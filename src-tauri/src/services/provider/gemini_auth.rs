//! Gemini authentication type detection
//!
//! Detects whether a Gemini provider uses PackyCode API Key, Google OAuth, or generic API Key.

use crate::error::AppError;
use crate::provider::Provider;

/// Gemini authentication type enumeration
///
/// Used to optimize performance by avoiding repeated provider type detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GeminiAuthType {
    /// PackyCode provider (uses API Key)
    Packycode,
    /// Google Official (uses OAuth)
    GoogleOfficial,
    /// Generic Gemini provider (uses API Key)
    Generic,
}

// Partner Promotion Key constants
const PACKYCODE_PARTNER_KEY: &str = "packycode";
const GOOGLE_OFFICIAL_PARTNER_KEY: &str = "google-official";

// PackyCode keyword constants
const PACKYCODE_KEYWORDS: [&str; 3] = ["packycode", "packyapi", "packy"];

/// Detect Gemini provider authentication type
///
/// One-time detection to avoid repeated calls to `is_packycode_gemini` and `is_google_official_gemini`.
///
/// # Returns
///
/// - `GeminiAuthType::GoogleOfficial`: Google official, uses OAuth
/// - `GeminiAuthType::Packycode`: PackyCode provider, uses API Key
/// - `GeminiAuthType::Generic`: Other generic providers, uses API Key
pub(crate) fn detect_gemini_auth_type(provider: &Provider) -> GeminiAuthType {
    // Explicit API configuration overrides editable official hints, including
    // a partner marker inherited from an official preset.
    let explicit_api = [
        "/env/GEMINI_API_KEY",
        "/env/GOOGLE_API_KEY",
        "/env/GOOGLE_GEMINI_BASE_URL",
        "/env/GOOGLE_GENAI_USE_VERTEXAI",
    ]
    .iter()
    .any(|path| provider.settings_config.pointer(path).is_some())
        || provider
            .settings_config
            .pointer("/config/security/auth/selectedType")
            .is_some_and(|auth_type| auth_type.as_str() != Some("oauth-personal"));

    // Partner markers identify presets but cannot turn API settings into OAuth.
    let partner_key = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.partner_promotion_key.as_deref());
    if let Some(key) = partner_key {
        if key.eq_ignore_ascii_case(GOOGLE_OFFICIAL_PARTNER_KEY) && !explicit_api {
            return GeminiAuthType::GoogleOfficial;
        }
        if key.eq_ignore_ascii_case(PACKYCODE_PARTNER_KEY) {
            return GeminiAuthType::Packycode;
        }
    }

    // Legacy official presets may lack the partner key. An editable name alone
    // is insufficient, and explicit API-key settings must never become OAuth.
    let legacy_official =
        partner_key.is_none() && provider.category.as_deref() == Some("official") && !explicit_api;
    let name_lower = provider.name.to_ascii_lowercase();
    if legacy_official && (name_lower == "google" || name_lower.starts_with("google ")) {
        return GeminiAuthType::GoogleOfficial;
    }

    // API providers can still use PackyCode-specific handling.
    if contains_packycode_keyword(&provider.name) {
        return GeminiAuthType::Packycode;
    }

    if let Some(site) = provider.website_url.as_deref() {
        if contains_packycode_keyword(site) {
            return GeminiAuthType::Packycode;
        }
    }

    if let Some(base_url) = provider
        .settings_config
        .pointer("/env/GOOGLE_GEMINI_BASE_URL")
        .and_then(|v| v.as_str())
    {
        if contains_packycode_keyword(base_url) {
            return GeminiAuthType::Packycode;
        }
    }

    GeminiAuthType::Generic
}

/// Check if string contains PackyCode related keywords (case-insensitive)
///
/// Keyword list: ["packycode", "packyapi", "packy"]
fn contains_packycode_keyword(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    PACKYCODE_KEYWORDS
        .iter()
        .any(|keyword| lower.contains(keyword))
}

/// Detect if provider is Google Official Gemini (uses OAuth authentication)
///
/// Google Official Gemini uses OAuth personal authentication, no API Key needed.
///
/// This is a convenience wrapper around `detect_gemini_auth_type`.
pub(crate) fn is_google_official_gemini(provider: &Provider) -> bool {
    detect_gemini_auth_type(provider) == GeminiAuthType::GoogleOfficial
}

