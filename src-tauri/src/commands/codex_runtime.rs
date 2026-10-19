//! Codex desktop runtime management backed by the audited Chimera runtime crate.
//!
//! Provider projection and application installation intentionally remain
//! separate write domains. Every runtime mutation takes a cross-process lock
//! and requires explicit confirmation from the renderer.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use chimera_platform::lock::{LockError, LockGuard, OperationLock};
use chimera_runtime::manager::{
    detect_portable_codex, latest_portable_rollback, maintenance_route, parse_windows_release_plan,
    rollback_portable_install, uninstall_windows_codex, InstallMode, MaintenanceRoute,
    UpdateSource, WindowsReleasePlan,
};

use crate::services::codex_install_journal::{InstallJournal, InstallJournalEntry};
use crate::services::codex_portable_layout::{self, LayoutMigrationOutcome, PortableLayout};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeDiagnostic {
    pub name: String,
    pub result: String,
    /// Stable lowercase reason code for a `warn`/`fail` item, e.g.
    /// `not-installed`, `layout`, `executable`, `not-registered`,
    /// `package-status`, `manifest`, `dependencies`, `launch`, `main-window`,
    /// `timeout`, `probe`, `permissions`, `signature`. Omitted when passing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// One plain-Chinese sentence with the specific reason and the next step.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CodexRuntimeDiagnostic {
    fn new(name: &str, result: &str) -> Self {
        Self {
            name: name.to_string(),
            result: result.to_string(),
            kind: None,
            detail: None,
        }
    }

    fn check(name: &str, passed: bool) -> Self {
        Self::new(name, if passed { "pass" } else { "fail" })
    }

    /// Attach the reason. A passing item never carries one, so the renderer
    /// can treat a present `detail` as authoritative.
    fn because(mut self, kind: &str, detail: impl Into<String>) -> Self {
        if self.result != "pass" {
            self.kind = Some(kind.to_string());
            self.detail = Some(detail.into());
        }
        self
    }
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
    /// `flat` | `nested` | `interrupted` for a portable root; omitted otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portable_layout: Option<String>,
    /// One plain-Chinese sentence about the portable layout, when relevant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout_notice: Option<String>,
    /// A registered MSIX found next to the managed portable install.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unmanaged_standard_version: Option<String>,
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
    /// Codex is running but no stable main window appeared within the
    /// startup budget: launched, not failed.
    pub startup_slow: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_notice: Option<String>,
    /// The portable layout migration run before this launch, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout_migration: Option<LayoutMigrationOutcome>,
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

/// Keep at most the single newest `Codex.rollback-*` sibling and the single
/// newest `Codex.replaced-*` sibling of `portable_root`, deleting older ones
/// of each prefix.
///
/// The two prefixes must be swept as SEPARATE pools, never compared against
/// each other by mtime: the pinned engine's `latest_portable_rollback` (the
/// function `rollback_codex_runtime` and the crash-recovery banner act on)
/// matches only `Codex.rollback-*` — `Codex.replaced-*` (left behind when a
/// user rolls back) is restorable by no code path at all, only useful for
/// manual recovery. A pooled newest-by-mtime sweep would, after a
/// "roll back to v1, then a later update crashes" sequence, delete the
/// journal-referenced `rollback-*` (older extraction mtime) in favor of an
/// unrestorable `replaced-*` — destroying the exact crash-recovery backup
/// this install flow depends on, before the new download even starts.
///
/// Within one prefix, older entries genuinely are unreachable: the engine
/// deletes its `rollback-*` after each successful install, so survivors are
/// crash artifacts, and both the engine's restore and our recovery arm pick
/// the newest by mtime. Best-effort: read/delete failures are logged and
/// otherwise ignored — opportunistic hygiene, not a correctness requirement
/// of the caller.
fn sweep_stale_portable_backups(portable_root: &Path) {
    let Some(parent) = portable_root.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    let mut rollback_backups: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut replaced_backups: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let pool = if name.starts_with("Codex.rollback-") {
            &mut rollback_backups
        } else if name.starts_with("Codex.replaced-") {
            &mut replaced_backups
        } else {
            continue;
        };
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
        pool.push((modified, entry.path()));
    }
    for backups in [&mut rollback_backups, &mut replaced_backups] {
        if backups.len() <= 1 {
            continue;
        }
        backups.sort_by_key(|(modified, _)| *modified);
        // Keep the last (newest) entry of this prefix; remove the rest.
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

/// Whether the detected Codex desktop installation currently owns a process,
/// with the same path-pinned discovery as `get_codex_process_status`. Only
/// Windows has a managed desktop install; elsewhere this reports `false`.
pub(crate) fn codex_desktop_is_running() -> Result<bool, String> {
    if !cfg!(target_os = "windows") {
        return Ok(false);
    }
    let portable_root = portable_root()?;
    match detect_managed_codex(&portable_root) {
        Some(installed) => codex_is_running(&installed),
        None => Ok(false),
    }
}

/// Which installation Chimera++ manages when a registered MSIX and a portable
/// install exist side by side. Without a portable preference MSIX wins, as
/// before; with one the portable install wins, so "install the portable build"
/// is not followed by launching or uninstalling the Store package.
fn select_managed(
    msix: Option<codex_win_engine::InstalledWindowsCodex>,
    portable: Option<codex_win_engine::InstalledWindowsCodex>,
    prefer_portable: bool,
) -> Option<codex_win_engine::InstalledWindowsCodex> {
    match (msix, portable) {
        (Some(_), Some(portable)) if prefer_portable => Some(portable),
        (Some(msix), _) => Some(msix),
        (None, portable) => portable,
    }
}

/// The user chose the portable build: in settings, or by their most recent
/// completed install through Chimera++.
fn portable_preferred() -> bool {
    if crate::settings::get_settings().codex_install_mode == "portable" {
        return true;
    }
    InstallJournal::at(&runtime_root())
        .load()
        .iter()
        .rev()
        .find(|entry| entry.state == "completed")
        .is_some_and(|entry| entry.install_mode == "portable")
}

/// Both candidates: the registered MSIX (if any) and the portable install at
/// `portable_root` (if any).
fn detect_candidates(
    portable_root: &Path,
) -> (
    Option<codex_win_engine::InstalledWindowsCodex>,
    Option<codex_win_engine::InstalledWindowsCodex>,
) {
    match codex_win_engine::detect_installed_codex(portable_root) {
        // MSIX detection runs first; a portable result means there is no MSIX.
        Some(found) if found.source == "portable" => (None, Some(found)),
        Some(msix) => (
            Some(msix),
            codex_win_engine::detect_portable_install(portable_root),
        ),
        None => (None, None),
    }
}

pub(crate) fn detect_managed_codex(
    portable_root: &Path,
) -> Option<codex_win_engine::InstalledWindowsCodex> {
    let (msix, portable) = detect_candidates(portable_root);
    let prefer_portable = portable.is_some() && msix.is_some() && portable_preferred();
    select_managed(msix, portable, prefer_portable)
}

fn runtime_install(
    installed: codex_win_engine::InstalledWindowsCodex,
) -> chimera_runtime::manager::InstalledCodex {
    chimera_runtime::manager::InstalledCodex {
        version: installed.version,
        path: installed.path,
        install_mode: process_install_mode(&installed.source),
    }
}

/// `detect_managed_codex` in the runtime crate's shape.
fn detect_managed_install(
    portable_root: &Path,
) -> Option<chimera_runtime::manager::InstalledCodex> {
    detect_managed_codex(portable_root).map(runtime_install)
}

/// Finish or undo a layout migration a crash interrupted, so the install root
/// exists again before detection. Caller holds the runtime operation lock.
/// The skin commands, which close and relaunch Codex too, call it the same way.
pub(crate) fn recover_interrupted_layout(portable_root: &Path) -> Result<(), String> {
    if !codex_portable_layout::migration_interrupted(portable_root) {
        return Ok(());
    }
    prepare_portable_layout(portable_root).map(|_| ())
}

/// While a migration is interrupted the install root is missing, so the
/// renderer offers neither "open" nor "repair". Status reads therefore heal it
/// under the operation lock. Returns why it is still interrupted, if it is.
fn heal_interrupted_layout(portable_root: &Path) -> Option<String> {
    if !codex_portable_layout::migration_interrupted(portable_root) {
        return None;
    }
    acquire_operation_lock("codex_runtime_layout_recovery")
        .and_then(|_guard| recover_interrupted_layout(portable_root))
        .err()
}

const LAYOUT_FLAT_NOTICE: &str = "免安装版仍是旧的目录结构。下次通过 Chimera++ 启动 Codex 时会自动升级（官方文件移入 app 子目录），会话和配置不受影响。";
const LAYOUT_INTERRUPTED_NOTICE: &str = "上次免安装版目录结构升级被中断，Codex 文件完整保留在旁边的 .layout- 暂存目录中，请不要手动删除该目录。重新打开“Codex 管理”页面时，Chimera++ 会自动再次尝试恢复。";

/// Layout code and notice for the status DTO. Pure apart from reading `root`.
fn portable_layout_status(
    installed_portable: bool,
    portable_root: &Path,
) -> (Option<String>, Option<String>) {
    if codex_portable_layout::migration_interrupted(portable_root) {
        return (
            Some("interrupted".to_string()),
            Some(LAYOUT_INTERRUPTED_NOTICE.to_string()),
        );
    }
    if !installed_portable {
        return (None, None);
    }
    match codex_portable_layout::detect_layout(portable_root) {
        PortableLayout::Flat => (
            Some("flat".to_string()),
            Some(LAYOUT_FLAT_NOTICE.to_string()),
        ),
        PortableLayout::Nested => (Some("nested".to_string()), None),
        PortableLayout::Missing | PortableLayout::Unknown => (None, None),
    }
}

fn launch_action(was_running: bool) -> &'static str {
    if was_running {
        "restarted"
    } else {
        "launched"
    }
}

pub(crate) fn renderer_unlock_available(
    installed: &codex_win_engine::InstalledWindowsCodex,
) -> bool {
    if installed.source == "portable" {
        return true;
    }
    let live_home = crate::codex_config::get_codex_config_dir();
    let default_home = crate::config::get_home_dir().join(".codex");
    codex_win_engine::same_windows_path(&live_home, &default_home)
}

fn renderer_unlock_launch_options(
    installed: &codex_win_engine::InstalledWindowsCodex,
) -> codex_win_engine::LaunchOptions<'static> {
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
    launch: LaunchReport,
) -> CodexLaunchResult {
    let startup_slow = launch.verdict == StartupVerdict::Slow;
    CodexLaunchResult {
        was_running,
        running,
        action: launch_action(was_running),
        model_unlock_attempted: model_unlock.attempted,
        model_unlock_injected: model_unlock.injected,
        model_unlock_model_count: model_unlock.model_count,
        model_unlock_error: model_unlock.error,
        startup_slow,
        startup_notice: startup_slow.then(|| STARTUP_SLOW_NOTICE.to_string()),
        layout_migration: launch.layout,
    }
}

/// Launch for the "open / restart Codex" commands: a failed verdict is an
/// error, a slow one is reported to the renderer as launched-but-slow.
fn launch_for_command(
    installed: &codex_win_engine::InstalledWindowsCodex,
    failure_prefix: &str,
) -> Result<LaunchReport, String> {
    let report = launch_codex_checked(installed, renderer_unlock_launch_options(installed))
        .map_err(|error| format!("{failure_prefix}{error}"))?;
    if let StartupVerdict::Failed { kind, message } = &report.verdict {
        log::warn!("Codex 启动未通过就绪检查（{kind}）");
        return Err(format!("{failure_prefix}{message}"));
    }
    Ok(report)
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

/// Upstream-branded and English failures the pinned engine reports, paired
/// with a plain-Chinese reason and next step. Patterns are lowercase.
const KNOWN_ENGINE_FAILURES: &[(&[&str], &str)] = &[
    (
        &["missing its bundled cli"],
        "Codex 免安装版缺少内置的命令行组件（resources\\codex.exe），无法启动。请在“Codex 管理”中执行“修复”重新安装。",
    ),
    (
        &["invalid portable launch target", "invalid portable executable name"],
        "Codex 免安装版的启动配置无效。请在“Codex 管理”中执行“修复”重新安装。",
    ),
    (
        &["write portable launch target", "write portable launcher"],
        "无法写入 Codex 免安装版启动器，安装目录可能只读或文件正被占用。请关闭 Codex 后重试；仍然失败时在“Codex 管理”中执行“修复”。",
    ),
    (
        &["no portable app executable", "no app entry executable"],
        "免安装版目录中找不到 Codex 主程序。请在“Codex 管理”中执行“修复”重新安装，或在设置中确认免安装版目录。",
    ),
    (
        &["(startup-dialog)"],
        "Codex 启动时弹出了错误对话框，没有正常打开。请在“Codex 管理”中运行诊断；如需改用免安装版，请在安装方式中选择后重新安装。",
    ),
    (
        &["(main-window-timeout)"],
        "Codex 已经启动，但 30 秒内没有出现稳定的主窗口。请检查 Codex 窗口，或在“Codex 管理”中运行诊断。",
    ),
    (
        &["(immediate-exit)", "exited immediately after launch"],
        "Codex 启动后立即退出。请在“Codex 管理”中运行诊断，必要时执行“修复”。",
    ),
    (
        &["(activation-failed)"],
        "Windows 没能启动 Codex 标准安装。请在“Codex 管理”中运行诊断；问题持续时可执行“修复”，或改用免安装版重新安装。",
    ),
    (
        &["codex is not installed", "registered codex package not found"],
        "Windows 中没有找到已注册的 Codex 标准安装。请在“Codex 管理”中重新安装 Codex。",
    ),
];

const ENGINE_FAILURE_NEXT_STEP: &str = "请在“Codex 管理”中运行诊断；问题持续时可执行“修复”。";

/// Drop every sentence that names the upstream manager. Its advice
/// ("Reinstall it with …", "automatically try the portable fallback") is
/// wrong inside Chimera++, which never falls back silently.
fn scrub_upstream_advice(raw: &str) -> String {
    raw.split(". ")
        .filter(|sentence| {
            let lower = sentence.to_ascii_lowercase();
            !(lower.contains("codex app manager")
                || lower.contains("codexappmanager")
                || lower.contains("codex-app-manager"))
        })
        .collect::<Vec<_>>()
        .join(". ")
        .trim()
        .trim_end_matches(['.', '。'])
        .to_string()
}

fn known_engine_failure(raw: &str) -> Option<&'static str> {
    let lower = raw.to_ascii_lowercase();
    KNOWN_ENGINE_FAILURES
        .iter()
        .find(|(patterns, _)| patterns.iter().any(|pattern| lower.contains(pattern)))
        .map(|(_, message)| *message)
}

