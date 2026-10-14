//! Confirmation preview for deep-link imports (MH-4).
//!
//! The confirm dialog shows what the backend will actually store: the full
//! content, the absolute paths of the live files it targets, whether
//! confirming writes those files right away, and the allowlist verdict for
//! every env key.

use super::codex_link::{self, CodexLinkConfig};
use super::env_allowlist::{classify_env_key, is_denied_env_key, EnvKeyStatus};
use super::provider::{
    build_provider_from_request, decode_link_config, deeplink_import_may_activate,
    get_primary_endpoint, grok_ignored_keys,
};
use super::utils::decode_base64_param;
use super::{parse_and_merge_config, DeepLinkImportRequest};
use crate::app_config::AppType;
use crate::error::AppError;
use serde::Serialize;
use std::path::PathBuf;
use std::str::FromStr;
use url::Url;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkImportPreview {
    /// Absolute paths of the live files this resource is written to once it
    /// is active. Empty when the resource never writes outside the database.
    pub target_paths: Vec<String>,
    /// Whether the link itself asks to write `target_paths` on confirm. For
    /// providers the dialog sends the user's own choice instead (see
    /// `may_activate`).
    pub writes_live: bool,
    /// Whether confirming may switch to this provider at all (a visible tool
    /// whose links may activate). The dialog offers the switch only then.
    pub may_activate: bool,
    /// The full content the link carries, as it will be stored (env keys are
    /// then filtered according to `env`).
    pub content: String,
    /// Allowlist verdict for every env key in the content.
    pub env: Vec<EnvKeyReview>,
    /// The usage query script the link carries, if any.
    pub usage: Option<UsageScriptPreview>,
    /// Names of link parameters and config entries that are not imported.
    pub ignored: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvKeyReview {
    pub key: String,
    pub status: EnvKeyStatus,
}

/// A link's usage query script, shown before the user decides to enable it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageScriptPreview {
    /// The decoded script, exactly as it will be stored.
    pub code: String,
    /// Hosts the script may contact. A link's script has no template type,
    /// so `usage_script` only lets it reach the same host and port as its
    /// base URL: the link's `usageBaseUrl`, or the provider's address.
    pub hosts: Vec<String>,
    /// The link asked for the query to be enabled. Only the dialog's switch
    /// decides.
    pub link_requests_enabled: bool,
    /// Automatic query interval in minutes, when the link sets one.
    pub auto_interval_minutes: Option<u64>,
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
            may_activate: false,
            content: format!(
                "repo: {}\nbranch: {}\ndirectory: {}",
                request.repo.as_deref().unwrap_or_default(),
                request.branch.as_deref().unwrap_or("main"),
                request.directory.as_deref().unwrap_or_default(),
            ),
            env: Vec::new(),
            usage: None,
            ignored: Vec::new(),
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

        AppType::Pi => crate::pi_config::get_pi_models_path()
            .map(|path| vec![path])
            .unwrap_or_default(),
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
    let may_activate = deeplink_import_may_activate(&app_type);
    Ok(DeepLinkImportPreview {
        target_paths: provider_live_paths(&app_type)
            .into_iter()
            .map(absolute)
            .collect(),
        writes_live: merged.enabled.unwrap_or(false) && may_activate,
        may_activate,
        content: serde_json::to_string_pretty(&provider.settings_config)
            .map_err(|source| AppError::JsonSerialize { source })?,
        env,
        usage: usage_preview(&merged)?,
        ignored: ignored_settings(&app_type, &merged)?,
    })
}

fn usage_preview(request: &DeepLinkImportRequest) -> Result<Option<UsageScriptPreview>, AppError> {
    let Some(script) = request.usage_script.as_deref() else {
        return Ok(None);
    };
    let code = String::from_utf8(decode_base64_param("usage_script", script)?)
        .map_err(|e| AppError::InvalidInput(format!("Invalid UTF-8 in usage_script: {e}")))?;
    if code.trim().is_empty() {
        return Ok(None);
    }
    // Same base URL `services::provider::usage` resolves for the script.
    let base_url = request
        .usage_base_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| get_primary_endpoint(request));
    Ok(Some(UsageScriptPreview {
        code,
        hosts: url_host(&base_url).into_iter().collect(),
        link_requests_enabled: request.usage_enabled.unwrap_or(false),
        auto_interval_minutes: request.usage_auto_interval.filter(|minutes| *minutes > 0),
    }))
}

/// `host` or `host:port` (the port only when it is not the scheme's default).
fn url_host(url: &str) -> Option<String> {
    let url = Url::parse(url.trim()).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

/// Link parameters and config entries the import leaves out, so the dialog
/// can say so. Names only, never values.
fn ignored_settings(
    app_type: &AppType,
    request: &DeepLinkImportRequest,
) -> Result<Vec<String>, AppError> {
    let mut ignored = Vec::new();
    if !matches!(app_type, AppType::Claude | AppType::ClaudeDesktop) {
        for (param, value) in [
            ("haikuModel", &request.haiku_model),
            ("sonnetModel", &request.sonnet_model),
            ("opusModel", &request.opus_model),
        ] {
            if value.is_some() {
                ignored.push(param.to_string());
            }
        }
    }
    let Some(config) = decode_link_config(request)? else {
        return Ok(ignored);
    };
    match app_type {
        AppType::Claude | AppType::ClaudeDesktop => {
            ignored.extend(other_keys(&config, &["env"]));
        }
        AppType::Codex => {
            ignored.extend(codex_link::ignored_wrapper_keys(&config));
            if let Some(text) = codex_link::config_text(&config)? {
                ignored.extend(CodexLinkConfig::parse(&text)?.ignored);
            }
        }
        AppType::Gemini => ignored.extend(other_keys(
            &config,
            &[
                "GEMINI_API_KEY",
                "GEMINI_BASE_URL",
                "GOOGLE_GEMINI_BASE_URL",
                "GEMINI_MODEL",
            ],
        )),
        AppType::GrokBuild => ignored.extend(grok_ignored_keys(&config)?),
        AppType::OpenCode | AppType::Pi => {
            ignored.extend(other_keys(
                &config,
                &["apiKey", "api_key", "baseUrl", "base_url", "options"],
            ));
            if let Some(options) = config.get("options").and_then(|o| o.as_object()) {
                ignored.extend(
                    options
                        .keys()
                        .filter(|key| key.as_str() != "baseURL")
                        .map(|key| format!("options.{key}")),
                );
            }
        }
    }
    Ok(ignored)
}

/// Top-level keys of a JSON config other than `used`.
fn other_keys(config: &serde_json::Value, used: &[&str]) -> Vec<String> {
    config
        .as_object()
        .map(|object| {
            object
                .keys()
                .filter(|key| !used.contains(&key.as_str()))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
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
        may_activate: false,
        content,
        env: Vec::new(),
        usage: None,
        ignored: Vec::new(),
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
        may_activate: false,
        content: serde_json::to_string_pretty(&config)
            .map_err(|source| AppError::JsonSerialize { source })?,
        env,
        usage: None,
        ignored: Vec::new(),
    })
}
