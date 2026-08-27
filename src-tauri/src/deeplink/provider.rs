//! Provider import from deep link
//!
//! Handles importing provider configurations via ccswitch:// URLs.

use super::utils::{decode_base64_param, infer_homepage_from_endpoint};
use super::DeepLinkImportRequest;
use crate::error::AppError;
use crate::provider::{ClaudeDesktopMode, Provider, ProviderMeta, UsageScript};
use crate::services::ProviderService;
use crate::settings::CustomEndpoint;
use crate::store::AppState;
use crate::AppType;
use serde_json::json;
use std::str::FromStr;

/// Import a provider from a deep link request
///
/// This function:
/// 1. Validates the request
/// 2. Merges config file if provided (v3.8+)
/// 3. Converts it to a Provider structure
/// 4. Delegates to ProviderService for actual import
/// 5. Optionally sets as current provider if enabled=true
pub async fn import_provider_from_deeplink(
    state: &AppState,
    request: DeepLinkImportRequest,
) -> Result<String, AppError> {
    validate_request_limits(&request)?;
    // Verify this is a provider request
    if request.resource != "provider" {
        return Err(AppError::InvalidInput(format!(
            "Expected provider resource, got '{}'",
            request.resource
        )));
    }

    // Step 1: Merge config file if provided (v3.8+)
    let mut merged_request = parse_and_merge_config(&request)?;

    // Extract required fields (now as Option)
    let app_str = merged_request
        .app
        .clone()
        .ok_or_else(|| AppError::InvalidInput("Missing 'app' field for provider".to_string()))?;

    let api_key = merged_request.api_key.as_ref().ok_or_else(|| {
        AppError::InvalidInput("API key is required (either in URL or config file)".to_string())
    })?;

    if api_key.is_empty() {
        return Err(AppError::InvalidInput(
            "API key cannot be empty".to_string(),
        ));
    }

    // Get endpoint: supports comma-separated multiple URLs (first is primary)
    let endpoint_str = merged_request.endpoint.as_ref().ok_or_else(|| {
        AppError::InvalidInput("Endpoint is required (either in URL or config file)".to_string())
    })?;

    // Parse endpoints: split by comma, first is primary
    let all_endpoints: Vec<String> = endpoint_str
        .split(',')
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect();

    let primary_endpoint = all_endpoints
        .first()
        .ok_or_else(|| AppError::InvalidInput("Endpoint cannot be empty".to_string()))?;

    // Auto-infer homepage from endpoint if not provided
    if merged_request
        .homepage
        .as_ref()
        .is_none_or(|s| s.is_empty())
    {
        merged_request.homepage = infer_homepage_from_endpoint(primary_endpoint);
    }

    let homepage = merged_request.homepage.as_ref().ok_or_else(|| {
        AppError::InvalidInput("Homepage is required (either in URL or config file)".to_string())
    })?;

    if homepage.is_empty() {
        return Err(AppError::InvalidInput(
            "Homepage cannot be empty".to_string(),
        ));
    }

    let name = merged_request
        .name
        .clone()
        .ok_or_else(|| AppError::InvalidInput("Missing 'name' field for provider".to_string()))?;

    // Parse app type
    let app_type = AppType::from_str(&app_str)
        .map_err(|_| AppError::InvalidInput(format!("Invalid app type: {app_str}")))?;

    // Build provider configuration based on app type.
    let mut provider = build_provider_from_request(&app_type, &merged_request)?;
    let enabled = merged_request.enabled.unwrap_or(false);

    // An enabled Codex-family deep link must persist the resolved upstream
    // protocol before the provider is added. Otherwise the generated Codex
    // config says Responses for every endpoint and the automatic switch path
    // cannot know that Chat Completions/Anthropic translation is required.
    if matches!(app_type, AppType::Codex | AppType::GrokBuild) {
        let detected = crate::services::model_fetch::detect_codex_api_format(
            primary_endpoint,
            api_key,
            false,
            merged_request.model.as_deref(),
            None,
        )
        .await
        .map_err(|e| AppError::Message(format!("自动识别上游 API 协议失败: {e}")))?;
        let meta = provider.meta.get_or_insert_with(ProviderMeta::default);
        meta.api_format = Some(detected.api_format);
        meta.api_key_field = detected.anthropic_auth_field;
    }

    // Generate a unique ID for the provider using timestamp + sanitized name
    let timestamp = chrono::Utc::now().timestamp_millis();
    let sanitized_name = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>()
        .to_lowercase();
    provider.id = format!("{sanitized_name}-{timestamp}");

    let provider_id = provider.id.clone();

    // Persist alternate endpoints as part of the provider row itself. This keeps
    // enabled imports inside one Profile transaction instead of mutating the
    // staged provider after activation has released profile_apply_lock.
    let endpoint_added_at = chrono::Utc::now().timestamp_millis();
    let meta = provider.meta.get_or_insert_with(ProviderMeta::default);
    for ep in all_endpoints.iter().skip(1) {
        let normalized = ep.trim().trim_end_matches('/').to_string();
        if !normalized.is_empty() {
            meta.custom_endpoints.insert(
                normalized.clone(),
                CustomEndpoint {
                    url: normalized,
                    added_at: endpoint_added_at,
                    last_used: None,
                },
            );
        }
    }

    if enabled {
        // Snapshotting, staging, activation and failure compensation for every
        // app run under the shared profile_apply_lock. Codex-family apps also
        // hold lifecycle/per-app locks and reconcile automatic routing.
        crate::add_and_activate_provider_with_automatic_routing_state(
            state.clone(),
            app_type.clone(),
            provider,
            true,
        )
        .await
        .map_err(AppError::Message)?;
        log::info!("Provider '{provider_id}' set as current for {app_type:?}");
    } else {
        // A disabled/default Deep Link is import-only, even in a fresh profile.
        // ProviderService::add would auto-select the first provider and mutate
        // Live, violating enabled=false and potentially activating before route
        // reconciliation. Always stage it as inactive instead.
        ProviderService::add_inactive(state, app_type.clone(), provider, true)?;
    }

    Ok(provider_id)
}

/// Build a Provider structure from a deep link request
pub(crate) fn build_provider_from_request(
    app_type: &AppType,
    request: &DeepLinkImportRequest,
) -> Result<Provider, AppError> {
    let settings_config = match app_type {
        AppType::Claude | AppType::ClaudeDesktop => build_claude_settings(request),
        AppType::Codex => build_codex_settings(request),
        AppType::Gemini => build_gemini_settings(request),
        AppType::GrokBuild => build_grokbuild_settings(request),
        AppType::OpenCode => build_opencode_settings(request),
        AppType::OpenClaw => build_additive_app_settings(request),
        AppType::Hermes => build_hermes_settings(request),
    };

    // Build usage script configuration if provided
    let mut meta = build_provider_meta(request)?;
    if matches!(app_type, AppType::ClaudeDesktop) {
        meta.get_or_insert_with(ProviderMeta::default)
            .claude_desktop_mode = Some(ClaudeDesktopMode::Direct);
    }

    let provider = Provider {
        id: String::new(), // Will be generated by caller
        name: request.name.clone().unwrap_or_default(),
        settings_config,
        website_url: request.homepage.clone(),
        category: None,
        created_at: None,
        sort_index: None,
        notes: request.notes.clone(),
        meta,
        icon: request.icon.clone(),
        icon_color: None,
        in_failover_queue: false,
    };

    Ok(provider)
}

