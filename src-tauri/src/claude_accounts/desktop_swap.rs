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
/// A durable mapping from a replacement's working folders to its final snapshot.
const SNAPSHOT_SAVE_PREFIX: &str = ".snapshot-save-";

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

/// Deployment mode is separate from the cached official sign-in. In API mode
/// the official cookies stay on disk, but that account is not the active route.
pub(crate) fn api_mode(main: &Path) -> bool {
    fs::read_to_string(main.join(CONFIG_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(strip_bom(&text)).ok())
        .is_some_and(|config| config.get("deploymentMode").and_then(Value::as_str) == Some("3p"))
}

pub(crate) use crate::claude_desktop_paths::data_locked;

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

pub(crate) fn snapshot_dir(vault: &CodeVault, id: &str) -> Result<PathBuf, AppError> {
    validate_account_id(id)?;
    Ok(snapshots_root(vault).join(id))
}

fn read_meta(dir: &Path) -> Option<SnapshotMeta> {
    serde_json::from_str(&fs::read_to_string(dir.join(META_FILE)).ok()?).ok()
}

fn write_meta(dir: &Path, meta: &SnapshotMeta) -> Result<(), AppError> {
    let data =
        serde_json::to_vec_pretty(meta).map_err(|e| AppError::JsonSerialize { source: e })?;
    crate::config::atomic_write(&dir.join(META_FILE), &data)
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if crate::security_limits::is_link_or_reparse_point(&meta) => {
            if meta.is_dir() {
                fs::remove_dir(path)
            } else {
                fs::remove_file(path)
            }
        }
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
        let meta = fs::symlink_metadata(&from)?;
        if crate::security_limits::is_link_or_reparse_point(&meta) {
            continue;
        }
        if meta.is_dir() {
            copy_dir(&from, &to)?;
        } else if meta.is_file() {
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
        let from_is_regular_file = fs::symlink_metadata(&from)
            .map(|meta| !crate::security_limits::is_link_or_reparse_point(&meta) && meta.is_file())
            .unwrap_or(false);
        if from_is_regular_file {
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
        let from_is_regular_dir = fs::symlink_metadata(&from)
            .map(|meta| !crate::security_limits::is_link_or_reparse_point(&meta) && meta.is_dir())
            .unwrap_or(false);
        if from_is_regular_dir {
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

#[derive(Serialize, Deserialize)]
struct SnapshotSave {
    target: String,
}

fn snapshot_save_path(parent: &Path, token: &str) -> PathBuf {
    parent.join(format!("{SNAPSHOT_SAVE_PREFIX}{token}.json"))
}

fn snapshot_save_error() -> AppError {
    AppError::Message(
        "Desktop 快照保存尚未恢复，已保留原快照和暂存文件。请检查快照目录后重试。".to_string(),
    )
}

/// Only direct, ordinary directories may be moved or recursively cleaned up.
fn snapshot_directory_exists(path: &Path) -> Result<bool, AppError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !crate::security_limits::is_link_or_reparse_point(&meta) => {
            Ok(true)
        }
        Ok(_) => Err(snapshot_save_error()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::io(path, error)),
    }
}

fn snapshot_complete(path: &Path) -> bool {
    has_sign_in_files(path) && read_meta(path).is_some()
}

fn write_snapshot_save(parent: &Path, token: &str, target: &str) -> Result<(), AppError> {
    let data = serde_json::to_vec(&SnapshotSave {
        target: target.to_string(),
    })
    .map_err(|source| AppError::JsonSerialize { source })?;
    crate::config::atomic_write_checked::<AppError, _>(
        &snapshot_save_path(parent, token),
        &data,
        true,
        || Ok(()),
    )
}

/// Keep the old snapshot until publication, or finish cleaning a published one.
/// A first capture with no old copy can safely publish its complete staging copy.
fn recover_snapshot_save(parent: &Path, token: &str) -> Result<(), AppError> {
    validate_account_id(token).map_err(|_| snapshot_save_error())?;
    let record = snapshot_save_path(parent, token);
    let data = crate::security_limits::read_limited(&record, 4096)
        .map_err(|error| AppError::io(&record, error))?;
    let save: SnapshotSave = serde_json::from_slice(&data).map_err(|_| snapshot_save_error())?;
    // Account IDs and stash timestamps are plain names. Never accept paths or
    // the dot-prefixed folders reserved for recovery itself.
    if save.target.is_empty()
        || save.target.len() > 128
        || save.target.starts_with('.')
        || save.target.ends_with('.')
        || !save
            .target
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err(snapshot_save_error());
    }
    let target = parent.join(&save.target);
    let staging = parent.join(format!(".staging-{token}"));
    let old = parent.join(format!(".old-{token}"));
    let target_exists = snapshot_directory_exists(&target)?;
    let old_exists = snapshot_directory_exists(&old)?;
    let staging_exists = snapshot_directory_exists(&staging)?;
    if !target_exists {
        let source = if old_exists && snapshot_complete(&old) {
            &old
        } else if staging_exists && snapshot_complete(&staging) {
            // Even when an incomplete `.old-*` exists from an interrupted overwrite
            // of a damaged snapshot, roll forward from the complete staged snapshot
            // rather than permanently wedging the vault.
            &staging
        } else {
            return Err(snapshot_save_error());
        };
        fs::rename(source, &target).map_err(|error| AppError::io(&target, error))?;
    }
    if !snapshot_complete(&target) {
        return Err(snapshot_save_error());
    }
    // Every destructive step follows recovery of a complete final snapshot.
    remove_if_exists(&old).map_err(|error| AppError::io(&old, error))?;
    remove_if_exists(&staging).map_err(|error| AppError::io(&staging, error))?;
    fs::remove_file(&record).map_err(|error| AppError::io(&record, error))
}

fn recover_snapshot_saves(parent: &Path) -> Result<(), AppError> {
    if !snapshot_directory_exists(parent)? {
        return Ok(());
    }
    let entries = fs::read_dir(parent).map_err(|error| AppError::io(parent, error))?;
    let mut tokens = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| AppError::io(parent, error))?;
        let name = entry.file_name();
        if let Some(token) = name
            .to_str()
            .and_then(|name| name.strip_prefix(SNAPSHOT_SAVE_PREFIX))
            .and_then(|name| name.strip_suffix(".json"))
        {
            tokens.push(token.to_string());
        }
    }
    tokens.sort();
    for token in tokens {
        recover_snapshot_save(parent, &token)?;
    }
    Ok(())
}

