//! 模型列表获取服务
//!
//! 通过 OpenAI 兼容的 GET /v1/models 端点获取供应商可用模型列表。
//! 主要面向第三方聚合站（硅基流动、OpenRouter 等），以及把 Anthropic
//! 协议挂在兼容子路径上的官方供应商（DeepSeek、Kimi、智谱 GLM 等）。

use futures::{future::join_all, stream, StreamExt};
use reqwest::header::{HeaderValue, CONTENT_TYPE, USER_AGENT};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use url::Url;

use crate::proxy::codex_url::{codex_upstream_url, CodexUpstreamProtocol};

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
    models: Option<Vec<ModelEntry>>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    #[serde(alias = "slug")]
    id: String,
    owned_by: Option<String>,
}

const FETCH_TIMEOUT_SECS: u64 = 15;
const API_FORMAT_PROBE_TIMEOUT_SECS: u64 = 8;

/// 模型列表只需要一小段 JSON。限制实际读取量，避免异常或恶意端点耗尽内存。
const MAX_MODEL_DISCOVERY_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// 协议探测及错误诊断只消费有限响应体；协议判断所需标记远小于该上限。
const MAX_PROTOCOL_PROBE_RESPONSE_BYTES: usize = 64 * 1024;
/// Models probed at the same time. Each fans out to three protocol endpoints,
/// so this stays small; the global permit pool below bounds the actual burst.
const CODEX_MODEL_PROTOCOL_PROBE_CONCURRENCY: usize = 3;
/// Hard cap on probe requests in flight across all models and protocols.
const MAX_CONCURRENT_PROBE_REQUESTS: usize = 6;
/// Upstream error text quoted back to the user per failed probe.
const PROBE_EXCERPT_MAX_CHARS: usize = 200;

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

    let candidates = build_models_url_candidates(base_url, is_full_url, models_url_override)
        .map_err(|error| sanitize_probe_error(&error, api_key))?;
    let client = crate::proxy::http_client::get_for_auth_probe()
        .map_err(|error| sanitize_probe_error(&error, api_key))?;
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
                return Err(sanitize_probe_error(
                    &format!("Request failed: {e}"),
                    api_key,
                ));
            }
        };

        let status = response.status();

        if status.is_success() {
            let body = read_response_body_limited(
                response,
                MAX_MODEL_DISCOVERY_RESPONSE_BYTES,
                "model discovery response",
            )
            .await
            .map_err(|error| sanitize_probe_error(&error, api_key))?;
            let resp: ModelsResponse = serde_json::from_slice(&body).map_err(|error| {
                sanitize_probe_error(&format!("Failed to parse response: {error}"), api_key)
            })?;

            let mut models: Vec<FetchedModel> = resp
                .data
                .or(resp.models)
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

        let body = read_response_text_limited(
            response,
            MAX_PROTOCOL_PROBE_RESPONSE_BYTES,
            "model discovery error response",
        )
        .await
        .map_err(|error| sanitize_probe_error(&error, api_key))?;
        // Redact before truncating, including 404/405 fallback diagnostics.
        let error = format!(
            "HTTP {status}: {}",
            truncate_body(sanitize_probe_error(&body, api_key))
        );
        if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
            last_err = Some(error);
            continue;
        }
        return Err(error);
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

/// A protocol selected by the Codex API capability probe. An upstream that
/// ignores the deliberately invalid token budget can still generate billable output.
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

/// Per-model protocol detection report. A model missing from `detected` has an
/// entry in `failures` explaining why, as `HTTP <status> (<classification>)
/// <upstream excerpt>` (or `network error: …` / `timeout`), so the UI can show
/// the user what the gateway actually said instead of a bare "failed".
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCodexApiFormats {
    pub detected: HashMap<String, DetectedCodexApiFormat>,
    pub failures: HashMap<String, String>,
}

/// What a single protocol probe concluded about one endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeClassification {
    /// The endpoint validated the protocol-specific field we made invalid.
    ProtocolValidation,
    /// The endpoint accepted the protocol-shaped request but normalised the
    /// error; conversion protocols only, never enough for native Responses.
    GenericValidation,
    /// HTTP 2xx with a body in this protocol's shape: the gateway ignored the
    /// invalid budget and generated output. Strong evidence, but it cost money.
    Generated,
    /// The route does not exist on this gateway.
    RouteMissing,
    /// The gateway understood the route but refuses this model on it.
    CapabilityRejected,
    /// A Responses gateway that rejects the Codex tool surface.
    ToolSurfaceRejected,
    Unauthorized,
    Forbidden,
    RateLimited,
    UpstreamError,
    Timeout,
    Network,
    Inconclusive,
}

impl ProbeClassification {
    fn supports_protocol(self) -> bool {
        matches!(
            self,
            Self::ProtocolValidation | Self::GenericValidation | Self::Generated
        )
    }

    fn is_strong(self) -> bool {
        matches!(self, Self::ProtocolValidation | Self::Generated)
    }

    fn label(self) -> &'static str {
        match self {
            Self::ProtocolValidation => "protocol_validation",
            Self::GenericValidation => "generic_validation",
            Self::Generated => "generated_billable",
            Self::RouteMissing => "route_missing",
            Self::CapabilityRejected => "capability_rejected",
            Self::ToolSurfaceRejected => "tool_surface_rejected",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::RateLimited => "rate_limited",
            Self::UpstreamError => "upstream_error",
            Self::Timeout => "timeout",
            Self::Network => "network_error",
            Self::Inconclusive => "inconclusive",
        }
    }

    /// Rank alternative authentication attempts on the same protocol.
    /// Cross-protocol diagnostics preserve every route instead of using this rank.
    fn explanatory_rank(self) -> u8 {
        match self {
            Self::CapabilityRejected | Self::ToolSurfaceRejected => 7,
            Self::Unauthorized | Self::Forbidden => 6,
            Self::RateLimited => 5,
            Self::Timeout | Self::Network => 4,
            Self::UpstreamError => 3,
            Self::Inconclusive | Self::GenericValidation => 2,
            Self::ProtocolValidation | Self::Generated => 1,
            Self::RouteMissing => 0,
        }
    }
}

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
        self.upstream_protocol().api_format()
    }

    fn upstream_protocol(self) -> CodexUpstreamProtocol {
        match self {
            Self::Responses => CodexUpstreamProtocol::Native,
            Self::ChatCompletions => CodexUpstreamProtocol::Chat,
            Self::AnthropicMessages => CodexUpstreamProtocol::Anthropic,
        }
    }

    /// Substrings (of the lowercased body) that show the endpoint validated a
    /// field only this protocol has. `input` is deliberately matched only in
    /// field-like positions: pydantic's "Input should be a valid integer" and
    /// zod's "Invalid input: expected …" describe any field's type error and
    /// used to promote every `/responses` route that returned 400/422.
    fn validation_markers(self) -> &'static [&'static str] {
        match self {
            Self::Responses => &[
                "\"input",
                "'input",
                ".input",
                "input must",
                "input is required",
                "input field",
                "input parameter",
                "missing input",
                "input cannot",
                "max_output_tokens",
                "max output tokens",
                "responses api",
                "response api",
            ],
            Self::ChatCompletions => &[
                "messages",
                "max_tokens",
                "max tokens",
                "max_completion_tokens",
                "chat completion",
                "chat/completions",
            ],
            Self::AnthropicMessages => &[
                "messages",
                "max_tokens",
                "max tokens",
                "anthropic",
                "anthropic-version",
                "x-api-key",
            ],
        }
    }
}