/// Reason only, for messages that already carry their own next step.
fn engine_failure_reason(raw: &str) -> String {
    known_engine_failure(raw)
        .map(str::to_string)
        .unwrap_or_else(|| scrub_upstream_advice(raw))
}

/// Plain-Chinese reason and next step for a failure reported by the Codex
/// engine. Known failures become a fixed sentence; anything else keeps its
/// text, minus upstream product advice, so diagnosis is still possible.
/// Callers log the raw text before converting it.
pub(crate) fn engine_error_message(raw: &str) -> String {
    if let Some(message) = known_engine_failure(raw) {
        return message.to_string();
    }
    let detail = scrub_upstream_advice(raw);
    if detail.is_empty() {
        ENGINE_FAILURE_NEXT_STEP.to_string()
    } else {
        format!("{detail}。{ENGINE_FAILURE_NEXT_STEP}")
    }
}

fn portable_command_with_codex_home(
    root: &Path,
    codex_home: &Path,
    options: codex_win_engine::LaunchOptions<'_>,
) -> Result<Command, String> {
    let launcher = codex_win_engine::portable::ensure_portable_launcher(root).map_err(|error| {
        let raw = error.to_string();
        log::warn!("准备 Codex 免安装版启动器失败：{raw}");
        format!(
            "无法准备 Codex 免安装版启动器：{}",
            engine_error_message(&raw)
        )
    })?;
    let mut command = Command::new(launcher);
    command
        .current_dir(root)
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
    Ok(command)
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct CodexStartupWindows {
    main_visible: bool,
    dialog_visible: bool,
}

#[cfg(any(windows, test))]
impl CodexStartupWindows {
    fn observe(&mut self, class: &str) {
        self.main_visible |= class == "Chrome_WidgetWin_1";
        self.dialog_visible |= class == "#32770";
    }

    fn probe(&self, running: bool) -> StartupProbe {
        if self.dialog_visible {
            StartupProbe::Dialog
        } else if self.main_visible {
            StartupProbe::MainWindow
        } else if running {
            StartupProbe::Running
        } else {
            StartupProbe::NotRunning
        }
    }
}

/// One look at the processes and visible windows of an install root.
/// Only the Windows probe can observe windows, so elsewhere some variants are
/// never constructed outside tests.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupProbe {
    NotRunning,
    Running,
    MainWindow,
    Dialog,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StartupVerdict {
    Ready,
    /// Still running, but no stable main window within the budget.
    Slow,
    Failed {
        kind: &'static str,
        message: String,
    },
}

const STARTUP_BUDGET: Duration = Duration::from_secs(30);
const STARTUP_STABLE_FOR: Duration = Duration::from_secs(3);
const STARTUP_POLL: Duration = Duration::from_millis(250);

const STARTUP_DIALOG_MESSAGE: &str = "Codex 启动时弹出了错误对话框，没有正常打开。请查看对话框中的提示，并在“Codex 管理”中运行诊断。";
const STARTUP_EXITED_MESSAGE: &str =
    "Codex 启动后立即退出。请在“Codex 管理”中运行诊断，必要时执行“修复”。";
const STARTUP_NOT_STARTED_MESSAGE: &str =
    "Codex 没有启动起来。请在“Codex 管理”中运行诊断，必要时执行“修复”。";
const STARTUP_SLOW_NOTICE: &str = "Codex 已经启动，但 30 秒内还没有出现稳定的主窗口，可能仍在加载。请稍候查看 Codex 窗口；一直没有出现时，请在“Codex 管理”中运行诊断。";

/// The startup decision, free of clocks and processes so it can be tested.
/// A dialog fails at once; a main window must stay up for `stable_for`;
/// at the budget a still-running Codex is slow, a vanished one failed.
struct StartupTracker {
    budget: Duration,
    stable_for: Duration,
    ready_since: Option<Duration>,
    saw_process: bool,
}

impl StartupTracker {
    fn new(budget: Duration, stable_for: Duration) -> Self {
        Self {
            budget,
            stable_for,
            ready_since: None,
            saw_process: false,
        }
    }

    fn observe(&mut self, elapsed: Duration, probe: StartupProbe) -> Option<StartupVerdict> {
        match probe {
            StartupProbe::Dialog => {
                return Some(StartupVerdict::Failed {
                    kind: "startup-dialog",
                    message: STARTUP_DIALOG_MESSAGE.to_string(),
                })
            }
            StartupProbe::MainWindow => {
                self.saw_process = true;
                let since = *self.ready_since.get_or_insert(elapsed);
                if elapsed.saturating_sub(since) >= self.stable_for {
                    return Some(StartupVerdict::Ready);
                }
            }
            StartupProbe::Running => {
                self.saw_process = true;
                self.ready_since = None;
            }
            StartupProbe::NotRunning => self.ready_since = None,
        }
        if elapsed < self.budget {
            return None;
        }
        Some(match probe {
            StartupProbe::Running | StartupProbe::MainWindow => StartupVerdict::Slow,
            _ if self.saw_process => StartupVerdict::Failed {
                kind: "immediate-exit",
                message: STARTUP_EXITED_MESSAGE.to_string(),
            },
            _ => StartupVerdict::Failed {
                kind: "activation-failed",
                message: STARTUP_NOT_STARTED_MESSAGE.to_string(),
            },
        })
    }
}

fn wait_for_startup(
    mut probe: impl FnMut() -> Result<StartupProbe, String>,
) -> Result<StartupVerdict, String> {
    let started = Instant::now();
    let mut tracker = StartupTracker::new(STARTUP_BUDGET, STARTUP_STABLE_FOR);
    loop {
        let observed = probe()?;
        if let Some(verdict) = tracker.observe(started.elapsed(), observed) {
            return Ok(verdict);
        }
        std::thread::sleep(STARTUP_POLL);
    }
}

#[cfg(any(windows, test))]
fn normalized_windows_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
    };
    text.trim_end_matches('\\').to_lowercase()
}

/// Whether `candidate` lies strictly inside `root`, on a component boundary.
/// Matching "inside the root" rather than "directly in the root" covers both
/// portable layouts (`root\ChatGPT.exe`, `root\app\ChatGPT.exe`) and MSIX.
#[cfg(any(windows, test))]
fn path_within_root(candidate: &Path, root: &Path) -> bool {
    let candidate = normalized_windows_path(candidate);
    let root = normalized_windows_path(root);
    !root.is_empty()
        && candidate.len() > root.len()
        && candidate.starts_with(&root)
        && candidate[root.len()..].starts_with('\\')
}

/// Native, path-pinned startup probe. Replaces the PowerShell `Get-Process`
/// filter, whose `.Path` is often empty for packaged processes.
#[cfg(windows)]
fn codex_startup_probe(root: &Path) -> Result<StartupProbe, String> {
    use std::collections::HashMap;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowThreadProcessId, IsWindowVisible,
    };

    let running = codex_win_engine::codex_running_for_root(root)
        .map_err(|error| format!("无法读取 Codex 进程状态：{error}"))?;
    if !running {
        return Ok(StartupProbe::NotRunning);
    }
    struct Probe<'a> {
        root: &'a Path,
        inside: HashMap<u32, bool>,
        windows: CodexStartupWindows,
    }
    fn image_within_root(pid: u32, root: &Path) -> bool {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return false;
        }
        let mut buffer = vec![0_u16; 32_768];
        let mut size = buffer.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size)
        };
        unsafe { CloseHandle(handle) };
        ok != 0
            && path_within_root(
                Path::new(&std::ffi::OsString::from_wide(&buffer[..size as usize])),
                root,
            )
    }
    unsafe extern "system" fn inspect(hwnd: HWND, param: LPARAM) -> i32 {
        let probe = unsafe { &mut *(param as *mut Probe) };
        if unsafe { IsWindowVisible(hwnd) } == 0 {
            return 1;
        }
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        let root = probe.root;
        if !*probe
            .inside
            .entry(pid)
            .or_insert_with(|| image_within_root(pid, root))
        {
            return 1;
        }
        let mut class = [0_u16; 128];
        let length = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
        if length > 0 {
            probe
                .windows
                .observe(&String::from_utf16_lossy(&class[..length as usize]));
        }
        1
    }
    let mut probe = Probe {
        root,
        inside: HashMap::new(),
        windows: CodexStartupWindows::default(),
    };
    if unsafe { EnumWindows(Some(inspect), &mut probe as *mut _ as LPARAM) } == 0 {
        return Err("Codex 主窗口枚举失败，无法确认启动成功".to_string());
    }
    Ok(probe.windows.probe(true))
}

#[cfg(not(windows))]
fn codex_startup_probe(_root: &Path) -> Result<StartupProbe, String> {
    Err("Codex 主窗口检查仅支持 Windows".to_string())
}

