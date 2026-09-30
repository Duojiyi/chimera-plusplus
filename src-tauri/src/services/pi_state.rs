// Adapted from farion1231/cc-switch src-tauri/src/services/pi_state.rs (MIT)
//! Read-only Pi provider membership and global default reference.

use crate::error::AppError;
use crate::pi_config::{read_pi_default_provider, read_pi_native_providers};
use crate::store::AppState;
use serde::Serialize;

const PI_APP: &str = "pi";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiCurrentState {
    /// Keys present in `models.json` (the "enabled" entries).
    pub enabled_provider_ids: Vec<String>,
    /// Pi's own `settings.json` default, shown as advice only.
    pub default_provider_id: Option<String>,
}

pub(crate) struct PiStateService;

impl PiStateService {
    pub(crate) fn current(state: &AppState) -> Result<PiCurrentState, AppError> {
        let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app(PI_APP));
        let enabled_provider_ids = read_pi_native_providers()?.keys().cloned().collect();
        let default_provider_id = read_pi_default_provider().unwrap_or_else(|error| {
            log::warn!("Failed to read Pi global default provider for advisory UI: {error}");
            None
        });
        Ok(PiCurrentState {
            enabled_provider_ids,
            default_provider_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use crate::pi_config::test_support::TestAgentDir;
    use serial_test::serial;
    use std::fs;
    use std::sync::Arc;

    fn write_models() {
        let models_path = crate::pi_config::get_pi_models_path().expect("models path");
        fs::create_dir_all(models_path.parent().expect("models directory"))
            .expect("create models directory");
        fs::write(
            models_path,
            r#"{
                "providers": {
                    "managed": { "name": "Managed", "models": [{ "id": "model-a" }] },
                    "native-oauth": { "oauth": "example" },
                    "anthropic": {}
                }
            }"#,
        )
        .expect("write models");
    }

    #[test]
    #[serial]
    fn state_exposes_every_explicit_provider_node() {
        let _agent = TestAgentDir::new();
        let state = AppState::new(Arc::new(Database::memory().expect("memory db")));
        write_models();
        let settings_path = crate::pi_config::get_pi_settings_path().expect("settings path");
        fs::write(
            &settings_path,
            r#"{"defaultProvider":"managed","defaultModel":"model-a"}"#,
        )
        .expect("write settings");

        let current = PiStateService::current(&state).expect("read state");
        assert_eq!(
            current.enabled_provider_ids,
            vec!["managed", "native-oauth", "anthropic"]
        );
        assert_eq!(current.default_provider_id.as_deref(), Some("managed"));
        // Reading state never rewrites Pi's own settings.
        assert_eq!(
            fs::read_to_string(settings_path).expect("read settings"),
            r#"{"defaultProvider":"managed","defaultModel":"model-a"}"#
        );
    }

    #[test]
    #[serial]
    fn invalid_global_settings_do_not_hide_provider_membership() {
        let _agent = TestAgentDir::new();
        let state = AppState::new(Arc::new(Database::memory().expect("memory db")));
        write_models();
        fs::write(
            crate::pi_config::get_pi_settings_path().expect("settings path"),
            "[]",
        )
        .expect("write invalid settings");

        let current = PiStateService::current(&state).expect("read membership");
        assert_eq!(current.enabled_provider_ids.len(), 3);
        assert_eq!(current.default_provider_id, None);
    }
}
