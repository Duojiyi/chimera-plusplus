//! Switching the default Claude Desktop (the one the Start menu opens)
//! between saved logins.
//!
//! Claude Desktop's sign-in is not one token. It is the session cookies
//! (`Network/Cookies`), the Chromium key that decrypts them (`Local State`),
//! `config.json` (which also holds the app's OAuth token cache), and the
//! origin storage. Writing a Claude Code login into the token cache would
//! change none of that, and the cache's tokens belong to Desktop's own OAuth
//! client, so a Claude Code token could not be refreshed there anyway. What
//! does switch the account is replacing the whole sign-in with one that was
//! captured while that account was signed in.
//!
//! So each saved login can have a **snapshot** of Desktop's sign-in files,
//! taken after signing in to Desktop as that account once. Switching closes
//! Desktop, keeps the outgoing sign-in (in its own snapshot, or in a small
//! rotating stash when it matches no saved login), puts the incoming files
//! in place, and rolls back if anything fails. Settings, MCP servers, window
//! state and caches are never touched.
//!
//! Snapshots only work on the machine and Windows user that made them: the
//! cookie key is protected by that user's DPAPI. They are never exported.
//! Several accounts open at once use Chimera's separate Desktop profiles
//! (`desktop.rs`) instead; this module is for the default Desktop and for the
//! Microsoft Store build, which cannot take a profile folder.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::code::{self, CodeVault};
use super::{strip_bom, validate_account_id};
use crate::error::AppError;

const SNAPSHOTS_DIR: &str = "desktop-auth";
const STASH_DIR: &str = ".stash";
const ROLLBACK_DIR: &str = ".rollback";
const META_FILE: &str = ".snapshot.json";
const KEEP_STASH: usize = 3;

/// Files in the data folder that make up the sign-in. `Local State` is
/// paired with the cookies and `config.json` because its
/// `os_crypt.encrypted_key` is what decrypts them.
const AUTH_FILES: &[&str] = &[
    "Local State",
    "config.json",
    "Preferences",
    "ant-did",
    "ant-device-registry.json",
    "Network/Cookies",
    "Network/Cookies-journal",
    "Network/Cookies-wal",
    "Network/Cookies-shm",
    "Network/Network Persistent State",
    "Network/TransportSecurity",
    "Network/Trust Tokens",
    "Network/Trust Tokens-journal",
    "Cookies",
    "Cookies-journal",
    "Cookies-wal",
    "Cookies-shm",
];

/// Folders holding the signed-in origin's storage.
const AUTH_DIRS: &[&str] = &[
    "Local Storage",
    "Session Storage",
    "IndexedDB",
    "WebStorage",
];

/// Files that, while Desktop runs, are held open.
const LOCK_PROBES: &[&str] = &[
    "lockfile",
    "Network/Cookies",
    "Cookies",
    "Local Storage/leveldb/LOCK",
];

pub(crate) fn supported() -> bool {
    cfg!(windows)
}

// ===== where Desktop keeps its data =====

/// An MSIX-virtualized `Roaming\Claude` folder, if one exists.
#[cfg(windows)]
fn msix_data_dir(local: &Path) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = fs::read_dir(local.join("Packages"))
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(str::to_ascii_lowercase)
                .is_some_and(|name| {
                    name.starts_with("claude_") || name.starts_with("anthropic.claude_")
                })
        })
        .map(|path| path.join("LocalCache").join("Roaming").join("Claude"))
        .filter(|path| path.is_dir())
        .collect();
    found.sort();
    found.into_iter().next()
}

fn freshness(dir: &Path) -> Option<std::time::SystemTime> {
    ["Network/Cookies", "Cookies", "Local State", "config.json"]
        .iter()
        .filter_map(|rel| fs::metadata(dir.join(rel)).ok()?.modified().ok())
        .max()
}

/// The default Desktop's data folder: `%APPDATA%\Claude`, unless a Store
/// build keeps a newer one under `%LOCALAPPDATA%\Packages`.
#[cfg(windows)]
pub(crate) fn main_data_dir() -> Option<PathBuf> {
    let roaming = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|dir| dir.join("Claude"));
    let virtualized = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .and_then(|local| msix_data_dir(&local));
    match (roaming, virtualized) {
        (Some(roaming), Some(virtualized)) => {
            if !roaming.is_dir() || freshness(&virtualized) > freshness(&roaming) {
                Some(virtualized)
            } else {
                Some(roaming)
            }
        }
        (Some(only), None) | (None, Some(only)) => Some(only),
        (None, None) => None,
    }
}

