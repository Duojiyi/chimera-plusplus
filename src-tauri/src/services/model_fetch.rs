//! 模型列表获取服务
//!
//! 通过 OpenAI 兼容的 GET /v1/models 端点获取供应商可用模型列表。
//! 主要面向第三方聚合站（硅基流动、OpenRouter 等），以及把 Anthropic
//! 协议挂在兼容子路径上的官方供应商（DeepSeek、Kimi、智谱 GLM 等）。

use futures::{future::join_all, stream, StreamExt};
use reqwest::header::{HeaderValue, CONTENT_TYPE, USER_AGENT};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use url::Url;

/// 获取到的模型信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    pub owned_by: Option<String>,
}

/// OpenAI 兼容的 /v1/models 响应格式
#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Option<Vec<ModelEntry>>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
    owned_by: Option<String>,
}

const FETCH_TIMEOUT_SECS: u64 = 15;
const API_FORMAT_PROBE_TIMEOUT_SECS: u64 = 8;

/// 模型列表只需要一小段 JSON。限制实际读取量，避免异常或恶意端点耗尽内存。
const MAX_MODEL_DISCOVERY_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// 协议探测及错误诊断只消费有限响应体；协议判断所需标记远小于该上限。
const MAX_PROTOCOL_PROBE_RESPONSE_BYTES: usize = 64 * 1024;
/// A model probe fans out to three protocol endpoints. Keep the request burst
/// modest while still scanning every saved model so an unscanned model can
/// never silently inherit another model's wire protocol.
const CODEX_MODEL_PROTOCOL_PROBE_CONCURRENCY: usize = 8;

/// 404/405 响应体截断长度：避免把几十 KB HTML 404 页整页保留到错误串里。
const ERROR_BODY_MAX_CHARS: usize = 512;

/// 已知的「Anthropic 协议兼容子路径」后缀；按长度降序，最长前缀优先匹配。
/// baseURL 命中这些后缀时，候选列表会追加「剥离后缀再拼 /v1/models / /models」的版本。
const KNOWN_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

/// 获取供应商的可用模型列表
///
/// 使用 OpenAI 兼容的 GET /v1/models 端点，按候选列表顺序尝试。
pub async fn fetch_models(
    base_url: &str,
    api_key: &str,
    is_full_url: bool,
    models_url_override: Option<&str>,
    user_agent: Option<HeaderValue>,
) -> Result<Vec<FetchedModel>, String> {
    if api_key.is_empty() {
        return Err("API Key is required to fetch models".to_string());
    }

    let candidates = build_models_url_candidates(base_url, is_full_url, models_url_override)?;
    let client = crate::proxy::http_client::get();
    let mut last_err: Option<String> = None;
    let log_secrets = vec![api_key.to_string()];

    for url in &candidates {
        log::debug!(
            "[ModelFetch] Trying endpoint: {}",
            crate::url_for_log_with_secrets(url, &log_secrets)
        );
        let mut request = client
            .get(url)
            .header("Authorization", format!("Bearer {api_key}"))
            .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS));
        // 自定义 User-Agent：部分 /models 端点同样有 UA 白名单（如 Kimi Coding Plan），
        // 与转发 / 检测路径共用同一 UA，避免"代理可用但取模型失败"。
        if let Some(ua) = &user_agent {
            request = request.header(USER_AGENT, ua.clone());
        }
        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                return Err(format!("Request failed: {e}"));
            }
        };

        let status = response.status();

        if status.is_success() {
            let body = read_response_body_limited(
                response,
                MAX_MODEL_DISCOVERY_RESPONSE_BYTES,
                "model discovery response",
            )
            .await?;
            let resp: ModelsResponse = serde_json::from_slice(&body)
                .map_err(|e| format!("Failed to parse response: {e}"))?;

            let mut models: Vec<FetchedModel> = resp
                .data
                .unwrap_or_default()
                .into_iter()
                .map(|m| FetchedModel {
                    id: m.id,
                    owned_by: m.owned_by,
                })
                .collect();

            models.sort_by(|a, b| a.id.cmp(&b.id));
            return Ok(models);
        }

        if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
            let body = read_response_text_limited(
                response,
                MAX_PROTOCOL_PROBE_RESPONSE_BYTES,
                "model discovery error response",
            )
            .await?;
            last_err = Some(format!("HTTP {status}: {}", truncate_body(body)));
            continue;
        }

        let body = read_response_text_limited(
            response,
            MAX_PROTOCOL_PROBE_RESPONSE_BYTES,
            "model discovery error response",
        )
        .await?;
        return Err(format!("HTTP {status}: {}", truncate_body(body)));
    }

    Err(format!(
        "All candidates failed: {}",
        last_err.unwrap_or_else(|| "no candidates".to_string())
    ))
}

async fn read_response_body_limited(
    response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    ensure_response_length_within_limit(response.content_length(), max_bytes, label)?;

    let mut body = Vec::with_capacity(
        response
            .content_length()
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(0)
            .min(max_bytes),
    );
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Failed to read {label}: {error}"))?;
        append_response_chunk(&mut body, &chunk, max_bytes, label)?;
    }
    Ok(body)
}

async fn read_response_text_limited(
    response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<String, String> {
    let body = read_response_body_limited(response, max_bytes, label).await?;
    Ok(String::from_utf8_lossy(&body).into_owned())
}

fn ensure_response_length_within_limit(
    content_length: Option<u64>,
    max_bytes: usize,
    label: &str,
) -> Result<(), String> {
    if content_length.is_some_and(|length| length > max_bytes as u64) {
        return Err(format!(
            "{label} exceeds the configured limit of {max_bytes} bytes"
        ));
    }
    Ok(())
}

fn append_response_chunk(
    body: &mut Vec<u8>,
    chunk: &[u8],
    max_bytes: usize,
    label: &str,
) -> Result<(), String> {
    if body.len().saturating_add(chunk.len()) > max_bytes {
        return Err(format!(
            "{label} exceeds the configured limit of {max_bytes} bytes"
        ));
    }
    body.extend_from_slice(chunk);
    Ok(())
}

/// A protocol selected by the non-billable Codex API capability probe.
///
/// The frontend intentionally stores the resolved format rather than an opaque
/// `auto` value, so the same provider behaves predictably on later switches.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCodexApiFormat {
    pub api_format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_auth_field: Option<String>,
}

/// Successful per-model protocol detections. Failed models are omitted so one
/// unsupported model cannot hide usable protocols exposed by the same gateway.
pub type DetectedCodexApiFormats = std::collections::HashMap<String, DetectedCodexApiFormat>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexApiProbe {
    Responses,
    ChatCompletions,
    AnthropicMessages,
}

impl CodexApiProbe {
    const ALL: [Self; 3] = [
        Self::Responses,
        Self::ChatCompletions,
        Self::AnthropicMessages,
    ];

