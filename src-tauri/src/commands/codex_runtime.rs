//! Codex desktop runtime management backed by the audited Chimera runtime crate.
//!
//! Provider projection and application installation intentionally remain
//! separate write domains. Every runtime mutation takes a cross-process lock
//! and requires explicit confirmation from the renderer.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use chimera_platform::lock::{LockGuard, OperationLock};
use chimera_runtime::manager::{
    detect_portable_codex, detect_windows_codex, diagnose_windows_codex,
    fetch_windows_release_plan, install_windows_release, latest_portable_rollback,
    maintenance_route, parse_windows_release_plan, rollback_portable_install,
    uninstall_windows_codex, InstallMode, MaintenanceRoute, UpdateSource, WindowsReleasePlan,
};

use crate::services::codex_install_journal::{InstallJournal, InstallJournalEntry};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeDiagnostic {
    pub name: String,
    pub result: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeVersion {
    pub version: String,
    pub state: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeStatus {
    pub supported: bool,
    pub installed: bool,
    pub version: Option<String>,
    pub install_mode: Option<String>,
    pub install_path: Option<String>,
    pub portable_root: String,
    pub can_repair: bool,
    pub can_rollback: bool,
    pub can_uninstall: bool,
    pub history: Vec<CodexRuntimeVersion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessStatus {
    pub supported: bool,
    pub installed: bool,
    pub running: bool,
    pub install_mode: Option<String>,
    pub official_login_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLaunchResult {
    pub was_running: bool,
    pub running: bool,
    pub action: &'static str,
    pub model_unlock_attempted: bool,
    pub model_unlock_injected: bool,
    pub model_unlock_model_count: usize,
    pub model_unlock_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexReleaseStatus {
    pub current_version: Option<String>,
    pub latest_version: String,
    pub package_version: String,
    pub update_available: bool,
    pub source: String,
    pub install_mode: String,
    pub size_bytes: u64,
    pub released_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeOperation {
    pub version: String,
    pub requested_mode: String,
    pub actual_mode: String,
    pub affected_path: Option<String>,
    pub backup_path: Option<String>,
    pub message: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelCatalogStatus {
    pub valid: bool,
    pub default_model: String,
    pub catalog_path: Option<String>,
    pub model_count: usize,
    /// Whether Codex's own runtime confirmed the catalog. `false` means the
    /// files are correct but the probe could not run (or its result did not
    /// line up); the renderer surfaces this as a warning, never as a failure.
    pub runtime_verified: bool,
    /// Why `runtime_verified` is false, for display next to the warning.
    pub runtime_message: Option<String>,
}

/// Renderer-side expectation for one catalog entry. Keeping this contract
/// explicit prevents a stale catalog with only the default model from being
/// reported as healthy merely because its JSON is parseable.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedCodexCatalogModel {
    pub model: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CatalogModelIdentity {
    slug: String,
    display_name: String,
}

fn normalize_expected_catalog_models(
    expected_model: &str,
    expected_models: Option<Vec<ExpectedCodexCatalogModel>>,
) -> Result<Vec<ExpectedCodexCatalogModel>, String> {
    let mut normalized = Vec::new();
    for entry in expected_models.unwrap_or_default() {
        let model = entry.model.trim().to_string();
        if model.is_empty() {
            return Err("预期模型映射包含空模型".to_string());
        }
        normalized.push(ExpectedCodexCatalogModel {
            model,
            display_name: entry
                .display_name
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty()),
        });
    }

    let expected_model = expected_model.trim();
    if normalized.is_empty() {
        normalized.push(ExpectedCodexCatalogModel {
            model: expected_model.to_string(),
            display_name: None,
        });
    }

    let mut expected_seen = std::collections::HashSet::new();
    for entry in &normalized {
        if !expected_seen.insert(entry.model.clone()) {
            return Err(format!("预期模型映射包含重复模型 {}", entry.model));
        }
    }
    if !expected_seen.contains(expected_model) {
        return Err(format!("预期模型映射不包含默认模型 {expected_model}"));
    }

    Ok(normalized)
}

fn parse_catalog_model_identities(
    models: &[serde_json::Value],
    source: &str,
) -> Result<Vec<CatalogModelIdentity>, String> {
    let mut actual = Vec::with_capacity(models.len());
    for (index, model_entry) in models.iter().enumerate() {
        let slug = model_entry
            .get("slug")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|slug| !slug.is_empty())
            .ok_or_else(|| format!("{source}第 {} 项缺少非空 slug", index + 1))?;
        let display_name = model_entry
            .get("display_name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| format!("{source}第 {} 项 {slug} 缺少非空 display_name", index + 1))?;
        actual.push(CatalogModelIdentity {
            slug: slug.to_string(),
            display_name: display_name.to_string(),
        });
    }
    Ok(actual)
}

/// Looser check for the list Codex's runtime reports: every expected model must
/// be present, but extra entries and a different order are fine.
///
/// Codex merges its own built-in entries into the picker and does not promise to
/// preserve file order, so demanding exact equality here would fail on healthy
/// installs. Order, count, and display names stay strictly checked against the
/// catalog file, which cc-switch owns outright.
fn validate_runtime_models_contain_expected(
    expected: &[ExpectedCodexCatalogModel],
    actual: &[CatalogModelIdentity],
    source: &str,
) -> Result<(), String> {
    let actual_by_slug: std::collections::HashMap<&str, &CatalogModelIdentity> = actual
        .iter()
        .map(|entry| (entry.slug.as_str(), entry))
        .collect();

    let missing = expected
        .iter()
        .filter(|entry| !actual_by_slug.contains_key(entry.model.as_str()))
        .map(|entry| entry.model.as_str())
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!("{source}缺少模型：{}", missing.join("、")));
    }

    Ok(())
}

fn validate_catalog_model_identities(
    expected: &[ExpectedCodexCatalogModel],
    actual: &[CatalogModelIdentity],
    source: &str,
) -> Result<(), String> {
    if actual.len() != expected.len() {
        return Err(format!(
            "{source}数量不一致：期望 {} 个，实际 {} 个",
            expected.len(),
            actual.len()
        ));
    }

    let mut actual_seen = std::collections::HashSet::new();
    for (index, actual_entry) in actual.iter().enumerate() {
        if !actual_seen.insert(actual_entry.slug.clone()) {
            return Err(format!("{source}包含重复 slug：{}", actual_entry.slug));
        }

        let Some(expected_entry) = expected.get(index) else {
            return Err(format!("{source}多出模型 {}", actual_entry.slug));
        };
        if actual_entry.slug != expected_entry.model {
            return Err(format!(
                "{source}顺序或 slug 不一致：第 {} 项期望 {}，实际 {}",
                index + 1,
                expected_entry.model,
                actual_entry.slug
            ));
        }
        if let Some(expected_display_name) = expected_entry.display_name.as_deref() {
            if actual_entry.display_name != expected_display_name {
                return Err(format!(
                    "{source}显示名不一致：{} 期望“{}”，实际“{}”",
                    actual_entry.slug, expected_display_name, actual_entry.display_name
                ));
            }
        }
    }

    let missing = expected
        .iter()
        .filter(|entry| !actual_seen.contains(&entry.model))
        .map(|entry| entry.model.as_str())
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!("{source}缺少映射：{}", missing.join(", ")));
    }

    Ok(())
}

fn runtime_root() -> PathBuf {
    crate::config::get_app_config_dir().join("codex-runtime")
}

fn portable_root() -> Result<PathBuf, String> {
    crate::settings::resolve_codex_portable_root()
}

/// Guard against the engine's install-swap treating an arbitrary existing
/// directory as "a previous Codex install to replace".
///
/// `codex_win_engine::install_portable_from_msix[_with_observer]` decides
/// whether `portable_root` holds a previous install purely from
/// `install_root.exists()`: if it does, the directory is closed (killing
/// every process rooted there), renamed to a rollback backup, and — once the
/// new payload is in place — that backup is permanently deleted. There is no
/// identity check on that path. A user-configured portable root that happens
/// to point at an existing, non-empty, *non-Codex* directory (e.g. a
/// document folder picked by mistake in the directory browser, which can
/// only select directories that already exist) would therefore have its
/// entire contents destroyed with no recovery.
///
/// `detect_portable_install`/`detect_portable_codex` already implements the
/// correct identity check (AppxManifest identity, or the asar package name
/// fallback) — it is just never consulted on the install path, only on the
/// detection path. Consult it here, before any engine install/update call,
/// so the destructive swap only ever runs against a directory that is either
/// absent, empty, or already a genuine Codex install.
fn ensure_portable_root_safe_for_install(portable_root: &Path) -> Result<(), String> {
    // Best-effort hygiene, not part of the safety contract below: every past
    // rollback leaves its replaced install (`Codex.replaced-*`) behind
    // forever (nothing in this codebase or the pinned engine ever deletes
    // it — the engine only auto-deletes the *other* backup prefix,
    // `Codex.rollback-*`, and only right after a successful install/update).
    // Left unchecked this is an unbounded, invisible-to-the-user leak of a
    // full Codex install (hundreds of MB) per rollback. Keep at most the
    // single newest spare copy — that is also the one `rollback_codex_runtime`
    // would act on — and clean up the rest before starting a new install.
    sweep_stale_portable_backups(portable_root);

    let exists = portable_root.is_dir();
    if !exists {
        return Ok(());
    }
    let is_empty = std::fs::read_dir(portable_root)
        .map_err(|error| format!("无法读取 Codex portable root：{error}"))?
        .next()
        .is_none();
    if is_empty {
        return Ok(());
    }
    if detect_portable_codex(portable_root).is_some() {
        return Ok(());
    }
    Err(format!(
        "Codex portable root（{}）已存在内容，但看起来不是一个 Codex 安装（未检测到有效的应用标识）。\
         为避免误删该目录下的数据，已拒绝安装。请在设置中把 Codex portable root 改为一个空目录，\
         或指向一个已有的 Codex 便携版安装目录。",
        portable_root.display()
    ))
}

/// Keep at most the single newest `Codex.rollback-*`/`Codex.replaced-*`
/// sibling of `portable_root` and delete the rest. `latest_portable_rollback`
/// (used by `rollback_codex_runtime`) only ever considers the newest one by
/// mtime regardless of prefix, so anything older is already unreachable —
/// deleting it recovers disk space without removing any rollback capability
/// a user could actually invoke. Best-effort: read/delete failures are
/// logged and otherwise ignored, since this is opportunistic hygiene, not a
/// correctness requirement of the caller.
fn sweep_stale_portable_backups(portable_root: &Path) {
    let Some(parent) = portable_root.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    let mut backups: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !(name.starts_with("Codex.rollback-") || name.starts_with("Codex.replaced-")) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        backups.push((modified, entry.path()));
    }
    if backups.len() <= 1 {
        return;
    }
    backups.sort_by_key(|(modified, _)| *modified);
    // Keep the last (newest) entry; remove everything else.
    for (_, path) in &backups[..backups.len() - 1] {
        if let Err(error) = std::fs::remove_dir_all(path) {
            log::warn!(
                "[portable-backup-sweep] 清理旧回滚备份 {} 失败: {error}",
                path.display()
            );
        } else {
            log::info!(
                "[portable-backup-sweep] 已清理旧回滚备份 {}",
                path.display()
            );
        }
    }
}

fn process_install_mode(source: &str) -> String {
    if source == "portable" {
        "portable"
    } else {
        "standard"
    }
    .to_string()
}

fn codex_is_running(installed: &codex_win_engine::InstalledWindowsCodex) -> Result<bool, String> {
    codex_win_engine::codex_running_for_root(Path::new(&installed.path))
        .map_err(|error| format!("无法读取 Codex 进程状态: {error}"))
}

fn launch_action(was_running: bool) -> &'static str {
    if was_running {
        "restarted"
    } else {
        "launched"
    }
}