/// A copy of the sign-in files into a fresh folder next to the final one, put
/// in place only when complete; its recovery record precedes either rename.
fn save_snapshot(main: &Path, target: &Path, meta: &SnapshotMeta) -> Result<(), AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Message("快照路径无效".to_string()))?;
    fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    recover_snapshot_saves(parent)?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(snapshot_save_error)?;
    let token = super::new_account_id();
    let staging = parent.join(format!(".staging-{token}"));
    let old = parent.join(format!(".old-{token}"));
    let mut journaled = false;
    let result = (|| {
        copy_auth_set(main, &staging).map_err(|e| AppError::io(&staging, e))?;
        write_meta(&staging, meta)?;
        let had_old = snapshot_directory_exists(target)?;
        write_snapshot_save(parent, &token, name)?;
        journaled = true;
        if had_old {
            fs::rename(target, &old).map_err(|e| AppError::io(target, e))?;
        }
        fs::rename(&staging, target).map_err(|e| AppError::io(target, e))
    })();
    if journaled {
        // Also tries the immediate rollback on a failed rename. If recovery
        // fails, keep the record and both working folders for the next attempt.
        recover_snapshot_save(parent, &token).map_err(|recovery| {
            AppError::Message(format!("保存 Desktop 登录后未能完成恢复：{recovery}"))
        })?;
    } else if result.is_err() {
        let _ = remove_if_exists(&staging);
    }
    result
}

