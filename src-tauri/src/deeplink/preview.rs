//! Confirmation preview for deep-link imports (MH-4).
//!
//! The confirm dialog shows what the backend will actually store: the full
//! content, the absolute paths of the live files it targets, whether
//! confirming writes those files right away, and the allowlist verdict for
//! every env key.

use super::env_allowlist::{classify_env_key, is_denied_env_key, EnvKeyStatus};
use super::provider::{build_provider_from_request, deeplink_import_may_activate};
use super::utils::decode_base64_param;
use super::{parse_and_merge_config, DeepLinkImportRequest};
use crate::app_config::AppType;
use crate::error::AppError;
use serde::Serialize;
use std::path::PathBuf;
use std::str::FromStr;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkImportPreview {
    /// Absolute paths of the live files this resource is written to once it
    /// is active. Empty when the resource never writes outside the database.
    pub target_paths: Vec<String>,
    /// Whether confirming writes `target_paths` immediately. When false the
    /// resource is only stored, disabled or inactive.
    pub writes_live: bool,
    /// The full content the link carries, as it will be stored (env keys are
    /// then filtered according to `env`).
    pub content: String,
    /// Allowlist verdict for every env key in the content.
    pub env: Vec<EnvKeyReview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvKeyReview {
    pub key: String,
    pub status: EnvKeyStatus,
}

pub fn preview_deeplink_import(
    request: &DeepLinkImportRequest,
) -> Result<DeepLinkImportPreview, AppError> {
    match request.resource.as_str() {
        "provider" => preview_provider(request),
        "prompt" => preview_prompt(request),
        "mcp" => preview_mcp(request),
        "skill" => Ok(DeepLinkImportPreview {
            target_paths: Vec::new(),
            writes_live: false,
            content: format!(
                "repo: {}\nbranch: {}\ndirectory: {}",
                request.repo.as_deref().unwrap_or_default(),
                request.branch.as_deref().unwrap_or("main"),
                request.directory.as_deref().unwrap_or_default(),
            ),
            env: Vec::new(),
        }),
        other => Err(AppError::InvalidInput(format!(
            "Unsupported resource type: {other}"
        ))),
    }
}

fn parse_app(request: &DeepLinkImportRequest) -> Result<AppType, AppError> {
    let app = request
        .app
        .as_deref()
        .ok_or_else(|| AppError::InvalidInput("Missing 'app' field".to_string()))?;
    AppType::from_str(app).map_err(|_| AppError::InvalidInput(format!("Invalid app type: {app}")))
}

fn absolute(path: PathBuf) -> String {
    std::path::absolute(&path)
        .unwrap_or(path)
        .display()
        .to_string()
}

/// The live files a provider switch writes for each tool.
fn provider_live_paths(app_type: &AppType) -> Vec<PathBuf> {
    match app_type {
        AppType::Claude => vec![crate::config::get_claude_settings_path()],
        // Claude Desktop writes through its own configuration library.
        AppType::ClaudeDesktop => Vec::new(),
        AppType::Codex => vec![
            crate::codex_config::get_codex_config_path(),
            crate::codex_config::get_codex_auth_path(),
        ],
        AppType::Gemini => vec![
            crate::gemini_config::get_gemini_env_path(),
            crate::gemini_config::get_gemini_settings_path(),
        ],
        AppType::GrokBuild => vec![crate::grok_config::get_grok_config_path()],
        AppType::OpenCode => vec![crate::opencode_config::get_opencode_config_path()],
        AppType::OpenClaw => vec![crate::openclaw_config::get_openclaw_config_path()],
        AppType::Hermes => vec![crate::hermes_config::get_hermes_config_path()],
    }
}

fn preview_provider(request: &DeepLinkImportRequest) -> Result<DeepLinkImportPreview, AppError> {
    let merged = parse_and_merge_config(request)?;
    let app_type = parse_app(&merged)?;
    let provider = build_provider_from_request(&app_type, &merged)?;
    let env = provider
        .settings_config
        .get("env")
        .and_then(|env| env.as_object())
        .map(|env| {
            env.keys()
                .map(|key| EnvKeyReview {
                    key: key.clone(),
                    status: classify_env_key(&app_type, key),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(DeepLinkImportPreview {
        target_paths: provider_live_paths(&app_type)
            .into_iter()
            .map(absolute)
            .collect(),
        writes_live: merged.enabled.unwrap_or(false) && deeplink_import_may_activate(&app_type),
        content: serde_json::to_string_pretty(&provider.settings_config)
            .map_err(|source| AppError::JsonSerialize { source })?,
        env,
    })
}

fn preview_prompt(request: &DeepLinkImportRequest) -> Result<DeepLinkImportPreview, AppError> {
    let app_type = parse_app(request)?;
    let content_b64 = request
        .content
        .as_deref()
        .ok_or_else(|| AppError::InvalidInput("Missing 'content' field for prompt".to_string()))?;
    let content = String::from_utf8(decode_base64_param("content", content_b64)?)
        .map_err(|e| AppError::InvalidInput(format!("Invalid UTF-8 in content: {e}")))?;
    Ok(DeepLinkImportPreview {
        target_paths: vec![absolute(crate::prompt_files::prompt_file_path(&app_type)?)],
        // Prompts always import disabled (see `import_prompt_from_deeplink`).
        writes_live: false,
        content,
        env: Vec::new(),
    })
}

fn preview_mcp(request: &DeepLinkImportRequest) -> Result<DeepLinkImportPreview, AppError> {
    let config_b64 = request
        .config
        .as_deref()
        .ok_or_else(|| AppError::InvalidInput("Missing 'config' parameter for MCP".to_string()))?;
    let decoded = String::from_utf8(decode_base64_param("config", config_b64)?)
        .map_err(|e| AppError::InvalidInput(format!("Invalid UTF-8 in config: {e}")))?;
    let config: serde_json::Value = serde_json::from_str(&decoded)
        .map_err(|e| AppError::InvalidInput(format!("Invalid JSON in MCP config: {e}")))?;

    // MCP servers import inert and are enabled per tool from MCP settings,
    // so there is no per-tool allowlist here; only the deny list is reported.
    let mut env: Vec<EnvKeyReview> = Vec::new();
    let servers = config
        .get("mcpServers")
        .and_then(|servers| servers.as_object());
    for spec in servers.into_iter().flat_map(|servers| servers.values()) {
        for key in spec
            .get("env")
            .and_then(|vars| vars.as_object())
            .into_iter()
            .flat_map(|vars| vars.keys())
        {
            if env.iter().all(|review| &review.key != key) {
                env.push(EnvKeyReview {
                    key: key.clone(),
                    status: if is_denied_env_key(key) {
                        EnvKeyStatus::Denied
                    } else {
                        EnvKeyStatus::Allowed
                    },
                });
            }
        }
    }
    Ok(DeepLinkImportPreview {
        target_paths: Vec::new(),
        writes_live: false,
        content: serde_json::to_string_pretty(&config)
            .map_err(|source| AppError::JsonSerialize { source })?,
        env,
    })
}