/// Get primary endpoint from request (first one if comma-separated)
fn get_primary_endpoint(request: &DeepLinkImportRequest) -> String {
    request
        .endpoint
        .as_ref()
        .and_then(|ep| ep.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn normalize_deeplink_api_key(api_key: &str) -> String {
    api_key.trim().to_string()
}

fn normalize_deeplink_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

fn usage_api_key_override(request: &DeepLinkImportRequest) -> Option<String> {
    let usage_api_key = normalize_deeplink_api_key(request.usage_api_key.as_deref()?);
    if usage_api_key.is_empty() {
        return None;
    }

    let provider_api_key = request
        .api_key
        .as_deref()
        .map(normalize_deeplink_api_key)
        .unwrap_or_default();

    if !provider_api_key.is_empty() && usage_api_key == provider_api_key {
        None
    } else {
        Some(usage_api_key)
    }
}

fn usage_base_url_override(request: &DeepLinkImportRequest) -> Option<String> {
    let usage_base_url = normalize_deeplink_base_url(request.usage_base_url.as_deref()?);
    if usage_base_url.is_empty() {
        return None;
    }

    let provider_base_url = normalize_deeplink_base_url(&get_primary_endpoint(request));

    if !provider_base_url.is_empty() && usage_base_url == provider_base_url {
        None
    } else {
        Some(usage_base_url)
    }
}

/// Build provider meta with usage script configuration
fn build_provider_meta(request: &DeepLinkImportRequest) -> Result<Option<ProviderMeta>, AppError> {
    // Check if any usage script fields are provided
    if request.usage_script.is_none()
        && request.usage_enabled.is_none()
        && request.usage_api_key.is_none()
        && request.usage_base_url.is_none()
        && request.usage_access_token.is_none()
        && request.usage_user_id.is_none()
        && request.usage_auto_interval.is_none()
    {
        return Ok(None);
    }

    // Decode usage script code if provided
    let code = if let Some(script_b64) = &request.usage_script {
        let decoded = decode_base64_param("usage_script", script_b64)?;
        String::from_utf8(decoded)
            .map_err(|e| AppError::InvalidInput(format!("Invalid UTF-8 in usage_script: {e}")))?
    } else {
        String::new()
    };

    // Determine enabled state: explicit param > has code > false
    let enabled = request.usage_enabled.unwrap_or(!code.is_empty());

    let usage_script = UsageScript {
        enabled,
        language: "javascript".to_string(),
        code,
        timeout: Some(10),
        api_key: usage_api_key_override(request),
        base_url: usage_base_url_override(request),
        access_token: request.usage_access_token.clone(),
        user_id: request.usage_user_id.clone(),
        template_type: None, // Deeplink providers don't specify template type (will use backward compatibility logic)
        auto_query_interval: request.usage_auto_interval,
        coding_plan_provider: None,
        access_key_id: None,
        secret_access_key: None,
        team_organization_id: None,
        team_project_id: None,
    };

    Ok(Some(ProviderMeta {
        usage_script: Some(usage_script),
        ..Default::default()
    }))
}

/// Build Claude settings configuration
///
/// Merges env from the inline config (if any) with the standard fields from URL params.
/// URL params take priority — they overwrite same-named fields from the config.
/// Non-standard env fields (e.g. `ANTHROPIC_CUSTOM_HEADERS`, `API_TIMEOUT_MS`,
/// `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, ...) are preserved as-is so that
/// providers requiring extra environment variables work after deeplink import.
fn build_claude_settings(request: &DeepLinkImportRequest) -> serde_json::Value {
    // Start from the full env block in the inline config (if present), so any
    // custom env vars the user passed via `config=<base64-json>` survive the
    // import. Falling back to an empty map keeps the previous behavior for
    // deeplinks that don't carry a config field.
    let mut env = extract_claude_config_env(request).unwrap_or_default();

    // Now overwrite / fill in the standard fields from URL params. URL params
    // are authoritative because they're what the deeplink builder put on the
    // wire — for Claude these are: ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL,
    // ANTHROPIC_MODEL, and the haiku/sonnet/opus model aliases.
    env.insert(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        json!(request.api_key.clone().unwrap_or_default()),
    );
    env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        json!(get_primary_endpoint(request)),
    );

    // Add default model if provided
    if let Some(model) = &request.model {
        env.insert("ANTHROPIC_MODEL".to_string(), json!(model));
    }

    // Add Claude-specific model fields (v3.7.1+)
    if let Some(haiku_model) = &request.haiku_model {
        env.insert(
            "ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(),
            json!(haiku_model),
        );
    }
    if let Some(sonnet_model) = &request.sonnet_model {
        env.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
            json!(sonnet_model),
        );
    }
    if let Some(opus_model) = &request.opus_model {
        env.insert(
            "ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(),
            json!(opus_model),
        );
    }

    json!({ "env": env })
}

/// Decode and extract the `env` object from the deeplink's inline config payload.
///
/// Returns `None` when no config is attached, when the payload can't be
/// decoded/parsed, or when it doesn't contain a Claude-style `env` object.
/// This is a best-effort accessor — we deliberately don't surface parse
/// errors here because `parse_and_merge_config` will have already validated
/// the payload during the merge phase; any failure at this point just means
/// "fall back to URL-param-only behavior".
fn extract_claude_config_env(
    request: &DeepLinkImportRequest,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    // Only the inline base64 config carries an env block. Remote config_url
    // is not implemented yet (see parse_and_merge_config), so nothing else to
    // try here.
    let config_b64 = request.config.as_ref()?;

    // Honor the declared format; default to JSON like parse_and_merge_config does.
    let format = request.config_format.as_deref().unwrap_or("json");
    if format != "json" {
        // Claude config is always JSON in practice. TOML/other formats aren't
        // expected on this app path, so don't try to handle them — safer to
        // fall back than to risk silently producing the wrong shape.
        return None;
    }

    // Decode the base64 payload. We re-decode here rather than threading the
    // already-decoded value through every build_* function, because the call
    // graph (parse_and_merge_config is pub and called separately for preview)
    // makes signature changes invasive. Decode cost is negligible on this
    // one-shot import path.
    let decoded = decode_base64_param("config", config_b64).ok()?;
    let json_str = std::str::from_utf8(&decoded).ok()?;
    let value: serde_json::Value = serde_json::from_str(json_str).ok()?;

    // Pull out the env object — same shape as Claude's own settings.json.
    value.get("env").and_then(|v| v.as_object()).cloned()
}

