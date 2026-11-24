// Adapted from farion1231/cc-switch src-tauri/src/commands/pi.rs (MIT)
use crate::app_config::AppType;

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
