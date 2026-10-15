//! Portable Codex directory layouts and the in-place flat → nested migration.
//!
//! Engine v0.5.8 and earlier wrote the *flat* layout: the official payload
//! (`ChatGPT.exe`, `resources\…`) sits directly in the portable root next to
//! Chimera's `LaunchCodex.exe`. Engine v0.5.16 writes the *nested* layout: the
//! payload lives in `app\` and the root holds only launcher stubs
//! (`Codex.exe`, `ChatGPT.exe`, `LaunchCodex.exe`) plus install metadata, so
//! double-clicking or pinning the root `ChatGPT.exe` no longer starts the
//! official binary without package identity.
//!
//! The migration never copies or deletes payload files. It renames the whole
//! root into a sibling staging directory on the same volume
//! (`<root>.layout-<pid>-<nanos>\app`), writes the new launchers next to it,
//! verifies the result, and renames the staging directory back to the root.
//! Every step before the final rename is undone on failure, and a marker file
//! lets the next run finish or undo a migration interrupted by a crash.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

pub const APP_DIR: &str = "app";
pub const LAUNCH_TARGET_FILE: &str = "codex-portable-launcher.txt";
const LAUNCHER_FILE: &str = "LaunchCodex.exe";
const MARKER_FILE: &str = ".chimera-layout-migration";
/// Root files that describe the install rather than belong to the official
/// payload. The nested layout keeps them in the root.
const ROOT_METADATA: [&str; 3] = [
    "AppxManifest.xml",
    "CHIMERA-CODEX-VERSION.txt",
    "ownership.json",
];
/// Launcher files of the flat layout. After the migration they are stale
/// copies inside `app\`; the nested root gets freshly written ones.
const FLAT_LAUNCHER_FILES: [&str; 2] = [LAUNCHER_FILE, LAUNCH_TARGET_FILE];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PortableLayout {
    Missing,
    Flat,
    Nested,
    Unknown,
}

/// What a migration attempt did. `state` is a stable code for the renderer;
/// `message` is one plain-Chinese sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutMigrationOutcome {
    pub state: &'static str,
    pub message: String,
}

impl LayoutMigrationOutcome {
    fn new(state: &'static str, message: impl Into<String>) -> Self {
        Self {
            state,
            message: message.into(),
        }
    }

    /// Whether the directory structure changed (or was restored) on disk.
    pub fn changed_disk(&self) -> bool {
        matches!(self.state, "migrated" | "recovered")
    }
}

/// Side effects the migration depends on, so tests can fake them.
pub trait LayoutHost {
    fn codex_running(&self, root: &Path) -> Result<bool, String>;
    /// Write the nested-layout launchers into `staging`, whose `app\`
    /// already holds the payload.
    fn write_launchers(&self, staging: &Path) -> Result<(), String>;
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }
}

/// The real host: path-pinned process discovery and launcher writer from the
/// pinned engine, plus its retrying rename for transient Windows locks.
pub struct EngineLayoutHost;

impl LayoutHost for EngineLayoutHost {
    fn codex_running(&self, root: &Path) -> Result<bool, String> {
        codex_win_engine::codex_running_for_root(root).map_err(|error| error.to_string())
    }

    fn write_launchers(&self, staging: &Path) -> Result<(), String> {
        codex_win_engine::portable::ensure_portable_launcher(staging)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        codex_win_engine::rename_directory_with_retry("migrate portable layout", from, to)
    }
}

/// Whether the launch config of `root` targets `app\` and `app\` exists.
pub fn launch_target_is_nested(root: &Path) -> bool {
    if !root.join(APP_DIR).is_dir() {
        return false;
    }
    let Ok(config) = fs::read_to_string(root.join(LAUNCH_TARGET_FILE)) else {
        return false;
    };
    let target = config
        .lines()
        .next()
        .unwrap_or_default()
        .trim_start_matches('\u{feff}')
        .trim()
        .to_ascii_lowercase();
    target.starts_with("app\\") || target.starts_with("app/")
}