/// Build Codex settings configuration
fn build_codex_settings(request: &DeepLinkImportRequest) -> serde_json::Value {
    let provider_display_name = request
        .name
        .as_deref()
        .unwrap_or("custom")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();
    let provider_display_name = if provider_display_name.is_empty() {
        "custom".to_string()
    } else {
        provider_display_name
    };

    // Model name: use deeplink model or default
    let model_name_raw = request
        .model
        .as_deref()
        .unwrap_or("gpt-5-codex")
        .to_string();

    // Endpoint: normalize trailing slashes (use primary endpoint only)
    let endpoint = get_primary_endpoint(request)
        .trim()
        .trim_end_matches('/')
        .to_string();

    let provider_display_name = toml_edit::Value::from(provider_display_name.as_str()).to_string();
    let model_name = toml_edit::Value::from(model_name_raw.as_str()).to_string();
    let endpoint = toml_edit::Value::from(endpoint.as_str()).to_string();

    // Build config.toml content
    let config_toml = format!(
        r#"model_provider = "custom"
model = {model_name}
model_reasoning_effort = "high"

[model_providers.custom]
name = {provider_display_name}
base_url = {endpoint}
wire_api = "responses"
requires_openai_auth = false
"#
    );

    json!({
        "auth": {
            "OPENAI_API_KEY": request.api_key,
        },
        "config": config_toml,
        "modelCatalog": {
            "models": [{ "model": model_name_raw }]
        }
    })
}

/// Build Gemini settings configuration
fn build_gemini_settings(request: &DeepLinkImportRequest) -> serde_json::Value {
    let mut env = serde_json::Map::new();
    env.insert("GEMINI_API_KEY".to_string(), json!(request.api_key));
    env.insert(
        "GOOGLE_GEMINI_BASE_URL".to_string(),
        json!(get_primary_endpoint(request)),
    );

    // Add model if provided
    if let Some(model) = &request.model {
        env.insert("GEMINI_MODEL".to_string(), json!(model));
    }

    json!({ "env": env })
}

fn build_grokbuild_settings(request: &DeepLinkImportRequest) -> serde_json::Value {
    let model = request
        .model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(crate::grok_config::DEFAULT_MODEL)
        .trim();
    let name = request
        .name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("custom")
        .trim();
    let endpoint = get_primary_endpoint(request).trim().to_string();
    let api_key = request.api_key.as_deref().unwrap_or("").trim();

    let model_value = toml_edit::Value::from(model).to_string();
    let name_value = toml_edit::Value::from(name).to_string();
    let endpoint_value = toml_edit::Value::from(endpoint.as_str()).to_string();
    let api_key_value = toml_edit::Value::from(api_key).to_string();

    json!({
        "config": format!(
            "[models]\ndefault = {model_value}\n\n[model.{model_value}]\nmodel = {model_value}\nbase_url = {endpoint_value}\nname = {name_value}\napi_key = {api_key_value}\napi_backend = \"{}\"\ncontext_window = {}\n",
            crate::grok_config::DEFAULT_API_BACKEND,
            crate::grok_config::DEFAULT_CONTEXT_WINDOW,
        )
    })
}

/// Build OpenCode settings configuration
fn build_opencode_settings(request: &DeepLinkImportRequest) -> serde_json::Value {
    let endpoint = get_primary_endpoint(request);

    // Build options object
    let mut options = serde_json::Map::new();
    if !endpoint.is_empty() {
        options.insert("baseURL".to_string(), json!(endpoint));
    }
    if let Some(api_key) = &request.api_key {
        options.insert("apiKey".to_string(), json!(api_key));
    }

    // Build models object
    let mut models = serde_json::Map::new();
    if let Some(model) = &request.model {
        models.insert(model.clone(), json!({ "name": model }));
    }

    // Default to openai-compatible npm package
    json!({
        "npm": "@ai-sdk/openai-compatible",
        "options": options,
        "models": models
    })
}

/// Build settings for OpenClaw (camelCase live config).
/// Format: { baseUrl, apiKey, api, models }
fn build_additive_app_settings(request: &DeepLinkImportRequest) -> serde_json::Value {
    let endpoint = get_primary_endpoint(request);

    let mut config = serde_json::Map::new();

    if !endpoint.is_empty() {
        config.insert("baseUrl".to_string(), json!(endpoint));
    }

    if let Some(api_key) = &request.api_key {
        config.insert("apiKey".to_string(), json!(api_key));
    }

    config.insert("api".to_string(), json!("openai-completions"));

    if let Some(model) = &request.model {
        config.insert(
            "models".to_string(),
            json!([{ "id": model, "name": model }]),
        );
    }

    json!(config)
}

/// Build Hermes provider settings (snake_case YAML-native fields).
///
/// Hermes' `custom_providers:` entries use `base_url` / `api_key` / `api_mode`
/// (see `_VALID_CUSTOM_PROVIDER_FIELDS` in upstream `hermes_cli/config.py`).
/// Emitting camelCase here — as the OpenClaw path does — would poison the
/// YAML with unknown root fields the Hermes runtime ignores.
///
/// `api_mode` is always written explicitly. Deeplinks have no field to carry
/// it, so we default to `chat_completions` (the most widely compatible
/// protocol) and let the user adjust via the UI after import. We never rely
/// on Hermes' built-in URL heuristics, which only recognize a handful of
/// official endpoints.
fn build_hermes_settings(request: &DeepLinkImportRequest) -> serde_json::Value {
    let endpoint = get_primary_endpoint(request);

    let mut config = serde_json::Map::new();

    if let Some(name) = request.name.as_deref().filter(|s| !s.is_empty()) {
        config.insert("name".to_string(), json!(name));
    }

    if !endpoint.is_empty() {
        config.insert("base_url".to_string(), json!(endpoint));
    }

    if let Some(api_key) = &request.api_key {
        config.insert("api_key".to_string(), json!(api_key));
    }

    config.insert("api_mode".to_string(), json!("chat_completions"));

    if let Some(model) = &request.model {
        config.insert(
            "models".to_string(),
            json!([{ "id": model, "name": model }]),
        );
    }

    json!(config)
}

// =============================================================================
// Config Merge Logic
// =============================================================================