#[cfg(not(windows))]
pub(crate) fn main_data_dir() -> Option<PathBuf> {
    None
}

// ===== what is signed in =====

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MainLogin {
    pub signed_in: bool,
    pub account_uuid: Option<String>,
}

/// Who a data folder is signed in as, from `config.json`: its token cache
/// (signed in or not) and `lastKnownAccountUuid` (which account).
pub(crate) fn login_of(dir: &Path) -> MainLogin {
    let Ok(text) = fs::read_to_string(dir.join("config.json")) else {
        return MainLogin::default();
    };
    let account_uuid = serde_json::from_str::<Value>(strip_bom(&text))
        .ok()
        .and_then(|value| {
            value
                .get("lastKnownAccountUuid")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|uuid| !uuid.is_empty() && uuid.len() <= 64)
                .map(str::to_string)
        });
    MainLogin {
        signed_in: super::desktop::desktop_config_signed_in(&text),
        account_uuid,
    }
}

/// Whether Desktop has the data folder open. The files it holds open cannot
/// be opened without sharing.
#[cfg(windows)]
pub(crate) fn data_locked(dir: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    LOCK_PROBES.iter().any(|rel| {
        let path = dir.join(rel);
        path.is_file()
            && fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&path)
                .is_err()
    })
}

#[cfg(not(windows))]
pub(crate) fn data_locked(_dir: &Path) -> bool {
    false
}

// ===== snapshots =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotMeta {
    account_id: String,
    #[serde(default)]
    account_uuid: Option<String>,
    captured_at: String,
}

fn snapshots_root(vault: &CodeVault) -> PathBuf {
    vault.root().join(SNAPSHOTS_DIR)
}

fn snapshot_dir(vault: &CodeVault, id: &str) -> Result<PathBuf, AppError> {
    validate_account_id(id)?;
    Ok(snapshots_root(vault).join(id))
}

fn read_meta(dir: &Path) -> Option<SnapshotMeta> {
    serde_json::from_str(&fs::read_to_string(dir.join(META_FILE)).ok()?).ok()
}

