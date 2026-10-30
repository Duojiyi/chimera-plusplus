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
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::security_limits::{
    is_link_or_reparse_point, open_regular_file_no_symlink, read_limited, MAX_CONFIG_FILE_BYTES,
};

pub(crate) const BACKUP_MANIFEST: &str = "manifest.json";
/// Where the non-Codex tools keep the copied files inside a generation.
const BACKUP_FILES_DIR: &str = "files";

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
    );
}

fn prune_session_delete_backups_older_than(
    root: &Path,
    current: &Path,
    keep: usize,
    min_age: Duration,
) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut generations: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .filter(|path| path != current)
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
        if let Err(error) = std::fs::remove_dir_all(&old) {
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

/// Copy `source` to a new file `target` (never replacing one), returning the
/// size and SHA-256 of what was written.
fn copy_file_hashed(source: &Path, target: &Path) -> io::Result<(u64, String)> {
    let mut input = open_regular_file_no_symlink(source)?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size: u64 = 0;
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
        size += read as u64;
    }
    output.sync_all()?;
    Ok((size, format!("{:x}", hasher.finalize())))
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
                    .filter(|file| !path_is_taken(&file.original))
                    .count(),
            });
        }
    }
    // Generation names start with the local timestamp, across tools too.
    summaries.sort_by(|a, b| generation_name(&b.id).cmp(generation_name(&a.id)));
    summaries
}

fn generation_name(id: &str) -> &str {
    id.split_once('/').map_or(id, |(_, name)| name)
}

/// Restore the files of one delete backup to where they were. A file whose
/// path is taken again is left alone, never overwritten. Codex backups
/// restore the rollouts only: Codex lists threads from the rollout files and
/// re-seeds missing state DB rows itself.
pub fn restore_session_delete_backup(id: &str) -> Result<SessionDeleteRestoreOutcome, String> {
    let (tool, name) = parse_backup_id(id)?;
    let allowed_roots = super::provider_roots(tool)?;
    restore_in(&backup_root(tool), tool, name, &allowed_roots)
}

fn restore_in(
    root: &Path,
    tool: &str,
    name: &str,
    allowed_roots: &[PathBuf],
) -> Result<SessionDeleteRestoreOutcome, String> {
    let generation = open_generation(root, name)?;
    let files = manifest_files(&generation)?;
    if files.is_empty() {
        return Err("这份备份里没有可恢复的会话文件".to_string());
    }
    // Check everything before writing anything.
    for file in &files {
        if !is_within_any_root(&file.original, allowed_roots) {
            return Err(format!(
                "备份记录的原位置不在会话目录内，已拒绝恢复：{}",
                file.original.display()
            ));
        }
        let (size, sha256) = hash_file(&file.backup)
            .map_err(|error| format!("无法读取备份文件 {}：{error}", file.backup.display()))?;
        if !file.matches(size, &sha256) {
            return Err(format!(
                "备份文件校验失败，已停止恢复：{}",
                file.backup.display()
            ));
        }
    }

    let mut restored_files = 0;
    let mut skipped_existing = 0;
    for file in &files {
        if path_is_taken(&file.original) {
            skipped_existing += 1;
            continue;
        }
        if let Some(parent) = file.original.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建目录 {}：{error}", parent.display()))?;
        }
        // Re-check after creating the parents: a link must not redirect the write.
        if !is_within_any_root(&file.original, allowed_roots) {
            return Err(format!(
                "恢复路径包含链接，已拒绝：{}",
                file.original.display()
            ));
        }
        match copy_file_hashed(&file.backup, &file.original) {
            Ok((size, sha256)) if file.matches(size, &sha256) => restored_files += 1,
            Ok(_) => {
                let _ = std::fs::remove_file(&file.original);
                return Err(format!("恢复后的文件校验失败：{}", file.original.display()));
            }
            // Created by someone else between the check and the copy.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => skipped_existing += 1,
            Err(error) => return Err(format!("无法恢复 {}：{error}", file.original.display())),
        }
    }
    Ok(SessionDeleteRestoreOutcome {
        provider_id: tool.to_string(),
        restored_files,
        skipped_existing,
    })
}