    fn api_format(self) -> &'static str {
        match self {
            Self::Responses => "openai_responses",
            Self::ChatCompletions => "openai_chat",
            Self::AnthropicMessages => "anthropic",
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Self::Responses => "/responses",
            Self::ChatCompletions => "/chat/completions",
            Self::AnthropicMessages => "/messages",
        }
    }

    fn validation_markers(self) -> &'static [&'static str] {
        match self {
            Self::Responses => &[
                "input",
                "max_output_tokens",
                "max output tokens",
                "responses api",
            ],
            Self::ChatCompletions => &[
                "messages",
                "max_tokens",
                "max tokens",
                "chat completion",
                "chat/completions",
            ],
            Self::AnthropicMessages => &[
                "messages",
                "max_tokens",
                "max tokens",
                "anthropic",
                "anthropic-version",
            ],
        }
    }
}

#[derive(Debug, Clone)]
struct ApiProbeOutcome {
    probe: CodexApiProbe,
    supported: bool,
    anthropic_auth_field: Option<&'static str>,
    diagnostic: String,
}

/// Detect which upstream protocol a custom Codex endpoint exposes.
///
/// A real model name is used so catch-all gateways cannot make every route look
/// valid by returning the same "model is required" response. The request then
/// supplies a deliberately invalid token-budget type, forcing request-schema
/// validation before inference. The probe therefore cannot create a completion
/// or bill output tokens. Authentication errors and protocol-agnostic model
/// errors are treated as inconclusive.
pub async fn detect_codex_api_format(
    base_url: &str,
    api_key: &str,
    is_full_url: bool,
    model_hint: Option<&str>,
    user_agent: Option<HeaderValue>,
) -> Result<DetectedCodexApiFormat, String> {
    if api_key.trim().is_empty() {
        return Err("API Key is required to detect the upstream API format".to_string());
    }

    let probe_model = resolve_codex_api_probe_model(
        base_url,
        api_key,
        is_full_url,
        model_hint,
        user_agent.clone(),
    )
    .await?;
    let candidates = build_api_format_probe_urls(base_url, is_full_url)?;
    let client = crate::proxy::http_client::get();
    let probes = candidates.into_iter().map(|(probe, url)| {
        probe_codex_api_format_endpoint(
            &client,
            probe,
            url,
            api_key,
            &probe_model,
            user_agent.clone(),
        )
    });
    let outcomes = join_all(probes).await;

    // The Responses probe includes the Codex custom-tool shape while keeping
    // `max_output_tokens` deliberately invalid. This lets a gateway reject an
    // unsupported tool before inference begins, without the previous second
    // request containing a valid budget and therefore potentially generating
    // billable output. Explicit tool-rejection errors are handled by
    // `response_indicates_protocol_support`.
    if let Some(outcome) = select_codex_api_probe_outcome(&outcomes, &probe_model) {
        return Ok(DetectedCodexApiFormat {
            api_format: outcome.probe.api_format().to_string(),
            anthropic_auth_field: outcome.anthropic_auth_field.map(str::to_string),
        });
    }

    let diagnostics = outcomes
        .iter()
        .map(|outcome| format!("{}: {}", outcome.probe.api_format(), outcome.diagnostic))
        .collect::<Vec<_>>()
        .join("; ");
    Err(format!(
        "Could not safely identify a supported API protocol. Verify the endpoint, API Key, and model, or choose the protocol manually. {diagnostics}"
    ))
}

/// Detect the upstream protocol independently for each model in a catalog.
///
/// The endpoint may expose a mixed catalog (for example, Responses models next
/// to Chat Completions or Anthropic models). This function deliberately returns
/// partial success and keeps the request count bounded.
pub async fn detect_codex_api_formats(
    base_url: &str,
    api_key: &str,
    is_full_url: bool,
    models: Vec<String>,
    user_agent: Option<HeaderValue>,
) -> Result<DetectedCodexApiFormats, String> {
    if api_key.trim().is_empty() {
        return Err("API Key is required to detect the upstream API format".to_string());
    }

    let unique_models = collect_codex_protocol_probe_models(models);
    if unique_models.is_empty() {
        return Err("At least one model is required to detect the upstream API format".to_string());
    }

    let results = stream::iter(unique_models.into_iter().map(|model| {
        let user_agent = user_agent.clone();
        async move {
            let result =
                detect_codex_api_format(base_url, api_key, is_full_url, Some(&model), user_agent)
                    .await;
            (model, result)
        }
    }))
    .buffer_unordered(CODEX_MODEL_PROTOCOL_PROBE_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    let detections = results
        .into_iter()
        .filter_map(|(model, result)| result.ok().map(|detected| (model, detected)))
        .collect::<DetectedCodexApiFormats>();

    if detections.is_empty() {
        return Err(
            "Could not safely identify a supported API protocol for any selected model. Verify the endpoint, API Key, and model, or choose the protocol manually."
                .to_string(),
        );
    }
    Ok(detections)
}

/// Normalize a catalog before per-model probing without truncating it. A
/// truncated catalog produces a partial protocol map, and a partial map is
/// unsafe for a mixed-protocol provider because unmapped models might otherwise
/// borrow the default model's protocol.
fn collect_codex_protocol_probe_models(models: Vec<String>) -> Vec<String> {
    let mut unique_models = Vec::new();
    for model in models {
        let model = model.trim();
        if model.is_empty() || unique_models.iter().any(|known| known == model) {
            continue;
        }
        unique_models.push(model.to_string());
    }
    unique_models
}

async fn resolve_codex_api_probe_model(
    base_url: &str,
    api_key: &str,
    is_full_url: bool,
    model_hint: Option<&str>,
    user_agent: Option<HeaderValue>,
) -> Result<String, String> {
    if let Some(model) = model_hint.map(str::trim).filter(|model| !model.is_empty()) {
        return Ok(model.to_string());
    }

    let models = fetch_models(base_url, api_key, is_full_url, None, user_agent)
        .await
        .map_err(|error| {
            format!("Could not obtain a real model name for safe protocol detection: {error}")
        })?;
    models
        .into_iter()
        .map(|model| model.id)
        .find(|model| !model.trim().is_empty())
        .ok_or_else(|| {
            "Could not obtain a real model name for safe protocol detection: the model list is empty"
                .to_string()
        })
}

fn select_codex_api_probe_outcome<'a>(
    outcomes: &'a [ApiProbeOutcome],
    probe_model: &str,
) -> Option<&'a ApiProbeOutcome> {
    // A catch-all gateway may return the same generic 400/422 for every
    // unknown path. That is not enough to select a route: requiring a manual
    // choice here is safer than silently routing all traffic through a guessed
    // conversion protocol. Generic validation remains useful when only one or
    // two conversion routes answer (the common aggregator case).
    let supported: Vec<&ApiProbeOutcome> = outcomes
        .iter()
        .filter(|outcome| outcome.supported)
        .collect();
    if supported.len() == CodexApiProbe::ALL.len()
        && supported
            .iter()
            .all(|outcome| outcome.diagnostic.contains("generic validation"))
    {
        return None;
    }

    // A protocol-specific Responses validation error is strong evidence that
    // direct Responses is available, so prefer it over conversion routes.
    if let Some(outcome) = outcomes
        .iter()
        .find(|outcome| outcome.probe == CodexApiProbe::Responses && outcome.supported)
    {
        return Some(outcome);
    }

    // Some aggregators expose both Chat Completions and Anthropic Messages. For
    // Claude-family models prefer the native Messages surface; otherwise prefer
    // the broadly compatible Chat surface. This tie-breaker is used only after
    // both concrete routes independently returned protocol-shaped validation.
    let fallback_order = if is_likely_anthropic_model(probe_model) {
        [
            CodexApiProbe::AnthropicMessages,
            CodexApiProbe::ChatCompletions,
        ]
    } else {
        [
            CodexApiProbe::ChatCompletions,
            CodexApiProbe::AnthropicMessages,
        ]
    };
    fallback_order.into_iter().find_map(|preferred| {
        outcomes
            .iter()
            .find(|outcome| outcome.probe == preferred && outcome.supported)
    })
}