/// Recover interrupted saves before removing orphaned snapshots. Complete
/// legacy working copies have no trustworthy target mapping and are retained.
fn sweep_leftovers(vault: &CodeVault) -> Result<(), AppError> {
    let root = snapshots_root(vault);
    for dir in [&root, &root.join(STASH_DIR)] {
        recover_snapshot_saves(dir)?;
    }
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
            if name.starts_with(".staging-")
                && !has_sign_in_files(&entry.path())
                && read_meta(&entry.path()).is_none()
            {
                let _ = remove_if_exists(&entry.path());
            }
        }
    }
    Ok(())
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
    sweep_leftovers(vault)?;
    recover_interrupted(vault, main)?;
    let (target, meta) = capture_target(vault, main, id)?;
    save_snapshot(main, &target, &meta)
}

/// Validates the identity selected in the import dialog, including after Desktop closes.
pub(crate) fn check_import(main: &Path, expected_uuid: &str) -> Result<(), AppError> {
    let login = login_of(main);
    if !login.signed_in {
        return Err(not_signed_in_error());
    }
    if expected_uuid.trim().is_empty()
        || !same_uuid_opt(login.account_uuid.as_deref(), Some(expected_uuid.trim()))
    {
        return Err(AppError::Message(
            "本机 Desktop 的登录已变化，请重新检测后再导入。".to_string(),
        ));
    }
    if !has_sign_in_files(main) {
        return Err(AppError::Message(
            "Desktop 登录文件不完整，请打开 Desktop 确认已登录后再试。".to_string(),
        ));
    }
    Ok(())
}

/// Publishes an account only after its Desktop sign-in has been safely captured.
pub(crate) fn import_in(
    vault: &CodeVault,
    main: &Path,
    expected_uuid: &str,
    email: Option<&str>,
) -> Result<code::CodeAccountDto, AppError> {
    if data_locked(main) {
        return Err(running_error());
    }
    sweep_leftovers(vault)?;
    recover_interrupted(vault, main)?;
    check_import(main, expected_uuid)?;
    code::save_desktop_login_in(vault, expected_uuid, email, |id| {
        let target = snapshot_dir(vault, id)?;
        let meta = SnapshotMeta {
            account_id: id.to_string(),
            account_uuid: Some(expected_uuid.trim().to_string()),
            captured_at: Utc::now().to_rfc3339(),
        };
        save_snapshot(main, &target, &meta)
    })
}

/// A whole, identity-checked snapshot for read-only quota queries.
pub(crate) fn quota_data_dir(vault: &CodeVault, id: &str) -> Result<Option<PathBuf>, AppError> {
    let dir = snapshot_dir(vault, id)?;
    let expected = code::account_uuid_of(vault, id)?;
    let valid = read_meta(&dir).is_some_and(|meta| {
        meta.account_id == id
            && same_uuid_opt(meta.account_uuid.as_deref(), expected.as_deref())
            && same_uuid_opt(login_of(&dir).account_uuid.as_deref(), expected.as_deref())
    });
    Ok((valid && has_sign_in_files(&dir)).then_some(dir))
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
        .filter(|name| !name.starts_with('.'))
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
    recover_snapshot_saves(&snapshots_root(vault))?;
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
    if api_mode(main) {
        Ok(())
    } else {
        reject_current(main, &meta)
    }
}