pub fn detect_layout(root: &Path) -> PortableLayout {
    if !root.is_dir() {
        return PortableLayout::Missing;
    }
    let app_dir = root.join(APP_DIR);
    match codex_win_engine::installed_app_exe(root) {
        Some(exe) if exe.parent() == Some(app_dir.as_path()) => PortableLayout::Nested,
        Some(exe) if exe.parent() == Some(root) && !app_dir.exists() => PortableLayout::Flat,
        _ if launch_target_is_nested(root) => PortableLayout::Nested,
        _ => PortableLayout::Unknown,
    }
}

/// A staging directory holds a complete nested install.
fn nested_complete(staging: &Path) -> bool {
    launch_target_is_nested(staging)
        && staging.join(LAUNCHER_FILE).is_file()
        && codex_win_engine::installed_app_exe(staging)
            .is_some_and(|exe| exe.parent() == Some(staging.join(APP_DIR).as_path()))
}

fn marker_text(root: &Path) -> String {
    root.to_string_lossy().to_string()
}

fn staging_prefix(root: &Path) -> Option<String> {
    Some(format!("{}.layout-", root.file_name()?.to_str()?))
}

/// Interrupted migrations for `root`: sibling staging directories that carry
/// a marker naming this root.
fn interrupted_stagings(root: &Path) -> Vec<PathBuf> {
    let (Some(parent), Some(prefix)) = (root.parent(), staging_prefix(root)) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut found = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix))
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
        })
        .map(|entry| entry.path())
        .filter(|staging| {
            fs::read_to_string(staging.join(MARKER_FILE))
                .is_ok_and(|text| text.trim() == marker_text(root))
        })
        .collect::<Vec<_>>();
    found.sort();
    found
}

/// The install root is gone and a staging directory still holds the payload:
/// Codex cannot start until the interrupted migration is finished or undone.
pub fn migration_interrupted(root: &Path) -> bool {
    !root.exists()
        && interrupted_stagings(root)
            .iter()
            .any(|staging| staging.join(APP_DIR).is_dir())
}

/// Launcher files the nested layout writes into the root. Only these (and the
/// engine's atomic-write temporaries) are ever removed when undoing.
const NESTED_LAUNCHER_FILES: [&str; 4] = [
    "Codex.exe",
    "ChatGPT.exe",
    LAUNCHER_FILE,
    LAUNCH_TARGET_FILE,
];
const ENGINE_TEMP_PREFIX: &str = ".codex-portable-write-";

fn under_windows_apps(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| name.eq_ignore_ascii_case("WindowsApps"))
    })
}

/// Put `staging\app` back at `root` exactly as it was before the migration.
fn undo(root: &Path, staging: &Path, host: &dyn LayoutHost) -> Result<(), String> {
    let app = staging.join(APP_DIR);
    for name in ROOT_METADATA {
        let moved = staging.join(name);
        if moved.is_file() && !app.join(name).exists() {
            fs::rename(&moved, app.join(name))
                .map_err(|error| format!("move {name} back: {error}"))?;
        }
    }
    for name in NESTED_LAUNCHER_FILES {
        let path = staging.join(name);
        if path.is_file() {
            fs::remove_file(&path).map_err(|error| format!("remove new {name}: {error}"))?;
        }
    }
    if let Ok(entries) = fs::read_dir(staging) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(ENGINE_TEMP_PREFIX))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    host.rename(&app, root)
        .map_err(|error| format!("restore install root: {error}"))?;
    discard_staging(staging);
    Ok(())
}

/// Remove an emptied staging directory. Non-recursive on purpose: anything
/// unexpected left inside is kept for manual inspection.
fn discard_staging(staging: &Path) {
    let _ = fs::remove_file(staging.join(MARKER_FILE));
    if let Err(error) = fs::remove_dir(staging) {
        log::warn!(
            "[portable-layout] 保留未清空的迁移暂存目录 {}：{error}",
            staging.display()
        );
    }
}

fn running_message() -> String {
    "Codex 正在运行，暂不升级免安装版的目录结构。关闭 Codex 后，下次通过 Chimera++ 启动时会自动完成。"
        .to_string()
}

