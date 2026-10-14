//! Deep link module tests

use super::env_allowlist::EnvKeyStatus;
use super::mcp::parse_mcp_apps;
use super::parser::parse_deeplink_url;
use super::prompt::import_prompt_from_deeplink;
use super::provider::parse_and_merge_config;
use super::skill::import_skill_from_deeplink;
use super::utils::{infer_homepage_from_endpoint, validate_url};
use super::DeepLinkImportRequest;
use crate::AppType;
use crate::{store::AppState, Database};
use base64::prelude::*;
use std::{env, ffi::OsString, sync::Arc};

struct TestHomeGuard {
    _dir: tempfile::TempDir,
    original_home: Option<OsString>,
    original_userprofile: Option<OsString>,
    original_test_home: Option<OsString>,
}

impl TestHomeGuard {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("create isolated test home");
        let original_home = env::var_os("HOME");
        let original_userprofile = env::var_os("USERPROFILE");
        let original_test_home = env::var_os("CC_SWITCH_TEST_HOME");

        env::set_var("HOME", dir.path());
        env::set_var("USERPROFILE", dir.path());
        env::set_var("CC_SWITCH_TEST_HOME", dir.path());

        Self {
            _dir: dir,
            original_home,
            original_userprofile,
            original_test_home,
        }
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        match &self.original_test_home {
            Some(value) => env::set_var("CC_SWITCH_TEST_HOME", value),
            None => env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        match &self.original_userprofile {
            Some(value) => env::set_var("USERPROFILE", value),
            None => env::remove_var("USERPROFILE"),
        }
        match &self.original_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
    }
}

// =============================================================================
// Parser Tests
// =============================================================================

#[test]
fn test_parse_valid_claude_deeplink() {
    let url = "ccswitch://v1/import?resource=provider&app=claude&name=Test%20Provider&homepage=https%3A%2F%2Fexample.com&endpoint=https%3A%2F%2Fapi.example.com&apiKey=sk-test-123&icon=claude";

    let request = parse_deeplink_url(url).unwrap();

    assert_eq!(request.version, "v1");
    assert_eq!(request.resource, "provider");
    assert_eq!(request.app, Some("claude".to_string()));
    assert_eq!(request.name, Some("Test Provider".to_string()));
    assert_eq!(request.homepage, Some("https://example.com".to_string()));
    assert_eq!(
        request.endpoint,
        Some("https://api.example.com".to_string())
    );
    assert_eq!(request.api_key, Some("sk-test-123".to_string()));
    assert_eq!(request.icon, Some("claude".to_string()));
}

#[test]
fn test_parse_deeplink_with_notes() {
    let url = "ccswitch://v1/import?resource=provider&app=codex&name=Codex&homepage=https%3A%2F%2Fcodex.com&endpoint=https%3A%2F%2Fapi.codex.com&apiKey=key123&notes=Test%20notes";

    let request = parse_deeplink_url(url).unwrap();

    assert_eq!(request.notes, Some("Test notes".to_string()));
}

#[test]
fn test_parse_grokbuild_provider() {
    use super::provider::build_provider_from_request;

    let url = "ccswitch://v1/import?resource=provider&app=grokbuild&name=Grok%20Relay&endpoint=https%3A%2F%2Fapi.example.com%2Fv1&apiKey=secret&model=grok-4.5";

    let request = parse_deeplink_url(url).unwrap();

    assert_eq!(request.app.as_deref(), Some("grokbuild"));
    assert_eq!(request.name.as_deref(), Some("Grok Relay"));
    assert_eq!(
        request.endpoint.as_deref(),
        Some("https://api.example.com/v1")
    );
    assert_eq!(request.api_key.as_deref(), Some("secret"));
    assert_eq!(request.model.as_deref(), Some("grok-4.5"));

    let provider = build_provider_from_request(&AppType::GrokBuild, &request).unwrap();
    let config = provider.settings_config["config"].as_str().unwrap();
    let document = config.parse::<toml::Value>().unwrap();
    let model = &document["model"]["grok-4.5"];

    assert_eq!(document["models"]["default"].as_str(), Some("grok-4.5"));
    assert_eq!(
        model["base_url"].as_str(),
        Some("https://api.example.com/v1")
    );
    assert_eq!(model["name"].as_str(), Some("Grok Relay"));
    assert_eq!(model["api_key"].as_str(), Some("secret"));
    assert_eq!(model["api_backend"].as_str(), Some("responses"));
    assert_eq!(model["context_window"].as_integer(), Some(500_000));
}

#[test]
fn test_parse_invalid_scheme() {
    let url = "https://v1/import?resource=provider&app=claude&name=Test";

    let result = parse_deeplink_url(url);
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Invalid Chimera++ deep-link scheme"));
}

#[test]
fn test_parse_unsupported_version() {
    let url = "ccswitch://v2/import?resource=provider&app=claude&name=Test";

    let result = parse_deeplink_url(url);
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Unsupported protocol version"));
}

#[test]
fn test_parse_missing_required_field() {
    // Name is still required even in v3.8+ (only homepage/endpoint/apiKey are optional)
    let url = "ccswitch://v1/import?resource=provider&app=claude";

    let result = parse_deeplink_url(url);
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Missing 'name' parameter"));
}

// =============================================================================
// Utils Tests
// =============================================================================

#[test]
fn test_validate_invalid_url() {
    let result = validate_url("not-a-url", "test");
    assert!(result.is_err());
}

#[test]
fn test_validate_invalid_scheme() {
    let result = validate_url("ftp://example.com", "test");
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("必须是 http 或 https"));
}

#[test]
fn test_infer_homepage() {
    assert_eq!(
        infer_homepage_from_endpoint("https://api.anthropic.com/v1"),
        Some("https://anthropic.com".to_string())
    );
    assert_eq!(
        infer_homepage_from_endpoint("https://api-test.company.com/v1"),
        Some("https://test.company.com".to_string())
    );
    assert_eq!(
        infer_homepage_from_endpoint("https://example.com"),
        Some("https://example.com".to_string())
    );
}

// =============================================================================
// Provider Tests
// =============================================================================