/// Replaces the default Desktop's sign-in with this login's snapshot.
/// Desktop must be closed. The outgoing sign-in is kept first, and the
/// previous files come back if putting the new ones in place fails.
pub(crate) fn switch_in(
    vault: &CodeVault,
    main: &Path,
    id: &str,
    activate_official: impl FnOnce() -> Result<(), AppError>,
) -> Result<SwitchResult, AppError> {
    if needs_recovery(vault) {
        if data_locked(main) {
            return Err(running_error());
        }
        recover_interrupted(vault, main)?;
    }
    let meta = switch_meta(vault, id)?;
    if api_mode(main) && reject_current(main, &meta).is_err() {
        if data_locked(main) {
            return Err(running_error());
        }
        // The cached login may be newer than its snapshot. Only change mode.
        activate_official()?;
        return Ok(SwitchResult {
            stashed_outgoing: false,
            saved_outgoing_for: None,
        });
    }
    switch_with(vault, main, id, |source, destination| {
        apply_auth_set(source, destination)?;
        // Last fallible step: the provider service compensates its own writes;
        // change_sign_in restores the previous auth set if activation fails.
        activate_official().map_err(|error| io::Error::other(error.to_string()))
    })
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
    activate_official: impl FnOnce() -> Result<(), AppError>,
) -> Result<SwitchResult, AppError> {
    check_prepare(vault, main, id)?;
    change_sign_in(vault, main, id, None, |main| {
        clear_sign_in(main)?;
        activate_official().map_err(|error| io::Error::other(error.to_string()))
    })
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
    sweep_leftovers(vault)?;
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
    crate::config::atomic_write(&pending, marker.to_string().as_bytes())?;
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
    pub platform_supported: bool,
    pub unsupported_reason: Option<String>,
    /// Desktop has its data open.
    pub running: bool,
    pub signed_in: bool,
    /// An official login can be cached while the API route is active.
    pub api_mode: bool,
    pub account_uuid: Option<String>,
    /// The saved login Desktop is signed in as, when it is one.
    pub current_account_id: Option<String>,
    pub snapshots: Vec<SnapshotDto>,
}

pub(crate) fn status_in(vault: &CodeVault, main: Option<&Path>) -> SwapStatus {
    let login = main.map(login_of).unwrap_or_default();
    let api_mode = main.is_some_and(api_mode);
    let current_account_id = login
        .account_uuid
        .as_deref()
        .filter(|_| login.signed_in)
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
                is_current: !api_mode
                    && login.signed_in
                    && same_uuid_opt(meta.account_uuid.as_deref(), login.account_uuid.as_deref()),
                account_id: id,
                captured_at: meta.captured_at,
            });
        }
    }
    let platform_supported = supported();
    let unsupported_reason = if !platform_supported {
        Some("Claude Desktop 账号切换目前仅支持 Windows。".to_string())
    } else if main.is_none() {
        Some("未检测到 Claude Desktop 配置目录，请先打开并登录 Claude Desktop。".to_string())
    } else {
        None
    };
    SwapStatus {
        supported: platform_supported && main.is_some(),
        platform_supported,
        unsupported_reason,
        running: main.is_some_and(data_locked),
        signed_in: login.signed_in,
        api_mode,
        account_uuid: login.account_uuid,
        current_account_id,
        snapshots,
    }
}

/// Removes a login's snapshot (when the login is deleted or on request).
pub(crate) fn remove_snapshot(vault: &CodeVault, id: &str) -> Result<(), AppError> {
    let dir = snapshot_dir(vault, id)?;
    sweep_leftovers(vault)?;
    remove_if_exists(&dir).map_err(|e| AppError::io(&dir, e))
}

/// Everything kept of a deleted login's Desktop sign-in: its snapshot, and
/// the stashed sign-ins of the same account.
pub(crate) fn forget_account(
    vault: &CodeVault,
    id: &str,
    account_uuid: Option<&str>,
) -> Result<(), AppError> {
    remove_snapshot(vault, id)?;
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
    sweep_leftovers(vault)
}

// ===== the Desktop process =====

/// A Desktop process that serves the default data folder: the app's own
/// executable and no `--user-data-dir` (Chimera's separate profiles pass one).
#[cfg(any(windows, all(test, not(target_os = "macos"))))]
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