fn is_likely_anthropic_model(model: &str) -> bool {
    let normalized = model.to_ascii_lowercase();
    normalized.contains("claude") || normalized.contains("anthropic")
}

async fn probe_codex_api_format_endpoint(
    client: &reqwest::Client,
    probe: CodexApiProbe,
    url: String,
    api_key: &str,
    probe_model: &str,
    user_agent: Option<HeaderValue>,
) -> ApiProbeOutcome {
    // Native Anthropic gateways differ on whether they expect `x-api-key` or
    // Bearer auth. Probe the canonical header first and only then fall back to
    // Bearer, so a successful auto-detect also selects the correct auth field.
    let auth_variants: &[Option<&str>] = if probe == CodexApiProbe::AnthropicMessages {
        &[Some("ANTHROPIC_API_KEY"), Some("ANTHROPIC_AUTH_TOKEN")]
    } else {
        &[None]
    };

    let mut diagnostics = Vec::with_capacity(auth_variants.len());
    for auth_field in auth_variants {
        let (supported, diagnostic) = send_codex_api_format_probe(
            client,
            probe,
            &url,
            api_key,
            probe_model,
            user_agent.clone(),
            *auth_field,
        )
        .await;
        diagnostics.push(diagnostic);
        if supported {
            return ApiProbeOutcome {
                probe,
                supported: true,
                anthropic_auth_field: *auth_field,
                diagnostic: diagnostics.join(", "),
            };
        }
    }

    ApiProbeOutcome {
        probe,
        supported: false,
        anthropic_auth_field: None,
        diagnostic: diagnostics.join(", "),
    }
}

async fn send_codex_api_format_probe(
    client: &reqwest::Client,
    probe: CodexApiProbe,
    url: &str,
    api_key: &str,
    probe_model: &str,
    user_agent: Option<HeaderValue>,
    anthropic_auth_field: Option<&str>,
) -> (bool, String) {
    let mut request = client
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .header("Accept", "application/json")
        .body(invalid_probe_body(probe, probe_model))
        .timeout(Duration::from_secs(API_FORMAT_PROBE_TIMEOUT_SECS));

    match anthropic_auth_field {
        Some("ANTHROPIC_API_KEY") => {
            request = request
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01");
        }
        _ => {
            request = request.header("Authorization", format!("Bearer {api_key}"));
            if anthropic_auth_field.is_some() {
                request = request.header("anthropic-version", "2023-06-01");
            }
        }
    }
    if let Some(ua) = user_agent {
        request = request.header(USER_AGENT, ua);
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status();
            match read_response_text_limited(
                response,
                MAX_PROTOCOL_PROBE_RESPONSE_BYTES,
                "protocol probe response",
            )
            .await
            {
                Ok(body) => {
                    let body = truncate_body(body);
                    let strong_evidence = response_indicates_protocol_support(probe, status, &body);
                    // Unknown aggregators often normalize all schema failures
                    // into a generic validation error instead of echoing the
                    // field we deliberately made invalid. Treat that as weak
                    // evidence only for conversion protocols: an unknown
                    // gateway should automatically prefer Chat/Anthropic, but
                    // must never be promoted to native Responses without a
                    // Responses-shaped field error.
                    let weak_evidence = !strong_evidence
                        && response_indicates_generic_validation_support(probe, status, &body);
                    let supported = strong_evidence || weak_evidence;
                    let classification = if strong_evidence {
                        "protocol validation"
                    } else if weak_evidence {
                        "generic validation (weak evidence)"
                    } else {
                        "inconclusive"
                    };
                    (supported, format!("HTTP {status} ({classification})"))
                }
                Err(error) => (false, error),
            }
        }
        Err(error) => (false, format!("request failed: {error}")),
    }
}

/// Invalid by construction for all three protocols. A real model identifier is
/// present so a generic model-required response cannot masquerade as support,
/// while the token-budget value has an impossible JSON type and must fail schema
/// validation before inference can begin.
///
/// This is the endpoint and Codex-tool-surface probe: the Responses payload
/// includes the custom tool, while the invalid budget prevents generation. A
/// truncated gateway can therefore be rejected in the same non-generating call.
fn invalid_probe_body(probe: CodexApiProbe, model: &str) -> String {
    let invalid_token_budget = serde_json::json!({ "chimeraProbe": true });
    let inert_input = "Chimera protocol compatibility probe. Do not process.";
    match probe {
        CodexApiProbe::Responses => serde_json::json!({
            "model": model,
            "input": inert_input,
            "max_output_tokens": invalid_token_budget,
            "tools": [{
                "type": "custom",
                "name": "chimera_probe_exec",
                "description": "Chimera protocol compatibility probe tool.",
                "parameters": {
                    "type": "object",
                    "properties": { "command": { "type": "string" } }
                }
            }]
        })
        .to_string(),
        CodexApiProbe::ChatCompletions | CodexApiProbe::AnthropicMessages => serde_json::json!({
            "model": model,
            "messages": [{
                "role": "user",
                "content": inert_input,
            }],
            "max_tokens": invalid_token_budget,
        })
        .to_string(),
    }
}

/// Accept only protocol-shaped request-validation responses from an existing
/// endpoint. A generic model error is intentionally insufficient: catch-all
/// gateways may return it for every unknown route, which previously made
/// Responses win solely because it was first in the preference order.
fn response_indicates_protocol_support(
    probe: CodexApiProbe,
    status: StatusCode,
    body: &str,
) -> bool {
    let normalized = body.to_ascii_lowercase();
    if [
        "not found",
        "unknown endpoint",
        "unknown route",
        "unsupported endpoint",
        "cannot post",
        "no route",
        "route not found",
        "invalid url",
        "convert_request_failed",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        return false;
    }

    // A proxy can reject a model's capability while echoing the malformed
    // fields we sent (`input`, `max_output_tokens`, `messages`, ...). That is
    // evidence for neither endpoint nor model support, so reject it before
    // looking for field-validation markers.
    if response_indicates_model_capability_rejection(&normalized) {
        return false;
    }

    // The Responses probe includes a custom tool. If the gateway rejects that
    // tool surface before validating the malformed budget, native Responses is
    // unsafe and must be demoted.
    if probe == CodexApiProbe::Responses && response_rejects_responses_tools(&normalized) {
        return false;
    }

    // Most gateways reject our deliberately malformed token-budget field with a
    // 400/422 schema error. Some (e.g. new-api based gateways such as
    // chimerahub) instead surface it as a 500 "cannot unmarshal" deserialization
    // error whose message still names the protocol-specific field
    // (`max_output_tokens` for Responses, `max_tokens` for Chat/Anthropic).
    // Treat that as equivalent evidence so such gateways are detected instead
    // of "no conclusion on every protocol".
    let schema_validation_status =
        status == StatusCode::BAD_REQUEST || status == StatusCode::UNPROCESSABLE_ENTITY;
    let deserialization_500 = status == StatusCode::INTERNAL_SERVER_ERROR
        && response_is_deserialization_error(&normalized);
    if !schema_validation_status && !deserialization_500 {
        return false;
    }

    probe
        .validation_markers()
        .iter()
        .any(|marker| normalized.contains(marker))
}