/// Remove every tool's delete backups.
pub fn clear_session_delete_backups() -> Result<SessionDeleteBackupsCleared, String> {
    let roots: Vec<PathBuf> = BACKED_UP_TOOLS.iter().copied().map(backup_root).collect();
    clear_in_roots(&roots)
}

fn clear_in_roots(roots: &[PathBuf]) -> Result<SessionDeleteBackupsCleared, String> {
    let mut cleared = SessionDeleteBackupsCleared {
        removed_backups: 0,
        freed_bytes: 0,
    };
    let mut errors = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            // Only generation directories; links and stray files stay.
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let path = entry.path();
            let bytes = directory_size(&path);
            match std::fs::remove_dir_all(&path) {
                Ok(()) => {
                    cleared.removed_backups += 1;
                    cleared.freed_bytes = cleared.freed_bytes.saturating_add(bytes);
                }
                Err(error) => errors.push(format!("{}: {error}", path.display())),
            }
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

fn directory_size(dir: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut pending = vec![dir.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                total = total.saturating_add(entry.metadata().map_or(0, |meta| meta.len()));
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
    if !is_single_component(name) {
        return Err(invalid());
    }
    Ok((tool, name))
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
    if !is_single_component(name) {
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
fn path_is_taken(path: &Path) -> bool {
    !matches!(std::fs::symlink_metadata(path), Err(error) if error.kind() == io::ErrorKind::NotFound)
}

/// `path` is a strict descendant of one of `roots` (as given or
/// canonicalized), without `..`, and none of its existing ancestors below the
/// root is a link.
fn is_within_any_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| {
        let canonical = root.canonicalize().ok();
        [Some(root.clone()), canonical]
            .into_iter()
            .flatten()
            .any(|base| is_within_root(path, &base))
    })
}

fn is_within_root(path: &Path, root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
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
        prune_session_delete_backups_older_than(root, &current, 1, SESSION_DELETE_BACKUP_MIN_AGE);
        assert!(root.join("20261001_000000_a").exists());

        prune_session_delete_backups_older_than(root, &current, 1, Duration::ZERO);

        assert!(!root.join("20261001_000000_a").exists());
        assert!(!root.join("20261002_000000_b").exists());
        assert!(root.join("20261003_000000_c").exists());
        assert!(current.exists());
        assert!(root.join("notes.txt").exists());
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

        let outcome = restore_in(&root, "claude", &name, &[sessions]).unwrap();
        assert_eq!(outcome.restored_files, 1);
        assert_eq!(outcome.skipped_existing, 1);
        assert_eq!(std::fs::read(&main).unwrap(), b"newer", "never overwritten");
        assert_eq!(std::fs::read(&sidecar).unwrap(), b"sidecar");
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
        let error = restore_in(&root, "claude", &name, &[other_root]).unwrap_err();
        assert!(error.contains("不在会话目录内"), "{error}");
        assert!(!main.exists());

        let copy = std::fs::read_dir(dir.join(BACKUP_FILES_DIR))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::write(&copy, b"tampered").unwrap();
        let error = restore_in(&root, "claude", &name, &[sessions]).unwrap_err();
        assert!(error.contains("校验失败"), "{error}");
        assert!(!main.exists());

        for bad in ["../x", "a/b", "", ".."] {
            assert!(restore_in(&root, "claude", bad, &[]).is_err(), "{bad}");
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
    fn clear_removes_generations_but_not_stray_files() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("backups");
        std::fs::create_dir_all(root.join("20261001_a").join("files")).unwrap();
        std::fs::write(root.join("20261001_a").join("files").join("0-x"), b"12345").unwrap();
        std::fs::create_dir_all(root.join("20261002_b")).unwrap();
        std::fs::write(root.join("notes.txt"), b"keep").unwrap();

        let cleared = clear_in_roots(&[root.clone(), temp.path().join("missing")]).unwrap();
        assert_eq!(cleared.removed_backups, 2);
        assert_eq!(cleared.freed_bytes, 5);
        assert!(root.join("notes.txt").exists());
        assert!(!root.join("20261001_a").exists());
    }
}
