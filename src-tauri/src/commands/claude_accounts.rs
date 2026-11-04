//! Claude Code saved-login switching and Claude Desktop profiles.

use std::path::{Path, PathBuf};

use tauri::State;

use crate::claude_accounts::code::bindings::{self, BindingDto};
use crate::claude_accounts::code::browser_login::{self, LoginPoll};
use crate::claude_accounts::code::manage;
use crate::claude_accounts::code::sessions;
use crate::claude_accounts::code::transfer::{self, ImportReport};
use crate::claude_accounts::code::{
    self, CodeAccountDto, CodeAccountsDto, CodeVault, LivePaths, SwitchOutcome,
};
use crate::claude_accounts::desktop::{self, DesktopProfileDto};
use crate::claude_accounts::desktop_swap;
use crate::claude_accounts::quota::{self, DesktopQuotaDto, QuotaView};
use crate::claude_accounts::usage::{self, UsageOverview};
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
        code::delete_in(&vault, &id)?;
        // Its Claude Desktop sign-in snapshot goes with it.
        desktop_swap::remove_snapshot(&vault, &id)
    })
    .await
    .map_err(unfinished)?
}

/// Saves a pasted setup-token (`claude setup-token`) or Console API key as an
/// account. Nothing is sent anywhere to check it.
#[tauri::command]
pub async fn add_claude_secret_account(
    name: Option<String>,
    secret: String,
) -> Result<CodeAccountDto, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        manage::add_secret_in(&vault, name.as_deref(), &secret)
    })
    .await
    .map_err(unfinished)?
}

/// Holds a saved login out of use, or puts it back.
#[tauri::command]
pub async fn set_claude_account_disabled(id: String, disabled: bool) -> Result<(), AppError> {
    crate::claude_accounts::validate_account_id(&id)?;
    let lock = code::account_lock(&id);
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        manage::set_disabled_in(&vault, &LivePaths::current(), &id, disabled)
    })
    .await
    .map_err(unfinished)?
}

/// Puts the listed logins first, in the given order.
#[tauri::command]
pub async fn reorder_claude_accounts(ids: Vec<String>) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        manage::reorder_in(&vault, &ids)
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

// ===== Parallel sessions and bound folders =====

/// The result of starting Claude in a terminal.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLaunch {
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub dir: Option<String>,
    /// The folder's binding chose the account.
    pub via_binding: bool,
    /// The account is the login Claude Code already uses, so a plain
    /// terminal was opened instead of a session folder.
    pub uses_default_login: bool,
}

/// How to start `claude` on a login's session folder from a shell that is
/// already open.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCommands {
    pub dir: String,
    pub cmd: String,
    pub powershell: String,
}

fn checked_folder(raw: &str) -> Result<PathBuf, AppError> {
    let (_, display) = bindings::check_path(raw)?;
    let path = PathBuf::from(display);
    if !path.is_dir() {
        return Err(AppError::InvalidInput("这个目录不存在".to_string()));
    }
    Ok(path)
}

/// In a double-quoted batch value only `%` needs care (`"` cannot be in a
/// Windows path, and delayed expansion is off).
fn batch_quoted(path: &Path) -> String {
    path.to_string_lossy().replace('%', "%%")
}

/// The batch file that starts `claude`: on a session folder (clearing the
/// variables that would override its login, and keeping `.session.lock` open
/// for as long as `claude` runs), or plain.
pub(crate) fn session_script(config_dir: Option<&Path>, cwd: Option<&Path>) -> String {
    let mut lines = vec!["@echo off".to_string(), "chcp 65001 >nul".to_string()];
    if let Some(dir) = config_dir {
        for name in sessions::AUTH_OVERRIDE_ENV {
            lines.push(format!("set \"{name}=\""));
        }
        lines.push(format!("set \"CLAUDE_CONFIG_DIR={}\"", batch_quoted(dir)));
    }
    if let Some(cwd) = cwd {
        let text = batch_quoted(cwd);
        lines.push(if text.starts_with(r"\\") {
            // `cd` cannot make a UNC path current; `pushd` maps it first.
            format!("pushd \"{text}\" || exit /b 1")
        } else {
            format!("cd /d \"{text}\" || exit /b 1")
        });
    }
    match config_dir {
        Some(dir) => lines.push(format!(
            "(call claude) 9>\"{}\"",
            batch_quoted(&sessions::lock_path(dir))
        )),
        None => lines.push("call claude".to_string()),
    }
    lines.push("del \"%~f0\" >nul 2>&1".to_string());
    lines.push("rmdir \"%~dp0\" >nul 2>&1".to_string());
    lines.join("\r\n") + "\r\n"
}

