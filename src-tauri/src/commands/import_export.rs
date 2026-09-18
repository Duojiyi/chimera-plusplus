#![allow(non_snake_case)]

use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::commands::sync_support::{
    post_import_warning, replace_database, run_post_import_sync, success_payload_with_warning,
    with_stopped_proxy,
};
use crate::database::backup::BackupEntry;
use crate::database::Database;
use crate::error::AppError;
use crate::store::AppState;

// ─── File import/export ──────────────────────────────────────

/// 导出数据库为 SQL 备份
#[tauri::command]
pub async fn export_config_to_file(
    #[allow(non_snake_case)] filePath: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target_path = PathBuf::from(&filePath);
        db.export_sql(&target_path)?;
        Ok::<_, AppError>(json!({
            "success": true,
            "message": "SQL exported successfully",
            "filePath": filePath
        }))
    })
    .await
    .map_err(|e| format!("导出配置失败: {e}"))?
    .map_err(|e: AppError| e.to_string())
}

/// 从 SQL 备份导入数据库
#[tauri::command]
pub async fn import_config_from_file(
    #[allow(non_snake_case)] filePath: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_stopped_proxy(&state, || {
            let backup_id =
                replace_database(&state, || state.db.import_sql(&PathBuf::from(filePath)))?;
            let warning = post_import_warning(&state);
            Ok(success_payload_with_warning(backup_id, warning))
        })
    })
    .await
    .map_err(|e| format!("导入配置失败: {e}"))?
    .map_err(|e: AppError| e.to_string())
}

#[tauri::command]
pub async fn sync_current_providers_live(state: State<'_, AppState>) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_stopped_proxy(&state, || {
            run_post_import_sync(&state)?;
            Ok(json!({
                "success": true,
                "message": "Live configuration synchronized"
            }))
        })
    })
    .await
    .map_err(|e| format!("同步当前供应商失败: {e}"))?
    .map_err(|e: AppError| e.to_string())
}

fn restore_outcome(backup_id: String, warning: Option<String>) -> Result<String, Value> {
    match warning {
        None => Ok(backup_id),
        Some(warning) => Err(json!({
            "dbRestored": true,
            "backupId": backup_id,
            "warning": warning,
            "message": format!("数据库已恢复，但 Live/运行态同步未完成（部分成功）。请关闭代理接管后重新应用当前供应商并同步 Live 配置，不要重复恢复。安全备份 ID: {backup_id}。{warning}")
        })),
    }
}

// ─── File dialogs ────────────────────────────────────────────

/// 保存文件对话框
#[tauri::command]
pub async fn save_file_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    #[allow(non_snake_case)] defaultName: String,
) -> Result<Option<String>, String> {
    let dialog = app.dialog();
    let result = dialog
        .file()
        .add_filter("SQL", &["sql"])
        .set_file_name(&defaultName)
        .blocking_save_file();

    Ok(result.map(|p| p.to_string()))
}

/// 打开文件对话框
#[tauri::command]
pub async fn open_file_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, String> {
    let dialog = app.dialog();
    let result = dialog
        .file()
        .add_filter("SQL", &["sql"])
        .blocking_pick_file();

    Ok(result.map(|p| p.to_string()))
}

/// 打开 ZIP 文件选择对话框
#[tauri::command]
pub async fn open_zip_file_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, String> {
    let dialog = app.dialog();
    let result = dialog
        .file()
        .add_filter("ZIP / Skill", &["zip", "skill"])
        .blocking_pick_file();

    Ok(result.map(|p| p.to_string()))
}

// ─── Database backup management ─────────────────────────────

/// Manually create a database backup
#[tauri::command]
pub async fn create_db_backup(state: State<'_, AppState>) -> Result<String, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || match db.backup_database_file()? {
        Some(path) => Ok(path
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default()),
        None => Err(AppError::Config(
            "Database file not found, backup skipped".to_string(),
        )),
    })
    .await
    .map_err(|e| format!("Backup failed: {e}"))?
    .map_err(|e: AppError| e.to_string())
}

/// List all database backup files
#[tauri::command]
pub fn list_db_backups() -> Result<Vec<BackupEntry>, String> {
    Database::list_backups().map_err(|e| e.to_string())
}

/// Restore database from a backup file
#[tauri::command]
pub async fn restore_db_backup(
    state: State<'_, AppState>,
    filename: String,
) -> Result<String, Value> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_stopped_proxy(&state, || {
            let backup_id = replace_database(&state, || state.db.restore_from_backup(&filename))?;
            Ok(restore_outcome(backup_id, post_import_warning(&state)))
        })
        .map_err(|e| Value::String(e.to_string()))?
    })
    .await
    .map_err(|e| Value::String(format!("Restore failed: {e}")))?
}

/// Rename a database backup file
#[tauri::command]
pub fn rename_db_backup(
    #[allow(non_snake_case)] oldFilename: String,
    #[allow(non_snake_case)] newName: String,
) -> Result<String, String> {
    Database::rename_backup(&oldFilename, &newName).map_err(|e| e.to_string())
}

/// Delete a database backup file
#[tauri::command]
pub fn delete_db_backup(filename: String) -> Result<(), String> {
    Database::delete_backup(&filename).map_err(|e| e.to_string())
}

#[cfg(test)]
mod backup_restore_tests {
    use super::restore_outcome;

    #[test]
    fn complete_restore_keeps_the_legacy_safety_backup_id() {
        assert_eq!(restore_outcome("safety".into(), None), Ok("safety".into()));
        assert_eq!(restore_outcome(String::new(), None), Ok(String::new()));
    }

    #[test]
    fn post_sync_failure_is_an_explicit_partial_restore() {
        let error = restore_outcome("safety".into(), Some("Live write failed".into())).unwrap_err();
        assert_eq!(error["dbRestored"], true);
        assert_eq!(error["backupId"], "safety");
        assert_eq!(error["warning"], "Live write failed");
        assert!(error["message"].as_str().unwrap().contains("不要重复恢复"));
    }
}