fn write_meta(dir: &Path, meta: &SnapshotMeta) -> Result<(), AppError> {
    let data =
        serde_json::to_vec_pretty(meta).map_err(|e| AppError::JsonSerialize { source: e })?;
    fs::write(dir.join(META_FILE), data).map_err(|e| AppError::io(dir, e))
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn copy_dir(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let (from, to) = (entry.path(), dst.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Makes `dst`'s sign-in files exactly `src`'s: what `src` has is copied
/// over, what it lacks is removed, nothing else in `dst` is touched.
fn copy_auth_set(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for rel in AUTH_FILES {
        let (from, to) = (src.join(rel), dst.join(rel));
        if from.is_file() {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&from, &to)?;
        } else {
            remove_if_exists(&to)?;
        }
    }
    for rel in AUTH_DIRS {
        let (from, to) = (src.join(rel), dst.join(rel));
        remove_if_exists(&to)?;
        if from.is_dir() {
            copy_dir(&from, &to)?;
        }
    }
    Ok(())
}

/// A copy of the sign-in files into a fresh folder next to the final one, put
/// in place only when complete.
fn save_snapshot(main: &Path, target: &Path, meta: &SnapshotMeta) -> Result<(), AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Message("快照路径无效".to_string()))?;
    fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    let staging = parent.join(format!(".staging-{}", super::new_account_id()));
    let result = (|| {
        copy_auth_set(main, &staging).map_err(|e| AppError::io(&staging, e))?;
        write_meta(&staging, meta)?;
        remove_if_exists(target).map_err(|e| AppError::io(target, e))?;
        fs::rename(&staging, target).map_err(|e| AppError::io(target, e))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn running_error() -> AppError {
    AppError::Message(
        "Claude Desktop 还开着，它占用着登录文件。请先完全退出它（包括托盘图标）。".to_string(),
    )
}

fn not_signed_in_error() -> AppError {
    AppError::Message("默认的 Claude Desktop 还没有登录，没有可保存的内容。".to_string())
}

/// Saves the default Desktop's current sign-in as this saved login's
/// snapshot. The login must be a subscription one and match the account
/// Desktop is signed in as. Desktop must be closed.
pub(crate) fn capture_in(vault: &CodeVault, main: &Path, id: &str) -> Result<(), AppError> {
    let target = snapshot_dir(vault, id)?;
    let expected = code::account_uuid_of(vault, id)?;
    let login = login_of(main);
    if !login.signed_in {
        return Err(not_signed_in_error());
    }
    match (&login.account_uuid, &expected) {
        (Some(have), Some(want)) if have != want => {
            return Err(AppError::Message(
                "默认 Claude Desktop 里登录的是另一个账号，和这个账号对不上。请先在 Desktop 里登录这个账号。".to_string(),
            ))
        }
        (None, _) => {
            return Err(AppError::Message(
                "读不到默认 Claude Desktop 登录的是哪个账号。请先打开一次 Desktop 再试。".to_string(),
            ))
        }
        _ => {}
    }
    if data_locked(main) {
        return Err(running_error());
    }
    let meta = SnapshotMeta {
        account_id: id.to_string(),
        account_uuid: login.account_uuid,
        captured_at: Utc::now().to_rfc3339(),
    };
    save_snapshot(main, &target, &meta)
}

/// Keeps only the newest `KEEP_STASH` outgoing sign-ins that matched no saved login.
fn prune_stash(vault: &CodeVault) {
    let dir = snapshots_root(vault).join(STASH_DIR);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();
    while names.len() > KEEP_STASH {
        let oldest = names.remove(0);
        let _ = fs::remove_dir_all(dir.join(oldest));
    }
}

/// What a switch did besides the switch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    /// The sign-in that was replaced belonged to no saved login and was kept
    /// in the stash instead.
    pub stashed_outgoing: bool,
    /// The sign-in that was replaced was saved as this login's snapshot.
    pub saved_outgoing_for: Option<String>,
}

/// Replaces the default Desktop's sign-in with this login's snapshot.
/// Desktop must be closed. The outgoing sign-in is kept first, and the
/// previous files come back if putting the new ones in place fails.
pub(crate) fn switch_in(
    vault: &CodeVault,
    main: &Path,
    id: &str,
) -> Result<SwitchResult, AppError> {
    switch_with(vault, main, id, copy_auth_set)
}

fn switch_with(
    vault: &CodeVault,
    main: &Path,
    id: &str,
    apply: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> Result<SwitchResult, AppError> {
    let source = snapshot_dir(vault, id)?;
    let meta = read_meta(&source).ok_or_else(|| {
        AppError::Message(
            "这个账号还没有保存过 Desktop 登录。请先在 Desktop 里登录它并保存。".to_string(),
        )
    })?;
    if code::is_disabled(vault, id)? {
        return Err(AppError::Message("这个账号已停用，请先启用它".to_string()));
    }
    if data_locked(main) {
        return Err(running_error());
    }
    fs::create_dir_all(main).map_err(|e| AppError::io(main, e))?;

    // 1. Keep the sign-in that is about to go.
    let outgoing = login_of(main);
    let mut result = SwitchResult {
        stashed_outgoing: false,
        saved_outgoing_for: None,
    };
    if outgoing.signed_in && outgoing.account_uuid != meta.account_uuid {
        let owner = outgoing
            .account_uuid
            .as_deref()
            .and_then(|uuid| code::find_by_account_uuid(vault, uuid));
        match owner {
            Some(owner_id) => {
                let target = snapshot_dir(vault, &owner_id)?;
                let kept = SnapshotMeta {
                    account_id: owner_id.clone(),
                    account_uuid: outgoing.account_uuid.clone(),
                    captured_at: Utc::now().to_rfc3339(),
                };
                save_snapshot(main, &target, &kept)?;
                result.saved_outgoing_for = Some(owner_id);
            }
            None => {
                let stash = snapshots_root(vault)
                    .join(STASH_DIR)
                    .join(Utc::now().format("%Y%m%dT%H%M%S%.3f").to_string());
                let kept = SnapshotMeta {
                    account_id: String::new(),
                    account_uuid: outgoing.account_uuid.clone(),
                    captured_at: Utc::now().to_rfc3339(),
                };
                save_snapshot(main, &stash, &kept)?;
                prune_stash(vault);
                result.stashed_outgoing = true;
            }
        }
    }

    // 2. Put the incoming files in place, with a way back.
    let rollback = snapshots_root(vault).join(ROLLBACK_DIR);
    remove_if_exists(&rollback).map_err(|e| AppError::io(&rollback, e))?;
    copy_auth_set(main, &rollback).map_err(|e| AppError::io(&rollback, e))?;
    match apply(&source, main) {
        Ok(()) => {
            let _ = fs::remove_dir_all(&rollback);
            Ok(result)
        }
        Err(error) => {
            let restored = copy_auth_set(&rollback, main);
            let _ = fs::remove_dir_all(&rollback);
            Err(AppError::Message(match restored {
                Ok(()) => format!("切换失败，已恢复原来的登录：{error}"),
                Err(restore_error) => format!(
                    "切换失败（{error}），而且没能恢复原来的登录（{restore_error}）。原来的登录保存在 {} 里。",
                    snapshots_root(vault).display()
                ),
            }))
        }
    }
}

// ===== listing =====

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDto {
    pub account_id: String,
    pub captured_at: String,
    /// Desktop is signed in as this account now.
    pub is_current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapStatus {
    pub supported: bool,
    /// Desktop has its data open.
    pub running: bool,
    pub signed_in: bool,
    pub account_uuid: Option<String>,
    /// The saved login Desktop is signed in as, when it is one.
    pub current_account_id: Option<String>,
    pub snapshots: Vec<SnapshotDto>,
}

pub(crate) fn status_in(vault: &CodeVault, main: Option<&Path>) -> SwapStatus {
    let login = main.map(login_of).unwrap_or_default();
    let current_account_id = login
        .account_uuid
        .as_deref()
        .and_then(|uuid| code::find_by_account_uuid(vault, uuid));
    let mut snapshots = Vec::new();
    for (id, _) in code::saved_names(vault) {
        let Ok(dir) = snapshot_dir(vault, &id) else {
            continue;
        };
        if let Some(meta) = read_meta(&dir) {
            snapshots.push(SnapshotDto {
                is_current: login.signed_in
                    && meta.account_uuid.is_some()
                    && meta.account_uuid == login.account_uuid,
                account_id: id,
                captured_at: meta.captured_at,
            });
        }
    }
    SwapStatus {
        supported: supported() && main.is_some(),
        running: main.is_some_and(data_locked),
        signed_in: login.signed_in,
        account_uuid: login.account_uuid,
        current_account_id,
        snapshots,
    }
}

/// Removes a login's snapshot (when the login is deleted or on request).
pub(crate) fn remove_snapshot(vault: &CodeVault, id: &str) -> Result<(), AppError> {
    let dir = snapshot_dir(vault, id)?;
    remove_if_exists(&dir).map_err(|e| AppError::io(&dir, e))
}

// ===== the Desktop process =====

/// A Desktop process that serves the default data folder: the app's own
/// executable and no `--user-data-dir` (Chimera's separate profiles pass one).
pub(crate) fn is_main_desktop_process(executable: &str, command_line: &str) -> bool {
    super::is_claude_desktop_image(executable)
        && !command_line
            .to_ascii_lowercase()
            .contains("--user-data-dir")
}

#[cfg(windows)]
fn main_desktop_pids() -> Vec<u32> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // No double quotes: they would need escaping through the command line.
    let script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; \
        Get-CimInstance Win32_Process | \
        Where-Object { $_.Name -eq 'claude.exe' } | \
        ForEach-Object { [string]$_.ProcessId + '|' + [string]$_.ExecutablePath + '|' + [string]$_.CommandLine }";
    let mut command = std::process::Command::new("powershell");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW);
    let Ok(output) = crate::process_utils::output_with_timeout(
        command,
        std::time::Duration::from_secs(10),
        crate::security_limits::MAX_PROCESS_OUTPUT_BYTES,
    ) else {
        return Vec::new();
    };
    crate::process_utils::decode_console_output(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '|');
            let pid = parts.next()?.trim().parse::<u32>().ok()?;
            let executable = parts.next()?;
            let command_line = parts.next().unwrap_or_default();
            is_main_desktop_process(executable, command_line).then_some(pid)
        })
        .collect()
}