#[test]
fn test_build_gemini_provider_with_model() {
    use super::provider::build_provider_from_request;

    let request = DeepLinkImportRequest {
        version: "v1".to_string(),
        resource: "provider".to_string(),
        app: Some("gemini".to_string()),
        name: Some("Test Gemini".to_string()),
        homepage: Some("https://example.com".to_string()),
        endpoint: Some("https://api.example.com".to_string()),
        api_key: Some("test-api-key".to_string()),
        icon: None,
        model: Some("gemini-2.0-flash".to_string()),
        notes: None,
        haiku_model: None,
        sonnet_model: None,
        opus_model: None,
        config: None,
        config_format: None,
        config_url: None,
        apps: None,
        repo: None,
        directory: None,
        branch: None,
        content: None,
        description: None,
        enabled: None,
        usage_enabled: None,
        usage_script: None,
        usage_api_key: None,
        usage_base_url: None,
        usage_access_token: None,
        usage_user_id: None,
        usage_auto_interval: None,
        confirmed_env_keys: None,
        confirmed_usage_enabled: None,
    };

    let provider = build_provider_from_request(&AppType::Gemini, &request).unwrap();

    // Verify provider basic info
    assert_eq!(provider.name, "Test Gemini");
    assert_eq!(
        provider.website_url,
        Some("https://example.com".to_string())
    );

    // Verify settings_config structure
    let env = provider.settings_config["env"].as_object().unwrap();
    assert_eq!(env["GEMINI_API_KEY"], "test-api-key");
    assert_eq!(env["GOOGLE_GEMINI_BASE_URL"], "https://api.example.com");
    assert_eq!(env["GEMINI_MODEL"], "gemini-2.0-flash");
}

#[test]
fn test_build_gemini_provider_without_model() {
    use super::provider::build_provider_from_request;

    let request = DeepLinkImportRequest {
        version: "v1".to_string(),
        resource: "provider".to_string(),
        app: Some("gemini".to_string()),
        name: Some("Test Gemini".to_string()),
        homepage: Some("https://example.com".to_string()),
        endpoint: Some("https://api.example.com".to_string()),
        api_key: Some("test-api-key".to_string()),
        icon: None,
        model: None,
        notes: None,
        haiku_model: None,
        sonnet_model: None,
        opus_model: None,
        config: None,
        config_format: None,
        config_url: None,
        apps: None,
        repo: None,
        directory: None,
        branch: None,
        content: None,
        description: None,
        enabled: None,
        usage_enabled: None,
        usage_script: None,
        usage_api_key: None,
        usage_base_url: None,
        usage_access_token: None,
        usage_user_id: None,
        usage_auto_interval: None,
        confirmed_env_keys: None,
        confirmed_usage_enabled: None,
    };

    let provider = build_provider_from_request(&AppType::Gemini, &request).unwrap();

    let env = provider.settings_config["env"].as_object().unwrap();
    assert_eq!(env["GEMINI_API_KEY"], "test-api-key");
    assert_eq!(env["GOOGLE_GEMINI_BASE_URL"], "https://api.example.com");
    // Model should not be present
    assert!(env.get("GEMINI_MODEL").is_none());
}

#[test]
fn test_deeplink_usage_script_does_not_copy_provider_credentials() {
    use super::provider::build_provider_from_request;

    let request = DeepLinkImportRequest {
        version: "v1".to_string(),
        resource: "provider".to_string(),
        app: Some("claude".to_string()),
        name: Some("Test Claude".to_string()),
        homepage: Some("https://example.com".to_string()),
        endpoint: Some("https://api.example.com/v1/".to_string()),
        api_key: Some("sk-main".to_string()),
        icon: None,
        model: None,
        notes: None,
        haiku_model: None,
        sonnet_model: None,
        opus_model: None,
        config: None,
        config_format: None,
        config_url: None,
        apps: None,
        repo: None,
        directory: None,
        branch: None,
        content: None,
        description: None,
        enabled: None,
        usage_enabled: Some(true),
        usage_script: None,
        usage_api_key: None,
        usage_base_url: None,
        usage_access_token: None,
        usage_user_id: None,
        usage_auto_interval: None,
        confirmed_env_keys: None,
        confirmed_usage_enabled: None,
    };

    let provider = build_provider_from_request(&AppType::Claude, &request).unwrap();
    let script = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.usage_script.as_ref())
        .expect("usage script should be created");

    // The link's `usageEnabled=true` alone never enables the query.
    assert!(!script.enabled);
    assert_eq!(script.api_key, None);
    assert_eq!(script.base_url, None);
}

#[test]
fn test_deeplink_usage_script_omits_explicit_credentials_that_match_provider() {
    use super::provider::build_provider_from_request;

    let request = DeepLinkImportRequest {
        version: "v1".to_string(),
        resource: "provider".to_string(),
        app: Some("claude".to_string()),
        name: Some("Test Claude".to_string()),
        homepage: Some("https://example.com".to_string()),
        endpoint: Some("https://api.example.com/v1/".to_string()),
        api_key: Some("sk-main".to_string()),
        icon: None,
        model: None,
        notes: None,
        haiku_model: None,
        sonnet_model: None,
        opus_model: None,
        config: None,
        config_format: None,
        config_url: None,
        apps: None,
        repo: None,
        directory: None,
        branch: None,
        content: None,
        description: None,
        enabled: None,
        usage_enabled: Some(true),
        usage_script: None,
        usage_api_key: Some(" sk-main ".to_string()),
        usage_base_url: Some(" https://api.example.com/v1/ ".to_string()),
        usage_access_token: None,
        usage_user_id: None,
        usage_auto_interval: None,
        confirmed_env_keys: None,
        confirmed_usage_enabled: None,
    };

    let provider = build_provider_from_request(&AppType::Claude, &request).unwrap();
    let script = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.usage_script.as_ref())
        .expect("usage script should be created");

    assert_eq!(script.api_key, None);
    assert_eq!(script.base_url, None);
}

#[test]
fn test_deeplink_usage_script_preserves_distinct_usage_credentials() {
    use super::provider::build_provider_from_request;

    let request = DeepLinkImportRequest {
        version: "v1".to_string(),
        resource: "provider".to_string(),
        app: Some("claude".to_string()),
        name: Some("Test Claude".to_string()),
        homepage: Some("https://example.com".to_string()),
        endpoint: Some("https://api.example.com/v1".to_string()),
        api_key: Some("sk-main".to_string()),
        icon: None,
        model: None,
        notes: None,
        haiku_model: None,
        sonnet_model: None,
        opus_model: None,
        config: None,
        config_format: None,
        config_url: None,
        apps: None,
        repo: None,
        directory: None,
        branch: None,
        content: None,
        description: None,
        enabled: None,
        usage_enabled: Some(true),
        usage_script: None,
        usage_api_key: Some(" sk-usage ".to_string()),
        usage_base_url: Some(" https://usage.example/api/ ".to_string()),
        usage_access_token: None,
        usage_user_id: None,
        usage_auto_interval: None,
        confirmed_env_keys: None,
        confirmed_usage_enabled: None,
    };

    let provider = build_provider_from_request(&AppType::Claude, &request).unwrap();
    let script = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.usage_script.as_ref())
        .expect("usage script should be created");

    assert_eq!(script.api_key.as_deref(), Some("sk-usage"));
    assert_eq!(
        script.base_url.as_deref(),
        Some("https://usage.example/api")
    );
}