fn renderer_unlock_available(installed: &codex_win_engine::InstalledWindowsCodex) -> bool {
    if installed.source == "portable" {
        return true;
    }
    let live_home = crate::codex_config::get_codex_config_dir();
    let default_home = crate::config::get_home_dir().join(".codex");
    codex_win_engine::same_windows_path(&live_home, &default_home)
}

fn renderer_unlock_launch_options(
    installed: &codex_win_engine::InstalledWindowsCodex,
) -> codex_win_engine::LaunchOptions {
    let mut options = codex_win_engine::LaunchOptions::default();
    if renderer_unlock_available(installed) {
        options.remote_debugging_port = Some(crate::codex_cdp::codex_renderer_debug_port());
    }
    options
}

fn renderer_unlock_status(
    installed: &codex_win_engine::InstalledWindowsCodex,
) -> crate::codex_cdp::CodexModelUnlockStatus {
    let status = if renderer_unlock_available(installed) {
        crate::codex_cdp::inject_codex_model_unlock(crate::codex_cdp::codex_renderer_debug_port())
    } else {
        crate::codex_cdp::unavailable_model_unlock(
            "标准 MSIX 使用自定义 CODEX_HOME 时无法同时传入 CDP 参数；请恢复默认 ~/.codex 或改用便携版 Codex",
        )
    };
    if let Some(error) = status.error.as_deref() {
        log::warn!("Codex renderer 模型注入未生效: {error}");
    }
    status
}

fn launch_result(
    was_running: bool,
    running: bool,
    model_unlock: crate::codex_cdp::CodexModelUnlockStatus,
) -> CodexLaunchResult {
    CodexLaunchResult {
        was_running,
        running,
        action: launch_action(was_running),
        model_unlock_attempted: model_unlock.attempted,
        model_unlock_injected: model_unlock.injected,
        model_unlock_model_count: model_unlock.model_count,
        model_unlock_error: model_unlock.error,
    }
}

fn official_login_available() -> bool {
    let path = crate::codex_config::get_codex_auth_path();
    let Ok(contents) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(auth) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };
    crate::codex_config::codex_auth_has_oauth_login_material(&auth)
}