#[derive(Debug, Clone)]
struct ApiProbeOutcome {
    probe: CodexApiProbe,
    classification: ProbeClassification,
    status: Option<StatusCode>,
    anthropic_auth_field: Option<&'static str>,
    /// Sanitised upstream error text, bounded, for diagnostics only.
    excerpt: String,
}

impl ApiProbeOutcome {
    fn supported(&self) -> bool {
        self.classification.supports_protocol()
    }

    /// `HTTP 400 (protocol_validation)` / `timeout` / `network_error`.
    fn status_summary(&self) -> String {
        match self.status {
            Some(status) => format!("HTTP {} ({})", status.as_u16(), self.classification.label()),
            None => self.classification.label().to_string(),
        }
    }
}

/// Why one model could not be identified, formatted for the UI as
/// `<protocol>: HTTP <status> (<classification>) <excerpt> | <other routes>`.
fn describe_probe_failure(outcomes: &[ApiProbeOutcome]) -> String {
    if outcomes.is_empty() {
        return "no protocol endpoint could be probed".to_string();
    }
    // Preserve protocol order and every bounded, sanitized excerpt. An expected
    // 403 on an unused protocol must not hide the relevant route's 502 body.
    outcomes
        .iter()
        .map(|outcome| {
            let mut text = format!(
                "{}: {}",
                outcome.probe.api_format(),
                outcome.status_summary()
            );
            if !outcome.excerpt.is_empty() {
                text.push(' ');
                text.push_str(&outcome.excerpt);
            }
            text
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

/// Detect which upstream protocol a custom Codex endpoint exposes.
///
/// A real model name is used so catch-all gateways cannot make every route look
/// valid by returning the same "model is required" response. The request then
/// supplies a deliberately invalid token-budget type to request schema validation.
/// Gateways may ignore it and generate billable output; this is not a guaranteed
/// non-generating probe. Authentication and protocol-agnostic errors cannot
/// establish protocol support.
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
    probe_model_protocol(base_url, api_key, is_full_url, &probe_model, user_agent)
        .await
        .map_err(|failure| {
            format!(
                "Could not safely identify a supported API protocol. Verify the endpoint, API Key, and model, or choose the protocol manually. {failure}"
            )
        })
}

/// Probe every candidate URL for one model and pick the protocol. `Err` carries
/// the per-route diagnostic string shown to the user.
async fn probe_model_protocol(
    base_url: &str,
    api_key: &str,
    is_full_url: bool,
    probe_model: &str,
    user_agent: Option<HeaderValue>,
) -> Result<DetectedCodexApiFormat, String> {
    let candidates = build_api_format_probe_urls(base_url, is_full_url)?;
    let client = crate::proxy::http_client::get_for_auth_probe()?;
    let probes = candidates.into_iter().map(|(probe, url)| {
        probe_codex_api_format_endpoint(
            &client,
            probe,
            url,
            api_key,
            probe_model,
            user_agent.clone(),
        )
    });
    let outcomes = join_all(probes).await;

    if let Some(outcome) = select_codex_api_probe_outcome(&outcomes, probe_model) {
        if outcome.classification == ProbeClassification::Generated {
            log::warn!(
                "[CODEX_PROTOCOL_PROBE_BILLABLE] {} answered the invalid probe with a generated {} response for model {probe_model}; the gateway ignores schema errors, so this probe was billable",
                outcome.probe.api_format(),
                outcome.status.map(|status| status.as_u16()).unwrap_or(0)
            );
        }
        return Ok(DetectedCodexApiFormat {
            api_format: outcome.probe.api_format().to_string(),
            anthropic_auth_field: outcome.anthropic_auth_field.map(str::to_string),
        });
    }
    Err(describe_probe_failure(&outcomes))
}

/// Detect the upstream protocol independently for each model in a catalog.
///
/// The endpoint may expose a mixed catalog (for example, Responses models next
/// to Chat Completions or Anthropic models). Every model gets either a
/// detection or a failure reason; the request count stays bounded by a global
/// permit pool so aggregators are not hit with dozens of concurrent probes.
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
                probe_model_protocol(base_url, api_key, is_full_url, &model, user_agent).await;
            (model, result)
        }
    }))
    .buffer_unordered(CODEX_MODEL_PROTOCOL_PROBE_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    let mut report = DetectedCodexApiFormats::default();
    for (model, result) in results {
        match result {
            Ok(detected) => {
                report.detected.insert(model, detected);
            }
            Err(reason) => {
                report.failures.insert(model, reason);
            }
        }
    }
    Ok(report)
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
    // Native Responses is only ever selected on strong evidence (a
    // Responses-shaped field error or a generated Responses body); generic
    // validation can never promote it, because a direct-connect line that turns
    // out to be a truncated gateway cannot carry Codex tools.
    if let Some(outcome) = outcomes.iter().find(|outcome| {
        outcome.probe == CodexApiProbe::Responses && outcome.classification.is_strong()
    }) {
        return Some(outcome);
    }

    // Some aggregators expose both Chat Completions and Anthropic Messages. For
    // Claude-family models prefer the native Messages surface; otherwise prefer
    // the broadly compatible Chat surface. Strong evidence on either conversion
    // route beats weak (normalised) evidence on the other before that
    // tie-breaker applies.
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
    let conversion = |strong_only: bool| {
        fallback_order.into_iter().find_map(|preferred| {
            outcomes.iter().find(|outcome| {
                outcome.probe == preferred
                    && outcome.supported()
                    && (!strong_only || outcome.classification.is_strong())
            })
        })
    };
    conversion(true).or_else(|| conversion(false))
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

    let mut attempts: Vec<(Option<&'static str>, ProbeAttempt)> =
        Vec::with_capacity(auth_variants.len());
    for auth_field in auth_variants {
        let attempt = send_codex_api_format_probe(
            client,
            probe,
            &url,
            api_key,
            probe_model,
            user_agent.clone(),
            *auth_field,
        )
        .await;
        let supported = attempt.classification.supports_protocol();
        attempts.push((*auth_field, attempt));
        if supported {
            break;
        }
    }

    // Report the attempt that got furthest: a supported one if any, otherwise
    // the most explanatory failure (a 401 on `x-api-key` followed by a 400 on
    // Bearer should surface the 400, which says what the gateway validated).
    let (auth_field, attempt) = attempts
        .into_iter()
        .max_by_key(|(_, attempt)| {
            (
                attempt.classification.supports_protocol(),
                attempt.classification.explanatory_rank(),
            )
        })
        .expect("at least one auth variant is probed");
    ApiProbeOutcome {
        probe,
        classification: attempt.classification,
        status: attempt.status,
        anthropic_auth_field: attempt
            .classification
            .supports_protocol()
            .then_some(auth_field)
            .flatten(),
        excerpt: attempt.excerpt,
    }
}

/// One HTTP exchange of the probe, after retries.
#[derive(Debug, Clone)]
struct ProbeAttempt {
    classification: ProbeClassification,
    status: Option<StatusCode>,
    excerpt: String,
}

/// Global cap on in-flight probe requests. One model fans out to three
/// protocols (Anthropic twice, for both auth headers) and several models are
/// probed at once, so without this an aggregator saw bursts of 20+ requests and
/// answered with 429s that were then read as "inconclusive".
fn probe_permits() -> &'static tokio::sync::Semaphore {
    static PERMITS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    PERMITS.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_PROBE_REQUESTS))
}

/// Longest we honour a `Retry-After` for a single probe retry.
const PROBE_RETRY_AFTER_CAP: Duration = Duration::from_secs(5);
const PROBE_RETRY_DEFAULT_DELAY: Duration = Duration::from_millis(1500);

