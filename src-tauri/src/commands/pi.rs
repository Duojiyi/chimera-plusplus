// Adapted from farion1231/cc-switch src-tauri/src/commands/pi.rs (MIT)
use crate::app_config::AppType;
use crate::services::pi_state::{PiCurrentState, PiStateService};
use crate::store::AppState;
use tauri::State;

/// Which Pi providers are in `models.json`, plus Pi's own default (advisory).
#[tauri::command]
pub(crate) fn get_pi_current_state(state: State<'_, AppState>) -> Result<PiCurrentState, String> {
    crate::product_policy::require_app(&AppType::Pi)?;
    PiStateService::current(state.inner()).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn get_pi_document(kind: String) -> Result<crate::pi_config::PiDocument, String> {
    crate::product_policy::require_app(&AppType::Pi)?;
    let _operation = super::pi_plugins::lock_package_operation()?;
    crate::pi_config::read_management_document(&kind).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn save_pi_document(
    kind: String,
    value: serde_json::Value,
    expected_revision: String,
) -> Result<crate::pi_config::PiDocument, String> {
    crate::product_policy::require_app(&AppType::Pi)?;
    let _operation = super::pi_plugins::lock_package_operation()?;
    crate::pi_config::save_management_document(&kind, value, &expected_revision)
        .map_err(|error| error.to_string())
}
