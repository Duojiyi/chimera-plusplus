//! Copies of session files taken before a delete, shared by every tool, and
//! the list / restore / clear actions the sessions page offers for them.
//!
//! Each delete writes one generation directory, named with a sortable local
//! timestamp, holding the copied files and a `manifest.json` written last (a
//! generation without a manifest is incomplete). Codex keeps its own root and
//! manifest layout (`rollouts`, `threadIds`, plus SQLite copies); the other
//! tools use `files` and `sessionIds`.

use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::security_limits::{
    is_link_or_reparse_point, open_regular_file_no_symlink, read_limited, MAX_CONFIG_FILE_BYTES,
};

pub(crate) const BACKUP_MANIFEST: &str = "manifest.json";
pub(super) const RESTORE_STAGING_PREFIX: &str = ".chimera-restore-";
/// Where the non-Codex tools keep the copied files inside a generation.
const BACKUP_FILES_DIR: &str = "files";
/// A generation moves here in the namespace before any of its files are removed.
const PENDING_CLEAR_PREFIX: &str = ".pending-clear-";

static BACKUP_OPERATIONS: Mutex<()> = Mutex::new(());

/// Serializes backup creation and pruning with restore and clear. Callers
/// that also need the Codex runtime lock acquire it first.
pub(crate) fn lock_backup_operations() -> Result<MutexGuard<'static, ()>, String> {
    BACKUP_OPERATIONS
        .lock()
        .map_err(|_| "会话备份操作锁不可用，请重启 Chimera++ 后重试".into())
}

/// Tools whose deletes are backed up, in the order the restore list groups
/// ties. Codex first: its root predates the others.
const BACKED_UP_TOOLS: &[&str] = &["codex", "claude", "gemini", "grokbuild"];

/// Backups of earlier deletes kept besides the current one; older ones are
/// removed so deleting sessions does not grow disk use without bound.
const KEPT_SESSION_DELETE_BACKUPS: usize = 20;
/// A backup younger than this is never pruned, so a large batch delete keeps
/// every backup it made.
const SESSION_DELETE_BACKUP_MIN_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Where `tool`'s delete backups live. Codex keeps the 2.8.7 location.
#[cfg(not(test))]
pub(crate) fn backup_root(tool: &str) -> PathBuf {
    let backups = crate::config::get_app_config_dir().join("backups");
    if tool == "codex" {
        backups.join("codex-session-delete")
    } else {
        backups.join("session-delete").join(tool)
    }
}

/// Tests never write into the real app data directory; the tests of this
/// module pass explicit roots instead.
#[cfg(test)]
pub(crate) fn backup_root(tool: &str) -> PathBuf {
    std::env::temp_dir()
        .join("chimera-session-delete-backup-tests")
        .join(tool)
}

/// A new generation directory name under a backup root.
pub(crate) fn new_generation_name() -> String {
    format!(
        "{}_{}",
        chrono::Local::now().format("%Y%m%d_%H%M%S"),
        uuid::Uuid::new_v4()
    )
}

/// One file copied aside before a delete.
#[derive(Debug)]
pub(crate) struct BackedUpFile {
    pub source: PathBuf,
    /// File name inside the generation's files directory.
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
}

/// Back up `files` of one `tool` session before it is deleted: copy and
/// verify them, write the manifest, then prune old generations. Returns
/// `None` when there was nothing to copy. On error nothing is left behind and
/// the caller must not delete anything.
// Adapted from BigPizzaV3/CodexPlusPlus 4a5ad45d
pub(crate) fn backup_session_files(
    root: &Path,
    tool: &str,
    session_id: &str,
    title: Option<&str>,
    files: &[PathBuf],
) -> Result<Option<PathBuf>, String> {
    let dir = root.join(new_generation_name());
    let copies = backup_files(files, &dir.join(BACKUP_FILES_DIR), available_space)?;
    if copies.is_empty() {
        return Ok(None);
    }
    let manifest = json!({
        "version": 1,
        "tool": tool,
        "createdAt": chrono::Local::now().to_rfc3339(),
        "sessionIds": [session_id],
        "title": title,
        "files": manifest_entries(&copies, BACKUP_FILES_DIR),
    });
    if let Err(error) = write_manifest(&dir, &manifest) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(error);
    }
    prune_session_delete_backups(root, &dir);
    Ok(Some(dir))
}

/// Manifest rows for `copies`, which live in `files_dir` of the generation.
pub(crate) fn manifest_entries(copies: &[BackedUpFile], files_dir: &str) -> Vec<Value> {
    copies
        .iter()
        .map(|copy| {
            json!({
                "originalPath": copy.source.to_string_lossy(),
                "backupFile": format!("{files_dir}/{}", copy.file_name),
                "size": copy.size,
                "sha256": copy.sha256,
            })
        })
        .collect()
}

/// Write `manifest.json` into `dir`, never replacing an existing one.
pub(crate) fn write_manifest(dir: &Path, manifest: &Value) -> Result<(), String> {
    let path = dir.join(BACKUP_MANIFEST);
    let failed = |error: String| {
        format!(
            "Failed to back up {} before deleting the session: {error}",
            path.display()
        )
    };
    let text = serde_json::to_vec_pretty(manifest).map_err(|error| failed(error.to_string()))?;
    std::fs::create_dir_all(dir).map_err(|error| failed(error.to_string()))?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| failed(error.to_string()))?;
    file.write_all(&text)
        .and_then(|()| file.sync_all())
        .map_err(|error| failed(error.to_string()))
}

/// Remove the oldest delete backups beyond the kept count that are also
/// older than [`SESSION_DELETE_BACKUP_MIN_AGE`]. Directory names start with a
/// sortable timestamp; links and stray files are left alone, and the backup
/// just made is never removed. Failures only log: the delete itself is safe.
pub(crate) fn prune_session_delete_backups(root: &Path, current: &Path) {
    prune_session_delete_backups_older_than(
        root,
        current,
        KEPT_SESSION_DELETE_BACKUPS,
        SESSION_DELETE_BACKUP_MIN_AGE,
        |path| std::fs::remove_dir_all(path),
    );
}

fn prune_session_delete_backups_older_than(
    root: &Path,
    current: &Path,
    keep: usize,
    min_age: Duration,
    remove: impl Fn(&Path) -> io::Result<()>,
) {
    let Ok(entries) = crate::security_limits::read_dir_without_links(root) else {
        return;
    };
    let mut generations: Vec<PathBuf> = entries
        .into_iter()
        .filter(|entry| entry.file_name().to_str().is_some_and(is_generation_name))
        .map(|entry| entry.path())
        .filter(|path| path != current && ordinary_directory(path).unwrap_or(false))
        .collect();
    generations.sort();
    let excess = generations.len().saturating_sub(keep);
    for old in generations.into_iter().take(excess) {
        let old_enough = std::fs::metadata(&old)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= min_age);
        if !old_enough {
            continue;
        }
        let result = mark_pending_clear(&old)
            .and_then(|pending| remove(&pending).map_err(|error| error.to_string()));
        if let Err(error) = result {
            log::warn!(
                "Failed to remove old session delete backup {}: {error}",
                old.display()
            );
        }
    }
}