#[test]
fn test_parse_and_merge_config_claude() {
    // Prepare Base64 encoded Claude config
    let config_json = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-ant-xxx","ANTHROPIC_BASE_URL":"https://api.anthropic.com/v1","ANTHROPIC_MODEL":"claude-sonnet-4.5"}}"#;
    let config_b64 = BASE64_STANDARD.encode(config_json.as_bytes());

    let request = DeepLinkImportRequest {
        version: "v1".to_string(),
        resource: "provider".to_string(),
        app: Some("claude".to_string()),
        name: Some("Test".to_string()),
        homepage: None,
        endpoint: None,
        api_key: None,
        icon: None,
        model: None,
        notes: None,
        haiku_model: None,
        sonnet_model: None,
        opus_model: None,
        config: Some(config_b64),
        config_format: Some("json".to_string()),
        config_url: None,
        apps: None,
        repo: None,
        directory: None,
        branch: None,
        content: None,
        description: None,
        enabled: None,
        usage_enabled: None,
        usage_script: None,
        usage_api_key: None,
        usage_base_url: None,
        usage_access_token: None,
        usage_user_id: None,
        usage_auto_interval: None,
        confirmed_env_keys: None,
        confirmed_usage_enabled: None,
    };

    let merged = parse_and_merge_config(&request).unwrap();

    // Should auto-fill from config
    assert_eq!(merged.api_key, Some("sk-ant-xxx".to_string()));
    assert_eq!(
        merged.endpoint,
        Some("https://api.anthropic.com/v1".to_string())
    );
    assert_eq!(merged.homepage, Some("https://anthropic.com".to_string()));
    assert_eq!(merged.model, Some("claude-sonnet-4.5".to_string()));
}

#[test]
fn test_parse_and_merge_config_codex_uses_bearer_token() {
    let config_toml = r#"model_provider = "rightcode"
model = "gpt-5-codex"

[model_providers.rightcode]
base_url = "https://rightcode.example/v1"
wire_api = "responses"
experimental_bearer_token = "sk-rightcode"
"#;
    let config_json = serde_json::json!({
        "auth": {},
        "config": config_toml,
    })
    .to_string();
    let config_b64 = BASE64_STANDARD.encode(config_json.as_bytes());

    let request = DeepLinkImportRequest {
        version: "v1".to_string(),
        resource: "provider".to_string(),
        app: Some("codex".to_string()),
        name: Some("RightCode".to_string()),
        config: Some(config_b64),
        config_format: Some("json".to_string()),
        ..Default::default()
    };

    let merged = parse_and_merge_config(&request).unwrap();

    assert_eq!(merged.api_key, Some("sk-rightcode".to_string()));
    assert_eq!(
        merged.endpoint,
        Some("https://rightcode.example/v1".to_string())
    );
    assert_eq!(
        merged.homepage,
        Some("https://rightcode.example".to_string())
    );
    assert_eq!(merged.model, Some("gpt-5-codex".to_string()));
}

#[test]
fn test_parse_and_merge_config_grokbuild() {
    let config_toml = r#"[models]
default = "grok-profile"

[model."grok-profile"]
model = "grok-upstream"
base_url = "https://grok.example/v1"
name = "Grok Relay"
api_key = "sk-grok"
api_backend = "responses"
context_window = 500000
"#;
    let config_json = serde_json::json!({ "config": config_toml }).to_string();
    let request = DeepLinkImportRequest {
        version: "v1".to_string(),
        resource: "provider".to_string(),
        app: Some("grokbuild".to_string()),
        name: Some("Grok Relay".to_string()),
        config: Some(BASE64_STANDARD.encode(config_json.as_bytes())),
        config_format: Some("json".to_string()),
        ..Default::default()
    };

    let merged = parse_and_merge_config(&request).expect("merge Grok Build config");

    assert_eq!(merged.api_key.as_deref(), Some("sk-grok"));
    assert_eq!(merged.endpoint.as_deref(), Some("https://grok.example/v1"));
    assert_eq!(merged.model.as_deref(), Some("grok-upstream"));
    assert_eq!(merged.homepage.as_deref(), Some("https://grok.example"));
}

#[test]
fn test_parse_and_merge_config_url_override() {
    let config_json = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-old","ANTHROPIC_BASE_URL":"https://api.anthropic.com/v1"}}"#;
    let config_b64 = BASE64_STANDARD.encode(config_json.as_bytes());

    let request = DeepLinkImportRequest {
        version: "v1".to_string(),
        resource: "provider".to_string(),
        app: Some("claude".to_string()),
        name: Some("Test".to_string()),
        homepage: None,
        endpoint: None,
        api_key: Some("sk-new".to_string()), // URL param should override
        icon: None,
        model: None,
        notes: None,
        haiku_model: None,
        sonnet_model: None,
        opus_model: None,
        config: Some(config_b64),
        config_format: Some("json".to_string()),
        config_url: None,
        apps: None,
        repo: None,
        directory: None,
        branch: None,
        content: None,
        description: None,
        enabled: None,
        usage_enabled: None,
        usage_script: None,
        usage_api_key: None,
        usage_base_url: None,
        usage_access_token: None,
        usage_user_id: None,
        usage_auto_interval: None,
        confirmed_env_keys: None,
        confirmed_usage_enabled: None,
    };

    let merged = parse_and_merge_config(&request).unwrap();

    // URL param should take priority
    assert_eq!(merged.api_key, Some("sk-new".to_string()));
    // Config file value should be used
    assert_eq!(
        merged.endpoint,
        Some("https://api.anthropic.com/v1".to_string())
    );
}

#[test]
fn test_build_claude_provider_preserves_custom_env_fields() {
    // Regression test for: deeplink import dropped non-standard env fields
    // such as ANTHROPIC_CUSTOM_HEADERS, even though the preview dialog
    // showed them. The preview and the actual persisted provider must
    // contain the same env keys.
    use super::provider::build_provider_from_request;

    let config_json = r#"{"env":{
        "ANTHROPIC_AUTH_TOKEN":"sk-ant-xxx",
        "ANTHROPIC_BASE_URL":"https://api.example.com",
        "ANTHROPIC_CUSTOM_HEADERS":"Cookie: session=abc",
        "API_TIMEOUT_MS":"3000000",
        "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS":"1",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL":"haiku-from-config"
    }}"#;
    let config_b64 = BASE64_STANDARD.encode(config_json.as_bytes());

    let request = DeepLinkImportRequest {
        version: "v1".to_string(),
        resource: "provider".to_string(),
        app: Some("claude".to_string()),
        name: Some("My Provider".to_string()),
        homepage: Some("https://example.com".to_string()),
        endpoint: Some("https://api.example.com".to_string()),
        api_key: Some("sk-ant-xxx".to_string()),
        icon: None,
        // URL param: must win over the same key in config (haiku-from-config)
        model: Some("main-model".to_string()),
        notes: None,
        haiku_model: Some("haiku-from-url".to_string()),
        sonnet_model: None,
        opus_model: None,
        config: Some(config_b64),
        config_format: Some("json".to_string()),
        config_url: None,
        apps: None,
        repo: None,
        directory: None,
        branch: None,
        content: None,
        description: None,
        enabled: None,
        usage_enabled: None,
        usage_script: None,
        usage_api_key: None,
        usage_base_url: None,
        usage_access_token: None,
        usage_user_id: None,
        usage_auto_interval: None,
        confirmed_env_keys: None,
        confirmed_usage_enabled: None,
    };

    let provider = build_provider_from_request(&AppType::Claude, &request).unwrap();
    let env = provider.settings_config["env"].as_object().unwrap();

    // Custom env fields from `config` must survive import
    assert_eq!(env["ANTHROPIC_CUSTOM_HEADERS"], "Cookie: session=abc");
    assert_eq!(env["API_TIMEOUT_MS"], "3000000");
    assert_eq!(env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"], "1");

    // Standard fields from URL params win over config
    assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "sk-ant-xxx");
    assert_eq!(env["ANTHROPIC_BASE_URL"], "https://api.example.com");
    assert_eq!(env["ANTHROPIC_MODEL"], "main-model");
    assert_eq!(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "haiku-from-url");
}

