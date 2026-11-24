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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_portable_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portable_path_error: Option<String>,
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

// Package operations and layout recovery can rename or remove directories.
// Keep them out of the external selection even if its drive is disconnected.
fn managed_root_for_maintenance() -> Result<PathBuf, String> {
    if crate::settings::get_settings()
        .codex_external_portable_root
        .is_some()
    {
        return Err(
            "已选择自备 Codex 便携版。请清除该选择后再使用 Chimera++ 的安装维护功能。".to_string(),
        );
    }
    portable_root()
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
    let root = Path::new(&installed.path);
    if installed.source == "portable" {
        let exe = portable_app_exe(root)?;
        return portable_is_running(&exe);
    }
    codex_win_engine::codex_running_for_root(root)
        .map_err(|error| format!("无法读取 Codex 进程状态: {error}"))
}

/// Whether any known Codex desktop installation currently owns a process. Only
/// Windows has a managed desktop install; elsewhere this reports `false`.
pub(crate) fn codex_desktop_is_running() -> Result<bool, String> {
    if !cfg!(target_os = "windows") {
        return Ok(false);
    }
    let settings = crate::settings::get_settings();
    let external =
        detected_external(settings.codex_external_portable_root.as_deref()).and_then(Result::ok);
    let managed_root = portable_root();
    let (msix, managed) = detect_candidates_optional(managed_root.as_deref().ok());
    // Session cleanup can touch the same CODEX_HOME from either installation.
    for installed in [external, msix, managed].into_iter().flatten() {
        if codex_is_running(&installed)? {
            return Ok(true);
        }
    }
    Ok(false)
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

fn detect_candidates_optional(
    managed_root: Option<&Path>,
) -> (
    Option<codex_win_engine::InstalledWindowsCodex>,
    Option<codex_win_engine::InstalledWindowsCodex>,
) {
    match managed_root {
        Some(root) => detect_candidates(root),
        None => (
            // The engine has one combined probe. Pass a file as the unused
            // portable directory so MSIX discovery remains independent.
            std::env::current_exe().ok().and_then(|exe| {
                codex_win_engine::detect_installed_codex(&exe)
                    .filter(|found| found.source == "msix")
            }),
            None,
        ),
    }
}

fn detected_external(
    configured_root: Option<&str>,
) -> Option<Result<codex_win_engine::InstalledWindowsCodex, String>> {
    configured_root.map(crate::settings::detect_codex_external_portable)
}

pub(crate) struct RuntimeTarget {
    pub(crate) installed: codex_win_engine::InstalledWindowsCodex,
    portable_layout_writable: bool,
}

fn select_runtime_target(
    external: Option<codex_win_engine::InstalledWindowsCodex>,
    msix: Option<codex_win_engine::InstalledWindowsCodex>,
    portable: Option<codex_win_engine::InstalledWindowsCodex>,
    prefer_portable: bool,
    managed_layout_writable: bool,
) -> Option<RuntimeTarget> {
    if let Some(installed) = external {
        return Some(RuntimeTarget {
            installed,
            portable_layout_writable: false,
        });
    }
    select_managed(msix, portable, prefer_portable).map(|installed| RuntimeTarget {
        portable_layout_writable: installed.source == "portable" && managed_layout_writable,
        installed,
    })
}

fn active_runtime_target(recover_layout: bool) -> Result<Option<RuntimeTarget>, String> {
    let settings = crate::settings::get_settings();
    let external_root = settings.codex_external_portable_root.as_deref();
    if let Some(Ok(installed)) = detected_external(external_root) {
        return Ok(Some(RuntimeTarget {
            installed,
            portable_layout_writable: false,
        }));
    }
    managed_runtime_target(
        portable_root().as_deref().ok(),
        external_root,
        recover_layout,
    )
}

fn managed_runtime_target(
    root: Option<&Path>,
    external_root: Option<&str>,
    recover_layout: bool,
) -> Result<Option<RuntimeTarget>, String> {
    let writable_root =
        root.filter(|root| verify_managed_layout_access(root, external_root).is_ok());
    if recover_layout {
        if let Some(root) = writable_root {
            recover_interrupted_layout(root)?;
        }
    }
    // Discovery needs no layout writes. An unresolved external volume blocks
    // recovery and migration, while a verified managed payload can still run.
    let (msix, portable) = detect_candidates_optional(root);
    let prefer_portable = msix.is_some() && portable.is_some() && portable_preferred();
    Ok(select_runtime_target(
        None,
        msix,
        portable,
        prefer_portable,
        writable_root.is_some(),
    ))
}

// If an external selection became unreadable, do not recover or migrate a
// managed installation unless its destination and recovery directories are
// demonstrably outside that selection.
fn verify_managed_layout_access(managed: &Path, external_root: Option<&str>) -> Result<(), String> {
    if let Some(raw) = external_root {
        let external = crate::settings::validate_portable_root_path(Path::new(raw), false)?;
        verify_distinct_managed_root(managed, &external)?;
    }
    Ok(())
}

fn verify_distinct_managed_root(managed: &Path, external: &Path) -> Result<(), String> {
    let comparable_external = resolve_existing_ancestor(external)?;
    let mut candidates = codex_portable_layout::staging_dirs(managed);
    candidates.push(managed.to_path_buf());
    for candidate in candidates {
        let candidate = resolve_existing_ancestor(&candidate)?;
        if normalized_windows_path(&candidate) == normalized_windows_path(&comparable_external)
            || path_within_root(&candidate, &comparable_external)
            || path_within_root(&comparable_external, &candidate)
        {
            return Err("托管 Codex 目录或恢复目录与自备便携版重叠".to_string());
        }
    }
    Ok(())
}

fn resolve_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    match path.canonicalize() {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
                return Ok(resolve_existing_ancestor(parent)?.join(name));
            }
            Err(format!("无法验证 Codex 目录 {}：{error}", path.display()))
        }
        Err(error) => Err(format!("无法验证 Codex 目录 {}：{error}", path.display())),
    }
}