/// Accept generic request-validation failures from unknown conversion gateways.
///
/// Many aggregators intentionally normalize provider errors and do not echo the
/// request field that failed. A generic validation response still proves that
/// the route accepted the protocol-shaped request, but it is deliberately weak
/// evidence: native Responses keeps requiring an explicit Responses marker to
/// avoid selecting a direct-connect path that cannot carry Codex tools.
fn response_indicates_generic_validation_support(
    probe: CodexApiProbe,
    status: StatusCode,
    body: &str,
) -> bool {
    if probe == CodexApiProbe::Responses
        || !(status == StatusCode::BAD_REQUEST
            || status == StatusCode::UNPROCESSABLE_ENTITY
            || (status == StatusCode::INTERNAL_SERVER_ERROR
                && response_is_deserialization_error(&body.to_ascii_lowercase())))
    {
        return false;
    }

    let normalized = body.to_ascii_lowercase();
    if [
        "not found",
        "unknown endpoint",
        "unknown route",
        "unsupported endpoint",
        "route not found",
        "invalid api key",
        "unauthorized",
        "forbidden",
        "model is required",
        "model not found",
        "model_not_found",
        "model is not available",
        "unsupported model",
        "unsupported_model",
        "not supported by this model",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        return false;
    }

    [
        "invalid request",
        "invalid_request_error",
        "invalid_request",
        "request error",
        "请求无效",
        "invalid parameter",
        "invalid params",
        "request validation",
        "validation failed",
        "validation error",
        "参数错误",
        "请求参数",
        "请求体错误",
        "字段错误",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

/// Whether an error body is a JSON deserialization failure that names a
/// request field we sent (Go-style `cannot unmarshal ... into struct field
/// ...max_output_tokens`). Some gateways map schema validation to HTTP 500
/// instead of 400/422; the field name in the message is still protocol-shaped.
fn response_is_deserialization_error(normalized_body: &str) -> bool {
    [
        "cannot unmarshal",
        "unmarshal error",
        "error decoding",
        "cannot parse json",
        "invalid json type",
        "expected uint",
        "expected integer",
        "expected number",
    ]
    .iter()
    .any(|marker| normalized_body.contains(marker))
}

/// Whether a Responses error indicates that the gateway rejects the Codex tool
/// surface (`custom`/`namespace`/`web_search`) that third-party-model clients
/// emit by default. Such a gateway is "Responses-shaped" but not usable for
/// Codex without the proxy's tool flattening.
fn response_rejects_responses_tools(normalized_body: &str) -> bool {
    [
        "responses_feature_not_supported",
        "feature not supported",
        "not supported by this gateway phase",
        "unsupported tool",
        "tool not supported",
        "unsupported tool type",
        "unknown variant \"namespace\"",
        "tool.custom",
        "tool.namespace",
        "tool type 'custom'",
        "tool type 'namespace'",
        "不支持 responses 能力",
        "能力：tool.",
        "tool.web_search",
        "web_search\"",
        "'web_search'",
    ]
    .iter()
    .any(|marker| normalized_body.contains(marker))
}

/// Gateways use many equivalent wordings for a model-level capability error.
/// Treat these as negative evidence before matching echoed request fields:
/// `input` and `max_output_tokens` may be present in an error even when that
/// model cannot use the Responses endpoint at all.
fn response_indicates_model_capability_rejection(normalized_body: &str) -> bool {
    [
        "does not support",
        "doesn't support",
        "doesnt support",
        "not supported",
        "unsupported for this model",
        "unsupported by this model",
        "unsupported_model",
        "model_unsupported",
        "unsupported model capability",
        "not available for this model",
        "model is not available",
        "this model cannot",
        "model cannot",
    ]
    .iter()
    .any(|marker| normalized_body.contains(marker))
        || (normalized_body.contains("for this model")
            && ["unsupported", "invalid", "not allowed", "unavailable"]
                .iter()
                .any(|marker| normalized_body.contains(marker)))
}

/// Derive the three protocol endpoints from either a base URL or a full API URL.
/// Full URLs are normalized by replacing their terminal known protocol path; an
/// unknown full URL falls back to its containing directory.
fn build_api_format_probe_urls(
    base_url: &str,
    is_full_url: bool,
) -> Result<Vec<(CodexApiProbe, String)>, String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Err("Base URL is empty".to_string());
    }

    let parsed = Url::parse(trimmed).map_err(|error| format!("Invalid base URL: {error}"))?;
    if parsed.host_str().is_none() || !matches!(parsed.scheme(), "http" | "https") {
        return Err("Base URL must be an http(s) URL".to_string());
    }

    let path = parsed.path().trim_end_matches('/');
    let root_path = if is_full_url {
        let known_suffixes = ["/chat/completions", "/responses", "/messages"];
        if let Some(suffix) = known_suffixes
            .iter()
            .find(|suffix| path.ends_with(**suffix))
        {
            &path[..path.len() - suffix.len()]
        } else {
            path.rsplit_once('/')
                .map(|(parent, _)| parent)
                .filter(|parent| !parent.is_empty())
                .ok_or_else(|| "Cannot derive API root from full URL".to_string())?
        }
    } else if ends_with_version_segment(path)
        || path.ends_with("/anthropic")
        || path.ends_with("/claudecode")
    {
        path
    } else {
        // Keep the user's path prefix (for example /api) and add the OpenAI
        // version segment. Query parameters are retained on every candidate;
        // some gateways use them for tenant/routing selection.
        return Ok(CodexApiProbe::ALL
            .into_iter()
            .map(|probe| {
                let mut url = parsed.clone();
                let candidate_path = format!("{}/v1{}", path.trim_end_matches('/'), probe.suffix());
                url.set_path(&candidate_path);
                (probe, url.to_string())
            })
            .collect());
    };

    Ok(CodexApiProbe::ALL
        .into_iter()
        .map(|probe| {
            let mut url = parsed.clone();
            let candidate_path = format!("{}{}", root_path.trim_end_matches('/'), probe.suffix());
            url.set_path(&candidate_path);
            (probe, url.to_string())
        })
        .collect())
}