#[test]
fn test_build_claude_provider_without_config_unchanged() {
    // Backward compatibility: deeplinks without a `config` field still
    // produce exactly the same env shape as before — only the standard
    // ANTHROPIC_* keys, nothing else.
    use super::provider::build_provider_from_request;

    let request = DeepLinkImportRequest {
        version: "v1".to_string(),
        resource: "provider".to_string(),
        app: Some("claude".to_string()),
        name: Some("Plain".to_string()),
        homepage: Some("https://example.com".to_string()),
        endpoint: Some("https://api.example.com".to_string()),
        api_key: Some("sk".to_string()),
        icon: None,
        model: None,
        notes: None,
        haiku_model: None,
        sonnet_model: None,
        opus_model: None,
        config: None,
        config_format: None,
        config_url: None,
        apps: None,
        repo: None,
        directory: None,
        branch: None,
        content: None,
        description: None,
        enabled: None,
        usage_enabled: None,
        usage_script: None,
        usage_api_key: None,
        usage_base_url: None,
        usage_access_token: None,
        usage_user_id: None,
        usage_auto_interval: None,
        confirmed_env_keys: None,
        confirmed_usage_enabled: None,
    };

    let provider = build_provider_from_request(&AppType::Claude, &request).unwrap();
    let env = provider.settings_config["env"].as_object().unwrap();

    assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "sk");
    assert_eq!(env["ANTHROPIC_BASE_URL"], "https://api.example.com");
    // No extras leaked in
    assert_eq!(env.len(), 2);
}

// =============================================================================
// Prompt Tests
// =============================================================================

// Integration-style unit test: prompt import reaches PromptService and resolves
// live config file paths, so HOME must be isolated before it runs.
#[test]
#[serial_test::serial]
fn test_import_prompt_allows_space_in_base64_content() {
    let _test_home = TestHomeGuard::new();
    let url = "chimera://v1/import?resource=prompt&app=codex&name=PromptPlus&content=Pj4+";
    let request = parse_deeplink_url(url).unwrap();

    // URL decoded content may have "+" become space
    assert_eq!(request.content.as_deref(), Some("Pj4 "));

    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());

    let prompt_id = import_prompt_from_deeplink(&state, request.clone()).expect("import prompt");

    let prompts = state.db.get_prompts("codex").expect("get prompts");
    let prompt = prompts.get(&prompt_id).expect("prompt saved");

    assert_eq!(prompt.content, ">>>");
    assert_eq!(prompt.name, request.name.unwrap());
}

// =============================================================================
// MCP Tests
// =============================================================================

#[test]
fn test_parse_mcp_apps() {
    let apps = parse_mcp_apps("claude,codex").unwrap();
    assert!(apps.claude);
    assert!(apps.codex);
    assert!(!apps.gemini);

    let apps = parse_mcp_apps("gemini").unwrap();
    assert!(!apps.claude);
    assert!(!apps.codex);
    assert!(apps.gemini);

    let apps = parse_mcp_apps("grokbuild,opencode").unwrap();
    assert!(apps.grokbuild);
    assert!(apps.opencode);

    let err = parse_mcp_apps("invalid").unwrap_err();
    assert!(err.to_string().contains("Invalid app"));
}

#[test]
fn test_parse_prompt_deeplink() {
    let content = "Hello World";
    let content_b64 = BASE64_STANDARD.encode(content);
    let url = format!(
        "chimera://v1/import?resource=prompt&app=claude&name=test&content={}&description=desc&enabled=true",
        content_b64
    );

    let request = parse_deeplink_url(&url).unwrap();
    assert_eq!(request.resource, "prompt");
    assert_eq!(request.app.unwrap(), "claude");
    assert_eq!(request.name.unwrap(), "test");
    assert_eq!(request.content.unwrap(), content_b64);
    assert_eq!(request.description.unwrap(), "desc");
    assert!(request.enabled.unwrap());
}

#[test]
fn test_parse_grokbuild_prompt_deeplink() {
    let content_b64 = BASE64_STANDARD.encode("Grok instructions");
    let url = format!(
        "chimera://v1/import?resource=prompt&app=grokbuild&name=test&content={content_b64}"
    );

    let request = parse_deeplink_url(&url).expect("parse Grok Build prompt deeplink");

    assert_eq!(request.app.as_deref(), Some("grokbuild"));
}

#[test]
fn test_parse_mcp_deeplink() {
    let config = r#"{"mcpServers":{"test":{"command":"echo"}}}"#;
    let config_b64 = BASE64_STANDARD.encode(config);
    let url = format!(
        "chimera://v1/import?resource=mcp&apps=claude,codex&config={}&enabled=true",
        config_b64
    );

    let request = parse_deeplink_url(&url).unwrap();
    assert_eq!(request.resource, "mcp");
    assert_eq!(request.apps.unwrap(), "claude,codex");
    assert_eq!(request.config.unwrap(), config_b64);
    assert!(request.enabled.unwrap());
}

#[test]
fn test_parse_grokbuild_mcp_deeplink() {
    let config = r#"{"mcpServers":{"test":{"command":"echo"}}}"#;
    let config_b64 = BASE64_STANDARD.encode(config);
    let url =
        format!("chimera://v1/import?resource=mcp&apps=grokbuild&config={config_b64}&enabled=true");

    let request = parse_deeplink_url(&url).expect("parse Grok Build MCP deeplink");

    assert_eq!(request.apps.as_deref(), Some("grokbuild"));
}

