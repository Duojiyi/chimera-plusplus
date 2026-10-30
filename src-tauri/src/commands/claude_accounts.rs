//! Claude Code saved-login switching and Claude Desktop profiles.

use std::path::PathBuf;

use tauri::State;

use crate::claude_accounts::code::{
    self, CodeAccountDto, CodeAccountsDto, CodeVault, LivePaths, SwitchOutcome,
};
use crate::claude_accounts::desktop::{self, DesktopProfileDto};
use crate::claude_accounts::quota::{self, DesktopQuotaDto, QuotaView};
use crate::error::AppError;
use crate::store::AppState;

fn unfinished(_: tauri::Error) -> AppError {
    AppError::Message("后台任务未完成，请重试".to_string())
}

// ===== Claude Code =====

#[tauri::command]
pub async fn list_claude_code_accounts() -> Result<CodeAccountsDto, AppError> {
    tauri::async_runtime::spawn_blocking(|| -> Result<CodeAccountsDto, AppError> {
        let vault = CodeVault::open_default()?;
        Ok(code::list_in(&vault, &LivePaths::current()))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn save_current_claude_code_login(
    name: Option<String>,
) -> Result<CodeAccountDto, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        code::save_current_in(&vault, &LivePaths::current(), name.as_deref())
    })
    .await
    .map_err(unfinished)?
}

/// `allow_running`: the user confirmed switching although a Claude Code
/// process is running (it may write the old login back).
#[tauri::command]
pub async fn switch_claude_code_account(
    id: String,
    allow_running: bool,
) -> Result<SwitchOutcome, AppError> {
    crate::claude_accounts::validate_account_id(&id)?;
    // Never overlap a token refresh of the same account.
    let lock = code::account_lock(&id);
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        code::switch_in(
            &vault,
            &LivePaths::current(),
            &id,
            allow_running,
            crate::claude_accounts::claude_code_running,
        )
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn rename_claude_code_account(id: String, name: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        code::rename_in(&vault, &id, &name)
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn delete_claude_code_account(id: String) -> Result<(), AppError> {
    crate::claude_accounts::validate_account_id(&id)?;
    let lock = code::account_lock(&id);
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        code::delete_in(&vault, &id)
    })
    .await
    .map_err(unfinished)?
}

/// `force`: a manual refresh; otherwise a reading less than five minutes old
/// is reused.
#[tauri::command]
pub async fn get_claude_code_account_quota(id: String, force: bool) -> Result<QuotaView, AppError> {
    quota::account_quota(id, force).await
}

// ===== Claude Desktop =====

#[tauri::command]
pub async fn list_claude_desktop_profiles() -> Result<Vec<DesktopProfileDto>, AppError> {
    tauri::async_runtime::spawn_blocking(desktop::list)
        .await
        .map_err(unfinished)?
}

/// Plan and quota of a Claude Desktop account (`default` = the app's own
/// data folder), read with its sign-in but never refreshing it.
#[tauri::command]
pub async fn get_claude_desktop_profile_quota(
    id: String,
    force: bool,
) -> Result<DesktopQuotaDto, AppError> {
    quota::desktop_quota(id, force).await
}

#[tauri::command]
pub async fn create_claude_desktop_profile(name: String) -> Result<DesktopProfileDto, AppError> {
    tauri::async_runtime::spawn_blocking(move || desktop::create(&name))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn rename_claude_desktop_profile(
    id: String,
    name: String,
) -> Result<DesktopProfileDto, AppError> {
    tauri::async_runtime::spawn_blocking(move || desktop::rename(&id, &name))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn delete_claude_desktop_profile(id: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || desktop::delete(&id))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn launch_claude_desktop_profile(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Same installation detection as the Claude Desktop page.
        let installation = crate::claude_desktop_config::get_status(&db, false)
            .ok()
            .and_then(|status| status.installation_path)
            .map(PathBuf::from);
        desktop::launch(&id, installation)
    })
    .await
    .map_err(unfinished)?
}