/// Copy `sources` into `dir`, hashing while copying, and verify each copy
/// against a second read of its source: a file the tool is still appending
/// to would otherwise be kept half-written. Any failure (including too little
/// free space, checked up front) removes the partial copies and fails, so the
/// caller deletes nothing.
// Adapted from BigPizzaV3/CodexPlusPlus 5126bfd
pub(crate) fn backup_files<F>(
    sources: &[PathBuf],
    dir: &Path,
    available_space: F,
) -> Result<Vec<BackedUpFile>, String>
where
    F: FnOnce(&Path) -> io::Result<u64>,
{
    let failed = |path: &Path, error: String| {
        format!(
            "Failed to back up {} before deleting the session: {error}",
            path.display()
        )
    };
    let mut planned = Vec::new();
    let mut total: u64 = 0;
    for source in sources {
        match std::fs::symlink_metadata(source) {
            Ok(metadata) if metadata.is_file() => {
                total = total.saturating_add(metadata.len());
                planned.push(source);
            }
            Ok(_) => return Err(failed(source, "not a regular file".to_string())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(failed(source, error.to_string())),
        }
    }
    if planned.is_empty() {
        return Ok(Vec::new());
    }

    std::fs::create_dir_all(dir).map_err(|error| failed(dir, error.to_string()))?;
    let free = match available_space(dir) {
        Ok(free) => free,
        Err(error) => {
            let _ = std::fs::remove_dir_all(dir);
            return Err(failed(dir, error.to_string()));
        }
    };
    if free < total {
        let _ = std::fs::remove_dir_all(dir);
        return Err(format!(
            "备份空间不足，原数据未删除：会话备份需要 {}，{} 只剩 {}。",
            human_size(total),
            dir.display(),
            human_size(free)
        ));
    }

    let mut backups = Vec::with_capacity(planned.len());
    for (index, source) in planned.into_iter().enumerate() {
        match backup_one_file(source, dir, index) {
            Ok(backup) => backups.push(backup),
            Err(error) => {
                let _ = std::fs::remove_dir_all(dir);
                return Err(failed(source, error));
            }
        }
    }
    Ok(backups)
}

fn backup_one_file(source: &Path, dir: &Path, index: usize) -> Result<BackedUpFile, String> {
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "session".to_string());
    let file_name = format!("{index}-{name}");
    let target = dir.join(&file_name);
    let (size, sha256) = copy_file_hashed(source, &target).map_err(|error| error.to_string())?;
    verify_copy(source, &target, size, &sha256)?;
    Ok(BackedUpFile {
        source: source.to_path_buf(),
        file_name,
        size,
        sha256,
    })
}

/// Both the source and the copy must still hash to what was copied.
fn verify_copy(source: &Path, copy: &Path, size: u64, sha256: &str) -> Result<(), String> {
    let source_now = hash_file(source).map_err(|error| error.to_string())?;
    if source_now != (size, sha256.to_string()) {
        return Err(
            "会话文件在备份期间发生了变化，原数据未删除。请先结束这个会话后重试。".to_string(),
        );
    }
    let copy_now = hash_file(copy).map_err(|error| error.to_string())?;
    if copy_now != (size, sha256.to_string()) {
        return Err("会话备份校验失败，原数据未删除。".to_string());
    }
    Ok(())
}

/// Copy a backup into a new file and hash the bytes as they are written.
fn copy_file_hashed(source: &Path, target: &Path) -> io::Result<(u64, String)> {
    let mut input = open_regular_file_no_symlink(source)?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let copied = (|| -> io::Result<(u64, String)> {
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];
        let mut size: u64 = 0;
        loop {
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read])?;
            hasher.update(&buffer[..read]);
            size += read as u64;
        }
        output.sync_all()?;
        Ok((size, format!("{:x}", hasher.finalize())))
    })();
    if copied.is_err() {
        drop(output);
        let _ = std::fs::remove_file(target);
    }
    copied
}

fn hash_file(path: &Path) -> io::Result<(u64, String)> {
    let mut input = open_regular_file_no_symlink(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size: u64 = 0;
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

/// Free bytes available to this process on the volume that holds `dir`.
pub(crate) fn available_space(dir: &Path) -> io::Result<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = dir
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free: u64 = 0;
        // SAFETY: `wide` is NUL-terminated and outlives the call; the two
        // optional out-pointers may be null.
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(free)
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(dir.as_os_str().as_bytes())
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        // SAFETY: `path` is NUL-terminated and `stat` is a plain C struct that
        // statvfs fills in.
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // The field widths differ between platforms.
        #[allow(clippy::unnecessary_cast)]
        let (blocks, block_size) = (stat.f_bavail as u64, stat.f_frsize as u64);
        Ok(blocks.saturating_mul(block_size))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = dir;
        Ok(u64::MAX)
    }
}

/// A byte count for people: "512 字节", "64 KB", "18.2 MB".
pub(crate) fn human_size(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    let size = bytes as f64;
    if size < KIB {
        format!("{bytes} 字节")
    } else if size < KIB * KIB {
        format!("{:.0} KB", size / KIB)
    } else {
        format!("{:.1} MB", size / (KIB * KIB))
    }
}

// ---------------------------------------------------------------------------
// List / restore / clear
// ---------------------------------------------------------------------------

/// One delete backup as the sessions page lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteBackupSummary {
    /// `<tool>/<generation directory>`; passed back to restore.
    pub id: String,
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub session_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub file_count: usize,
    pub total_bytes: u64,
    /// Files whose original location is free, so a restore would write them.
    pub restorable_files: usize,
    /// Removal began, but files in this generation still need clearing.
    pub pending_clear: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteRestoreOutcome {
    pub provider_id: String,
    pub restored_files: usize,
    /// Files left alone because something already exists at their path.
    pub skipped_existing: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteBackupsCleared {
    pub removed_backups: usize,
    pub freed_bytes: u64,
}

/// One manifest row, with the backup path resolved inside its generation.
struct ManifestFile {
    original: PathBuf,
    backup: PathBuf,
    size: u64,
    sha256: String,
}

impl ManifestFile {
    fn matches(&self, size: u64, sha256: &str) -> bool {
        self.size == size && self.sha256 == sha256
    }
}

struct Generation {
    name: String,
    dir: PathBuf,
    manifest: Value,
}

/// Every tool's delete backups, newest first.
pub fn list_session_delete_backups() -> Vec<SessionDeleteBackupSummary> {
    let roots: Vec<(&str, PathBuf)> = BACKED_UP_TOOLS
        .iter()
        .map(|tool| (*tool, backup_root(tool)))
        .collect();
    list_in_roots(&roots)
}

fn list_in_roots(roots: &[(&str, PathBuf)]) -> Vec<SessionDeleteBackupSummary> {
    let mut summaries = Vec::new();
    for (tool, root) in roots {
        for generation in generations(root) {
            let Ok(files) = manifest_files(&generation) else {
                continue;
            };
            let manifest = &generation.manifest;
            let session_ids = manifest
                .get("sessionIds")
                .or_else(|| manifest.get("threadIds"))
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            summaries.push(SessionDeleteBackupSummary {
                id: format!("{tool}/{}", generation.name),
                provider_id: tool.to_string(),
                created_at: manifest
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                session_ids,
                title: manifest
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                    .map(str::to_string),
                file_count: files.len(),
                total_bytes: files.iter().map(|file| file.size).sum(),
                restorable_files: files
                    .iter()
                    .filter(|file| matches!(path_is_taken(&file.original), Ok(false)))
                    .count(),
                pending_clear: false,
            });
        }
        if !ordinary_directory(root).unwrap_or(false) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name
                .to_str()
                .filter(|name| pending_generation_name(name).is_some())
            else {
                continue;
            };
            let path = entry.path();
            if !ordinary_directory(&path).unwrap_or(false) {
                continue;
            }
            summaries.push(SessionDeleteBackupSummary {
                id: format!("{tool}/{name}"),
                provider_id: tool.to_string(),
                created_at: None,
                session_ids: Vec::new(),
                title: None,
                file_count: 0,
                total_bytes: directory_size(&path),
                restorable_files: 0,
                pending_clear: true,
            });
        }
    }
    // Generation names start with the local timestamp, across tools too.
    summaries.sort_by(|a, b| generation_name(&b.id).cmp(generation_name(&a.id)));
    summaries
}

