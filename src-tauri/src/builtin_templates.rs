//! Product-owned built-in provider templates.
//!
//! ChimeraHub is Chimera++'s own relay and the only built-in template. It is
//! defined here once: the renderer reads it through `get_chimerahub_template`
//! instead of carrying its own copy, and the balance service recognises the
//! same domain. The endpoint stays editable per provider, so a user with a
//! dedicated relay address can point the line elsewhere.

use serde::Serialize;
use serde_json::{json, Value};

pub const CHIMERAHUB_NAME: &str = "ChimeraHub";
pub const CHIMERAHUB_WEBSITE_URL: &str = "https://api.chimerahub.org/";
/// OpenAI-compatible endpoint (Responses and Chat Completions).
pub const CHIMERAHUB_BASE_URL: &str = "https://api.chimerahub.org/v1";
pub const CHIMERAHUB_MODEL: &str = "gpt-5.6-sol";
/// Registrable domain of every ChimeraHub endpoint.
const CHIMERAHUB_DOMAIN: &str = "chimerahub.org";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChimeraHubTemplate {
    pub name: &'static str,
    pub website_url: &'static str,
    /// OpenAI-compatible `/v1` base URL shared by every tool's preset.
    pub base_url: &'static str,
    pub model: &'static str,
    /// Codex `auth.json`: key-first, the user pastes their own key.
    pub auth: Value,
    /// Codex `config.toml`.
    pub config: String,
}

pub fn chimerahub_template() -> ChimeraHubTemplate {
    // `gpt-5.6-sol` is the built-in Codex slug; Responses is ChimeraHub's
    // native Codex protocol.
    let config = format!(
        r#"model_provider = "custom"
model = "{CHIMERAHUB_MODEL}"
model_reasoning_effort = "high"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = false
base_url = "{CHIMERAHUB_BASE_URL}""#
    );
    ChimeraHubTemplate {
        name: CHIMERAHUB_NAME,
        website_url: CHIMERAHUB_WEBSITE_URL,
        base_url: CHIMERAHUB_BASE_URL,
        model: CHIMERAHUB_MODEL,
        auth: json!({ "OPENAI_API_KEY": "" }),
        config,
    }
}

/// Whether `host` (already lower-cased) is a ChimeraHub endpoint.
pub fn is_chimerahub_host(host: &str) -> bool {
    host == CHIMERAHUB_DOMAIN
        || host
            .strip_suffix(CHIMERAHUB_DOMAIN)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

#[tauri::command]
pub fn get_chimerahub_template() -> ChimeraHubTemplate {
    chimerahub_template()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chimerahub_template_is_a_key_first_responses_line() {
        let template = chimerahub_template();
        let config: toml::Table = toml::from_str(&template.config).expect("valid config.toml");

        assert_eq!(config["model_provider"].as_str(), Some("custom"));
        assert_eq!(config["model"].as_str(), Some(CHIMERAHUB_MODEL));
        assert_eq!(config["model_reasoning_effort"].as_str(), Some("high"));
        let custom = &config["model_providers"]["custom"];
        assert_eq!(custom["base_url"].as_str(), Some(CHIMERAHUB_BASE_URL));
        assert_eq!(custom["wire_api"].as_str(), Some("responses"));
        assert_eq!(custom["requires_openai_auth"].as_bool(), Some(false));
        assert_eq!(template.auth, json!({ "OPENAI_API_KEY": "" }));
        assert_eq!(template.base_url, "https://api.chimerahub.org/v1");
        assert_eq!(template.model, "gpt-5.6-sol");
    }

    #[test]
    fn chimerahub_template_serializes_for_the_renderer() {
        let value = serde_json::to_value(chimerahub_template()).expect("serialize");
        assert_eq!(value["name"], "ChimeraHub");
        assert_eq!(value["websiteUrl"], "https://api.chimerahub.org/");
        assert_eq!(value["baseUrl"], "https://api.chimerahub.org/v1");
        assert_eq!(value["model"], "gpt-5.6-sol");
        assert_eq!(value["auth"], json!({ "OPENAI_API_KEY": "" }));
        assert!(value["config"].as_str().is_some());
    }

    #[test]
    fn chimerahub_host_matches_the_domain_and_its_subdomains_only() {
        assert!(is_chimerahub_host("chimerahub.org"));
        assert!(is_chimerahub_host("api.chimerahub.org"));
        assert!(is_chimerahub_host("relay-2.chimerahub.org"));
        assert!(!is_chimerahub_host("evilchimerahub.org"));
        assert!(!is_chimerahub_host("chimerahub.org.evil.test"));
        assert!(!is_chimerahub_host("chimerahub.com"));
        assert!(!is_chimerahub_host(""));
    }
}