fn wait_for_codex_running(
    installed: &codex_win_engine::InstalledWindowsCodex,
) -> Result<bool, String> {
    // MSIX activation goes through the AppX deployment service, which the
    // engine's own `MSIX_ACTIVATION_WINDOW_SECS` documents as needing up to
    // 30s on a cold machine/low-speed disk — well above a direct portable
    // process spawn. Using the same 10s window for both used to make
    // successful-but-slow MSIX launches report as failures (steering users to
    // an unnecessary "run diagnostics" prompt). Match the engine's own
    // activation budget for MSIX; keep the shorter window for portable, whose
    // launch is a direct child-process spawn.
    let attempts: u32 = if installed.source == "msix" { 120 } else { 40 };
    for _ in 0..attempts {
        if codex_is_running(installed)? {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Ok(false)
}

fn wait_for_codex_stopped(
    installed: &codex_win_engine::InstalledWindowsCodex,
) -> Result<bool, String> {
    // Electron can briefly replace the main process while it is shutting down.
    // Require a full second of consecutive path-pinned scans with no matching
    // process before starting the replacement instance.
    let mut clear_polls = 0_u8;
    for _ in 0..120 {
        if codex_is_running(installed)? {
            clear_polls = 0;
        } else {
            clear_polls += 1;
            if clear_polls >= 4 {
                return Ok(true);
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Ok(false)
}

fn launch_executable_with_codex_home(
    executable: &Path,
    working_dir: &Path,
    codex_home: &Path,
    options: codex_win_engine::LaunchOptions,
) -> Result<(), String> {
    let mut command = Command::new(executable);
    command
        .current_dir(working_dir)
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if options.disable_codex_self_updates {
        command.env("CODEX_SPARKLE_ENABLED", "false");
    }
    if let Some(port) = options.remote_debugging_port {
        command.args([
            "--remote-debugging-address=127.0.0.1",
            &format!("--remote-debugging-port={port}"),
        ]);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let child = command.spawn().map_err(|error| {
        format!(
            "无法启动 Codex 可执行文件 {}: {error}",
            executable.display()
        )
    })?;
    // The process is intentionally owned by Codex after launch. We verify its
    // liveness separately, so waiting here would block the Tauri command.
    std::mem::forget(child);
    Ok(())
}

fn launch_msix_with_codex_home(
    codex_home: &Path,
    options: codex_win_engine::LaunchOptions,
) -> Result<(), String> {
    if options.remote_debugging_port.is_some() {
        return Err("MSIX 启动暂不支持通过环境注入远程调试参数".to_string());
    }

    // Shell activation normally happens in a separate process and therefore
    // cannot see a temporary Rust-side environment change. Start the shell
    // activation from PowerShell with CODEX_HOME explicitly present so the
    // activated Desktop process inherits the same config directory.
    let script = r#"
$ErrorActionPreference = 'Stop'
$pkg = Get-AppxPackage -Name 'OpenAI.Codex' |
  Sort-Object -Property Version -Descending |
  Select-Object -First 1
if ($null -eq $pkg) { throw 'Codex is not installed' }
$app = (Get-AppxPackageManifest $pkg).Package.Applications.Application
if ($app -is [array]) { $app = $app[0] }
$id = [string]$app.Id
if ([string]::IsNullOrWhiteSpace($id)) { $id = 'App' }
Start-Process ("shell:AppsFolder\" + $pkg.PackageFamilyName + "!" + $id)
"#;
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if options.disable_codex_self_updates {
        command.env("CODEX_SPARKLE_ENABLED", "false");
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let output = crate::process_utils::output_with_timeout(
        command,
        Duration::from_secs(15),
        crate::security_limits::MAX_PROCESS_OUTPUT_BYTES,
    )
    .map_err(|error| format!("无法调用 PowerShell 启动 MSIX Codex: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("MSIX Codex 激活失败（退出码 {:?}）", output.status.code())
        } else {
            format!("MSIX Codex 激活失败：{detail}")
        });
    }
    Ok(())
}

pub(crate) fn launch_codex_with_config(
    installed: &codex_win_engine::InstalledWindowsCodex,
    options: codex_win_engine::LaunchOptions,
) -> Result<(), String> {
    let codex_home = crate::codex_config::get_codex_config_dir();

    if installed.source == "portable" {
        let root = Path::new(&installed.path);
        let executable = codex_win_engine::installed_app_exe(root)
            .ok_or_else(|| format!("未找到 Codex 启动程序：{}", root.display()))?;
        return launch_executable_with_codex_home(&executable, root, &codex_home, options);
    }

    // The audited engine uses IApplicationActivationManager when Electron
    // arguments are present, which is the only reliable way to pass the local
    // CDP flags to an MSIX desktop app. This path is used only with the default
    // ~/.codex directory, so no CODEX_HOME environment override is required.
    if options.remote_debugging_port.is_some() {
        return codex_win_engine::launch_codex_with_options(installed, options)
            .map_err(|error| format!("无法带 CDP 参数启动 MSIX Codex：{error}"));
    }

    // Without renderer injection, prefer the environment-aware shell activation.
    // If PowerShell is policy-blocked, fall back to the audited engine launcher.
    match launch_msix_with_codex_home(&codex_home, options) {
        Ok(()) => Ok(()),
        Err(error) => {
            log::warn!("环境注入的 MSIX Codex 启动失败，回退到系统激活：{error}");
            codex_win_engine::launch_codex_with_options(installed, options)
                .map_err(|fallback| format!("{error}；系统激活也失败：{fallback}"))
        }
    }
}

pub(crate) fn close_codex_for_restart(
    installed: &codex_win_engine::InstalledWindowsCodex,
    portable_root: &Path,
) -> Result<(), String> {
    if installed.source == "msix" {
        codex_win_engine::close_msix_codex_processes(30)
            .map_err(|error| format!("无法关闭 Codex: {error}"))?;
    } else {
        codex_win_engine::close_codex_gracefully_for_root(30, portable_root)
            .map_err(|error| format!("无法关闭 Codex: {error}"))?;
    }
    if !wait_for_codex_stopped(installed)? {
        return Err("Codex 未能完全退出，已取消重启".to_string());
    }
    Ok(())
}

/// Verify that the live Codex config points at Chimera's catalog and contains
/// every model that the renderer just saved. This command is read-only.
///
/// `expected_models` is optional for IPC compatibility with older renderers;
/// those callers still get the legacy default-model check. New renderers pass
/// the complete mapping (including display names), which catches the exact
/// failure mode where only Codex's single `custom` entry remains visible.
#[tauri::command]
pub fn verify_codex_model_catalog(
    expected_model: String,
    expected_models: Option<Vec<ExpectedCodexCatalogModel>>,
) -> Result<CodexModelCatalogStatus, String> {
    let expected_model = expected_model.trim();
    if expected_model.is_empty() {
        return Err("默认模型不能为空".to_string());
    }
    let expected_models = normalize_expected_catalog_models(expected_model, expected_models)?;

    let config_text = crate::codex_config::read_codex_config_text().map_err(|e| e.to_string())?;
    let config = config_text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Codex 配置无法解析: {e}"))?;
    let default_model = config
        .get("model")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if default_model != expected_model {
        return Err(format!(
            "Codex 默认模型未正确写入（当前为 {default_model}）"
        ));
    }

    let generated_path = crate::codex_config::get_codex_model_catalog_path();
    let catalog_path =
        crate::codex_config::resolve_cc_switch_catalog_path(&config_text, &generated_path)
            .ok_or_else(|| "Codex 配置未引用 Chimera 模型目录".to_string())?;
    let catalog_text = std::fs::read_to_string(&catalog_path).map_err(|_| {
        format!(
            "Chimera 模型目录文件不存在或无法读取：{}",
            catalog_path.display()
        )
    })?;
    let catalog: serde_json::Value = serde_json::from_str(&catalog_text)
        .map_err(|e| format!("Chimera 模型目录无法解析：{e}"))?;
    let models = catalog
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Chimera 模型目录缺少 models 列表".to_string())?;
    let file_models = parse_catalog_model_identities(models, "模型目录")?;
    validate_catalog_model_identities(
        &expected_models,
        &file_models,
        &format!("模型目录（{}）", catalog_path.display()),
    )?;

    // File-level validation above is authoritative: cc-switch owns config.toml
    // and the catalog file, and both were just confirmed correct.
    //
    // Asking Codex's own runtime is a useful extra signal — it is what detects
    // the old "only custom is visible" failure — but it is only advisory. The
    // probe needs a runnable `codex` CLI, which is not guaranteed: a macOS GUI
    // process inherits launchd's PATH, so an npm-installed launcher cannot find
    // its Node interpreter, and older CLIs lack `debug models` entirely. Those
    // are environment gaps, not catalog defects, and the remediation the user
    // would be pushed toward (restart Codex) is Windows-only anyway. Treating
    // them as hard failures reported a correct save as broken.
    let (runtime_verified, runtime_message) =
        match crate::codex_config::probe_codex_runtime_models() {
            Ok(runtime_models) => {
                let runtime_models = runtime_models
                    .into_iter()
                    .map(|model| CatalogModelIdentity {
                        slug: model.slug,
                        display_name: model.display_name,
                    })
                    .collect::<Vec<_>>();
                match validate_runtime_models_contain_expected(
                    &expected_models,
                    &runtime_models,
                    "Codex 实际模型列表",
                ) {
                    Ok(()) => (true, None),
                    Err(message) => (false, Some(message)),
                }
            }
            Err(error) => (false, Some(error.to_string())),
        };

    if let Some(message) = runtime_message.as_deref() {
        log::info!("Codex model catalog written; runtime cross-check unavailable: {message}");
    }

    Ok(CodexModelCatalogStatus {
        valid: true,
        default_model,
        catalog_path: Some(catalog_path.to_string_lossy().to_string()),
        model_count: file_models.len(),
        runtime_verified,
        runtime_message,
    })
}

/// Restart Codex after an explicit renderer confirmation so it reloads the
/// startup-only model catalog. Reuses Codex App Manager's install detection.
#[tauri::command]
pub async fn restart_codex_for_model_catalog(confirm: bool) -> Result<CodexLaunchResult, String> {
    require_confirmation(confirm, "重启 Codex 以刷新模型列表")?;
    require_windows()?;
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_restart_catalog")?;
        let installed = codex_win_engine::detect_installed_codex(&portable_root)
            .ok_or_else(|| "未检测到 Codex 安装".to_string())?;
        let was_running = codex_is_running(&installed)?;
        close_codex_for_restart(&installed, &portable_root)?;
        launch_codex_with_config(&installed, renderer_unlock_launch_options(&installed))?;
        let running = wait_for_codex_running(&installed)?;
        if !running {
            return Err("Codex 重启后未保持运行，请在更新页运行诊断".to_string());
        }
        let model_unlock = renderer_unlock_status(&installed);
        Ok(launch_result(was_running, running, model_unlock))
    })
    .await
    .map_err(|e| format!("Codex 重启任务中断: {e}"))?
}

/// Read whether the exact detected Codex installation currently owns a process.
/// Process discovery is path-pinned so an unrelated ChatGPT installation is not
/// mistaken for, or affected as, the managed Codex instance.
#[tauri::command]
pub async fn get_codex_process_status() -> Result<CodexProcessStatus, String> {
    if !cfg!(target_os = "windows") {
        return Ok(CodexProcessStatus {
            supported: false,
            installed: false,
            running: false,
            install_mode: None,
            official_login_available: official_login_available(),
        });
    }
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(installed) = codex_win_engine::detect_installed_codex(&portable_root) else {
            return Ok(CodexProcessStatus {
                supported: true,
                installed: false,
                running: false,
                install_mode: None,
                official_login_available: official_login_available(),
            });
        };
        Ok(CodexProcessStatus {
            supported: true,
            installed: true,
            running: codex_is_running(&installed)?,
            install_mode: Some(process_install_mode(&installed.source)),
            official_login_available: official_login_available(),
        })
    })
    .await
    .map_err(|error| format!("读取 Codex 进程状态时任务中断: {error}"))?
}

/// Probe a running Codex instance for whether the Chimera++ renderer model
/// unlock is attachable and already injected.
///
/// This is the read-side diagnostics for the "模型列表未解锁" guidance. A
/// `attachable: false` result means the running instance was started outside
/// Chimera++ (manual launch, or an MSIX/custom-CODEX_HOME launch without a
/// debug port), so the model picker shows only the gated default until Codex
/// is restarted through Chimera++. Errors are non-fatal diagnostics.
#[tauri::command]
pub async fn probe_codex_renderer_unlock(
) -> Result<crate::codex_cdp::CodexRendererUnlockProbe, String> {
    // Renderer injection is Windows-only today; other platforms have no Codex
    // desktop renderer to attach to, so report not-attachable without probing.
    if !cfg!(target_os = "windows") {
        return Ok(crate::codex_cdp::CodexRendererUnlockProbe {
            attachable: false,
            injected: false,
            model_count: 0,
            error: Some("Codex 桌面版渲染注入仅支持 Windows".to_string()),
        });
    }
    let debug_port = crate::codex_cdp::codex_renderer_debug_port();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(crate::codex_cdp::probe_codex_renderer_unlock(debug_port))
    })
    .await
    .map_err(|error| format!("探测 Codex renderer 注入状态时任务中断: {error}"))?
}

/// Sentinel prefix on the error returned by [`open_codex_runtime`] when Codex
/// is already running and the caller has not set `confirm_restart`. Matched
/// with `.startsWith(...)` by the renderer rather than the full localized
/// message, so wording can change without breaking the confirmation flow.
pub const OPEN_CODEX_RESTART_CONFIRMATION_REQUIRED_PREFIX: &str = "CONFIRM_RESTART_REQUIRED:";

/// Launch the managed Codex installation, replacing a running managed instance
/// first. The deprecated optional flag is accepted only for IPC compatibility:
/// lifecycle policy is backend-owned and a running target is always restarted
/// once the caller has confirmed that.
///
/// The cross-process lock covers discovery, shutdown, launch, and health
/// verification. Process discovery and termination are path-pinned in
/// `codex_win_engine`, so unrelated Electron or ChatGPT processes are never
/// selected.
///
/// A running target is only closed and relaunched when `confirm_restart` is
/// `true` — "open Codex" clicked on an already-running instance used to
/// silently force-close it (killing after a 30s grace period, per
/// `close_codex_for_restart`), interrupting whatever the user was doing in
/// Codex with no warning. Callers should check the already-known process
/// status (e.g. the renderer's own polled `get_codex_process_status`) before
/// invoking this, and only pass `confirm_restart: true` after the user has
/// explicitly agreed to interrupt the running session.
#[tauri::command]
pub async fn open_codex_runtime(
    restart_if_running: Option<bool>,
    confirm_restart: Option<bool>,
) -> Result<CodexLaunchResult, String> {
    // Keep accepting the old renderer argument without allowing it to weaken
    // the safe restart policy. The renderer submits launch intent only.
    let _legacy_restart_preference = restart_if_running;
    require_windows()?;
    let portable_root = portable_root()?;
    let confirm_restart = confirm_restart.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_launch")?;
        let installed = codex_win_engine::detect_installed_codex(&portable_root)
            .ok_or_else(|| "未检测到 Codex 安装".to_string())?;
        let was_running = codex_is_running(&installed)?;
        if was_running && !confirm_restart {
            return Err(format!(
                "{OPEN_CODEX_RESTART_CONFIRMATION_REQUIRED_PREFIX}Codex 正在运行，继续将关闭并重新启动它以应用最新配置，\
                 期间的任何未完成操作都会中断。"
            ));
        }
        // Always pass through the shutdown gate. It is a no-op when the target
        // is already stopped, and it removes the discovery/launch race where a
        // just-started Electron child could otherwise survive the restart.
        close_codex_for_restart(&installed, &portable_root)?;
        if let Err(error) =
            launch_codex_with_config(&installed, renderer_unlock_launch_options(&installed))
        {
            // A second portable Electron process may exit after handing focus
            // to an already-running instance. We intentionally reject that
            // path here: a previous target was either absent or confirmed
            // closed, so accepting it could hide a failed replacement.
            return Err(format!("无法启动 Codex: {error}"));
        }
        let running = wait_for_codex_running(&installed)?;
        if !running {
            return Err("Codex 启动后未保持运行，请在更新页运行诊断".to_string());
        }
        let model_unlock = renderer_unlock_status(&installed);
        Ok(launch_result(was_running, running, model_unlock))
    })
    .await
    .map_err(|error| format!("Codex 启动任务中断: {error}"))?
}

