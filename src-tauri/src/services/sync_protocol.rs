//! Transport-agnostic sync protocol layer.
//!
//! Shared by WebDAV, S3, and future transports. Artifact set: `db.sql` + `skills.zip`.

use std::collections::BTreeMap;
use std::fs;
use std::process::Command;
use std::sync::{Mutex as StdMutex, OnceLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

use crate::error::AppError;

// Re-export archive functions for use by transport layers.
pub(crate) use super::webdav_sync::archive::{
    backup_current_skills, restore_skills_from_backup, restore_skills_zip, zip_skills_ssot,
};

// ─── Protocol constants ──────────────────────────────────────

/// Wire-format identifier stored in remote manifests.
/// Retains historic "webdav" naming for backward compatibility with existing remotes.
pub(crate) const PROTOCOL_FORMAT: &str = "cc-switch-webdav-sync";
// Keep the established v2 directory: readers discover old and new manifests there.
pub(crate) const PROTOCOL_VERSION: u32 = 2;
// v3 requires an immutable generation. v2 readers must fail closed, not read stale fixed files.
pub(crate) const MANIFEST_VERSION: u32 = 3;
pub(crate) const DB_COMPAT_VERSION: u32 = 6;
pub(crate) const LEGACY_DB_COMPAT_VERSION: u32 = 5;
pub(crate) const REMOTE_DB_SQL: &str = "db.sql";
pub(crate) const REMOTE_SKILLS_ZIP: &str = "skills.zip";
pub(crate) const REMOTE_MANIFEST: &str = "manifest.json";
pub(crate) const MAX_DEVICE_NAME_LEN: usize = 64;
pub(crate) const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_SYNC_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

// ─── Error helpers ───────────────────────────────────────────

pub(crate) fn localized(
    key: &'static str,
    zh: impl Into<String>,
    en: impl Into<String>,
) -> AppError {
    AppError::localized(key, zh, en)
}

pub(crate) fn io_context_localized(
    _key: &'static str,
    zh: impl Into<String>,
    en: impl Into<String>,
    source: std::io::Error,
) -> AppError {
    let zh_msg = zh.into();
    let en_msg = en.into();
    AppError::IoContext {
        context: format!("{zh_msg} ({en_msg})"),
        source,
    }
}

// ─── Types ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncManifest {
    pub format: String,
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_compat_version: Option<u32>,
    pub device_name: String,
    pub created_at: String,
    pub artifacts: BTreeMap<String, ArtifactMeta>,
    pub snapshot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ArtifactMeta {
    pub sha256: String,
    pub size: u64,
}

pub(crate) struct LocalSnapshot {
    pub manifest: SyncManifest,
    pub db_sql: Vec<u8>,
    pub skills_zip: Vec<u8>,
    pub manifest_bytes: Vec<u8>,
    pub manifest_hash: String,
}

impl LocalSnapshot {
    pub(crate) fn artifact_paths(&self) -> Result<(String, String), AppError> {
        if self.manifest.version != MANIFEST_VERSION {
            return Err(localized(
                "sync.mutable_snapshot_upload_rejected",
                "不能发布旧的可变快照布局",
                "Cannot publish the legacy mutable snapshot layout.",
            ));
        }
        validate_manifest_compat(&self.manifest, RemoteLayout::Current)?;
        Ok((
            artifact_relative_path(&self.manifest, REMOTE_DB_SQL)?,
            artifact_relative_path(&self.manifest, REMOTE_SKILLS_ZIP)?,
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteLayout {
    Current,
    Legacy,
}

impl RemoteLayout {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Legacy => "legacy",
        }
    }
}

// ─── Snapshot building ───────────────────────────────────────

pub(crate) fn build_local_snapshot(
    db: &crate::database::Database,
) -> Result<LocalSnapshot, AppError> {
    // Readers and restorers share the same local snapshot boundary.
    let _lock = snapshot_apply_mutex()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Export database to SQL string
    let sql_string = db.export_sql_string_for_sync()?;
    let db_sql = sql_string.into_bytes();

    // Pack skills into deterministic ZIP
    let tmp = tempdir().map_err(|e| {
        io_context_localized(
            "sync.snapshot_tmpdir_failed",
            "创建快照临时目录失败",
            "Failed to create temporary directory for snapshot",
            e,
        )
    })?;
    let skills_zip_path = tmp.path().join(REMOTE_SKILLS_ZIP);
    zip_skills_ssot(&skills_zip_path)?;
    let skills_zip = fs::read(&skills_zip_path).map_err(|e| AppError::io(&skills_zip_path, e))?;

    snapshot_from_artifacts(
        db_sql,
        skills_zip,
        detect_system_device_name().unwrap_or_else(|| "Unknown Device".to_string()),
    )
}

fn snapshot_from_artifacts(
    db_sql: Vec<u8>,
    skills_zip: Vec<u8>,
    device_name: String,
) -> Result<LocalSnapshot, AppError> {
    validate_artifact_size_limit(REMOTE_DB_SQL, db_sql.len() as u64)?;
    validate_artifact_size_limit(REMOTE_SKILLS_ZIP, skills_zip.len() as u64)?;
    // Never reuse a generation, even for identical content: a failed PUT on a
    // server without conditional writes must not truncate a published artifact.
    let generation = uuid::Uuid::new_v4().simple().to_string();
    // Build artifact map and compute hashes
    let mut artifacts = BTreeMap::new();
    artifacts.insert(
        REMOTE_DB_SQL.to_string(),
        ArtifactMeta {
            sha256: sha256_hex(&db_sql),
            size: db_sql.len() as u64,
        },
    );
    artifacts.insert(
        REMOTE_SKILLS_ZIP.to_string(),
        ArtifactMeta {
            sha256: sha256_hex(&skills_zip),
            size: skills_zip.len() as u64,
        },
    );

    let snapshot_id = compute_snapshot_id(&artifacts);
    let manifest = SyncManifest {
        format: PROTOCOL_FORMAT.to_string(),
        version: MANIFEST_VERSION,
        db_compat_version: Some(DB_COMPAT_VERSION),
        device_name,
        created_at: Utc::now().to_rfc3339(),
        artifacts,
        snapshot_id,
        generation: Some(generation),
    };
    let manifest_bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|e| AppError::JsonSerialize { source: e })?;
    let manifest_hash = sha256_hex(&manifest_bytes);

    Ok(LocalSnapshot {
        manifest,
        db_sql,
        skills_zip,
        manifest_bytes,
        manifest_hash,
    })
}

// ─── Manifest handling ───────────────────────────────────────

/// Compute a deterministic snapshot identity from artifact hashes.
///
/// BTreeMap iteration order is sorted by key, ensuring stability.
pub(crate) fn compute_snapshot_id(artifacts: &BTreeMap<String, ArtifactMeta>) -> String {
    let parts: Vec<String> = artifacts
        .iter()
        .map(|(name, meta)| format!("{}:{}", name, meta.sha256))
        .collect();
    sha256_hex(parts.join("|").as_bytes())
}

pub(crate) fn effective_db_compat_version(
    manifest: &SyncManifest,
    layout: RemoteLayout,
) -> Option<u32> {
    manifest
        .db_compat_version
        .or_else(|| (layout == RemoteLayout::Legacy).then_some(LEGACY_DB_COMPAT_VERSION))
}

pub(crate) fn validate_manifest_compat(
    manifest: &SyncManifest,
    layout: RemoteLayout,
) -> Result<(), AppError> {
    if manifest.format != PROTOCOL_FORMAT {
        return Err(localized(
            "sync.manifest_format_incompatible",
            format!("远端 manifest 格式不兼容: {}", manifest.format),
            format!(
                "Remote manifest format is incompatible: {}",
                manifest.format
            ),
        ));
    }
    if !matches!(manifest.version, PROTOCOL_VERSION | MANIFEST_VERSION) {
        return Err(localized(
            "sync.manifest_version_incompatible",
            format!(
                "远端 manifest 协议版本不兼容: v{} (本地支持 v{PROTOCOL_VERSION}/v{MANIFEST_VERSION})",
                manifest.version
            ),
            format!(
                "Remote manifest protocol version is incompatible: v{} (local supports v{PROTOCOL_VERSION}/v{MANIFEST_VERSION})",
                manifest.version
            ),
        ));
    }
    // Validate the only remotely supplied path component before any artifact request.
    artifact_relative_path(manifest, REMOTE_DB_SQL)?;
    artifact_relative_path(manifest, REMOTE_SKILLS_ZIP)?;
    if manifest.version == MANIFEST_VERSION {
        if manifest.artifacts.len() != 2
            || ![REMOTE_DB_SQL, REMOTE_SKILLS_ZIP].iter().all(|name| {
                manifest.artifacts.get(*name).is_some_and(|meta| {
                    meta.sha256.len() == 64
                        && meta
                            .sha256
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
            })
            || compute_snapshot_id(&manifest.artifacts) != manifest.snapshot_id
        {
            return Err(localized(
                "sync.manifest_artifacts_invalid",
                "远端 manifest 的快照摘要或文件集合无效",
                "Remote manifest has an invalid snapshot digest or artifact set.",
            ));
        }
        for (name, meta) in &manifest.artifacts {
            validate_artifact_size_limit(name, meta.size)?;
        }
    }
    let Some(db_compat_version) = effective_db_compat_version(manifest, layout) else {
        return Err(localized(
            "sync.manifest_db_version_missing",
            "远端 manifest 缺少数据库兼容版本",
            "Remote manifest is missing the database compatibility version.",
        ));
    };
    match layout {
        RemoteLayout::Current if db_compat_version != DB_COMPAT_VERSION => {
            return Err(localized(
                "sync.manifest_db_version_incompatible",
                format!(
                    "远端数据库快照版本不兼容: db-v{db_compat_version} (本地 db-v{DB_COMPAT_VERSION})"
                ),
                format!(
                    "Remote database snapshot version is incompatible: db-v{db_compat_version} (local db-v{DB_COMPAT_VERSION})"
                ),
            ));
        }
        RemoteLayout::Legacy if db_compat_version > DB_COMPAT_VERSION => {
            return Err(localized(
                "sync.manifest_db_version_incompatible",
                format!(
                    "远端数据库快照版本不兼容: db-v{db_compat_version} (本地最高支持 db-v{DB_COMPAT_VERSION})"
                ),
                format!(
                    "Remote database snapshot version is incompatible: db-v{db_compat_version} (local supports up to db-v{DB_COMPAT_VERSION})"
                ),
            ));
        }
        _ => {}
    }
    Ok(())
}

// ─── Optimistic concurrency (upload conflict detection) ───────

/// Localized error key shared by every transport's "remote changed"
/// detection — both the client-side ETag comparison done before an upload
/// starts, and (where the transport supports it) a server-side conditional
/// write rejected during the upload itself — so callers can recognise this
/// specific condition uniformly regardless of which backend is in use.
pub(crate) const REMOTE_CHANGED_ERROR_KEY: &str = "sync.remote_changed";

/// Only these two basenames and a lowercase UUID generation may reach a transport.
/// No remote absolute URLs, separators, percent escapes, queries or dot segments.
pub(crate) fn artifact_relative_path(
    manifest: &SyncManifest,
    artifact_name: &str,
) -> Result<String, AppError> {
    if matches!(artifact_name, REMOTE_DB_SQL | REMOTE_SKILLS_ZIP) {
        match (manifest.version, manifest.generation.as_deref()) {
            (PROTOCOL_VERSION, None) => return Ok(artifact_name.to_string()),
            (MANIFEST_VERSION, Some(generation))
                if generation.len() == 32
                    && generation
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
            {
                return Ok(format!("snapshots/{generation}/{artifact_name}"));
            }
            _ => {}
        }
    }
    Err(localized(
        "sync.manifest_artifact_path_invalid",
        "远端 manifest 的快照路径或协议版本无效",
        "Remote manifest has an invalid snapshot path or protocol version.",
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WriteCondition {
    Unconditional,
    IfMatch(String),
    IfNoneMatch,
}

impl WriteCondition {
    pub(crate) fn header(&self) -> Option<(&'static str, &str)> {
        match self {
            Self::Unconditional => None,
            Self::IfMatch(etag) => Some(("if-match", etag)),
            Self::IfNoneMatch => Some(("if-none-match", "*")),
        }
    }
}

/// GET, not HEAD: distinguish a missing manifest from one without a validator,
/// and reject unknown protocols even during force upload. A saved body hash also
/// detects changes on WebDAV servers that omit ETags.
pub(crate) fn manifest_write_condition(
    remote: Option<&(Vec<u8>, Option<String>)>,
    known_etag: Option<&str>,
    known_hash: Option<&str>,
    options: UploadOptions,
) -> Result<WriteCondition, AppError> {
    let Some((bytes, etag)) = remote else {
        return Ok(WriteCondition::IfNoneMatch);
    };
    let manifest: SyncManifest =
        serde_json::from_slice(bytes).map_err(|source| AppError::Json {
            path: REMOTE_MANIFEST.to_string(),
            source,
        })?;
    validate_manifest_compat(&manifest, RemoteLayout::Current)?;
    if options.force {
        log::warn!("[Sync] Force upload replaces the manifest pointer, not existing artifacts");
        return Ok(WriteCondition::Unconditional);
    }
    let unchanged = match known_hash {
        Some(hash) => sha256_hex(bytes) == hash,
        None => known_etag.is_some() && etag.as_deref() == known_etag,
    };
    if !unchanged {
        return Err(remote_changed_conflict_error());
    }
    match etag.as_deref().filter(|etag| {
        etag.len() >= 2
            && etag.starts_with('"')
            && etag.ends_with('"')
            && etag.as_bytes()[1..etag.len() - 1]
                .iter()
                .all(|&b| b == 0x21 || (0x23..=0x7e).contains(&b) || b >= 0x80)
    }) {
        Some(etag) => Ok(WriteCondition::IfMatch(etag.to_string())),
        None => {
            // WebDAV without a strong ETag has no cross-device CAS. Last writer
            // wins, but each pointer still references its own complete generation.
            log::warn!("[Sync] No strong ETag: manifest publication cannot prevent concurrent lost updates");
            Ok(WriteCondition::Unconditional)
        }
    }
}

/// Error returned when an upload is aborted (or a conditional write is
/// rejected by the server) because the remote manifest changed since our
/// last successful sync. See [`manifest_write_condition`].
pub(crate) fn remote_changed_conflict_error() -> AppError {
    localized(
        REMOTE_CHANGED_ERROR_KEY,
        "远端数据自上次同步后已被其他设备修改，为避免覆盖对方的更改，本次上传已取消。请先下载合并后再重试；若确认本机数据是正确的，可使用「强制上传」重写远端。",
        "Remote data has changed since your last sync, likely from another device. Upload was cancelled to avoid overwriting those changes — download and merge before retrying, or use force upload if this device's data is the one to keep.",
    )
}

/// How an upload treats the remote snapshot's version check.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UploadOptions {
    /// Replace the manifest pointer despite a known remote change. Artifacts are
    /// always new, create-only objects; force never overwrites an old generation.
    pub force: bool,
}

pub(crate) const REMOTE_SNAPSHOT_TORN_ERROR_KEY: &str = "sync.remote_snapshot_torn";

/// A downloaded artifact does not match the manifest that lists it.
pub(crate) fn torn_snapshot_error(artifact_name: &str, cause: &AppError) -> AppError {
    localized(
        REMOTE_SNAPSHOT_TORN_ERROR_KEY,
        format!(
            "远端快照不完整：{artifact_name} 与 manifest 不一致（{cause}）。通常是另一台设备的上传被中断，或两台设备几乎同时上传。请在数据正确的那台设备上执行「强制上传」重写远端，然后再在本机下载。"
        ),
        format!(
            "The remote snapshot is inconsistent: {artifact_name} does not match its manifest ({cause}). This usually means another device's upload was interrupted, or two devices uploaded at the same time. Run a force upload from the device whose data is correct, then download here."
        ),
    )
}

// ─── Artifact verification ───────────────────────────────────

pub(crate) fn validate_artifact_size_limit(artifact_name: &str, size: u64) -> Result<(), AppError> {
    if size > MAX_SYNC_ARTIFACT_BYTES {
        let max_mb = MAX_SYNC_ARTIFACT_BYTES / 1024 / 1024;
        return Err(localized(
            "sync.artifact_too_large",
            format!("artifact {artifact_name} 超过下载上限（{} MB）", max_mb),
            format!(
                "Artifact {artifact_name} exceeds download limit ({} MB)",
                max_mb
            ),
        ));
    }
    Ok(())
}

/// Verify that downloaded artifact bytes match the expected size and SHA-256 hash.
pub(crate) fn verify_artifact(
    bytes: &[u8],
    artifact_name: &str,
    meta: &ArtifactMeta,
) -> Result<(), AppError> {
    // Quick size check before expensive hash
    if bytes.len() as u64 != meta.size {
        return Err(localized(
            "sync.artifact_size_mismatch",
            format!(
                "artifact {artifact_name} 大小不匹配 (expected: {}, got: {})",
                meta.size,
                bytes.len(),
            ),
            format!(
                "Artifact {artifact_name} size mismatch (expected: {}, got: {})",
                meta.size,
                bytes.len(),
            ),
        ));
    }

    let actual_hash = sha256_hex(bytes);
    if actual_hash != meta.sha256 {
        return Err(localized(
            "sync.artifact_hash_mismatch",
            format!(
                "artifact {artifact_name} SHA256 校验失败 (expected: {}..., got: {}...)",
                meta.sha256.get(..8).unwrap_or(&meta.sha256),
                actual_hash.get(..8).unwrap_or(&actual_hash),
            ),
            format!(
                "Artifact {artifact_name} SHA256 verification failed (expected: {}..., got: {}...)",
                meta.sha256.get(..8).unwrap_or(&meta.sha256),
                actual_hash.get(..8).unwrap_or(&actual_hash),
            ),
        ));
    }
    Ok(())
}

// ─── Snapshot application ────────────────────────────────────

static SNAPSHOT_APPLY_MUTEX: OnceLock<StdMutex<()>> = OnceLock::new();

pub(crate) fn snapshot_apply_mutex() -> &'static StdMutex<()> {
    SNAPSHOT_APPLY_MUTEX.get_or_init(|| StdMutex::new(()))
}

pub(crate) async fn apply_snapshot(
    db: &crate::database::Database,
    db_sql: &[u8],
    skills_zip: &[u8],
) -> Result<(), AppError> {
    // Acquire before snapshot/DB locks. Importers commit usage and cursors in
    // separate steps; the local-only snapshot must not split those writes.
    let _session_guard = super::session_usage::session_sync_mutex().lock().await;
    // No await or detached worker below: cancellation cannot release either
    // guard while the synchronous skills/DB replacement is still running.
    let _lock = snapshot_apply_mutex()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let sql_str = std::str::from_utf8(db_sql).map_err(|e| {
        localized(
            "sync.sql_not_utf8",
            format!("SQL 非 UTF-8: {e}"),
            format!("SQL is not valid UTF-8: {e}"),
        )
    })?;
    let skills_backup = backup_current_skills()?;

    // Replace skills first, then import database; roll back skills on failure.
    if let Err(skills_err) = restore_skills_zip(skills_zip) {
        if let Err(rollback_err) = restore_skills_from_backup(skills_backup) {
            return Err(localized(
                "sync.skills_restore_and_rollback_failed",
                format!("恢复 Skills 失败: {skills_err}; 同时回滚 Skills 备份失败: {rollback_err}"),
                format!(
                    "Failed to restore skills: {skills_err}; skills backup rollback also failed: {rollback_err}"
                ),
            ));
        }
        return Err(skills_err);
    }

    if let Err(db_err) = db.import_sql_string_for_sync(sql_str) {
        if let Err(rollback_err) = restore_skills_from_backup(skills_backup) {
            return Err(localized(
                "sync.db_import_and_rollback_failed",
                format!("导入数据库失败: {db_err}; 同时回滚 Skills 失败: {rollback_err}"),
                format!(
                    "Database import failed: {db_err}; skills rollback also failed: {rollback_err}"
                ),
            ));
        }
        return Err(db_err);
    }

    Ok(())
}

// ─── Utilities ───────────────────────────────────────────────

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub(crate) fn detect_system_device_name() -> Option<String> {
    let env_name = ["CC_SWITCH_DEVICE_NAME", "COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .find_map(|value| normalize_device_name(&value));

    if env_name.is_some() {
        return env_name;
    }

    let output = Command::new("hostname").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let hostname = String::from_utf8(output.stdout).ok()?;
    normalize_device_name(&hostname)
}

pub(crate) fn normalize_device_name(raw: &str) -> Option<String> {
    let compact = raw
        .chars()
        .fold(String::with_capacity(raw.len()), |mut acc, ch| {
            if ch.is_whitespace() {
                acc.push(' ');
            } else if !ch.is_control() {
                acc.push(ch);
            }
            acc
        });
    let normalized = compact.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return None;
    }

    let limited = trimmed
        .chars()
        .take(MAX_DEVICE_NAME_LEN)
        .collect::<String>();
    if limited.is_empty() {
        None
    } else {
        Some(limited)
    }
}

// ─── Sync status persistence ─────────────────────────────────

pub(crate) fn persist_sync_success_best_effort<S, F>(
    settings: &mut S,
    manifest_hash: String,
    etag: Option<String>,
    persist_fn: F,
) -> bool
where
    F: FnOnce(&mut S, String, Option<String>) -> Result<(), AppError>,
{
    match persist_fn(settings, manifest_hash, etag) {
        Ok(()) => true,
        Err(err) => {
            log::warn!("[Sync] Persist sync status failed, keep operation success: {err}");
            false
        }
    }
}

// ─── Tests ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(sha256: &str, size: u64) -> ArtifactMeta {
        ArtifactMeta {
            sha256: sha256.to_string(),
            size,
        }
    }

    #[test]
    fn snapshot_id_is_stable() {
        let mut artifacts = BTreeMap::new();
        artifacts.insert("db.sql".to_string(), artifact("abc123", 100));
        artifacts.insert("skills.zip".to_string(), artifact("def456", 200));

        let id1 = compute_snapshot_id(&artifacts);
        let id2 = compute_snapshot_id(&artifacts);
        assert_eq!(id1, id2);
    }

    #[test]
    fn snapshot_id_changes_with_artifacts() {
        let mut a1 = BTreeMap::new();
        a1.insert("db.sql".to_string(), artifact("hash-a", 1));

        let mut a2 = BTreeMap::new();
        a2.insert("db.sql".to_string(), artifact("hash-b", 1));

        assert_ne!(compute_snapshot_id(&a1), compute_snapshot_id(&a2));
    }

    #[test]
    fn sha256_hex_is_correct() {
        let hash = sha256_hex(b"hello");
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn persist_best_effort_returns_true_on_success() {
        let mut dummy = ();
        let ok = persist_sync_success_best_effort(
            &mut dummy,
            "hash".to_string(),
            Some("etag".to_string()),
            |_settings, _hash, _etag| Ok(()),
        );
        assert!(ok);
    }

    #[test]
    fn persist_best_effort_returns_false_on_error() {
        let mut dummy = ();
        let ok = persist_sync_success_best_effort(
            &mut dummy,
            "hash".to_string(),
            None,
            |_settings, _hash, _etag| Err(AppError::Config("boom".to_string())),
        );
        assert!(!ok);
    }

    fn manifest_with(format: &str, version: u32, db_compat_version: Option<u32>) -> SyncManifest {
        let mut artifacts = BTreeMap::new();
        artifacts.insert("db.sql".to_string(), artifact("abc", 1));
        artifacts.insert("skills.zip".to_string(), artifact("def", 2));
        SyncManifest {
            format: format.to_string(),
            version,
            db_compat_version,
            device_name: "My MacBook".to_string(),
            created_at: "2026-02-12T00:00:00Z".to_string(),
            artifacts,
            snapshot_id: "snap-1".to_string(),
            generation: None,
        }
    }

    #[test]
    fn validate_manifest_compat_accepts_supported_manifest() {
        let manifest = manifest_with(PROTOCOL_FORMAT, PROTOCOL_VERSION, Some(DB_COMPAT_VERSION));
        assert!(validate_manifest_compat(&manifest, RemoteLayout::Current).is_ok());
    }

    #[test]
    fn validate_manifest_compat_rejects_wrong_format() {
        let manifest = manifest_with("other-format", PROTOCOL_VERSION, Some(DB_COMPAT_VERSION));
        assert!(validate_manifest_compat(&manifest, RemoteLayout::Current).is_err());
    }

    #[test]
    fn validate_manifest_compat_rejects_wrong_version() {
        let manifest = manifest_with(
            PROTOCOL_FORMAT,
            MANIFEST_VERSION + 1,
            Some(DB_COMPAT_VERSION),
        );
        assert!(validate_manifest_compat(&manifest, RemoteLayout::Current).is_err());
    }

    #[test]
    fn validate_manifest_compat_accepts_legacy_manifest_without_db_compat() {
        let manifest = manifest_with(PROTOCOL_FORMAT, PROTOCOL_VERSION, None);
        assert!(validate_manifest_compat(&manifest, RemoteLayout::Legacy).is_ok());
    }

    #[test]
    fn validate_manifest_compat_rejects_current_manifest_with_wrong_db_compat() {
        let manifest = manifest_with(
            PROTOCOL_FORMAT,
            PROTOCOL_VERSION,
            Some(LEGACY_DB_COMPAT_VERSION),
        );
        assert!(validate_manifest_compat(&manifest, RemoteLayout::Current).is_err());
    }

    #[test]
    fn validate_manifest_compat_rejects_legacy_manifest_from_newer_db_generation() {
        let manifest = manifest_with(
            PROTOCOL_FORMAT,
            PROTOCOL_VERSION,
            Some(DB_COMPAT_VERSION + 1),
        );
        assert!(validate_manifest_compat(&manifest, RemoteLayout::Legacy).is_err());
    }

    #[test]
    fn effective_db_compat_version_defaults_legacy_layout_to_v5() {
        let manifest = manifest_with(PROTOCOL_FORMAT, PROTOCOL_VERSION, None);
        assert_eq!(
            effective_db_compat_version(&manifest, RemoteLayout::Legacy),
            Some(LEGACY_DB_COMPAT_VERSION)
        );
        assert_eq!(
            effective_db_compat_version(&manifest, RemoteLayout::Current),
            None
        );
    }

    #[test]
    fn normalize_device_name_returns_none_for_blank_input() {
        assert_eq!(normalize_device_name("   \n\t  "), None);
    }

    #[test]
    fn normalize_device_name_collapses_whitespace_and_drops_control_chars() {
        assert_eq!(
            normalize_device_name("  Mac\tBook \n Pro\u{0007} "),
            Some("Mac Book Pro".to_string())
        );
    }

    #[test]
    fn normalize_device_name_truncates_to_max_len() {
        let long = "a".repeat(80);
        assert_eq!(normalize_device_name(&long).map(|s| s.len()), Some(64));
    }

    #[test]
    fn manifest_serialization_uses_device_name_only() {
        let manifest = manifest_with(PROTOCOL_FORMAT, PROTOCOL_VERSION, Some(DB_COMPAT_VERSION));
        let value = serde_json::to_value(&manifest).expect("serialize manifest");
        assert!(
            value.get("deviceName").is_some(),
            "manifest should contain deviceName"
        );
        assert_eq!(
            value.get("dbCompatVersion").and_then(|v| v.as_u64()),
            Some(DB_COMPAT_VERSION as u64)
        );
        assert!(
            value.get("deviceId").is_none(),
            "manifest should not contain deviceId"
        );
    }

    #[test]
    fn validate_artifact_size_limit_rejects_oversized_artifacts() {
        let err = validate_artifact_size_limit("skills.zip", MAX_SYNC_ARTIFACT_BYTES + 1)
            .expect_err("artifact larger than limit should be rejected");
        assert!(
            err.to_string().contains("too large") || err.to_string().contains("超过"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn validate_artifact_size_limit_accepts_limit_boundary() {
        assert!(validate_artifact_size_limit("skills.zip", MAX_SYNC_ARTIFACT_BYTES).is_ok());
    }

    #[test]
    fn verify_artifact_rejects_size_mismatch() {
        let meta = artifact("abc123", 100);
        let bytes = vec![0u8; 50];
        let err = verify_artifact(&bytes, "test.bin", &meta)
            .expect_err("size mismatch should be rejected");
        assert!(
            err.to_string().contains("mismatch") || err.to_string().contains("不匹配"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn verify_artifact_rejects_hash_mismatch() {
        let meta = ArtifactMeta {
            sha256: "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            size: 5,
        };
        let bytes = b"hello";
        let err = verify_artifact(bytes, "test.bin", &meta)
            .expect_err("hash mismatch should be rejected");
        assert!(
            err.to_string().contains("verification failed") || err.to_string().contains("校验失败"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn remote_changed_conflict_error_uses_the_shared_key() {
        let err = remote_changed_conflict_error();
        match err {
            AppError::Localized { key, .. } => assert_eq!(key, REMOTE_CHANGED_ERROR_KEY),
            other => panic!("expected AppError::Localized, got {other:?}"),
        }
    }

    #[test]
    fn torn_snapshot_error_names_the_artifact_and_the_way_out() {
        let cause = localized(
            "sync.artifact_hash_mismatch",
            "hash 不匹配",
            "hash mismatch",
        );
        let err = torn_snapshot_error("db.sql", &cause);
        let text = err.to_string();
        assert!(text.contains("db.sql"), "{text}");
        assert!(
            text.contains("强制上传") || text.contains("force upload"),
            "{text}"
        );
        match err {
            AppError::Localized { key, .. } => assert_eq!(key, REMOTE_SNAPSHOT_TORN_ERROR_KEY),
            other => panic!("expected AppError::Localized, got {other:?}"),
        }
    }

    #[test]
    fn verify_artifact_accepts_matching_data() {
        let data = b"hello";
        let meta = ArtifactMeta {
            sha256: sha256_hex(data),
            size: data.len() as u64,
        };
        assert!(verify_artifact(data, "test.bin", &meta).is_ok());
    }

    #[test]
    fn snapshot_apply_mutex_serializes_concurrent_callers() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::thread;

        let active_count = Arc::new(AtomicUsize::new(0));
        let max_concurrency = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();

        for _ in 0..8 {
            let active = Arc::clone(&active_count);
            let max_conc = Arc::clone(&max_concurrency);
            handles.push(thread::spawn(move || {
                let _lock = snapshot_apply_mutex().lock().unwrap();
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                max_conc.fetch_max(current, Ordering::SeqCst);
                thread::sleep(std::time::Duration::from_millis(15));
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(
            max_concurrency.load(Ordering::SeqCst),
            1,
            "Snapshot apply lock must strictly serialize all concurrent callers"
        );
    }
}

#[cfg(test)]
#[path = "sync_protocol_tests.rs"]
mod publication_tests;