/// Finish or undo a migration a crash interrupted while `root` was absent.
fn recover(root: &Path, host: &dyn LayoutHost) -> Option<LayoutMigrationOutcome> {
    let staging = interrupted_stagings(root).pop()?;
    let app = staging.join(APP_DIR);
    if !app.is_dir() {
        discard_staging(&staging);
        return None;
    }
    match host.codex_running(&app) {
        Ok(false) => {}
        Ok(true) => {
            return Some(LayoutMigrationOutcome::new(
                "skipped-running",
                running_message(),
            ))
        }
        Err(error) => {
            log::warn!("[portable-layout] 无法确认 Codex 是否在运行：{error}");
            return Some(LayoutMigrationOutcome::new(
                "skipped-probe",
                "无法确认 Codex 是否在运行，暂不恢复上次中断的目录结构升级。请关闭 Codex 后重试。",
            ));
        }
    }
    if nested_complete(&staging) {
        return Some(match host.rename(&staging, root) {
            Ok(()) => {
                let _ = fs::remove_file(root.join(MARKER_FILE));
                remove_stale_flat_launchers(root);
                LayoutMigrationOutcome::new("recovered", "已完成上次中断的免安装版目录结构升级。")
            }
            Err(error) => needs_attention(&staging, &error.to_string()),
        });
    }
    Some(match undo(root, &staging, host) {
        Ok(()) => LayoutMigrationOutcome::new(
            "recovered",
            "上次免安装版目录结构升级被中断，已恢复为原来的结构。",
        ),
        Err(error) => needs_attention(&staging, &error),
    })
}

fn needs_attention(staging: &Path, error: &str) -> LayoutMigrationOutcome {
    log::error!(
        "[portable-layout] 迁移无法自动恢复，文件保留在 {}：{error}",
        staging.display()
    );
    LayoutMigrationOutcome::new(
        "failed-needs-attention",
        format!(
            "免安装版目录结构升级失败，且没能自动恢复。所有文件都完整保留在 {}，请不要删除它；关闭 Codex 后重新打开 Chimera++ 会再次尝试恢复。",
            staging.display()
        ),
    )
}

/// The flat layout's launcher copies that ended up in `app\`.
fn remove_stale_flat_launchers(root: &Path) {
    for name in FLAT_LAUNCHER_FILES {
        let stale = root.join(APP_DIR).join(name);
        if stale.is_file() {
            if let Err(error) = fs::remove_file(&stale) {
                log::warn!(
                    "[portable-layout] 清理旧启动器 {} 失败：{error}",
                    stale.display()
                );
            }
        }
    }
}