fn launch_portable_with_codex_home(
    installed: &codex_win_engine::InstalledWindowsCodex,
    codex_home: &Path,
    options: codex_win_engine::LaunchOptions<'_>,
) -> Result<StartupVerdict, String> {
    let root = Path::new(&installed.path);
    let mut command = portable_command_with_codex_home(root, codex_home, options)?;
    let mut launcher = command
        .spawn()
        .map_err(|error| format!("Codex 免安装版启动器失败: {error}"))?;
    let launcher_deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = launcher
            .try_wait()
            .map_err(|error| format!("无法检查 Codex 启动器状态: {error}"))?
        {
            if !status.success() {
                return Err(format!("Codex 免安装版启动器退出: {status}"));
            }
            break;
        }
        if Instant::now() >= launcher_deadline {
            let _ = launcher.kill();
            let _ = launcher.wait();
            return Err("Codex 免安装版启动器超时".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    wait_for_startup(|| {
        let probe = codex_startup_probe(root)?;
        // With CDP the renderer must also be attachable, or skin and model
        // injection would silently miss this instance.
        let renderer_pending = probe == StartupProbe::MainWindow
            && options.remote_debugging_port.is_some_and(|port| {
                !crate::codex_cdp::probe_codex_renderer_unlock(port).attachable
            });
        Ok(if renderer_pending {
            StartupProbe::Running
        } else {
            probe
        })
    })
}

fn launch_msix_with_codex_home(
    codex_home: &Path,
    options: codex_win_engine::LaunchOptions<'_>,
) -> Result<(), String> {
    if options.remote_debugging_port.is_some() {
        return Err("MSIX 启动暂不支持通过环境注入远程调试参数".to_string());
    }

    // Shell activation normally happens in a separate process and therefore
    // cannot see a temporary Rust-side environment change. Start the shell
    // activation from PowerShell with CODEX_HOME explicitly present so the
    // activated Desktop process inherits the same config directory.
    // The encoding line keeps Chinese error text readable; it fails silently
    // under ConstrainedLanguage, where `decode_console_output` falls back to
    // the OEM code page.
    let script = r#"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
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
        let detail = crate::process_utils::decode_console_output(&output.stderr)
            .trim()
            .to_string();
        return Err(if detail.is_empty() {
            format!("MSIX Codex 激活失败（退出码 {:?}）", output.status.code())
        } else {
            format!("MSIX Codex 激活失败：{detail}")
        });
    }
    Ok(())
}

/// How a launch went: the startup verdict plus the portable layout migration
/// that ran right before it, if any.
pub(crate) struct LaunchReport {
    verdict: StartupVerdict,
    layout: Option<LayoutMigrationOutcome>,
}

/// Launch for callers that only need "did it start". A slow start counts as
/// started; the caller's own follow-up (e.g. CDP injection) reports misses.
pub(crate) fn launch_codex_with_config(
    installed: &codex_win_engine::InstalledWindowsCodex,
    options: codex_win_engine::LaunchOptions<'_>,
) -> Result<(), String> {
    match launch_codex_checked(installed, options)?.verdict {
        StartupVerdict::Ready => Ok(()),
        StartupVerdict::Slow => {
            log::warn!("Codex 已启动但 30 秒内未出现稳定主窗口，按已启动处理");
            Ok(())
        }
        StartupVerdict::Failed { message, .. } => Err(message),
    }
}

/// Bring a portable root to the nested layout before launching it. Only
/// called with Codex already closed and the runtime operation lock held.
fn prepare_portable_layout(root: &Path) -> Result<Option<LayoutMigrationOutcome>, String> {
    let outcome = codex_portable_layout::migrate_flat_to_nested(
        root,
        &codex_portable_layout::EngineLayoutHost,
    );
    log::info!("[portable-layout] {}: {}", outcome.state, outcome.message);
    if outcome.state == "failed-needs-attention" || !root.is_dir() {
        return Err(outcome.message);
    }
    Ok((outcome.state != "not-needed").then_some(outcome))
}

fn launch_codex_checked(
    installed: &codex_win_engine::InstalledWindowsCodex,
    mut options: codex_win_engine::LaunchOptions<'_>,
) -> Result<LaunchReport, String> {
    let codex_home = crate::codex_config::get_codex_config_dir();

    if installed.source == "portable" {
        let layout = prepare_portable_layout(Path::new(&installed.path))?;
        let verdict = launch_portable_with_codex_home(installed, &codex_home, options)?;
        return Ok(LaunchReport { verdict, layout });
    }
    let root = Path::new(&installed.path);
    let report = |verdict| LaunchReport {
        verdict,
        layout: None,
    };

    // The engine uses IApplicationActivationManager when Electron arguments
    // are present, the only reliable way to pass the local CDP flags to an
    // MSIX desktop app. This path is used only with the default ~/.codex
    // directory, so no CODEX_HOME environment override is required. The
    // engine itself waits for a stable main window and rejects startup
    // dialogs.
    if options.remote_debugging_port.is_some() {
        if !renderer_unlock_available(installed) {
            return Err("标准 MSIX 使用自定义 CODEX_HOME 时无法同时传入 CDP 参数；请恢复默认目录或使用便携版".to_string());
        }
        match engine_msix_launch(installed, options) {
            Ok(verdict) => return Ok(report(verdict)),
            Err(error) if error.contains("(startup-dialog)") => {
                return Ok(report(StartupVerdict::Failed {
                    kind: "startup-dialog",
                    message: msix_launch_error(&engine_failure_reason(&error)),
                }));
            }
            Err(error) => {
                log::warn!("带 CDP 参数启动 MSIX Codex 失败，尝试普通启动：{error}");
                if codex_is_running(installed)? {
                    // A live process alone is not success: observe it.
                    return wait_for_startup(|| codex_startup_probe(root)).map(report);
                }
                options.remote_debugging_port = None;
            }
        }
    }

    // Without renderer injection, prefer the environment-aware shell activation.
    // The engine fallback cannot propagate CODEX_HOME, so only use it for the
    // default config directory. Never silently launch against another profile.
    match launch_msix_with_codex_home(&codex_home, options) {
        Ok(()) => wait_for_startup(|| codex_startup_probe(root)).map(report),
        Err(error) => {
            let default_home = crate::config::get_home_dir().join(".codex");
            if !codex_win_engine::same_windows_path(&codex_home, &default_home) {
                return Err(msix_launch_error(&format!(
                    "{error}；系统激活无法保留自定义 CODEX_HOME，已停止回退"
                )));
            }
            log::warn!("环境注入的 MSIX Codex 启动失败，回退到系统激活：{error}");
            engine_msix_launch(installed, options)
                .map(report)
                .map_err(|raw| {
                    msix_launch_error(&format!(
                        "{error}；系统激活也失败：{}",
                        engine_failure_reason(&raw)
                    ))
                })
        }
    }
}

/// Engine MSIX activation. Since v0.5.16 it waits for a stable main window
/// itself; its "no stable window in 30 seconds" with Codex still running is
/// a slow start, not a failure.
fn engine_msix_launch(
    installed: &codex_win_engine::InstalledWindowsCodex,
    options: codex_win_engine::LaunchOptions<'_>,
) -> Result<StartupVerdict, String> {
    match codex_win_engine::launch_codex_with_options(installed, options) {
        Ok(()) => Ok(StartupVerdict::Ready),
        Err(error) => {
            let raw = error.to_string();
            log::warn!("系统激活 MSIX Codex 失败：{raw}");
            if raw.contains("(main-window-timeout)") && codex_is_running(installed)? {
                Ok(StartupVerdict::Slow)
            } else {
                Err(raw)
            }
        }
    }
}

fn msix_launch_error(detail: &str) -> String {
    let detail = scrub_upstream_advice(detail);
    let normalized = detail.to_ascii_lowercase();
    if normalized.contains("80073d28") || normalized.contains("80073cf6") {
        format!("Windows 无法注册或激活 Codex 安装包（打包服务可能需要管理员权限）。这不是线路配置损坏。请在“Codex 管理”中选择免安装版重新安装，或由管理员修复标准 MSIX 安装；无需删除 ~/.codex 会话与配置。原始错误：{detail}")
    } else {
        format!("MSIX Codex 启动失败；请在“Codex 管理”中运行诊断或选择免安装版。原始错误：{detail}")
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
///
/// Async on purpose: Tauri runs a synchronous command on the main thread, and
/// the runtime cross-check below spawns the Codex CLI with a 10-second
/// timeout per candidate, which froze the window on every line save. The
/// work runs on a blocking thread instead.
#[tauri::command]
pub async fn verify_codex_model_catalog(
    expected_model: String,
    expected_models: Option<Vec<ExpectedCodexCatalogModel>>,
) -> Result<CodexModelCatalogStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        verify_codex_model_catalog_blocking(&expected_model, expected_models)
    })
    .await
    .map_err(|error| format!("校验 Codex 模型目录的任务被中断：{error}"))?
}

fn verify_codex_model_catalog_blocking(
    expected_model: &str,
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
            .ok_or_else(|| crate::codex_config::codex_model_catalog_reference_error(&config))?;
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
        recover_interrupted_layout(&portable_root)?;
        let installed = detect_managed_codex(&portable_root)
            .ok_or_else(|| "未检测到 Codex 安装".to_string())?;
        let was_running = codex_is_running(&installed)?;
        close_codex_for_restart(&installed, &portable_root)?;
        let launch = launch_for_command(&installed, "")?;
        let running = wait_for_codex_running(&installed)?;
        if !running {
            return Err("Codex 重启后未保持运行，请在“Codex 管理”中运行诊断".to_string());
        }
        let model_unlock = renderer_unlock_status(&installed);
        Ok(launch_result(was_running, running, model_unlock, launch))
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
        let Some(installed) = detect_managed_codex(&portable_root) else {
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

/// Launch the managed Codex installation. If a managed instance is already
/// running, it is only closed and relaunched when `confirm_restart` is
/// `true`; otherwise this returns the
/// [`OPEN_CODEX_RESTART_CONFIRMATION_REQUIRED_PREFIX`] sentinel error with
/// zero side effects. The deprecated `restart_if_running` flag is accepted
/// only for IPC compatibility: lifecycle policy is backend-owned.
///
/// The cross-process lock covers discovery, shutdown, launch, and health
/// verification. Process discovery and termination are path-pinned in
/// `codex_win_engine`, so unrelated Electron or ChatGPT processes are never
/// selected.
///
/// The confirmation gate exists because "open Codex" clicked on an
/// already-running instance used to silently force-close it (killing after
/// a 30s grace period, per `close_codex_for_restart`), interrupting whatever
/// the user was doing in Codex with no warning. Callers should invoke with
/// `confirm_restart: false` first and only retry with `true` after the user
/// explicitly agreed in response to the sentinel error — the running check
/// here is the source of truth, so a caller-side pre-check against its own
/// (possibly stale) polled process status must not substitute for it.
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
        recover_interrupted_layout(&portable_root)?;
        let installed = detect_managed_codex(&portable_root)
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
        // A second portable Electron process may exit after handing focus to
        // an already-running instance. We intentionally reject that path: a
        // previous target was either absent or confirmed closed, so accepting
        // it could hide a failed replacement.
        let launch = launch_for_command(&installed, "无法启动 Codex：")?;
        let running = wait_for_codex_running(&installed)?;
        if !running {
            return Err("Codex 启动后未保持运行，请在“Codex 管理”中运行诊断".to_string());
        }
        let model_unlock = renderer_unlock_status(&installed);
        Ok(launch_result(was_running, running, model_unlock, launch))
    })
    .await
    .map_err(|error| format!("Codex 启动任务中断: {error}"))?
}

fn operation_lock() -> OperationLock {
    OperationLock::new(runtime_root().join("operation.lock"))
}

/// Runtime operations are user-initiated and mostly short, but a restart holds
/// the lock for as long as Codex takes to close and come back (tens of seconds
/// on MSIX). Failing the instant the lock is busy turned any overlap into a
/// dead end, so wait for a plausibly-short holder before reporting contention.
const OPERATION_LOCK_WAIT: Duration = Duration::from_secs(15);