fn generation_name(id: &str) -> &str {
    let name = id.split_once('/').map_or(id, |(_, name)| name);
    pending_generation_name(name).unwrap_or(name)
}

/// Restore the files of one delete backup to where they were. A file whose
/// path is taken again is left alone, never overwritten. Codex backups
/// restore the rollouts only: Codex lists threads from the rollout files and
/// re-seeds missing state DB rows itself.
pub fn restore_session_delete_backup(id: &str) -> Result<SessionDeleteRestoreOutcome, String> {
    let (tool, name) = parse_backup_id(id)?;
    let allowed_roots = super::provider_roots(tool)?;
    restore_in(
        &backup_root(tool),
        tool,
        name,
        &allowed_roots,
        copy_restore_contents,
    )
}

fn copy_restore_contents(file: &ManifestFile, staged: &mut std::fs::File) -> io::Result<()> {
    io::copy(&mut open_regular_file_no_symlink(&file.backup)?, staged)?;
    Ok(())
}

fn restore_in(
    root: &Path,
    tool: &str,
    name: &str,
    allowed_roots: &[PathBuf],
    mut write_staged: impl FnMut(&ManifestFile, &mut std::fs::File) -> io::Result<()>,
) -> Result<SessionDeleteRestoreOutcome, String> {
    let generation = open_generation(root, name)?;
    let files = manifest_files(&generation)?;
    if files.is_empty() {
        return Err("这份备份里没有可恢复的会话文件".to_string());
    }
    // Check everything before writing anything.
    let mut restore_files = Vec::new();
    let mut skipped_existing = 0;
    let mut codex_home = None;
    for file in &files {
        let Some(root) = matching_restore_root(&file.original, allowed_roots) else {
            return Err(format!(
                "备份记录的原位置不在会话目录内，已拒绝恢复：{}",
                file.original.display()
            ));
        };
        let (size, sha256) = hash_file(&file.backup)
            .map_err(|error| format!("无法读取备份文件 {}：{error}", file.backup.display()))?;
        if !file.matches(size, &sha256) {
            return Err(format!(
                "备份文件校验失败，已停止恢复：{}",
                file.backup.display()
            ));
        }
        if path_is_taken(&file.original)? {
            skipped_existing += 1;
            continue;
        }
        if tool == "codex" {
            let root = resolve_restore_path(root)?;
            let home = root.parent().ok_or("Codex 会话目录缺少主目录")?;
            if codex_home
                .as_deref()
                .is_some_and(|previous| previous != home)
            {
                return Err("一份 Codex 备份的会话必须位于同一个配置目录".into());
            }
            codex_home = Some(home.to_path_buf());
        }
        restore_files.push(file);
    }

    let mut restored_files = 0;
    for file in restore_files {
        if path_is_taken(&file.original)? {
            skipped_existing += 1;
            continue;
        }
        let parent = file.original.parent().ok_or("恢复路径缺少父目录")?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目录 {}：{error}", parent.display()))?;
        let checked_parent = || {
            let Some(root) = matching_restore_root(&file.original, allowed_roots) else {
                return Err(format!(
                    "恢复路径包含链接，已拒绝：{}",
                    file.original.display()
                ));
            };
            if let Some(home) = codex_home.as_deref() {
                if resolve_restore_path(root)?.parent() != Some(home) {
                    return Err("Codex 配置目录在恢复期间发生变化".into());
                }
            }
            resolve_restore_path(parent)
        };
        let resolved_parent = checked_parent()?;
        let restore_error = |error| format!("无法恢复 {}：{error}", file.original.display());
        // Keep an interrupted copy out of the session list. Publish only a
        // verified, flushed sibling, without replacing an existing session.
        let mut staged = tempfile::Builder::new()
            .prefix(RESTORE_STAGING_PREFIX)
            .suffix(".tmp")
            .tempfile_in(&resolved_parent)
            .map_err(restore_error)?;
        let target = resolved_parent.join(file.original.file_name().ok_or("恢复路径缺少文件名")?);
        let mut guard = codex_home
            .as_deref()
            .map(|home| {
                super::providers::codex::track_rollout_restore_stage(home, &target, staged.path())
            })
            .transpose()?;
        let prepare = (|| {
            write_staged(file, staged.as_file_mut()).map_err(restore_error)?;
            let (size, sha256) = hash_file(staged.path()).map_err(restore_error)?;
            if !file.matches(size, &sha256) {
                return Err(format!("恢复后的文件校验失败：{}", file.original.display()));
            }
            staged.as_file().sync_all().map_err(restore_error)?;
            if checked_parent()? != resolved_parent {
                return Err("会话目录在恢复期间发生变化".into());
            }
            if let Some(guard) = guard.as_mut().filter(|_| restored_files == 0) {
                let thread_ids = generation.manifest["threadIds"]
                    .as_array()
                    .ok_or("Codex 备份清单中缺少会话编号")?
                    .iter()
                    .map(|id| {
                        id.as_str()
                            .filter(|id| !id.is_empty())
                            .ok_or("Codex 备份清单中的会话编号无效")
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                if thread_ids.is_empty() {
                    return Err("Codex 备份清单中缺少会话编号".into());
                }
                guard.prepare_publication(&thread_ids)?;
            }
            Ok(())
        })();
        if let Err(error) = prepare {
            drop(staged);
            if let Some(guard) = guard {
                if let Err(cleanup_error) = guard.finish(false) {
                    log::warn!("{cleanup_error}");
                }
            }
            return Err(error);
        }
        if guard.is_some() {
            // Reconcile through the ledger if the no-clobber operation fails.
            staged.disable_cleanup(true);
        }
        match staged.persist_noclobber(&target) {
            Ok(_) => {
                if let Some(guard) = guard {
                    guard.finish(true)?;
                }
                restored_files += 1;
            }
            Err(tempfile::PersistError { error, file: stage }) => {
                drop(stage);
                if error.kind() != io::ErrorKind::AlreadyExists {
                    // An I/O failure does not prove whether publication happened.
                    // Reconcile the saved intent when its filesystem is readable.
                    return Err(restore_error(error));
                }
                if let Some(guard) = guard {
                    guard.finish(false)?;
                }
                skipped_existing += 1;
            }
        }
    }
    Ok(SessionDeleteRestoreOutcome {
        provider_id: tool.to_string(),
        restored_files,
        skipped_existing,
    })
}

/// Remove only the generations captured when the user opened the confirmation.
pub fn clear_session_delete_backups(ids: &[String]) -> Result<SessionDeleteBackupsCleared, String> {
    clear_confirmed_backups(ids, backup_root, |path| std::fs::remove_dir_all(path))
}

fn clear_confirmed_backups(
    ids: &[String],
    root_for: impl Fn(&str) -> PathBuf,
    remove: impl Fn(&Path) -> io::Result<()>,
) -> Result<SessionDeleteBackupsCleared, String> {
    // Reject malformed IDs before deleting any generation.
    let mut seen = std::collections::HashSet::new();
    let confirmed = ids
        .iter()
        .filter(|id| seen.insert(*id))
        .map(|id| parse_backup_id(id))
        .collect::<Result<Vec<_>, _>>()?;
    let mut cleared = SessionDeleteBackupsCleared {
        removed_backups: 0,
        freed_bytes: 0,
    };
    let mut errors = Vec::new();
    for (tool, name) in confirmed {
        let root = root_for(tool);
        let path = root.join(name);
        let result = (|| -> Result<Option<u64>, String> {
            if !ordinary_directory(&root)? || !ordinary_directory(&path)? {
                return Ok(None);
            }
            let path = if pending_generation_name(name).is_some() {
                path.clone()
            } else {
                let generation = open_generation(&root, name)?;
                manifest_files(&generation)?;
                mark_pending_clear(&path)?
            };
            let bytes = directory_size(&path);
            remove(&path).map_err(|error| error.to_string())?;
            Ok(Some(bytes))
        })();
        match result {
            Ok(Some(bytes)) => {
                cleared.removed_backups += 1;
                cleared.freed_bytes = cleared.freed_bytes.saturating_add(bytes);
            }
            Ok(None) => {} // Already pruned or cleared since the confirmation opened.
            Err(error) => errors.push(format!("{}: {error}", path.display())),
        }
    }
    if !errors.is_empty() {
        return Err(format!(
            "已清理 {} 份备份，以下备份未能删除：{}",
            cleared.removed_backups,
            errors.join("; ")
        ));
    }
    Ok(cleared)
}

fn mark_pending_clear(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("无效的备份编号")?;
    let pending = path.with_file_name(format!("{PENDING_CLEAR_PREFIX}{name}"));
    if path_is_taken(&pending)? {
        return Err("已有同名备份待清理，请先完成上次清理".into());
    }
    // A retained or explicitly cleared generation remains discoverable even
    // if recursive removal deletes its manifest before hitting a locked file.
    std::fs::rename(path, &pending).map_err(|error| error.to_string())?;
    Ok(pending)
}

fn directory_size(dir: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut pending = vec![dir.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if is_link_or_reparse_point(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    total
}

fn parse_backup_id(id: &str) -> Result<(&'static str, &str), String> {
    let invalid = || format!("无效的备份编号：{id}");
    let (tool, name) = id.split_once('/').ok_or_else(invalid)?;
    let tool = BACKED_UP_TOOLS
        .iter()
        .copied()
        .find(|known| *known == tool)
        .ok_or_else(invalid)?;
    if !is_generation_name(name) && pending_generation_name(name).is_none() {
        return Err(invalid());
    }
    Ok((tool, name))
}

fn ordinary_directory(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !is_link_or_reparse_point(&metadata) => Ok(true),
        Ok(_) => Err("备份路径不是普通目录".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn is_generation_name(name: &str) -> bool {
    // Generated names use a timestamp and UUID, with no Windows path aliases.
    is_single_component(name)
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn pending_generation_name(name: &str) -> Option<&str> {
    name.strip_prefix(PENDING_CLEAR_PREFIX)
        .filter(|name| is_generation_name(name))
}

fn is_single_component(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(part)) if part == name)
        && components.next().is_none()
}

/// Generation directories under `root` that carry a readable manifest,
/// newest first.
fn generations(root: &Path) -> Vec<Generation> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect();
    names.sort_by(|a, b| b.cmp(a));
    names
        .into_iter()
        .filter_map(|name| open_generation(root, &name).ok())
        .collect()
}

fn open_generation(root: &Path, name: &str) -> Result<Generation, String> {
    if !is_generation_name(name) {
        return Err(format!("无效的备份编号：{name}"));
    }
    let dir = root.join(name);
    let metadata = std::fs::symlink_metadata(&dir).map_err(|_| "找不到这份备份".to_string())?;
    if !metadata.is_dir() || is_link_or_reparse_point(&metadata) {
        return Err("找不到这份备份".to_string());
    }
    let bytes = read_limited(&dir.join(BACKUP_MANIFEST), MAX_CONFIG_FILE_BYTES)
        .map_err(|error| format!("备份清单不可读：{error}"))?;
    let manifest: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("备份清单不可读：{error}"))?;
    Ok(Generation {
        name: name.to_string(),
        dir,
        manifest,
    })
}

/// The files a manifest lists (`files`, or Codex's `rollouts`), with each
/// backup path checked to stay inside its generation.
fn manifest_files(generation: &Generation) -> Result<Vec<ManifestFile>, String> {
    let rows = generation
        .manifest
        .get("files")
        .or_else(|| generation.manifest.get("rollouts"))
        .and_then(Value::as_array)
        .ok_or("备份清单缺少文件列表")?;
    rows.iter()
        .map(|row| {
            let invalid = || "备份清单格式不正确".to_string();
            let original = row
                .get("originalPath")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .ok_or_else(invalid)?;
            let relative = row
                .get("backupFile")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            if relative.is_empty()
                || Path::new(relative)
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
            {
                return Err(invalid());
            }
            Ok(ManifestFile {
                original,
                backup: generation.dir.join(relative),
                size: row
                    .get("size")
                    .and_then(Value::as_u64)
                    .ok_or_else(invalid)?,
                sha256: row
                    .get("sha256")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?
                    .to_string(),
            })
        })
        .collect()
}

/// Something (a file, a directory or a dangling link) already sits at `path`.
fn path_is_taken(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法检查恢复位置 {}：{error}", path.display())),
    }
}

/// `path` is a strict descendant of one of `roots` (as given or
/// canonicalized), without `..`, and none of its existing ancestors below the
/// root is a link.
fn matching_restore_root<'a>(path: &Path, roots: &'a [PathBuf]) -> Option<&'a Path> {
    roots
        .iter()
        .find(|root| {
            is_within_root(path, root)
                || root
                    .canonicalize()
                    .is_ok_and(|base| is_within_root(path, &base))
        })
        .map(PathBuf::as_path)
}