fn operation_lock() -> OperationLock {
    OperationLock::new(runtime_root().join("operation.lock"))
}

fn acquire_operation_lock(operation: &str) -> Result<LockGuard, String> {
    let root = runtime_root();
    std::fs::create_dir_all(&root).map_err(|_| "无法创建 Chimera++ 运行时目录".to_string())?;
    operation_lock()
        .try_acquire(operation)
        .map_err(|_| "另一个 Chimera++ 操作正在进行".to_string())
}

fn parse_source(value: Option<String>) -> Result<UpdateSource, String> {
    value
        .unwrap_or_else(|| crate::settings::get_settings().codex_update_source)
        .parse::<UpdateSource>()
        .map_err(|_| "更新源仅支持 auto 或 mirror".to_string())
}

fn parse_install_mode(value: Option<String>) -> Result<InstallMode, String> {
    value
        .unwrap_or_else(|| crate::settings::get_settings().codex_install_mode)
        .parse::<InstallMode>()
        .map_err(|_| "安装方式仅支持 standard 或 portable".to_string())
}

fn source_label(source: UpdateSource) -> String {
    match source {
        UpdateSource::Auto => "auto",
        UpdateSource::Mirror => "mirror",
    }
    .to_string()
}

fn mode_label(mode: InstallMode) -> String {
    match mode {
        InstallMode::Standard => "standard",
        InstallMode::Portable => "portable",
    }
    .to_string()
}

/// Decode a single filesystem entry name if it contains OPC percent-escapes,
/// returning `None` when there is nothing to do or the decode is not a clean
/// round-trip to UTF-8 (defensive: never guess on ambiguous input).
fn decode_percent_encoded_entry_name(name: &str) -> Option<String> {
    if !name.contains('%') {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(name)
        .decode_utf8()
        .ok()?;
    if decoded == name {
        return None;
    }
    // `name` is a single filesystem entry (one path component) and the
    // caller renames within its existing parent directory via
    // `path.with_file_name(&decoded_name)`. A decoded value that introduces
    // a path separator or resolves to `.`/`..` would let a crafted
    // percent-encoded entry name (e.g. `%2e%2e%5cescape`) rename outside
    // that directory — reject it defensively rather than trust the
    // round-trip decode alone. Reaching this at all already requires an
    // MSIX that passed sha256 + Authenticode + package-identity checks, so
    // this is defense-in-depth, not the primary guard.
    if decoded.contains('/') || decoded.contains('\\') || decoded == ".." || decoded == "." {
        log::warn!(
            "[portable-payload-fixup] 拒绝可疑的百分号解码结果（包含路径分隔符）: {name} → {decoded}"
        );
        return None;
    }
    Some(decoded.into_owned())
}

/// Workaround for a known extraction bug in the pinned `codex-win-engine`
/// crate (upstream Codex App Manager issue #260): its `extract_msix` writes
/// ZIP entry names to disk verbatim via `enclosed_name()`, without
/// percent-decoding the OPC (Open Packaging Conventions) percent-escapes
/// MSIX payloads use for characters outside the ASCII path-safe set — e.g. an
/// `@oai` directory is stored in the package as `%40oai`, `$_StatsigGlobal.js`
/// as `%24_StatsigGlobal.js`. Left undecoded, those are the literal names
/// that land on disk, breaking anything that looks the real names up at
/// runtime — most visibly Node's `require()` resolution for the `@oai/...`
/// scoped packages the bundled Computer Use plugin depends on.
///
/// We do not control the pinned crate's extraction code, so this fixes it up
/// ourselves immediately after a successful portable install/update: walk
/// the install tree post-order (a directory's children are fixed up, and can
/// still be found under its original name while that happens, before the
/// directory itself is renamed) and rename any entry whose name is still
/// percent-encoded back to its decoded form.
///
/// Best-effort by design: a failure fixing up one entry is logged and does
/// not abort the walk or the caller's success result — a partially-fixed
/// tree is still strictly better than an entirely unfixed one, and this must
/// never turn an otherwise-successful install into a reported failure.
fn fix_up_percent_encoded_portable_payload(dir: &Path) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!(
                "[portable-payload-fixup] 无法读取目录 {}: {error}",
                dir.display()
            );
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            fix_up_percent_encoded_portable_payload(&path);
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(decoded_name) = decode_percent_encoded_entry_name(name) else {
            continue;
        };
        let target = path.with_file_name(&decoded_name);
        if target.exists() {
            log::warn!(
                "[portable-payload-fixup] 跳过重命名 {} → {}：目标已存在",
                path.display(),
                target.display()
            );
            continue;
        }
        if let Err(error) = std::fs::rename(&path, &target) {
            log::warn!(
                "[portable-payload-fixup] 重命名 {} → {} 失败: {error}",
                path.display(),
                target.display()
            );
        }
    }
}

/// Mirrors the private `chimera_runtime::manager::safe_package_moniker`
/// check: the moniker is interpolated into a filesystem path
/// (`{moniker}.Msix`), so this is validated defensively before we do that
/// ourselves in `install_portable_release_with_observer` below.
fn safe_package_moniker(value: &str) -> bool {
    value.starts_with("OpenAI.Codex_")
        && value.len() <= 180
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Builds a `PortableObserver` that persists each rename-boundary transition
/// into the install journal (TASK-007), so a crash mid-swap can be found and
/// explained on next launch. Journal write failures are logged and never
/// abort the install itself — matching the offline-install call site this
/// was factored out of, the observer always returns `Ok(())`.
fn install_journal_observer<'a>(
    journal: &'a InstallJournal,
    journal_id: &'a str,
) -> impl FnMut(codex_win_engine::PortableBoundary) -> Result<(), codex_win_engine::EngineError> + 'a
{
    move |boundary: codex_win_engine::PortableBoundary| {
        use codex_win_engine::PortableBoundary as Boundary;
        let (state, backup) = match &boundary {
            Boundary::BeforeMoveOld { backup, .. } => {
                ("moving:before_move_old", Some(backup.clone()))
            }
            Boundary::AfterMoveOld { backup, .. } => {
                ("moving:after_move_old", Some(backup.clone()))
            }
            Boundary::BeforeMoveNew { backup, .. } => {
                ("moving:before_move_new", Some(backup.clone()))
            }
            Boundary::AfterMoveNew { backup, .. } => {
                ("moving:after_move_new", Some(backup.clone()))
            }
            Boundary::BeforeRollback { backup, .. } => {
                ("moving:before_rollback", Some(backup.clone()))
            }
            Boundary::RollbackCompleted { backup, .. } => {
                ("moving:rollback_completed", Some(backup.clone()))
            }
        };
        if let Err(error) = journal.update(journal_id, |entry| {
            entry.state = state.to_string();
            if let Some(backup) = &backup {
                entry.backup_path = Some(backup.to_string_lossy().to_string());
            }
        }) {
            log::warn!("[InstallJournal] 边界状态写入失败: {error}");
        }
        Ok(())
    }
}

/// Replicates `chimera_runtime::manager::install_windows_release`'s portable
/// path (download → verify size/sha256/Authenticode → install) using only
/// the pinned engine's public functions, but calling
/// `install_portable_from_msix_with_observer` instead of the plain
/// `install_windows_release`/`install_portable_from_msix` the manager crate
/// uses internally for this mode.
///
/// `install_windows_release` does not accept an observer — the online
/// install/update path (by far the most used, versus the rarely-used
/// offline-file path) therefore could not persist rename-boundary state into
/// the crash-recovery journal, so a crash during the destructive swap window
/// left the journal entry stuck at "started" with no `backup_path`, and the
/// recovery banner would tell the user "if Codex works, ignore this" even
/// when the install root had just been destroyed (see
/// `ensure_portable_root_safe_for_install`'s doc comment for the swap
/// mechanics). We do not control the pinned crate, so this bypasses its
/// convenience wrapper for the one mode where observer access actually
/// matters — standard/MSIX installs keep going through
/// `install_windows_release` unchanged, since that path additionally runs
/// capability probing and standard/portable fallback logic that belongs to
/// the engine, not to us.
fn install_portable_release_with_observer(
    plan: &WindowsReleasePlan,
    staging_root: &Path,
    portable_root: &Path,
    on_progress: &dyn Fn(u64),
    // `codex_win_engine::PortableObserver` (the type alias
    // `install_portable_from_msix_with_observer` itself is declared in
    // terms of) is a private type not re-exported from the crate root;
    // spell out the same trait object using the two pieces that ARE
    // exported (`PortableBoundary`, `EngineError`) instead.
    observer: &mut dyn FnMut(
        codex_win_engine::PortableBoundary,
    ) -> Result<(), codex_win_engine::EngineError>,
) -> Result<codex_win_engine::PortableInstallReport, String> {
    if !safe_package_moniker(&plan.package_moniker) {
        return Err("安装计划中的包名不合法".to_string());
    }
    std::fs::create_dir_all(staging_root).map_err(|error| format!("创建暂存目录失败: {error}"))?;
    let package_path = staging_root.join(format!("{}.Msix", plan.package_moniker));
    codex_win_engine::download_to_with_progress_bounded(
        &plan.package_url,
        &package_path,
        plan.size_bytes,
        on_progress,
    )
    .map_err(|error| format!("下载安装包失败: {error}"))?;

    let size = package_path
        .metadata()
        .map_err(|error| format!("读取安装包信息失败: {error}"))?
        .len();
    let digest = codex_win_engine::sha256_file(&package_path)
        .map_err(|error| format!("计算安装包哈希失败: {error}"))?;
    if size != plan.size_bytes || !digest.eq_ignore_ascii_case(&plan.sha256) {
        let _ = std::fs::remove_file(&package_path);
        return Err("安装包大小或哈希与发布计划不符，已拒绝".to_string());
    }
    let signature = codex_win_engine::verify_openai_authenticode(&package_path)
        .map_err(|error| format!("验证安装包签名失败: {error}"))?;
    if !signature.is_valid_openai() {
        let _ = std::fs::remove_file(&package_path);
        return Err("安装包未通过 OpenAI 发行者签名校验，已拒绝安装".to_string());
    }

    let result = codex_win_engine::install_portable_from_msix_with_observer(
        &package_path,
        portable_root,
        true,
        false,
        observer,
    )
    .map_err(|error| error.to_string());
    if result.is_ok() {
        let _ = std::fs::remove_file(&package_path);
    }
    result
}