#[test]
fn test_parse_skill_deeplink() {
    let url = "chimera://v1/import?resource=skill&repo=owner/repo&directory=skills&branch=dev";
    let request = parse_deeplink_url(url).unwrap();

    assert_eq!(request.resource, "skill");
    assert_eq!(request.repo.unwrap(), "owner/repo");
    assert_eq!(request.directory.unwrap(), "skills");
    assert_eq!(request.branch.unwrap(), "dev");
}

// =============================================================================
// Multiple Endpoints Tests
// =============================================================================

#[test]
fn test_parse_multiple_endpoints_comma_separated() {
    let url = "ccswitch://v1/import?resource=provider&app=claude&name=Test&endpoint=https%3A%2F%2Fapi1.example.com,https%3A%2F%2Fapi2.example.com,https%3A%2F%2Fapi3.example.com&apiKey=sk-test";

    let request = parse_deeplink_url(url).unwrap();

    assert!(request.endpoint.is_some());
    let endpoint = request.endpoint.unwrap();
    // Should contain all endpoints comma-separated
    assert!(endpoint.contains("https://api1.example.com"));
    assert!(endpoint.contains("https://api2.example.com"));
    assert!(endpoint.contains("https://api3.example.com"));
}

#[test]
fn test_parse_single_endpoint_backward_compatible() {
    // Old format with single endpoint should still work
    let url = "ccswitch://v1/import?resource=provider&app=claude&name=Test&endpoint=https%3A%2F%2Fapi.example.com&apiKey=sk-test";

    let request = parse_deeplink_url(url).unwrap();

    assert_eq!(
        request.endpoint,
        Some("https://api.example.com".to_string())
    );
}

#[test]
fn test_parse_endpoints_with_spaces_trimmed() {
    let url = "ccswitch://v1/import?resource=provider&app=claude&name=Test&endpoint=https%3A%2F%2Fapi1.example.com%20,%20https%3A%2F%2Fapi2.example.com&apiKey=sk-test";

    let request = parse_deeplink_url(url).unwrap();

    // Validation should pass (spaces are trimmed during validation)
    assert!(request.endpoint.is_some());
}

#[test]
fn test_infer_homepage_from_endpoint_without_homepage() {
    // Test that homepage is auto-inferred from endpoint when not provided
    assert_eq!(
        infer_homepage_from_endpoint("https://api.cubence.com/v1"),
        Some("https://cubence.com".to_string())
    );
    assert_eq!(
        infer_homepage_from_endpoint("https://cubence.com"),
        Some("https://cubence.com".to_string())
    );
}

// =============================================================================
// MH-4 lockdown
// =============================================================================

#[test]
fn legacy_scheme_is_provider_only() {
    let content_b64 = BASE64_STANDARD.encode("x");
    let mcp_b64 = BASE64_STANDARD.encode(r#"{"mcpServers":{"t":{"command":"echo"}}}"#);
    for query in [
        format!("resource=prompt&app=claude&name=p&content={content_b64}"),
        format!("resource=mcp&apps=claude&config={mcp_b64}"),
        "resource=skill&repo=owner/repo".to_string(),
    ] {
        let error = parse_deeplink_url(&format!("ccswitch://v1/import?{query}")).unwrap_err();
        assert!(
            error.to_string().contains("can only import providers"),
            "{query}: {error}"
        );
        parse_deeplink_url(&format!("chimera://v1/import?{query}"))
            .unwrap_or_else(|error| panic!("{query}: {error}"));
    }
    let provider =
        "resource=provider&app=claude&name=P&endpoint=https%3A%2F%2Fapi.example.com&apiKey=k";
    for scheme in ["ccswitch", "chimera"] {
        parse_deeplink_url(&format!("{scheme}://v1/import?{provider}")).unwrap();
    }
}

#[test]
#[serial_test::serial]
fn prompt_deeplink_imports_disabled_and_leaves_live_file_alone() {
    let _test_home = TestHomeGuard::new();
    let live = crate::prompt_files::prompt_file_path(&AppType::Codex).expect("prompt path");
    std::fs::create_dir_all(live.parent().expect("prompt dir")).expect("create prompt dir");
    std::fs::write(&live, "hand-written instructions").expect("seed live prompt");

    let content_b64 = BASE64_STANDARD.encode("imported prompt");
    let request = parse_deeplink_url(&format!(
        "chimera://v1/import?resource=prompt&app=codex&name=Linked&content={content_b64}&enabled=true"
    ))
    .unwrap();
    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());
    let id = import_prompt_from_deeplink(&state, request).expect("import prompt");

    let prompts = db.get_prompts("codex").expect("get prompts");
    let prompt = prompts.get(&id).expect("prompt saved");
    assert!(!prompt.enabled, "enabled=true on a prompt link is ignored");
    assert_eq!(prompt.content, "imported prompt");
    assert_eq!(
        std::fs::read_to_string(&live).expect("read live prompt"),
        "hand-written instructions",
        "a prompt link must not write or truncate the live prompt file"
    );
}

#[test]
#[serial_test::serial]
fn skill_deeplink_repo_is_added_disabled() {
    let _test_home = TestHomeGuard::new();
    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());
    let mut request =
        parse_deeplink_url("chimera://v1/import?resource=skill&repo=owner/linked-repo").unwrap();
    request.enabled = Some(true);

    import_skill_from_deeplink(&state, request).expect("import skill repo");

    let repo = db
        .get_skill_repos()
        .expect("read skill repos")
        .into_iter()
        .find(|repo| repo.owner == "owner" && repo.name == "linked-repo")
        .expect("repo saved");
    assert!(!repo.enabled);
}

#[test]
#[serial_test::serial]
fn preview_reports_full_content_absolute_targets_and_env_verdicts() {
    let _test_home = TestHomeGuard::new();
    crate::settings::reload_settings().expect("reload settings");

    let content_b64 = BASE64_STANDARD.encode("# Linked\nfull body");
    let prompt = parse_deeplink_url(&format!(
        "chimera://v1/import?resource=prompt&app=codex&name=P&content={content_b64}&enabled=true"
    ))
    .unwrap();
    let preview = super::preview_deeplink_import(&prompt).expect("prompt preview");
    assert_eq!(preview.content, "# Linked\nfull body");
    assert!(!preview.writes_live);
    assert_eq!(preview.target_paths.len(), 1);
    let target = std::path::Path::new(&preview.target_paths[0]);
    assert!(target.is_absolute(), "{target:?}");
    assert!(target.ends_with("AGENTS.md"), "{target:?}");

    let mut provider = parse_deeplink_url(
        "chimera://v1/import?resource=provider&app=claude&name=P&endpoint=https%3A%2F%2Fapi.example.com&apiKey=k&enabled=true",
    )
    .unwrap();
    provider.config =
        Some(BASE64_STANDARD.encode(
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"t","VENDOR_FLAG":"1","LD_PRELOAD":"/x.so"}}"#,
        ));
    provider.config_format = Some("json".to_string());
    let preview = super::preview_deeplink_import(&provider).expect("provider preview");
    assert!(!preview.writes_live, "Claude is hidden by default");
    assert!(preview.target_paths[0].ends_with("settings.json"));
    assert!(preview.content.contains("VENDOR_FLAG"));
    let status = |key: &str| {
        preview
            .env
            .iter()
            .find(|review| review.key == key)
            .map(|review| review.status)
    };
    assert_eq!(status("ANTHROPIC_AUTH_TOKEN"), Some(EnvKeyStatus::Allowed));
    assert_eq!(status("VENDOR_FLAG"), Some(EnvKeyStatus::NeedsConfirmation));
    assert_eq!(status("LD_PRELOAD"), Some(EnvKeyStatus::Denied));

    let codex = parse_deeplink_url(
        "chimera://v1/import?resource=provider&app=codex&name=C&endpoint=https%3A%2F%2Fapi.example.com%2Fv1&apiKey=k&enabled=true",
    )
    .unwrap();
    let preview = super::preview_deeplink_import(&codex).expect("codex preview");
    assert!(
        preview.writes_live,
        "visible Codex with enabled=true activates"
    );
    assert!(preview
        .target_paths
        .iter()
        .any(|path| path.ends_with("config.toml")));
}