/// A backup can recreate a missing sessions directory. Resolve its existing
/// ancestors so the protection still has the same key as a later delete.
fn resolve_restore_path(path: &Path) -> Result<PathBuf, String> {
    match path.canonicalize() {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
                return Ok(resolve_restore_path(parent)?.join(name));
            }
            Err(format!("无法定位 Codex 恢复目录：{error}"))
        }
        Err(error) => Err(format!("无法定位 Codex 恢复目录：{error}")),
    }
}

/// `path` relative to `root`; on Windows the comparison ignores case, as the
/// file system does (a config dir spelled `.Claude` is the same folder).
fn relative_to<'a>(path: &'a Path, root: &Path) -> Option<std::borrow::Cow<'a, Path>> {
    if let Ok(relative) = path.strip_prefix(root) {
        return Some(std::borrow::Cow::Borrowed(relative));
    }
    if !cfg!(windows) {
        return None;
    }
    let mut parts = path.components();
    for root_part in root.components() {
        let part = parts.next()?;
        if !part
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&root_part.as_os_str().to_string_lossy())
        {
            return None;
        }
    }
    Some(std::borrow::Cow::Owned(parts.as_path().to_path_buf()))
}

fn is_within_root(path: &Path, root: &Path) -> bool {
    let Some(relative) = relative_to(path, root) else {
        return false;
    };
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return false;
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if is_link_or_reparse_point(&metadata) => return false,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use tempfile::tempdir;

    #[test]
    fn session_delete_backups_keep_only_the_newest_generations() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        for name in [
            "20261001_000000_a",
            "20261002_000000_b",
            "20261003_000000_c",
        ] {
            std::fs::create_dir_all(root.join(name).join("rollouts")).unwrap();
        }
        std::fs::write(root.join("notes.txt"), b"keep").unwrap();
        let current = root.join("20261004_000000_d");
        std::fs::create_dir_all(&current).unwrap();

        // Recent backups survive even beyond the count (a large batch delete).
        let remove = |path: &Path| std::fs::remove_dir_all(path);
        prune_session_delete_backups_older_than(
            root,
            &current,
            1,
            SESSION_DELETE_BACKUP_MIN_AGE,
            remove,
        );
        assert!(root.join("20261001_000000_a").exists());

        prune_session_delete_backups_older_than(root, &current, 1, Duration::ZERO, remove);

        assert!(!root.join("20261001_000000_a").exists());
        assert!(!root.join("20261002_000000_b").exists());
        assert!(root.join("20261003_000000_c").exists());
        assert!(current.exists());
        assert!(root.join("notes.txt").exists());
    }

    #[test]
    fn interrupted_retention_remains_listed_and_can_be_retried_without_a_manifest() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let old = root.join("20261001_000000_a");
        let current = root.join("20261002_000000_b");
        for generation in [&old, &current] {
            write_manifest(generation, &json!({"files": []})).unwrap();
            std::fs::write(generation.join("payload"), b"12345").unwrap();
        }
        prune_session_delete_backups_older_than(root, &current, 0, Duration::ZERO, |pending| {
            std::fs::remove_file(pending.join(BACKUP_MANIFEST))?;
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "locked payload",
            ))
        });
        assert!(!old.exists());
        let roots = [("claude", root.to_path_buf())];
        let pending = list_in_roots(&roots)
            .into_iter()
            .find(|entry| entry.pending_clear)
            .unwrap();
        assert_eq!(pending.total_bytes, 5);
        let cleared = clear_confirmed_backups(
            &[pending.id],
            |_| root.to_path_buf(),
            |path| std::fs::remove_dir_all(path),
        )
        .unwrap();
        assert_eq!(cleared.removed_backups, 1);
        assert_eq!(list_in_roots(&roots).len(), 1);
        assert!(current.is_dir());
    }

    #[test]
    fn backup_without_enough_space_copies_and_deletes_nothing() {
        let temp = tempdir().unwrap();
        let main = temp.path().join("session.jsonl");
        std::fs::write(&main, b"{\"type\":\"session\"}\n").unwrap();
        let dir = temp.path().join("backup").join("rollouts");

        let error = backup_files(std::slice::from_ref(&main), &dir, |_| Ok(1))
            .expect_err("too little space must fail");
        assert!(error.contains("备份空间不足"), "{error}");
        assert!(main.exists());
        assert!(!dir.exists(), "no partial copy is left behind");

        let backups = backup_files(std::slice::from_ref(&main), &dir, |_| Ok(u64::MAX)).unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            std::fs::read(dir.join(&backups[0].file_name)).unwrap(),
            std::fs::read(&main).unwrap()
        );
    }

    #[test]
    fn a_file_that_changes_after_its_copy_fails_verification() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("session.jsonl");
        std::fs::write(&source, b"{\"type\":\"session\"}\n").unwrap();
        let copy = temp.path().join("copy.jsonl");
        let (size, sha256) = copy_file_hashed(&source, &copy).unwrap();
        verify_copy(&source, &copy, size, &sha256).expect("unchanged copy verifies");

        // The tool appends another line after the copy was taken.
        let mut writer = OpenOptions::new().append(true).open(&source).unwrap();
        writer.write_all(b"{\"type\":\"late\"}\n").unwrap();
        drop(writer);

        let error = verify_copy(&source, &copy, size, &sha256).unwrap_err();
        assert!(error.contains("发生了变化"), "{error}");
    }

    #[test]
    fn available_space_reports_the_temp_volume() {
        let temp = tempdir().unwrap();
        assert!(available_space(temp.path()).unwrap() > 0);
    }

    /// A tool's session root with one session file and a sidecar file.
    fn session_tree(base: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let sessions = base.join("projects");
        let main = sessions.join("p").join("s1.jsonl");
        let sidecar = sessions
            .join("p")
            .join("s1")
            .join("subagents")
            .join("a.jsonl");
        std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        std::fs::write(&main, b"main").unwrap();
        std::fs::write(&sidecar, b"sidecar").unwrap();
        (sessions, main, sidecar)
    }

    #[test]
    fn backup_session_files_writes_a_verified_manifest() {
        let temp = tempdir().unwrap();
        let (_, main, sidecar) = session_tree(temp.path());
        let root = temp.path().join("backups");

        let dir = backup_session_files(
            &root,
            "claude",
            "s1",
            Some("修复登录"),
            &[main.clone(), sidecar.clone()],
        )
        .unwrap()
        .expect("files were copied");

        let manifest: Value =
            serde_json::from_slice(&std::fs::read(dir.join(BACKUP_MANIFEST)).unwrap()).unwrap();
        assert_eq!(manifest["tool"], json!("claude"));
        assert_eq!(manifest["sessionIds"], json!(["s1"]));
        assert_eq!(manifest["title"], json!("修复登录"));
        let files = manifest["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        let main_entry = files
            .iter()
            .find(|row| row["originalPath"] == json!(main.to_string_lossy()))
            .unwrap();
        assert_eq!(
            std::fs::read(dir.join(main_entry["backupFile"].as_str().unwrap())).unwrap(),
            b"main"
        );
        assert_eq!(
            main_entry["sha256"],
            json!(format!("{:x}", Sha256::digest(b"main")))
        );

        // Nothing to copy: no generation is written.
        let missing = temp.path().join("projects").join("gone.jsonl");
        assert!(
            backup_session_files(&root, "claude", "s2", None, &[missing])
                .unwrap()
                .is_none()
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    }

    #[test]
    fn restore_brings_back_deleted_files_without_overwriting() {
        let temp = tempdir().unwrap();
        let (sessions, main, sidecar) = session_tree(temp.path());
        let root = temp.path().join("backups");
        let dir = backup_session_files(
            &root,
            "claude",
            "s1",
            None,
            &[main.clone(), sidecar.clone()],
        )
        .unwrap()
        .unwrap();
        let name = dir.file_name().unwrap().to_str().unwrap().to_string();

        // The delete: the main file and the whole sidecar directory go.
        std::fs::remove_file(&main).unwrap();
        std::fs::remove_dir_all(main.with_extension("")).unwrap();
        // Meanwhile a new file appeared where the main file was.
        std::fs::write(&main, b"newer").unwrap();

        let listed = list_in_roots(&[("claude", root.clone())]);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, format!("claude/{name}"));
        assert_eq!(listed[0].file_count, 2);
        assert_eq!(listed[0].restorable_files, 1);
        assert_eq!(listed[0].total_bytes, 4 + 7);

        let outcome =
            restore_in(&root, "claude", &name, &[sessions], copy_restore_contents).unwrap();
        assert_eq!(outcome.restored_files, 1);
        assert_eq!(outcome.skipped_existing, 1);
        assert_eq!(std::fs::read(&main).unwrap(), b"newer", "never overwritten");
        assert_eq!(std::fs::read(&sidecar).unwrap(), b"sidecar");
    }

    #[test]
    fn staged_restore_preserves_a_destination_created_during_copy() {
        let temp = tempdir().unwrap();
        let (sessions, original, _) = session_tree(temp.path());
        let root = temp.path().join("backups");
        let dir =
            backup_session_files(&root, "claude", "s1", None, std::slice::from_ref(&original))
                .unwrap()
                .unwrap();
        let name = dir.file_name().unwrap().to_str().unwrap();
        std::fs::remove_file(&original).unwrap();

        let restored = restore_in(&root, "claude", name, &[sessions], |file, staged| {
            copy_restore_contents(file, staged)?;
            std::fs::write(&file.original, b"concurrent session")
        })
        .unwrap();
        assert_eq!((restored.restored_files, restored.skipped_existing), (0, 1));
        assert_eq!(std::fs::read(&original).unwrap(), b"concurrent session");
    }

    fn pending_codex_backup(home: &Path, session_id: &str) -> (PathBuf, PathBuf, PathBuf, String) {
        use crate::session_manager::providers::codex;

        let root = home.join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        // An unreadable TOML config leaves a retry without a live Codex process.
        std::fs::write(home.join("config.toml"), b"[").unwrap();
        let source = root.join(format!("rollout-2026-01-01T00-00-00-{session_id}.jsonl"));
        std::fs::write(
            &source,
            format!(
                "{}\n",
                json!({"type": "session_meta", "payload": {"id": session_id}})
            ),
        )
        .unwrap();
        let result = codex::delete_session(&root, &source, session_id).unwrap();
        assert!(result.source_deleted && result.cleanup_pending);
        assert!(!source.exists());
        let backups = home.join("session-delete-backups");
        let name = generations(&backups).pop().unwrap().name;
        (root, source, backups, name)
    }

    #[test]
    fn interrupted_restore_reconciles_before_listing_or_retrying_cleanup() {
        use crate::session_manager::providers::codex;

        for (publish, moves_away, retry_first) in [
            (false, false, false),
            (false, false, true),
            (true, false, false),
            (true, true, true),
        ] {
            let temp = tempdir().unwrap();
            let home = temp.path().canonicalize().unwrap();
            let session_id = "11111111-1111-4111-8111-111111111111";
            let (sessions, source, _, _) = pending_codex_backup(&home, session_id);
            let roots = std::slice::from_ref(&sessions);
            let dated = sessions.join("2026").join("01").join("01");
            std::fs::create_dir_all(&dated).unwrap();
            let child = dated
                .join("rollout-2026-01-01T00-00-00-22222222-2222-4222-8222-222222222222.jsonl");
            let staged = dated.join(format!("{RESTORE_STAGING_PREFIX}interrupted.tmp"));
            let moved = home.join("moved-date");
            std::fs::write(&staged, b"synced rollout").unwrap();
            let mut guard = codex::track_rollout_restore_stage(&home, &child, &staged).unwrap();
            guard.prepare_publication(&[session_id]).unwrap();
            if publish {
                std::fs::rename(&staged, &child).unwrap();
            }
            if moves_away {
                std::fs::rename(&dated, &moved).unwrap();
            }
            // Simulate restart without finishing the in-memory operation, on
            // either side of the no-clobber publication.
            drop(guard);
            if !retry_first {
                assert_eq!(
                    codex::list_pending_deletes(roots).sessions.len(),
                    usize::from(!publish)
                );
            }
            std::fs::remove_file(home.join("config.toml")).unwrap();
            let result = codex::cleanup_deleted_session(&sessions, &source, session_id).unwrap();
            assert_eq!(result.cleanup_cancelled, publish);
            assert!(!result.cleanup_pending, "{:?}", result.error);
            assert!(codex::list_pending_deletes(roots).sessions.is_empty());
            assert_eq!(child.is_file(), publish && !moves_away);
            assert_eq!(moved.join(child.file_name().unwrap()).is_file(), moves_away);
            assert!(!staged.exists(), "abandoned stage should be reclaimed");
        }
    }

    #[test]
    fn restart_reclaims_interrupted_first_and_later_rollout_copies() {
        use crate::session_manager::providers::codex;

        for already_restored in [false, true] {
            let temp = tempdir().unwrap();
            let home = temp.path().canonicalize().unwrap();
            let session_id = "11111111-1111-4111-8111-111111111111";
            let (sessions, source, _, _) = pending_codex_backup(&home, session_id);
            let roots = std::slice::from_ref(&sessions);
            let child = sessions
                .join("rollout-2026-01-01T00-00-00-22222222-2222-4222-8222-222222222222.jsonl");
            if already_restored {
                let first = sessions.join(format!("{RESTORE_STAGING_PREFIX}first.tmp"));
                std::fs::write(&first, b"synced rollout").unwrap();
                let mut guard = codex::track_rollout_restore_stage(&home, &child, &first).unwrap();
                guard.prepare_publication(&[session_id]).unwrap();
                std::fs::rename(first, &child).unwrap();
                guard.finish(true).unwrap();
            }
            let stage = sessions.join(format!("{RESTORE_STAGING_PREFIX}interrupted.tmp"));
            let mut file = std::fs::File::create(&stage).unwrap();
            let guard = codex::track_rollout_restore_stage(&home, &source, &stage).unwrap();
            file.write_all(b"partial rollout").unwrap();
            // Abandon a partially copied file without advancing publication.
            drop(file);
            drop(guard);

            let pending = codex::list_pending_deletes(roots);
            assert_eq!(pending.sessions.len(), usize::from(!already_restored));
            assert!(pending.warnings.is_empty());
            assert!(!stage.exists() && !source.exists());
            assert_eq!(child.is_file(), already_restored);
        }
    }

    #[test]
    fn unreadable_restore_destination_preserves_intent_without_blocking_other_deletes() {
        use crate::session_manager::providers::codex;

        let temp = tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let affected = "11111111-1111-4111-8111-111111111111";
        let unrelated = "22222222-2222-4222-8222-222222222222";
        let (sessions, source, _, _) = pending_codex_backup(&home, affected);
        let (_, other_source, _, _) = pending_codex_backup(&home, unrelated);
        let dated = sessions.join("2026").join("01").join("01");
        std::fs::create_dir_all(&dated).unwrap();
        let staged_name = format!("{RESTORE_STAGING_PREFIX}interrupted.tmp");
        let staged = dated.join(&staged_name);
        let target = dated.join(source.file_name().unwrap());
        std::fs::write(&staged, b"synced rollout").unwrap();
        let mut guard = codex::track_rollout_restore_stage(&home, &target, &staged).unwrap();
        guard.prepare_publication(&[affected]).unwrap();
        drop(guard);
        let ledger = codex::restore_protection_path(&home);
        let intent = std::fs::read(&ledger).unwrap();

        let moved = home.join("moved-date");
        std::fs::rename(&dated, &moved).unwrap();
        std::fs::write(&dated, b"obstructed ancestor").unwrap();
        std::fs::remove_file(home.join("config.toml")).unwrap();

        let listed = codex::list_pending_deletes(std::slice::from_ref(&sessions));
        assert_eq!(listed.sessions.len(), 1);
        assert_eq!(listed.sessions[0].session_id, unrelated);
        assert!(listed
            .warnings
            .iter()
            .any(|warning| warning.contains("恢复结果暂时无法确认")));

        // An occupied source path also makes the receipt ineligible for
        // retry. The outstanding publication warning must still appear.
        std::fs::create_dir(&source).unwrap();
        let occupied = codex::list_pending_deletes(std::slice::from_ref(&sessions));
        assert_eq!(occupied.sessions.len(), 1);
        assert_eq!(occupied.sessions[0].session_id, unrelated);
        assert_eq!(occupied.warnings, listed.warnings);
        std::fs::remove_dir(&source).unwrap();

        let blocked = codex::cleanup_deleted_session(&sessions, &source, affected).unwrap_err();
        assert!(blocked.contains("恢复结果暂时无法确认"), "{blocked}");
        let clean = codex::cleanup_deleted_session(&sessions, &other_source, unrelated).unwrap();
        assert!(
            !clean.cleanup_pending && !clean.cleanup_cancelled,
            "{:?}",
            clean.error
        );
        assert_eq!(std::fs::read(&ledger).unwrap(), intent);
        assert!(moved.join(&staged_name).is_file());

        std::fs::remove_file(&dated).unwrap();
        std::fs::rename(&moved, &dated).unwrap();
        let recovered = codex::cleanup_deleted_session(&sessions, &source, affected).unwrap();
        assert!(
            !recovered.cleanup_pending && !recovered.cleanup_cancelled,
            "{:?}",
            recovered.error
        );
        assert!(!target.exists() && !staged.exists());
    }

    #[cfg(windows)]
    #[test]
    fn codex_restore_reclaims_stage_after_a_publication_lock_is_released() {
        use crate::session_manager::providers::codex;
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

        let temp = tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let session_id = "11111111-1111-4111-8111-111111111111";
        let (sessions, source, backups, name) = pending_codex_backup(&home, session_id);
        let roots = std::slice::from_ref(&sessions);
        let mut lock = None;
        let mut staged_path = None;
        let error = restore_in(&backups, "codex", &name, roots, |file, output| {
            copy_restore_contents(file, output)?;
            let staged = std::fs::read_dir(&sessions)?
                .map(|entry| entry.unwrap().path())
                .find(|entry| {
                    entry
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(RESTORE_STAGING_PREFIX)
                })
                .unwrap();
            lock = Some(
                std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .open(&staged)?,
            );
            staged_path = Some(staged);
            Ok(())
        })
        .unwrap_err();
        assert!(error.starts_with("无法恢复 "), "{error}");
        let staged = staged_path.unwrap();
        let ledger = codex::restore_protection_path(&home);
        let read_ledger = || {
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&ledger).unwrap()).unwrap()
        };
        assert!(read_ledger()["pending"].is_object());
        assert!(!source.exists() && staged.is_file());

        assert_eq!(codex::list_pending_deletes(roots).sessions.len(), 1);
        let settled = read_ledger();
        assert!(settled["pending"].is_null());
        assert_eq!(settled["revision"], 0);
        assert_eq!(settled["stages_to_remove"].as_array().unwrap().len(), 1);
        assert!(staged.is_file());
        drop(lock.take().unwrap());

        assert_eq!(codex::list_pending_deletes(roots).sessions.len(), 1);
        assert!(read_ledger()["stages_to_remove"].is_null());
        assert!(!staged.exists());
        let restored = restore_in(&backups, "codex", &name, roots, copy_restore_contents).unwrap();
        assert_eq!(restored.restored_files, 1);
        assert!(source.is_file());
    }

    #[test]
    fn codex_restore_ignores_unrelated_corrupt_journals_and_other_homes() {
        use crate::session_manager::providers::codex;

        let temp = tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let chosen = base.join("chosen");
        let other = base.join("other");
        let session_id = "11111111-1111-4111-8111-111111111111";
        let (root, source, backups, name) = pending_codex_backup(&chosen, session_id);
        let (other_root, other_source, _, _) = pending_codex_backup(&other, session_id);
        let corrupt = chosen
            .join("codex-session-delete-pending")
            .join("unrelated.json");
        std::fs::write(&corrupt, b"malformed").unwrap();

        let roots = [other_root, root];
        let result = restore_in(&backups, "codex", &name, &roots, copy_restore_contents).unwrap();
        assert_eq!(result.restored_files, 1);
        assert!(source.is_file() && !other_source.exists());
        assert_eq!(std::fs::read(&corrupt).unwrap(), b"malformed");
        let pending = codex::list_pending_deletes(&roots).sessions;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].source_path.as_deref(), other_source.to_str());
    }

    #[cfg(windows)]
    #[test]
    fn codex_restore_commit_failure_leaves_rollouts_and_pending_deletes_alone() {
        use crate::session_manager::providers::codex;
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

        let temp = tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let (root, source, backups, name) =
            pending_codex_backup(&home, "11111111-1111-4111-8111-111111111111");
        let roots = [root];
        codex::record_restore_for_test(&home, &["unrelated"]);
        let protection = codex::restore_protection_path(&home);
        let before = std::fs::read(&protection).unwrap();
        let locked = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&protection)
            .unwrap();

        let error =
            restore_in(&backups, "codex", &name, &roots, copy_restore_contents).unwrap_err();
        assert!(error.contains("无法保存 Codex 会话恢复记录"), "{error}");
        drop(locked);
        assert_eq!(std::fs::read(&protection).unwrap(), before);
        assert!(!source.exists());
        assert_eq!(codex::list_pending_deletes(&roots).sessions.len(), 1);
        assert_eq!(
            restore_in(&backups, "codex", &name, &roots, copy_restore_contents)
                .unwrap()
                .restored_files,
            1
        );
    }

    #[test]
    fn interrupted_staging_leaves_the_original_path_and_cleanup_retry_intact() {
        use crate::session_manager::providers::codex;

        let temp = tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let session_id = "11111111-1111-4111-8111-111111111111";
        let (root, source, backups, name) = pending_codex_backup(&home, session_id);
        codex::record_restore_for_test(&home, &["previously-restored"]);
        let ledger = codex::restore_protection_path(&home);
        let previous = std::fs::read(&ledger).unwrap();
        let roots = [root];
        for interrupted in [true, false] {
            let error = restore_in(&backups, "codex", &name, &roots, |file, staged| {
                let copying: Value = serde_json::from_slice(&std::fs::read(&ledger)?).unwrap();
                assert!(copying["pending"].is_null());
                assert_eq!(copying["stages_to_remove"].as_array().unwrap().len(), 1);
                staged.write_all(b"partial rollout")?;
                assert!(!file.original.exists());
                if interrupted {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "fixture failure",
                    ));
                }
                Ok(()) // The staged checksum still prevents publication.
            })
            .unwrap_err();
            assert!(
                error.contains(if interrupted {
                    "fixture failure"
                } else {
                    "校验失败"
                }),
                "{error}"
            );
            assert!(!source.exists());
            assert_eq!(std::fs::read_dir(&roots[0]).unwrap().count(), 0);
            assert_eq!(std::fs::read(&ledger).unwrap(), previous);
            assert_eq!(codex::list_pending_deletes(&roots).sessions.len(), 1);
        }
        let restored = restore_in(&backups, "codex", &name, &roots, copy_restore_contents).unwrap();
        assert_eq!(restored.restored_files, 1);
        assert!(source.is_file());
    }

    #[test]
    fn partial_codex_restore_cancels_both_missing_rollout_delete_paths() {
        use crate::session_manager::providers::codex;
        use rusqlite::Connection;

        let temp = tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let sessions = home.join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        std::fs::write(
            home.join("config.toml"),
            format!("sqlite_home = '{}'\n", home.display()),
        )
        .unwrap();
        let parent_id = "11111111-1111-4111-8111-111111111111";
        let child_id = "22222222-2222-4222-8222-222222222222";
        let parent = sessions.join(format!("rollout-2026-01-01T00-00-01-{parent_id}.jsonl"));
        let child = sessions.join(format!("rollout-2026-01-01T00-00-00-{child_id}.jsonl"));
        for (path, id) in [(&parent, parent_id), (&child, child_id)] {
            std::fs::write(
                path,
                format!(
                    "{}\n",
                    json!({"type": "session_meta", "payload": {"id": id}})
                ),
            )
            .unwrap();
        }
        let conn =
            Connection::open(home.join(crate::codex_state_db::CODEX_STATE_DB_FILENAME)).unwrap();
        conn.execute_batch(
            "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
             CREATE TABLE threads (id TEXT PRIMARY KEY);
             CREATE TRIGGER fail_parent_cleanup BEFORE DELETE ON threads
               BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO thread_spawn_edges VALUES (?1, ?2, 'running')",
            [parent_id, child_id],
        )
        .unwrap();
        conn.execute("INSERT INTO threads VALUES (?1)", [parent_id])
            .unwrap();
        let result = codex::delete_session(&sessions, &parent, parent_id).unwrap();
        assert!(result.source_deleted && result.cleanup_pending);
        assert_eq!(
            codex::list_pending_deletes(std::slice::from_ref(&sessions))
                .sessions
                .len(),
            1
        );
        assert!(!parent.exists() && !child.exists());

        let backups = home.join("session-delete-backups");
        let generation = generations(&backups).pop().unwrap();
        // Use a valid backup with the child first, then simulate a failure
        // writing the parent after the child reached disk.
        let mut manifest = generation.manifest;
        manifest["rollouts"]
            .as_array_mut()
            .unwrap()
            .sort_by_key(|entry| entry["originalPath"].as_str() == parent.to_str());
        crate::config::atomic_write(
            &generation.dir.join(BACKUP_MANIFEST),
            &serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let error = restore_in(
            &backups,
            "codex",
            &generation.name,
            std::slice::from_ref(&sessions),
            |file, staged| {
                if file.original == parent {
                    let ledger = std::fs::read(codex::restore_protection_path(&home))?;
                    let copying: Value = serde_json::from_slice(&ledger).unwrap();
                    assert!(copying["pending"].is_null());
                    assert_eq!(copying["stages_to_remove"].as_array().unwrap().len(), 1);
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "blocked parent write",
                    ));
                }
                copy_restore_contents(file, staged)
            },
        )
        .unwrap_err();
        assert!(error.contains("blocked parent write"), "{error}");
        assert!(child.is_file() && !parent.exists());
        assert!(codex::list_pending_deletes(std::slice::from_ref(&sessions))
            .sessions
            .is_empty());

        conn.execute_batch("DROP TRIGGER fail_parent_cleanup")
            .unwrap();
        for retry in [codex::cleanup_deleted_session, codex::delete_session] {
            let result = retry(&sessions, &parent, parent_id).unwrap();
            assert!(result.cleanup_cancelled && !result.cleanup_pending);
            assert!(result.error.unwrap().contains("清理已因恢复操作取消"));
            assert!(child.is_file());
        }

        let restored = restore_in(
            &backups,
            "codex",
            &generation.name,
            std::slice::from_ref(&sessions),
            copy_restore_contents,
        )
        .unwrap();
        assert_eq!((restored.restored_files, restored.skipped_existing), (1, 1));
        let result = codex::delete_session(&sessions, &parent, parent_id).unwrap();
        assert!(
            result.source_deleted && !result.cleanup_pending,
            "{:?}",
            result.error
        );
        assert!(!parent.exists() && !child.exists());
    }

    #[test]
    fn restore_refuses_paths_outside_the_session_roots_and_tampered_copies() {
        let temp = tempdir().unwrap();
        let (sessions, main, _) = session_tree(temp.path());
        let root = temp.path().join("backups");
        let dir = backup_session_files(&root, "claude", "s1", None, std::slice::from_ref(&main))
            .unwrap()
            .unwrap();
        let name = dir.file_name().unwrap().to_str().unwrap().to_string();
        std::fs::remove_file(&main).unwrap();

        let other_root = temp.path().join("elsewhere");
        std::fs::create_dir_all(&other_root).unwrap();
        let error =
            restore_in(&root, "claude", &name, &[other_root], copy_restore_contents).unwrap_err();
        assert!(error.contains("不在会话目录内"), "{error}");
        assert!(!main.exists());

        let copy = std::fs::read_dir(dir.join(BACKUP_FILES_DIR))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::write(&copy, b"tampered").unwrap();
        let error =
            restore_in(&root, "claude", &name, &[sessions], copy_restore_contents).unwrap_err();
        assert!(error.contains("校验失败"), "{error}");
        assert!(!main.exists());

        for bad in ["../x", "a/b", "", ".."] {
            assert!(
                restore_in(&root, "claude", bad, &[], copy_restore_contents).is_err(),
                "{bad}"
            );
        }
        assert!(parse_backup_id("opencode/x").is_err());
        assert!(parse_backup_id("claude/../x").is_err());
        assert_eq!(
            parse_backup_id("codex/20261001_x").unwrap(),
            ("codex", "20261001_x")
        );
    }

    #[test]
    fn codex_manifests_list_their_rollouts_and_thread_ids() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("codex-backups");
        let generation = root.join("20261002_000000_x");
        std::fs::create_dir_all(generation.join("rollouts")).unwrap();
        std::fs::write(generation.join("rollouts").join("0-r.jsonl"), b"rollout").unwrap();
        write_manifest(
            &generation,
            &json!({
                "version": 1,
                "createdAt": "2026-10-02T00:00:00+08:00",
                "threadIds": ["t1", "t2"],
                "stateDbBackups": [],
                "rollouts": [{
                    "originalPath": temp.path().join("sessions").join("r.jsonl").to_string_lossy(),
                    "backupFile": "rollouts/0-r.jsonl",
                    "size": 7,
                    "sha256": format!("{:x}", Sha256::digest(b"rollout")),
                }],
            }),
        )
        .unwrap();
        // An older generation of another tool sorts after it.
        let claude_root = temp.path().join("claude-backups");
        let older = claude_root.join("20261001_000000_y");
        write_manifest(&older, &json!({"files": [], "sessionIds": ["c1"]})).unwrap();
        // A generation without a manifest is incomplete and not listed.
        std::fs::create_dir_all(root.join("20261003_000000_z")).unwrap();

        let listed = list_in_roots(&[("codex", root), ("claude", claude_root)]);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].provider_id, "codex");
        assert_eq!(listed[0].session_ids, vec!["t1", "t2"]);
        assert_eq!(listed[0].restorable_files, 1);
        assert_eq!(listed[1].provider_id, "claude");
    }

    #[test]
    fn clear_removes_only_confirmed_generations() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("backups");
        let shown = root.join("20261001_a");
        write_manifest(&shown, &json!({"files": []})).unwrap();
        std::fs::write(shown.join("payload"), b"12345").unwrap();
        let expected_size = directory_size(&shown);
        let mut confirmed: Vec<String> = list_in_roots(&[("codex", root.clone())])
            .into_iter()
            .map(|backup| backup.id)
            .collect();
        confirmed.push("codex/pruned_since_confirmation".into());
        let newer = root.join("20261002_b");
        write_manifest(&newer, &json!({"files": []})).unwrap();
        let incomplete = root.join("incomplete");
        std::fs::create_dir(&incomplete).unwrap();
        let stray = root.join("notes.txt");
        std::fs::write(&stray, b"keep").unwrap();

        let mut malformed = confirmed.clone();
        malformed.push("codex/../other".into());
        assert!(clear_confirmed_backups(
            &malformed,
            |_| root.clone(),
            |path| std::fs::remove_dir_all(path)
        )
        .is_err());
        assert!(shown.exists());

        let cleared = clear_confirmed_backups(
            &confirmed,
            |_| root.clone(),
            |path| std::fs::remove_dir_all(path),
        )
        .unwrap();
        assert_eq!(cleared.removed_backups, 1);
        assert_eq!(cleared.freed_bytes, expected_size);
        assert!(!shown.exists());
        assert!(newer.exists() && incomplete.exists() && stray.exists());
    }

    #[test]
    fn interrupted_clear_remains_listed_without_a_manifest_and_only_retries_that_backup() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("backups");
        let name = "20261001_000000_a";
        let shown = root.join(name);
        write_manifest(&shown, &json!({"files": []})).unwrap();
        std::fs::write(shown.join("payload"), b"12345").unwrap();
        let roots = [("claude", root.clone())];
        let id = format!("claude/{name}");
        let error = clear_confirmed_backups(
            &[id],
            |_| root.clone(),
            |path| {
                std::fs::remove_file(path.join(BACKUP_MANIFEST))?;
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "locked payload",
                ))
            },
        )
        .unwrap_err();
        assert!(error.contains("locked payload"));
        assert!(!shown.exists());
        let pending = list_in_roots(&roots).pop().unwrap();
        assert!(pending.pending_clear);
        assert_eq!(pending.total_bytes, 5);
        assert_eq!(pending.restorable_files, 0);
        let (_, pending_name) = parse_backup_id(&pending.id).unwrap();
        assert!(open_generation(&root, pending_name).is_err());
        // A separately created generation is still restorable and is not part of
        // this explicit retry, even if it happens to reuse the original name.
        write_manifest(&shown, &json!({"files": []})).unwrap();
        let cleared = clear_confirmed_backups(
            &[pending.id],
            |_| root.clone(),
            |path| std::fs::remove_dir_all(path),
        )
        .unwrap();
        assert_eq!((cleared.removed_backups, cleared.freed_bytes), (1, 5));
        assert_eq!(list_in_roots(&roots).len(), 1);
        assert!(shown.exists());
    }
}
