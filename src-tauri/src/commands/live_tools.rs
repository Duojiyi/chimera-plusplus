//! Multi-tool live-config commands (plan §2 M2.1, M2.0b ③). Every command
//! here is a v2.8.0 entry point behind its capability.

use std::str::FromStr;

use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::app_config::AppType;
use crate::error::AppError;
use crate::product_policy::{self, Capability};
use crate::services::live_backup::{
    self, LiveBackupReason, LiveBackupRestoreResult, LiveBackupSummary,
};
use crate::store::AppState;

/// Parses the app and applies the capability plus the per-app `multi_tool`
/// gate (Codex always passes the latter).
fn gated_app(capability: Capability, app: &str) -> Result<AppType, AppError> {
    product_policy::require(capability)?;
    let app = AppType::from_str(app)?;
    product_policy::require_app(&app)?;
    Ok(app)
}

async fn run_blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| format!("后台任务执行失败: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_live_backups(app: String) -> Result<Vec<LiveBackupSummary>, String> {
    let app = gated_app(Capability::LiveBackups, &app).map_err(String::from)?;
    run_blocking(move || live_backup::list_backups(&app)).await
}

#[tauri::command]
pub async fn open_live_backup_directory(handle: AppHandle, app: String) -> Result<(), String> {
    let app = gated_app(Capability::LiveBackups, &app).map_err(String::from)?;
    let directory = run_blocking(move || live_backup::prepare_backup_dir(&app)).await?;
    handle
        .opener()
        .open_path(directory.to_string_lossy().to_string(), None::<String>)
        .map_err(|_| "无法打开备份目录，请检查本机文件管理器。".to_string())
}

/// Returns `None` when the tool has no live file to back up.
#[tauri::command]
pub async fn create_live_backup(
    state: State<'_, AppState>,
    app: String,
) -> Result<Option<LiveBackupSummary>, String> {
    let app = gated_app(Capability::LiveBackups, &app).map_err(String::from)?;
    let state = state.inner().clone();
    run_blocking(move || {
        // Manual snapshots must not interleave with this app's managed writes.
        // Service callers that already hold this lock keep using create_backup directly.
        let _guard =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app(app.as_str()));
        live_backup::create_backup(&state.db, &app, LiveBackupReason::Manual)
    })
    .await
}

#[tauri::command]
pub async fn restore_live_backup(
    state: State<'_, AppState>,
    app: String,
    id: String,
) -> Result<LiveBackupRestoreResult, String> {
    let app = gated_app(Capability::LiveBackups, &app).map_err(String::from)?;
    let state = state.inner().clone();
    run_blocking(move || live_backup::restore_backup(&state, &app, &id)).await
}

#[tauri::command]
pub async fn delete_live_backup(app: String, id: String) -> Result<(), String> {
    let app = gated_app(Capability::LiveBackups, &app).map_err(String::from)?;
    run_blocking(move || live_backup::delete_backup(&app, &id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_capability_rejection(result: Result<AppType, AppError>) -> bool {
        matches!(
            result,
            Err(AppError::Localized {
                key: "capability.disabled",
                ..
            })
        )
    }

    #[test]
    fn live_backup_commands_are_available_when_the_capability_is_enabled() {
        assert!(Capability::LiveBackups.enabled());
        for app in AppType::all() {
            assert!(
                !is_capability_rejection(gated_app(Capability::LiveBackups, app.as_str())),
                "{}",
                app.as_str()
            );
        }
    }
}