#[cfg(windows)]
fn process_exited(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        // Only treat ERROR_INVALID_PARAMETER (PID no longer exists) as exited;
        // ERROR_ACCESS_DENIED (e.g. elevated/AppContainer process) means it is still alive.
        return unsafe { GetLastError() } == ERROR_INVALID_PARAMETER;
    }
    let state = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    state == WAIT_OBJECT_0
}

/// Closes the default Desktop: asks nicely, then ends what is left, and
/// waits until both its data locks are released and its processes have exited.
/// Returns `true` when it was running.
#[cfg(windows)]
pub(crate) fn close_main_desktop(main: &Path) -> Result<bool, AppError> {
    use std::os::windows::process::CommandExt;
    use std::time::{Duration, Instant};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut tracked_pids = main_desktop_pids();
    if tracked_pids.is_empty() && !data_locked(main) {
        return Ok(false);
    }
    for pid in &tracked_pids {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let wait = |tracked: &[u32], limit: Duration| {
        let start = Instant::now();
        while start.elapsed() < limit {
            if !data_locked(main)
                && tracked.iter().all(|&pid| process_exited(pid))
                && main_desktop_pids().is_empty()
                && !data_locked(main)
            {
                return true;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        !data_locked(main)
            && tracked.iter().all(|&pid| process_exited(pid))
            && main_desktop_pids().is_empty()
    };
    if !wait(&tracked_pids, Duration::from_secs(6)) {
        // It lives on in the tray after its windows close. What it runs (Code
        // sessions, MCP servers) goes with it.
        tracked_pids = main_desktop_pids();
        for pid in &tracked_pids {
            crate::process_utils::terminate_process_tree(*pid);
        }
        if !wait(&tracked_pids, Duration::from_secs(8)) {
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

// The vault saves no login on macOS (Claude Code keeps it in the keychain).
#[cfg(all(test, not(target_os = "macos")))]
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

    /// Creates the on-disk state immediately before either replacement rename.
    fn snapshot_save_test_transaction(
        root: &Path,
        parent: &Path,
        name: &str,
    ) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let before = desktop(&root.join("before"), "uuid-a", "old");
        let incoming = desktop(&root.join("incoming"), "uuid-a", "new");
        let token = "aregression1";
        let target = parent.join(name);
        let staging = parent.join(format!(".staging-{token}"));
        let old = parent.join(format!(".old-{token}"));
        let meta = SnapshotMeta {
            account_id: if parent.file_name().is_some_and(|name| name == STASH_DIR) {
                String::new()
            } else {
                name.to_string()
            },
            account_uuid: Some("uuid-a".to_string()),
            captured_at: "2026-11-17T00:00:00Z".to_string(),
        };
        copy_auth_set(&before, &target).unwrap();
        write_meta(&target, &meta).unwrap();
        copy_auth_set(&incoming, &staging).unwrap();
        write_meta(&staging, &meta).unwrap();
        write_snapshot_save(parent, token, name).unwrap();
        (target, staging, old, snapshot_save_path(parent, token))
    }

    #[test]
    fn snapshot_save_recovers_every_replace_boundary() {
        for in_stash in [false, true] {
            for boundary in 0..4 {
                let temp = tempfile::tempdir().unwrap();
                let parent = if in_stash {
                    temp.path().join("desktop-auth").join(STASH_DIR)
                } else {
                    temp.path().join("desktop-auth")
                };
                let name = if in_stash {
                    "20261117T000000.000"
                } else {
                    "saved-account"
                };
                let (target, staging, old, record) =
                    snapshot_save_test_transaction(temp.path(), &parent, name);
                if boundary >= 1 {
                    fs::rename(&target, &old).unwrap();
                }
                if boundary >= 2 {
                    fs::rename(&staging, &target).unwrap();
                }
                if boundary >= 3 {
                    remove_if_exists(&old).unwrap();
                }
                recover_snapshot_saves(&parent).unwrap();
                let expected = if boundary < 2 { "old" } else { "new" };
                assert_eq!(marker_of(&target), expected);
                assert!(snapshot_complete(&target));
                assert!(!staging.exists() && !old.exists() && !record.exists());
                recover_snapshot_saves(&parent).unwrap();
                assert_eq!(marker_of(&target), expected, "recovery must be idempotent");
            }
        }
    }

    #[test]
    fn snapshot_save_recovers_first_capture_without_old_target() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("desktop-auth");
        let (target, staging, old, record) =
            snapshot_save_test_transaction(temp.path(), &parent, "saved-account");
        remove_if_exists(&target).unwrap();
        recover_snapshot_saves(&parent).unwrap();
        assert_eq!(marker_of(&target), "new");
        assert!(snapshot_complete(&target));
        assert!(!staging.exists() && !old.exists() && !record.exists());
    }

    #[test]
    fn snapshot_save_retains_copies_when_recovery_cannot_proceed() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("desktop-auth");
        let (target, staging, old, record) =
            snapshot_save_test_transaction(temp.path(), &parent, "saved-account");
        fs::rename(&target, &old).unwrap();
        // A deterministic blocker models an unsuccessful rename-back.
        fs::create_dir(&target).unwrap();
        assert!(recover_snapshot_saves(&parent).is_err());
        assert_eq!(marker_of(&old), "old");
        assert_eq!(marker_of(&staging), "new");
        assert!(record.exists());
        fs::remove_dir(&target).unwrap();
        recover_snapshot_saves(&parent).unwrap();
        assert_eq!(marker_of(&target), "old");
        assert!(!staging.exists() && !old.exists() && !record.exists());
    }

    #[test]
    fn snapshot_save_rejects_journal_path_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("desktop-auth");
        let (target, staging, old, record) =
            snapshot_save_test_transaction(temp.path(), &parent, "saved-account");
        fs::rename(&target, &old).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("sentinel"), b"untouched").unwrap();
        write_snapshot_save(&parent, "aregression1", "../outside").unwrap();
        assert!(recover_snapshot_saves(&parent).is_err());
        assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"untouched");
        assert_eq!(marker_of(&old), "old");
        assert_eq!(marker_of(&staging), "new");
        assert!(record.exists() && !target.exists());
    }

    #[test]
    fn snapshot_save_sweep_recovers_before_other_account_capture() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let b = saved(&f, "b@example.com", "uuid-b");
        let temp = tempfile::tempdir().unwrap();
        let root = snapshots_root(&f.vault);
        let (target, staging, old, record) = snapshot_save_test_transaction(temp.path(), &root, &a);
        fs::rename(&target, &old).unwrap();
        let main = desktop(&temp.path().join("other"), "uuid-b", "other");
        capture_in(&f.vault, &main, &b).unwrap();
        assert_eq!(marker_of(&target), "old");
        assert_eq!(marker_of(&snapshot_dir(&f.vault, &b).unwrap()), "other");
        assert!(!staging.exists() && !old.exists() && !record.exists());
    }

    #[test]
    fn snapshot_save_preserves_legacy_backups_during_sweep_and_pruning() {
        let f = fixture();
        let temp = tempfile::tempdir().unwrap();
        let stash = snapshots_root(&f.vault).join(STASH_DIR);
        let (target, staging, old, record) =
            snapshot_save_test_transaction(temp.path(), &stash, "20261117T000000.000");
        fs::rename(&target, &old).unwrap();
        fs::remove_file(&record).unwrap(); // Legacy versions wrote no journal.
        for day in 1..=7 {
            fs::create_dir(stash.join(format!("202601{day:02}T000000.000"))).unwrap();
        }
        sweep_leftovers(&f.vault).unwrap();
        prune_stash(&f.vault);
        assert_eq!(marker_of(&old), "old");
        assert_eq!(marker_of(&staging), "new");
        let kept = fs::read_dir(&stash)
            .unwrap()
            .flatten()
            .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
            .count();
        assert_eq!(kept, KEEP_STASH);
    }

    #[test]
    fn snapshot_save_forget_retains_copies_when_recovery_is_blocked() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        let stash = snapshots_root(&f.vault).join(STASH_DIR);
        let (target, staging, old, record) =
            snapshot_save_test_transaction(temp.path(), &stash, "20261117T000000.000");
        fs::rename(&target, &old).unwrap();
        fs::create_dir(&target).unwrap();
        assert!(forget_account(&f.vault, &a, Some("uuid-a")).is_err());
        assert_eq!(marker_of(&old), "old");
        assert_eq!(marker_of(&staging), "new");
        assert!(record.exists());
        fs::remove_dir(&target).unwrap();
        forget_account(&f.vault, &a, Some("uuid-a")).unwrap();
        assert!(!target.exists() && !staging.exists() && !old.exists() && !record.exists());
    }

    #[test]
    fn snapshot_save_deletion_does_not_resurrect_pending_snapshot() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        let root = snapshots_root(&f.vault);
        let (target, staging, old, record) = snapshot_save_test_transaction(temp.path(), &root, &a);
        fs::rename(&target, &old).unwrap();
        remove_snapshot(&f.vault, &a).unwrap();
        sweep_leftovers(&f.vault).unwrap();
        assert!(!target.exists() && !staging.exists() && !old.exists() && !record.exists());
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
    fn importing_local_desktop_creates_one_card_with_a_complete_snapshot() {
        let f = fixture();
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        let a = import_in(&f.vault, &main, "UUID-A", Some("a@example.com")).unwrap();
        assert_eq!(a.kind, code::SlotKind::DesktopOnly);
        let snap = quota_data_dir(&f.vault, &a.id).unwrap().unwrap();
        assert_eq!(marker_of(&snap), "A");
        assert!(!snap.join("claude_desktop_config.json").exists());
        code::rename_in(&f.vault, &a.id, "我的账号").unwrap();
        let again = import_in(&f.vault, &main, "uuid-a", None).unwrap();
        assert_eq!(again.id, a.id);
        assert_eq!(again.name, "我的账号");
        assert_eq!(code::all_account_ids(&f.vault).len(), 1);
        let state = status_in(&f.vault, Some(&main));
        assert_eq!(state.current_account_id.as_deref(), Some(a.id.as_str()));
        assert_eq!(state.snapshots.len(), 1);
    }

    #[test]
    fn changed_or_incomplete_desktop_login_cannot_publish_an_import() {
        let f = fixture();
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-b", "B");
        assert!(import_in(&f.vault, &main, "uuid-a", None).is_err());
        fs::remove_file(main.join("Local State")).unwrap();
        assert!(import_in(&f.vault, &main, "uuid-b", None).is_err());
        assert!(code::all_account_ids(&f.vault).is_empty());
    }

    #[test]
    fn saved_quota_rejects_a_snapshot_with_the_wrong_identity() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        capture_in(&f.vault, &main, &a).unwrap();
        let snap = quota_data_dir(&f.vault, &a).unwrap().unwrap();
        fs::write(
            snap.join("config.json"),
            json!({
                "lastKnownAccountUuid": "uuid-b", "oauth:tokenCacheV2": "v10B"
            })
            .to_string(),
        )
        .unwrap();
        assert!(quota_data_dir(&f.vault, &a).unwrap().is_none());
    }

    #[test]
    fn a_stale_account_uuid_after_logout_is_not_the_current_desktop_account() {
        let f = fixture();
        saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        fs::write(
            main.join("config.json"),
            json!({"lastKnownAccountUuid": "uuid-a"}).to_string(),
        )
        .unwrap();
        let state = status_in(&f.vault, Some(&main));
        assert!(!state.signed_in);
        assert!(state.current_account_id.is_none());
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

        let result = switch_in(&f.vault, &main, &b, || Ok(())).unwrap();
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
        switch_in(&f.vault, &main, &a, || Ok(())).unwrap();
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
            let result = switch_in(&f.vault, &main, &b, || Ok(())).unwrap();
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
        assert!(switch_in(&f.vault, &main, &a, || Ok(()))
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
        assert!(switch_in(&f.vault, &main, &a, || Ok(()))
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
        assert!(switch_in(&f.vault, &main, &b, || Ok(()))
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

        let result = switch_in(&f.vault, &main, &b, || Ok(())).unwrap();
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
        let error = switch_in(&f.vault, &main, &b, || Ok(()))
            .err()
            .unwrap()
            .to_string();
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
        let result = prepare_login_in(&f.vault, &main, &b, || Ok(())).unwrap();
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
        switch_in(&f.vault, &main, &a, || Ok(())).unwrap();
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
        let error = switch_in(&f.vault, &main, &a, || Ok(()))
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("不用切换"), "{error}");
        assert_eq!(marker_of(&main), "A-newer", "the newer copy stays");
    }

    #[test]
    fn switching_from_api_to_the_cached_official_account_keeps_its_newer_auth() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A");
        capture_in(&f.vault, &main, &a).unwrap();
        fs::write(
            main.join("config.json"),
            json!({
                "deploymentMode": "3p", "lastKnownAccountUuid": "uuid-a",
                "oauth:tokenCacheV2": "v10A-newer"
            })
            .to_string(),
        )
        .unwrap();
        copy_auth_set(&main, &rollback_path(&f.vault)).unwrap();
        fs::write(pending_path(&f.vault), "{}").unwrap();
        fs::write(main.join("Cookies"), "partial:Cookies").unwrap();
        let status = status_in(&f.vault, Some(&main));
        assert!(status.api_mode);
        assert!(!status.snapshots[0].is_current);
        check_switch(&f.vault, &main, &a).unwrap();
        switch_in(&f.vault, &main, &a, || {
            let mut config: Value =
                serde_json::from_slice(&fs::read(main.join("config.json")).unwrap()).unwrap();
            config.as_object_mut().unwrap().remove("deploymentMode");
            fs::write(main.join("config.json"), config.to_string()).unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(marker_of(&main), "A-newer");
        assert_eq!(
            fs::read_to_string(main.join("Cookies")).unwrap(),
            "A:Cookies"
        );
        assert!(!needs_recovery(&f.vault));
        assert!(!api_mode(&main));
        assert!(status_in(&f.vault, Some(&main)).snapshots[0].is_current);
    }

    #[test]
    fn failed_official_activation_restores_the_previous_auth_and_api_mode() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a");
        let b = saved(&f, "b@example.com", "uuid-b");
        let saved_b = tempfile::tempdir().unwrap();
        capture_in(&f.vault, &desktop(saved_b.path(), "uuid-b", "B"), &b).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let main = desktop(temp.path(), "uuid-a", "A-newer");
        let mut config: Value =
            serde_json::from_slice(&fs::read(main.join("config.json")).unwrap()).unwrap();
        config["deploymentMode"] = json!("3p");
        fs::write(main.join("config.json"), config.to_string()).unwrap();
        let before = fs::read(main.join("config.json")).unwrap();
        let error = switch_in(&f.vault, &main, &b, || {
            assert_eq!(marker_of(&main), "B");
            Err(AppError::Message("activation failed".into()))
        })
        .err()
        .unwrap();
        assert!(error.to_string().contains("已恢复原来的登录"));
        assert_eq!(fs::read(main.join("config.json")).unwrap(), before);
        assert_eq!(marker_of(&snapshot_dir(&f.vault, &a).unwrap()), "A-newer");
        assert!(api_mode(&main));
        assert!(!needs_recovery(&f.vault));
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
        sweep_leftovers(&f.vault).unwrap();
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