/// Closes the default Desktop: asks nicely, then ends what is left, and
/// waits until it has let go of its data. `true` when it was running.
#[cfg(windows)]
pub(crate) fn close_main_desktop(main: &Path) -> Result<bool, AppError> {
    use std::os::windows::process::CommandExt;
    use std::time::{Duration, Instant};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let pids = main_desktop_pids();
    if pids.is_empty() && !data_locked(main) {
        return Ok(false);
    }
    for pid in &pids {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let wait = |limit: Duration| {
        let start = Instant::now();
        while start.elapsed() < limit {
            if !data_locked(main) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        !data_locked(main)
    };
    if !wait(Duration::from_secs(3)) {
        // It lives on in the tray after its windows close.
        for pid in main_desktop_pids() {
            crate::process_utils::terminate_process_tree(pid);
        }
        if !wait(Duration::from_secs(8)) {
            return Err(running_error());
        }
    }
    Ok(true)
}

#[cfg(not(windows))]
pub(crate) fn close_main_desktop(_main: &Path) -> Result<bool, AppError> {
    Err(AppError::Message(
        "切换默认 Claude Desktop 目前只支持 Windows".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_accounts::code::tests::{fixture, login, Fixture};
    use serde_json::json;

    fn saved(f: &Fixture, email: &str, uuid: &str) -> String {
        login(&f.paths, email, uuid, &format!("token-{uuid}"));
        code::save_current_in(&f.vault, &f.paths, None).unwrap().id
    }

    /// A Desktop data folder signed in as `uuid`, with `marker` in every
    /// sign-in file so a swap can be told apart.
    fn desktop(root: &Path, uuid: &str, marker: &str) -> PathBuf {
        let dir = root.join("Claude");
        for rel in AUTH_FILES {
            let path = dir.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, format!("{marker}:{rel}")).unwrap();
        }
        fs::write(
            dir.join("config.json"),
            json!({
                "lastKnownAccountUuid": uuid,
                "oauth:tokenCacheV2": format!("v10{marker}"),
                "locale": "zh-CN",
                "marker": marker,
            })
            .to_string(),
        )
        .unwrap();
        for rel in AUTH_DIRS {
            fs::create_dir_all(dir.join(rel).join("leveldb")).unwrap();
            fs::write(dir.join(rel).join("leveldb").join("000003.log"), marker).unwrap();
        }
        // Not sign-in: must never move.
        fs::write(
            dir.join("claude_desktop_config.json"),
            "{\"mcpServers\":{}}",
        )
        .unwrap();
        fs::create_dir_all(dir.join("Cache")).unwrap();
        fs::write(dir.join("Cache").join("data_0"), "cache").unwrap();
        fs::write(dir.join("window-state.json"), "{\"x\":1}").unwrap();
        dir
    }

    fn marker_of(dir: &Path) -> String {
        let value: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        value["marker"].as_str().unwrap().to_string()
    }

    #[test]
    fn who_is_signed_in_comes_from_the_config_file() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(login_of(&temp.path().join("none")), MainLogin::default());
        let dir = desktop(temp.path(), "uuid-a", "A");
        assert_eq!(
            login_of(&dir),
            MainLogin {
                signed_in: true,
                account_uuid: Some("uuid-a".to_string())
            }
        );
        fs::write(
            dir.join("config.json"),
            "{\"lastKnownAccountUuid\":\"uuid-a\"}",
        )
        .unwrap();
        assert!(!login_of(&dir).signed_in, "no token cache: not signed in");
    }

    #[test]
    fn a_snapshot_holds_the_sign_in_files_and_nothing_else() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");

        capture_in(&f.vault, &main, &a).unwrap();
        let snap = snapshot_dir(&f.vault, &a).unwrap();
        assert_eq!(marker_of(&snap), "A");
        assert_eq!(
            fs::read_to_string(snap.join("Network/Cookies")).unwrap(),
            "A:Network/Cookies"
        );
        assert!(snap.join("Local Storage/leveldb/000003.log").is_file());
        for other in ["claude_desktop_config.json", "Cache", "window-state.json"] {
            assert!(!snap.join(other).exists(), "{other} is not sign-in");
        }
        let status = status_in(&f.vault, Some(&main));
        assert!(status.signed_in);
        assert_eq!(status.current_account_id.as_deref(), Some(a.as_str()));
        assert_eq!(status.snapshots.len(), 1);
        assert!(status.snapshots[0].is_current);
    }

    #[test]
    fn a_sign_in_is_saved_only_for_the_account_it_belongs_to() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let b = saved(&f, "b@example.com", "uuid-b");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");

        let error = capture_in(&f.vault, &main, &b).err().unwrap().to_string();
        assert!(error.contains("另一个账号"), "{error}");
        assert!(!snapshot_dir(&f.vault, &b).unwrap().exists());

        fs::write(main.join("config.json"), "{}").unwrap();
        assert!(capture_in(&f.vault, &main, &a)
            .err()
            .unwrap()
            .to_string()
            .contains("还没有登录"));
        fs::write(
            main.join("config.json"),
            json!({"oauth:tokenCacheV2": "v10"}).to_string(),
        )
        .unwrap();
        assert!(capture_in(&f.vault, &main, &a)
            .err()
            .unwrap()
            .to_string()
            .contains("读不到"));
        assert!(capture_in(&f.vault, &main, "../x").is_err());
    }

    #[test]
    fn switching_swaps_the_sign_in_keeps_the_outgoing_one_and_leaves_everything_else() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let b = saved(&f, "b@example.com", "uuid-b");
        let temp_a = tempfile::tempdir().unwrap();
        let temp_b = tempfile::tempdir().unwrap();
        capture_in(&f.vault, &desktop(temp_a.path(), "uuid-a", "A"), &a).unwrap();
        capture_in(&f.vault, &desktop(temp_b.path(), "uuid-b", "B"), &b).unwrap();

        // Desktop is signed in as A, and A has newer files than its snapshot.
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A2");
        fs::write(main.join("window-state.json"), "{\"x\":99}").unwrap();

        let result = switch_in(&f.vault, &main, &b).unwrap();
        assert_eq!(result.saved_outgoing_for.as_deref(), Some(a.as_str()));
        assert!(!result.stashed_outgoing);
        assert_eq!(marker_of(&main), "B");
        assert_eq!(
            fs::read_to_string(main.join("Cookies")).unwrap(),
            "B:Cookies"
        );
        assert!(fs::read_to_string(main.join("Local Storage/leveldb/000003.log")).unwrap() == "B");
        // Settings, MCP servers, window state and caches stayed.
        assert_eq!(
            fs::read_to_string(main.join("window-state.json")).unwrap(),
            "{\"x\":99}"
        );
        assert!(main.join("claude_desktop_config.json").is_file());
        assert!(main.join("Cache/data_0").is_file());
        // A's newest files were kept in its snapshot.
        assert_eq!(marker_of(&snapshot_dir(&f.vault, &a).unwrap()), "A2");
        assert!(!snapshots_root(&f.vault).join(ROLLBACK_DIR).exists());

        // And back.
        switch_in(&f.vault, &main, &a).unwrap();
        assert_eq!(marker_of(&main), "A2");
        let status = status_in(&f.vault, Some(&main));
        assert_eq!(status.current_account_id.as_deref(), Some(a.as_str()));
    }

    #[test]
    fn a_sign_in_that_matches_no_saved_login_goes_to_a_small_stash() {
        let f = fixture();
        let b = saved(&f, "b@example.com", "uuid-b");
        let temp_b = tempfile::tempdir().unwrap();
        capture_in(&f.vault, &desktop(temp_b.path(), "uuid-b", "B"), &b).unwrap();

        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-stranger", "S");
        for round in 0..5 {
            fs::write(
                main.join("config.json"),
                json!({"lastKnownAccountUuid": "uuid-stranger", "oauth:tokenCacheV2": "v10", "marker": format!("S{round}")}).to_string(),
            )
            .unwrap();
            let result = switch_in(&f.vault, &main, &b).unwrap();
            assert!(result.stashed_outgoing && result.saved_outgoing_for.is_none());
            assert_eq!(marker_of(&main), "B");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let kept = fs::read_dir(snapshots_root(&f.vault).join(STASH_DIR))
            .unwrap()
            .count();
        assert_eq!(kept, KEEP_STASH);
    }

    #[test]
    fn a_failed_switch_puts_the_previous_sign_in_back() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let b = saved(&f, "b@example.com", "uuid-b");
        let temp_a = tempfile::tempdir().unwrap();
        let temp_b = tempfile::tempdir().unwrap();
        capture_in(&f.vault, &desktop(temp_a.path(), "uuid-a", "A"), &a).unwrap();
        capture_in(&f.vault, &desktop(temp_b.path(), "uuid-b", "B"), &b).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");

        let error = switch_with(&f.vault, &main, &b, |src, dst| {
            // Half the files go over, then the disk "fails".
            fs::copy(src.join("Cookies"), dst.join("Cookies"))?;
            fs::remove_file(dst.join("config.json"))?;
            Err(io::Error::other("disk full"))
        })
        .err()
        .unwrap()
        .to_string();
        assert!(
            error.contains("已恢复原来的登录") && error.contains("disk full"),
            "{error}"
        );
        assert_eq!(marker_of(&main), "A");
        assert_eq!(
            fs::read_to_string(main.join("Cookies")).unwrap(),
            "A:Cookies"
        );
        assert!(!snapshots_root(&f.vault).join(ROLLBACK_DIR).exists());
    }

    #[test]
    fn a_switch_needs_a_snapshot_an_enabled_account_and_a_closed_desktop() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let _b = saved(&f, "b@example.com", "uuid-b");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-c", "C");
        assert!(switch_in(&f.vault, &main, &a)
            .err()
            .unwrap()
            .to_string()
            .contains("还没有保存过"));

        capture_in(
            &f.vault,
            &desktop(tempfile::tempdir().unwrap().path(), "uuid-a", "A"),
            &a,
        )
        .unwrap();
        code::manage::set_disabled_in(&f.vault, &f.paths, &a, true).unwrap();
        assert!(switch_in(&f.vault, &main, &a)
            .err()
            .unwrap()
            .to_string()
            .contains("已停用"));
        assert_eq!(marker_of(&main), "C", "nothing changed");
        assert!(
            !snapshots_root(&f.vault).join(STASH_DIR).exists(),
            "nothing was stashed either"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_running_desktop_blocks_capture_and_switch() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let b = saved(&f, "b@example.com", "uuid-b");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        capture_in(
            &f.vault,
            &desktop(tempfile::tempdir().unwrap().path(), "uuid-b", "B"),
            &b,
        )
        .unwrap();

        // What the running app does: keeps its cookie database open.
        let held = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(3)
            .open(main.join("Network/Cookies"))
            .unwrap();
        assert!(data_locked(&main));
        assert!(status_in(&f.vault, Some(&main)).running);
        assert!(capture_in(&f.vault, &main, &a)
            .err()
            .unwrap()
            .to_string()
            .contains("还开着"));
        assert!(switch_in(&f.vault, &main, &b)
            .err()
            .unwrap()
            .to_string()
            .contains("还开着"));
        assert_eq!(marker_of(&main), "A");
        drop(held);
        assert!(!data_locked(&main));
    }

    #[test]
    fn only_the_apps_own_default_instance_is_closed() {
        let main =
            r"C:\Program Files\WindowsApps\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe";
        assert!(is_main_desktop_process(main, &format!("\"{main}\"")));
        assert!(is_main_desktop_process(
            main,
            &format!("\"{main}\" --type=renderer --lang=zh-CN")
        ));
        // One of Chimera's separate profiles.
        assert!(!is_main_desktop_process(
            main,
            &format!("\"{main}\" --user-data-dir=D:\\Chimera\\p1")
        ));
        assert!(!is_main_desktop_process(
            main,
            &format!("\"{main}\" --type=gpu-process --user-data-dir=D:\\p")
        ));
        // The Claude Code CLI.
        assert!(!is_main_desktop_process(
            r"C:\Users\me\.local\bin\claude.exe",
            "claude"
        ));
        assert!(!is_main_desktop_process(
            r"C:\Users\me\AppData\Roaming\Claude\claude-code\2.1.309\x\claude.exe",
            "claude"
        ));
    }

    #[test]
    fn a_deleted_logins_snapshot_can_be_removed() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        capture_in(&f.vault, &desktop(temp.path(), "uuid-a", "A"), &a).unwrap();
        assert!(snapshot_dir(&f.vault, &a).unwrap().exists());
        remove_snapshot(&f.vault, &a).unwrap();
        assert!(!snapshot_dir(&f.vault, &a).unwrap().exists());
        remove_snapshot(&f.vault, &a).unwrap();
        assert!(status_in(&f.vault, None).snapshots.is_empty());
        assert!(!status_in(&f.vault, None).supported);
    }
}