/// 构造「模型列表端点」的候选 URL 列表
///
/// 候选顺序：
/// 1. `models_url_override` 非空 → 只返回它
/// 2. baseURL 拼 `/v1/models`；若已以版本段 `/v{N}` 结尾（`/v1`、智谱
///    `/api/coding/paas/v4` 等），版本号已在路径里，改拼 `/models`
/// 3. 版本段非 `/v1`（如 `/v4`）时再追加 `/v1/models` 作为兜底次候选
/// 4. 若 baseURL 命中 [`KNOWN_COMPAT_SUFFIXES`]，剥离后缀再拼 `/v1/models`、`/models`
///
/// 结果已去重且保持首次出现顺序。
pub fn build_models_url_candidates(
    base_url: &str,
    is_full_url: bool,
    models_url_override: Option<&str>,
) -> Result<Vec<String>, String> {
    if let Some(raw) = models_url_override {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(vec![trimmed.to_string()]);
        }
    }

    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Base URL is empty".to_string());
    }

    let mut candidates: Vec<String> = Vec::new();

    if is_full_url {
        if let Some(idx) = trimmed.find("/v1/") {
            candidates.push(format!("{}/v1/models", &trimmed[..idx]));
        } else if let Some(idx) = trimmed.rfind('/') {
            let root = &trimmed[..idx];
            if root.contains("://") && root.len() > root.find("://").unwrap() + 3 {
                candidates.push(format!("{root}/v1/models"));
            }
        }
        if candidates.is_empty() {
            return Err("Cannot derive models endpoint from full URL".to_string());
        }
        return Ok(candidates);
    }

    // baseURL 已以版本段 /v{N} 结尾时（如 `/v1`、智谱 `/api/coding/paas/v4`），
    // OpenAI 惯例的模型端点是 `{base}/models`，不能再补 `/v1`
    // （否则 .../coding/paas/v4/v1/models → 404）。
    if ends_with_version_segment(trimmed) {
        candidates.push(format!("{trimmed}/models"));
        // 版本段非 /v1 时，保留旧的 /v1/models 作为兜底次候选（正确路径已在前）。
        if !trimmed.ends_with("/v1") {
            candidates.push(format!("{trimmed}/v1/models"));
        }
    } else {
        candidates.push(format!("{trimmed}/v1/models"));
    }

    if let Some(stripped) = strip_compat_suffix(trimmed) {
        let root = stripped.trim_end_matches('/');
        if !root.is_empty() && root.contains("://") {
            candidates.push(format!("{root}/v1/models"));
            candidates.push(format!("{root}/models"));
        }
    }

    // 候选最多 3 条，线性去重即可，不值得上 HashSet。
    let mut unique: Vec<String> = Vec::with_capacity(candidates.len());
    for url in candidates {
        if !unique.iter().any(|u| u == &url) {
            unique.push(url);
        }
    }

    Ok(unique)
}

/// 截断响应体到 [`ERROR_BODY_MAX_CHARS`] 字符，避免 HTML 404 页占用错误串。
fn truncate_body(body: String) -> String {
    if body.chars().count() <= ERROR_BODY_MAX_CHARS {
        body
    } else {
        let mut s: String = body.chars().take(ERROR_BODY_MAX_CHARS).collect();
        s.push('…');
        s
    }
}

/// 若 baseURL 以任一已知兼容子路径结尾，返回剥离后的剩余部分；否则 `None`。
///
/// 依赖 [`KNOWN_COMPAT_SUFFIXES`] 按长度降序排列，确保最长前缀优先命中
/// （否则 `/anthropic` 会提前匹配掉 `/api/anthropic` 的场景）。
fn strip_compat_suffix(base_url: &str) -> Option<&str> {
    for suffix in KNOWN_COMPAT_SUFFIXES {
        if base_url.ends_with(*suffix) {
            return Some(&base_url[..base_url.len() - suffix.len()]);
        }
    }
    None
}