async fn send_codex_api_format_probe(
    client: &reqwest::Client,
    probe: CodexApiProbe,
    url: &str,
    api_key: &str,
    probe_model: &str,
    user_agent: Option<HeaderValue>,
    anthropic_auth_field: Option<&str>,
) -> ProbeAttempt {
    let _permit = probe_permits().acquire().await.ok();
    let first = send_codex_api_format_probe_once(
        client,
        probe,
        url,
        api_key,
        probe_model,
        user_agent.clone(),
        anthropic_auth_field,
    )
    .await;

    // Rate limiting and transient 5xx say nothing about the protocol; one
    // retry after the server's own `Retry-After` turns most of them into a
    // real answer instead of an "inconclusive" that blocks the save.
    let retryable = matches!(
        first.attempt.classification,
        ProbeClassification::RateLimited | ProbeClassification::UpstreamError
    );
    if !retryable {
        return first.attempt;
    }
    tokio::time::sleep(first.retry_after.unwrap_or(PROBE_RETRY_DEFAULT_DELAY)).await;
    send_codex_api_format_probe_once(
        client,
        probe,
        url,
        api_key,
        probe_model,
        user_agent,
        anthropic_auth_field,
    )
    .await
    .attempt
}

struct ProbeExchange {
    attempt: ProbeAttempt,
    retry_after: Option<Duration>,
}

async fn send_codex_api_format_probe_once(
    client: &reqwest::Client,
    probe: CodexApiProbe,
    url: &str,
    api_key: &str,
    probe_model: &str,
    user_agent: Option<HeaderValue>,
    anthropic_auth_field: Option<&str>,
) -> ProbeExchange {
    let mut request = client
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .header("Accept", "application/json")
        // The shared client does not decompress; a gateway that gzips every
        // error body would otherwise hand the classifier binary noise.
        .header("Accept-Encoding", "identity")
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

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            let classification = if error.is_timeout() {
                ProbeClassification::Timeout
            } else {
                ProbeClassification::Network
            };
            return ProbeExchange {
                attempt: ProbeAttempt {
                    classification,
                    status: None,
                    excerpt: probe_excerpt(&sanitize_probe_error(&error.to_string(), api_key)),
                },
                retry_after: None,
            };
        }
    };

    let status = response.status();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| Duration::from_secs(seconds).min(PROBE_RETRY_AFTER_CAP));
    let body = match read_response_text_limited(
        response,
        MAX_PROTOCOL_PROBE_RESPONSE_BYTES,
        "protocol probe response",
    )
    .await
    {
        Ok(body) => body,
        Err(error) => {
            return ProbeExchange {
                attempt: ProbeAttempt {
                    classification: ProbeClassification::Inconclusive,
                    status: Some(status),
                    excerpt: probe_excerpt(&sanitize_probe_error(&error, api_key)),
                },
                retry_after,
            };
        }
    };

    // Classify the whole (bounded) body: the field name that proves the
    // protocol is often past the first 512 characters of a verbose error.
    let classification = classify_probe_response(probe, status, &body);
    ProbeExchange {
        attempt: ProbeAttempt {
            classification,
            status: Some(status),
            excerpt: probe_excerpt(&sanitize_probe_error(
                &upstream_error_message(&body),
                api_key,
            )),
        },
        retry_after,
    }
}

/// Whether an error the upstream returned for a real Responses request shows the
/// endpoint understood the Responses protocol (a Responses-shaped field error).
/// The router uses this to avoid re-routing a whole line to Chat because a
/// single request was malformed.
pub fn error_body_confirms_responses_protocol(status: u16, body: Option<&str>) -> bool {
    let Some(body) = body else {
        return false;
    };
    let Ok(status) = StatusCode::from_u16(status) else {
        return false;
    };
    classify_probe_response(CodexApiProbe::Responses, status, body)
        == ProbeClassification::ProtocolValidation
}

/// Decide what one probe response says about the protocol.
fn classify_probe_response(
    probe: CodexApiProbe,
    status: StatusCode,
    body: &str,
) -> ProbeClassification {
    let mut status = status;
    if status.is_success() {
        if let Some(protocol) = protocol_of_generated_body(body) {
            return if protocol == probe.upstream_protocol() {
                ProbeClassification::Generated
            } else {
                ProbeClassification::Inconclusive
            };
        }
        // MiniMax and a few gateways answer HTTP 200 and put the failure in
        // the body (`base_resp.status_code`). Classify the text as if it had
        // been a 400; a 200 with neither output nor error says nothing.
        if !body_carries_error_envelope(body) {
            return ProbeClassification::Inconclusive;
        }
        status = StatusCode::BAD_REQUEST;
    }
    if status == StatusCode::UNAUTHORIZED {
        return ProbeClassification::Unauthorized;
    }
    if status == StatusCode::FORBIDDEN {
        return ProbeClassification::Forbidden;
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return ProbeClassification::RateLimited;
    }
    let normalized = body.to_ascii_lowercase();
    if matches!(
        status,
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
    ) || response_indicates_missing_route(&normalized)
    {
        return ProbeClassification::RouteMissing;
    }
    if probe == CodexApiProbe::Responses && response_rejects_responses_tools(&normalized) {
        return ProbeClassification::ToolSurfaceRejected;
    }
    if response_indicates_model_capability_rejection(&normalized) {
        return ProbeClassification::CapabilityRejected;
    }
    if response_indicates_protocol_support(probe, status, body) {
        return ProbeClassification::ProtocolValidation;
    }
    if response_indicates_generic_validation_support(probe, status, body) {
        return ProbeClassification::GenericValidation;
    }
    if status.is_server_error() {
        return ProbeClassification::UpstreamError;
    }
    ProbeClassification::Inconclusive
}

/// A 2xx means the gateway ignored the deliberately invalid budget and ran the
/// request. The body's shape still identifies the protocol precisely.
fn protocol_of_generated_body(body: &str) -> Option<CodexUpstreamProtocol> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    match value.get("object").and_then(|object| object.as_str()) {
        Some("response") => return Some(CodexUpstreamProtocol::Native),
        Some("chat.completion") | Some("chat.completion.chunk") => {
            return Some(CodexUpstreamProtocol::Chat)
        }
        _ => {}
    }
    if value.get("type").and_then(|kind| kind.as_str()) == Some("message")
        && value
            .get("content")
            .is_some_and(|content| content.is_array())
    {
        return Some(CodexUpstreamProtocol::Anthropic);
    }
    None
}

/// Whether a 2xx body is really an error envelope.
fn body_carries_error_envelope(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    if value.get("error").is_some_and(|error| !error.is_null()) {
        return true;
    }
    value
        .pointer("/base_resp/status_code")
        .and_then(|code| code.as_i64())
        .is_some_and(|code| code != 0)
}