#[cfg(windows)]
fn launch_session_script(script: &str) -> Result<(), AppError> {
    use std::io::Write;
    // A directory only this user can enter holds the script; the script
    // removes it when `claude` ends.
    let launch_dir = tempfile::Builder::new()
        .prefix("chimera-launch-")
        .tempdir()
        .map_err(|e| AppError::Message(format!("创建临时目录失败: {e}")))?
        .keep();
    let bat = launch_dir.join("session.bat");
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&bat)
        .and_then(|mut file| file.write_all(script.as_bytes()));
    let result = written
        .map_err(|e| AppError::Message(format!("写入启动脚本失败: {e}")))
        .and_then(|()| {
            super::misc::run_script_in_preferred_terminal(&bat).map_err(AppError::Message)
        });
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&launch_dir);
    }
    result
}

#[cfg(not(windows))]
fn launch_session_script(_script: &str) -> Result<(), AppError> {
    Err(AppError::Message(
        "并行会话目前只支持 Windows。可以用「复制启动命令」在自己的终端里使用。".to_string(),
    ))
}

/// Opens a terminal running `claude`: for a saved login (its own session
/// folder), for a folder (the login bound to it, else the default login), or
/// both. Only a login's session folder is touched, never the live login.
#[tauri::command]
pub async fn open_claude_session(
    id: Option<String>,
    dir: Option<String>,
) -> Result<SessionLaunch, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        if id.is_none() && dir.is_none() {
            return Err(AppError::InvalidInput("请选择账号或目录".to_string()));
        }
        if let Some(id) = &id {
            crate::claude_accounts::validate_account_id(id)?;
        }
        let cwd = dir.as_deref().map(checked_folder).transpose()?;
        let vault = CodeVault::open_default()?;
        let paths = LivePaths::current();
        let mut via_binding = false;
        let account_id = match (id, &cwd) {
            (Some(id), _) => Some(id),
            (None, Some(cwd)) => match bindings::resolve_in(&vault, &cwd.to_string_lossy())? {
                Some(binding) => match binding.state {
                    bindings::BindingState::Ready => {
                        via_binding = true;
                        Some(binding.account_id)
                    }
                    bindings::BindingState::Missing => {
                        return Err(AppError::Message(
                            "这个目录绑定的账号已经不在了。请重新绑定或解除绑定。".to_string(),
                        ))
                    }
                    bindings::BindingState::Disabled => {
                        return Err(AppError::Message(format!(
                            "这个目录绑定的账号「{}」已停用。请先启用它，或改绑别的账号。",
                            binding.account_name.unwrap_or_default()
                        )))
                    }
                },
                None => None,
            },
            (None, None) => None,
        };
        let uses_default_login = account_id
            .as_deref()
            .is_some_and(|id| sessions::is_live_login(&vault, &paths, id));
        let prepared = match (&account_id, uses_default_login) {
            (Some(id), false) => Some(sessions::prepare_in(&vault, &paths, id)?),
            _ => None,
        };
        let account_name = match &prepared {
            Some(prepared) => Some(prepared.name.clone()),
            None => account_id
                .as_deref()
                .and_then(|id| vault.read_slot(id).ok())
                .map(|slot| slot.name().to_string()),
        };
        let script = session_script(prepared.as_ref().map(|p| p.dir.as_path()), cwd.as_deref());
        launch_session_script(&script)?;
        Ok(SessionLaunch {
            account_id,
            account_name,
            dir: cwd.map(|dir| dir.display().to_string()),
            via_binding,
            uses_default_login,
        })
    })
    .await
    .map_err(unfinished)?
}

/// Prepares a login's session folder and returns the commands that use it.
#[tauri::command]
pub async fn get_claude_session_commands(id: String) -> Result<SessionCommands, AppError> {
    crate::claude_accounts::validate_account_id(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        let prepared = sessions::prepare_in(&vault, &LivePaths::current(), &id)?;
        let (cmd, powershell) = sessions::shell_commands(&prepared.dir);
        Ok(SessionCommands {
            dir: prepared.dir.display().to_string(),
            cmd,
            powershell,
        })
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn list_claude_bindings() -> Result<Vec<BindingDto>, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        let vault = CodeVault::open_default()?;
        bindings::list_in(&vault)
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn set_claude_binding(path: String, account_id: String) -> Result<BindingDto, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        bindings::set_in(&vault, &path, &account_id)
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn remove_claude_binding(path: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        bindings::remove_in(&vault, &path)
    })
    .await
    .map_err(unfinished)?
}