#[test]
fn supported_deeplink_targets_are_allowed_but_unknown_targets_are_rejected() {
    use super::ensure_targets_allowed;

    let codex_provider = DeepLinkImportRequest {
        resource: "provider".to_string(),
        app: Some("codex".to_string()),
        ..Default::default()
    };
    assert!(ensure_targets_allowed(&codex_provider).is_ok());
    // A link without any target (e.g. a skill repo) is not an app-scoped import.
    assert!(ensure_targets_allowed(&DeepLinkImportRequest::default()).is_ok());

    for app in crate::app_config::AppType::all() {
        let request = DeepLinkImportRequest {
            resource: "provider".to_string(),
            app: Some(app.as_str().to_string()),
            ..Default::default()
        };
        assert!(ensure_targets_allowed(&request).is_ok(), "{}", app.as_str());
    }

    for apps in ["codex,claude", " gemini "] {
        let request = DeepLinkImportRequest {
            resource: "mcp".to_string(),
            apps: Some(apps.to_string()),
            ..Default::default()
        };
        assert!(ensure_targets_allowed(&request).is_ok(), "{apps}");
    }
    for target in ["not-a-tool", "codex,not-a-tool"] {
        for request in [
            DeepLinkImportRequest {
                app: Some(target.into()),
                ..Default::default()
            },
            DeepLinkImportRequest {
                apps: Some(target.into()),
                ..Default::default()
            },
        ] {
            assert!(ensure_targets_allowed(&request).is_err(), "{target}");
        }
    }
    let codex_mcp = DeepLinkImportRequest {
        resource: "mcp".to_string(),
        apps: Some("codex".to_string()),
        ..Default::default()
    };
    assert!(ensure_targets_allowed(&codex_mcp).is_ok());
}

// =============================================================================
// Link review fixes: expansion, usage script, Codex and Grok configs
// =============================================================================

/// A provider link for `app` with ordinary values, where `overrides`
/// replace (or add) parameters.
fn provider_link(app: &str, overrides: &[(&str, &str)]) -> String {
    let mut params: Vec<(&str, &str)> = vec![
        ("resource", "provider"),
        ("app", app),
        ("name", "Example"),
        ("endpoint", "https://api.example.com/v1"),
        ("apiKey", "sk-example-123"),
        ("model", "example-model"),
    ];
    for (key, value) in overrides {
        params.retain(|(existing, _)| existing != key);
        params.push((*key, *value));
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params)
        .finish();
    format!("chimera://v1/import?{query}")
}

fn base64_json(value: serde_json::Value) -> String {
    BASE64_STANDARD.encode(value.to_string())
}

#[test]
fn link_values_a_tool_would_expand_are_refused_while_parsing() {
    for (app, param, label, value) in [
        ("pi", "apiKey", "API Key", "!curl x|sh"),
        ("pi", "apiKey", "API Key", "$HOME"),
        ("pi", "apiKey", "API Key", "${OPENAI_API_KEY}"),
        ("pi", "model", "模型", "${HOME}"),
        ("opencode", "apiKey", "API Key", "{file:~/.ssh/id_rsa}"),
        ("opencode", "apiKey", "API Key", "{env:AWS_SECRET}"),
        (
            "opencode",
            "endpoint",
            "请求地址",
            "https://api.example.com/{env:GITHUB_TOKEN}",
        ),
        (
            "gemini",
            "apiKey",
            "API Key",
            "key\nNODE_OPTIONS=--require x",
        ),
    ] {
        let error = parse_deeplink_url(&provider_link(app, &[(param, value)]))
            .expect_err("expansion syntax must be refused while parsing");
        let message = error.to_string();
        assert!(message.contains(label), "{app}/{param}: {message}");
        assert!(!message.contains(value), "{app}/{param}: {message}");
    }
}

#[test]
fn ordinary_link_values_still_parse() {
    for (app, param, value) in [
        ("pi", "apiKey", "sk-abc$1def"),
        ("pi", "apiKey", "sk-ends-with-!"),
        ("opencode", "apiKey", "sk-{not-a-reference}"),
        // Switch-mode tools do not expand these spellings.
        ("claude", "apiKey", "!literal-key"),
        ("codex", "apiKey", "${literal}"),
        ("gemini", "apiKey", "{env:LITERAL}"),
    ] {
        let request = parse_deeplink_url(&provider_link(app, &[(param, value)]))
            .unwrap_or_else(|error| panic!("{app}/{param}={value} should parse: {error}"));
        assert_eq!(request.app.as_deref(), Some(app));
    }
}

#[test]
fn values_from_a_config_or_a_direct_request_are_checked_too() {
    use super::provider::build_provider_from_request;

    for (app, config) in [
        (
            "opencode",
            serde_json::json!({ "apiKey": "{file:~/.aws/credentials}" }),
        ),
        ("pi", serde_json::json!({ "apiKey": "!cat ~/.ssh/id_rsa" })),
    ] {
        let config = base64_json(config);
        let request = parse_deeplink_url(&provider_link(
            app,
            &[("apiKey", ""), ("config", config.as_str())],
        ))
        .expect("the URL parameters themselves are ordinary");
        let error = parse_and_merge_config(&request).expect_err("merged key must be refused");
        assert!(error.to_string().contains("API Key"), "{app}: {error}");
    }

    // The frontend can send a request that never went through the parser.
    let request = DeepLinkImportRequest {
        resource: "provider".to_string(),
        app: Some("pi".to_string()),
        name: Some("Example".to_string()),
        endpoint: Some("https://api.example.com/v1".to_string()),
        api_key: Some("!printf review-fixture".to_string()),
        model: Some("m".to_string()),
        ..Default::default()
    };
    assert!(build_provider_from_request(&AppType::Pi, &request).is_err());
}