fn operation_dto(value: chimera_runtime::manager::InstallOperationResult) -> CodexRuntimeOperation {
    CodexRuntimeOperation {
        version: value.version,
        requested_mode: value.requested_mode,
        actual_mode: value.actual_mode,
        affected_path: value.affected_path,
        backup_path: value.backup_path,
        message: value.message,
        notes: value.notes,
    }
}

fn require_windows() -> Result<(), String> {
    if cfg!(target_os = "windows") {
        Ok(())
    } else {
        Err("当前运行时管理引擎仅支持 Windows".to_string())
    }
}

fn require_confirmation(confirm: bool, action: &str) -> Result<(), String> {
    if confirm {
        Ok(())
    } else {
        Err(format!("{action}需要用户明确确认"))
    }
}

/// Read installed Codex state without making a network request.
#[tauri::command]
pub async fn get_codex_runtime_status() -> Result<CodexRuntimeStatus, String> {
    let portable_root = portable_root()?;
    if !cfg!(target_os = "windows") {
        return Ok(CodexRuntimeStatus {
            supported: false,
            installed: false,
            version: None,
            install_mode: None,
            install_path: None,
            portable_root: portable_root.to_string_lossy().to_string(),
            can_repair: false,
            can_rollback: false,
            can_uninstall: false,
            history: Vec::new(),
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let installed = detect_windows_codex(&portable_root);
        let rollback = latest_portable_rollback(&portable_root).ok().flatten();
        let mut history = Vec::new();
        if let Some(current) = installed.as_ref() {
            history.push(CodexRuntimeVersion {
                version: current.version.clone(),
                state: "active",
            });
        }
        if let Some(previous) = rollback.as_deref().and_then(detect_portable_codex) {
            history.push(CodexRuntimeVersion {
                version: previous.version,
                state: "previous",
            });
        }
        let portable = installed
            .as_ref()
            .is_some_and(|value| value.install_mode == "portable");
        Ok(CodexRuntimeStatus {
            supported: true,
            installed: installed.is_some(),
            version: installed.as_ref().map(|value| value.version.clone()),
            install_mode: installed.as_ref().map(|value| value.install_mode.clone()),
            install_path: installed.as_ref().map(|value| value.path.clone()),
            portable_root: portable_root.to_string_lossy().to_string(),
            can_repair: installed.is_some(),
            can_rollback: portable && rollback.is_some(),
            can_uninstall: installed.is_some(),
            history,
        })
    })
    .await
    .map_err(|_| "读取 Codex 安装状态时任务中断".to_string())?
}

#[tauri::command]
pub async fn open_codex_runtime_directory(handle: AppHandle) -> Result<bool, String> {
    require_windows()?;
    let installed =
        detect_windows_codex(&portable_root()?).ok_or_else(|| "未检测到 Codex 安装".to_string())?;
    let path = PathBuf::from(installed.path);
    let directory = if path.is_file() {
        path.parent().map(PathBuf::from).unwrap_or(path)
    } else {
        path
    };
    handle
        .opener()
        .open_path(directory.to_string_lossy().to_string(), None::<String>)
        .map_err(|error| format!("打开安装目录失败: {error}"))?;
    Ok(true)
}

/// Explicitly query the selected Codex release source.
#[tauri::command]
pub async fn check_codex_runtime_update(
    source: Option<String>,
    install_mode: Option<String>,
) -> Result<CodexReleaseStatus, String> {
    require_windows()?;
    let source = parse_source(source)?;
    let install_mode = parse_install_mode(install_mode)?;
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let installed = detect_windows_codex(&portable_root);
        let current_version = installed.as_ref().map(|value| value.version.clone());
        let plan = fetch_windows_release_plan(source, Some(std::env::consts::ARCH))
            .map_err(|error| error.to_string())?;
        Ok(CodexReleaseStatus {
            update_available: plan.is_update_available(current_version.as_deref()),
            current_version,
            latest_version: plan.version,
            package_version: plan.package_version,
            source: source_label(source),
            install_mode: mode_label(install_mode),
            size_bytes: plan.size_bytes,
            released_at: plan.released_at,
        })
    })
    .await
    .map_err(|_| "检查 Codex 更新时任务中断".to_string())?
}

/// Run installation and launch diagnostics only after a user action.
#[tauri::command]
pub async fn diagnose_codex_runtime() -> Result<Vec<CodexRuntimeDiagnostic>, String> {
    require_windows()?;
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(diagnose_windows_codex(&portable_root)
            .into_iter()
            .map(|entry| CodexRuntimeDiagnostic {
                name: entry.name,
                result: entry.result,
            })
            .collect())
    })
    .await
    .map_err(|_| "Codex 诊断任务中断".to_string())?
}

async fn install_release(
    app: tauri::AppHandle,
    expected_version: Option<String>,
    source: Option<String>,
    install_mode: Option<String>,
) -> Result<CodexRuntimeOperation, String> {
    require_windows()?;
    let source = parse_source(source)?;
    let install_mode = parse_install_mode(install_mode)?;
    let root = runtime_root();
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_install")?;
        // `install_windows_release`'s `Standard` arm can silently fall back to
        // the same unguarded portable-install swap internally (e.g. when
        // sideloading is policy-blocked or the post-install health check
        // fails), so this guard must run for every mode, not just an
        // explicit `Portable` request — see `ensure_portable_root_safe_for_install`'s
        // doc comment for the swap it prevents.
        ensure_portable_root_safe_for_install(&portable_root)?;
        let plan = fetch_windows_release_plan(source, Some(std::env::consts::ARCH))
            .map_err(|error| error.to_string())?;
        if expected_version
            .as_deref()
            .is_some_and(|expected| expected != plan.version)
        {
            return Err("确认后可用版本发生变化，请重新检查更新".to_string());
        }
        let total = plan.size_bytes;
        let progress_app = app.clone();
        let progress = move |downloaded: u64| {
            let _ = progress_app.emit(
                "codex-runtime-download-progress",
                serde_json::json!({ "downloaded": downloaded, "total": total }),
            );
        };
        // 安装事务日志（TASK-007）：破坏性操作前落盘，崩溃后启动时可发现。
        let journal = InstallJournal::at(&root);
        let journal_id = journal
            .begin(
                &plan.version,
                &mode_label(install_mode),
                "mirror:latest",
                Some(&plan.sha256),
            )
            .map_err(|error| format!("写入安装事务日志失败，已中止安装: {error}"))?;
        if install_mode == InstallMode::Portable {
            // See `install_portable_release_with_observer`'s doc comment: the
            // manager crate's `install_windows_release` has no observer hook,
            // so the online path — the one users actually hit — could not
            // record rename-boundary progress into the crash journal. Bypass
            // it for this mode only.
            let mut observer = install_journal_observer(&journal, &journal_id);
            let result = install_portable_release_with_observer(
                &plan,
                &root.join("downloads"),
                &portable_root,
                &progress,
                &mut observer,
            );
            return match result {
                Ok(report) => {
                    let _ = journal.finish(&journal_id, "completed", Some(report.message.clone()));
                    fix_up_percent_encoded_portable_payload(Path::new(&report.install_root));
                    Ok(CodexRuntimeOperation {
                        version: report.version,
                        requested_mode: "portable".to_string(),
                        actual_mode: "portable".to_string(),
                        affected_path: Some(report.install_root),
                        backup_path: report.backup_path,
                        message: report.message,
                        notes: report.notes,
                    })
                }
                Err(error) => {
                    let _ = journal.finish(&journal_id, "failed", Some(error.clone()));
                    Err(error)
                }
            };
        }
        let result = install_windows_release(
            &plan,
            install_mode,
            &root.join("downloads"),
            &portable_root,
            &progress,
        );
        match &result {
            Ok(operation) => {
                let _ = journal.finish(&journal_id, "completed", Some(operation.message.clone()));
            }
            Err(error) => {
                let _ = journal.finish(&journal_id, "failed", Some(error.to_string()));
            }
        }
        result.map(operation_dto).map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Codex 安装任务中断，请先运行诊断".to_string())?
}

/// Install or update Codex after the renderer has shown a confirmation dialog.
#[tauri::command]
pub async fn apply_codex_runtime_update(
    app: tauri::AppHandle,
    expected_version: Option<String>,
    source: Option<String>,
    install_mode: Option<String>,
    confirm: bool,
) -> Result<CodexRuntimeOperation, String> {
    require_confirmation(confirm, "安装或更新 Codex")?;
    install_release(app, expected_version, source, install_mode).await
}

/// Repair Codex by reinstalling a newly verified package in the detected mode.
#[tauri::command]
pub async fn repair_codex_runtime(
    app: tauri::AppHandle,
    source: Option<String>,
    install_mode: Option<String>,
    confirm: bool,
) -> Result<CodexRuntimeOperation, String> {
    require_confirmation(confirm, "修复 Codex")?;
    require_windows()?;
    let installed = detect_windows_codex(&portable_root()?)
        .ok_or_else(|| "未检测到 Codex，请先执行安装".to_string())?;
    install_release(
        app,
        None,
        source,
        install_mode.or(Some(installed.install_mode)),
    )
    .await
}