/// Parse and merge configuration from Base64 encoded config or remote URL
///
/// Priority: URL params > inline config > remote config
pub fn parse_and_merge_config(
    request: &DeepLinkImportRequest,
) -> Result<DeepLinkImportRequest, AppError> {
    validate_request_limits(request)?;
    // If no config provided, return original request
    if request.config.is_none() && request.config_url.is_none() {
        return Ok(request.clone());
    }

    // Step 1: Get config content
    let config_content = if let Some(config_b64) = &request.config {
        // Decode Base64 inline config
        let decoded = decode_base64_param("config", config_b64)?;
        String::from_utf8(decoded)
            .map_err(|e| AppError::InvalidInput(format!("Invalid UTF-8 in config: {e}")))?
    } else if let Some(_config_url) = &request.config_url {
        // Fetch remote config (TODO: implement remote fetching in next phase)
        return Err(AppError::InvalidInput(
            "Remote config URL is not yet supported. Use inline config instead.".to_string(),
        ));
    } else {
        return Ok(request.clone());
    };

    // Step 2: Parse config based on format
    let format = request.config_format.as_deref().unwrap_or("json");
    let config_value: serde_json::Value = match format {
        "json" => serde_json::from_str(&config_content)
            .map_err(|e| AppError::InvalidInput(format!("Invalid JSON config: {e}")))?,
        "toml" => {
            let toml_value: toml::Value = toml::from_str(&config_content)
                .map_err(|e| AppError::InvalidInput(format!("Invalid TOML config: {e}")))?;
            // Convert TOML to JSON for uniform processing
            serde_json::to_value(toml_value)
                .map_err(|e| AppError::Message(format!("Failed to convert TOML to JSON: {e}")))?
        }
        _ => {
            return Err(AppError::InvalidInput(format!(
                "Unsupported config format: {format}"
            )))
        }
    };

    // Step 3: Extract values from config based on app type and merge with URL params
    let mut merged = request.clone();

    // MCP, Skill and other resource types don't need config merging
    if request.resource != "provider" {
        return Ok(merged);
    }

    match request.app.as_deref().unwrap_or("") {
        "claude" => merge_claude_config(&mut merged, &config_value)?,
        "codex" => merge_codex_config(&mut merged, &config_value)?,
        "gemini" => merge_gemini_config(&mut merged, &config_value)?,
        "grokbuild" => merge_grokbuild_config(&mut merged, &config_value)?,
        // Additive mode apps use JSON config directly; pass through as-is
        "openclaw" | "opencode" | "hermes" => {
            merge_additive_config(&mut merged, &config_value)?;
        }
        "" => {
            // No app specified, skip merging
            return Ok(merged);
        }
        _ => {
            return Err(AppError::InvalidInput(format!(
                "Invalid app type: {:?}",
                request.app
            )))
        }
    }

    Ok(merged)
}

fn validate_request_limits(request: &DeepLinkImportRequest) -> Result<(), AppError> {
    let max_string = crate::security_limits::MAX_IMPORT_BYTES as usize;
    for (field, value) in [
        ("name", request.name.as_deref()),
        ("endpoint", request.endpoint.as_deref()),
        ("api_key", request.api_key.as_deref()),
        ("notes", request.notes.as_deref()),
        ("config", request.config.as_deref()),
        ("config_url", request.config_url.as_deref()),
        ("usage_script", request.usage_script.as_deref()),
        ("usage_access_token", request.usage_access_token.as_deref()),
    ] {
        if value.is_some_and(|value| value.len() > max_string.saturating_mul(2)) {
            return Err(AppError::InvalidInput(format!(
                "Deep link field '{field}' is too large"
            )));
        }
    }
    Ok(())
}

/// Merge Claude configuration from config file
fn merge_claude_config(
    request: &mut DeepLinkImportRequest,
    config: &serde_json::Value,
) -> Result<(), AppError> {
    let env = config
        .get("env")
        .and_then(|v| v.as_object())
        .ok_or_else(|| {
            AppError::InvalidInput("Claude config must have 'env' object".to_string())
        })?;

    // Auto-fill API key if not provided in URL
    if request.api_key.as_ref().is_none_or(|s| s.is_empty()) {
        if let Some(token) = env.get("ANTHROPIC_AUTH_TOKEN").and_then(|v| v.as_str()) {
            request.api_key = Some(token.to_string());
        }
    }

    // Auto-fill endpoint if not provided in URL
    if request.endpoint.as_ref().is_none_or(|s| s.is_empty()) {
        if let Some(base_url) = env.get("ANTHROPIC_BASE_URL").and_then(|v| v.as_str()) {
            request.endpoint = Some(base_url.to_string());
        }
    }

    // Auto-fill homepage from endpoint if not provided
    if request.homepage.as_ref().is_none_or(|s| s.is_empty()) {
        if let Some(endpoint) = request.endpoint.as_ref().filter(|s| !s.is_empty()) {
            request.homepage = infer_homepage_from_endpoint(endpoint);
            if request.homepage.is_none() {
                request.homepage = Some("https://anthropic.com".to_string());
            }
        }
    }

    // Auto-fill model fields (URL params take priority)
    if request.model.is_none() {
        request.model = env
            .get("ANTHROPIC_MODEL")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }
    if request.haiku_model.is_none() {
        request.haiku_model = env
            .get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }
    if request.sonnet_model.is_none() {
        request.sonnet_model = env
            .get("ANTHROPIC_DEFAULT_SONNET_MODEL")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }
    if request.opus_model.is_none() {
        request.opus_model = env
            .get("ANTHROPIC_DEFAULT_OPUS_MODEL")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }

    Ok(())
}

/// Merge Codex configuration from config file
fn merge_codex_config(
    request: &mut DeepLinkImportRequest,
    config: &serde_json::Value,
) -> Result<(), AppError> {
    // Auto-fill API key from auth.OPENAI_API_KEY or Codex mobile-compatible bearer token.
    if request.api_key.as_ref().is_none_or(|s| s.is_empty()) {
        let config_str = config.get("config").and_then(|v| v.as_str());
        if let Some(api_key) =
            crate::codex_config::extract_codex_api_key(config.get("auth"), config_str)
        {
            request.api_key = Some(api_key.to_string());
        }
    }

    // Auto-fill endpoint and model from config string
    if let Some(config_str) = config.get("config").and_then(|v| v.as_str()) {
        // Parse TOML config string to extract base_url and model
        if let Ok(toml_value) = toml::from_str::<toml::Value>(config_str) {
            // Extract base_url from model_providers section
            if request.endpoint.as_ref().is_none_or(|s| s.is_empty()) {
                if let Some(base_url) = extract_codex_base_url(&toml_value) {
                    request.endpoint = Some(base_url);
                }
            }

            // Extract model
            if request.model.is_none() {
                if let Some(model) = toml_value.get("model").and_then(|v| v.as_str()) {
                    request.model = Some(model.to_string());
                }
            }
        }
    }

    // Auto-fill homepage from endpoint
    if request.homepage.as_ref().is_none_or(|s| s.is_empty()) {
        if let Some(endpoint) = request.endpoint.as_ref().filter(|s| !s.is_empty()) {
            request.homepage = infer_homepage_from_endpoint(endpoint);
            if request.homepage.is_none() {
                request.homepage = Some("https://openai.com".to_string());
            }
        }
    }

    Ok(())
}