#[test]
fn addresses_filled_in_from_a_config_must_be_plain_web_addresses() {
    let config = base64_json(serde_json::json!({
        "env": { "ANTHROPIC_AUTH_TOKEN": "sk", "ANTHROPIC_BASE_URL": "file:///etc/passwd" }
    }));
    let request = parse_deeplink_url(&provider_link(
        "claude",
        &[("endpoint", ""), ("config", config.as_str())],
    ))
    .expect("parse");
    let error = parse_and_merge_config(&request).expect_err("file URL must be refused");
    assert!(error.to_string().contains("http"), "{error}");
}

#[test]
fn a_remote_config_url_is_refused_while_parsing() {
    let error = parse_deeplink_url(&provider_link(
        "codex",
        &[("configUrl", "https://example.com/config.json")],
    ))
    .expect_err("configUrl must be refused up front");
    assert!(error.to_string().contains("configUrl"), "{error}");
}

fn usage_request(code: &str, link_enabled: Option<bool>) -> DeepLinkImportRequest {
    DeepLinkImportRequest {
        resource: "provider".to_string(),
        app: Some("claude".to_string()),
        name: Some("Usage".to_string()),
        endpoint: Some("https://api.example.com/v1".to_string()),
        api_key: Some("sk-main".to_string()),
        usage_enabled: link_enabled,
        usage_script: Some(BASE64_STANDARD.encode(code)),
        ..Default::default()
    }
}

#[test]
fn a_usage_script_is_enabled_only_by_the_dialog_switch() {
    use super::provider::build_provider_from_request;

    let enabled = |request: &DeepLinkImportRequest| {
        build_provider_from_request(&AppType::Claude, request)
            .expect("build")
            .meta
            .and_then(|meta| meta.usage_script)
            .map(|script| script.enabled)
    };

    // Neither a script alone nor the link's own request turns it on.
    assert_eq!(enabled(&usage_request("return 1;", None)), Some(false));
    assert_eq!(
        enabled(&usage_request("return 1;", Some(true))),
        Some(false)
    );

    let mut confirmed = usage_request("return 1;", None);
    confirmed.confirmed_usage_enabled = Some(true);
    assert_eq!(enabled(&confirmed), Some(true));

    let mut declined = usage_request("return 1;", Some(true));
    declined.confirmed_usage_enabled = Some(false);
    assert_eq!(enabled(&declined), Some(false));

    // A blank script has nothing to run.
    let mut empty = usage_request("  \n", None);
    empty.confirmed_usage_enabled = Some(true);
    assert_eq!(enabled(&empty), Some(false));
}

#[test]
#[serial_test::serial]
fn preview_shows_the_usage_script_and_the_host_it_may_contact() {
    let _test_home = TestHomeGuard::new();
    crate::settings::reload_settings().expect("reload settings");

    let script = "return fetch(\"{{baseUrl}}/balance\");";
    let encoded = BASE64_STANDARD.encode(script);
    let request = parse_deeplink_url(&provider_link(
        "codex",
        &[
            ("usageScript", encoded.as_str()),
            ("usageEnabled", "true"),
            ("usageAutoInterval", "30"),
        ],
    ))
    .expect("parse");
    let preview = super::preview_deeplink_import(&request).expect("preview");
    let usage = preview.usage.expect("usage section");
    assert_eq!(usage.code, script);
    assert_eq!(usage.hosts, ["api.example.com"]);
    assert!(usage.link_requests_enabled);
    assert_eq!(usage.auto_interval_minutes, Some(30));
    assert!(preview.may_activate, "Codex is visible by default");

    let request = parse_deeplink_url(&provider_link(
        "codex",
        &[
            ("usageScript", encoded.as_str()),
            ("usageBaseUrl", "https://usage.example.com:8443/api"),
        ],
    ))
    .expect("parse");
    let usage = super::preview_deeplink_import(&request)
        .expect("preview")
        .usage
        .expect("usage section");
    assert_eq!(usage.hosts, ["usage.example.com:8443"]);
    assert!(!usage.link_requests_enabled);

    assert!(parse_deeplink_url(&provider_link("codex", &[("usageBaseUrl", "file:///x")])).is_err());
}

#[test]
fn a_codex_link_without_config_keeps_the_template_byte_for_byte() {
    use super::provider::build_provider_from_request;

    let request = parse_deeplink_url(&provider_link(
        "codex",
        &[("name", "My Relay"), ("model", "gpt-5-codex")],
    ))
    .expect("parse");
    let provider = build_provider_from_request(&AppType::Codex, &request).expect("build");
    assert_eq!(
        provider.settings_config,
        serde_json::json!({
            "auth": { "OPENAI_API_KEY": "sk-example-123" },
            "config": "model_provider = \"custom\"\nmodel = \"gpt-5-codex\"\nmodel_reasoning_effort = \"high\"\n\n[model_providers.custom]\nname = \"My Relay\"\nbase_url = \"https://api.example.com/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n",
            "modelCatalog": { "models": [{ "model": "gpt-5-codex" }] }
        })
    );
    assert_eq!(provider.meta.and_then(|meta| meta.api_format), None);
}

/// A link that carries `config` (merged into the request by the caller);
/// endpoint and model come from the config unless `overrides` set them.
fn config_link(
    app: &str,
    config: serde_json::Value,
    overrides: &[(&str, &str)],
) -> DeepLinkImportRequest {
    let config = base64_json(config);
    let mut params: Vec<(&str, &str)> = vec![("endpoint", "")];
    params.retain(|(key, _)| overrides.iter().all(|(other, _)| other != key));
    params.extend_from_slice(overrides);
    params.push(("config", config.as_str()));
    let mut request = parse_deeplink_url(&provider_link(app, &params)).expect("parse");
    // The base link's model would win over the config's.
    if !overrides.iter().any(|(key, _)| *key == "model") {
        request.model = None;
    }
    request
}

fn codex_config_link(config_toml: &str, overrides: &[(&str, &str)]) -> DeepLinkImportRequest {
    config_link(
        "codex",
        serde_json::json!({ "auth": {}, "config": config_toml }),
        overrides,
    )
}

