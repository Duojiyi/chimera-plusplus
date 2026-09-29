//! Per-tool environment-variable allowlist for untrusted imports (MH-4, D9).
//!
//! An imported provider may carry an `env` block that the tool later exports
//! into its own process. A deny list alone is never complete, so the policy
//! is an allowlist per tool:
//!
//! - keys on the tool's allowlist are imported as-is;
//! - any other key is imported only after the user confirms that exact key;
//! - keys on the deny list (loader, TLS trust, proxy and shell hooks) are
//!   never imported, not even when confirmed. This is defense in depth.
//!
//! Deep-link import uses this today. SQL / `.db` import (MH-13b) and
//! cc-switch import (M2.1) are meant to reuse the same functions.

use crate::app_config::AppType;
use serde::Serialize;
use serde_json::{Map, Value};

/// Verdict for one environment-variable key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EnvKeyStatus {
    /// On the tool's allowlist.
    Allowed,
    /// Not on the allowlist; imported only when the user confirms this key.
    NeedsConfirmation,
    /// On the deny list; never imported.
    Denied,
}

/// Keys the Claude family reads from `settings.json` `env`, as used by the
/// bundled provider presets.
const CLAUDE_ENV_ALLOWLIST: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "API_TIMEOUT_MS",
    "AWS_ACCESS_KEY_ID",
    "AWS_REGION",
    "AWS_SECRET_ACCESS_KEY",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLAUDE_CODE_USE_BEDROCK",
    "ENABLE_TOOL_SEARCH",
];

/// Keys Gemini CLI reads from `~/.gemini/.env`.
const GEMINI_ENV_ALLOWLIST: &[&str] = &[
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "GOOGLE_GEMINI_BASE_URL",
];

/// Keys Codex reads from `auth.json`.
const CODEX_ENV_ALLOWLIST: &[&str] = &["OPENAI_API_KEY"];

/// Exact keys (case-insensitive) that change what code a process loads, what
/// certificates it trusts, where all of its traffic goes, or how a shell
/// starts. No provider needs to set them through an import.
const DENIED_ENV_KEYS: &[&str] = &[
    "ALL_PROXY",
    "BASH_ENV",
    "CLAUDE_CODE_SHELL_PREFIX",
    "CLAUDE_CONFIG_DIR",
    "COMSPEC",
    "CURL_CA_BUNDLE",
    "ENV",
    "GIT_SSH_COMMAND",
    "HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "IFS",
    "JAVA_TOOL_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "PATH",
    "PATHEXT",
    "PERL5OPT",
    "PROMPT_COMMAND",
    "PSMODULEPATH",
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "REQUESTS_CA_BUNDLE",
    "RUBYOPT",
    "SHELL",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "USERPROFILE",
    "ZDOTDIR",
];

/// Prefixes (case-insensitive) of dynamic-loader controls.
const DENIED_ENV_PREFIXES: &[&str] = &["LD_", "DYLD_"];

/// The allowlist for one tool. Tools whose provider config has no `env`
/// block get an empty list, so every key there needs confirmation.
pub fn allowed_env_keys(app: &AppType) -> &'static [&'static str] {
    match app {
        AppType::Claude | AppType::ClaudeDesktop => CLAUDE_ENV_ALLOWLIST,
        AppType::Gemini => GEMINI_ENV_ALLOWLIST,
        AppType::Codex => CODEX_ENV_ALLOWLIST,
        AppType::GrokBuild | AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => &[],
    }
}

/// Tool-independent deny list.
pub fn is_denied_env_key(key: &str) -> bool {
    let key = key.trim();
    DENIED_ENV_KEYS
        .iter()
        .any(|denied| key.eq_ignore_ascii_case(denied))
        || DENIED_ENV_PREFIXES.iter().any(|prefix| {
            key.get(..prefix.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        })
}

/// Classify one key for one tool. The deny list wins over the allowlist.
pub fn classify_env_key(app: &AppType, key: &str) -> EnvKeyStatus {
    if is_denied_env_key(key) {
        EnvKeyStatus::Denied
    } else if allowed_env_keys(app).contains(&key) {
        EnvKeyStatus::Allowed
    } else {
        EnvKeyStatus::NeedsConfirmation
    }
}

/// Drop every key that is denied, or neither allowlisted nor confirmed by
/// the user. Returns the removed keys, sorted, so callers can report them
/// (names only, never values).
pub fn retain_permitted_env(
    app: &AppType,
    env: &mut Map<String, Value>,
    confirmed_keys: &[String],
) -> Vec<String> {
    let mut removed = Vec::new();
    env.retain(|key, _| {
        let keep = match classify_env_key(app, key) {
            EnvKeyStatus::Allowed => true,
            EnvKeyStatus::NeedsConfirmation => confirmed_keys.iter().any(|c| c == key),
            EnvKeyStatus::Denied => false,
        };
        if !keep {
            removed.push(key.clone());
        }
        keep
    });
    removed.sort();
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deny_list_wins_and_is_case_insensitive() {
        for key in [
            "LD_PRELOAD",
            "ld_library_path",
            "DYLD_INSERT_LIBRARIES",
            "NODE_OPTIONS",
            "node_extra_ca_certs",
            "HTTPS_PROXY",
            "http_proxy",
            "PATH",
            "Path",
            "BASH_ENV",
        ] {
            assert!(is_denied_env_key(key), "{key}");
            assert_eq!(
                classify_env_key(&AppType::Claude, key),
                EnvKeyStatus::Denied
            );
        }
        for key in [
            "ANTHROPIC_BASE_URL",
            "NODE",
            "LD",
            "OPENAI_API_KEY",
            "MY_PATH",
        ] {
            assert!(!is_denied_env_key(key), "{key}");
        }
    }

    #[test]
    fn allowlist_is_per_tool() {
        assert_eq!(
            classify_env_key(&AppType::Claude, "ANTHROPIC_AUTH_TOKEN"),
            EnvKeyStatus::Allowed
        );
        assert_eq!(
            classify_env_key(&AppType::Gemini, "ANTHROPIC_AUTH_TOKEN"),
            EnvKeyStatus::NeedsConfirmation
        );
        assert_eq!(
            classify_env_key(&AppType::Gemini, "GEMINI_API_KEY"),
            EnvKeyStatus::Allowed
        );
        assert_eq!(
            classify_env_key(&AppType::Claude, "SOME_VENDOR_FLAG"),
            EnvKeyStatus::NeedsConfirmation
        );
    }

    #[test]
    fn retain_keeps_allowed_and_confirmed_but_never_denied() {
        let mut env = json!({
            "ANTHROPIC_AUTH_TOKEN": "sk",
            "VENDOR_FLAG": "1",
            "OTHER_FLAG": "1",
            "NODE_OPTIONS": "--require /tmp/x.js"
        })
        .as_object()
        .cloned()
        .unwrap();
        let removed = retain_permitted_env(
            &AppType::Claude,
            &mut env,
            &["VENDOR_FLAG".to_string(), "NODE_OPTIONS".to_string()],
        );
        assert_eq!(removed, ["NODE_OPTIONS", "OTHER_FLAG"]);
        let mut kept = env.keys().cloned().collect::<Vec<_>>();
        kept.sort();
        assert_eq!(kept, ["ANTHROPIC_AUTH_TOKEN", "VENDOR_FLAG"]);
    }
}