/// Restore the latest portable backup. Standard MSIX has no local rollback slot.
#[tauri::command]
pub async fn rollback_codex_runtime(confirm: bool) -> Result<CodexRuntimeOperation, String> {
    require_confirmation(confirm, "回滚 Codex")?;
    require_windows()?;
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_rollback")?;
        match detect_windows_codex(&portable_root) {
            Some(installed) => {
                if maintenance_route(Some(&installed)) != MaintenanceRoute::Portable {
                    return Err("标准安装由 Windows 管理，没有本地回滚副本".to_string());
                }
                rollback_portable_install(&portable_root)
                    .map(operation_dto)
                    .map_err(|error| error.to_string())
            }
            // The install root can go missing if a portable install/update was
            // interrupted (crash, forced exit, power loss) between "move
            // current install to rollback backup" and "move new payload into
            // place" — see `ensure_portable_root_safe_for_install` for the
            // destructive-window details. The engine's own
            // `rollback_portable_install` refuses in this exact state (it
            // requires `portable_root.is_dir()`), even though the backup sits
            // intact right next to it. Recover it ourselves: locate the
            // newest `Codex.rollback-*` sibling and rename it back into
            // place, mirroring what the engine does internally.
            None if !portable_root.is_dir() => {
                let backup = latest_portable_rollback(&portable_root)
                    .map_err(|error| format!("查找回滚备份失败: {error}"))?
                    .ok_or_else(|| "未检测到 Codex，且没有可用的回滚备份".to_string())?;
                codex_win_engine::rename_directory_with_retry(
                    "restore portable rollback after missing install root",
                    &backup,
                    &portable_root,
                )
                .map_err(|error| format!("恢复回滚备份失败: {error}"))?;
                let restored = detect_portable_codex(&portable_root)
                    .ok_or_else(|| "回滚备份恢复后仍未检测到有效的 Codex 安装".to_string())?;
                Ok(CodexRuntimeOperation {
                    version: restored.version,
                    requested_mode: "portable".to_string(),
                    actual_mode: "portable".to_string(),
                    affected_path: Some(portable_root.to_string_lossy().to_string()),
                    backup_path: None,
                    message: "Codex 安装目录缺失（可能是上次安装被中断），已从回滚备份恢复。"
                        .to_string(),
                    notes: Vec::new(),
                })
            }
            None => Err("未检测到 Codex".to_string()),
        }
    })
    .await
    .map_err(|_| "Codex 回滚任务中断，请运行诊断".to_string())?
}

/// Uninstall Codex while preserving the user's `~/.codex` data.
#[tauri::command]
pub async fn uninstall_codex_runtime(confirm: bool) -> Result<CodexRuntimeOperation, String> {
    require_confirmation(confirm, "卸载 Codex")?;
    require_windows()?;
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_uninstall")?;
        uninstall_windows_codex(&portable_root)
            .map(operation_dto)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Codex 卸载任务中断，请运行诊断".to_string())?
}

// ─── v2.5.0 M3：历史版本、离线安装与安装事务恢复 ─────────────────────────

/// Chimera 自有 Codex 镜像仓库（与 `chimera_runtime` 的 latest 端点同源）。
const MIRROR_REPO: &str = "Duojiyi/codex-app-mirror";
/// 离线安装包大小上限：防御异常/恶意文件的无界读取。
const OFFLINE_PACKAGE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// 镜像仓库某个发布 tag 的资产下载前缀。
fn mirror_tag_download_base(tag: &str) -> String {
    format!("https://github.com/{MIRROR_REPO}/releases/download/{tag}")
}

/// tag 只允许 GitHub release tag 的保守字符集，防止 URL 注入。
fn validate_mirror_tag(tag: &str) -> Result<(), String> {
    let valid = !tag.is_empty()
        && tag.len() <= 100
        && tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err("版本 tag 含有非法字符".to_string())
    }
}

/// 目录/清单抓取的请求超时（秒）。
const MIRROR_FETCH_TIMEOUT_SECS: u64 = 20;
/// 目录/清单响应体积上限（防异常响应无界读取）。
const MIRROR_CATALOG_MAX_BYTES: usize = 8 * 1024 * 1024;
/// 发送给镜像仓库的标准 User-Agent（避免被 GitHub API 当作脚本而拒绝）。
const MIRROR_USER_AGENT: &str = "chimera-plus-plus";

/// 通过应用内 reqwest 客户端抓取镜像仓库的文本资源，跟随全局代理设置。
///
/// 取代进程外 `codex_win_engine::fetch_text`（curl）：后者对大响应体存在
/// 管道背压死锁 —— `run_capturing` 先等进程退出、之后才读 stdout，Windows
/// 匿名管道缓冲区仅约 4KB，而 GitHub Releases 目录约 400KB+，curl 写满管道
/// 后被阻塞、进程无法退出，历史版本目录因此长期卡在“正在加载”。
async fn fetch_mirror_text(url: &str) -> Result<String, String> {
    let client = crate::proxy::http_client::get();
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, MIRROR_USER_AGENT)
        .timeout(Duration::from_secs(MIRROR_FETCH_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|error| format!("请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        // 附带有限错误体（如 GitHub API 速率限制信息），便于用户/日志排障。
        let detail = response
            .bytes()
            .await
            .map(|bytes| String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).into_owned())
            .unwrap_or_default();
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}: {detail}")
        });
    }
    if response
        .content_length()
        .is_some_and(|len| len > MIRROR_CATALOG_MAX_BYTES as u64)
    {
        return Err(format!("响应超过 {} 字节上限", MIRROR_CATALOG_MAX_BYTES));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取响应失败: {error}"))?;
    if bytes.len() > MIRROR_CATALOG_MAX_BYTES {
        return Err(format!("响应超过 {} 字节上限", MIRROR_CATALOG_MAX_BYTES));
    }
    String::from_utf8(bytes.to_vec()).map_err(|error| format!("响应不是有效 UTF-8: {error}"))
}

/// 从 GitHub Releases 数组提取可展示/可安装的历史版本条目（纯函数，便于测试）。
fn releases_from_items(items: &[serde_json::Value]) -> Vec<CodexRuntimeRelease> {
    items
        .iter()
        .filter_map(|item| {
            let tag = item.get("tag_name")?.as_str()?.to_string();
            let asset_names: Vec<&str> = item
                .get("assets")
                .and_then(|assets| assets.as_array())
                .map(|assets| {
                    assets
                        .iter()
                        .filter_map(|asset| asset.get("name").and_then(|name| name.as_str()))
                        .collect()
                })
                .unwrap_or_default();
            let installable = asset_names.contains(&"release-manifest.json")
                && asset_names.contains(&"SHA256SUMS-windows.txt");
            Some(CodexRuntimeRelease {
                tag,
                name: item
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                published_at: item
                    .get("published_at")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                prerelease: item
                    .get("prerelease")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
                installable,
            })
        })
        .collect()
}

/// 当前主机对应的 MSIX 架构标识。
fn msix_architecture_for_current_host() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeRelease {
    pub tag: String,
    pub name: Option<String>,
    pub published_at: Option<String>,
    pub prerelease: bool,
    /// 该发布是否带有可安装的 Windows 资产（manifest + checksums）。
    pub installable: bool,
}

/// 分页列出镜像仓库的历史 Codex 版本（TASK-009）。
#[tauri::command]
pub async fn list_codex_runtime_releases(
    page: Option<u32>,
) -> Result<Vec<CodexRuntimeRelease>, String> {
    require_windows()?;
    let page = page.unwrap_or(1).clamp(1, 50);
    let url =
        format!("https://api.github.com/repos/{MIRROR_REPO}/releases?per_page=10&page={page}");
    let body = fetch_mirror_text(&url)
        .await
        .map_err(|error| format!("获取历史版本目录失败: {error}"))?;
    let releases: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| format!("解析历史版本目录失败: {error}"))?;
    let Some(items) = releases.as_array() else {
        return Err("历史版本目录格式异常".to_string());
    };
    Ok(releases_from_items(items))
}

/// 解析指定历史版本的安装计划（TASK-009 / TASK-028）。
///
/// 返回的 `WindowsReleasePlan` 就是安装确认对象：版本、构建、资产、来源、
/// SHA-256 与大小全部锁定；前端确认后原样传回 `install_codex_runtime_release`，
/// 后台目录刷新不会改变已确认的目标。
#[tauri::command]
pub async fn plan_codex_runtime_release(tag: String) -> Result<WindowsReleasePlan, String> {
    require_windows()?;
    validate_mirror_tag(&tag)?;
    let base = mirror_tag_download_base(&tag);
    let manifest = fetch_mirror_text(&format!("{base}/release-manifest.json"))
        .await
        .map_err(|error| format!("获取该版本清单失败: {error}"))?;
    let checksums = fetch_mirror_text(&format!("{base}/SHA256SUMS-windows.txt"))
        .await
        .map_err(|error| format!("获取该版本校验和失败: {error}"))?;
    let mut plan = parse_windows_release_plan(
        &manifest,
        &checksums,
        UpdateSource::Mirror,
        Some(std::env::consts::ARCH),
    )
    .map_err(|error| error.to_string())?;
    // parse_windows_release_plan 生成的下载地址指向 latest；
    // 历史安装必须把下载源锁定到所选 tag，与该 tag 的校验和绑定。
    plan.package_url = format!("{base}/{}.Msix", plan.package_moniker);
    Ok(plan)
}

