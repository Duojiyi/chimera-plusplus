//! Commands for importing lines from a legacy cc-switch `config.json`.
//! Classification, safety checks and writes live in `services::cc_switch_import`.
use crate::services::cc_switch_import::{
    self as service, ImportInventory, ImportReceipt, ImportSelection,
};
use crate::store::AppState;
use tauri::State;

/// `AppState` names the preview slot through this path.
pub use crate::services::cc_switch_import::CcSwitchPreviewSession;

#[tauri::command]
pub async fn preview_cc_switch_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<ImportInventory, String> {
    crate::product_policy::require(crate::product_policy::Capability::Providers)
        .map_err(|_| "IMPORT_PREVIEW_UNAVAILABLE")?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service::preview(&state, path))
        .await
        .map_err(|_| "IMPORT_PREVIEW_FAILED".to_string())?
}

#[tauri::command]
pub async fn commit_cc_switch_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    preview_id: String,
    selections: Vec<ImportSelection>,
) -> Result<ImportReceipt, String> {
    crate::product_policy::require(crate::product_policy::Capability::CcSwitchImport)
        .map_err(|_| "IMPORT_COMMIT_UNAVAILABLE")?;
    let state = state.inner().clone();
    let guards = service::lock_for_commit(&state, &selections).await;
    let receipt = tauri::async_runtime::spawn_blocking(move || {
        let _guards = guards;
        service::commit(&state, &preview_id, &selections)
    })
    .await
    .map_err(|_| "IMPORT_COMMIT_FAILED".to_string())??;
    // The tray lists every line, including the new inactive ones.
    crate::tray::refresh_tray_menu(&app);
    Ok(receipt)
}
