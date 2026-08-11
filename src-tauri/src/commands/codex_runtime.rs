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
    maintenance_route, rollback_portable_install, uninstall_windows_codex, InstallMode,
    MaintenanceRoute, UpdateSource,
};
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
        options.remote_debugging_port = Some(crate::codex_cdp::CODEX_RENDERER_DEBUG_PORT);
    }
    options
}

fn renderer_unlock_status(
    installed: &codex_win_engine::InstalledWindowsCodex,
) -> crate::codex_cdp::CodexModelUnlockStatus {
    let status = if renderer_unlock_available(installed) {
        crate::codex_cdp::inject_codex_model_unlock(crate::codex_cdp::CODEX_RENDERER_DEBUG_PORT)
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
    // MSIX activation can take longer than a direct portable spawn on a cold
    // system, so allow a bounded ten-second window before declaring failure.
    for _ in 0..40 {
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
    let debug_port = crate::codex_cdp::CODEX_RENDERER_DEBUG_PORT;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(crate::codex_cdp::probe_codex_renderer_unlock(debug_port))
    })
    .await
    .map_err(|error| format!("探测 Codex renderer 注入状态时任务中断: {error}"))?
}

/// Launch the managed Codex installation, replacing a running managed instance
/// first. The deprecated optional flag is accepted only for IPC compatibility:
/// lifecycle policy is backend-owned and a running target is always restarted.
///
/// The cross-process lock covers discovery, shutdown, launch, and health
/// verification. Process discovery and termination are path-pinned in
/// `codex_win_engine`, so unrelated Electron or ChatGPT processes are never
/// selected.
#[tauri::command]
pub async fn open_codex_runtime(
    restart_if_running: Option<bool>,
) -> Result<CodexLaunchResult, String> {
    // Keep accepting the old renderer argument without allowing it to weaken
    // the safe restart policy. The renderer submits launch intent only.
    let _legacy_restart_preference = restart_if_running;
    require_windows()?;
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_launch")?;
        let installed = codex_win_engine::detect_installed_codex(&portable_root)
            .ok_or_else(|| "未检测到 Codex 安装".to_string())?;
        let was_running = codex_is_running(&installed)?;
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
        install_windows_release(
            &plan,
            install_mode,
            &root.join("downloads"),
            &portable_root,
            &progress,
        )
        .map(operation_dto)
        .map_err(|error| error.to_string())
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
        let installed =
            detect_windows_codex(&portable_root).ok_or_else(|| "未检测到 Codex".to_string())?;
        if maintenance_route(Some(&installed)) != MaintenanceRoute::Portable {
            return Err("标准安装由 Windows 管理，没有本地回滚副本".to_string());
        }
        let _guard = acquire_operation_lock("codex_runtime_rollback")?;
        rollback_portable_install(&portable_root)
            .map(operation_dto)
            .map_err(|error| error.to_string())
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
}
