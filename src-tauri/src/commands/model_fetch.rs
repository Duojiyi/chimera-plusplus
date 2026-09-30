//! 模型列表获取命令
//!
//! 提供 Tauri 命令，供前端在供应商表单中获取可用模型列表。

use std::collections::HashMap;

use crate::product_policy::{self, Capability};
use crate::provider::LocalProxyRequestOverrides;
use crate::services::model_fetch::{self, FetchedModel, UpstreamRequestHeaders};

/// Headers for discovery and probe requests: the custom User-Agent (invalid
/// values are silently ignored, as in the forwarder) and the form's custom
/// request headers. Custom headers are gated by `custom_request_headers` and
/// validated like a save, so errors name the header but never echo a value.
fn request_headers(
    custom_user_agent: Option<&str>,
    custom_headers: Option<HashMap<String, String>>,
) -> Result<UpstreamRequestHeaders, String> {
    let user_agent = crate::provider::parse_custom_user_agent(custom_user_agent)
        .ok()
        .flatten();
    let headers = UpstreamRequestHeaders::with_user_agent(user_agent);
    let Some(custom_headers) = custom_headers.filter(|headers| !headers.is_empty()) else {
        return Ok(headers);
    };
    product_policy::require(Capability::CustomRequestHeaders).map_err(|error| error.to_string())?;
    let overrides = LocalProxyRequestOverrides {
        headers: custom_headers,
        body: None,
    };
    overrides
        .validate_headers()
        .map_err(|error| error.to_string())?;
    Ok(headers.with_overrides(Some(&overrides), true))
}

/// 获取供应商的可用模型列表
///
/// 使用 OpenAI 兼容的 GET /v1/models 端点。优先使用 `models_url` 精确覆写；
/// 否则对 baseURL 生成候选列表（含「剥离 Anthropic 兼容子路径」兜底），按序尝试。
#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_models_for_config(
    base_url: String,
    api_key: String,
    is_full_url: Option<bool>,
    models_url: Option<String>,
    custom_user_agent: Option<String>,
    custom_headers: Option<HashMap<String, String>>,
) -> Result<Vec<FetchedModel>, String> {
    let headers = request_headers(custom_user_agent.as_deref(), custom_headers)?;
    model_fetch::fetch_models(
        &base_url,
        &api_key,
        is_full_url.unwrap_or(false),
        models_url.as_deref(),
        headers,
    )
    .await
}

/// Safely detect whether a custom Codex endpoint implements Responses, Chat
/// Completions, or Anthropic Messages. The service uses a real model name with
/// an impossible token-budget type, so validation finishes before inference.
#[tauri::command(rename_all = "camelCase")]
pub async fn detect_codex_api_format(
    base_url: String,
    api_key: String,
    is_full_url: Option<bool>,
    model: Option<String>,
    custom_user_agent: Option<String>,
    custom_headers: Option<HashMap<String, String>>,
) -> Result<model_fetch::DetectedCodexApiFormat, String> {
    let headers = request_headers(custom_user_agent.as_deref(), custom_headers)?;
    model_fetch::detect_codex_api_format(
        &base_url,
        &api_key,
        is_full_url.unwrap_or(false),
        model.as_deref(),
        headers,
    )
    .await
}

/// Detect the upstream protocol for each selected model independently. Models
/// that reject the safe probe are omitted while successful detections remain
/// usable by the Codex router.
#[tauri::command(rename_all = "camelCase")]
pub async fn detect_codex_api_formats(
    base_url: String,
    api_key: String,
    is_full_url: Option<bool>,
    models: Vec<String>,
    custom_user_agent: Option<String>,
    custom_headers: Option<HashMap<String, String>>,
) -> Result<model_fetch::DetectedCodexApiFormats, String> {
    let headers = request_headers(custom_user_agent.as_deref(), custom_headers)?;
    model_fetch::detect_codex_api_formats(
        &base_url,
        &api_key,
        is_full_url.unwrap_or(false),
        models,
        headers,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_headers_are_gated_and_absent_headers_pass() {
        assert!(request_headers(Some("Chimera-Test/1.0"), None).is_ok());
        assert!(request_headers(None, Some(HashMap::new())).is_ok());
        let result = request_headers(
            None,
            Some(HashMap::from([("X-Gateway".into(), "team-a".into())])),
        );
        assert_eq!(
            result.is_ok(),
            Capability::CustomRequestHeaders.enabled(),
            "custom headers must follow the custom_request_headers capability"
        );
    }
}