/// Caller holds the runtime operation lock before resolving a launch target.
pub(crate) fn runtime_target_for_launch() -> Result<RuntimeTarget, String> {
    active_runtime_target(true)?.ok_or_else(|| {
        "未检测到 Codex 安装。请在“Codex 管理”中选择现有便携版目录或安装 Codex。".to_string()
    })
}

fn detect_managed_codex(portable_root: &Path) -> Option<codex_win_engine::InstalledWindowsCodex> {
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
fn recover_interrupted_layout(portable_root: &Path) -> Result<(), String> {
    if !codex_portable_layout::migration_interrupted(portable_root) {
        return Ok(());
    }
    prepare_portable_layout(portable_root).map(|_| ())
}

/// While a migration is interrupted the install root is missing, so the
/// renderer offers neither "open" nor "repair". Status reads therefore heal it
/// under the operation lock. Returns why it is still interrupted, if it is.
fn heal_interrupted_layout(root: &Path) -> Option<String> {
    if !codex_portable_layout::migration_interrupted(root) {
        return None;
    }
    acquire_operation_lock("codex_runtime_layout_recovery")
        .and_then(|_guard| {
            // The selection or managed destination may have changed while we waited.
            let settings = crate::settings::get_settings();
            let external_root = settings.codex_external_portable_root.as_deref();
            if !matches!(detected_external(external_root), Some(Ok(_)))
                && portable_root().as_deref() == Ok(root)
                && verify_managed_layout_access(root, external_root).is_ok()
            {
                recover_interrupted_layout(root)?;
            }
            Ok(())
        })
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
    if renderer_unlock_available(installed) && crate::codex_cdp::has_model_unlock_config() {
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
    target: &RuntimeTarget,
    failure_prefix: &str,
) -> Result<LaunchReport, String> {
    let report = launch_codex_checked(target, renderer_unlock_launch_options(&target.installed))
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

fn wait_for_codex_stopped_for(
    installed: &codex_win_engine::InstalledWindowsCodex,
    max_polls: usize,
) -> Result<bool, String> {
    // Electron can briefly replace the main process while it is shutting down.
    // Require a full second of consecutive path-pinned scans with no matching
    // process before starting the replacement instance. Transient probe errors
    // (such as ACCESS_DENIED / exiting handles during shutdown) are retried
    // until the deadline and fail closed if they persist to the end.
    let mut clear_polls = 0_u8;
    let mut last_probe_error: Option<String> = None;
    for _ in 0..max_polls {
        match codex_is_running(installed) {
            Ok(true) => {
                clear_polls = 0;
                last_probe_error = None;
            }
            Ok(false) => {
                last_probe_error = None;
                clear_polls += 1;
                if clear_polls >= 4 {
                    return Ok(true);
                }
            }
            Err(error) => {
                clear_polls = 0;
                last_probe_error = Some(error);
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if let Some(error) = last_probe_error {
        return Err(error);
    }
    Ok(false)
}

fn wait_for_codex_stopped(
    installed: &codex_win_engine::InstalledWindowsCodex,
) -> Result<bool, String> {
    wait_for_codex_stopped_for(installed, 120)
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
    Ok(configure_portable_command(
        launcher, root, codex_home, options,
    ))
}

fn direct_portable_command(
    root: &Path,
    codex_home: &Path,
    options: codex_win_engine::LaunchOptions<'_>,
) -> Result<Command, String> {
    let exe = portable_app_exe(root)?;
    let app_dir = exe
        .parent()
        .ok_or_else(|| "无法确定 Codex 主程序目录".to_string())?;
    let mut command = configure_portable_command(&exe, app_dir, codex_home, options);
    // As in the pinned engine's portable launcher, use the bundled CLI when
    // no explicit CLI override was supplied, and do not use the MSIX core.
    command.env_remove("CODEX_WINDOWS_REGISTERED_CORE");
    if std::env::var_os("CODEX_CLI_PATH")
        .is_none_or(|value| value.to_string_lossy().trim().is_empty())
    {
        if let Some(cli) = ["resources/codex.exe", "resources/bin/codex.exe"]
            .into_iter()
            .map(|relative| app_dir.join(relative))
            .find(|path| path.is_file())
        {
            command.env("CODEX_CLI_PATH", cli);
        }
    }
    Ok(command)
}

fn configure_portable_command(
    program: impl AsRef<std::ffi::OsStr>,
    working_dir: &Path,
    codex_home: &Path,
    options: codex_win_engine::LaunchOptions<'_>,
) -> Command {
    let mut command = Command::new(program);
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
    command
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

fn normalized_windows_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
    };
    text.trim_end_matches('\\').to_lowercase()
}

/// Component-boundary path comparison, including the Windows verbatim prefix.
fn path_within_root(candidate: &Path, root: &Path) -> bool {
    let candidate = normalized_windows_path(candidate);
    let root = normalized_windows_path(root);
    !root.is_empty()
        && candidate
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

fn portable_app_exe(root: &Path) -> Result<PathBuf, String> {
    codex_win_engine::installed_app_exe(root)
        .ok_or_else(|| "找不到 Codex 便携版主程序，请检查安装目录".to_string())
}

#[cfg(any(windows, test))]
fn matches_portable_image(candidate: &Path, expected: &Path) -> bool {
    normalized_windows_path(candidate) == normalized_windows_path(expected)
}

#[cfg(windows)]
mod portable_process {
    use super::{matches_portable_image, Path};
    use std::{
        ffi::OsString,
        os::windows::{
            ffi::OsStringExt,
            io::{FromRawHandle, OwnedHandle},
        },
    };
    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    fn is_exited_process_error(error: &std::io::Error) -> bool {
        // ERROR_INVALID_PARAMETER (87), ERROR_GEN_FAILURE (31), ERROR_PARTIAL_COPY (299):
        // commonly returned when a process exits between snapshot and image query.
        matches!(error.raw_os_error(), Some(87 | 31 | 299))
    }

    pub(super) fn image_path(pid: u32) -> std::io::Result<Option<std::path::PathBuf>> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            let error = std::io::Error::last_os_error();
            return if is_exited_process_error(&error) {
                Ok(None) // The process exited since the snapshot.
            } else {
                Err(error)
            };
        }
        let _handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut buffer = vec![0_u16; 32_768];
        let mut size = buffer.len() as u32;
        if unsafe {
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size)
        } == 0
        {
            let error = std::io::Error::last_os_error();
            return if is_exited_process_error(&error) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        Ok(Some(OsString::from_wide(&buffer[..size as usize]).into()))
    }

    fn image_matches(pid: u32, exe: &Path) -> std::io::Result<bool> {
        Ok(image_path(pid)?.is_some_and(|image| matches_portable_image(&image, exe)))
    }

    pub(super) fn matching_pids(exe: &Path) -> Result<Vec<u32>, String> {
        fn snapshot(snapshot: HANDLE, exe: &Path) -> std::io::Result<Vec<u32>> {
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut found = unsafe { Process32FirstW(snapshot, &mut entry) };
            let mut pids = Vec::new();
            while found != 0 {
                let length = entry
                    .szExeFile
                    .iter()
                    .position(|&unit| unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = OsString::from_wide(&entry.szExeFile[..length]);
                if exe.file_name().is_some_and(|exe_name| {
                    name.to_string_lossy().to_lowercase()
                        == exe_name.to_string_lossy().to_lowercase()
                }) {
                    if let Ok(true) = image_matches(entry.th32ProcessID, exe) {
                        pids.push(entry.th32ProcessID);
                    }
                }
                found = unsafe { Process32NextW(snapshot, &mut entry) };
            }
            Ok(pids)
        }
        let result = (|| {
            let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
            if raw == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error());
            }
            let _snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
            snapshot(raw, exe)
        })();
        result.map_err(|error| format!("无法读取 Codex 进程列表：{error}"))
    }

    pub(super) fn running(exe: &Path) -> Result<bool, String> {
        fn snapshot(snapshot: HANDLE, exe: &Path) -> std::io::Result<bool> {
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut found = unsafe { Process32FirstW(snapshot, &mut entry) };
            let mut probe_error = None;
            while found != 0 {
                let length = entry
                    .szExeFile
                    .iter()
                    .position(|&unit| unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = OsString::from_wide(&entry.szExeFile[..length]);
                if exe.file_name().is_some_and(|exe_name| {
                    name.to_string_lossy().to_lowercase()
                        == exe_name.to_string_lossy().to_lowercase()
                }) {
                    match image_matches(entry.th32ProcessID, exe) {
                        Ok(true) => return Ok(true),
                        Ok(false) => {}
                        Err(error) => probe_error = Some(error),
                    }
                }
                found = unsafe { Process32NextW(snapshot, &mut entry) };
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                return Err(error);
            }
            probe_error.map_or(Ok(false), Err)
        }
        let result = (|| {
            let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
            if raw == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error());
            }
            let _snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
            snapshot(raw, exe)
        })();
        result.map_err(|error| format!("无法读取 Codex 进程状态：{error}"))
    }
}

fn portable_is_running(exe: &Path) -> Result<bool, String> {
    #[cfg(windows)]
    {
        portable_process::running(exe)
    }
    #[cfg(not(windows))]
    {
        let _ = exe;
        Err("Codex 进程检查仅支持 Windows".to_string())
    }
}

/// A portable launcher owns one specific payload, while an MSIX app owns
/// its package directory and can run a payload in a nested directory.
#[derive(Clone, Copy)]
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
enum StartupImage<'a> {
    PortableExe(&'a Path),
    MsixRoot(&'a Path),
}

#[cfg(any(windows, test))]
impl StartupImage<'_> {
    fn owns_image(self, image: &Path) -> bool {
        match self {
            Self::PortableExe(exe) => matches_portable_image(image, exe),
            Self::MsixRoot(root) => path_within_root(image, root),
        }
    }
}

#[cfg(windows)]
fn visit_codex_windows(
    target: StartupImage<'_>,
    include_hidden: bool,
    visit: impl FnMut(windows_sys::Win32::Foundation::HWND),
) -> Result<(), String> {
    use std::collections::HashMap;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER,
    };

    struct Probe<'a, F> {
        target: StartupImage<'a>,
        include_hidden: bool,
        matches: HashMap<u32, bool>,
        visit: F,
    }
    unsafe extern "system" fn inspect<F: FnMut(HWND)>(hwnd: HWND, param: LPARAM) -> i32 {
        let probe = unsafe { &mut *(param as *mut Probe<'_, F>) };
        let eligible = if probe.include_hidden {
            unsafe { GetWindow(hwnd, GW_OWNER).is_null() }
        } else {
            unsafe { IsWindowVisible(hwnd) != 0 }
        };
        if eligible {
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
            let target = probe.target;
            if *probe.matches.entry(pid).or_insert_with(|| {
                portable_process::image_path(pid)
                    .ok()
                    .flatten()
                    .is_some_and(|image| target.owns_image(&image))
            }) {
                (probe.visit)(hwnd);
            }
        }
        1
    }
    fn enumerate<F: FnMut(HWND)>(probe: &mut Probe<'_, F>) -> Result<(), String> {
        if unsafe { EnumWindows(Some(inspect::<F>), probe as *mut _ as LPARAM) } == 0 {
            return Err("无法枚举 Codex 窗口".to_string());
        }
        Ok(())
    }
    enumerate(&mut Probe {
        target,
        include_hidden,
        matches: HashMap::new(),
        visit,
    })
}

#[cfg(windows)]
fn codex_startup_probe(target: StartupImage<'_>) -> Result<StartupProbe, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let running = match target {
        StartupImage::PortableExe(exe) => portable_is_running(exe)?,
        StartupImage::MsixRoot(root) => codex_win_engine::codex_running_for_root(root)
            .map_err(|error| format!("无法读取 Codex 进程状态：{error}"))?,
    };
    if !running {
        return Ok(StartupProbe::NotRunning);
    }
    let mut windows = CodexStartupWindows::default();
    visit_codex_windows(target, false, |hwnd| {
        let mut class = [0_u16; 128];
        let length = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
        if length > 0 {
            windows.observe(&String::from_utf16_lossy(&class[..length as usize]));
        }
    })?;
    Ok(windows.probe(true))
}

#[cfg(not(windows))]
fn codex_startup_probe(_target: StartupImage<'_>) -> Result<StartupProbe, String> {
    Err("Codex 主窗口检查仅支持 Windows".to_string())
}

fn prepare_portable_launch(
    target: &RuntimeTarget,
    codex_home: &Path,
    options: codex_win_engine::LaunchOptions<'_>,
) -> Result<(Command, Option<LayoutMigrationOutcome>), String> {
    let root = Path::new(&target.installed.path);
    if target.portable_layout_writable {
        let layout = prepare_portable_layout(root)?;
        return Ok((
            portable_command_with_codex_home(root, codex_home, options)?,
            layout,
        ));
    }
    Ok((direct_portable_command(root, codex_home, options)?, None))
}

fn launch_portable_with_codex_home(
    target: &RuntimeTarget,
    codex_home: &Path,
    options: codex_win_engine::LaunchOptions<'_>,
) -> Result<LaunchReport, String> {
    let (mut command, layout) = prepare_portable_launch(target, codex_home, options)?;
    let exe = portable_app_exe(Path::new(&target.installed.path))?;
    let mut launcher = command
        .spawn()
        .map_err(|error| format!("Codex 免安装版启动失败: {error}"))?;
    let launcher_deadline = Instant::now() + Duration::from_secs(15);
    if target.portable_layout_writable {
        wait_for_portable_launcher(&mut launcher, launcher_deadline)?;
    }
    let verdict = wait_for_startup(|| {
        let probe = codex_startup_probe(StartupImage::PortableExe(&exe))?;
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
    })?;
    Ok(LaunchReport { verdict, layout })
}

fn wait_for_portable_launcher(
    launcher: &mut std::process::Child,
    deadline: Instant,
) -> Result<(), String> {
    loop {
        if let Some(status) = launcher
            .try_wait()
            .map_err(|error| format!("无法检查 Codex 启动器状态: {error}"))?
        {
            if !status.success() {
                return Err(format!("Codex 免安装版启动器退出: {status}"));
            }
            return Ok(());
        }
        if Instant::now() >= deadline {
            let _ = launcher.kill();
            let _ = launcher.wait();
            return Err("Codex 免安装版启动器超时".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
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
    target: &RuntimeTarget,
    options: codex_win_engine::LaunchOptions<'_>,
) -> Result<(), String> {
    match launch_codex_checked(target, options)?.verdict {
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
    target: &RuntimeTarget,
    mut options: codex_win_engine::LaunchOptions<'_>,
) -> Result<LaunchReport, String> {
    let codex_home = crate::codex_config::get_codex_config_dir();

    let installed = &target.installed;
    let root = Path::new(&installed.path);
    if installed.source == "portable" {
        return launch_portable_with_codex_home(target, &codex_home, options);
    }
    let report = |verdict| LaunchReport {
        verdict,
        layout: None,
    };

    let msix_probe = || codex_startup_probe(StartupImage::MsixRoot(root));

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
                    return wait_for_startup(msix_probe).map(report);
                }
                options.remote_debugging_port = None;
            }
        }
    }

    // Without renderer injection, prefer the environment-aware shell activation.
    // The engine fallback cannot propagate CODEX_HOME, so only use it for the
    // default config directory. Never silently launch against another profile.
    match launch_msix_with_codex_home(&codex_home, options) {
        Ok(()) => wait_for_startup(msix_probe).map(report),
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
) -> Result<(), String> {
    if installed.source == "msix" {
        codex_win_engine::close_msix_codex_processes(30)
            .map_err(|error| format!("无法关闭 Codex: {error}"))?;
        if !wait_for_codex_stopped(installed)? {
            return Err("Codex 未能完全退出，已取消重启".to_string());
        }
    } else {
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
            let exe = portable_app_exe(Path::new(&installed.path))?;
            // Include hidden ownerless windows so tray-minimized portable Codex receives WM_CLOSE.
            visit_codex_windows(StartupImage::PortableExe(&exe), true, |hwnd| {
                unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) };
            })?;
            // Wait up to 10s for graceful shutdown before falling back to path-pinned termination.
            if !wait_for_codex_stopped_for(installed, 40)? {
                for pid in portable_process::matching_pids(&exe)? {
                    crate::process_utils::terminate_process_tree(pid);
                }
                if !wait_for_codex_stopped_for(installed, 80)? {
                    return Err("Codex 未能完全退出，已取消重启".to_string());
                }
            }
        }
        #[cfg(not(windows))]
        if !wait_for_codex_stopped(installed)? {
            return Err("Codex 未能完全退出，已取消重启".to_string());
        }
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
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_restart_catalog")?;
        let target = runtime_target_for_launch()?;
        let installed = &target.installed;
        let was_running = codex_is_running(installed)?;
        close_codex_for_restart(installed)?;
        let launch = launch_for_command(&target, "")?;
        let running = wait_for_codex_running(installed)?;
        if !running {
            return Err("Codex 重启后未保持运行，请在“Codex 管理”中运行诊断".to_string());
        }
        let model_unlock = renderer_unlock_status(installed);
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
    tauri::async_runtime::spawn_blocking(move || {
        let Some(RuntimeTarget { installed, .. }) = active_runtime_target(false)? else {
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
    let confirm_restart = confirm_restart.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_launch")?;
        let target = runtime_target_for_launch()?;
        let installed = &target.installed;
        let was_running = codex_is_running(installed)?;
        if was_running && !confirm_restart {
            return Err(format!(
                "{OPEN_CODEX_RESTART_CONFIRMATION_REQUIRED_PREFIX}Codex 正在运行，继续将关闭并重新启动它以应用最新配置，\
                 期间的任何未完成操作都会中断。"
            ));
        }
        // Always pass through the shutdown gate. It is a no-op when the target
        // is already stopped, and it removes the discovery/launch race where a
        // just-started Electron child could otherwise survive the restart.
        close_codex_for_restart(installed)?;
        // A second portable Electron process may exit after handing focus to
        // an already-running instance. We intentionally reject that path: a
        // previous target was either absent or confirmed closed, so accepting
        // it could hide a failed replacement.
        let launch = launch_for_command(&target, "无法启动 Codex：")?;
        let running = wait_for_codex_running(installed)?;
        if !running {
            return Err("Codex 启动后未保持运行，请在“Codex 管理”中运行诊断".to_string());
        }
        let model_unlock = renderer_unlock_status(installed);
        Ok(launch_result(was_running, running, model_unlock, launch))
    })
    .await
    .map_err(|error| format!("Codex 启动任务中断: {error}"))?
}

fn operation_lock() -> OperationLock {
    OperationLock::new(runtime_root().join("operation.lock"))
}

/// Whether a Codex install, update or skin operation holds the runtime lock at
/// this moment. Quitting in the middle of one can leave a half-swapped folder
/// that only the install journal repairs at the next start.
pub(crate) fn runtime_operation_in_progress() -> bool {
    matches!(
        operation_lock().try_acquire("app_exit_probe"),
        Err(LockError::AlreadyHeld { .. })
    )
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
            if let Some(health) = accepted_msix_install_health(report.success, || {
                verify_msix_health_with_main_window(portable_root)
            }) {
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
    if !cfg!(target_os = "windows") {
        return Ok(CodexRuntimeStatus {
            supported: false,
            installed: false,
            version: None,
            install_mode: None,
            install_path: None,
            portable_root: String::new(),
            external_portable_root: None,
            portable_path_error: None,
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
        let settings = crate::settings::get_settings();
        let external_root = settings.codex_external_portable_root;
        let external = detected_external(external_root.as_deref()).transpose();
        let external_found = external.as_ref().is_ok_and(Option::is_some);
        let managed_root = portable_root();
        let root = managed_root.as_deref().ok();
        let writable_root = root.filter(|root| {
            !external_found && verify_managed_layout_access(root, external_root.as_deref()).is_ok()
        });
        let recovery_error = writable_root.and_then(heal_interrupted_layout);
        let (msix, portable_candidate) = detect_candidates_optional(root);
        let prefer_portable =
            msix.is_some() && portable_candidate.is_some() && portable_preferred();
        let unmanaged_standard_version = if external_found || prefer_portable {
            msix.as_ref().map(|value| value.version.clone())
        } else {
            None
        };
        let portable_path_error = external.as_ref().err().cloned().or_else(|| {
            if external_found {
                None
            } else {
                managed_root.as_ref().err().cloned()
            }
        });
        let installed = select_runtime_target(
            external.ok().flatten(),
            msix,
            portable_candidate,
            prefer_portable,
            writable_root.is_some(),
        )
        .map(|target| runtime_install(target.installed));
        let can_manage = external_root.is_none() && root.is_some();
        let rollback = if can_manage {
            root.and_then(|root| latest_portable_rollback(root).ok().flatten())
        } else {
            None
        };
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
        let (portable_layout, mut layout_notice) = writable_root
            .map(|root| portable_layout_status(portable, root))
            .unwrap_or_default();
        if portable_layout.as_deref() == Some("interrupted") && recovery_error.is_some() {
            layout_notice = recovery_error;
        }
        Ok(CodexRuntimeStatus {
            supported: true,
            installed: installed.is_some(),
            version: installed.as_ref().map(|value| value.version.clone()),
            install_mode: installed.as_ref().map(|value| value.install_mode.clone()),
            install_path: installed.as_ref().map(|value| value.path.clone()),
            portable_root: root
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
            external_portable_root: external_root,
            portable_path_error,
            can_repair: can_manage && installed.is_some(),
            can_rollback: can_manage && portable && rollback.is_some(),
            can_uninstall: can_manage && installed.is_some(),
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
pub async fn set_codex_external_portable_root(path: Option<String>) -> Result<(), String> {
    require_windows()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_select_portable")?;
        let selected = detected_external(path.as_deref())
            .transpose()?
            .map(|installed| installed.path);
        let previous = crate::settings::get_settings().codex_external_portable_root;
        if previous == selected {
            return Ok(());
        }
        if codex_desktop_is_running()? {
            return Err("请先完全关闭 Codex，再更换或清除便携版目录。".to_string());
        }
        crate::settings::mutate_settings(|settings| {
            settings.codex_external_portable_root = selected
        })
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "保存 Codex 便携版目录时任务中断".to_string())?
}

#[tauri::command]
pub async fn open_codex_runtime_directory(handle: AppHandle) -> Result<bool, String> {
    require_windows()?;
    let path = tauri::async_runtime::spawn_blocking(|| {
        active_runtime_target(false)?
            .map(|target| PathBuf::from(target.installed.path))
            .ok_or_else(|| "未检测到 Codex 安装".to_string())
    })
    .await
    .map_err(|_| "读取 Codex 安装目录时任务中断".to_string())??;
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
    let plan = fetch_latest_runtime_plan().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let current_version = active_runtime_target(false)?.map(|target| target.installed.version);
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

fn accepted_msix_install_health(
    installed: bool,
    verify: impl FnOnce() -> codex_win_engine::MsixHealthReport,
) -> Option<codex_win_engine::MsixHealthReport> {
    installed.then(verify).filter(msix_health_accepts_install)
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
fn diagnose_windows_codex_non_destructive() -> Vec<CodexRuntimeDiagnostic> {
    let target = match active_runtime_target(true) {
        Ok(target) => target,
        Err(reason) => {
            return vec![
                CodexRuntimeDiagnostic::new("installation", "warn").because("layout", reason)
            ]
        }
    };
    let Some(target) = target else {
        return vec![CodexRuntimeDiagnostic::new("installation", "fail").because(
            "not-installed",
            "没有检测到 Codex 标准版或免安装版。请在“Codex 管理”中安装 Codex；如果使用免安装版，请在设置中确认免安装版目录。",
        )];
    };
    let installed = target.installed;
    let install_root = Path::new(&installed.path);
    if installed.source == "portable" {
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
    let health = classify_msix_health(
        codex_win_engine::verify_msix_health_with_options(true),
        || codex_is_running(&installed).unwrap_or(false),
    );
    diagnostics.extend(msix_health_diagnostics(&health));
    diagnostics
}

/// Run installation diagnostics only after a user action, under a shared
/// operation lock, and without terminating a running Codex instance.
#[tauri::command]
pub async fn diagnose_codex_runtime() -> Result<Vec<CodexRuntimeDiagnostic>, String> {
    require_windows()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_diagnose")?;
        Ok(diagnose_windows_codex_non_destructive())
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
    let plan = fetch_latest_runtime_plan().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_install")?;
        let portable_root = managed_root_for_maintenance()?;
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
    // Recover any interrupted portable layout and detect installation off the async
    // executor under the operation lock, then release the lock before `install_release`
    // acquires it for the reinstall phase.
    let installed = tauri::async_runtime::spawn_blocking(|| {
        let _guard = acquire_operation_lock("codex_runtime_repair")?;
        let portable_root = managed_root_for_maintenance()?;
        recover_interrupted_layout(&portable_root)?;
        detect_managed_install(&portable_root)
            .ok_or_else(|| "未检测到 Codex，请先执行安装".to_string())
    })
    .await
    .map_err(|error| format!("检测 Codex 安装任务失败：{error}"))??;
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
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_rollback")?;
        let portable_root = managed_root_for_maintenance()?;
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
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_uninstall")?;
        let portable_root = managed_root_for_maintenance()?;
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

/// tag 只允许 GitHub release tag 的保守字符集，防止 URL 注入与路径穿越。
fn validate_mirror_tag(tag: &str) -> Result<(), String> {
    let valid = !tag.is_empty()
        && tag.len() <= 100
        && tag != "."
        && tag != ".."
        && !tag.contains("..")
        && tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err("版本 tag 含有非法字符".to_string())
    }
}

fn validate_mirror_package_url(raw_url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(raw_url.trim())
        .map_err(|_| "安装包地址不在受信任的镜像发布源内".to_string())?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || parsed.port().is_some_and(|p| p != 443)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("安装包地址不在受信任的镜像发布源内".to_string());
    }
    if raw_url.contains("..") {
        return Err("安装包地址不在受信任的镜像发布源内".to_string());
    }
    let expected_prefix = format!("/{MIRROR_REPO}/releases/download/");
    let Some(rest) = parsed.path().strip_prefix(&expected_prefix) else {
        return Err("安装包地址不在受信任的镜像发布源内".to_string());
    };
    let mut segments = rest.split('/');
    let Some(tag) = segments.next() else {
        return Err("安装包地址不在受信任的镜像发布源内".to_string());
    };
    let Some(asset) = segments.next() else {
        return Err("安装包地址不在受信任的镜像发布源内".to_string());
    };
    if segments.next().is_some() || validate_mirror_tag(tag).is_err() || asset.is_empty() {
        return Err("安装包地址不在受信任的镜像发布源内".to_string());
    }
    Ok(())
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
    let page = page.unwrap_or(1).clamp(1, 50) as usize;
    // GitHub lists releases by creation time, and every mirror release points
    // at the same commit, so the API order is not version order and a page of
    // ten can miss the newest builds. Read the catalog, order it by version,
    // then page locally.
    let mut releases = Vec::new();
    for api_page in 1..=MIRROR_CATALOG_MAX_PAGES {
        let url = format!(
            "https://api.github.com/repos/{MIRROR_REPO}/releases?per_page={MIRROR_CATALOG_PAGE_SIZE}&page={api_page}"
        );
        let body = fetch_mirror_text(&url)
            .await
            .map_err(|error| format!("获取历史版本目录失败: {error}"))?;
        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|error| format!("解析历史版本目录失败: {error}"))?;
        let Some(items) = value.as_array() else {
            return Err("历史版本目录格式异常".to_string());
        };
        releases.extend(releases_from_items(items));
        if items.len() < MIRROR_CATALOG_PAGE_SIZE {
            break;
        }
    }
    sort_releases_newest_first(&mut releases);
    Ok(release_page(releases, page))
}

const MIRROR_CATALOG_PAGE_SIZE: usize = 100;
const MIRROR_CATALOG_MAX_PAGES: usize = 3;
const HISTORY_PAGE_SIZE: usize = 10;

/// Numeric version of a mirror tag such as `codex-app-26.1027.30824`.
fn release_version(tag: &str) -> Option<Vec<u64>> {
    let digits = tag.trim_start_matches(|c: char| !c.is_ascii_digit());
    let parts: Option<Vec<u64>> = digits
        .split('.')
        .map(|part| part.parse::<u64>().ok())
        .collect();
    parts.filter(|parts| !parts.is_empty())
}

/// Highest version first; unparsable tags fall back to publish time and sort
/// after every versioned release.
fn sort_releases_newest_first(releases: &mut [CodexRuntimeRelease]) {
    releases.sort_by(|a, b| {
        release_version(&b.tag)
            .cmp(&release_version(&a.tag))
            .then_with(|| b.published_at.cmp(&a.published_at))
            .then_with(|| b.tag.cmp(&a.tag))
    });
}

fn release_page(releases: Vec<CodexRuntimeRelease>, page: usize) -> Vec<CodexRuntimeRelease> {
    releases
        .into_iter()
        .skip((page.max(1) - 1) * HISTORY_PAGE_SIZE)
        .take(HISTORY_PAGE_SIZE)
        .collect()
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
    // 目标锁定：确认对象的下载地址必须位于受信任的镜像发布源内（规范化解析防 `..` 绕过）。
    validate_mirror_package_url(&plan.package_url)?;
    let root = runtime_root();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_install")?;
        let portable_root = managed_root_for_maintenance()?;
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
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = acquire_operation_lock("codex_runtime_install")?;
        let portable_root = managed_root_for_maintenance()?;
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

        let mut observer = install_journal_observer(&journal, &journal_id);
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
    use std::path::Path;

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
        use super::accepted_msix_install_health;

        assert!(accepted_msix_install_health(false, || {
            panic!("a failed registration must not probe or accept a pre-existing installation")
        })
        .is_none());
        assert!(accepted_msix_install_health(true, || health_report("startup-dialog")).is_none());
        assert!(
            accepted_msix_install_health(true, || health_report("main-window-timeout")).is_none()
        );
        assert!(accepted_msix_install_health(true, || health_report("")).is_some());
        assert!(
            accepted_msix_install_health(true, || health_report(super::MSIX_WINDOW_SLOW)).is_some()
        );
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
                body.find("renderer_unlock_available(&target.installed)")
                    .unwrap()
                    < body
                        .find("close_codex_for_restart(&target.installed)")
                        .unwrap()
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
            external_portable_root: None,
            portable_path_error: None,
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

    fn catalog_release(tag: &str, published_at: Option<&str>) -> super::CodexRuntimeRelease {
        super::CodexRuntimeRelease {
            tag: tag.to_string(),
            name: None,
            published_at: published_at.map(str::to_string),
            prerelease: false,
            installable: true,
        }
    }

    #[test]
    fn release_catalog_orders_by_version_not_api_order() {
        // The mirror's API order puts 26.930 before 26.1027 (same creation time).
        let mut releases = vec![
            catalog_release("codex-app-26.930.61225", Some("2026-09-12T21:35:28Z")),
            catalog_release("codex-app-26.917.71314", Some("2026-09-12T21:35:28Z")),
            catalog_release("codex-app-26.1027.30824", Some("2026-09-12T21:35:28Z")),
            catalog_release("codex-app-26.1023.11111", None),
            catalog_release("nightly", Some("2026-10-30T00:00:00Z")),
        ];
        super::sort_releases_newest_first(&mut releases);
        let tags: Vec<&str> = releases
            .iter()
            .map(|release| release.tag.as_str())
            .collect();
        assert_eq!(
            tags,
            [
                "codex-app-26.1027.30824",
                "codex-app-26.1023.11111",
                "codex-app-26.930.61225",
                "codex-app-26.917.71314",
                "nightly",
            ]
        );
    }

    #[test]
    fn release_catalog_pages_locally_after_sorting() {
        let releases: Vec<_> = (1..=25)
            .map(|n| catalog_release(&format!("codex-app-26.{n}.1"), None))
            .collect();
        let mut sorted = releases.clone();
        super::sort_releases_newest_first(&mut sorted);
        let first = super::release_page(sorted.clone(), 1);
        let third = super::release_page(sorted.clone(), 3);
        assert_eq!(first.len(), 10);
        assert_eq!(first[0].tag, "codex-app-26.25.1");
        assert_eq!(third.len(), 5);
        assert_eq!(third[4].tag, "codex-app-26.1.1");
        assert!(super::release_page(sorted, 4).is_empty());
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
    fn startup_probe_matches_msix_package_and_portable_payload_differently() {
        use super::StartupImage;

        let package = Path::new(r"C:\Program Files\WindowsApps\OpenAI.Codex_123");
        let payload = package.join("app").join("Codex.exe");
        let other = Path::new(r"C:\Program Files\WindowsApps\OpenAI.Codex_1234\app\Codex.exe");
        assert!(StartupImage::MsixRoot(package).owns_image(&payload));
        assert!(!StartupImage::MsixRoot(package).owns_image(other));
        assert!(!StartupImage::PortableExe(package).owns_image(&payload));
        assert!(StartupImage::PortableExe(&payload).owns_image(&payload));
        assert!(!StartupImage::PortableExe(&payload).owns_image(other));
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
            "codex_runtime_rollback",
            "codex_runtime_uninstall",
            "codex_runtime_install",
        ] {
            let lock_call = format!("acquire_operation_lock(\"{lock}\")?;");
            let bodies: Vec<_> = source.split(&lock_call).skip(1).collect();
            assert!(!bodies.is_empty(), "{lock}");
            for body in bodies {
                let body = body.trim_start();
                let after_guard = body
                    .strip_prefix("let portable_root = managed_root_for_maintenance()?;")
                    .unwrap_or_else(|| panic!("{lock} must protect the selected folder"));
                assert!(after_guard
                    .trim_start()
                    .starts_with("recover_interrupted_layout(&portable_root)?;"));
            }
        }
        for lock in ["codex_runtime_launch", "codex_runtime_restart_catalog"] {
            let lock_call = format!("acquire_operation_lock(\"{lock}\")?;");
            let body = source.split_once(&lock_call).unwrap().1;
            assert!(
                body.trim_start()
                    .starts_with("let target = runtime_target_for_launch()?;"),
                "{lock}"
            );
        }
    }

    fn external_portable_test_dir() -> tempfile::TempDir {
        let parent = std::env::temp_dir();
        // macOS exposes its temporary directory through the /var symlink.
        #[cfg(not(windows))]
        let parent = parent.canonicalize().expect("resolve portable test parent");
        tempfile::tempdir_in(parent).expect("create portable test directory")
    }

    fn write_external_portable_fixture(
        root: &Path,
        nested: bool,
        executable: &str,
        product: &str,
    ) -> std::path::PathBuf {
        let app = if nested {
            root.join("app")
        } else {
            root.to_path_buf()
        };
        std::fs::create_dir_all(app.join("resources")).unwrap();
        let exe = app.join(executable);
        std::fs::write(&exe, b"payload fixture").unwrap();
        std::fs::write(app.join("resources/app.asar"), b"resource fixture").unwrap();
        std::fs::write(root.join("AppxManifest.xml"), format!(
            r#"<Package><Identity Name="{product}" Publisher="CN=Fixture" Version="1.2.3.4" ProcessorArchitecture="x64"/><Applications><Application Executable="{executable}"/></Applications></Package>"#,
        )).unwrap();
        exe
    }

    #[test]
    fn selected_portable_resolves_flat_and_nested_payloads_without_install_writes() {
        let dir = external_portable_test_dir();
        for (nested, executable) in [(false, "Codex.exe"), (true, "ChatGPT.exe")] {
            // Also exercise selection from a child of a managed install location.
            let root = dir
                .path()
                .join("Managed Codex")
                .join(format!("自定义-{executable}"));
            let exe = write_external_portable_fixture(&root, nested, executable, "OpenAI.Codex");
            let selected = super::detected_external(root.to_str()).unwrap().unwrap();
            let target = super::select_runtime_target(
                Some(selected),
                Some(installed("msix", "9")),
                Some(installed("portable", "8")),
                false,
                true,
            )
            .unwrap();
            assert!(!target.portable_layout_writable);
            assert_eq!(Path::new(&target.installed.path), root);
            let codex_home = dir.path().join("custom home");
            let command = super::direct_portable_command(
                &root,
                &codex_home,
                codex_win_engine::LaunchOptions::default(),
            )
            .unwrap();
            assert_eq!(command.get_program(), exe.as_os_str());
            assert_eq!(command.get_current_dir(), exe.parent());
            assert!(command
                .get_envs()
                .any(|(key, value)| key == "CODEX_HOME" && value == Some(codex_home.as_os_str())));
            assert_eq!(std::fs::read(&exe).unwrap(), b"payload fixture");
            assert_eq!(
                std::fs::read(exe.parent().unwrap().join("resources/app.asar")).unwrap(),
                b"resource fixture"
            );
            assert_eq!(root.read_dir().unwrap().count(), if nested { 2 } else { 3 });
        }
    }

    #[test]
    fn missing_or_foreign_external_portable_can_fall_back_to_registered_install() {
        let dir = external_portable_test_dir();
        let foreign = dir.path().join("ChatGPT Classic");
        write_external_portable_fixture(&foreign, true, "ChatGPT.exe", "OpenAI.ChatGPT");
        for invalid in [
            foreign,
            dir.path().join("missing"),
            std::path::PathBuf::from("relative"),
        ] {
            let selected = super::detected_external(invalid.to_str()).unwrap();
            assert!(selected.is_err());
            let target = super::select_runtime_target(
                selected.ok(),
                Some(installed("msix", "1")),
                None,
                true,
                false,
            )
            .unwrap();
            assert_eq!(target.installed.source, "msix");
            assert!(!target.portable_layout_writable);
        }
    }

    #[test]
    fn portable_process_matching_is_exact_even_inside_the_selected_directory() {
        let payload = Path::new(r"E:\Apps\Codex\app\ChatGPT.exe");
        assert!(super::matches_portable_image(
            Path::new(r"\\?\e:\apps\Codex\app\CHATGPT.exe"),
            payload,
        ));
        for other in [
            r"E:\Apps\Codex\app\unrelated.exe",
            r"E:\Apps\Codex\ChatGPT.exe",
            r"E:\Apps\Other\app\ChatGPT.exe",
        ] {
            assert!(!super::matches_portable_image(Path::new(other), payload));
        }
    }

    #[test]
    fn missing_external_portable_can_fall_back_to_a_separate_managed_portable() {
        let dir = external_portable_test_dir();
        let missing = dir.path().join("Disconnected Codex");
        let managed = dir.path().join("Managed Codex");
        write_external_portable_fixture(&managed, true, "ChatGPT.exe", "OpenAI.Codex");
        super::verify_distinct_managed_root(&managed, &missing).unwrap();
        assert!(super::verify_distinct_managed_root(&managed, &managed.join("missing")).is_err());
        let external = super::detected_external(missing.to_str()).unwrap();
        assert!(external.is_err());
        let portable = super::detected_external(managed.to_str()).unwrap().unwrap();
        let target =
            super::select_runtime_target(external.ok(), None, Some(portable), true, true).unwrap();
        assert_eq!(target.installed.path, managed.to_string_lossy());
        assert!(target.portable_layout_writable);
    }

    #[test]
    fn overlapping_external_selection_allows_managed_payload_without_layout_writes() {
        let dir = external_portable_test_dir();
        let managed = dir.path().join("Managed Codex");
        let exe = write_external_portable_fixture(&managed, false, "Codex.exe", "OpenAI.Codex");
        let external = managed.join("Unavailable external selection");
        assert!(super::detected_external(external.to_str())
            .unwrap()
            .is_err());
        let error = super::verify_managed_layout_access(&managed, external.to_str()).unwrap_err();
        assert!(error.contains("与自备便携版重叠"), "{error}");

        // Probe the actual portable payload independently of any MSIX the test
        // machine happens to have registered.
        let portable = codex_win_engine::detect_portable_install(&managed).unwrap();
        let target = super::select_runtime_target(None, None, Some(portable), true, false).unwrap();
        let (command, layout) = super::prepare_portable_launch(
            &target,
            &dir.path().join("test Codex home"),
            codex_win_engine::LaunchOptions::default(),
        )
        .unwrap();
        assert_eq!(command.get_program(), exe.as_os_str());
        assert!(layout.is_none());
        assert!(!managed.join("app").exists() && !managed.join("LaunchCodex.exe").exists());
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