/// 判断 baseURL 是否以 OpenAI 风格的版本段 `/v{N}` 结尾（`N` 为一个或多个数字），
/// 例如 `/v1`、`.../paas/v4`。这类 URL 版本号已在路径中，模型端点应为
/// `{base}/models`，不能再补 `/v1`（智谱 Coding Plan 即 `.../coding/paas/v4`）。
fn ends_with_version_segment(url: &str) -> bool {
    let last = url.rsplit('/').next().unwrap_or("");
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_candidates_plain_root() {
        let c = build_models_url_candidates("https://api.siliconflow.cn", false, None).unwrap();
        assert_eq!(c, vec!["https://api.siliconflow.cn/v1/models"]);
    }

    #[test]
    fn test_candidates_trailing_slash() {
        let c = build_models_url_candidates("https://api.example.com/", false, None).unwrap();
        assert_eq!(c, vec!["https://api.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_with_v1() {
        let c = build_models_url_candidates("https://api.example.com/v1", false, None).unwrap();
        assert_eq!(c, vec!["https://api.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_zhipu_coding_paas_v4() {
        // 智谱 Coding Plan 端点以 /v4 版本段结尾：模型端点是 {base}/models，
        // 正确路径必须排在 .../v4/v1/models（404）之前。
        let c =
            build_models_url_candidates("https://open.bigmodel.cn/api/coding/paas/v4", false, None)
                .unwrap();
        assert_eq!(
            c,
            vec![
                "https://open.bigmodel.cn/api/coding/paas/v4/models",
                "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
            ]
        );
    }

    #[test]
    fn test_candidates_zai_coding_paas_v4() {
        let c = build_models_url_candidates("https://api.z.ai/api/coding/paas/v4", false, None)
            .unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.z.ai/api/coding/paas/v4/models",
                "https://api.z.ai/api/coding/paas/v4/v1/models",
            ]
        );
    }

    #[test]
    fn test_ends_with_version_segment() {
        assert!(ends_with_version_segment("https://x.com/v1"));
        assert!(ends_with_version_segment(
            "https://open.bigmodel.cn/api/coding/paas/v4"
        ));
        assert!(ends_with_version_segment("https://x.com/v10"));
        assert!(!ends_with_version_segment("https://x.com/api"));
        assert!(!ends_with_version_segment("https://x.com/vX"));
        assert!(!ends_with_version_segment("https://x.com/models"));
        assert!(!ends_with_version_segment("https://api.siliconflow.cn"));
    }

    #[test]
    fn test_candidates_full_url() {
        let c = build_models_url_candidates(
            "https://proxy.example.com/v1/chat/completions",
            true,
            None,
        )
        .unwrap();
        assert_eq!(c, vec!["https://proxy.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_empty() {
        assert!(build_models_url_candidates("", false, None).is_err());
    }
    #[test]
    fn protocol_probe_candidates_support_root_version_and_full_urls() {
        let root = build_api_format_probe_urls("https://gateway.example", false).unwrap();
        assert_eq!(
            root.iter().map(|(_, url)| url.as_str()).collect::<Vec<_>>(),
            vec![
                "https://gateway.example/v1/responses",
                "https://gateway.example/v1/chat/completions",
                "https://gateway.example/v1/messages",
            ]
        );

        let versioned = build_api_format_probe_urls("https://gateway.example/v1", false).unwrap();
        assert_eq!(
            versioned
                .iter()
                .map(|(_, url)| url.as_str())
                .collect::<Vec<_>>(),
            vec![
                "https://gateway.example/v1/responses",
                "https://gateway.example/v1/chat/completions",
                "https://gateway.example/v1/messages",
            ]
        );

        let full = build_api_format_probe_urls("https://gateway.example/v1/chat/completions", true)
            .unwrap();
        assert_eq!(
            full.iter().map(|(_, url)| url.as_str()).collect::<Vec<_>>(),
            vec![
                "https://gateway.example/v1/responses",
                "https://gateway.example/v1/chat/completions",
                "https://gateway.example/v1/messages",
            ]
        );
    }

    #[test]
    fn protocol_probe_preserves_path_prefix_and_query_parameters() {
        let candidates =
            build_api_format_probe_urls("https://gateway.example/api/v1?tenant=acme", false)
                .unwrap();
        assert_eq!(
            candidates[0].1,
            "https://gateway.example/api/v1/responses?tenant=acme"
        );

        let full = build_api_format_probe_urls(
            "https://gateway.example/api/v1/chat/completions?tenant=acme",
            true,
        )
        .unwrap();
        assert_eq!(
            full[0].1,
            "https://gateway.example/api/v1/responses?tenant=acme"
        );
        assert_eq!(
            full[1].1,
            "https://gateway.example/api/v1/chat/completions?tenant=acme"
        );
    }

    #[test]
    fn protocol_probe_rejects_non_http_urls() {
        assert!(build_api_format_probe_urls("file:///tmp/codex", false).is_err());
        assert!(build_api_format_probe_urls("not-a-url", false).is_err());
    }

    #[test]
    fn protocol_probe_bodies_use_a_real_model_and_impossible_token_type() {
        for probe in CodexApiProbe::ALL {
            let body: serde_json::Value =
                serde_json::from_str(&invalid_probe_body(probe, "claude-sonnet-4-6")).unwrap();
            assert_eq!(body["model"], "claude-sonnet-4-6");
            match probe {
                CodexApiProbe::Responses => {
                    assert_eq!(
                        body["input"],
                        "Chimera protocol compatibility probe. Do not process."
                    );
                    assert!(body["max_output_tokens"].is_object());
                    // The invalid token budget keeps this probe non-generating,
                    // while the custom tool lets us reject truncated Responses
                    // gateways before selecting native routing.
                    let tools = body["tools"].as_array().expect("tools array");
                    assert_eq!(tools[0]["type"], "custom");
                }
                CodexApiProbe::ChatCompletions | CodexApiProbe::AnthropicMessages => {
                    assert_eq!(
                        body["messages"][0],
                        serde_json::json!({
                            "role": "user",
                            "content": "Chimera protocol compatibility probe. Do not process."
                        })
                    );
                    assert!(body["max_tokens"].is_object());
                }
            }
        }
    }

    #[test]
    fn responses_probe_is_non_generating_and_carries_custom_tool() {
        let body: serde_json::Value =
            serde_json::from_str(&invalid_probe_body(CodexApiProbe::Responses, "qwen3.8-max"))
                .unwrap();
        assert_eq!(body["model"], "qwen3.8-max");
        assert!(body["max_output_tokens"].is_object());
        let tools = body["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], "custom");
        assert_eq!(tools[0]["name"], "chimera_probe_exec");
    }

    #[test]
    fn protocol_probe_rejects_truncated_responses_gateways() {
        // Real-world truncated Responses gateways (e.g. tokenrhythm.studio)
        // accept a bare schema check but reject the Codex tool surface with
        // `RESPONSES_FEATURE_NOT_SUPPORTED`. The probe now includes a custom
        // tool, so these must be treated as negative evidence for Responses
        // even though the body echoes field names.
        let truncated_bodies = [
            // tokenrhythm verbatim (Chinese message + english code)
            r#"{"error":{"message":"当前模型或上游不支持 Responses 能力：tool.custom","type":"invalid_request_error","code":"RESPONSES_FEATURE_NOT_SUPPORTED"}}"#,
            // namespace variant
            r#"{"error":{"message":"当前模型或上游不支持 Responses 能力：tool.namespace","code":"RESPONSES_FEATURE_NOT_SUPPORTED"}}"#,
            // web_search variant
            r#"{"error":{"message":"当前模型或上游不支持 Responses 能力：web_search","code":"RESPONSES_FEATURE_NOT_SUPPORTED"}}"#,
            // English gateway-phase rejection
            r#"{"error":{"code":"responses_feature_not_supported","message":"tool type 'web_search' is not supported by this gateway phase"}}"#,
            // strict parser namespace rejection (xAI-style)
            r#"{"error":{"message":"422 unknown variant \"namespace\", expected one of [...]"}}"#,
        ];
        for body in truncated_bodies {
            assert!(
                !response_indicates_protocol_support(
                    CodexApiProbe::Responses,
                    StatusCode::BAD_REQUEST,
                    body,
                ),
                "truncated Responses gateway must not be detected as Responses: {body}"
            );
        }

        // A full gateway that accepts the custom tool and rejects only the
        // malformed token budget must still be detected as Responses.
        assert!(response_indicates_protocol_support(
            CodexApiProbe::Responses,
            StatusCode::BAD_REQUEST,
            r#"{"error":"max_output_tokens must be an integer"}"#
        ));
    }

    #[test]
    fn protocol_probe_truncated_gateway_detection_is_responses_only() {
        // The tool-rejection heuristic must not leak into Chat/Anthropic probes:
        // those protocols legitimately surface tool errors and are handled by
        // the proxy conversion layer.
        for probe in [
            CodexApiProbe::ChatCompletions,
            CodexApiProbe::AnthropicMessages,
        ] {
            assert!(
                !response_indicates_protocol_support(
                    probe,
                    StatusCode::BAD_REQUEST,
                    r#"{"error":{"message":"当前模型或上游不支持 Responses 能力：tool.custom","code":"RESPONSES_FEATURE_NOT_SUPPORTED"}}"#,
                ),
                "tool-rejection must not affect {probe:?} detection semantics"
            );
        }
    }

    #[test]
    fn protocol_probe_responses_tool_rejection_detector() {
        assert!(response_rejects_responses_tools(
            "responses_feature_not_supported"
        ));
        assert!(response_rejects_responses_tools(
            "不支持 responses 能力：tool.custom"
        ));
        assert!(response_rejects_responses_tools(
            "tool type 'custom' is not supported"
        ));
        assert!(!response_rejects_responses_tools(
            "max_output_tokens must be an integer"
        ));
        assert!(!response_rejects_responses_tools("input must not be empty"));
    }

    #[test]
    fn protocol_probe_rejects_generic_model_errors() {
        for probe in CodexApiProbe::ALL {
            assert!(!response_indicates_protocol_support(
                probe,
                StatusCode::BAD_REQUEST,
                r#"{"error":"model is required"}"#
            ));
            assert!(!response_indicates_protocol_support(
                probe,
                StatusCode::BAD_REQUEST,
                r#"{"error":"未指定模型名称，模型名称不能为空"}"#
            ));
        }
    }

    #[test]
    fn protocol_probe_rejects_model_capability_errors_that_echo_probe_fields() {
        // Some gateways echo `input` / `max_output_tokens` in a model-level
        // capability error even though the route is not usable for that model.
        // Field names alone must never promote an unsupported Responses model.
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::Responses,
            StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"This model does not support the Responses API. input and max_output_tokens are unsupported for this model."}}"#
        ));
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::ChatCompletions,
            StatusCode::UNPROCESSABLE_ENTITY,
            r#"{"error":{"message":"messages and max_tokens are not supported by this model on this endpoint"}}"#
        ));
    }

    #[test]
    fn protocol_probe_rejects_contracted_capability_errors_that_echo_probe_fields() {
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::Responses,
            StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"This model doesn't support the Responses API. input and max_output_tokens are invalid for this model."}}"#
        ));
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::AnthropicMessages,
            StatusCode::UNPROCESSABLE_ENTITY,
            r#"{"error":{"code":"unsupported_model_capability","message":"messages and max_tokens are rejected for this model"}}"#
        ));
    }

    #[test]
    fn protocol_probe_model_collection_keeps_models_beyond_the_legacy_limit() {
        let models = (0..25)
            .map(|index| format!("model-{index}"))
            .collect::<Vec<_>>();

        let unique = collect_codex_protocol_probe_models(models);

        assert_eq!(unique.len(), 25);
        assert_eq!(unique.last().map(String::as_str), Some("model-24"));
    }

    #[test]
    fn protocol_probe_accepts_only_protocol_shaped_validation_errors() {
        assert!(response_indicates_protocol_support(
            CodexApiProbe::Responses,
            StatusCode::BAD_REQUEST,
            r#"{"error":"max_output_tokens must be an integer"}"#
        ));
        assert!(response_indicates_protocol_support(
            CodexApiProbe::ChatCompletions,
            StatusCode::UNPROCESSABLE_ENTITY,
            r#"{"error":"messages must not be empty"}"#
        ));
        assert!(response_indicates_protocol_support(
            CodexApiProbe::AnthropicMessages,
            StatusCode::BAD_REQUEST,
            r#"{"error":"max_tokens must be an integer"}"#
        ));
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::Responses,
            StatusCode::BAD_REQUEST,
            r#"{"error":"messages must not be empty"}"#
        ));
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::Responses,
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":"convert_request_failed"}"#
        ));
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::ChatCompletions,
            StatusCode::UNAUTHORIZED,
            r#"{"error":"invalid api key"}"#
        ));
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::AnthropicMessages,
            StatusCode::NOT_FOUND,
            "not found"
        ));
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::ChatCompletions,
            StatusCode::BAD_REQUEST,
            "Unknown endpoint"
        ));
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::ChatCompletions,
            StatusCode::BAD_REQUEST,
            "Bad request"
        ));
    }

    #[test]
    fn protocol_probe_accepts_generic_validation_for_unknown_aggregators() {
        // Aggregators such as TokenRhythm normalize schema failures instead of
        // echoing `messages`/`max_tokens`. This is enough to select the
        // conversion route, but never enough to select native Responses.
        for probe in [
            CodexApiProbe::ChatCompletions,
            CodexApiProbe::AnthropicMessages,
        ] {
            assert!(response_indicates_generic_validation_support(
                probe,
                StatusCode::BAD_REQUEST,
                r#"{"error":{"message":"request validation failed"}}"#
            ));
            assert!(response_indicates_generic_validation_support(
                probe,
                StatusCode::UNPROCESSABLE_ENTITY,
                r#"{"message":"参数错误"}"#
            ));
        }
        assert!(!response_indicates_generic_validation_support(
            CodexApiProbe::Responses,
            StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"request validation failed"}}"#
        ));
        assert!(!response_indicates_generic_validation_support(
            CodexApiProbe::ChatCompletions,
            StatusCode::BAD_REQUEST,
            "Bad request"
        ));
        assert!(!response_indicates_generic_validation_support(
            CodexApiProbe::ChatCompletions,
            StatusCode::BAD_REQUEST,
            r#"{"error":"model is required"}"#
        ));
    }

    #[test]
    fn protocol_probe_accepts_500_deserialization_errors_with_protocol_fields() {
        // new-api based gateways (e.g. chimerahub) map schema validation to
        // HTTP 500 with a Go "cannot unmarshal" message that still names the
        // protocol-specific field. The probe must recognize those as protocol
        // evidence, otherwise every protocol comes back "no conclusion".
        assert!(response_indicates_protocol_support(
            CodexApiProbe::ChatCompletions,
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":{"message":"json: cannot unmarshal object into Go struct field GeneralOpenAIRequest.max_tokens of type uint"}}"#
        ));
        assert!(response_indicates_protocol_support(
            CodexApiProbe::AnthropicMessages,
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":{"message":"json: cannot unmarshal object into Go struct field ClaudeRequest.max_tokens of type uint"}}"#
        ));
        assert!(response_indicates_protocol_support(
            CodexApiProbe::Responses,
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":{"message":"json: cannot unmarshal object into Go struct field OpenAIResponsesRequest.max_output_tokens of type uint"}}"#
        ));

        // A bare 500 without a deserialization marker is still not evidence.
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::ChatCompletions,
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":"internal server error"}"#
        ));
        // `convert_request_failed` remains a route-missing signal even at 500.
        assert!(!response_indicates_protocol_support(
            CodexApiProbe::Responses,
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":{"code":"convert_request_failed","message":"not implemented"}}"#
        ));
    }

    fn probe_outcome(probe: CodexApiProbe, supported: bool) -> ApiProbeOutcome {
        ApiProbeOutcome {
            probe,
            supported,
            anthropic_auth_field: (probe == CodexApiProbe::AnthropicMessages)
                .then_some("ANTHROPIC_AUTH_TOKEN"),
            diagnostic: String::new(),
        }
    }

    #[test]
    fn protocol_probe_selection_rejects_generic_catch_all_routes() {
        let outcomes = [
            ApiProbeOutcome {
                probe: CodexApiProbe::Responses,
                supported: false,
                anthropic_auth_field: None,
                diagnostic: "HTTP 422 (inconclusive)".to_string(),
            },
            ApiProbeOutcome {
                probe: CodexApiProbe::ChatCompletions,
                supported: true,
                anthropic_auth_field: None,
                diagnostic: "HTTP 422 (generic validation (weak evidence))".to_string(),
            },
            ApiProbeOutcome {
                probe: CodexApiProbe::AnthropicMessages,
                supported: true,
                anthropic_auth_field: Some("ANTHROPIC_API_KEY"),
                diagnostic: "HTTP 422 (generic validation (weak evidence))".to_string(),
            },
        ];
        assert!(select_codex_api_probe_outcome(&outcomes, "claude-sonnet-4-6").is_some());

        let all_generic = [
            ApiProbeOutcome {
                probe: CodexApiProbe::Responses,
                supported: true,
                anthropic_auth_field: None,
                diagnostic: "HTTP 422 (generic validation (weak evidence))".to_string(),
            },
            outcomes[1].clone(),
            outcomes[2].clone(),
        ];
        assert!(select_codex_api_probe_outcome(&all_generic, "claude-sonnet-4-6").is_none());
    }

    #[test]
    fn protocol_probe_selection_prefers_responses_only_when_confirmed() {
        let outcomes = [
            probe_outcome(CodexApiProbe::Responses, true),
            probe_outcome(CodexApiProbe::ChatCompletions, true),
            probe_outcome(CodexApiProbe::AnthropicMessages, true),
        ];
        assert_eq!(
            select_codex_api_probe_outcome(&outcomes, "claude-sonnet-4-6")
                .unwrap()
                .probe,
            CodexApiProbe::Responses
        );
    }

    #[test]
    fn protocol_probe_selection_prefers_anthropic_for_claude_ties() {
        let outcomes = [
            probe_outcome(CodexApiProbe::Responses, false),
            probe_outcome(CodexApiProbe::ChatCompletions, true),
            probe_outcome(CodexApiProbe::AnthropicMessages, true),
        ];
        assert_eq!(
            select_codex_api_probe_outcome(&outcomes, "anthropic/claude-sonnet-4-6")
                .unwrap()
                .probe,
            CodexApiProbe::AnthropicMessages
        );
    }

    #[test]
    fn protocol_probe_selection_prefers_chat_for_non_claude_ties() {
        let outcomes = [
            probe_outcome(CodexApiProbe::Responses, false),
            probe_outcome(CodexApiProbe::ChatCompletions, true),
            probe_outcome(CodexApiProbe::AnthropicMessages, true),
        ];
        assert_eq!(
            select_codex_api_probe_outcome(&outcomes, "deepseek-v3.2")
                .unwrap()
                .probe,
            CodexApiProbe::ChatCompletions
        );
    }

    #[test]
    fn protocol_probe_selection_returns_none_for_ambiguous_routes() {
        let outcomes = [
            probe_outcome(CodexApiProbe::Responses, false),
            probe_outcome(CodexApiProbe::ChatCompletions, false),
            probe_outcome(CodexApiProbe::AnthropicMessages, false),
        ];
        assert!(select_codex_api_probe_outcome(&outcomes, "claude-sonnet-4-6").is_none());
    }

    #[test]
    fn test_candidates_override_returns_single() {
        let c = build_models_url_candidates(
            "https://api.deepseek.com/anthropic",
            false,
            Some("https://api.deepseek.com/models"),
        )
        .unwrap();
        assert_eq!(c, vec!["https://api.deepseek.com/models"]);
    }

    #[test]
    fn test_candidates_override_empty_falls_through() {
        let c =
            build_models_url_candidates("https://api.siliconflow.cn", false, Some("   ")).unwrap();
        assert_eq!(c, vec!["https://api.siliconflow.cn/v1/models"]);
    }

    #[test]
    fn test_candidates_deepseek_strip_anthropic() {
        let c =
            build_models_url_candidates("https://api.deepseek.com/anthropic", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/v1/models",
                "https://api.deepseek.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_zhipu_strip_api_anthropic() {
        let c = build_models_url_candidates("https://open.bigmodel.cn/api/anthropic", false, None)
            .unwrap();
        assert_eq!(
            c,
            vec![
                "https://open.bigmodel.cn/api/anthropic/v1/models",
                "https://open.bigmodel.cn/v1/models",
                "https://open.bigmodel.cn/models",
            ]
        );
    }

    #[test]
    fn test_candidates_bailian_strip_apps_anthropic() {
        let c = build_models_url_candidates(
            "https://dashscope.aliyuncs.com/apps/anthropic",
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            c,
            vec![
                "https://dashscope.aliyuncs.com/apps/anthropic/v1/models",
                "https://dashscope.aliyuncs.com/v1/models",
                "https://dashscope.aliyuncs.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_stepfun_strip_step_plan() {
        let c =
            build_models_url_candidates("https://api.stepfun.com/step_plan", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.stepfun.com/step_plan/v1/models",
                "https://api.stepfun.com/v1/models",
                "https://api.stepfun.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_doubao_strip_api_coding() {
        let c = build_models_url_candidates(
            "https://ark.cn-beijing.volces.com/api/coding",
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            c,
            vec![
                "https://ark.cn-beijing.volces.com/api/coding/v1/models",
                "https://ark.cn-beijing.volces.com/v1/models",
                "https://ark.cn-beijing.volces.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_rightcode_strip_claude() {
        let c = build_models_url_candidates("https://www.right.codes/claude", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://www.right.codes/claude/v1/models",
                "https://www.right.codes/v1/models",
                "https://www.right.codes/models",
            ]
        );
    }

    #[test]
    fn test_candidates_longer_suffix_wins() {
        // baseURL 以 /api/anthropic 结尾时，应剥离整个 /api/anthropic，
        // 而不是只剥离 /anthropic（那样会得到残缺的 https://.../api 根）。
        let c = build_models_url_candidates("https://api.z.ai/api/anthropic", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.z.ai/api/anthropic/v1/models",
                "https://api.z.ai/v1/models",
                "https://api.z.ai/models",
            ]
        );
    }

    #[test]
    fn test_candidates_no_suffix_no_strip() {
        let c = build_models_url_candidates("https://openrouter.ai/api", false, None).unwrap();
        assert_eq!(c, vec!["https://openrouter.ai/api/v1/models"]);
    }

    #[test]
    fn test_candidates_deduplicate() {
        // 虚构 case：baseURL 就是 "scheme://host"，剥不出子路径，应只有一个候选。
        let c = build_models_url_candidates("https://host.example.com", false, None).unwrap();
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn test_parse_response() {
        let json = r#"{"object":"list","data":[{"id":"gpt-4","object":"model","owned_by":"openai"},{"id":"claude-3-sonnet","object":"model","owned_by":"anthropic"}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();
        assert_eq!(data.len(), 2);
        assert_eq!(data[0].id, "gpt-4");
        assert_eq!(data[0].owned_by.as_deref(), Some("openai"));
        assert_eq!(data[1].id, "claude-3-sonnet");
    }

    #[test]
    fn test_parse_response_no_owned_by() {
        let json = r#"{"object":"list","data":[{"id":"my-model","object":"model"}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();
        assert_eq!(data[0].id, "my-model");
        assert!(data[0].owned_by.is_none());
    }

    #[test]
    fn test_parse_response_empty_data() {
        let json = r#"{"object":"list","data":[]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        assert!(resp.data.unwrap().is_empty());
    }

    #[test]
    fn response_limit_rejects_excessive_declared_length() {
        let error = ensure_response_length_within_limit(Some(65), 64, "test response")
            .expect_err("oversized declared response must be rejected");
        assert!(error.contains("test response"));
        assert!(error.contains("64 bytes"));
        assert!(ensure_response_length_within_limit(Some(64), 64, "test response").is_ok());
        assert!(ensure_response_length_within_limit(None, 64, "test response").is_ok());
    }

    #[test]
    fn response_limit_stops_before_appending_oversized_chunk() {
        let mut body = vec![1_u8; 60];
        let error = append_response_chunk(&mut body, &[2_u8; 5], 64, "test response")
            .expect_err("streamed response must stop at the limit");
        assert_eq!(body.len(), 60, "oversized chunk must not be appended");
        assert!(error.contains("64 bytes"));

        append_response_chunk(&mut body, &[2_u8; 4], 64, "test response").unwrap();
        assert_eq!(body.len(), 64);
    }
}