/// Shared by every Codex runtime mutation, including the skin operations in
/// `skin_catalog`: applying a skin closes and relaunches Codex on the same
/// install root an update may be mid-swap on, so the two must exclude each
/// other. They previously derived this path independently, where any drift
/// would have silently removed that guarantee.
pub(crate) fn acquire_operation_lock(operation: &str) -> Result<LockGuard, String> {
    let root = runtime_root();
    std::fs::create_dir_all(&root).map_err(|_| "无法创建 Chimera++ 运行时目录".to_string())?;
    let lock = operation_lock();
    let deadline = Instant::now() + OPERATION_LOCK_WAIT;
    loop {
        match lock.try_acquire(operation) {
            Ok(guard) => return Ok(guard),
            Err(LockError::Io { source, .. }) => {
                return Err(format!("无法打开 Chimera++ 运行时锁: {source}"));
            }
            Err(LockError::AlreadyHeld { holder_pid }) => {
                if Instant::now() >= deadline {
                    return Err(describe_lock_contention(holder_pid));
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
}

/// The lock is an OS advisory lock, so the holder is always a live process:
/// the operating system drops it when that process exits. Reporting "another
/// Chimera++" for our own pid sent users hunting for a second window that was
/// never there, so name what actually holds it.
fn describe_lock_contention(holder_pid: Option<u32>) -> String {
    match holder_pid {
        Some(pid) if pid == std::process::id() => {
            "上一个 Codex 运行时操作还没结束，请等它完成后再试".to_string()
        }
        Some(pid) => {
            format!("另一个 Chimera++（进程 {pid}）正在执行 Codex 运行时操作，请等它完成后再试")
        }
        None => "另一个 Chimera++ 操作正在进行".to_string(),
    }
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

/// Forward package download progress to the renderer. The event name and
/// `{ downloaded, total }` payload are unchanged; the downloader throttles calls.
fn runtime_download_progress(
    app: &AppHandle,
    total: u64,
) -> crate::services::bounded_download::ProgressCallback {
    let app = app.clone();
    std::sync::Arc::new(move |downloaded: u64| {
        let _ = app.emit(
            "codex-runtime-download-progress",
            serde_json::json!({ "downloaded": downloaded, "total": total }),
        );
    })
}

fn install_runtime_release_with_observer(
    plan: &WindowsReleasePlan,
    install_mode: InstallMode,
    staging_root: &Path,
    portable_root: &Path,
    on_progress: crate::services::bounded_download::ProgressCallback,
    observer: &mut dyn FnMut(
        codex_win_engine::PortableBoundary,
    ) -> Result<(), codex_win_engine::EngineError>,
) -> Result<CodexRuntimeOperation, String> {
    if !safe_package_moniker(&plan.package_moniker)
        || plan.size_bytes == 0
        || plan.size_bytes > OFFLINE_PACKAGE_MAX_BYTES
    {
        return Err("安装计划中的包名或大小不合法".to_string());
    }
    std::fs::create_dir_all(staging_root).map_err(|error| format!("创建暂存目录失败: {error}"))?;
    let package_path = staging_root.join(format!("{}.Msix", plan.package_moniker));
    let result = (|| {
        // Same proxy and TLS stack as the update check: the app proxy when
        // one is set, otherwise the system proxy. The download client also
        // refuses any non-HTTPS redirect hop. This runs on the blocking
        // thread that holds the runtime operation lock, so the runtime lock
        // also covers the download.
        crate::services::bounded_download::download_to_file_blocking(
            crate::proxy::http_client::get_for_download()?,
            plan.package_url.clone(),
            package_path.clone(),
            plan.size_bytes,
            crate::services::bounded_download::DownloadOptions::default(),
            on_progress,
        )
        .map_err(|error| {
            format!(
                "下载 Codex 安装包失败：{error}。当前网络：{}。请检查网络，或在设置中调整应用代理后重试；也可以使用离线安装。",
                crate::proxy::http_client::describe_network_mode()
            )
        })?;
        verify_staged_runtime_package(plan, &package_path)?;
        let mut notes = Vec::new();
        if install_mode == InstallMode::Standard {
            let capability = codex_win_engine::probe_capabilities();
            notes = capability.notes;
            if capability.recommendation
                == codex_win_engine::SideloadRecommendation::PortableFallback
            {
                return Err(format!(
                    "Windows 当前不允许注册 Codex MSIX，已阻止回退到无包身份的免安装版；请由管理员修复 AppX/MSIX 服务后重试。{}",
                    if notes.is_empty() {
                        String::new()
                    } else {
                        format!("诊断：{}", notes.join("；"))
                    }
                ));
            }
            codex_win_engine::close_msix_codex_processes(30)
                .map_err(|error| format!("无法关闭 Codex，安装已中止：{error}"))?;
            let report =
                codex_win_engine::install_msix_sideload(&package_path, &plan.package_moniker)
                    .map_err(|error| {
                        let raw = error.to_string();
                        log::warn!("注册 Codex MSIX 安装包失败：{raw}");
                        msix_launch_error(&engine_failure_reason(&raw))
                    })?;
            let health = if report.success {
                Some(verify_msix_health_with_main_window(portable_root))
            } else {
                None
            };
            if let Some(health) = health.filter(msix_health_accepts_install) {
                let slow = health.failure_kind == MSIX_WINDOW_SLOW;
                if slow {
                    notes.push(STARTUP_SLOW_NOTICE.to_string());
                }
                return Ok(CodexRuntimeOperation {
                    version: plan.version.clone(),
                    requested_mode: "standard".to_string(),
                    actual_mode: "standard".to_string(),
                    affected_path: report.installed.map(|installed| installed.path),
                    backup_path: None,
                    message: if slow {
                        "Codex 标准安装完成；Codex 已启动，但主窗口出现较慢".to_string()
                    } else {
                        "Codex 标准安装完成并通过启动检查".to_string()
                    },
                    notes,
                });
            }
            return Err("Codex MSIX 安装完成但启动健康检查未通过；为避免无程序包标识符错误，未回退到免安装版。请在“Codex 管理”中运行诊断或由管理员修复 MSIX。".to_string());
        }
        let report = codex_win_engine::install_portable_from_msix_with_observer(
            &package_path,
            portable_root,
            true,
            false,
            observer,
        )
        .map_err(|error| {
            let raw = error.to_string();
            log::warn!("安装 Codex 免安装版失败：{raw}");
            format!("安装 Codex 免安装版失败：{}", engine_error_message(&raw))
        })?;
        notes.extend(report.notes);
        Ok(CodexRuntimeOperation {
            version: report.version,
            requested_mode: mode_label(install_mode),
            actual_mode: "portable".to_string(),
            affected_path: Some(report.install_root),
            backup_path: report.backup_path,
            message: report.message,
            notes,
        })
    })();
    let _ = std::fs::remove_file(&package_path);
    result
}

fn verify_staged_runtime_package(
    plan: &WindowsReleasePlan,
    package_path: &Path,
) -> Result<(), String> {
    let size = package_path
        .metadata()
        .map_err(|error| format!("读取安装包信息失败: {error}"))?
        .len();
    let digest = codex_win_engine::sha256_file(package_path)
        .map_err(|error| format!("计算安装包哈希失败: {error}"))?;
    if size != plan.size_bytes || !digest.eq_ignore_ascii_case(&plan.sha256) {
        return Err("安装包大小或哈希与发布计划不符，已拒绝".to_string());
    }
    let signature = codex_win_engine::verify_openai_authenticode(package_path)
        .map_err(|error| format!("验证安装包签名失败: {error}"))?;
    if !signature.is_valid_openai() {
        return Err("安装包未通过 OpenAI 发行者签名校验，已拒绝安装".to_string());
    }
    Ok(())
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
            portable_layout: None,
            layout_notice: None,
            unmanaged_standard_version: None,
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let recovery_error = heal_interrupted_layout(&portable_root);
        let (msix, portable_candidate) = detect_candidates(&portable_root);
        let prefer_portable =
            msix.is_some() && portable_candidate.is_some() && portable_preferred();
        let unmanaged_standard_version = if prefer_portable {
            msix.as_ref().map(|value| value.version.clone())
        } else {
            None
        };
        let installed =
            select_managed(msix, portable_candidate, prefer_portable).map(runtime_install);
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
        let (portable_layout, mut layout_notice) = portable_layout_status(portable, &portable_root);
        if portable_layout.as_deref() == Some("interrupted") && recovery_error.is_some() {
            layout_notice = recovery_error;
        }
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
            portable_layout,
            layout_notice,
            unmanaged_standard_version,
        })
    })
    .await
    .map_err(|_| "读取 Codex 安装状态时任务中断".to_string())?
}

#[tauri::command]
pub async fn open_codex_runtime_directory(handle: AppHandle) -> Result<bool, String> {
    require_windows()?;
    let installed = detect_managed_install(&portable_root()?)
        .ok_or_else(|| "未检测到 Codex 安装".to_string())?;
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
    let plan = fetch_latest_runtime_plan().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let installed = detect_managed_install(&portable_root);
        let current_version = installed.as_ref().map(|value| value.version.clone());
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

// MSIX keeps its Electron payload in app/, unlike the flattened portable layout.
fn msix_app_exe(install_root: &Path) -> Option<PathBuf> {
    codex_win_engine::installed_app_exe(&install_root.join("app"))
        .or_else(|| codex_win_engine::installed_app_exe(install_root))
}

/// Wrapper code for an MSIX that is running but showed no stable main window
/// within the engine's 30-second budget: launched but slow, not broken.
const MSIX_WINDOW_SLOW: &str = "window-slow";

/// Engine v0.5.16 already waits for a stable main window and rejects startup
/// dialogs (natively, without `Get-Process .Path`). Keep the probe instance
/// running so a user's live session survives. A `main-window-timeout` while
/// Codex is still running is downgraded to `window-slow` (warn, not fail).
fn verify_msix_health_with_main_window(portable_root: &Path) -> codex_win_engine::MsixHealthReport {
    let health = codex_win_engine::verify_msix_health_with_options(true);
    let still_running = || {
        codex_win_engine::detect_installed_codex(portable_root)
            .filter(|installed| installed.source == "msix")
            .is_some_and(|installed| codex_is_running(&installed).unwrap_or(false))
    };
    classify_msix_health(health, still_running)
}

fn classify_msix_health(
    mut health: codex_win_engine::MsixHealthReport,
    still_running: impl FnOnce() -> bool,
) -> codex_win_engine::MsixHealthReport {
    if !health.healthy && health.failure_kind == "main-window-timeout" && still_running() {
        health.verified = false;
        health.failure_kind = MSIX_WINDOW_SLOW.to_string();
    }
    health
}

/// Whether an MSIX install may be reported as done: healthy, or running but slow.
fn msix_health_accepts_install(health: &codex_win_engine::MsixHealthReport) -> bool {
    health.healthy || health.failure_kind == MSIX_WINDOW_SLOW
}

/// The portable checks the runtime crate reports after `executable`.
fn portable_diagnostic_entries() -> Vec<chimera_runtime::manager::ManagerDiagnostic> {
    use chimera_runtime::manager::ManagerDiagnostic;
    vec![
        ManagerDiagnostic {
            name: "package signature".to_string(),
            result: "warn".to_string(),
        },
        ManagerDiagnostic {
            name: "ownership".to_string(),
            result: "pass".to_string(),
        },
    ]
}

const REINSTALL_NEXT_STEP: &str = "请在“Codex 管理”中执行“修复”重新安装。";
const NOT_REGISTERED_DETAIL: &str =
    "Windows 中没有找到已注册的 Codex 安装包。请在“Codex 管理”中执行“修复”重新安装。";

/// Reason code and plain-Chinese explanation for an unhealthy MSIX report.
/// `failure_kind` carries the engine's `msix_failure` codes plus the
/// wrapper's own `window-slow`.
fn msix_failure_reason(health: &codex_win_engine::MsixHealthReport) -> (&'static str, String) {
    match health.failure_kind.as_str() {
        "not-registered" => ("not-registered", NOT_REGISTERED_DETAIL.to_string()),
        "status-bad" => ("package-status", msix_status_detail(&health.status)),
        "aumid-unresolved" => (
            "manifest",
            format!("无法从安装包清单中找到 Codex 的启动入口。{REINSTALL_NEXT_STEP}"),
        ),
        "missing-dependencies" => (
            "dependencies",
            missing_dependencies_detail(&health.missing_dependencies),
        ),
        "policy" => (
            "permissions",
            "系统策略不允许运行 Codex 标准安装。请联系管理员调整策略，或改用免安装版重新安装。"
                .to_string(),
        ),
        "timeout" => (
            "timeout",
            "启动检查超时，系统繁忙时也可能发生。请稍后重新诊断；仍然超时可在“Codex 管理”中执行“修复”。"
                .to_string(),
        ),
        "probe-failed" => (
            "probe",
            "启动检查无法运行（PowerShell 不可用或受系统策略限制），无法确认 Codex 能否启动；这不一定代表安装损坏，可以直接打开 Codex 确认。"
                .to_string(),
        ),
        "startup-dialog" => (
            "main-window",
            "Codex 启动时弹出了错误对话框，没有正常打开。问题持续时请在“Codex 管理”中执行“修复”，或改用免安装版重新安装。"
                .to_string(),
        ),
        "main-window-timeout" => (
            "main-window",
            "Codex 启动后 30 秒内没有出现稳定的主窗口，随后退出了。问题持续时请在“Codex 管理”中执行“修复”，或改用免安装版重新安装。"
                .to_string(),
        ),
        "window-slow" => ("slow-start", STARTUP_SLOW_NOTICE.to_string()),
        "immediate-exit" => (
            "launch",
            "Codex 启动后立即退出。请在“Codex 管理”中执行“修复”；问题持续时可改用免安装版重新安装。"
                .to_string(),
        ),
        _ => (
            "launch",
            "Windows 没能启动 Codex 标准安装。请在“Codex 管理”中执行“修复”；问题持续时可改用免安装版重新安装。"
                .to_string(),
        ),
    }
}

fn msix_status_detail(status: &str) -> String {
    let status = status.trim();
    if status.is_empty() {
        format!("Windows 报告 Codex 安装包状态异常。{REINSTALL_NEXT_STEP}")
    } else {
        format!("Windows 报告 Codex 安装包状态异常（{status}）。{REINSTALL_NEXT_STEP}")
    }
}

fn missing_dependencies_detail(missing: &[String]) -> String {
    format!(
        "缺少运行依赖：{}。请联网后在“Codex 管理”中执行“修复”，或改用免安装版重新安装。",
        missing.join("、")
    )
}

/// Map one MSIX health report onto the four standard-install checks, each
/// with its own reason. Pure so the wording is testable without Windows.
fn msix_health_diagnostics(
    health: &codex_win_engine::MsixHealthReport,
) -> Vec<CodexRuntimeDiagnostic> {
    let integrity = CodexRuntimeDiagnostic::check(
        "package integrity",
        health.package_registered && health.status_ok,
    );
    let integrity = if health.package_registered {
        integrity.because("package-status", msix_status_detail(&health.status))
    } else {
        integrity.because("not-registered", NOT_REGISTERED_DETAIL)
    };
    let registration =
        CodexRuntimeDiagnostic::check("package registration", health.package_registered)
            .because("not-registered", NOT_REGISTERED_DETAIL);
    let dependencies =
        CodexRuntimeDiagnostic::check("dependencies", health.missing_dependencies.is_empty())
            .because(
                "dependencies",
                missing_dependencies_detail(&health.missing_dependencies),
            );
    let launch_result = if health.healthy {
        "pass"
    } else if health.verified {
        "fail"
    } else {
        "warn"
    };
    let (kind, detail) = msix_failure_reason(health);
    let launch = CodexRuntimeDiagnostic::new("launch", launch_result).because(kind, detail);
    vec![integrity, registration, dependencies, launch]
}

/// Attach reasons to the portable checks produced by the runtime crate.
fn portable_runtime_diagnostic(
    entry: chimera_runtime::manager::ManagerDiagnostic,
) -> CodexRuntimeDiagnostic {
    let diagnostic = CodexRuntimeDiagnostic::new(&entry.name, &entry.result);
    match entry.name.as_str() {
        "package signature" => diagnostic.because(
            "signature",
            "免安装版提取后不再携带可独立验证的安装包签名；安装前已验证过 OpenAI 发行者签名，不影响使用。",
        ),
        "ownership" => diagnostic.because(
            "permissions",
            "无法确认这个免安装版目录由 Chimera++ 管理。请在设置中确认免安装版目录，或在“Codex 管理”中执行“修复”。",
        ),
        _ => diagnostic,
    }
}

/// Run installation diagnostics without killing a running Codex install.
///
/// The shared runtime helper activates MSIX and closes the probe instance. For
/// the standard install mode we use the keep-running variant here so the user's
/// live Codex session survives a diagnostic run.
fn diagnose_windows_codex_non_destructive(portable_root: &Path) -> Vec<CodexRuntimeDiagnostic> {
    let Some(installed) = detect_managed_install(portable_root) else {
        return vec![CodexRuntimeDiagnostic::new("installation", "fail").because(
            "not-installed",
            "没有检测到 Codex 标准版或免安装版。请在“Codex 管理”中安装 Codex；如果使用免安装版，请在设置中确认免安装版目录。",
        )];
    };
    let install_root = Path::new(&installed.path);
    if installed.install_mode != "standard" {
        // The engine resolves both layouts and never treats a root launcher
        // stub as the official executable.
        let executable = CodexRuntimeDiagnostic::check(
            "executable",
            codex_win_engine::installed_app_exe(install_root).is_some(),
        )
        .because(
            "executable",
            "免安装版目录中找不到 Codex 主程序。请在“Codex 管理”中执行“修复”重新安装，或在设置中确认免安装版目录。",
        );
        // Built here rather than by the runtime crate, whose diagnostics
        // re-detect MSIX first and would activate the Store package when it
        // sits next to the managed portable install.
        let mut diagnostics = vec![executable];
        diagnostics.extend(
            portable_diagnostic_entries()
                .into_iter()
                .map(portable_runtime_diagnostic),
        );
        return diagnostics;
    }

    let executable_found = msix_app_exe(install_root).is_some();
    let executable = CodexRuntimeDiagnostic::check("executable", executable_found).because(
        "executable",
        format!("找不到 Codex 标准安装的主程序文件。{REINSTALL_NEXT_STEP}"),
    );
    let mut diagnostics = vec![executable];
    let health = verify_msix_health_with_main_window(portable_root);
    diagnostics.extend(msix_health_diagnostics(&health));
    diagnostics
}

/// Run installation diagnostics only after a user action, under a shared
/// operation lock, and without terminating a running Codex instance.
#[tauri::command]
pub async fn diagnose_codex_runtime() -> Result<Vec<CodexRuntimeDiagnostic>, String> {
    require_windows()?;
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_diagnose")?;
        // An interrupted layout migration would otherwise read as "not
        // installed": finish or undo it first, and report only what remains.
        if let Err(reason) = recover_interrupted_layout(&portable_root) {
            return Ok(vec![
                CodexRuntimeDiagnostic::new("installation", "warn").because("layout", reason)
            ]);
        }
        Ok(diagnose_windows_codex_non_destructive(&portable_root))
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
    parse_source(source)?;
    let install_mode = parse_install_mode(install_mode)?;
    let root = runtime_root();
    let portable_root = portable_root()?;
    let plan = fetch_latest_runtime_plan().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_install")?;
        recover_interrupted_layout(&portable_root)?;
        ensure_portable_root_safe_for_install(&portable_root)?;
        if expected_version
            .as_deref()
            .is_some_and(|expected| expected != plan.version)
        {
            return Err("确认后可用版本发生变化，请重新检查更新".to_string());
        }
        let progress = runtime_download_progress(&app, plan.size_bytes);
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
        let mut observer = install_journal_observer(&journal, &journal_id);
        let result = install_runtime_release_with_observer(
            &plan,
            install_mode,
            &root.join("downloads"),
            &portable_root,
            progress,
            &mut observer,
        );
        match &result {
            Ok(operation) => {
                let _ = journal.finish(&journal_id, "completed", Some(operation.message.clone()));
            }
            Err(error) => {
                let _ = journal.finish(&journal_id, "failed", Some(error.clone()));
            }
        }
        result
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
    let installed = detect_managed_install(&portable_root()?)
        .ok_or_else(|| "未检测到 Codex，请先执行安装".to_string())?;
    install_release(
        app,
        None,
        source,
        install_mode.or(Some(installed.install_mode)),
    )
    .await
}

/// Plain-Chinese text for maintenance failures from the runtime crate, whose
/// messages are English. The original text stays in the log.
fn maintenance_error_message(
    failed: &str,
    error: &chimera_runtime::manager::ManagerError,
) -> String {
    use chimera_runtime::manager::ManagerError;
    log::warn!("{failed}：{error}");
    match error {
        ManagerError::NotInstalled => format!("{failed}：未检测到 Codex 安装。"),
        ManagerError::NoRollback => format!(
            "{failed}：没有可用的回滚备份。只有通过 Chimera++ 更新过的免安装版才会保留上一个版本。"
        ),
        ManagerError::Maintenance => format!(
            "{failed}：Codex 可能仍在运行，或安装目录被占用、没有写入权限。请关闭 Codex 后重试；问题持续时在“Codex 管理”中运行诊断。"
        ),
        other => format!("{failed}：{other}。{ENGINE_FAILURE_NEXT_STEP}"),
    }
}

/// Restore the latest portable backup. Standard MSIX has no local rollback slot.
#[tauri::command]
pub async fn rollback_codex_runtime(confirm: bool) -> Result<CodexRuntimeOperation, String> {
    require_confirmation(confirm, "回滚 Codex")?;
    require_windows()?;
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_rollback")?;
        recover_interrupted_layout(&portable_root)?;
        match detect_managed_install(&portable_root) {
            Some(installed) => {
                if maintenance_route(Some(&installed)) != MaintenanceRoute::Portable {
                    return Err("标准安装由 Windows 管理，没有本地回滚副本".to_string());
                }
                rollback_portable_install(&portable_root)
                    .map(operation_dto)
                    .map_err(|error| maintenance_error_message("回滚 Codex 失败", &error))
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

fn uninstall_portable_target(
    portable_root: &Path,
    version: String,
) -> Result<CodexRuntimeOperation, String> {
    let report = codex_win_engine::uninstall_portable(portable_root, false).map_err(|error| {
        log::warn!("卸载 Codex 免安装版失败：{error}");
        format!(
            "卸载 Codex 失败：{}",
            engine_error_message(&error.to_string())
        )
    })?;
    if !report.success {
        log::warn!("卸载 Codex 免安装版未完成：{}", report.message);
        return Err("卸载 Codex 失败：Codex 可能仍在运行，或安装目录被占用、没有写入权限。请关闭 Codex 后重试；问题持续时在“Codex 管理”中运行诊断。".to_string());
    }
    Ok(CodexRuntimeOperation {
        version,
        requested_mode: "portable".to_string(),
        actual_mode: "uninstalled".to_string(),
        affected_path: Some(report.install_root),
        backup_path: None,
        message: report.message,
        notes: report.notes,
    })
}

/// Uninstall Codex while preserving the user's `~/.codex` data.
#[tauri::command]
pub async fn uninstall_codex_runtime(confirm: bool) -> Result<CodexRuntimeOperation, String> {
    require_confirmation(confirm, "卸载 Codex")?;
    require_windows()?;
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_uninstall")?;
        recover_interrupted_layout(&portable_root)?;
        // The runtime crate always prefers a registered MSIX; when the managed
        // target is the portable install, remove that one instead.
        if let Some(installed) =
            detect_managed_codex(&portable_root).filter(|installed| installed.source == "portable")
        {
            return uninstall_portable_target(&portable_root, installed.version);
        }
        uninstall_windows_codex(&portable_root)
            .map(operation_dto)
            .map_err(|error| maintenance_error_message("卸载 Codex 失败", &error))
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

fn mirror_http_error(status: reqwest::StatusCode, headers: &reqwest::header::HeaderMap) -> String {
    let rate_limited = status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || (status == reqwest::StatusCode::FORBIDDEN
            && (headers
                .get("x-ratelimit-remaining")
                .is_some_and(|value| value == "0")
                || headers.contains_key("retry-after")));
    if rate_limited {
        let retry = headers
            .get("retry-after")
            .and_then(|value| value.to_str().ok()?.parse::<u64>().ok())
            .map(|seconds| format!("请在 {seconds} 秒后重试"))
            .or_else(|| {
                let seconds = headers
                    .get("x-ratelimit-reset")?
                    .to_str()
                    .ok()?
                    .parse()
                    .ok()?;
                let reset = chrono::DateTime::from_timestamp(seconds, 0)?;
                Some(format!(
                    "额度预计于 {} 恢复（本机时间）",
                    reset.with_timezone(&chrono::Local).format("%m-%d %H:%M:%S")
                ))
            })
            .unwrap_or_else(|| "请稍后重试".to_string());
        return format!(
            "GitHub API 请求限流（HTTP {status}）；{retry}，也可更换应用代理出口或使用离线安装"
        );
    }
    format!("HTTP {status}；请检查网络与应用代理设置，稍后重试或使用离线安装")
}

/// The release lookups, manifests and checksums decide which package and
/// SHA-256 the hardened download then trusts, so every redirect hop must stay
/// on HTTPS, as for the package download itself.
async fn send_mirror_request(
    method: reqwest::Method,
    url: &str,
) -> Result<reqwest::Response, String> {
    let client = crate::proxy::http_client::get_for_download()?;
    send_mirror_request_with(&client, method, url).await
}

async fn send_mirror_request_with(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
) -> Result<reqwest::Response, String> {
    let response = client
        .request(method, url)
        .header(reqwest::header::USER_AGENT, MIRROR_USER_AGENT)
        .timeout(Duration::from_secs(MIRROR_FETCH_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|error| format!("请求失败: {error}"))?;
    if !response.status().is_success() {
        return Err(mirror_http_error(response.status(), response.headers()));
    }
    Ok(response)
}

/// 通过应用内 reqwest 客户端抓取镜像仓库的文本资源，跟随全局代理设置。
///
/// 取代进程外 `codex_win_engine::fetch_text`（curl）：后者对大响应体存在
/// 管道背压死锁 —— `run_capturing` 先等进程退出、之后才读 stdout，Windows
/// 匿名管道缓冲区仅约 4KB，而 GitHub Releases 目录约 400KB+，curl 写满管道
/// 后被阻塞、进程无法退出，历史版本目录因此长期卡在“正在加载”。
async fn fetch_mirror_text(url: &str) -> Result<String, String> {
    let mut response = send_mirror_request(reqwest::Method::GET, url).await?;
    if response
        .content_length()
        .is_some_and(|len| len > MIRROR_CATALOG_MAX_BYTES as u64)
    {
        return Err(format!("响应超过 {} 字节上限", MIRROR_CATALOG_MAX_BYTES));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取响应失败: {error}"))?
    {
        if chunk.len() > MIRROR_CATALOG_MAX_BYTES.saturating_sub(bytes.len()) {
            return Err(format!("响应超过 {} 字节上限", MIRROR_CATALOG_MAX_BYTES));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|error| format!("响应不是有效 UTF-8: {error}"))
}

async fn fetch_latest_runtime_plan() -> Result<WindowsReleasePlan, String> {
    let body = match fetch_mirror_text(&format!(
        "https://api.github.com/repos/{MIRROR_REPO}/releases/latest"
    ))
    .await
    {
        Ok(body) => body,
        Err(api_error) => {
            log::warn!("Codex release API unavailable, trying pinned release assets: {api_error}");
            return fetch_latest_runtime_plan_without_api()
                .await
                .map_err(|error| {
                    format!("获取 Codex 安装版本失败：{api_error}；发布清单回退也失败：{error}")
                });
        }
    };
    let release: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| format!("解析 Codex 安装版本失败：{error}"))?;
    let tag = release
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Codex 发布缺少版本 tag".to_string())?;
    let plan = plan_codex_runtime_release(tag.to_string()).await?;
    validate_release_asset(&release, &plan)?;
    Ok(plan)
}

/// Resolve latest once, then use only assets pinned to that trusted release.
/// This avoids GitHub's shared anonymous API quota without weakening the normal
/// architecture/checksum checks or downloading a package during update checks.
async fn fetch_latest_runtime_plan_without_api() -> Result<WindowsReleasePlan, String> {
    let latest = send_mirror_request(
        reqwest::Method::HEAD,
        &format!("https://github.com/{MIRROR_REPO}/releases/latest"),
    )
    .await?;
    let tag = mirror_release_tag_from_url(latest.url())?;
    let plan = plan_codex_runtime_release(tag).await?;
    // The API path checks the asset list. Its fallback must also reject a
    // missing, zero-length or partially published package before offering it.
    let package = send_mirror_request(reqwest::Method::HEAD, &plan.package_url).await?;
    validate_mirror_package_size(package.headers(), plan.size_bytes)?;
    Ok(plan)
}

fn mirror_release_tag_from_url(url: &reqwest::Url) -> Result<String, String> {
    let prefix = format!("/{MIRROR_REPO}/releases/tag/");
    let tag = url.path().strip_prefix(&prefix).unwrap_or_default();
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("最新发布跳转不在受信任的镜像仓库内".to_string());
    }
    validate_mirror_tag(tag)?;
    Ok(tag.to_string())
}

fn validate_mirror_package_size(
    headers: &reqwest::header::HeaderMap,
    expected: u64,
) -> Result<(), String> {
    let size = headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok()?.parse::<u64>().ok());
    if expected > 0 && size == Some(expected) {
        Ok(())
    } else {
        Err("该版本安装包大小与清单不符或无法验证；请稍后重试，或选择其他历史版本".to_string())
    }
}

fn validate_release_asset(
    release: &serde_json::Value,
    plan: &WindowsReleasePlan,
) -> Result<(), String> {
    let name = format!("{}.Msix", plan.package_moniker);
    let available = release
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|assets| {
            assets.iter().any(|asset| {
                asset.get("name").and_then(serde_json::Value::as_str) == Some(name.as_str())
                    && asset.get("size").and_then(serde_json::Value::as_u64)
                        == Some(plan.size_bytes)
                    && plan.size_bytes > 0
            })
        });
    if available {
        Ok(())
    } else {
        Err(format!(
            "该版本尚无完整的本机架构安装包 {name}；请稍后重试，或从历史版本选择可用安装包"
        ))
    }
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
        recover_interrupted_layout(&portable_root)?;
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
        let progress = runtime_download_progress(&app, plan.size_bytes);
        let mut observer = install_journal_observer(&journal, &journal_id);
        let result = install_runtime_release_with_observer(
            &plan,
            install_mode,
            &root.join("downloads"),
            &portable_root,
            progress,
            &mut observer,
        );
        match &result {
            Ok(operation) => {
                let _ = journal.finish(&journal_id, "completed", Some(operation.message.clone()));
            }
            Err(error) => {
                let _ = journal.finish(&journal_id, "failed", Some(error.clone()));
            }
        }
        result
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
        recover_interrupted_layout(&portable_root)?;
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
                // The journal keeps the engine's own text for diagnosis; the
                // user sees the plain-Chinese reason and next step.
                let raw = error.to_string();
                log::warn!("离线安装 Codex 失败：{raw}");
                let _ = journal.finish(&journal_id, "failed", Some(raw.clone()));
                Err(format!("离线安装失败：{}", engine_error_message(&raw)))
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
    #[test]
    fn msix_executable_prefers_app_payload_and_supports_flat_layout() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(super::msix_app_exe(root).is_none());
        std::fs::write(root.join("Codex.exe"), b"fixture").unwrap();
        assert_eq!(super::msix_app_exe(root), Some(root.join("Codex.exe")));
        std::fs::create_dir(root.join("app")).unwrap();
        std::fs::write(root.join("app/ChatGPT.exe"), b"fixture").unwrap();
        assert_eq!(
            super::msix_app_exe(root),
            Some(root.join("app/ChatGPT.exe"))
        );
    }

    #[test]
    fn msix_health_treats_a_running_slow_start_as_launched_not_broken() {
        // Signature only: calling it would activate the real package.
        let _: fn(&std::path::Path) -> codex_win_engine::MsixHealthReport =
            super::verify_msix_health_with_main_window;

        let slow = super::classify_msix_health(health_report("main-window-timeout"), || true);
        assert_eq!(slow.failure_kind, super::MSIX_WINDOW_SLOW);
        assert!(!slow.healthy && !slow.verified);
        assert!(super::msix_health_accepts_install(&slow));
        let launch = &super::msix_health_diagnostics(&slow)[3];
        assert_eq!(launch.result, "warn");
        assert_eq!(launch.kind.as_deref(), Some("slow-start"));
        assert!(launch
            .detail
            .as_deref()
            .is_some_and(|d| d.contains("可能仍在加载")));

        // Gone by the time we look: a real failure.
        let exited = super::classify_msix_health(health_report("main-window-timeout"), || false);
        assert_eq!(exited.failure_kind, "main-window-timeout");
        assert!(!super::msix_health_accepts_install(&exited));

        // A dialog is never downgraded, whatever the process state.
        let dialog = super::classify_msix_health(health_report("startup-dialog"), || true);
        assert_eq!(dialog.failure_kind, "startup-dialog");
        assert!(!super::msix_health_accepts_install(&dialog));

        let healthy = super::classify_msix_health(health_report(""), || {
            panic!("a healthy report must not probe processes")
        });
        assert!(super::msix_health_accepts_install(&healthy));
    }

    #[test]
    fn standard_install_success_requires_an_accepted_health_report() {
        let source = include_str!("codex_runtime.rs")
            .split("mod tests {")
            .next()
            .unwrap();
        assert!(source.contains("health.filter(msix_health_accepts_install)"));
        assert!(source.contains("let health = verify_msix_health_with_main_window(portable_root);"));
        assert!(!source.contains("codex_win_engine::verify_msix_health().healthy"));
    }

    #[test]
    fn msix_engine_fallback_cannot_discard_custom_codex_home() {
        let source = include_str!("codex_runtime.rs")
            .split("mod tests {")
            .next()
            .unwrap();
        let launch = source
            .split("pub(crate) fn launch_codex_with_config(")
            .nth(1)
            .unwrap()
            .split("fn msix_launch_error(")
            .next()
            .unwrap();
        assert!(launch.contains("let codex_home = crate::codex_config::get_codex_config_dir();"));
        let fallback = launch
            .split("match launch_msix_with_codex_home(&codex_home, options)")
            .nth(1)
            .unwrap();
        let guard = fallback
            .find("if !codex_win_engine::same_windows_path(&codex_home, &default_home)")
            .unwrap();
        let activation = fallback
            .find("codex_win_engine::launch_codex_with_options(installed, options)")
            .unwrap();
        assert!(guard < activation);
        assert!(fallback[guard..activation].contains("return Err(msix_launch_error("));
        assert!(fallback.contains("crate::config::get_home_dir().join(\".codex\")"));
    }

    #[test]
    fn skin_injection_checks_custom_home_before_side_effects() {
        let runtime = include_str!("codex_runtime.rs")
            .split("mod tests {")
            .next()
            .unwrap();
        let launch = runtime
            .split("pub(crate) fn launch_codex_with_config(")
            .nth(1)
            .unwrap()
            .split("fn msix_launch_error(")
            .next()
            .unwrap();
        assert!(
            launch
                .find("if !renderer_unlock_available(installed)")
                .unwrap()
                < launch
                    .find("codex_win_engine::launch_codex_with_options(installed, options)")
                    .unwrap()
        );
        let skin = include_str!("skin_catalog.rs");
        for entry in ["fn close_and_launch(", "pub async fn apply_skin_package("] {
            let body = skin.split(entry).nth(1).expect("skin entry point");
            assert!(
                body.find("renderer_unlock_available(&installed)").unwrap()
                    < body.find("close_codex(&installed,").unwrap()
            );
        }
    }

    #[test]
    fn msix_registration_errors_preserve_details_and_offer_non_destructive_recovery() {
        for detail in ["0x80073D28", "registration failed (0x80073CF6)"] {
            let message = super::msix_launch_error(detail);
            assert!(message.contains(detail));
            assert!(message.contains("免安装版"));
            assert!(message.contains("无需删除"));
        }
        let message = super::msix_launch_error("activation timed out");
        assert!(message.contains("activation timed out"));
        assert!(!message.contains("管理员权限"));
    }

    #[test]
    fn mirror_errors_distinguish_rate_limits_from_other_forbidden_responses() {
        use reqwest::{header::HeaderMap, StatusCode};
        let mut headers = HeaderMap::new();
        let forbidden = super::mirror_http_error(StatusCode::FORBIDDEN, &headers);
        assert!(forbidden.contains("HTTP 403"));
        assert!(!forbidden.contains("限流"));
        headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
        headers.insert("x-ratelimit-reset", "1791239309".parse().unwrap());
        let limited = super::mirror_http_error(StatusCode::FORBIDDEN, &headers);
        assert!(limited.contains("限流"));
        assert!(limited.contains("本机时间"));
        headers.insert("retry-after", "120".parse().unwrap());
        assert!(super::mirror_http_error(StatusCode::FORBIDDEN, &headers).contains("120 秒"));
        headers.clear();
        headers.insert("x-ratelimit-reset", "invalid".parse().unwrap());
        let limited = super::mirror_http_error(StatusCode::TOO_MANY_REQUESTS, &headers);
        assert!(limited.contains("限流"));
        assert!(limited.contains("稍后重试"));
    }

    #[test]
    fn fallback_only_accepts_a_pinned_tag_in_the_trusted_mirror() {
        let base = format!("https://github.com/{}/releases", super::MIRROR_REPO);
        let url = reqwest::Url::parse(&format!("{base}/tag/codex-app-26.930.31730")).unwrap();
        assert_eq!(
            super::mirror_release_tag_from_url(&url).unwrap(),
            "codex-app-26.930.31730"
        );
        for url in [
            format!("{base}/latest"),
            format!("{base}/tag/"),
            format!("{base}/tag/test/other"),
            format!("{base}/tag/test?redirect=other"),
            format!("{base}/tag/test#other"),
            format!("{base}/tag/test%2Fother"),
            format!("{base}/tag/test").replace("https:", "http:"),
            format!("{base}/tag/test").replace("github.com/", "github.com:8443/"),
            format!("{base}/tag/test").replace("github.com/", "github.com.evil.test/"),
            format!("{base}/tag/test").replace(super::MIRROR_REPO, "other/repo"),
        ] {
            assert!(
                super::mirror_release_tag_from_url(&reqwest::Url::parse(&url).unwrap()).is_err(),
                "{url}"
            );
        }
    }

    #[test]
    fn fallback_requires_a_nonempty_package_matching_the_manifest_size() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert!(super::validate_mirror_package_size(&headers, 100).is_err());
        for (value, expected, valid) in [
            ("100", 100, true),
            ("99", 100, false),
            ("0", 0, false),
            ("bad", 100, false),
        ] {
            headers.insert(reqwest::header::CONTENT_LENGTH, value.parse().unwrap());
            assert_eq!(
                super::validate_mirror_package_size(&headers, expected).is_ok(),
                valid
            );
        }
    }

    #[test]
    fn release_asset_must_match_package_name_and_size() {
        let plan = super::WindowsReleasePlan {
            version: "26.915.31945".to_string(),
            package_version: "26.915.4065.0".to_string(),
            package_moniker: "OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0".to_string(),
            package_url: String::new(),
            sha256: "a".repeat(64),
            size_bytes: 824570408,
            released_at: None,
        };
        let release = serde_json::json!({"assets": [{
            "name": format!("{}.Msix", plan.package_moniker),
            "size": plan.size_bytes
        }]});
        assert!(super::validate_release_asset(&release, &plan).is_ok());
        assert!(super::validate_release_asset(&serde_json::json!({"assets": []}), &plan).is_err());
        let mut wrong_size = release.clone();
        wrong_size["assets"][0]["size"] = serde_json::json!(1);
        assert!(super::validate_release_asset(&wrong_size, &plan).is_err());
        let mut wrong_arch = release;
        wrong_arch["assets"][0]["name"] = serde_json::json!("OpenAI.Codex_arm64.Msix");
        assert!(super::validate_release_asset(&wrong_arch, &plan).is_err());
    }

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
            portable_layout: None,
            layout_notice: None,
            unmanaged_standard_version: None,
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

    #[test]
    fn portable_launcher_preserves_home_and_debug_options_without_renaming_payload() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("Codex.exe"), b"fixture").unwrap();
        std::fs::create_dir(root.join("resources")).unwrap();
        std::fs::write(root.join("resources/codex.exe"), b"cli").unwrap();
        let literal_name = root.join("resources/%40literal");
        std::fs::write(&literal_name, b"literal percent name").unwrap();
        let home = root.join("custom home");
        let command = super::portable_command_with_codex_home(
            root,
            &home,
            codex_win_engine::LaunchOptions {
                disable_codex_self_updates: true,
                remote_debugging_port: Some(9222),
                ..Default::default()
            },
        )
        .unwrap();
        #[cfg(windows)]
        assert_eq!(
            command.get_program(),
            root.join("LaunchCodex.exe").as_os_str()
        );
        assert_eq!(command.get_current_dir(), Some(root));
        assert!(command
            .get_envs()
            .any(|(key, value)| { key == "CODEX_HOME" && value == Some(home.as_os_str()) }));
        assert!(command.get_envs().any(|(key, value)| {
            key == "CODEX_SPARKLE_ENABLED" && value == Some(std::ffi::OsStr::new("false"))
        }));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=9222"
            ]
        );
        assert!(literal_name.is_file());
        assert!(!root.join("resources/@literal").exists());
        let ordinary = super::portable_command_with_codex_home(
            root,
            &home,
            codex_win_engine::LaunchOptions::default(),
        )
        .unwrap();
        assert_eq!(ordinary.get_args().count(), 0);
        assert!(!ordinary.get_envs().any(|(key, _)| key == "CODEX_CLI_PATH"));
    }

    #[test]
    fn startup_window_classes_map_to_probe_states() {
        use super::StartupProbe;
        let mut windows = super::CodexStartupWindows::default();
        assert_eq!(windows.probe(false), StartupProbe::NotRunning);
        assert_eq!(windows.probe(true), StartupProbe::Running);
        windows.observe("ConsoleWindowClass");
        assert_eq!(windows.probe(true), StartupProbe::Running);
        windows.observe("Chrome_WidgetWin_1");
        assert_eq!(windows.probe(true), StartupProbe::MainWindow);
        windows.observe("#32770");
        assert_eq!(windows.probe(true), StartupProbe::Dialog);
    }

    fn run_tracker(script: &[(u64, super::StartupProbe)]) -> Option<super::StartupVerdict> {
        let mut tracker = super::StartupTracker::new(
            std::time::Duration::from_secs(30),
            std::time::Duration::from_secs(3),
        );
        script
            .iter()
            .find_map(|(ms, probe)| tracker.observe(std::time::Duration::from_millis(*ms), *probe))
    }

    #[test]
    fn startup_needs_a_main_window_that_stays_up() {
        use super::{StartupProbe::*, StartupVerdict};
        assert_eq!(
            run_tracker(&[(0, Running), (1_000, MainWindow), (4_000, MainWindow)]),
            Some(StartupVerdict::Ready)
        );
        // Not stable long enough yet.
        assert_eq!(
            run_tracker(&[(1_000, MainWindow), (3_999, MainWindow)]),
            None
        );
        // A flicker resets the stability clock.
        assert_eq!(
            run_tracker(&[
                (1_000, MainWindow),
                (3_000, Running),
                (5_000, MainWindow),
                (7_000, MainWindow)
            ]),
            None
        );
    }

    #[test]
    fn startup_dialog_fails_immediately() {
        use super::{StartupProbe::*, StartupVerdict};
        let verdict = run_tracker(&[(0, MainWindow), (500, Dialog)]).unwrap();
        assert!(matches!(
            verdict,
            StartupVerdict::Failed {
                kind: "startup-dialog",
                ..
            }
        ));
    }

    #[test]
    fn budget_distinguishes_slow_from_failed() {
        use super::{StartupProbe::*, StartupVerdict};
        // Still running without a stable window: slow, not failed.
        assert_eq!(
            run_tracker(&[(0, Running), (30_000, Running)]),
            Some(StartupVerdict::Slow)
        );
        assert_eq!(
            run_tracker(&[(29_000, MainWindow), (30_000, MainWindow)]),
            Some(StartupVerdict::Slow)
        );
        // Started, then vanished.
        assert!(matches!(
            run_tracker(&[(0, Running), (30_000, NotRunning)]),
            Some(StartupVerdict::Failed {
                kind: "immediate-exit",
                ..
            })
        ));
        // Never seen.
        assert!(matches!(
            run_tracker(&[(0, NotRunning), (30_000, NotRunning)]),
            Some(StartupVerdict::Failed {
                kind: "activation-failed",
                ..
            })
        ));
    }

    #[test]
    fn startup_loop_propagates_probe_errors() {
        let error = super::wait_for_startup(|| Err("probe broke".to_string())).unwrap_err();
        assert_eq!(error, "probe broke");
        let ready = super::wait_for_startup(|| Ok(super::StartupProbe::Dialog)).unwrap();
        assert!(matches!(ready, super::StartupVerdict::Failed { .. }));
    }

    #[test]
    fn process_paths_match_inside_the_root_on_component_boundaries() {
        use std::path::Path;
        let root = Path::new(r"D:\Apps\Codex");
        assert!(super::path_within_root(
            Path::new(r"D:\Apps\Codex\ChatGPT.exe"),
            root
        ));
        assert!(super::path_within_root(
            Path::new(r"d:\apps\codex\app\ChatGPT.exe"),
            root
        ));
        assert!(super::path_within_root(
            Path::new(r"\\?\D:\Apps\Codex\app\ChatGPT.exe"),
            root
        ));
        assert!(super::path_within_root(
            Path::new("D:/Apps/Codex/app/ChatGPT.exe"),
            Path::new(r"D:\Apps\Codex\")
        ));
        assert!(!super::path_within_root(
            Path::new(r"D:\Apps\Codex2\ChatGPT.exe"),
            root
        ));
        assert!(!super::path_within_root(root, root));
        assert!(!super::path_within_root(
            Path::new(r"D:\Apps\ChatGPT.exe"),
            root
        ));
    }

    #[test]
    fn launches_report_slow_starts_and_never_accept_failures() {
        let source = include_str!("codex_runtime.rs")
            .split("mod tests {")
            .next()
            .unwrap();
        let checked = source
            .split("fn launch_codex_checked(")
            .nth(1)
            .unwrap()
            .split("\nfn ")
            .next()
            .unwrap();
        // Portable launches migrate the layout first.
        assert!(
            checked.find("prepare_portable_layout(").unwrap()
                < checked.find("launch_portable_with_codex_home(").unwrap()
        );
        // Every MSIX activation is followed by a window observation.
        assert!(checked
            .contains("Ok(()) => wait_for_startup(|| codex_startup_probe(root)).map(report),"));
        assert!(
            checked.contains("return wait_for_startup(|| codex_startup_probe(root)).map(report);")
        );
        let command = source.split("fn launch_for_command(").nth(1).unwrap();
        assert!(
            command.contains("if let StartupVerdict::Failed { kind, message } = &report.verdict")
        );
    }

    #[test]
    fn portable_launcher_rejects_missing_payload() {
        let dir = tempfile::tempdir().unwrap();
        assert!(super::portable_command_with_codex_home(
            dir.path(),
            dir.path(),
            codex_win_engine::LaunchOptions::default(),
        )
        .is_err());
    }

    // ── Portable-root install safety guard ──────────────────────────────

    #[test]
    fn portable_root_guard_accepts_missing_and_empty_roots() {
        let dir = tempfile::tempdir().expect("tempdir");

        let missing = dir.path().join("not-created-yet");
        assert!(super::ensure_portable_root_safe_for_install(&missing).is_ok());

        let empty = dir.path().join("empty");
        std::fs::create_dir(&empty).expect("create empty root");
        assert!(super::ensure_portable_root_safe_for_install(&empty).is_ok());
    }

    #[test]
    fn portable_root_guard_rejects_a_non_codex_directory_with_content() {
        // The destructive engine swap treats any existing directory as "a
        // previous install to replace" — the guard must refuse anything
        // non-empty that doesn't pass the Codex identity check. (The
        // genuine-install accept branch depends on the pinned engine's
        // AppxManifest/app.asar parsing and is exercised by real installs,
        // not fixtured here.)
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("documents");
        std::fs::create_dir(&root).expect("create root");
        std::fs::write(root.join("thesis.docx"), b"irreplaceable").expect("write file");

        let error = super::ensure_portable_root_safe_for_install(&root)
            .expect_err("non-Codex content must be refused");
        assert!(error.contains("已拒绝安装"), "got: {error}");
        // Refusal must not have touched the directory.
        assert!(root.join("thesis.docx").exists());
    }

    // ── Stale portable-backup sweep ──────────────────────────────────────

    #[test]
    fn backup_sweep_never_trades_a_rollback_backup_for_a_newer_replaced_one() {
        // `latest_portable_rollback` (the engine fn crash recovery and the
        // rollback command act on) matches ONLY `Codex.rollback-*`;
        // `Codex.replaced-*` is restorable by no code path. The sweep must
        // therefore prune the two prefixes as separate pools — a pooled
        // newest-by-mtime sweep would delete the only restorable backup
        // whenever an (unrestorable) replaced-* happens to be newer, which
        // is exactly the "rolled back earlier, later update crashed" state
        // crash recovery exists for.
        let dir = tempfile::tempdir().expect("tempdir");
        let portable_root = dir.path().join("Codex");

        let mkdir_ordered = |name: &str| {
            let path = dir.path().join(name);
            std::fs::create_dir(&path).expect("create backup dir");
            // Distinct mtimes: directory mtime is its creation time and NTFS
            // resolution is far finer than this sleep.
            std::thread::sleep(std::time::Duration::from_millis(40));
            path
        };
        let rollback_old = mkdir_ordered("Codex.rollback-20260101-000000");
        let rollback_new = mkdir_ordered("Codex.rollback-20260201-000000");
        let replaced_old = mkdir_ordered("Codex.replaced-20260301-000000");
        let replaced_new = mkdir_ordered("Codex.replaced-20260401-000000");

        super::sweep_stale_portable_backups(&portable_root);

        assert!(
            rollback_new.exists(),
            "newest rollback-* must survive even though every replaced-* has a newer mtime"
        );
        assert!(replaced_new.exists(), "newest replaced-* must survive");
        assert!(!rollback_old.exists(), "older rollback-* should be pruned");
        assert!(!replaced_old.exists(), "older replaced-* should be pruned");
    }

    // ── Engine error wording ─────────────────────────────────────────────

    #[test]
    fn engine_errors_become_plain_chinese_without_upstream_names() {
        for (raw, expected) in [
            (
                "io error: configure portable launch: Portable Codex is missing its bundled CLI (resources/codex.exe). Reinstall it with Codex App Manager.",
                "缺少内置的命令行组件",
            ),
            (
                "Invalid portable launch target. Reinstall with Codex App Manager.",
                "启动配置无效",
            ),
            (
                "io error: write portable launcher: Access is denied. (os error 5)",
                "无法写入 Codex 免安装版启动器",
            ),
            (
                "install error: no portable app executable in C:\\Codex",
                "找不到 Codex 主程序",
            ),
            (
                "io error: Codex exited immediately after launch (exit=1)",
                "立即退出",
            ),
            (
                "MSIX Codex failed to start (startup-dialog): The process has no package identity. Reinstall this version in Codex App Manager to verify startup and automatically try the portable fallback.",
                "错误对话框",
            ),
            (
                "MSIX Codex failed to start (main-window-timeout): no stable window",
                "稳定的主窗口",
            ),
            (
                "MSIX Codex failed to start (activation-failed): 0x80004005",
                "没能启动 Codex 标准安装",
            ),
            (
                "install error: Codex is not installed",
                "没有找到已注册的 Codex 标准安装",
            ),
        ] {
            let message = super::engine_error_message(raw);
            assert!(message.contains(expected), "{raw} -> {message}");
            assert!(message.contains("“Codex 管理”"), "{raw} -> {message}");
            assert!(!message.contains("Manager"), "{raw} -> {message}");
            assert!(!message.contains("Reinstall"), "{raw} -> {message}");
            assert!(!message.contains("fallback"), "{raw} -> {message}");
        }
    }

    #[test]
    fn unknown_engine_errors_keep_their_detail_but_drop_upstream_advice() {
        let message = super::engine_error_message(
            "install error: rename staging failed (os error 32). Reinstall it with Codex App Manager.",
        );
        assert!(
            message.starts_with("install error: rename staging failed (os error 32)。"),
            "{message}"
        );
        assert!(!message.contains("Manager"), "{message}");
        assert!(
            message.ends_with("请在“Codex 管理”中运行诊断；问题持续时可执行“修复”。"),
            "{message}"
        );
        assert_eq!(
            super::engine_error_message("Reinstall it with Codex App Manager."),
            "请在“Codex 管理”中运行诊断；问题持续时可执行“修复”。"
        );
        // Composite MSIX messages keep the HRESULT that selects the advice.
        let launch = super::msix_launch_error(
            "0x80073CF6. Reinstall this version in Codex App Manager to verify startup",
        );
        assert!(launch.contains("原始错误：0x80073CF6"), "{launch}");
        assert!(launch.contains("管理员"), "{launch}");
        assert!(!launch.contains("Manager"), "{launch}");
        assert_eq!(
            super::engine_failure_reason("install error: Codex is not installed"),
            "Windows 中没有找到已注册的 Codex 标准安装。请在“Codex 管理”中重新安装 Codex。"
        );
    }

    #[test]
    fn maintenance_errors_are_reported_in_chinese() {
        use chimera_runtime::manager::ManagerError;
        for (error, expected) in [
            (ManagerError::NotInstalled, "未检测到 Codex 安装"),
            (ManagerError::NoRollback, "没有可用的回滚备份"),
            (ManagerError::Maintenance, "关闭 Codex 后重试"),
        ] {
            let message = super::maintenance_error_message("回滚 Codex 失败", &error);
            assert!(message.starts_with("回滚 Codex 失败："), "{message}");
            assert!(message.contains(expected), "{message}");
        }
    }

    // ── Managed target and portable layout ───────────────────────────────

    fn installed(source: &str, version: &str) -> codex_win_engine::InstalledWindowsCodex {
        serde_json::from_value(serde_json::json!({
            "path": format!("C:\\fixture\\{source}"),
            "version": version,
            "arch": null,
            "source": source,
            "packageFamilyName": null,
        }))
        .expect("fixture install")
    }

    #[test]
    fn managed_target_prefers_portable_only_when_the_user_chose_it() {
        let msix = || Some(installed("msix", "1"));
        let portable = || Some(installed("portable", "2"));
        let pick = |m, p, prefer| super::select_managed(m, p, prefer).map(|i| i.source);
        assert_eq!(pick(msix(), portable(), false).as_deref(), Some("msix"));
        assert_eq!(pick(msix(), portable(), true).as_deref(), Some("portable"));
        assert_eq!(pick(msix(), None, true).as_deref(), Some("msix"));
        assert_eq!(pick(None, portable(), false).as_deref(), Some("portable"));
        assert_eq!(pick(None, None, true), None);
    }

    #[test]
    fn mutating_commands_route_through_the_managed_target() {
        let source = include_str!("codex_runtime.rs")
            .split("mod tests {")
            .next()
            .unwrap();
        assert!(!source.contains("detect_windows_codex("));
        assert!(!source.contains("diagnose_windows_codex("));
        let uninstall = source
            .split("pub async fn uninstall_codex_runtime(")
            .nth(1)
            .unwrap();
        assert!(
            uninstall.find("uninstall_portable_target(").unwrap()
                < uninstall.find("uninstall_windows_codex(").unwrap()
        );
        for lock in [
            "\"codex_runtime_launch\"",
            "\"codex_runtime_restart_catalog\"",
            "\"codex_runtime_rollback\"",
            "\"codex_runtime_uninstall\"",
            "\"codex_runtime_install\"",
        ] {
            for body in source
                .split(&format!("acquire_operation_lock({lock})?;"))
                .skip(1)
            {
                assert!(
                    body.trim_start()
                        .starts_with("recover_interrupted_layout(&portable_root)?;"),
                    "{lock} must recover an interrupted layout migration first"
                );
            }
        }
        // Read paths heal or explain an interrupted migration before they
        // would report the install as missing.
        let status = source
            .split("pub async fn get_codex_runtime_status(")
            .nth(1)
            .unwrap();
        assert!(
            status
                .find("heal_interrupted_layout(&portable_root)")
                .unwrap()
                < status.find("detect_candidates(&portable_root)").unwrap()
        );
        let diagnose = source
            .split("pub async fn diagnose_codex_runtime(")
            .nth(1)
            .unwrap();
        assert!(
            diagnose
                .find("recover_interrupted_layout(&portable_root)")
                .unwrap()
                < diagnose
                    .find("diagnose_windows_codex_non_destructive(&portable_root)")
                    .unwrap()
        );
    }

    #[test]
    fn nested_portable_layout_now_launches_through_the_root_launcher() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("app/ChatGPT.exe"), b"fixture").unwrap();
        let command = super::portable_command_with_codex_home(
            root,
            root,
            codex_win_engine::LaunchOptions::default(),
        )
        .expect("nested layout is supported by the pinned engine");
        #[cfg(windows)]
        assert_eq!(command.get_program(), root.join("Codex.exe").as_os_str());
        #[cfg(not(windows))]
        let _ = command;
    }

    #[test]
    fn layout_status_explains_flat_and_interrupted_roots() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("Codex");
        assert_eq!(super::portable_layout_status(true, &root), (None, None));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("ChatGPT.exe"), b"fixture").unwrap();
        let (code, notice) = super::portable_layout_status(true, &root);
        assert_eq!(code.as_deref(), Some("flat"));
        assert!(notice.unwrap().contains("自动升级"));
        // Not the managed portable install: no layout claims.
        assert_eq!(super::portable_layout_status(false, &root), (None, None));

        let staging = dir.path().join("Codex.layout-1-2");
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(
            staging.join(".chimera-layout-migration"),
            root.to_string_lossy().as_ref(),
        )
        .unwrap();
        std::fs::rename(&root, staging.join("app")).unwrap();
        let (code, notice) = super::portable_layout_status(false, &root);
        assert_eq!(code.as_deref(), Some("interrupted"));
        assert!(notice.unwrap().contains("不要手动删除"));
    }

    // ── Diagnostics with reasons ─────────────────────────────────────────

    fn health_report(failure_kind: &str) -> codex_win_engine::MsixHealthReport {
        codex_win_engine::MsixHealthReport {
            healthy: failure_kind.is_empty(),
            verified: failure_kind != "probe-failed",
            package_registered: failure_kind != "not-registered",
            status: if failure_kind == "status-bad" {
                "Modified"
            } else {
                "Ok"
            }
            .to_string(),
            status_ok: !matches!(failure_kind, "not-registered" | "status-bad"),
            aumid_resolved: failure_kind != "aumid-unresolved",
            missing_dependencies: if failure_kind == "missing-dependencies" {
                vec!["Microsoft.VCLibs.140.00".to_string()]
            } else {
                Vec::new()
            },
            activation_ok: failure_kind.is_empty(),
            failure_kind: failure_kind.to_string(),
            reason: String::new(),
        }
    }

    #[test]
    fn msix_diagnostics_explain_each_failure_with_a_stable_kind() {
        let healthy = super::msix_health_diagnostics(&health_report(""));
        assert_eq!(
            healthy
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            [
                "package integrity",
                "package registration",
                "dependencies",
                "launch"
            ]
        );
        assert!(healthy
            .iter()
            .all(|entry| entry.result == "pass" && entry.kind.is_none() && entry.detail.is_none()));
        // Passing items keep the old two-field JSON shape.
        assert_eq!(
            serde_json::to_value(&healthy[3]).expect("diagnostic serializes"),
            serde_json::json!({ "name": "launch", "result": "pass" })
        );

        for (failure, item, result, kind, needle) in [
            (
                "not-registered",
                "package registration",
                "fail",
                "not-registered",
                "没有找到已注册",
            ),
            (
                "not-registered",
                "package integrity",
                "fail",
                "not-registered",
                "修复",
            ),
            (
                "status-bad",
                "package integrity",
                "fail",
                "package-status",
                "Modified",
            ),
            (
                "missing-dependencies",
                "dependencies",
                "fail",
                "dependencies",
                "Microsoft.VCLibs.140.00",
            ),
            (
                "missing-dependencies",
                "launch",
                "fail",
                "dependencies",
                "缺少运行依赖",
            ),
            ("aumid-unresolved", "launch", "fail", "manifest", "启动入口"),
            ("policy", "launch", "fail", "permissions", "系统策略"),
            ("timeout", "launch", "fail", "timeout", "稍后重新诊断"),
            (
                "probe-failed",
                "launch",
                "warn",
                "probe",
                "不一定代表安装损坏",
            ),
            (
                "startup-dialog",
                "launch",
                "fail",
                "main-window",
                "错误对话框",
            ),
            (
                "main-window-timeout",
                "launch",
                "fail",
                "main-window",
                "稳定的主窗口",
            ),
            ("immediate-exit", "launch", "fail", "launch", "立即退出"),
            ("activation-failed", "launch", "fail", "launch", "修复"),
        ] {
            let diagnostics = super::msix_health_diagnostics(&health_report(failure));
            let entry = diagnostics
                .iter()
                .find(|entry| entry.name == item)
                .expect("diagnostic item exists");
            assert_eq!(entry.result, result, "{failure}/{item}");
            assert_eq!(entry.kind.as_deref(), Some(kind), "{failure}/{item}");
            let detail = entry
                .detail
                .as_deref()
                .expect("failing items carry a detail");
            assert!(detail.contains(needle), "{failure}/{item}: {detail}");
            let json = serde_json::to_value(entry).expect("diagnostic serializes");
            assert_eq!(json["kind"], kind);
            assert_eq!(json["detail"], detail);
        }
    }

    #[test]
    fn portable_diagnostics_explain_the_signature_warning_only_when_relevant() {
        use chimera_runtime::manager::ManagerDiagnostic;
        let signature = super::portable_runtime_diagnostic(ManagerDiagnostic {
            name: "package signature".to_string(),
            result: "warn".to_string(),
        });
        assert_eq!(signature.kind.as_deref(), Some("signature"));
        assert!(signature
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("安装前已验证")));
        let ownership = super::portable_runtime_diagnostic(ManagerDiagnostic {
            name: "ownership".to_string(),
            result: "pass".to_string(),
        });
        assert!(ownership.kind.is_none() && ownership.detail.is_none());
    }

    // ── One network path for checks and downloads ────────────────────────

    /// Tauri runs a synchronous command on the main thread. The catalog check
    /// spawns the Codex CLI with a 10-second timeout per candidate, so it is
    /// async and does its work on a blocking thread; so is every other
    /// command here.
    #[test]
    fn codex_cli_probes_never_run_on_the_main_thread() {
        let source = include_str!("codex_runtime.rs")
            .split("mod tests {")
            .next()
            .unwrap();
        let check = source
            .split("pub async fn verify_codex_model_catalog(")
            .nth(1)
            .expect("the catalog check is an async command")
            .split("\n}\n")
            .next()
            .unwrap();
        assert!(check.contains("tauri::async_runtime::spawn_blocking(move || {"));
        assert!(check.contains("verify_codex_model_catalog_blocking(&expected_model"));
        let blocking = source
            .split("fn verify_codex_model_catalog_blocking(")
            .nth(1)
            .unwrap();
        assert!(blocking.contains("crate::codex_config::probe_codex_runtime_models()"));
        let commands = source
            .split("#[tauri::command]")
            .skip(1)
            .collect::<Vec<_>>();
        assert!(commands.len() > 10);
        for command in commands {
            assert!(
                command.trim_start().starts_with("pub async fn "),
                "{}",
                command
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .unwrap_or_default()
            );
        }
    }

    /// Release lookups (GET and the HEAD of the latest-release redirect) never
    /// follow a hop to plain HTTP.
    #[tokio::test]
    async fn mirror_requests_refuse_a_plain_http_redirect_hop() {
        use crate::proxy::http_client::download_redirect_fixture::{start, START_URL};

        let fixture = start().await;
        for method in [reqwest::Method::GET, reqwest::Method::HEAD] {
            let error = super::send_mirror_request_with(&fixture.client, method.clone(), START_URL)
                .await
                .expect_err("a plain-HTTP hop must be refused");
            assert!(
                error.starts_with("请求失败") && error.contains("redirect"),
                "{method}: {error}"
            );
        }
        assert_eq!(fixture.target_hits(), 0);
    }

    #[test]
    fn package_downloads_use_the_shared_client_instead_of_engine_curl() {
        let runtime = include_str!("codex_runtime.rs")
            .split("mod tests {")
            .next()
            .unwrap();
        let install = runtime
            .split("fn install_runtime_release_with_observer(")
            .nth(1)
            .unwrap()
            .split("\nfn ")
            .next()
            .unwrap();
        assert!(install.contains("bounded_download::download_to_file_blocking("));
        assert!(install.contains("crate::proxy::http_client::get_for_download()?,"));
        assert!(install.contains("describe_network_mode()"));
        let skin = include_str!("skin_catalog.rs")
            .split("mod tests {")
            .next()
            .unwrap();
        assert!(skin.contains("bounded_download::download_to_file_blocking("));
        assert!(skin.contains("crate::proxy::http_client::get_for_download()?,"));
        // What decides the package and its SHA-256 (release lookups,
        // manifests, checksums, the skin catalog) goes through the same
        // HTTPS-only client as the downloads.
        let mirror = runtime
            .split("async fn send_mirror_request(")
            .nth(1)
            .unwrap()
            .split("\n}\n")
            .next()
            .unwrap();
        assert!(mirror.contains("crate::proxy::http_client::get_for_download()?;"));
        let catalog = skin
            .split("async fn fetch_catalog_text()")
            .nth(1)
            .unwrap()
            .split("\n}\n")
            .next()
            .unwrap();
        assert!(catalog.contains("crate::proxy::http_client::get_for_download()"));
        for source in [runtime, skin] {
            assert!(!source.contains("http_client::get()"));
        }
        // Neither the engine's curl downloads nor the runtime crate's
        // curl-based release helpers may come back.
        for source in [runtime, skin] {
            for forbidden in [
                "NetworkConfig::",
                "download_to_with_progress",
                "codex_win_engine::download_to(",
                "codex_win_engine::fetch_text(",
                "install_windows_release(",
                "fetch_windows_release_plan(",
            ] {
                assert!(!source.contains(forbidden), "{forbidden}");
            }
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn child_drop_does_not_terminate_process() {
        use std::process::Command;

        let child = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 3"])
            .spawn()
            .expect("spawn test child");

        let pid = child.id();
        drop(child);

        let check = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .expect("check tasklist");
        let output = String::from_utf8_lossy(&check.stdout);
        assert!(
            output.contains(&pid.to_string()),
            "Process should still exist after dropping child handle"
        );

        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &format!("{pid}")])
            .output();
    }
}