/// Ensure Google Official Gemini provider security flag is correctly set (OAuth mode)
///
/// Google Official Gemini uses OAuth personal authentication, no API Key needed.
///
/// # What it does
///
/// Writes to **`~/.gemini/settings.json`** (Gemini client config).
///
/// # Value set
///
/// ```json
/// {
///   "security": {
///     "auth": {
///       "selectedType": "oauth-personal"
///     }
///   }
/// }
/// ```
///
/// # OAuth authentication flow
///
/// 1. User switches to Google Official provider
/// 2. CC-Switch sets `selectedType = "oauth-personal"`
/// 3. User's first use of Gemini CLI will auto-open browser for OAuth login
/// 4. After successful login, credentials saved in Gemini credential store
/// 5. Subsequent requests auto-use saved credentials
///
/// # Error handling
///
/// If provider is not Google Official, function returns `Ok(())` immediately without any operation.
pub(crate) fn ensure_google_oauth_security_flag(provider: &Provider) -> Result<(), AppError> {
    if !is_google_official_gemini(provider) {
        return Ok(());
    }

    // Write to Gemini directory settings.json (~/.gemini/settings.json)
    use crate::gemini_config::write_google_oauth_settings;
    write_google_oauth_settings()?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderMeta;
    use serde_json::{json, Value};

    fn provider(name: &str, settings: Value) -> Provider {
        Provider::with_id(
            "synthetic-gemini".to_string(),
            name.to_string(),
            settings,
            None,
        )
    }

    #[test]
    fn gemini_auth_custom_google_names_remain_api_key() {
        for name in ["Google", "Google proxy", "gOoGlE custom"] {
            for category in [None, Some("custom"), Some("official")] {
                let mut candidate = provider(
                    name,
                    json!({"env": {
                        "GEMINI_API_KEY": "synthetic-key",
                        "GOOGLE_GEMINI_BASE_URL": "https://proxy.invalid"
                    }}),
                );
                candidate.category = category.map(str::to_string);
                assert_eq!(detect_gemini_auth_type(&candidate), GeminiAuthType::Generic);
                assert!(!is_google_official_gemini(&candidate));
            }
        }
    }

    #[test]
    fn gemini_auth_explicit_api_settings_override_official_hints() {
        for settings in [
            json!({"env": {"GEMINI_API_KEY": "synthetic-key"}}),
            json!({"env": {"GOOGLE_API_KEY": "legacy-key"}}),
            json!({"env": {"GOOGLE_GEMINI_BASE_URL": "https://proxy.invalid"}}),
            json!({"env": {"GEMINI_API_KEY": ""}}),
            json!({"env": {"GOOGLE_GENAI_USE_VERTEXAI": "true"}}),
            json!({"config": {"security": {"auth": {"selectedType": "gemini-api-key"}}}}),
            json!({"config": {"security": {"auth": {"selectedType": "vertex-ai"}}}}),
            json!({
                "env": {"GEMINI_API_KEY": "synthetic-key"},
                "config": {"security": {"auth": {"selectedType": "oauth-personal"}}}
            }),
        ] {
            for marker in [None, Some("GOOGLE-OFFICIAL")] {
                let mut candidate = provider("Google Official", settings.clone());
                candidate.category = Some("official".to_string());
                candidate.meta = marker.map(|key| ProviderMeta {
                    partner_promotion_key: Some(key.to_string()),
                    ..Default::default()
                });
                assert_eq!(detect_gemini_auth_type(&candidate), GeminiAuthType::Generic);
                assert!(!is_google_official_gemini(&candidate));
            }
        }
    }

    #[test]
    fn gemini_auth_name_alone_does_not_select_oauth() {
        for category in [None, Some("custom"), Some("aggregator")] {
            let mut candidate = provider("Google proxy", json!({"env": {}}));
            candidate.category = category.map(str::to_string);
            assert_eq!(detect_gemini_auth_type(&candidate), GeminiAuthType::Generic);
        }
    }

    #[test]
    fn gemini_auth_official_marker_survives_renaming() {
        let mut candidate = provider("工作账号", json!({"env": {}}));
        candidate.meta = Some(ProviderMeta {
            partner_promotion_key: Some("GOOGLE-OFFICIAL".to_string()),
            ..Default::default()
        });
        assert_eq!(
            detect_gemini_auth_type(&candidate),
            GeminiAuthType::GoogleOfficial
        );
        assert!(is_google_official_gemini(&candidate));
    }

    #[test]
    fn gemini_auth_legacy_official_preset_without_api_settings_keeps_oauth() {
        for name in ["Google", "Google Official"] {
            let mut candidate = provider(
                name,
                json!({"env": {}, "config": {"security": {"auth": {
                    "selectedType": "oauth-personal"
                }}}}),
            );
            candidate.category = Some("official".to_string());
            assert_eq!(
                detect_gemini_auth_type(&candidate),
                GeminiAuthType::GoogleOfficial
            );
        }
    }

    #[test]
    fn gemini_auth_packycode_marker_still_uses_api_key() {
        let mut candidate = provider("Google proxy", json!({"env": {}}));
        candidate.meta = Some(ProviderMeta {
            partner_promotion_key: Some("packycode".to_string()),
            ..Default::default()
        });
        assert_eq!(
            detect_gemini_auth_type(&candidate),
            GeminiAuthType::Packycode
        );
    }
}