/// Bring `root` to the nested layout. Idempotent: a nested, missing or
/// unrecognised root is left alone. The caller holds the runtime operation
/// lock. Checking for a running Codex is advisory — Windows refuses to rename
/// a directory whose executables are running, so a Codex started in between
/// makes the first rename fail and nothing changes.
pub fn migrate_flat_to_nested(root: &Path, host: &dyn LayoutHost) -> LayoutMigrationOutcome {
    if under_windows_apps(root) {
        return LayoutMigrationOutcome::new(
            "skipped-unsupported",
            "Windows 应用目录（WindowsApps）不是免安装版目录，不做目录结构升级。",
        );
    }
    if !root.exists() {
        return recover(root, host).unwrap_or_else(|| {
            LayoutMigrationOutcome::new("not-needed", "未检测到免安装版目录。")
        });
    }
    // Leftovers of a migration that finished or never started moving files.
    let _ = fs::remove_file(root.join(MARKER_FILE));
    for staging in interrupted_stagings(root) {
        if !staging.join(APP_DIR).exists() {
            discard_staging(&staging);
        }
    }
    if fs::symlink_metadata(root).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return LayoutMigrationOutcome::new(
            "skipped-unsupported",
            "免安装版目录是符号链接，不做目录结构升级。",
        );
    }
    match detect_layout(root) {
        PortableLayout::Flat => {}
        PortableLayout::Nested | PortableLayout::Missing => {
            return LayoutMigrationOutcome::new("not-needed", "免安装版已是新的目录结构。")
        }
        PortableLayout::Unknown => {
            return LayoutMigrationOutcome::new(
                "skipped-unsupported",
                "没有识别出免安装版的目录结构，未做改动。",
            )
        }
    }
    match host.codex_running(root) {
        Ok(false) => {}
        Ok(true) => return LayoutMigrationOutcome::new("skipped-running", running_message()),
        Err(error) => {
            log::warn!("[portable-layout] 无法确认 Codex 是否在运行：{error}");
            return LayoutMigrationOutcome::new(
                "skipped-probe",
                "无法确认 Codex 是否在运行，暂不升级免安装版的目录结构，下次启动时会再试。",
            );
        }
    }
    let (Some(parent), Some(prefix)) = (root.parent(), staging_prefix(root)) else {
        return LayoutMigrationOutcome::new(
            "skipped-unsupported",
            "免安装版目录位置无效，未做改动。",
        );
    };
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let staging = parent.join(format!("{prefix}{}-{nanos}", std::process::id()));
    let untouched = |error: String| {
        log::warn!("[portable-layout] 目录结构升级未开始：{error}");
        LayoutMigrationOutcome::new("failed", "免安装版目录结构升级没有完成，原目录未改动，Codex 仍可正常使用。目录可能被占用或没有写入权限，下次启动时会再试。")
    };
    if let Err(error) = fs::create_dir(&staging) {
        return untouched(format!("create {}: {error}", staging.display()));
    }
    if let Err(error) = fs::write(staging.join(MARKER_FILE), marker_text(root)) {
        let _ = fs::remove_dir(&staging);
        return untouched(format!("write marker: {error}"));
    }
    if let Err(error) = host.rename(root, &staging.join(APP_DIR)) {
        discard_staging(&staging);
        return untouched(format!("move payload: {error}"));
    }
    let forward = (|| -> Result<(), String> {
        for name in ROOT_METADATA {
            let source = staging.join(APP_DIR).join(name);
            if source.is_file() {
                fs::rename(&source, staging.join(name))
                    .map_err(|error| format!("move {name}: {error}"))?;
            }
        }
        host.write_launchers(&staging)?;
        if !nested_complete(&staging) {
            return Err("the new layout did not verify".to_string());
        }
        host.rename(&staging, root)
            .map_err(|error| format!("commit new layout: {error}"))
    })();
    match forward {
        Ok(()) => {
            let _ = fs::remove_file(root.join(MARKER_FILE));
            remove_stale_flat_launchers(root);
            LayoutMigrationOutcome::new(
                "migrated",
                "免安装版已升级为新的目录结构，官方文件移入 app 子目录，会话和配置不受影响。",
            )
        }
        Err(error) => {
            log::warn!("[portable-layout] 目录结构升级失败，正在恢复：{error}");
            match undo(root, &staging, host) {
                Ok(()) => LayoutMigrationOutcome::new(
                    "failed",
                    "免安装版目录结构升级没有完成，已恢复为原来的结构，Codex 仍可正常使用。",
                ),
                Err(undo_error) => needs_attention(&staging, &format!("{error}; {undo_error}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    type RenameFault = Box<dyn Fn(&Path, &Path) -> bool>;

    struct FakeHost {
        running: bool,
        fail_write: bool,
        fail_rename: RenameFault,
    }

    impl Default for FakeHost {
        fn default() -> Self {
            Self {
                running: false,
                fail_write: false,
                fail_rename: Box::new(|_, _| false),
            }
        }
    }

    impl LayoutHost for FakeHost {
        fn codex_running(&self, _root: &Path) -> Result<bool, String> {
            Ok(self.running)
        }

        fn write_launchers(&self, staging: &Path) -> Result<(), String> {
            // Like the engine: stubs first, then the config.
            for name in ["Codex.exe", "ChatGPT.exe", LAUNCHER_FILE] {
                fs::write(staging.join(name), b"new launcher stub").unwrap();
            }
            if self.fail_write {
                return Err("launcher is locked".to_string());
            }
            fs::write(
                staging.join(LAUNCH_TARGET_FILE),
                "app\\ChatGPT.exe\nrequire-cli=0",
            )
            .unwrap();
            Ok(())
        }

        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            if (self.fail_rename)(from, to) {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "locked"));
            }
            fs::rename(from, to)
        }
    }

    fn flat_install(parent: &Path) -> PathBuf {
        let root = parent.join("Codex");
        fs::create_dir_all(root.join("resources")).unwrap();
        fs::write(root.join("ChatGPT.exe"), b"official entry").unwrap();
        fs::write(root.join("resources/app.asar"), b"official resources").unwrap();
        fs::write(root.join("resources/codex.exe"), b"official cli").unwrap();
        fs::write(root.join("AppxManifest.xml"), b"<Package/>").unwrap();
        fs::write(root.join("CHIMERA-CODEX-VERSION.txt"), b"tag\ncommit").unwrap();
        fs::write(root.join(LAUNCHER_FILE), b"old launcher").unwrap();
        fs::write(root.join(LAUNCH_TARGET_FILE), "ChatGPT.exe").unwrap();
        root
    }

    fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
        let mut files = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let relative = path.strip_prefix(root).unwrap();
                    files.insert(
                        relative.to_string_lossy().replace('\\', "/"),
                        fs::read(&path).unwrap(),
                    );
                }
            }
        }
        files
    }

    fn siblings(parent: &Path) -> Vec<String> {
        let mut names = fs::read_dir(parent)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    #[test]
    fn flat_install_moves_into_app_without_losing_a_byte_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let root = flat_install(dir.path());
        let before = snapshot(&root);
        assert_eq!(detect_layout(&root), PortableLayout::Flat);

        let outcome = migrate_flat_to_nested(&root, &FakeHost::default());
        assert_eq!(outcome.state, "migrated", "{outcome:?}");
        assert!(outcome.changed_disk());
        assert_eq!(detect_layout(&root), PortableLayout::Nested);
        assert_eq!(siblings(dir.path()), ["Codex"]);

        let after = snapshot(&root);
        for (path, bytes) in &before {
            let moved = if ROOT_METADATA.contains(&path.as_str()) {
                path.clone()
            } else if FLAT_LAUNCHER_FILES.contains(&path.as_str()) {
                continue;
            } else {
                format!("app/{path}")
            };
            assert_eq!(after.get(&moved), Some(bytes), "{moved}");
        }
        assert!(!root.join("app").join(LAUNCHER_FILE).exists());
        assert!(!root.join("app").join(LAUNCH_TARGET_FILE).exists());
        assert!(!root.join(MARKER_FILE).exists());
        assert_eq!(after[LAUNCHER_FILE], b"new launcher stub");

        let again = migrate_flat_to_nested(&root, &FakeHost::default());
        assert_eq!(again.state, "not-needed");
        assert_eq!(snapshot(&root), after);
    }

    #[test]
    fn running_codex_is_never_moved() {
        let dir = tempfile::tempdir().unwrap();
        let root = flat_install(dir.path());
        let before = snapshot(&root);
        let host = FakeHost {
            running: true,
            ..FakeHost::default()
        };
        let outcome = migrate_flat_to_nested(&root, &host);
        assert_eq!(outcome.state, "skipped-running");
        assert!(outcome.message.contains("关闭 Codex"));
        assert_eq!(snapshot(&root), before);
        assert_eq!(siblings(dir.path()), ["Codex"]);
    }

    #[test]
    fn a_failed_launcher_write_restores_the_exact_flat_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = flat_install(dir.path());
        let before = snapshot(&root);
        let host = FakeHost {
            fail_write: true,
            ..FakeHost::default()
        };
        let outcome = migrate_flat_to_nested(&root, &host);
        assert_eq!(outcome.state, "failed", "{outcome:?}");
        assert!(outcome.message.contains("已恢复"));
        assert_eq!(snapshot(&root), before);
        assert_eq!(siblings(dir.path()), ["Codex"]);
    }

    #[test]
    fn a_failed_commit_rename_restores_the_exact_flat_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = flat_install(dir.path());
        let before = snapshot(&root);
        let host = FakeHost {
            fail_rename: Box::new(|from, _| {
                from.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".layout-"))
            }),
            ..FakeHost::default()
        };
        assert_eq!(migrate_flat_to_nested(&root, &host).state, "failed");
        assert_eq!(snapshot(&root), before);
        assert_eq!(siblings(dir.path()), ["Codex"]);
    }

    #[test]
    fn a_locked_root_fails_before_anything_moves() {
        let dir = tempfile::tempdir().unwrap();
        let root = flat_install(dir.path());
        let before = snapshot(&root);
        let host = FakeHost {
            fail_rename: Box::new(|_, to| to.ends_with(APP_DIR)),
            ..FakeHost::default()
        };
        let outcome = migrate_flat_to_nested(&root, &host);
        assert_eq!(outcome.state, "failed");
        assert!(outcome.message.contains("原目录未改动"));
        assert_eq!(snapshot(&root), before);
        assert_eq!(siblings(dir.path()), ["Codex"]);
    }

    #[test]
    fn when_undo_also_fails_every_file_stays_in_the_staging_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = flat_install(dir.path());
        let payload = fs::read(root.join("resources/app.asar")).unwrap();
        let host = FakeHost {
            fail_rename: Box::new({
                let root = root.clone();
                move |_, to| to == root
            }),
            ..FakeHost::default()
        };
        let outcome = migrate_flat_to_nested(&root, &host);
        assert_eq!(outcome.state, "failed-needs-attention", "{outcome:?}");
        assert!(!root.exists());
        assert!(migration_interrupted(&root));
        let staging = interrupted_stagings(&root).pop().unwrap();
        assert!(outcome.message.contains(&staging.display().to_string()));
        assert_eq!(
            fs::read(staging.join("app/resources/app.asar")).unwrap(),
            payload
        );

        // The next run (rename no longer locked) puts the flat install back.
        let recovered = migrate_flat_to_nested(&root, &FakeHost::default());
        assert_eq!(recovered.state, "recovered", "{recovered:?}");
        assert_eq!(detect_layout(&root), PortableLayout::Flat);
        assert_eq!(fs::read(root.join("resources/app.asar")).unwrap(), payload);
        assert_eq!(siblings(dir.path()), ["Codex"]);
    }

    /// A crash after the launchers were written but before the commit rename.
    #[test]
    fn a_crash_after_a_complete_staging_is_finished_on_the_next_run() {
        let dir = tempfile::tempdir().unwrap();
        let root = flat_install(dir.path());
        let staging = dir.path().join("Codex.layout-1-2");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join(MARKER_FILE), marker_text(&root)).unwrap();
        fs::rename(&root, staging.join(APP_DIR)).unwrap();
        for name in ROOT_METADATA {
            if staging.join(APP_DIR).join(name).is_file() {
                fs::rename(staging.join(APP_DIR).join(name), staging.join(name)).unwrap();
            }
        }
        FakeHost::default().write_launchers(&staging).unwrap();
        assert!(migration_interrupted(&root));

        let outcome = migrate_flat_to_nested(&root, &FakeHost::default());
        assert_eq!(outcome.state, "recovered", "{outcome:?}");
        assert_eq!(detect_layout(&root), PortableLayout::Nested);
        assert!(!root.join(MARKER_FILE).exists());
        assert!(!root.join("app").join(LAUNCHER_FILE).exists());
        assert_eq!(siblings(dir.path()), ["Codex"]);
    }

    /// A crash right after the payload moved, before any launcher existed.
    #[test]
    fn a_crash_after_moving_the_payload_is_undone_on_the_next_run() {
        let dir = tempfile::tempdir().unwrap();
        let root = flat_install(dir.path());
        let before = snapshot(&root);
        let staging = dir.path().join("Codex.layout-1-2");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join(MARKER_FILE), marker_text(&root)).unwrap();
        fs::rename(&root, staging.join(APP_DIR)).unwrap();
        fs::rename(
            staging.join(APP_DIR).join("AppxManifest.xml"),
            staging.join("AppxManifest.xml"),
        )
        .unwrap();

        let outcome = migrate_flat_to_nested(&root, &FakeHost::default());
        assert_eq!(outcome.state, "recovered", "{outcome:?}");
        assert_eq!(snapshot(&root), before);
        assert_eq!(siblings(dir.path()), ["Codex"]);
    }

    #[test]
    fn a_running_codex_blocks_recovery_too() {
        let dir = tempfile::tempdir().unwrap();
        let root = flat_install(dir.path());
        let staging = dir.path().join("Codex.layout-1-2");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join(MARKER_FILE), marker_text(&root)).unwrap();
        fs::rename(&root, staging.join(APP_DIR)).unwrap();
        let host = FakeHost {
            running: true,
            ..FakeHost::default()
        };
        assert_eq!(
            migrate_flat_to_nested(&root, &host).state,
            "skipped-running"
        );
        assert!(staging.join("app/resources/app.asar").is_file());
        assert!(!root.exists());
    }

    #[test]
    fn unrelated_directories_and_foreign_stagings_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Codex");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("notes.txt"), b"user data").unwrap();
        // A directory with our prefix but no marker for this root.
        let foreign = dir.path().join("Codex.layout-9-9");
        fs::create_dir_all(foreign.join(APP_DIR)).unwrap();
        fs::write(foreign.join(APP_DIR).join("keep.txt"), b"keep").unwrap();

        let outcome = migrate_flat_to_nested(&root, &FakeHost::default());
        assert_eq!(outcome.state, "skipped-unsupported");
        assert_eq!(fs::read(root.join("notes.txt")).unwrap(), b"user data");
        assert!(foreign.join(APP_DIR).join("keep.txt").is_file());

        let missing = dir.path().join("Missing");
        assert_eq!(
            migrate_flat_to_nested(&missing, &FakeHost::default()).state,
            "not-needed"
        );
        assert!(!missing.exists());
    }

    #[test]
    fn windows_apps_paths_are_never_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("WindowsApps");
        fs::create_dir(&apps).unwrap();
        let root = flat_install(&apps);
        let before = snapshot(&root);
        assert_eq!(
            migrate_flat_to_nested(&root, &FakeHost::default()).state,
            "skipped-unsupported"
        );
        assert_eq!(snapshot(&root), before);
    }

    #[test]
    fn nested_detection_reads_the_launch_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let config = root.join(LAUNCH_TARGET_FILE);
        fs::write(&config, "ChatGPT.exe").unwrap();
        assert!(!launch_target_is_nested(root));
        fs::create_dir(root.join(APP_DIR)).unwrap();
        assert!(!launch_target_is_nested(root));
        for text in [
            "app\\ChatGPT.exe\r\nrequire-cli=1\r\n",
            "app/ChatGPT.exe",
            "\u{feff}APP\\Codex.exe\nrequire-cli=0",
        ] {
            fs::write(&config, text).unwrap();
            assert!(launch_target_is_nested(root), "{text:?}");
        }
        fs::write(&config, "application.exe").unwrap();
        assert!(!launch_target_is_nested(root));
    }

    /// The real engine host on a disposable flat copy: native launcher
    /// binaries, path-pinned process probe and the retrying rename.
    #[cfg(windows)]
    #[test]
    fn the_engine_host_migrates_a_flat_copy_to_native_launchers() {
        let dir = tempfile::tempdir().unwrap();
        let root = flat_install(dir.path());
        let before = snapshot(&root);

        let outcome = migrate_flat_to_nested(&root, &EngineLayoutHost);
        assert_eq!(outcome.state, "migrated", "{outcome:?}");
        assert_eq!(detect_layout(&root), PortableLayout::Nested);
        assert_eq!(
            codex_win_engine::installed_app_exe(&root),
            Some(root.join(APP_DIR).join("ChatGPT.exe"))
        );
        for name in ["Codex.exe", "ChatGPT.exe", LAUNCHER_FILE] {
            let launcher = fs::read(root.join(name)).unwrap();
            assert_eq!(launcher.get(..2), Some(&b"MZ"[..]), "{name}");
        }
        let after = snapshot(&root);
        for (path, bytes) in &before {
            if FLAT_LAUNCHER_FILES.contains(&path.as_str()) {
                continue;
            }
            let moved = if ROOT_METADATA.contains(&path.as_str()) {
                path.clone()
            } else {
                format!("app/{path}")
            };
            assert_eq!(after.get(&moved), Some(bytes), "{moved}");
        }
        assert_eq!(siblings(dir.path()), ["Codex"]);
        assert_eq!(
            migrate_flat_to_nested(&root, &EngineLayoutHost).state,
            "not-needed"
        );
    }
}