/// Lets the user pick a folder. `None` when the dialog was cancelled.
#[tauri::command]
pub async fn pick_claude_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, AppError> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("选择目录")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|e| AppError::Message(format!("无效的目录位置: {e}")))?;
        let (_, display) = bindings::check_path(&path.to_string_lossy())?;
        Ok(Some(display))
    })
    .await
    .map_err(unfinished)?
}

// ===== Usage overview =====

/// What a million tokens of each kind cost, applied to a count.
fn cost_of(pricing: &crate::proxy::usage::calculator::ModelPricing, tokens: &usage::Tokens) -> f64 {
    use rust_decimal::prelude::ToPrimitive;
    use rust_decimal::Decimal;
    let million = Decimal::from(1_000_000);
    let cost = Decimal::from(tokens.input) * pricing.input_cost_per_million / million
        + Decimal::from(tokens.output) * pricing.output_cost_per_million / million
        + Decimal::from(tokens.cache_read) * pricing.cache_read_cost_per_million / million
        + Decimal::from(tokens.cache_write) * pricing.cache_creation_cost_per_million / million;
    cost.to_f64().unwrap_or(0.0)
}

/// Tokens and estimated cost of what Claude Code has done, by day, project,
/// model and login, over the last `range_days` days (`None` for all).
#[tauri::command]
pub async fn get_claude_usage_overview(
    state: State<'_, AppState>,
    range_days: Option<u32>,
) -> Result<UsageOverview, AppError> {
    let db = state.db.clone();
    let range_days = range_days.map(|days| days.clamp(1, 3650));
    tauri::async_runtime::spawn_blocking(move || {
        db.ensure_model_pricing_seeded()?;
        let vault = CodeVault::open_default()?;
        let roots = usage::roots(&vault, crate::config::get_claude_config_dir());
        let scan = usage::scan(&roots);
        let prices = db.with_connection(|conn| {
            Ok(scan
                .models()
                .into_iter()
                .map(|model| {
                    let pricing = crate::services::usage_stats::find_model_pricing(conn, &model);
                    (model, pricing)
                })
                .collect::<std::collections::HashMap<_, _>>())
        })?;
        let price = |model: &str, tokens: &usage::Tokens| {
            prices
                .get(model)
                .and_then(Option::as_ref)
                .map(|pricing| cost_of(pricing, tokens))
        };
        Ok(usage::summarize(
            &scan,
            &roots,
            range_days,
            usage::today(),
            &price,
        ))
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

// ===== Default Claude Desktop =====

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopSwapState {
    Done,
    /// Claude Desktop has to be closed first and was not allowed to be.
    DesktopRunning,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSwapOutcome {
    pub status: DesktopSwapState,
    /// It was running, was closed for this, and has been opened again.
    pub restarted: bool,
    /// The sign-in that was replaced was kept as this login's snapshot.
    pub saved_outgoing_for: Option<String>,
    /// The sign-in that was replaced matched no saved login and was stashed.
    pub stashed_outgoing: bool,
}

fn desktop_main_dir() -> Result<PathBuf, AppError> {
    desktop_swap::main_data_dir().ok_or_else(|| {
        AppError::Message(
            "未找到 Claude Desktop 的数据目录，默认 Desktop 切换目前只支持 Windows".to_string(),
        )
    })
}

/// Reopens the default Desktop after it was closed for a swap.
fn reopen_desktop(db: &crate::database::Database) -> bool {
    let installation = crate::claude_desktop_config::get_status(db, false)
        .ok()
        .and_then(|status| status.installation_path)
        .map(PathBuf::from);
    match desktop::launch_default(installation) {
        Ok(()) => true,
        Err(error) => {
            log::warn!("重新打开 Claude Desktop 失败: {error}");
            false
        }
    }
}

/// Which logins have a Claude Desktop sign-in saved, and who Desktop is
/// signed in as.
#[tauri::command]
pub async fn get_claude_desktop_swap_status() -> Result<desktop_swap::SwapStatus, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        let vault = CodeVault::open_default()?;
        Ok(desktop_swap::status_in(
            &vault,
            desktop_swap::main_data_dir().as_deref(),
        ))
    })
    .await
    .map_err(unfinished)?
}

/// Saves the default Desktop's current sign-in for a saved login. With
/// `close_desktop`, a running Desktop is closed first and reopened after.
#[tauri::command]
pub async fn capture_claude_desktop_login(
    state: State<'_, AppState>,
    id: String,
    close_desktop: bool,
) -> Result<DesktopSwapOutcome, AppError> {
    crate::claude_accounts::validate_account_id(&id)?;
    let lock = code::account_lock(&id);
    let _guard = lock.lock().await;
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        let main = desktop_main_dir()?;
        let mut was_running = false;
        if desktop_swap::data_locked(&main) {
            if !close_desktop {
                return Ok(DesktopSwapOutcome {
                    status: DesktopSwapState::DesktopRunning,
                    restarted: false,
                    saved_outgoing_for: None,
                    stashed_outgoing: false,
                });
            }
            was_running = desktop_swap::close_main_desktop(&main)?;
        }
        let captured = desktop_swap::capture_in(&vault, &main, &id);
        let restarted = was_running && reopen_desktop(&db);
        captured?;
        Ok(DesktopSwapOutcome {
            status: DesktopSwapState::Done,
            restarted,
            saved_outgoing_for: None,
            stashed_outgoing: false,
        })
    })
    .await
    .map_err(unfinished)?
}

