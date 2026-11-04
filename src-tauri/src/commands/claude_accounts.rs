//! Claude Code saved-login switching and Claude Desktop profiles.

use std::path::PathBuf;

use tauri::State;

use crate::claude_accounts::code::browser_login::{self, LoginPoll};
use crate::claude_accounts::code::transfer::{self, ImportReport};
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

// ===== Claude login files and browser authorization =====

/// What an export wrote. The file holds live tokens.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLoginExport {
    pub path: String,
    pub count: usize,
    /// Saved logins left out because they lack the account block the format needs.
    pub skipped: usize,
}

/// Writes saved logins (all, or the given ids) to a JSON file the user picks.
/// `None` when the save dialog was cancelled.
#[tauri::command]
pub async fn export_claude_logins<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    ids: Option<Vec<String>>,
) -> Result<Option<ClaudeLoginExport>, AppError> {
    use tauri_plugin_dialog::DialogExt;
    for id in ids.iter().flatten() {
        crate::claude_accounts::validate_account_id(id)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        let exported = transfer::export_in(&vault, ids.as_deref())?;
        let file_name = format!(
            "chimera-claude-logins-{}.json",
            chrono::Local::now().format("%Y%m%d")
        );
        let selected = app
            .dialog()
            .file()
            .set_title("导出 Claude 登录凭证（文件里是明文令牌）")
            .add_filter("JSON", &["json"])
            .set_file_name(&file_name)
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|e| AppError::Message(format!("无效的保存位置: {e}")))?;
        crate::config::atomic_write_checked::<AppError, _>(
            &path,
            exported.json.as_bytes(),
            true,
            || Ok(()),
        )?;
        Ok(Some(ClaudeLoginExport {
            path: path.display().to_string(),
            count: exported.count,
            skipped: exported.skipped,
        }))
    })
    .await
    .map_err(unfinished)?
}

/// Reads a login file (claude-swap's export, or Claude Code's
/// `.credentials.json`) the user picks. `None` when the dialog was cancelled.
#[tauri::command]
pub async fn import_claude_logins<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<ImportReport>, AppError> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("导入 Claude 登录凭证")
            .add_filter("JSON", &["json"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|e| AppError::Message(format!("无效的文件位置: {e}")))?;
        let bytes = crate::security_limits::read_limited(&path, transfer::MAX_IMPORT_BYTES)
            .map_err(|e| {
                AppError::Message(format!("无法读取这个文件（需要 8 MiB 以内的 JSON）: {e}"))
            })?;
        let text = String::from_utf8(bytes)
            .map_err(|_| AppError::Message("这个文件不是 UTF-8 文本".to_string()))?;
        let vault = CodeVault::open_default()?;
        transfer::import_in(&vault, &text).map(Some)
    })
    .await
    .map_err(unfinished)?
}

/// Opens the claude.ai authorization in the browser (and a console window for
/// the pasted login code) and returns the flow id to poll.
#[tauri::command]
pub async fn begin_claude_browser_login() -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        let vault = CodeVault::open_default()?;
        let cli = super::misc::resolve_path_default("claude").ok_or_else(|| {
            AppError::Message(
                "没有找到 claude 命令。请先安装 Claude Code，并确认在终端里能运行 claude。"
                    .to_string(),
            )
        })?;
        browser_login::begin(&vault, &cli)
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn poll_claude_browser_login(id: String) -> Result<LoginPoll, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        browser_login::poll(&vault, &id)
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn cancel_claude_browser_login(id: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        browser_login::cancel(&vault, &id)
    })
    .await
    .map_err(unfinished)?
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
