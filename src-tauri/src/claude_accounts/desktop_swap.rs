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
//! state and caches are never touched; in `config.json` only the keys that
//! belong to the account (its token cache and what was cached for it) are
//! replaced, the app's own settings stay as they are.
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
const KEEP_STASH: usize = 5;
/// Written while a swap is applying; a swap that was cut short leaves it, and
/// the folder it left half-changed is put back before anything else is done.
const PENDING_FILE: &str = ".swap-pending.json";
const CONFIG_FILE: &str = "config.json";
/// Marks a folder that a crashed save left behind.
const LEFTOVER_PREFIXES: &[&str] = &[".staging-", ".old-"];

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
#[cfg(windows)]
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

/// The default Desktop's data folder: `%APPDATA%\Claude`, or the one a Store
/// build keeps under its package, whichever is in use.
pub(crate) fn main_data_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        super::desktop_auth::default_user_data_dir()
    } else {
        None
    }
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

/// Two programs write the account number, with no promise about case.
fn same_uuid(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn same_uuid_opt(a: Option<&str>, b: Option<&str>) -> bool {
    matches!((a, b), (Some(a), Some(b)) if same_uuid(a, b))
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

/// Keys of `config.json` that belong to the signed-in account: its OAuth
/// token cache, the account number, the per-organization extension lists, and
/// what the app cached for it (the sidebar it drew last). The rest of the file
/// is the app's own settings.
const ACCOUNT_KEY_PREFIXES: &[&str] = &["oauth:", "dxt:"];
const ACCOUNT_KEYS: &[&str] = &[
    "lastKnownAccountUuid",
    "lastGoodMainViewLoad",
    "bootSidebarPlaceholder",
];

fn is_account_key(key: &str) -> bool {
    ACCOUNT_KEYS.contains(&key)
        || ACCOUNT_KEY_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
}

/// `current` with its account keys replaced by `snapshot`'s. `None` when
/// either is not a JSON object.
fn merged_config(current: &str, snapshot: &str) -> Option<String> {
    let Value::Object(mut merged) = serde_json::from_str::<Value>(strip_bom(current)).ok()? else {
        return None;
    };
    let Value::Object(incoming) = serde_json::from_str::<Value>(strip_bom(snapshot)).ok()? else {
        return None;
    };
    merged.retain(|key, _| !is_account_key(key));
    for (key, value) in incoming {
        if is_account_key(&key) {
            merged.insert(key, value);
        }
    }
    serde_json::to_string_pretty(&Value::Object(merged)).ok()
}

/// Makes `dst`'s sign-in files exactly `src`'s: what `src` has is copied
/// over, what it lacks is removed, nothing else in `dst` is touched. With
/// `keep_settings`, `config.json` keeps `dst`'s own settings and takes only
/// the account keys from `src`.
fn copy_files(src: &Path, dst: &Path, keep_settings: bool) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for rel in AUTH_FILES {
        let (from, to) = (src.join(rel), dst.join(rel));
        if from.is_file() {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            if keep_settings && *rel == CONFIG_FILE {
                let merged = fs::read_to_string(&to)
                    .ok()
                    .zip(fs::read_to_string(&from).ok())
                    .and_then(|(current, incoming)| merged_config(&current, &incoming));
                if let Some(text) = merged {
                    crate::config::atomic_write(&to, text.as_bytes())
                        .map_err(|e| io::Error::other(e.to_string()))?;
                    continue;
                }
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

/// A faithful copy, for snapshots and the way back.
fn copy_auth_set(src: &Path, dst: &Path) -> io::Result<()> {
    copy_files(src, dst, false)
}

/// Puts a snapshot's sign-in into the data folder, leaving the app's settings.
fn apply_auth_set(src: &Path, dst: &Path) -> io::Result<()> {
    copy_files(src, dst, true)
}

/// What a usable sign-in needs: the key, the token cache and the cookies.
fn has_sign_in_files(dir: &Path) -> bool {
    dir.join("Local State").is_file()
        && dir.join(CONFIG_FILE).is_file()
        && (dir.join("Network/Cookies").is_file() || dir.join("Cookies").is_file())
}

/// A copy of the sign-in files into a fresh folder next to the final one, put
/// in place only when complete; the folder it replaces is kept until then.
fn save_snapshot(main: &Path, target: &Path, meta: &SnapshotMeta) -> Result<(), AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Message("快照路径无效".to_string()))?;
    fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    let token = super::new_account_id();
    let staging = parent.join(format!(".staging-{token}"));
    let old = parent.join(format!(".old-{token}"));
    let result = (|| {
        copy_auth_set(main, &staging).map_err(|e| AppError::io(&staging, e))?;
        write_meta(&staging, meta)?;
        let had_old = fs::symlink_metadata(target).is_ok();
        if had_old {
            fs::rename(target, &old).map_err(|e| AppError::io(target, e))?;
        }
        match fs::rename(&staging, target) {
            Ok(()) => {
                let _ = remove_if_exists(&old);
                Ok(())
            }
            Err(error) => {
                if had_old {
                    let _ = fs::rename(&old, target);
                }
                Err(AppError::io(target, error))
            }
        }
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

/// Removes what a crashed save left next to the snapshots, and the snapshots
/// of logins that no longer exist (a delete that could not remove them).
fn sweep_leftovers(vault: &CodeVault) {
    let root = snapshots_root(vault);
    let known = code::all_account_ids(vault);
    for entry in fs::read_dir(&root).into_iter().flatten().flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if validate_account_id(&name).is_ok() && !known.iter().any(|id| id == &*name) {
            let _ = remove_if_exists(&entry.path());
        }
    }
    for dir in [root.join(STASH_DIR), root] {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if LEFTOVER_PREFIXES
                .iter()
                .any(|prefix| name.starts_with(prefix))
            {
                let _ = remove_if_exists(&entry.path());
            }
        }
    }
}

fn pending_path(vault: &CodeVault) -> PathBuf {
    snapshots_root(vault).join(PENDING_FILE)
}

fn rollback_path(vault: &CodeVault) -> PathBuf {
    snapshots_root(vault).join(ROLLBACK_DIR)
}

/// A swap that was cut short left the data folder half one login and half
/// another; the copy taken before it started is put back. Until that works,
/// nothing may treat the folder as a login.
fn recover_interrupted(vault: &CodeVault, main: &Path) -> Result<(), AppError> {
    let pending = pending_path(vault);
    if fs::symlink_metadata(&pending).is_err() {
        return Ok(());
    }
    let rollback = rollback_path(vault);
    if rollback.is_dir() {
        copy_auth_set(&rollback, main).map_err(|error| {
            AppError::Message(format!(
                "上一次切换 Desktop 登录没有完成，也没能恢复原来的登录（{error}）。原来的登录备份在 {} 里",
                rollback.display()
            ))
        })?;
        let _ = fs::remove_dir_all(&rollback);
    }
    remove_if_exists(&pending).map_err(|e| AppError::io(&pending, e))
}

fn running_error() -> AppError {
    AppError::Message(
        "Claude Desktop 还开着，它占用着登录文件。请先完全退出它（包括托盘图标）。".to_string(),
    )
}

fn not_signed_in_error() -> AppError {
    AppError::Message("默认的 Claude Desktop 还没有登录，没有可保存的内容。".to_string())
}

/// The checks for saving the current sign-in as this login's, none of which
/// needs Desktop closed.
fn capture_target(
    vault: &CodeVault,
    main: &Path,
    id: &str,
) -> Result<(PathBuf, SnapshotMeta), AppError> {
    let target = snapshot_dir(vault, id)?;
    let expected = code::account_uuid_of(vault, id)?;
    let login = login_of(main);
    if !login.signed_in {
        return Err(not_signed_in_error());
    }
    let Some(have) = login.account_uuid else {
        return Err(AppError::Message(
            "读不到默认 Claude Desktop 登录的是哪个账号。请先打开一次 Desktop 再试。".to_string(),
        ));
    };
    match expected.as_deref() {
        Some(want) if same_uuid(&have, want) => {}
        Some(_) => {
            return Err(AppError::Message(
                "默认 Claude Desktop 里登录的是另一个账号，和这个账号对不上。请先在 Desktop 里登录这个账号。".to_string(),
            ))
        }
        None => {
            return Err(AppError::Message(
                "这个登录里没有账号编号，无法确认它和 Desktop 里登录的是同一个账号。请在 Claude Code 里重新登录后再保存。".to_string(),
            ))
        }
    }
    if !has_sign_in_files(main) {
        return Err(AppError::Message(
            "默认 Claude Desktop 的登录文件不完整。请先打开 Desktop，确认已登录后再试。"
                .to_string(),
        ));
    }
    let meta = SnapshotMeta {
        account_id: id.to_string(),
        account_uuid: Some(have),
        captured_at: Utc::now().to_rfc3339(),
    };
    Ok((target, meta))
}

/// Whether the current sign-in can be saved for this login, before Desktop is
/// closed for it.
pub(crate) fn check_capture(vault: &CodeVault, main: &Path, id: &str) -> Result<(), AppError> {
    capture_target(vault, main, id).map(|_| ())
}

/// Saves the default Desktop's current sign-in as this saved login's
/// snapshot. The login must be a subscription one and match the account
/// Desktop is signed in as. Desktop must be closed.
pub(crate) fn capture_in(vault: &CodeVault, main: &Path, id: &str) -> Result<(), AppError> {
    snapshot_dir(vault, id)?;
    if data_locked(main) {
        return Err(running_error());
    }
    sweep_leftovers(vault);
    recover_interrupted(vault, main)?;
    let (target, meta) = capture_target(vault, main, id)?;
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

/// The snapshot a switch would put in place, if it can be.
fn switch_meta(vault: &CodeVault, id: &str) -> Result<SnapshotMeta, AppError> {
    let source = snapshot_dir(vault, id)?;
    let meta = read_meta(&source).ok_or_else(|| {
        AppError::Message(
            "这个账号还没有保存过 Desktop 登录。请先在 Desktop 里登录它并保存。".to_string(),
        )
    })?;
    if !has_sign_in_files(&source) {
        return Err(AppError::Message(
            "保存的 Desktop 登录不完整。请先在 Desktop 里重新登录这个账号并再保存一次。"
                .to_string(),
        ));
    }
    if code::is_disabled(vault, id)? {
        return Err(AppError::Message("这个账号已停用，请先启用它".to_string()));
    }
    Ok(meta)
}

fn already_signed_in_error() -> AppError {
    AppError::Message("默认 Claude Desktop 现在就登录着这个账号，不用切换。".to_string())
}

/// A switch to the login Desktop is signed in as would only put an older
/// copy over the newer one.
fn reject_current(main: &Path, meta: &SnapshotMeta) -> Result<(), AppError> {
    let login = login_of(main);
    if login.signed_in && same_uuid_opt(meta.account_uuid.as_deref(), login.account_uuid.as_deref())
    {
        return Err(already_signed_in_error());
    }
    Ok(())
}

/// Whether a switch to this login can be done, before Desktop is closed for it.
pub(crate) fn check_switch(vault: &CodeVault, main: &Path, id: &str) -> Result<(), AppError> {
    let meta = switch_meta(vault, id)?;
    reject_current(main, &meta)
}

/// Replaces the default Desktop's sign-in with this login's snapshot.
/// Desktop must be closed. The outgoing sign-in is kept first, and the
/// previous files come back if putting the new ones in place fails.
pub(crate) fn switch_in(
    vault: &CodeVault,
    main: &Path,
    id: &str,
) -> Result<SwitchResult, AppError> {
    switch_with(vault, main, id, apply_auth_set)
}

fn switch_with(
    vault: &CodeVault,
    main: &Path,
    id: &str,
    apply: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> Result<SwitchResult, AppError> {
    let meta = switch_meta(vault, id)?;
    let source = snapshot_dir(vault, id)?;
    reject_current(main, &meta)?;
    change_sign_in(vault, main, id, meta.account_uuid.as_deref(), |main| {
        apply(&source, main)
    })
}

/// What stays when Desktop is taken back to its sign-in page: the key that
/// protects the cookies, the app's preferences, the device's identity and the
/// settings in `config.json`.
const KEEP_WHEN_CLEARED: &[&str] = &[
    "Local State",
    "Preferences",
    "ant-did",
    "ant-device-registry.json",
    CONFIG_FILE,
];

/// Removes the sign-in from the data folder without signing anyone out: the
/// cookies and storage go, so Desktop starts at its sign-in page, while the
/// session they belonged to stays valid on the server (and in the snapshot).
fn clear_sign_in(main: &Path) -> io::Result<()> {
    for rel in AUTH_FILES {
        if !KEEP_WHEN_CLEARED.contains(rel) {
            remove_if_exists(&main.join(rel))?;
        }
    }
    for rel in AUTH_DIRS {
        remove_if_exists(&main.join(rel))?;
    }
    let config = main.join(CONFIG_FILE);
    if let Ok(text) = fs::read_to_string(&config) {
        if let Some(cleared) = merged_config(&text, "{}") {
            crate::config::atomic_write(&config, cleared.as_bytes())
                .map_err(|e| io::Error::other(e.to_string()))?;
        }
    }
    Ok(())
}

/// Whether Desktop can be taken back to its sign-in page so this login can
/// be signed in, before Desktop is closed for it.
pub(crate) fn check_prepare(vault: &CodeVault, main: &Path, id: &str) -> Result<(), AppError> {
    snapshot_dir(vault, id)?;
    let Some(want) = code::account_uuid_of(vault, id)? else {
        return Err(AppError::Message(
            "这个登录里没有账号编号，无法确认之后在 Desktop 里登录的是不是同一个账号。".to_string(),
        ));
    };
    if code::is_disabled(vault, id)? {
        return Err(AppError::Message("这个账号已停用，请先启用它".to_string()));
    }
    let login = login_of(main);
    if login.signed_in && same_uuid_opt(Some(&want), login.account_uuid.as_deref()) {
        return Err(AppError::Message(
            "默认 Claude Desktop 现在就登录着这个账号，直接保存它的 Desktop 登录就行。".to_string(),
        ));
    }
    Ok(())
}

/// Takes the default Desktop back to its sign-in page, keeping the sign-in
/// that was in use (as above), so another account can be signed in there. The
/// session that was in use is not signed out.
pub(crate) fn prepare_login_in(
    vault: &CodeVault,
    main: &Path,
    id: &str,
) -> Result<SwitchResult, AppError> {
    check_prepare(vault, main, id)?;
    change_sign_in(vault, main, id, None, clear_sign_in)
}

/// Whether a swap was cut short and its folder not put back yet. Desktop must
/// not be opened on such a folder: half one login and half another reads to
/// it as a different person, and it resets what it keeps for the old one.
pub(crate) fn needs_recovery(vault: &CodeVault) -> bool {
    fs::symlink_metadata(pending_path(vault)).is_ok()
}

/// Ends a swap. The marker goes first: a backup left without one is never
/// restored from, while a marker left beside a half-removed backup would be.
fn finish_swap(vault: &CodeVault) {
    let _ = fs::remove_file(pending_path(vault));
    let _ = fs::remove_dir_all(rollback_path(vault));
}

/// Changes the sign-in in the data folder with `apply`: keeps the sign-in
/// that is going (unless it is the one coming), and undoes `apply` if it
/// fails. `incoming` is the account number of the sign-in that comes.
fn change_sign_in(
    vault: &CodeVault,
    main: &Path,
    id: &str,
    incoming: Option<&str>,
    apply: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<SwitchResult, AppError> {
    if data_locked(main) {
        return Err(running_error());
    }
    sweep_leftovers(vault);
    recover_interrupted(vault, main)?;
    fs::create_dir_all(main).map_err(|e| AppError::io(main, e))?;

    // 1. Keep the sign-in that is about to go. One that is not whole would
    // only damage a good snapshot, so it is not kept.
    let outgoing = login_of(main);
    let mut result = SwitchResult {
        stashed_outgoing: false,
        saved_outgoing_for: None,
    };
    if outgoing.signed_in
        && has_sign_in_files(main)
        && !same_uuid_opt(outgoing.account_uuid.as_deref(), incoming)
    {
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

    // 2. Change it, with a way back. The marker says a swap is under way
    // until it has finished or been undone.
    let rollback = rollback_path(vault);
    remove_if_exists(&rollback).map_err(|e| AppError::io(&rollback, e))?;
    copy_auth_set(main, &rollback).map_err(|e| AppError::io(&rollback, e))?;
    let pending = pending_path(vault);
    let marker = serde_json::json!({
        "accountId": id,
        "startedAt": Utc::now().to_rfc3339(),
    });
    fs::write(&pending, marker.to_string()).map_err(|e| AppError::io(&pending, e))?;
    match apply(main) {
        Ok(()) => {
            finish_swap(vault);
            Ok(result)
        }
        Err(error) => match copy_auth_set(&rollback, main) {
            Ok(()) => {
                finish_swap(vault);
                Err(AppError::Message(format!(
                    "切换失败，已恢复原来的登录：{error}"
                )))
            }
            // The backup and the marker stay, so the next try picks it up.
            Err(restore_error) => Err(AppError::Message(format!(
                "切换失败（{error}），而且没能恢复原来的登录（{restore_error}）。原来的登录备份保留在 {} 里，下次操作会再试着恢复。",
                rollback.display()
            ))),
        },
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
            // A snapshot that is not whole is as good as none.
            if !has_sign_in_files(&dir) {
                continue;
            }
            snapshots.push(SnapshotDto {
                is_current: login.signed_in
                    && same_uuid_opt(meta.account_uuid.as_deref(), login.account_uuid.as_deref()),
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

/// Everything kept of a deleted login's Desktop sign-in: its snapshot, and
/// the stashed sign-ins of the same account.
pub(crate) fn forget_account(
    vault: &CodeVault,
    id: &str,
    account_uuid: Option<&str>,
) -> Result<(), AppError> {
    let removed = remove_snapshot(vault, id);
    if let Some(uuid) = account_uuid {
        let stash = snapshots_root(vault).join(STASH_DIR);
        for entry in fs::read_dir(&stash).into_iter().flatten().flatten() {
            let path = entry.path();
            let kept = read_meta(&path)
                .and_then(|meta| meta.account_uuid)
                .is_some_and(|have| same_uuid(&have, uuid));
            if kept {
                let _ = remove_if_exists(&path);
            }
        }
    }
    sweep_leftovers(vault);
    removed
}

// ===== the Desktop process =====

/// A Desktop process that serves the default data folder: the app's own
/// executable and no `--user-data-dir` (Chimera's separate profiles pass one).
#[cfg(any(windows, test))]
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
    if !wait(Duration::from_secs(6)) {
        // It lives on in the tray after its windows close. What it runs (Code
        // sessions, MCP servers) goes with it.
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

    /// Which login's sign-in a data folder holds, from its token cache.
    fn marker_of(dir: &Path) -> String {
        let value: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        value["oauth:tokenCacheV2"]
            .as_str()
            .unwrap()
            .trim_start_matches("v10")
            .to_string()
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
        for round in 0..(KEEP_STASH + 2) {
            fs::write(
                main.join("config.json"),
                json!({"lastKnownAccountUuid": "uuid-stranger", "oauth:tokenCacheV2": format!("v10S{round}")}).to_string(),
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

    #[test]
    fn a_switch_replaces_the_account_keys_and_keeps_the_apps_settings() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let b = saved(&f, "b@example.com", "uuid-b");
        capture_in(
            &f.vault,
            &desktop(tempfile::tempdir().unwrap().path(), "uuid-b", "B"),
            &b,
        )
        .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        // What the user changed in Desktop after B's snapshot was taken.
        fs::write(
            main.join("config.json"),
            json!({
                "lastKnownAccountUuid": "uuid-a",
                "oauth:tokenCacheV2": "v10A",
                "dxt:allowlist:org-a": ["x"],
                "locale": "en-US",
                "userThemeMode": "dark",
                "updaterLastSeenVersion": "9.9.9",
            })
            .to_string(),
        )
        .unwrap();

        let result = switch_in(&f.vault, &main, &b).unwrap();
        assert_eq!(result.saved_outgoing_for.as_deref(), Some(a.as_str()));
        let config: Value =
            serde_json::from_str(&fs::read_to_string(main.join("config.json")).unwrap()).unwrap();
        assert_eq!(config["lastKnownAccountUuid"], "uuid-b");
        assert_eq!(config["oauth:tokenCacheV2"], "v10B");
        assert!(
            config.get("dxt:allowlist:org-a").is_none(),
            "A's own list went"
        );
        assert_eq!(config["locale"], "en-US");
        assert_eq!(config["userThemeMode"], "dark");
        assert_eq!(config["updaterLastSeenVersion"], "9.9.9");
        // A's snapshot kept the whole file as it was.
        let kept: Value = serde_json::from_str(
            &fs::read_to_string(snapshot_dir(&f.vault, &a).unwrap().join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(kept["locale"], "en-US");
    }

    #[test]
    fn a_swap_that_was_cut_short_is_undone_before_anything_is_saved() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        // The copy taken before a swap began, and a folder left half changed.
        copy_auth_set(&main, &rollback_path(&f.vault)).unwrap();
        fs::write(pending_path(&f.vault), "{}").unwrap();
        fs::write(
            main.join("config.json"),
            json!({"lastKnownAccountUuid": "uuid-b", "oauth:tokenCacheV2": "v10B"}).to_string(),
        )
        .unwrap();
        fs::write(main.join("Cookies"), "B:Cookies").unwrap();

        capture_in(&f.vault, &main, &a).unwrap();
        assert_eq!(marker_of(&main), "A");
        assert_eq!(
            fs::read_to_string(main.join("Cookies")).unwrap(),
            "A:Cookies"
        );
        assert_eq!(marker_of(&snapshot_dir(&f.vault, &a).unwrap()), "A");
        assert!(!pending_path(&f.vault).exists() && !rollback_path(&f.vault).exists());
    }

    #[test]
    fn a_swap_that_cannot_be_undone_blocks_saving_the_folder_as_a_login() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        // The backup has a cookie file where the folder has a directory, so
        // putting it back fails.
        let rollback = rollback_path(&f.vault);
        fs::create_dir_all(rollback.join("Network")).unwrap();
        fs::write(rollback.join("Network/Cookies"), "R").unwrap();
        fs::write(pending_path(&f.vault), "{}").unwrap();
        fs::remove_file(main.join("Network/Cookies")).unwrap();
        fs::create_dir_all(main.join("Network/Cookies")).unwrap();

        let error = capture_in(&f.vault, &main, &a).err().unwrap().to_string();
        assert!(error.contains("没有完成"), "{error}");
        assert!(!snapshot_dir(&f.vault, &a).unwrap().exists());
        assert!(pending_path(&f.vault).exists(), "kept for the next try");
        assert!(rollback.exists());
    }

    #[test]
    fn a_snapshot_that_is_not_whole_is_not_offered_or_applied() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let b = saved(&f, "b@example.com", "uuid-b");
        capture_in(
            &f.vault,
            &desktop(tempfile::tempdir().unwrap().path(), "uuid-b", "B"),
            &b,
        )
        .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        fs::remove_file(snapshot_dir(&f.vault, &b).unwrap().join("Local State")).unwrap();

        assert!(status_in(&f.vault, Some(&main)).snapshots.is_empty());
        let error = switch_in(&f.vault, &main, &b).err().unwrap().to_string();
        assert!(error.contains("不完整"), "{error}");
        assert_eq!(marker_of(&main), "A", "nothing changed");

        // A folder without its key is not saved either.
        fs::remove_file(main.join("Local State")).unwrap();
        let error = capture_in(&f.vault, &main, &a).err().unwrap().to_string();
        assert!(error.contains("不完整"), "{error}");
    }

    #[test]
    fn the_account_number_matches_whatever_its_case() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "UUID-A");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        capture_in(&f.vault, &main, &a).unwrap();
        let status = status_in(&f.vault, Some(&main));
        assert_eq!(status.current_account_id.as_deref(), Some(a.as_str()));
        assert!(status.snapshots[0].is_current);
    }

    #[test]
    fn saving_again_replaces_the_snapshot_and_leaves_nothing_behind() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        capture_in(&f.vault, &main, &a).unwrap();
        fs::write(
            main.join("config.json"),
            json!({"lastKnownAccountUuid": "uuid-a", "oauth:tokenCacheV2": "v10A2"}).to_string(),
        )
        .unwrap();
        capture_in(&f.vault, &main, &a).unwrap();
        assert_eq!(marker_of(&snapshot_dir(&f.vault, &a).unwrap()), "A2");
        let names: Vec<String> = fs::read_dir(snapshots_root(&f.vault))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec![a.clone()], "{names:?}");
    }

    #[test]
    fn forgetting_a_login_removes_its_snapshot_stash_and_crash_leftovers() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        capture_in(&f.vault, &desktop(temp.path(), "uuid-a", "A"), &a).unwrap();
        let root = snapshots_root(&f.vault);
        let mine = root.join(STASH_DIR).join("20260101T000000.000");
        let other = root.join(STASH_DIR).join("20260102T000000.000");
        for (dir, uuid) in [(&mine, "UUID-A"), (&other, "uuid-z")] {
            fs::create_dir_all(dir).unwrap();
            write_meta(
                dir,
                &SnapshotMeta {
                    account_id: String::new(),
                    account_uuid: Some(uuid.to_string()),
                    captured_at: String::new(),
                },
            )
            .unwrap();
        }
        fs::create_dir_all(root.join(".staging-dead")).unwrap();

        forget_account(&f.vault, &a, Some("uuid-a")).unwrap();
        assert!(!snapshot_dir(&f.vault, &a).unwrap().exists());
        assert!(!mine.exists() && other.exists());
        assert!(!root.join(".staging-dead").exists());
        forget_account(&f.vault, &a, None).unwrap();
    }

    #[test]
    fn the_checks_come_before_desktop_is_closed() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let b = saved(&f, "b@example.com", "uuid-b");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        assert!(
            check_capture(&f.vault, &main, &b).is_err(),
            "another account"
        );
        assert!(check_capture(&f.vault, &main, &a).is_ok());
        assert!(
            check_switch(&f.vault, &main, &b).is_err(),
            "no snapshot yet"
        );
        capture_in(&f.vault, &main, &a).unwrap();
        assert!(
            check_switch(&f.vault, &main, &a).is_err(),
            "Desktop is signed in as it already"
        );
        capture_in(
            &f.vault,
            &desktop(tempfile::tempdir().unwrap().path(), "uuid-b", "B"),
            &b,
        )
        .unwrap();
        assert!(check_switch(&f.vault, &main, &b).is_ok());
    }

    #[test]
    fn going_back_to_the_sign_in_page_keeps_the_outgoing_login_and_the_settings() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let b = saved(&f, "b@example.com", "uuid-b");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        fs::write(
            main.join("config.json"),
            json!({
                "lastKnownAccountUuid": "uuid-a",
                "oauth:tokenCacheV2": "v10A",
                "locale": "en-US",
                "userThemeMode": "dark",
            })
            .to_string(),
        )
        .unwrap();

        check_prepare(&f.vault, &main, &b).unwrap();
        let result = prepare_login_in(&f.vault, &main, &b).unwrap();
        assert_eq!(result.saved_outgoing_for.as_deref(), Some(a.as_str()));
        // Signed out of nothing: A's session is in its snapshot, whole.
        assert_eq!(marker_of(&snapshot_dir(&f.vault, &a).unwrap()), "A");
        // Desktop starts at the sign-in page, with its key and settings.
        let login = login_of(&main);
        assert!(!login.signed_in && login.account_uuid.is_none());
        assert!(!main.join("Network/Cookies").exists() && !main.join("Cookies").exists());
        assert!(!main.join("Local Storage").exists());
        assert!(main.join("Local State").is_file());
        assert!(main.join("Preferences").is_file());
        let config: Value =
            serde_json::from_str(&fs::read_to_string(main.join("config.json")).unwrap()).unwrap();
        assert_eq!(config["locale"], "en-US");
        assert_eq!(config["userThemeMode"], "dark");
        assert!(config.get("oauth:tokenCacheV2").is_none());
        assert!(main.join("claude_desktop_config.json").is_file());
        assert!(main.join("Cache/data_0").is_file());
        assert!(!pending_path(&f.vault).exists() && !rollback_path(&f.vault).exists());

        // Signing in as B there, then saving, completes the round trip.
        fs::write(
            main.join("config.json"),
            json!({"lastKnownAccountUuid": "uuid-b", "oauth:tokenCacheV2": "v10B", "locale": "en-US"})
                .to_string(),
        )
        .unwrap();
        for rel in ["Network/Cookies", "Cookies"] {
            fs::create_dir_all(main.join(rel).parent().unwrap()).unwrap();
            fs::write(main.join(rel), format!("B:{rel}")).unwrap();
        }
        capture_in(&f.vault, &main, &b).unwrap();
        switch_in(&f.vault, &main, &a).unwrap();
        assert_eq!(marker_of(&main), "A");
    }

    #[test]
    fn the_page_is_not_offered_for_the_login_desktop_is_already_signed_in_as() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        let error = check_prepare(&f.vault, &main, &a)
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("直接保存"), "{error}");
        assert!(check_prepare(&f.vault, &main, "../x").is_err());
        // B is what Claude Code is signed in with now; A can be held out of use.
        let _b = saved(&f, "b@example.com", "uuid-b");
        code::manage::set_disabled_in(&f.vault, &f.paths, &a, true).unwrap();
        assert!(check_prepare(&f.vault, &main, &a)
            .err()
            .unwrap()
            .to_string()
            .contains("已停用"));
    }

    #[test]
    fn a_switch_to_the_login_desktop_is_signed_in_as_is_refused() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        capture_in(&f.vault, &main, &a).unwrap();
        fs::write(
            main.join("config.json"),
            json!({"lastKnownAccountUuid": "uuid-a", "oauth:tokenCacheV2": "v10A-newer"})
                .to_string(),
        )
        .unwrap();
        let error = switch_in(&f.vault, &main, &a).err().unwrap().to_string();
        assert!(error.contains("不用切换"), "{error}");
        assert_eq!(marker_of(&main), "A-newer", "the newer copy stays");
    }

    #[test]
    fn a_swap_is_finished_by_removing_the_marker_before_the_backup() {
        let f = fixture();
        fs::create_dir_all(rollback_path(&f.vault)).unwrap();
        fs::write(pending_path(&f.vault), "{}").unwrap();
        assert!(needs_recovery(&f.vault));
        finish_swap(&f.vault);
        assert!(!needs_recovery(&f.vault) && !rollback_path(&f.vault).exists());
    }

    #[test]
    fn snapshots_of_logins_that_no_longer_exist_are_swept() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        capture_in(&f.vault, &desktop(temp.path(), "uuid-a", "A"), &a).unwrap();
        let orphan = snapshots_root(&f.vault).join("gone1234");
        fs::create_dir_all(orphan.join("Network")).unwrap();
        fs::write(orphan.join("Local State"), "x").unwrap();
        sweep_leftovers(&f.vault);
        assert!(!orphan.exists());
        assert!(
            snapshot_dir(&f.vault, &a).unwrap().is_dir(),
            "a live login's stays"
        );
        assert!(snapshots_root(&f.vault)
            .join(STASH_DIR)
            .parent()
            .unwrap()
            .is_dir());
    }
}