/// Makes the default Desktop sign in as this saved login, from its snapshot.
#[tauri::command]
pub async fn switch_claude_desktop_account(
    state: State<'_, AppState>,
    id: String,
    close_desktop: bool,
) -> Result<DesktopSwapOutcome, AppError> {
    crate::claude_accounts::validate_account_id(&id)?;
    let lock = code::account_lock(&id);
    let _guard = lock.lock().await;
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let vault = CodeVault::open_default()?;
        let main = desktop_main_dir()?;
        let mut was_running = false;
        if desktop_swap::data_locked(&main) {
            if !close_desktop {
                return Ok(DesktopSwapOutcome {
                    status: DesktopSwapState::DesktopRunning,
                    restarted: false,
                    saved_outgoing_for: None,
                    stashed_outgoing: false,
                });
            }
            was_running = desktop_swap::close_main_desktop(&main)?;
        }
        let switched = desktop_swap::switch_in(&vault, &main, &id);
        // Reopen even when the swap failed: the old sign-in was put back.
        let restarted = was_running && reopen_desktop(&db);
        let result = switched?;
        Ok(DesktopSwapOutcome {
            status: DesktopSwapState::Done,
            restarted,
            saved_outgoing_for: result.saved_outgoing_for,
            stashed_outgoing: result.stashed_outgoing,
        })
    })
    .await
    .map_err(unfinished)?
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn the_session_script_clears_overrides_and_keeps_the_lock_open_while_claude_runs() {
        let script = session_script(
            Some(Path::new(r"C:\Users\me\v\sessions\a1")),
            Some(Path::new(r"D:\work\100%")),
        );
        assert!(script.starts_with("@echo off\r\nchcp 65001 >nul\r\n"));
        for name in sessions::AUTH_OVERRIDE_ENV {
            assert!(script.contains(&format!("set \"{name}=\"\r\n")), "{name}");
        }
        assert!(script.contains("set \"CLAUDE_CONFIG_DIR=C:\\Users\\me\\v\\sessions\\a1\"\r\n"));
        assert!(script.contains("cd /d \"D:\\work\\100%%\" || exit /b 1\r\n"));
        assert!(script
            .contains("(call claude) 9>\"C:\\Users\\me\\v\\sessions\\a1\\.session.lock\"\r\n"));
        assert!(script.ends_with("del \"%~f0\" >nul 2>&1\r\nrmdir \"%~dp0\" >nul 2>&1\r\n"));
        // Lines are CRLF only, as cmd expects.
        assert!(!script.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn a_plain_launch_sets_no_account_and_unc_folders_use_pushd() {
        let script = session_script(None, Some(Path::new(r"\\srv\share\repo")));
        assert!(!script.contains("CLAUDE_CONFIG_DIR"));
        assert!(!script.contains("ANTHROPIC_API_KEY"));
        assert!(script.contains("pushd \"\\\\srv\\share\\repo\" || exit /b 1\r\n"));
        assert!(script.contains("call claude\r\n"));
        assert!(!script.contains("9>"));
    }

    #[test]
    fn a_folder_must_exist_and_be_a_plain_absolute_path() {
        assert!(checked_folder("relative").is_err());
        assert!(checked_folder("C:\\no\\such\\folder\\anywhere-123456").is_err());
        let dir = tempfile::tempdir().unwrap();
        assert!(checked_folder(&dir.path().to_string_lossy()).is_ok());
    }
}