/// Merge Gemini configuration from config file
fn merge_gemini_config(
    request: &mut DeepLinkImportRequest,
    config: &serde_json::Value,
) -> Result<(), AppError> {
    // Gemini uses flat env structure
    if request.api_key.as_ref().is_none_or(|s| s.is_empty()) {
        if let Some(api_key) = config.get("GEMINI_API_KEY").and_then(|v| v.as_str()) {
            request.api_key = Some(api_key.to_string());
        }
    }

    if request.endpoint.as_ref().is_none_or(|s| s.is_empty()) {
        if let Some(base_url) = config
            .get("GOOGLE_GEMINI_BASE_URL")
            .or_else(|| config.get("GEMINI_BASE_URL"))
            .and_then(|v| v.as_str())
        {
            request.endpoint = Some(base_url.to_string());
        }
    }

    if request.model.is_none() {
        request.model = config
            .get("GEMINI_MODEL")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }

    // Auto-fill homepage from endpoint
    if request.homepage.as_ref().is_none_or(|s| s.is_empty()) {
        if let Some(endpoint) = request.endpoint.as_ref().filter(|s| !s.is_empty()) {
            request.homepage = infer_homepage_from_endpoint(endpoint);
            if request.homepage.is_none() {
                request.homepage = Some("https://ai.google.dev".to_string());
            }
        }
    }

    Ok(())
}

fn merge_grokbuild_config(
    request: &mut DeepLinkImportRequest,
    config: &serde_json::Value,
) -> Result<(), AppError> {
    let config_toml = if let Some(config_toml) = config.get("config").and_then(|v| v.as_str()) {
        config_toml.to_string()
    } else {
        let toml_value: toml::Value = serde_json::from_value(config.clone()).map_err(|error| {
            AppError::InvalidInput(format!("Invalid Grok Build config: {error}"))
        })?;
        toml::to_string(&toml_value).map_err(|error| {
            AppError::InvalidInput(format!("Invalid Grok Build config: {error}"))
        })?
    };
    let model = crate::grok_config::extract_model_config(&config_toml).ok_or_else(|| {
        AppError::InvalidInput("Invalid Grok Build config.toml model profile".to_string())
    })?;

    if request
        .api_key
        .as_ref()
        .is_none_or(|value| value.is_empty())
    {
        request.api_key = model.api_key.or_else(|| {
            crate::grok_config::extract_credentials(&config_toml).map(|(_, api_key)| api_key)
        });
    }
    if request
        .endpoint
        .as_ref()
        .is_none_or(|value| value.is_empty())
    {
        request.endpoint = Some(model.base_url);
    }
    if request.model.is_none() {
        request.model = Some(model.model);
    }
    if request
        .homepage
        .as_ref()
        .is_none_or(|value| value.is_empty())
    {
        if let Some(endpoint) = request.endpoint.as_deref() {
            request.homepage = infer_homepage_from_endpoint(endpoint);
        }
    }

    Ok(())
}

/// Merge configuration for additive mode apps (OpenClaw, OpenCode)
///
/// These apps use JSON config directly, so we only extract common fields
/// (api_key, endpoint, model) from the config if not already set in URL params.
fn merge_additive_config(
    request: &mut DeepLinkImportRequest,
    config: &serde_json::Value,
) -> Result<(), AppError> {
    // Extract api_key from config if not provided in URL
    if request.api_key.as_ref().is_none_or(|s| s.is_empty()) {
        if let Some(api_key) = config
            .get("apiKey")
            .or_else(|| config.get("api_key"))
            .and_then(|v| v.as_str())
        {
            request.api_key = Some(api_key.to_string());
        }
    }

    // Extract endpoint from config if not provided in URL
    if request.endpoint.as_ref().is_none_or(|s| s.is_empty()) {
        if let Some(base_url) = config
            .get("baseUrl")
            .or_else(|| config.get("base_url"))
            .or_else(|| config.get("options").and_then(|o| o.get("baseURL")))
            .and_then(|v| v.as_str())
        {
            request.endpoint = Some(base_url.to_string());
        }
    }

    // Auto-fill homepage from endpoint
    if request.homepage.as_ref().is_none_or(|s| s.is_empty()) {
        if let Some(endpoint) = request.endpoint.as_ref().filter(|s| !s.is_empty()) {
            request.homepage = infer_homepage_from_endpoint(endpoint);
        }
    }

    Ok(())
}

