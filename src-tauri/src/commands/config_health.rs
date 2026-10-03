use crate::config_health::{self, HealthReport};
use crate::product_policy::{self, Capability};

#[tauri::command]
pub async fn check_codex_config_health() -> Result<HealthReport, String> {
    product_policy::require(Capability::ConfigHealth).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(config_health::check)
        .await
        .map_err(|_| "配置体检任务执行失败，请重试。".to_string())
}

#[tauri::command]
pub async fn repair_codex_owned_instruction_refs(
    expected_token: String,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<HealthReport, String> {
    product_policy::require(Capability::ConfigHealth).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        config_health::repair_owned_instruction_refs(&state, &expected_token)
    })
    .await
    .map_err(|_| "配置修复任务执行失败，请重新检查。".to_string())?
    .map_err(|_| "配置修复未确认完成，请检查接管状态并重新体检。".to_string())
}