/// The text the protocol markers are matched against. pydantic-style gateways
/// echo the offending request value under `detail[].input`, so a Chat endpoint
/// rejecting the Responses probe for a missing `messages` field would echo
/// `input` and `max_output_tokens` right back and look like a Responses
/// endpoint. For those bodies only the field paths and messages are matched.
fn marker_text(body: &str) -> String {
    let details = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("detail")?.as_array().cloned())
        .filter(|items| items.iter().all(|item| item.is_object()));
    let Some(details) = details else {
        return body.to_ascii_lowercase();
    };
    details
        .iter()
        .map(|item| {
            let loc = item
                .get("loc")
                .and_then(|loc| loc.as_array())
                .map(|loc| {
                    loc.iter()
                        .map(|part| match part {
                            serde_json::Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .collect::<Vec<_>>()
                        .join(".")
                })
                .unwrap_or_default();
            let msg = item.get("msg").and_then(|m| m.as_str()).unwrap_or_default();
            let kind = item
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or_default();
            format!("{loc} {msg} {kind}")
        })
        .collect::<Vec<_>>()
        .join("; ")
        .to_ascii_lowercase()
}

/// The human-readable message inside a gateway error envelope, falling back to
/// the raw body. Handles `{"error":{"message":…}}`, `{"error":"…"}`,
/// `{"message":…}`, `{"detail":"…"}`, and pydantic `{"detail":[{"msg":…}]}`.
fn upstream_error_message(body: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return body.to_string();
    };
    let message = value
        .get("error")
        .and_then(|error| {
            error.as_str().map(str::to_string).or_else(|| {
                error
                    .get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            })
        })
        .or_else(|| {
            value
                .get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .or_else(|| {
            value
                .get("msg")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .or_else(|| {
            value.get("detail").and_then(|detail| {
                detail.as_str().map(str::to_string).or_else(|| {
                    detail.as_array().map(|items| {
                        items
                            .iter()
                            .filter_map(|item| {
                                let msg = item.get("msg")?.as_str()?;
                                let loc = item
                                    .get("loc")
                                    .and_then(|loc| loc.as_array())
                                    .map(|loc| {
                                        loc.iter()
                                            .filter_map(|part| part.as_str())
                                            .collect::<Vec<_>>()
                                            .join(".")
                                    })
                                    .unwrap_or_default();
                                Some(if loc.is_empty() {
                                    msg.to_string()
                                } else {
                                    format!("{loc}: {msg}")
                                })
                            })
                            .collect::<Vec<_>>()
                            .join("; ")
                    })
                })
            })
        });
    match message {
        Some(message) if !message.trim().is_empty() => message,
        _ => body.to_string(),
    }
}

/// Never let the API key travel into a log line or the UI, even when a gateway
/// or reqwest echoes the request.
fn sanitize_probe_error(text: &str, api_key: &str) -> String {
    let key = api_key.trim();
    if !key.is_empty() && text.contains(key) {
        text.replace(key, "[redacted]")
    } else {
        text.to_string()
    }
}

/// Excerpt shown to the user: whitespace collapsed, bounded on a character
/// boundary so multi-byte text cannot panic the truncation.
fn probe_excerpt(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= PROBE_EXCERPT_MAX_CHARS {
        collapsed
    } else {
        let mut excerpt: String = collapsed.chars().take(PROBE_EXCERPT_MAX_CHARS).collect();
        excerpt.push('…');
        excerpt
    }
}

/// Invalid by construction for all three protocols. A real model identifier is
/// present so a generic model-required response cannot masquerade as support,
/// while the token-budget value has an impossible JSON type and must fail schema
/// validation before inference can begin.
///
/// This is the endpoint and Codex-tool-surface probe: the Responses payload
/// includes a spec-compliant custom tool (`format`, not the Chat-style
/// `parameters` a strict gateway rejects as an unknown key before it ever looks
/// at the budget), while the invalid budget prevents generation. A truncated
/// gateway can therefore be rejected in the same non-generating call.
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
                "format": { "type": "text" }
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
    if response_indicates_missing_route(&normalized) {
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

    // "Unknown parameter: 'input'" is the endpoint saying it does not speak
    // this protocol at all; the field name alone must not count as support.
    if response_rejects_field_as_unknown(&normalized) {
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

    let text = marker_text(body);
    probe
        .validation_markers()
        .iter()
        .any(|marker| text.contains(marker))
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
    if response_indicates_missing_route(&normalized)
        || response_indicates_model_capability_rejection(&normalized)
        || response_rejects_field_as_unknown(&normalized)
        || [
            "invalid api key",
            "unauthorized",
            "forbidden",
            "model is required",
            "model not found",
            "model_not_found",
            "unsupported model",
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
        "invalid input",
        "invalid argument",
        "invalid_argument",
        "invalidparameter",
        "parameter is invalid",
        "parameter error",
        "bad request body",
        "request validation",
        "validation failed",
        "validation error",
        "参数错误",
        "参数有误",
        "参数非法",
        "参数不合法",
        "请求参数",
        "请求体错误",
        "字段错误",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

/// The route itself does not exist on this gateway (as opposed to existing but
/// rejecting the request). `convert_request_failed` is how some proxies report
/// a protocol they have no converter for.
fn response_indicates_missing_route(normalized_body: &str) -> bool {
    [
        "not found",
        "unknown endpoint",
        "unknown route",
        "unsupported endpoint",
        "cannot post",
        "no route",
        "route not found",
        "invalid url",
        "convert_request_failed",
        "404 page not found",
    ]
    .iter()
    .any(|marker| normalized_body.contains(marker))
}

/// The endpoint parsed our request and rejected one of the fields that define
/// the protocol (`input`, `messages`, `max_output_tokens`, …) as unknown. That
/// is the endpoint saying it speaks a different protocol; the echoed field name
/// must not be read as validation of it.
fn response_rejects_field_as_unknown(normalized_body: &str) -> bool {
    [
        "unknown parameter",
        "unrecognized request argument",
        "unrecognized key",
        "unrecognized field",
        "unknown field",
        "unexpected field",
        "extra inputs are not permitted",
        "additional properties are not allowed",
        "additional property",
        "not a valid field",
        "unexpected keyword argument",
        "unexpected parameter",
    ]
    .iter()
    .any(|marker| normalized_body.contains(marker))
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
///
/// The wording has to name the model or the API, not merely say "not
/// supported": OpenAI's Chat endpoint answers the probe for gpt-5 models with
/// `'max_tokens' is not supported with this model. Use 'max_completion_tokens'`
/// (`code: unsupported_parameter`), which is the endpoint understanding our
/// field perfectly — protocol evidence, not a rejection.
fn response_indicates_model_capability_rejection(normalized_body: &str) -> bool {
    if [
        "unsupported_parameter",
        "\"param\": \"max_tokens\"",
        "\"param\":\"max_tokens\"",
        "\"param\": \"max_output_tokens\"",
        "\"param\":\"max_output_tokens\"",
        "use 'max_completion_tokens'",
    ]
    .iter()
    .any(|marker| normalized_body.contains(marker))
    {
        return false;
    }

    [
        "model does not support",
        "model doesn't support",
        "model doesnt support",
        "does not support the responses",
        "does not support responses",
        "doesn't support the responses",
        "not support the responses api",
        "responses api is not supported",
        "responses api not supported",
        "responses api is not available",
        "not supported by this model",
        "not supported with this model",
        "not supported for this model",
        "not supported on this model",
        "unsupported for this model",
        "unsupported by this model",
        "unsupported_model",
        "model_unsupported",
        "model_not_supported",
        "responses_model_not_supported",
        "unsupported model capability",
        "not available for this model",
        "model is not available",
        "this model cannot",
        "model cannot",
        "not_supported",
        "不支持 responses api",
        "不支持responses api",
        "不支持 responses 接口",
        "模型不支持",
        "不支持该模型",
        "不支持此模型",
        "当前模型不支持",
    ]
    .iter()
    .any(|marker| normalized_body.contains(marker))
        || (normalized_body.contains("for this model")
            && ["unsupported", "invalid", "not allowed", "unavailable"]
                .iter()
                .any(|marker| normalized_body.contains(marker)))
}

/// The URLs to probe, one per protocol, each being exactly the URL the router
/// would send that protocol's requests to (see `proxy::codex_url`). A full URL
/// names a single endpoint, so only the protocol implied by its final path
/// segment is probed; probing sibling paths would test URLs the router never
/// uses, and a full URL with an unrecognisable ending cannot be probed at all.
fn build_api_format_probe_urls(
    base_url: &str,
    is_full_url: bool,
) -> Result<Vec<(CodexApiProbe, String)>, String> {
    let candidates: Vec<CodexApiProbe> = if is_full_url {
        let path = Url::parse(base_url.trim())
            .map_err(|error| format!("Invalid base URL: {error}"))?
            .path()
            .trim_end_matches('/')
            .to_ascii_lowercase();
        let implied = if path.ends_with("/chat/completions") {
            Some(CodexApiProbe::ChatCompletions)
        } else if path.ends_with("/messages") {
            Some(CodexApiProbe::AnthropicMessages)
        } else if path.ends_with("/responses") {
            Some(CodexApiProbe::Responses)
        } else {
            None
        };
        vec![implied.ok_or_else(|| {
            "完整 API 地址必须以 /responses、/chat/completions 或 /messages 结尾，否则无法判断协议"
                .to_string()
        })?]
    } else {
        CodexApiProbe::ALL.to_vec()
    };

    candidates
        .into_iter()
        .map(|probe| {
            let protocol = probe.upstream_protocol();
            codex_upstream_url(base_url, is_full_url, protocol, protocol.endpoint())
                .map(|url| (probe, url.to_string()))
        })
        .collect()
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

    #[tokio::test]
    async fn discovers_zhipu_response_model_slugs() {
        let (url, server) = serve_test_router(axum::Router::new().fallback(|| async {
            axum::Json(serde_json::json!({"models": [{"slug": "glm-5.3"}, {"slug": "glm-5"}]}))
        })).await;
        let models = fetch_models(&url, "test-discovery-key", false, None, None).await.unwrap();
        server.abort();
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), vec!["glm-5", "glm-5.3"]);
        assert!(models.iter().all(|model| model.owned_by.is_none()));
        let standard: ModelsResponse = serde_json::from_str(r#"{"data":[{"id":"gpt-test","owned_by":"vendor"}]}"#).unwrap();
        assert_eq!(standard.data.unwrap()[0].owned_by.as_deref(), Some("vendor"));
    }

    async fn serve_test_router(router: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (url, server)
    }

    #[tokio::test]
    async fn authenticated_discovery_does_not_follow_cross_origin_redirects() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        const KEY: &str = "audit-probe-fake-key";
        for status in [
            StatusCode::TEMPORARY_REDIRECT,
            StatusCode::PERMANENT_REDIRECT,
        ] {
            let redirected_requests = Arc::new(AtomicUsize::new(0));
            let received = redirected_requests.clone();
            let (destination, destination_server) =
                serve_test_router(axum::Router::new().fallback(move || {
                    let received = received.clone();
                    async move {
                        received.fetch_add(1, Ordering::SeqCst);
                        (StatusCode::BAD_REQUEST, "max_tokens must be an integer")
                    }
                }))
                .await;
            let key_requests = Arc::new(AtomicUsize::new(0));
            let received = key_requests.clone();
            let (origin, origin_server) = serve_test_router(axum::Router::new().fallback(
                move |headers: axum::http::HeaderMap| {
                    let received = received.clone();
                    let destination = destination.clone();
                    async move {
                        if headers
                            .get("x-api-key")
                            .and_then(|value| value.to_str().ok())
                            == Some(KEY)
                        {
                            received.fetch_add(1, Ordering::SeqCst);
                        }
                        (
                            status,
                            [(axum::http::header::LOCATION, destination)],
                            "redirect",
                        )
                    }
                },
            ))
            .await;

            let result = detect_codex_api_format(
                &format!("{origin}/v1/messages"),
                KEY,
                true,
                Some("claude-test"),
                None,
            )
            .await;
            let models_result = fetch_models(&origin, KEY, false, None, None).await;
            origin_server.abort();
            destination_server.abort();

            assert!(
                result.is_err(),
                "redirects must not establish protocol support"
            );
            assert!(models_result
                .unwrap_err()
                .contains(&format!("HTTP {status}")));
            assert_eq!(key_requests.load(Ordering::SeqCst), 1);
            assert_eq!(redirected_requests.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn model_discovery_redacts_all_upstream_error_branches_before_truncation() {
        const KEY: &str = "audit-model-discovery-fake-key";
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::METHOD_NOT_ALLOWED,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            // The echoed key crosses the truncation boundary.
            let body = format!("{}{KEY}", "x".repeat(ERROR_BODY_MAX_CHARS - 16));
            let (url, server) = serve_test_router(axum::Router::new().fallback(move || {
                let body = body.clone();
                async move { (status, body) }
            }))
            .await;
            // Compatibility paths exercise multiple 404/405 candidates.
            let result = fetch_models(&format!("{url}/api/coding"), KEY, false, None, None).await;
            server.abort();
            let error = result.unwrap_err();
            assert!(error.contains(&format!("HTTP {status}")));
            assert!(error.contains("[redacted]"));
            assert!(!error.contains("audit-model"), "{error}");
            assert_eq!(
                error.starts_with("All candidates failed:"),
                status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED
            );
        }
    }

    #[tokio::test]
    async fn model_discovery_redacts_schema_errors_from_success_responses() {
        const KEY: &str = "audit-model-discovery-fake-key";
        let body = serde_json::json!({ "data": KEY }).to_string();
        let (url, server) = serve_test_router(axum::Router::new().fallback(move || {
            let body = body.clone();
            async move { body }
        }))
        .await;
        let result = fetch_models(&url, KEY, false, None, None).await;
        server.abort();
        let error = result.unwrap_err();
        assert!(error.contains("Failed to parse response:"));
        assert!(error.contains("[redacted]"));
        assert!(!error.contains(KEY));
    }

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

        // A full URL is one endpoint: only the protocol its path implies is
        // probed, at exactly that URL. Probing sibling paths tested URLs the
        // router never calls.
        let full = build_api_format_probe_urls("https://gateway.example/v1/chat/completions", true)
            .unwrap();
        assert_eq!(
            full.iter()
                .map(|(probe, url)| (*probe, url.as_str()))
                .collect::<Vec<_>>(),
            vec![(
                CodexApiProbe::ChatCompletions,
                "https://gateway.example/v1/chat/completions"
            )]
        );
        let full_anthropic =
            build_api_format_probe_urls("https://gateway.example/anthropic/v1/messages/", true)
                .unwrap();
        assert_eq!(
            full_anthropic[0],
            (
                CodexApiProbe::AnthropicMessages,
                "https://gateway.example/anthropic/v1/messages/".to_string()
            )
        );
        assert!(build_api_format_probe_urls("https://gateway.example/custom/route", true).is_err());
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
            full,
            vec![(
                CodexApiProbe::ChatCompletions,
                "https://gateway.example/api/v1/chat/completions?tenant=acme".to_string()
            )]
        );
    }

    /// R2 truth table: for every base-URL shape seen in the wild, the URL the
    /// probe tests must be the URL the router forwards to. Both sides call
    /// `codex_upstream_url`, so this pins the contract rather than re-deriving
    /// the rules; the expected values document what the router actually does.
    #[test]
    fn protocol_probe_urls_equal_forwarding_urls_for_every_known_base_shape() {
        use crate::proxy::codex_url::codex_upstream_url;

        let cases: &[(&str, [&str; 3])] = &[
            (
                "https://api.deepseek.com/anthropic",
                [
                    "https://api.deepseek.com/anthropic/v1/responses",
                    "https://api.deepseek.com/anthropic/chat/completions",
                    "https://api.deepseek.com/anthropic/v1/messages",
                ],
            ),
            (
                "https://relay.example/claudecode",
                [
                    "https://relay.example/claudecode/v1/responses",
                    "https://relay.example/claudecode/chat/completions",
                    "https://relay.example/claudecode/v1/messages",
                ],
            ),
            (
                "https://open.bigmodel.cn/api/paas/v4",
                [
                    "https://open.bigmodel.cn/api/paas/v4/v1/responses",
                    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
                    "https://open.bigmodel.cn/api/paas/v4/v1/messages",
                ],
            ),
            (
                "https://ark.cn-beijing.volces.com/api/v3",
                [
                    "https://ark.cn-beijing.volces.com/api/v3/v1/responses",
                    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
                    "https://ark.cn-beijing.volces.com/api/v3/v1/messages",
                ],
            ),
            (
                "https://relay.example/api",
                [
                    "https://relay.example/api/v1/responses",
                    "https://relay.example/api/chat/completions",
                    "https://relay.example/api/v1/messages",
                ],
            ),
            (
                "https://api.kimi.com/coding",
                [
                    "https://api.kimi.com/coding/v1/responses",
                    "https://api.kimi.com/coding/chat/completions",
                    "https://api.kimi.com/coding/v1/messages",
                ],
            ),
            (
                "https://qianfan.baidubce.com/v2/coding",
                [
                    "https://qianfan.baidubce.com/v2/coding/v1/responses",
                    "https://qianfan.baidubce.com/v2/coding/chat/completions",
                    "https://qianfan.baidubce.com/v2/coding/v1/messages",
                ],
            ),
            (
                "https://chatgpt.com/backend-api/codex",
                [
                    "https://chatgpt.com/backend-api/codex/v1/responses",
                    "https://chatgpt.com/backend-api/codex/chat/completions",
                    "https://chatgpt.com/backend-api/codex/v1/messages",
                ],
            ),
            (
                "https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
                [
                    "https://gateway.ai.cloudflare.com/v1/acct/gw/compat/v1/responses",
                    "https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions",
                    "https://gateway.ai.cloudflare.com/v1/acct/gw/compat/v1/messages",
                ],
            ),
            (
                "https://openrouter.ai/api",
                [
                    "https://openrouter.ai/api/v1/responses",
                    "https://openrouter.ai/api/chat/completions",
                    "https://openrouter.ai/api/v1/messages",
                ],
            ),
            (
                "https://relay.example/openai",
                [
                    "https://relay.example/openai/v1/responses",
                    "https://relay.example/openai/chat/completions",
                    "https://relay.example/openai/v1/messages",
                ],
            ),
            (
                "https://relay.example/v1?tenant=a",
                [
                    "https://relay.example/v1/responses?tenant=a",
                    "https://relay.example/v1/chat/completions?tenant=a",
                    "https://relay.example/v1/messages?tenant=a",
                ],
            ),
            (
                "https://relay.example/V1",
                [
                    "https://relay.example/v1/responses",
                    "https://relay.example/v1/chat/completions",
                    "https://relay.example/v1/messages",
                ],
            ),
        ];

        for (base, expected) in cases {
            let probed = build_api_format_probe_urls(base, false).unwrap();
            assert_eq!(probed.len(), 3, "{base}");
            for ((probe, probe_url), expected_url) in probed.iter().zip(expected.iter()) {
                let protocol = probe.upstream_protocol();
                let forward_url =
                    codex_upstream_url(base, false, protocol, protocol.endpoint()).unwrap();
                assert_eq!(probe_url, &forward_url.to_string(), "{base} {protocol:?}");
                assert_eq!(probe_url, expected_url, "{base} {protocol:?}");
            }
        }
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

    fn classified_outcome(
        probe: CodexApiProbe,
        classification: ProbeClassification,
    ) -> ApiProbeOutcome {
        ApiProbeOutcome {
            probe,
            classification,
            status: Some(StatusCode::BAD_REQUEST),
            anthropic_auth_field: (probe == CodexApiProbe::AnthropicMessages
                && classification.supports_protocol())
            .then_some("ANTHROPIC_AUTH_TOKEN"),
            excerpt: String::new(),
        }
    }

    fn probe_outcome(probe: CodexApiProbe, supported: bool) -> ApiProbeOutcome {
        classified_outcome(
            probe,
            if supported {
                ProbeClassification::ProtocolValidation
            } else {
                ProbeClassification::Inconclusive
            },
        )
    }

    #[test]
    fn protocol_probe_selection_prefers_strong_conversion_evidence_over_weak() {
        // Both conversion routes answered, but only Chat echoed our field; the
        // Claude-name tie-breaker must not override that.
        let outcomes = [
            classified_outcome(CodexApiProbe::Responses, ProbeClassification::Inconclusive),
            classified_outcome(
                CodexApiProbe::ChatCompletions,
                ProbeClassification::ProtocolValidation,
            ),
            classified_outcome(
                CodexApiProbe::AnthropicMessages,
                ProbeClassification::GenericValidation,
            ),
        ];
        assert_eq!(
            select_codex_api_probe_outcome(&outcomes, "claude-sonnet-4-6")
                .unwrap()
                .probe,
            CodexApiProbe::ChatCompletions
        );

        // With weak evidence on both, the tie-breaker decides.
        let weak = [
            classified_outcome(CodexApiProbe::Responses, ProbeClassification::Inconclusive),
            classified_outcome(
                CodexApiProbe::ChatCompletions,
                ProbeClassification::GenericValidation,
            ),
            classified_outcome(
                CodexApiProbe::AnthropicMessages,
                ProbeClassification::GenericValidation,
            ),
        ];
        assert_eq!(
            select_codex_api_probe_outcome(&weak, "claude-sonnet-4-6")
                .unwrap()
                .probe,
            CodexApiProbe::AnthropicMessages
        );
        assert_eq!(
            select_codex_api_probe_outcome(&weak, "deepseek-v3.2")
                .unwrap()
                .probe,
            CodexApiProbe::ChatCompletions
        );
    }

    #[test]
    fn protocol_probe_selection_never_promotes_responses_on_weak_evidence() {
        let outcomes = [
            classified_outcome(
                CodexApiProbe::Responses,
                ProbeClassification::GenericValidation,
            ),
            classified_outcome(
                CodexApiProbe::ChatCompletions,
                ProbeClassification::GenericValidation,
            ),
            classified_outcome(
                CodexApiProbe::AnthropicMessages,
                ProbeClassification::Inconclusive,
            ),
        ];
        assert_eq!(
            select_codex_api_probe_outcome(&outcomes, "gpt-5.6-sol")
                .unwrap()
                .probe,
            CodexApiProbe::ChatCompletions
        );

        // A generated Responses body is strong evidence even though it billed.
        let generated = [
            classified_outcome(CodexApiProbe::Responses, ProbeClassification::Generated),
            classified_outcome(
                CodexApiProbe::ChatCompletions,
                ProbeClassification::ProtocolValidation,
            ),
            classified_outcome(
                CodexApiProbe::AnthropicMessages,
                ProbeClassification::RouteMissing,
            ),
        ];
        assert_eq!(
            select_codex_api_probe_outcome(&generated, "gpt-5.6-sol")
                .unwrap()
                .probe,
            CodexApiProbe::Responses
        );
    }

    /// Real gateway error bodies × the classifier. Each row is a body a probe
    /// has actually received (or a faithful reconstruction from the vendor's
    /// documented error format) together with what the probe must conclude.
    #[test]
    fn probe_corpus_classifies_real_gateway_bodies() {
        use CodexApiProbe::{
            AnthropicMessages as Anth, ChatCompletions as Chat, Responses as Resp,
        };
        use ProbeClassification::*;
        const S400: StatusCode = StatusCode::BAD_REQUEST;
        const S422: StatusCode = StatusCode::UNPROCESSABLE_ENTITY;

        let corpus: &[(&str, CodexApiProbe, StatusCode, &str, ProbeClassification)] = &[
            // OpenAI Chat, gpt-5 family: the endpoint understood max_tokens and
            // asked for max_completion_tokens instead. Protocol evidence.
            (
                "openai chat gpt-5 unsupported_parameter",
                Chat,
                S400,
                r#"{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.","type":"invalid_request_error","param":"max_tokens","code":"unsupported_parameter"}}"#,
                ProtocolValidation,
            ),
            (
                "openai chat invalid type",
                Chat,
                S400,
                r#"{"error":{"message":"Invalid type for 'max_tokens': expected an integer, but got an object instead.","type":"invalid_request_error","param":"max_tokens","code":"invalid_type"}}"#,
                ProtocolValidation,
            ),
            (
                "openai responses invalid type",
                Resp,
                S400,
                r#"{"error":{"message":"Invalid type for 'max_output_tokens': expected an integer, but got an object instead.","type":"invalid_request_error","param":"max_output_tokens","code":"invalid_type"}}"#,
                ProtocolValidation,
            ),
            // The other protocol's endpoint on OpenAI: it names our field as unknown.
            (
                "openai responses endpoint given chat probe",
                Chat,
                S400,
                r#"{"error":{"message":"Unknown parameter: 'messages'.","type":"invalid_request_error","param":"messages","code":"unknown_parameter"}}"#,
                Inconclusive,
            ),
            (
                "openai chat endpoint given responses probe",
                Resp,
                S400,
                r#"{"error":{"message":"Unrecognized request argument supplied: input","type":"invalid_request_error","param":null,"code":null}}"#,
                Inconclusive,
            ),
            // Anthropic native and Anthropic-compatible (DeepSeek /anthropic).
            (
                "anthropic messages",
                Anth,
                S400,
                r#"{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: Input should be a valid integer"}}"#,
                ProtocolValidation,
            ),
            (
                "anthropic 404 for responses",
                Resp,
                StatusCode::NOT_FOUND,
                r#"{"type":"error","error":{"type":"not_found_error","message":"Not Found"}}"#,
                RouteMissing,
            ),
            (
                "deepseek chat serde",
                Chat,
                S400,
                r#"{"error":{"message":"Failed to deserialize the JSON body into the target type: max_tokens: invalid type: map, expected u32 at line 1 column 123","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#,
                ProtocolValidation,
            ),
            (
                "moonshot chat",
                Chat,
                S400,
                r#"{"error":{"message":"Invalid request: max_tokens must be a positive integer","type":"invalid_request_error"}}"#,
                ProtocolValidation,
            ),
            // Zhipu: 1210 is a normalised message, 1214 names the field.
            (
                "zhipu 1210 generic",
                Chat,
                S400,
                r#"{"error":{"code":"1210","message":"API 调用参数有误，请检查文档。"}}"#,
                GenericValidation,
            ),
            (
                "zhipu 1214 field",
                Chat,
                S400,
                r#"{"error":{"code":"1214","message":"messages 参数非法。请检查文档。"}}"#,
                ProtocolValidation,
            ),
            // MiniMax reports failures inside an HTTP 200.
            (
                "minimax 2013 in a 200",
                Chat,
                StatusCode::OK,
                r#"{"base_resp":{"status_code":2013,"status_msg":"invalid params, max_tokens type error"}}"#,
                ProtocolValidation,
            ),
            (
                "dashscope invalid parameter",
                Chat,
                S400,
                r#"{"code":"InvalidParameter","message":"<400> InternalError.Algo.InvalidParameter: max_tokens must be an integer","request_id":"8f0a"}"#,
                ProtocolValidation,
            ),
            (
                "volcengine ark",
                Chat,
                S400,
                r#"{"error":{"code":"InvalidParameter","message":"The parameter `max_tokens` specified in the request are not valid: expected integer.","param":"max_tokens","type":"BadRequest"}}"#,
                ProtocolValidation,
            ),
            (
                "siliconflow 20015",
                Chat,
                S400,
                r#"{"code":20015,"message":"max_tokens: Input should be a valid integer","data":null}"#,
                ProtocolValidation,
            ),
            (
                "siliconflow 20012 model missing",
                Chat,
                S400,
                r#"{"code":20012,"message":"Model does not exist. Please check it carefully.","data":null}"#,
                Inconclusive,
            ),
            // OpenRouter: compact message, field only inside metadata.raw.
            (
                "openrouter chat with raw",
                Chat,
                S400,
                r#"{"error":{"message":"Invalid input","code":400,"metadata":{"raw":"[{\"code\":\"invalid_type\",\"expected\":\"number\",\"received\":\"object\",\"path\":[\"max_tokens\"],\"message\":\"Expected number, received object\"}]"}}}"#,
                ProtocolValidation,
            ),
            (
                "openrouter responses with raw",
                Resp,
                S400,
                r#"{"error":{"message":"Invalid input","code":400,"metadata":{"raw":"[{\"path\":[\"max_output_tokens\"],\"message\":\"Expected number, received object\"}]"}}}"#,
                ProtocolValidation,
            ),
            // R7: "Invalid input" alone must not be read as the Responses `input` field.
            (
                "openrouter compact responses",
                Resp,
                S400,
                r#"{"error":{"message":"Invalid input","code":400}}"#,
                Inconclusive,
            ),
            (
                "openrouter compact chat",
                Chat,
                S400,
                r#"{"error":{"message":"Invalid input","code":400}}"#,
                GenericValidation,
            ),
            // new-api maps schema validation to 500.
            (
                "new-api unmarshal 500",
                Chat,
                StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":{"message":"json: cannot unmarshal object into Go struct field GeneralOpenAIRequest.max_tokens of type uint","type":"new_api_error"}}"#,
                ProtocolValidation,
            ),
            (
                "litellm",
                Chat,
                S400,
                r#"{"error":{"message":"litellm.BadRequestError: OpenAIException - Invalid type for 'max_tokens': expected an integer, but got an object instead.","type":null,"param":null,"code":"400"}}"#,
                ProtocolValidation,
            ),
            // pydantic: the invalid value is echoed under `input`; only loc/msg count.
            (
                "pydantic responses endpoint",
                Resp,
                S422,
                r#"{"detail":[{"type":"int_type","loc":["body","max_output_tokens"],"msg":"Input should be a valid integer","input":{"chimeraProbe":true}}]}"#,
                ProtocolValidation,
            ),
            (
                "pydantic chat endpoint echoing the responses probe",
                Resp,
                S422,
                r#"{"detail":[{"type":"missing","loc":["body","messages"],"msg":"Field required","input":{"model":"x","input":"probe","max_output_tokens":{"chimeraProbe":true},"tools":[]}}]}"#,
                Inconclusive,
            ),
            (
                "pydantic extra field forbidden",
                Resp,
                S422,
                r#"{"detail":[{"type":"extra_forbidden","loc":["body","input"],"msg":"Extra inputs are not permitted","input":"probe"}]}"#,
                Inconclusive,
            ),
            // zod's generic wording must not match the `input` field either.
            (
                "zod generic",
                Resp,
                S400,
                r#"{"error":{"message":"Invalid input: expected number, received object"}}"#,
                Inconclusive,
            ),
            // Truncated Responses gateways.
            (
                "tokenrhythm feature not supported",
                Resp,
                S400,
                r#"{"error":{"message":"当前模型或上游不支持 Responses 能力：tool.custom","type":"invalid_request_error","code":"RESPONSES_FEATURE_NOT_SUPPORTED"}}"#,
                ToolSurfaceRejected,
            ),
            (
                "model not supported on responses (#2019)",
                Resp,
                S400,
                r#"{"error":{"message":"当前模型不支持 Responses API，请切换为 Chat Completions。","type":"invalid_request_error","code":"RESPONSES_MODEL_NOT_SUPPORTED"}}"#,
                CapabilityRejected,
            ),
            (
                "english model does not support",
                Resp,
                S400,
                r#"{"error":{"message":"This model does not support the Responses API. input and max_output_tokens are unsupported for this model."}}"#,
                CapabilityRejected,
            ),
            // The gateway ignored the invalid budget and generated: strong but billable.
            (
                "generated chat completion",
                Chat,
                StatusCode::OK,
                r#"{"id":"chatcmpl-1","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"total_tokens":12}}"#,
                Generated,
            ),
            (
                "generated response object",
                Resp,
                StatusCode::OK,
                r#"{"id":"resp_1","object":"response","output":[],"usage":{"total_tokens":12}}"#,
                Generated,
            ),
            (
                "generated anthropic message",
                Anth,
                StatusCode::OK,
                r#"{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}]}"#,
                Generated,
            ),
            (
                "generated body of another protocol",
                Resp,
                StatusCode::OK,
                r#"{"id":"chatcmpl-1","object":"chat.completion","choices":[]}"#,
                Inconclusive,
            ),
            // Transport-level outcomes.
            (
                "rate limited",
                Chat,
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}"#,
                RateLimited,
            ),
            (
                "bad key",
                Chat,
                StatusCode::UNAUTHORIZED,
                r#"{"error":{"message":"Incorrect API key provided"}}"#,
                Unauthorized,
            ),
            (
                "html 502",
                Chat,
                StatusCode::BAD_GATEWAY,
                "<html><body><h1>502 Bad Gateway</h1></body></html>",
                UpstreamError,
            ),
            (
                "html 404",
                Resp,
                StatusCode::NOT_FOUND,
                "<!DOCTYPE html><html><head><title>404 Not Found</title></head></html>",
                RouteMissing,
            ),
            (
                "405 method not allowed",
                Anth,
                StatusCode::METHOD_NOT_ALLOWED,
                "",
                RouteMissing,
            ),
            (
                "nginx 404 in a 400",
                Chat,
                S400,
                "404 page not found",
                RouteMissing,
            ),
        ];

        for (name, probe, status, body, expected) in corpus {
            let actual = classify_probe_response(*probe, *status, body);
            assert_eq!(actual, *expected, "{name}: {body}");
        }
    }

    #[test]
    fn responses_probe_body_uses_the_spec_compliant_custom_tool_shape() {
        let body: serde_json::Value =
            serde_json::from_str(&invalid_probe_body(CodexApiProbe::Responses, "gpt-5.6-sol"))
                .unwrap();
        let tool = &body["tools"][0];
        assert_eq!(tool["format"]["type"], "text");
        assert!(
            tool.get("parameters").is_none(),
            "Chat-style `parameters` is an unknown key on strict Responses gateways"
        );
    }

    #[test]
    fn probe_failure_description_preserves_every_route_and_excerpt() {
        let outcomes = [
            ApiProbeOutcome {
                probe: CodexApiProbe::Responses,
                classification: ProbeClassification::RouteMissing,
                status: Some(StatusCode::NOT_FOUND),
                anthropic_auth_field: None,
                excerpt: "404 page not found".to_string(),
            },
            ApiProbeOutcome {
                probe: CodexApiProbe::ChatCompletions,
                classification: ProbeClassification::CapabilityRejected,
                status: Some(StatusCode::BAD_REQUEST),
                anthropic_auth_field: None,
                excerpt: "当前模型不支持 Responses API".to_string(),
            },
            ApiProbeOutcome {
                probe: CodexApiProbe::AnthropicMessages,
                classification: ProbeClassification::Unauthorized,
                status: Some(StatusCode::UNAUTHORIZED),
                anthropic_auth_field: None,
                excerpt: String::new(),
            },
        ];
        let text = describe_probe_failure(&outcomes);
        assert!(
            text.contains(
                "openai_chat: HTTP 400 (capability_rejected) 当前模型不支持 Responses API"
            ),
            "{text}"
        );
        assert!(
            text.contains("openai_responses: HTTP 404 (route_missing)"),
            "{text}"
        );
        assert!(
            text.contains("anthropic: HTTP 401 (unauthorized)"),
            "{text}"
        );

        let network = [ApiProbeOutcome {
            probe: CodexApiProbe::Responses,
            classification: ProbeClassification::Timeout,
            status: None,
            anthropic_auth_field: None,
            excerpt: "operation timed out".to_string(),
        }];
        assert_eq!(
            describe_probe_failure(&network),
            "openai_responses: timeout operation timed out"
        );
    }

    #[test]
    fn forbidden_and_gateway_errors_do_not_confirm_a_protocol() {
        for probe in CodexApiProbe::ALL {
            assert_eq!(
                classify_probe_response(
                    probe,
                    StatusCode::FORBIDDEN,
                    "This group does not allow /v1/messages dispatch"
                ),
                ProbeClassification::Forbidden
            );
            assert_eq!(
                classify_probe_response(probe, StatusCode::BAD_GATEWAY, "upstream unavailable"),
                ProbeClassification::UpstreamError
            );
        }
        let outcomes = [
            ApiProbeOutcome {
                probe: CodexApiProbe::Responses,
                classification: ProbeClassification::UpstreamError,
                status: Some(StatusCode::BAD_GATEWAY),
                anthropic_auth_field: None,
                excerpt: "upstream unavailable".into(),
            },
            ApiProbeOutcome {
                probe: CodexApiProbe::AnthropicMessages,
                classification: ProbeClassification::Forbidden,
                status: Some(StatusCode::FORBIDDEN),
                anthropic_auth_field: None,
                excerpt: "group disallows messages".into(),
            },
        ];
        assert_eq!(describe_probe_failure(&outcomes),
            "openai_responses: HTTP 502 (upstream_error) upstream unavailable | anthropic: HTTP 403 (forbidden) group disallows messages");
        assert!(select_codex_api_probe_outcome(&outcomes, "gpt-6-astra").is_none());
    }

    #[test]
    fn probe_excerpt_is_bounded_on_character_boundaries_and_redacts_keys() {
        let long = "错".repeat(500);
        let excerpt = probe_excerpt(&long);
        assert_eq!(excerpt.chars().count(), PROBE_EXCERPT_MAX_CHARS + 1);
        assert!(excerpt.ends_with('…'));

        assert_eq!(probe_excerpt("  a \n\n b\tc  "), "a b c");
        assert_eq!(
            sanitize_probe_error("Bearer sk-live-1234567890 rejected", "sk-live-1234567890"),
            "Bearer [redacted] rejected"
        );
        // Even short configured credentials must not be echoed to the UI.
        assert_eq!(
            sanitize_probe_error("key abc rejected", "abc"),
            "key [redacted] rejected"
        );
        assert_eq!(sanitize_probe_error("missing key", ""), "missing key");
    }

    #[test]
    fn upstream_error_message_unwraps_common_envelopes() {
        assert_eq!(
            upstream_error_message(r#"{"error":{"message":"bad budget","type":"x"}}"#),
            "bad budget"
        );
        assert_eq!(
            upstream_error_message(r#"{"error":"bad budget"}"#),
            "bad budget"
        );
        assert_eq!(
            upstream_error_message(r#"{"message":"参数错误"}"#),
            "参数错误"
        );
        assert_eq!(
            upstream_error_message(
                r#"{"detail":[{"loc":["body","max_output_tokens"],"msg":"Input should be a valid integer","type":"int_type"}]}"#
            ),
            "body.max_output_tokens: Input should be a valid integer"
        );
        assert_eq!(
            upstream_error_message("<html>502</html>"),
            "<html>502</html>"
        );
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