/// Extract base_url from Codex TOML config
fn extract_codex_base_url(toml_value: &toml::Value) -> Option<String> {
    // Try to find base_url in model_providers section
    if let Some(providers) = toml_value.get("model_providers").and_then(|v| v.as_table()) {
        for (_key, provider) in providers.iter() {
            if let Some(base_url) = provider.get("base_url").and_then(|v| v.as_str()) {
                return Some(base_url.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::StatusCode, response::IntoResponse, routing::post, Json, Router};
    use serial_test::serial;
    use std::env;
    use std::sync::Arc;
    use tempfile::TempDir;

    struct TempHome {
        _dir: TempDir,
        original_home: Option<String>,
        original_userprofile: Option<String>,
        original_test_home: Option<String>,
        #[cfg(windows)]
        original_local_app_data: Option<String>,
    }

    impl TempHome {
        fn new() -> Self {
            let dir = TempDir::new().expect("create temp home");
            let original_home = env::var("HOME").ok();
            let original_userprofile = env::var("USERPROFILE").ok();
            let original_test_home = env::var("CC_SWITCH_TEST_HOME").ok();
            #[cfg(windows)]
            let original_local_app_data = env::var("LOCALAPPDATA").ok();

            env::set_var("HOME", dir.path());
            env::set_var("USERPROFILE", dir.path());
            env::set_var("CC_SWITCH_TEST_HOME", dir.path());
            #[cfg(windows)]
            env::set_var("LOCALAPPDATA", dir.path().join("AppData").join("Local"));

            Self {
                _dir: dir,
                original_home,
                original_userprofile,
                original_test_home,
                #[cfg(windows)]
                original_local_app_data,
            }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            for (key, value) in [
                ("HOME", &self.original_home),
                ("USERPROFILE", &self.original_userprofile),
                ("CC_SWITCH_TEST_HOME", &self.original_test_home),
            ] {
                match value {
                    Some(value) => env::set_var(key, value),
                    None => env::remove_var(key),
                }
            }
            #[cfg(windows)]
            match &self.original_local_app_data {
                Some(value) => env::set_var("LOCALAPPDATA", value),
                None => env::remove_var("LOCALAPPDATA"),
            }
        }
    }

    fn hermes_request() -> DeepLinkImportRequest {
        DeepLinkImportRequest {
            resource: "provider".to_string(),
            app: Some("hermes".to_string()),
            name: Some("MyHermes".to_string()),
            endpoint: Some("https://api.example.com/v1".to_string()),
            api_key: Some("sk-test".to_string()),
            model: Some("anthropic/claude-opus-4-8".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn build_hermes_settings_emits_snake_case() {
        let settings = build_hermes_settings(&hermes_request());
        let obj = settings.as_object().expect("settings must be object");

        assert_eq!(obj.get("name").unwrap(), "MyHermes");
        assert_eq!(obj.get("base_url").unwrap(), "https://api.example.com/v1");
        assert_eq!(obj.get("api_key").unwrap(), "sk-test");

        // camelCase and legacy fields must NOT be present
        assert!(obj.get("baseUrl").is_none(), "no camelCase baseUrl");
        assert!(obj.get("apiKey").is_none(), "no camelCase apiKey");
        assert!(obj.get("api").is_none(), "no legacy 'api' field");

        // models array with the deeplink model id
        let models = obj.get("models").unwrap().as_array().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["id"], "anthropic/claude-opus-4-8");
    }

    #[test]
    fn build_hermes_settings_writes_default_api_mode() {
        let settings = build_hermes_settings(&hermes_request());
        assert_eq!(
            settings.as_object().unwrap().get("api_mode").unwrap(),
            "chat_completions",
            "api_mode must be written explicitly so Hermes never falls back to URL auto-detection"
        );
    }

    #[test]
    fn build_hermes_settings_skips_missing_optional_fields() {
        let request = DeepLinkImportRequest {
            resource: "provider".to_string(),
            app: Some("hermes".to_string()),
            name: Some("Minimal".to_string()),
            endpoint: None,
            api_key: None,
            model: None,
            ..Default::default()
        };
        let settings = build_hermes_settings(&request);
        let obj = settings.as_object().unwrap();

        assert_eq!(obj.get("name").unwrap(), "Minimal");
        assert!(obj.get("base_url").is_none());
        assert!(obj.get("api_key").is_none());
        assert!(obj.get("models").is_none());
        assert_eq!(obj.get("api_mode").unwrap(), "chat_completions");
    }

    #[test]
    fn build_codex_settings_uses_custom_key_and_preserves_display_name() {
        let request = DeepLinkImportRequest {
            resource: "provider".to_string(),
            app: Some("codex".to_string()),
            name: Some("My \"Relay\"".to_string()),
            endpoint: Some("https://api.example.com/v1/".to_string()),
            api_key: Some("sk-test".to_string()),
            model: Some("gpt-5-codex".to_string()),
            ..Default::default()
        };

        let settings = build_codex_settings(&request);
        let config_text = settings
            .get("config")
            .and_then(|value| value.as_str())
            .expect("config text");
        let parsed: toml::Value = toml::from_str(config_text).expect("valid Codex config");

        assert_eq!(
            parsed
                .get("model_provider")
                .and_then(|value| value.as_str()),
            Some("custom")
        );
        let custom_provider = parsed
            .get("model_providers")
            .and_then(|value| value.get("custom"))
            .expect("custom model provider");
        assert_eq!(
            custom_provider.get("name").and_then(|value| value.as_str()),
            Some("My \"Relay\"")
        );
        assert_eq!(
            custom_provider
                .get("base_url")
                .and_then(|value| value.as_str()),
            Some("https://api.example.com/v1")
        );
        assert_eq!(
            custom_provider
                .get("requires_openai_auth")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
    }

    #[tokio::test]
    #[serial]
    async fn first_unlogged_enabled_codex_chat_import_establishes_direct_baseline() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(crate::database::Database::memory().expect("create memory db"));
        let proxy_listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("reserve proxy port");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        drop(proxy_listener);
        db.update_proxy_config(crate::proxy::types::ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("set proxy port");
        let state = crate::store::AppState::new(db.clone());

        async fn unsupported() -> impl IntoResponse {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not found"})),
            )
        }
        async fn chat_validation() -> impl IntoResponse {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": {"message": "max_tokens must be an integer for chat/completions"}
                })),
            )
        }
        let probe_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind probe server");
        let probe_addr = probe_listener.local_addr().expect("probe addr");
        let probe_server = tokio::spawn(async move {
            axum::serve(
                probe_listener,
                Router::new()
                    .route("/v1/responses", post(unsupported))
                    .route("/v1/chat/completions", post(chat_validation))
                    .route("/v1/messages", post(unsupported)),
            )
            .await
            .expect("serve probe routes");
        });

        let endpoint = format!("http://{probe_addr}/v1");
        let request = DeepLinkImportRequest {
            resource: "provider".to_string(),
            app: Some("codex".to_string()),
            name: Some("Fresh Chat Import".to_string()),
            enabled: Some(true),
            endpoint: Some(endpoint.clone()),
            api_key: Some("test-only-key".to_string()),
            model: Some("claude-test".to_string()),
            ..Default::default()
        };

        let provider_id = import_provider_from_deeplink(&state, request)
            .await
            .expect("first enabled Codex import");
        assert_eq!(
            db.get_current_provider("codex")
                .expect("db current")
                .as_deref(),
            Some(provider_id.as_str())
        );
        assert!(
            db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        assert!(state.proxy_service.is_running().await);
        let takeover =
            std::fs::read_to_string(crate::get_codex_config_path()).expect("read takeover config");
        assert!(takeover.contains("127.0.0.1"));

        state
            .proxy_service
            .set_takeover_for_app("codex", false)
            .await
            .expect("disable takeover");
        let direct =
            std::fs::read_to_string(crate::get_codex_config_path()).expect("read direct config");
        assert!(direct.contains(&endpoint));
        assert!(!direct.contains(&format!("127.0.0.1:{proxy_port}")));
        probe_server.abort();
    }

    #[tokio::test]
    #[serial]
    async fn disabled_codex_deeplink_stays_inactive_and_persists_detected_protocol() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(crate::database::Database::memory().expect("create memory db"));
        let state = crate::store::AppState::new(db.clone());

        async fn unsupported() -> impl IntoResponse {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not found"})),
            )
        }
        async fn chat_validation() -> impl IntoResponse {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": {"message": "max_tokens must be an integer for chat/completions"}
                })),
            )
        }
        let probe_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind probe server");
        let probe_addr = probe_listener.local_addr().expect("probe addr");
        let probe_server = tokio::spawn(async move {
            axum::serve(
                probe_listener,
                Router::new()
                    .route("/v1/responses", post(unsupported))
                    .route("/v1/chat/completions", post(chat_validation))
                    .route("/v1/messages", post(unsupported)),
            )
            .await
            .expect("serve probe routes");
        });

        let endpoint = format!("http://{probe_addr}/v1");
        let request = DeepLinkImportRequest {
            resource: "provider".to_string(),
            app: Some("codex".to_string()),
            name: Some("Disabled Chat Import".to_string()),
            enabled: Some(false),
            endpoint: Some(endpoint),
            api_key: Some("test-only-key".to_string()),
            model: Some("claude-disabled".to_string()),
            ..Default::default()
        };
        let provider_id = import_provider_from_deeplink(&state, request)
            .await
            .expect("disabled import must be staged");

        let stored = db
            .get_provider_by_id(&provider_id, "codex")
            .expect("read imported provider")
            .expect("provider exists");
        assert_eq!(
            stored
                .meta
                .as_ref()
                .and_then(|meta| meta.api_format.as_deref()),
            Some("openai_chat")
        );
        assert_eq!(db.get_current_provider("codex").expect("db current"), None);
        assert_eq!(crate::settings::get_current_provider(&AppType::Codex), None);
        assert!(!crate::get_codex_auth_path().exists());
        assert!(!crate::get_codex_config_path().exists());
        assert!(!crate::codex_config::get_codex_model_catalog_path().exists());
        assert!(
            !db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        assert!(!state.proxy_service.is_running().await);
        assert!(db.get_live_backup("codex").await.expect("backup").is_none());
        probe_server.abort();
    }

    #[tokio::test]
    #[serial]
    async fn enabled_codex_import_activates_even_when_a_current_provider_exists() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(crate::database::Database::memory().expect("create memory db"));
        let proxy_listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("reserve proxy port");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        drop(proxy_listener);
        db.update_proxy_config(crate::proxy::types::ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("set proxy port");
        let state = crate::store::AppState::new(db.clone());

        let mut existing = Provider::with_id(
            "existing".to_string(),
            "Existing".to_string(),
            serde_json::json!({
                "auth": {"OPENAI_API_KEY": "existing-test-key"},
                "config": "model_provider = \"existing\"\nmodel = \"gpt-existing\"\n[model_providers.existing]\nname = \"Existing\"\nbase_url = \"https://existing.example.invalid/v1\"\nwire_api = \"responses\"\n",
                "modelCatalog": {"models": [{"model": "gpt-existing", "displayName": "Existing"}]}
            }),
            None,
        );
        existing.meta = Some(ProviderMeta {
            api_format: Some("openai_responses".to_string()),
            ..ProviderMeta::default()
        });
        crate::add_provider_with_automatic_routing_state(
            state.clone(),
            AppType::Codex,
            existing,
            true,
        )
        .await
        .expect("activate existing provider");

        async fn unsupported() -> impl IntoResponse {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not found"})),
            )
        }
        async fn chat_validation() -> impl IntoResponse {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": {"message": "max_tokens must be an integer for chat/completions"}
                })),
            )
        }
        let probe_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind probe server");
        let probe_addr = probe_listener.local_addr().expect("probe addr");
        let probe_server = tokio::spawn(async move {
            axum::serve(
                probe_listener,
                Router::new()
                    .route("/v1/responses", post(unsupported))
                    .route("/v1/chat/completions", post(chat_validation))
                    .route("/v1/messages", post(unsupported)),
            )
            .await
            .expect("serve probe routes");
        });

        let endpoint = format!("http://{probe_addr}/v1");
        let request = DeepLinkImportRequest {
            resource: "provider".to_string(),
            app: Some("codex".to_string()),
            name: Some("Enabled Chat Import".to_string()),
            enabled: Some(true),
            endpoint: Some(endpoint.clone()),
            api_key: Some("import-test-key".to_string()),
            model: Some("claude-imported".to_string()),
            ..Default::default()
        };
        let imported_id = import_provider_from_deeplink(&state, request)
            .await
            .expect("enabled import must activate");

        assert_eq!(
            db.get_current_provider("codex")
                .expect("db current")
                .as_deref(),
            Some(imported_id.as_str())
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Codex).as_deref(),
            Some(imported_id.as_str())
        );
        assert!(
            db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        let live = std::fs::read_to_string(crate::get_codex_config_path())
            .expect("read imported takeover");
        assert!(live.contains(&format!("127.0.0.1:{proxy_port}")));

        state
            .proxy_service
            .set_takeover_for_app("codex", false)
            .await
            .expect("disable takeover");
        let restored = std::fs::read_to_string(crate::get_codex_config_path())
            .expect("read imported direct config");
        assert!(restored.contains(&endpoint));
        assert!(!restored.contains("https://existing.example.invalid/v1"));
        assert!(!restored.contains(&format!("127.0.0.1:{proxy_port}")));
        probe_server.abort();
    }

    #[tokio::test]
    #[serial]
    async fn enabled_non_codex_import_waits_for_profile_and_rolls_back_to_latest_live() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(crate::database::Database::memory().expect("create memory db"));
        let state = crate::store::AppState::new(db.clone());

        let provider_a = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "test-a",
                    "ANTHROPIC_BASE_URL": "https://a.example.invalid"
                }
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "claude-b".to_string(),
            "Claude B".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "test-b",
                    "ANTHROPIC_BASE_URL": "https://b.example.invalid"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider_a)
            .expect("save provider A");
        db.save_provider("claude", &provider_b)
            .expect("save provider B");
        ProviderService::switch(&state, AppType::Claude, "claude-a").expect("activate provider A");

        // Model the complete Profile Apply transaction. The enabled Deep Link
        // may parse/build its provider concurrently, but it must not snapshot or
        // stage anything until the Profile transaction has committed provider B.
        let profile_lock = state.profile_apply_lock.clone();
        let profile_guard = profile_lock.lock().await;
        let import_state = state.clone();
        let import_task = tokio::spawn(async move {
            import_provider_from_deeplink(
                &import_state,
                DeepLinkImportRequest {
                    resource: "provider".to_string(),
                    app: Some("claude".to_string()),
                    name: Some("Transactional Import".to_string()),
                    enabled: Some(true),
                    homepage: Some("https://example.com".to_string()),
                    endpoint: Some("https://c.example.invalid".to_string()),
                    api_key: Some("test-c".to_string()),
                    model: Some("claude-test".to_string()),
                    ..Default::default()
                },
            )
            .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(
            db.get_all_providers("claude")
                .expect("read providers while profile lock held")
                .len(),
            2,
            "enabled import must not stage outside profile_apply_lock"
        );

        crate::switch_provider_with_automatic_routing_profile_lock_held_state(
            state.clone(),
            AppType::Claude,
            "claude-b".to_string(),
        )
        .await
        .expect("commit Profile provider B");

        {
            let conn = db.conn.lock().expect("lock database");
            conn.execute_batch(
                "CREATE TRIGGER reject_imported_claude_current_update
                 BEFORE UPDATE OF is_current ON providers
                 WHEN NEW.app_type = 'claude'
                   AND NEW.id LIKE 'transactionalimport-%'
                   AND NEW.is_current = 1
                 BEGIN
                   SELECT RAISE(ABORT, 'forced concurrent enabled-import failure');
                 END;",
            )
            .expect("install imported-provider failure trigger");
        }
        drop(profile_guard);

        let error = import_task
            .await
            .expect("join enabled import")
            .expect_err("forced provider switch failure must abort import");
        assert!(error
            .to_string()
            .contains("forced concurrent enabled-import failure"));

        let providers = db
            .get_all_providers("claude")
            .expect("read providers after rollback");
        assert_eq!(providers.len(), 2);
        assert!(!providers
            .keys()
            .any(|id| id.starts_with("transactionalimport-")));
        assert_eq!(
            db.get_current_provider("claude")
                .expect("read db current after rollback")
                .as_deref(),
            Some("claude-b")
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Claude).as_deref(),
            Some("claude-b")
        );
        let live = std::fs::read_to_string(crate::config::get_claude_settings_path())
            .expect("read Claude Live after rollback");
        assert!(live.contains("https://b.example.invalid"));
        assert!(!live.contains("https://a.example.invalid"));
        assert!(!live.contains("https://c.example.invalid"));
    }

    #[tokio::test]
    #[serial]
    async fn enabled_claude_desktop_import_failure_restores_all_live_files() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        if crate::claude_desktop_config::capture_live_snapshot()
            .expect("probe Claude Desktop snapshot support")
            .is_none()
        {
            return;
        }

        let db = Arc::new(crate::database::Database::memory().expect("create memory db"));
        let state = crate::store::AppState::new(db.clone());
        let current_id = import_provider_from_deeplink(
            &state,
            DeepLinkImportRequest {
                resource: "provider".to_string(),
                app: Some("claude-desktop".to_string()),
                name: Some("Desktop A".to_string()),
                enabled: Some(true),
                endpoint: Some("https://desktop-a.example.invalid/v1".to_string()),
                api_key: Some("desktop-a-test-key".to_string()),
                model: Some("claude-a".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("activate initial Claude Desktop provider");

        let before = crate::claude_desktop_config::capture_live_snapshot()
            .expect("capture initial Claude Desktop Live")
            .expect("supported platform snapshot");
        assert!(before.has_live_data());

        {
            let conn = db.conn.lock().expect("lock database");
            conn.execute_batch(
                "CREATE TRIGGER reject_imported_claude_desktop_current_update
                 BEFORE UPDATE OF is_current ON providers
                 WHEN NEW.app_type = 'claude-desktop'
                   AND NEW.id LIKE 'desktopc-%'
                   AND NEW.is_current = 1
                 BEGIN
                   SELECT RAISE(ABORT, 'forced Claude Desktop enabled-import failure');
                 END;",
            )
            .expect("install Claude Desktop failure trigger");
        }

        let error = import_provider_from_deeplink(
            &state,
            DeepLinkImportRequest {
                resource: "provider".to_string(),
                app: Some("claude-desktop".to_string()),
                name: Some("Desktop C".to_string()),
                enabled: Some(true),
                endpoint: Some("https://desktop-c.example.invalid/v1".to_string()),
                api_key: Some("desktop-c-test-key".to_string()),
                model: Some("claude-c".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect_err("forced current commit failure must abort import");
        assert!(error
            .to_string()
            .contains("forced Claude Desktop enabled-import failure"));

        let providers = db
            .get_all_providers("claude-desktop")
            .expect("read Claude Desktop providers after rollback");
        assert_eq!(providers.len(), 1);
        assert!(providers.contains_key(&current_id));
        assert!(!providers.keys().any(|id| id.starts_with("desktopc-")));
        assert_eq!(
            db.get_current_provider("claude-desktop")
                .expect("read DB current after rollback")
                .as_deref(),
            Some(current_id.as_str())
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::ClaudeDesktop).as_deref(),
            Some(current_id.as_str())
        );

        let after = crate::claude_desktop_config::capture_live_snapshot()
            .expect("capture rolled-back Claude Desktop Live")
            .expect("supported platform snapshot");
        assert_eq!(
            after, before,
            "deployment configs, generated profile, and metadata must all roll back"
        );
    }

    #[tokio::test]
    #[serial]
    async fn enabled_import_removes_staged_provider_when_switch_fails() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(crate::database::Database::memory().expect("create memory db"));
        let state = crate::store::AppState::new(db.clone());

        {
            let conn = db.conn.lock().expect("lock database");
            conn.execute_batch(
                "CREATE TRIGGER reject_claude_current_update
                 BEFORE UPDATE OF is_current ON providers
                 WHEN NEW.app_type = 'claude'
                 BEGIN
                   SELECT RAISE(ABORT, 'forced enabled-import switch failure');
                 END;",
            )
            .expect("install failure trigger");
        }

        let request = DeepLinkImportRequest {
            resource: "provider".to_string(),
            app: Some("claude".to_string()),
            name: Some("Transactional Import".to_string()),
            enabled: Some(true),
            homepage: Some("https://example.com".to_string()),
            endpoint: Some("https://api.example.com/v1".to_string()),
            api_key: Some("test-key".to_string()),
            model: Some("claude-test".to_string()),
            ..Default::default()
        };

        let error = import_provider_from_deeplink(&state, request)
            .await
            .expect_err("forced provider switch failure must abort import");
        assert!(error
            .to_string()
            .contains("forced enabled-import switch failure"));
        assert!(
            db.get_all_providers("claude")
                .expect("read providers after rollback")
                .is_empty(),
            "failed enabled import must not leave the staged provider"
        );
        assert_eq!(
            db.get_current_provider("claude")
                .expect("read db current after rollback"),
            None
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Claude),
            None
        );
        assert!(
            !crate::config::get_claude_settings_path().exists(),
            "failed enabled import must restore the missing Live config"
        );
    }

    #[test]
    fn openclaw_still_uses_camel_case() {
        // OpenClaw's live config natively uses camelCase; guard against a
        // refactor accidentally flipping it to snake_case.
        let request = DeepLinkImportRequest {
            resource: "provider".to_string(),
            app: Some("openclaw".to_string()),
            name: Some("c".to_string()),
            endpoint: Some("https://api.example.com".to_string()),
            api_key: Some("k".to_string()),
            ..Default::default()
        };
        let settings = build_additive_app_settings(&request);
        let obj = settings.as_object().unwrap();
        assert!(obj.contains_key("baseUrl"));
        assert!(obj.contains_key("apiKey"));
    }
}