/// 按用户确认过的安装计划安装指定版本（TASK-009 / TASK-028）。
#[tauri::command]
pub async fn install_codex_runtime_release(
    app: tauri::AppHandle,
    plan: WindowsReleasePlan,
    install_mode: Option<String>,
    confirm: bool,
) -> Result<CodexRuntimeOperation, String> {
    require_confirmation(confirm, "安装所选 Codex 版本")?;
    require_windows()?;
    let install_mode = parse_install_mode(install_mode)?;
    // 目标锁定：确认对象的下载地址必须位于受信任的镜像发布源内。
    let trusted_prefix = format!("https://github.com/{MIRROR_REPO}/releases/");
    if !plan.package_url.starts_with(&trusted_prefix) {
        return Err("安装包地址不在受信任的镜像发布源内".to_string());
    }
    let root = runtime_root();
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_install")?;
        // See `install_release`'s matching comment: `Standard` mode can fall
        // back internally to the same unguarded portable-install swap.
        ensure_portable_root_safe_for_install(&portable_root)?;
        let journal = InstallJournal::at(&root);
        let journal_id = journal
            .begin(
                &plan.version,
                &mode_label(install_mode),
                &format!("mirror:{}", plan.package_moniker),
                Some(&plan.sha256),
            )
            .map_err(|error| format!("写入安装事务日志失败，已中止安装: {error}"))?;
        let total = plan.size_bytes;
        let progress_app = app.clone();
        let progress = move |downloaded: u64| {
            let _ = progress_app.emit(
                "codex-runtime-download-progress",
                serde_json::json!({ "downloaded": downloaded, "total": total }),
            );
        };
        if install_mode == InstallMode::Portable {
            // See `install_portable_release_with_observer`'s doc comment.
            let mut observer = install_journal_observer(&journal, &journal_id);
            let result = install_portable_release_with_observer(
                &plan,
                &root.join("downloads"),
                &portable_root,
                &progress,
                &mut observer,
            );
            return match result {
                Ok(report) => {
                    let _ = journal.finish(&journal_id, "completed", Some(report.message.clone()));
                    fix_up_percent_encoded_portable_payload(Path::new(&report.install_root));
                    Ok(CodexRuntimeOperation {
                        version: report.version,
                        requested_mode: "portable".to_string(),
                        actual_mode: "portable".to_string(),
                        affected_path: Some(report.install_root),
                        backup_path: report.backup_path,
                        message: report.message,
                        notes: report.notes,
                    })
                }
                Err(error) => {
                    let _ = journal.finish(&journal_id, "failed", Some(error.clone()));
                    Err(error)
                }
            };
        }
        let result = install_windows_release(
            &plan,
            install_mode,
            &root.join("downloads"),
            &portable_root,
            &progress,
        );
        match &result {
            Ok(operation) => {
                let _ = journal.finish(&journal_id, "completed", Some(operation.message.clone()));
            }
            Err(error) => {
                let _ = journal.finish(&journal_id, "failed", Some(error.to_string()));
            }
        }
        result.map(operation_dto).map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Codex 安装任务中断，请先运行诊断".to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOfflinePackageInspection {
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub signature_valid: bool,
    pub package_name: String,
    pub publisher: String,
    pub package_version: String,
    pub architecture: String,
    pub architecture_matches: bool,
    pub identity_valid: bool,
}

/// 检查本地离线安装包并返回确认页所需的全部校验信息（TASK-010）。
///
/// 只读操作：读取 → 大小上限 → SHA-256 → Authenticode → MSIX 身份/架构。
#[tauri::command]
pub async fn inspect_codex_runtime_package(
    file_path: String,
) -> Result<CodexOfflinePackageInspection, String> {
    require_windows()?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&file_path);
        if !path.is_file() {
            return Err("离线安装包不存在".to_string());
        }
        let is_msix = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("msix"));
        if !is_msix {
            return Err("离线安装当前仅支持官方 .Msix 安装包".to_string());
        }
        let size_bytes = path
            .metadata()
            .map_err(|error| format!("读取安装包信息失败: {error}"))?
            .len();
        if size_bytes == 0 || size_bytes > OFFLINE_PACKAGE_MAX_BYTES {
            return Err("安装包大小异常，已拒绝".to_string());
        }
        let sha256 = codex_win_engine::sha256_file(&path)
            .map_err(|error| format!("计算安装包哈希失败: {error}"))?;
        let signature_valid = codex_win_engine::verify_openai_authenticode(&path)
            .map(|report| report.is_valid_openai())
            .unwrap_or(false);
        let identity = codex_win_engine::read_msix_identity(&path)
            .map_err(|error| format!("读取 MSIX 身份失败: {error}"))?;
        let expected_arch = msix_architecture_for_current_host();
        Ok(CodexOfflinePackageInspection {
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default(),
            size_bytes,
            sha256,
            signature_valid,
            package_name: identity.name.clone(),
            publisher: identity.publisher.clone(),
            package_version: identity.version.clone(),
            architecture: identity.processor_architecture.clone(),
            architecture_matches: identity
                .processor_architecture
                .eq_ignore_ascii_case(expected_arch),
            identity_valid: identity.name == codex_win_engine::OPENAI_PACKAGE_IDENTITY,
        })
    })
    .await
    .map_err(|_| "检查离线安装包任务中断".to_string())?
}

/// 离线安装本地 `.Msix`（TASK-007 / TASK-010）。
///
/// 全部校验在安装前完成且不访问网络：哈希必须与确认页一致（目标锁定）、
/// Authenticode 必须是 OpenAI 发行者、包身份必须是 Codex、架构必须匹配。
/// 安装走便携模式，并通过 `PortableBoundary` 观察者把每个 rename 边界
/// 与真实备份目录写入安装事务日志，供崩溃恢复使用。
#[tauri::command]
pub async fn install_codex_runtime_offline(
    file_path: String,
    expected_sha256: String,
    confirm: bool,
) -> Result<CodexRuntimeOperation, String> {
    require_confirmation(confirm, "离线安装 Codex")?;
    require_windows()?;
    let root = runtime_root();
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_install")?;
        ensure_portable_root_safe_for_install(&portable_root)?;
        let path = PathBuf::from(&file_path);
        if !path.is_file() {
            return Err("离线安装包不存在".to_string());
        }
        let size_bytes = path
            .metadata()
            .map_err(|error| format!("读取安装包信息失败: {error}"))?
            .len();
        if size_bytes == 0 || size_bytes > OFFLINE_PACKAGE_MAX_BYTES {
            return Err("安装包大小异常，已拒绝".to_string());
        }
        let sha256 = codex_win_engine::sha256_file(&path)
            .map_err(|error| format!("计算安装包哈希失败: {error}"))?;
        if !sha256.eq_ignore_ascii_case(expected_sha256.trim()) {
            return Err("安装包内容在确认后发生变化，已中止安装".to_string());
        }
        let signature = codex_win_engine::verify_openai_authenticode(&path)
            .map_err(|error| format!("验证安装包签名失败: {error}"))?;
        if !signature.is_valid_openai() {
            return Err("安装包未通过 OpenAI 发行者签名校验，已拒绝安装".to_string());
        }
        let identity = codex_win_engine::read_msix_identity(&path)
            .map_err(|error| format!("读取 MSIX 身份失败: {error}"))?;
        if identity.name != codex_win_engine::OPENAI_PACKAGE_IDENTITY {
            return Err(format!("包身份不是 Codex（{}），已拒绝安装", identity.name));
        }
        let expected_arch = msix_architecture_for_current_host();
        if !identity
            .processor_architecture
            .eq_ignore_ascii_case(expected_arch)
        {
            return Err(format!(
                "安装包架构 {} 与本机 {expected_arch} 不匹配，已拒绝安装",
                identity.processor_architecture
            ));
        }

        let journal = InstallJournal::at(&root);
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let journal_id = journal
            .begin(
                &identity.version,
                "portable",
                &format!("offline:{file_name}"),
                Some(&sha256),
            )
            .map_err(|error| format!("写入安装事务日志失败，已中止安装: {error}"))?;

        let journal_ref = &journal;
        let journal_entry_id = journal_id.clone();
        let mut observer = |boundary: codex_win_engine::PortableBoundary| {
            use codex_win_engine::PortableBoundary as Boundary;
            let (state, backup) = match &boundary {
                Boundary::BeforeMoveOld { backup, .. } => {
                    ("moving:before_move_old", Some(backup.clone()))
                }
                Boundary::AfterMoveOld { backup, .. } => {
                    ("moving:after_move_old", Some(backup.clone()))
                }
                Boundary::BeforeMoveNew { backup, .. } => {
                    ("moving:before_move_new", Some(backup.clone()))
                }
                Boundary::AfterMoveNew { backup, .. } => {
                    ("moving:after_move_new", Some(backup.clone()))
                }
                // v0.5.2 新增：安装失败决定回滚时、消耗备份之前先持久化意图。
                Boundary::BeforeRollback { backup, .. } => {
                    ("moving:before_rollback", Some(backup.clone()))
                }
                Boundary::RollbackCompleted { backup, .. } => {
                    ("moving:rollback_completed", Some(backup.clone()))
                }
            };
            // 日志写入失败不得中断破坏性窗口内的安装，仅告警。
            if let Err(error) = journal_ref.update(&journal_entry_id, |entry| {
                entry.state = state.to_string();
                if let Some(backup) = &backup {
                    entry.backup_path = Some(backup.to_string_lossy().to_string());
                }
            }) {
                log::warn!("[InstallJournal] 边界状态写入失败: {error}");
            }
            Ok(())
        };
        let result = codex_win_engine::install_portable_from_msix_with_observer(
            &path,
            &portable_root,
            true,
            false,
            &mut observer,
        );
        match result {
            Ok(report) => {
                let _ = journal.finish(&journal_id, "completed", Some(report.message.clone()));
                fix_up_percent_encoded_portable_payload(Path::new(&report.install_root));
                Ok(CodexRuntimeOperation {
                    version: report.version,
                    requested_mode: "portable".to_string(),
                    actual_mode: "portable".to_string(),
                    affected_path: Some(report.install_root),
                    backup_path: report.backup_path,
                    message: report.message,
                    notes: report.notes,
                })
            }
            Err(error) => {
                let _ = journal.finish(&journal_id, "failed", Some(error.to_string()));
                Err(format!("离线安装失败: {error}"))
            }
        }
    })
    .await
    .map_err(|_| "离线安装任务中断".to_string())?
}