#[test]
fn a_codex_link_keeps_its_provider_table_under_the_allowlist() {
    use super::provider::build_provider_from_request;

    let request = codex_config_link(
        r#"model_provider = "relay"
model = "gpt-5.5"
model_verbosity = "low"
notify_sound = true

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "chat"
requires_openai_auth = true
experimental_bearer_token = "sk-table"
stream_idle_timeout_ms = 300000
http_headers = { "x-team" = "42" }
query_params = { "api-version" = "2026-01-01" }
"#,
        &[],
    );
    let merged = parse_and_merge_config(&request).expect("merge");
    assert_eq!(merged.endpoint.as_deref(), Some("https://relay.example/v1"));
    assert_eq!(merged.model.as_deref(), Some("gpt-5.5"));
    // URL parameters win over the table's bearer token.
    assert_eq!(merged.api_key.as_deref(), Some("sk-example-123"));

    let provider = build_provider_from_request(&AppType::Codex, &merged).expect("build");
    let config: toml::Value = provider.settings_config["config"]
        .as_str()
        .expect("config text")
        .parse()
        .expect("valid TOML");
    let custom = &config["model_providers"]["custom"];
    assert_eq!(custom["http_headers"]["x-team"].as_str(), Some("42"));
    assert_eq!(
        custom["query_params"]["api-version"].as_str(),
        Some("2026-01-01")
    );
    assert_eq!(custom["stream_idle_timeout_ms"].as_integer(), Some(300_000));
    assert_eq!(custom["requires_openai_auth"].as_bool(), Some(false));
    assert_eq!(custom["wire_api"].as_str(), Some("responses"));
    assert!(custom.get("experimental_bearer_token").is_none());
    assert!(config.get("notify_sound").is_none());
    assert_eq!(config["model_verbosity"].as_str(), Some("low"));
    assert_eq!(
        provider.settings_config["auth"]["OPENAI_API_KEY"],
        "sk-example-123"
    );
    // The declared protocol wins over the model-family default.
    assert_eq!(
        provider.meta.and_then(|meta| meta.api_format).as_deref(),
        Some("openai_chat")
    );
}

#[test]
fn a_codex_link_that_runs_commands_or_leaks_credentials_is_refused() {
    use super::provider::build_provider_from_request;

    let auth_command = codex_config_link(
        "model_provider = \"r\"\n[model_providers.r]\nbase_url = \"https://relay.example/v1\"\n[model_providers.r.auth]\ncommand = \"curl\"\n",
        &[],
    );
    let error = parse_and_merge_config(&auth_command).expect_err("auth.command must be refused");
    assert!(error.to_string().contains("auth"), "{error}");

    let env_key_only = codex_config_link(
        "model_provider = \"r\"\n[model_providers.r]\nbase_url = \"https://relay.example/v1\"\nenv_key = \"AWS_SECRET_ACCESS_KEY\"\n",
        &[("apiKey", "")],
    );
    let error = parse_and_merge_config(&env_key_only).expect_err("env_key-only must be refused");
    assert!(error.to_string().contains("env_key"), "{error}");

    let cross_origin = codex_config_link(
        "model_provider = \"r\"\n[model_providers.r]\nbase_url = \"https://relay.example/v1\"\nmodel_catalog_url = \"https://collector.example/models\"\n",
        &[],
    );
    let merged = parse_and_merge_config(&cross_origin).expect("merge");
    let error = build_provider_from_request(&AppType::Codex, &merged)
        .expect_err("cross-origin catalog must be refused");
    assert!(error.to_string().contains("model_catalog_url"), "{error}");
}

#[test]
#[serial_test::serial]
fn preview_lists_link_settings_that_are_not_imported() {
    let _test_home = TestHomeGuard::new();
    crate::settings::reload_settings().expect("reload settings");

    let mut request = codex_config_link(
        "model_provider = \"r\"\nsandbox_mode = \"danger-full-access\"\n[model_providers.r]\nbase_url = \"https://relay.example/v1\"\n[model_providers.spare]\nbase_url = \"https://spare.example/v1\"\n",
        &[],
    );
    request.haiku_model = Some("haiku".to_string());
    let preview = super::preview_deeplink_import(&request).expect("preview");
    for name in ["haikuModel", "sandbox_mode", "model_providers.spare"] {
        assert!(
            preview.ignored.iter().any(|item| item == name),
            "{name}: {:?}",
            preview.ignored
        );
    }
}

fn grok_config_link(profile_fields: &str, overrides: &[(&str, &str)]) -> DeepLinkImportRequest {
    let config_toml = format!(
        "[models]\ndefault = \"relay-profile\"\n\n[model.\"relay-profile\"]\nmodel = \"grok-upstream\"\nbase_url = \"https://grok.example/v1\"\nname = \"Profile Display\"\napi_backend = \"chat_completions\"\ncontext_window = 256000\n{profile_fields}"
    );
    config_link(
        "grokbuild",
        serde_json::json!({ "config": config_toml }),
        overrides,
    )
}

#[test]
fn a_grok_link_keeps_backend_window_and_profile_name() {
    use super::provider::build_provider_from_request;

    let merged =
        parse_and_merge_config(&grok_config_link("", &[("name", "Grok Relay")])).expect("merge");
    let provider = build_provider_from_request(&AppType::GrokBuild, &merged).expect("build");
    let config: toml::Value = provider.settings_config["config"]
        .as_str()
        .expect("config text")
        .parse()
        .expect("valid TOML");
    let profile = &config["model"]["grok-upstream"];
    assert_eq!(profile["name"].as_str(), Some("Profile Display"));
    assert_eq!(profile["api_backend"].as_str(), Some("chat_completions"));
    assert_eq!(profile["context_window"].as_integer(), Some(256_000));
    assert_eq!(profile["api_key"].as_str(), Some("sk-example-123"));
    assert_eq!(
        profile["base_url"].as_str(),
        Some("https://grok.example/v1")
    );
    assert_eq!(
        provider.meta.and_then(|meta| meta.api_format).as_deref(),
        Some("openai_chat")
    );
}

#[test]
fn a_grok_link_with_local_credential_settings_is_refused() {
    for key in ["auth_provider", "env_http_headers", "mtls_cert_dir"] {
        let request = grok_config_link(&format!("{key} = \"x\"\n"), &[]);
        let error = parse_and_merge_config(&request).expect_err("must be refused");
        assert!(error.to_string().contains(key), "{key}: {error}");
    }

    let request = grok_config_link("env_key = \"AWS_SECRET_ACCESS_KEY\"\n", &[("apiKey", "")]);
    let error = parse_and_merge_config(&request).expect_err("env_key-only must be refused");
    assert!(error.to_string().contains("env_key"), "{error}");
}

struct EnvVarGuard {
    name: &'static str,
    original: Option<OsString>,
}

impl EnvVarGuard {
    fn set(name: &'static str, value: &str) -> Self {
        let original = env::var_os(name);
        env::set_var(name, value);
        Self { name, original }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match &self.original {
            Some(value) => env::set_var(self.name, value),
            None => env::remove_var(self.name),
        }
    }
}

#[test]
#[serial_test::serial]
fn a_grok_link_never_takes_a_key_from_this_computers_environment() {
    let _xai = EnvVarGuard::set("XAI_API_KEY", "local-xai-secret");
    let merged = parse_and_merge_config(&grok_config_link("", &[("apiKey", "")]))
        .expect("merge without a key");
    assert_eq!(merged.api_key, None);
}