/// 读取等待用户处理的中断安装事务（TASK-008）。
#[tauri::command]
pub async fn get_codex_install_recovery() -> Result<Vec<InstallJournalEntry>, String> {
    if !cfg!(target_os = "windows") {
        return Ok(Vec::new());
    }
    let root = runtime_root();
    tauri::async_runtime::spawn_blocking(move || Ok(InstallJournal::at(&root).pending_recovery()))
        .await
        .map_err(|_| "读取安装恢复记录任务中断".to_string())?
}

/// 用户处理完一个中断事务（已回滚或确认忽略）后关闭该记录（TASK-008）。
#[tauri::command]
pub async fn acknowledge_codex_install_recovery(id: String) -> Result<(), String> {
    require_windows()?;
    let root = runtime_root();
    tauri::async_runtime::spawn_blocking(move || {
        InstallJournal::at(&root)
            .acknowledge(&id)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "更新安装恢复记录任务中断".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        launch_action, normalize_expected_catalog_models, parse_catalog_model_identities,
        process_install_mode, validate_catalog_model_identities,
        validate_runtime_models_contain_expected, CatalogModelIdentity, CodexModelCatalogStatus,
        CodexProcessStatus, CodexRuntimeStatus, ExpectedCodexCatalogModel,
    };

    fn identity(slug: &str, display_name: &str) -> CatalogModelIdentity {
        CatalogModelIdentity {
            slug: slug.to_string(),
            display_name: display_name.to_string(),
        }
    }

    #[test]
    fn runtime_validation_tolerates_extra_entries_and_reordering() {
        let expected = normalize_expected_catalog_models(
            "gpt-5.5",
            Some(vec![
                ExpectedCodexCatalogModel {
                    model: "gpt-5.5".to_string(),
                    display_name: Some("GPT-5.5".to_string()),
                },
                ExpectedCodexCatalogModel {
                    model: "gpt-5.5-codex".to_string(),
                    display_name: Some("GPT-5.5 Codex".to_string()),
                },
            ]),
        )
        .expect("expected mapping normalizes");

        // Codex merges its own entries in and does not promise file order, so a
        // healthy install legitimately reports a superset in a different order.
        let actual = vec![
            identity("gpt-5.5-codex", "GPT-5.5 Codex"),
            identity("gpt-5.1-codex-max", "GPT-5.1 Codex Max"),
            identity("gpt-5.5", "GPT-5.5 (Chimera)"),
        ];

        assert!(
            validate_runtime_models_contain_expected(&expected, &actual, "Codex 实际模型列表")
                .is_ok(),
            "a superset in a different order must pass the runtime check"
        );
    }

    #[test]
    fn runtime_validation_still_reports_a_genuinely_missing_model() {
        let expected = normalize_expected_catalog_models(
            "gpt-5.5",
            Some(vec![
                ExpectedCodexCatalogModel {
                    model: "gpt-5.5".to_string(),
                    display_name: None,
                },
                ExpectedCodexCatalogModel {
                    model: "gpt-5.5-codex".to_string(),
                    display_name: None,
                },
            ]),
        )
        .expect("expected mapping normalizes");
        // The historical failure this probe exists to catch: only Codex's single
        // `custom` entry survives, so the configured models are invisible.
        let actual = vec![identity("custom", "Custom")];

        let error =
            validate_runtime_models_contain_expected(&expected, &actual, "Codex 实际模型列表")
                .expect_err("a missing model must still be reported");
        assert!(error.contains("gpt-5.5"), "got {error}");
        assert!(error.contains("gpt-5.5-codex"), "got {error}");
    }

    #[test]
    fn catalog_status_reports_runtime_verification_separately() {
        // The renderer distinguishes "catalog written" from "runtime confirmed";
        // an unverifiable probe must still arrive as valid == true.
        let status = CodexModelCatalogStatus {
            valid: true,
            default_model: "gpt-5.5".to_string(),
            catalog_path: Some("/Users/me/.codex/cc-switch-model-catalog.json".to_string()),
            model_count: 3,
            runtime_verified: false,
            runtime_message: Some("未找到可用的 Codex CLI".to_string()),
        };
        let json = serde_json::to_value(status).expect("status serializes");
        assert_eq!(json["valid"], true);
        assert_eq!(json["runtimeVerified"], false);
        assert_eq!(json["runtimeMessage"], "未找到可用的 Codex CLI");
        assert!(json.get("runtime_verified").is_none());
    }

    #[test]
    fn launch_action_replaces_a_running_instance() {
        assert_eq!(launch_action(false), "launched");
        assert_eq!(launch_action(true), "restarted");
    }

    #[test]
    fn process_install_mode_keeps_customer_labels_stable() {
        assert_eq!(process_install_mode("portable"), "portable");
        assert_eq!(process_install_mode("msix"), "standard");
    }

    #[test]
    fn process_status_serializes_as_renderer_contract() {
        let status = CodexProcessStatus {
            supported: true,
            installed: true,
            running: false,
            install_mode: Some("portable".to_string()),
            official_login_available: true,
        };
        let json = serde_json::to_value(status).expect("status serializes");
        assert_eq!(json["installed"], true);
        assert_eq!(json["supported"], true);
        assert_eq!(json["running"], false);
        assert_eq!(json["installMode"], "portable");
        assert_eq!(json["officialLoginAvailable"], true);
        assert!(json.get("install_mode").is_none());
    }

    #[test]
    fn catalog_validation_rejects_a_partial_mapping() {
        let expected = normalize_expected_catalog_models(
            "claude-opus-4-5-2025",
            Some(vec![
                ExpectedCodexCatalogModel {
                    model: "claude-opus-4-5-2025".to_string(),
                    display_name: Some("Claude Opus 4.5".to_string()),
                },
                ExpectedCodexCatalogModel {
                    model: "claude-sonnet-4-5-20250929".to_string(),
                    display_name: Some("Claude Sonnet 4.5".to_string()),
                },
            ]),
        )
        .expect("expected mapping normalizes");
        let actual = vec![CatalogModelIdentity {
            slug: "claude-opus-4-5-2025".to_string(),
            display_name: "Claude Opus 4.5".to_string(),
        }];

        let error = validate_catalog_model_identities(&expected, &actual, "测试目录")
            .expect_err("partial mapping must fail");
        assert!(error.contains("期望 2 个，实际 1 个"));
    }

    #[test]
    fn catalog_validation_rejects_wrong_display_name_and_duplicate_slug() {
        let expected = normalize_expected_catalog_models(
            "claude-opus-4-5-2025",
            Some(vec![ExpectedCodexCatalogModel {
                model: "claude-opus-4-5-2025".to_string(),
                display_name: Some("Claude Opus 4.5".to_string()),
            }]),
        )
        .expect("expected mapping normalizes");
        let duplicate = vec![
            CatalogModelIdentity {
                slug: "claude-opus-4-5-2025".to_string(),
                display_name: "Claude Opus 4.5".to_string(),
            },
            CatalogModelIdentity {
                slug: "claude-opus-4-5-2025".to_string(),
                display_name: "Claude Opus 4.5".to_string(),
            },
        ];
        let error = validate_catalog_model_identities(&expected, &duplicate, "运行时目录")
            .expect_err("duplicate slug must fail");
        assert!(error.contains("数量不一致") || error.contains("重复 slug"));

        let wrong_display = vec![CatalogModelIdentity {
            slug: "claude-opus-4-5-2025".to_string(),
            display_name: "Opus".to_string(),
        }];
        let error = validate_catalog_model_identities(&expected, &wrong_display, "运行时目录")
            .expect_err("wrong display name must fail");
        assert!(error.contains("显示名不一致"));
    }

    #[test]
    fn catalog_json_parser_requires_slug_and_display_name() {
        let models = vec![serde_json::json!({
            "slug": "claude-opus-4-5-2025",
            "display_name": "Claude Opus 4.5",
        })];
        let parsed = parse_catalog_model_identities(&models, "目录").expect("valid model");
        assert_eq!(parsed[0].slug, "claude-opus-4-5-2025");
        assert_eq!(parsed[0].display_name, "Claude Opus 4.5");

        let missing_display = vec![serde_json::json!({
            "slug": "claude-opus-4-5-2025",
        })];
        let error = parse_catalog_model_identities(&missing_display, "目录")
            .expect_err("display name is required");
        assert!(error.contains("display_name"));
    }

    #[test]
    fn unsupported_runtime_status_is_explicit_and_non_actionable() {
        let status = CodexRuntimeStatus {
            supported: false,
            installed: false,
            version: None,
            install_mode: None,
            install_path: None,
            portable_root: String::new(),
            can_repair: false,
            can_rollback: false,
            can_uninstall: false,
            history: Vec::new(),
        };
        let json = serde_json::to_value(status).expect("status serializes");
        assert_eq!(json["supported"], false);
        assert_eq!(json["installed"], false);
        assert_eq!(json["canRepair"], false);
        assert_eq!(json["canRollback"], false);
        assert_eq!(json["canUninstall"], false);
    }

    #[test]
    fn release_catalog_maps_installable_windows_assets() {
        let items = serde_json::json!([
            {
                "tag_name": "codex-app-26.0.0",
                "name": "Codex 26.0.0",
                "published_at": "2026-08-01T00:00:00Z",
                "prerelease": false,
                "assets": [
                    {"name": "release-manifest.json"},
                    {"name": "SHA256SUMS-windows.txt"},
                    {"name": "codex-26.0.0.Msix"}
                ]
            },
            {
                "tag_name": "codex-app-25.0.0",
                "name": null,
                "published_at": null,
                "prerelease": true,
                "assets": [{"name": "codex-25.0.0.Msix"}]
            }
        ]);
        let items = items.as_array().expect("array");
        let releases = super::releases_from_items(items);
        assert_eq!(releases.len(), 2);
        assert_eq!(releases[0].tag, "codex-app-26.0.0");
        assert!(releases[0].installable);
        assert!(!releases[0].prerelease);
        assert_eq!(releases[0].name.as_deref(), Some("Codex 26.0.0"));
        assert_eq!(releases[1].tag, "codex-app-25.0.0");
        assert!(!releases[1].installable);
        assert!(releases[1].prerelease);
        assert!(releases[1].name.is_none());
    }
}
