//! Steps 5.3/5.4 — Runtime directory layout, current pointer, staging, commit, rollback.
//! Spec 8.2: versions/<v>/, staging/<tx>/, backup/<v>/, current.json, operation.lock

use chimera_platform::lock::{LockError, OperationLock};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum UpdateError {
    #[error("no previous version available for rollback")]
    NoPreviousVersion,
    #[error("version directory already exists: {0}")]
    AlreadyInstalled(PathBuf),
    #[error("current.json is missing or corrupt: {0}")]
    PointerCorrupt(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(String),
    #[error("another operation holds the runtime lock (holder pid: {holder_pid:?})")]
    Locked { holder_pid: Option<u32> },
}

impl From<LockError> for UpdateError {
    fn from(e: LockError) -> Self {
        match e {
            LockError::AlreadyHeld { holder_pid } => UpdateError::Locked { holder_pid },
            // A lock we cannot even open is an IO problem, not contention.
            LockError::Io { source, .. } => UpdateError::Io(source),
        }
    }
}

/// Active version pointer, written as `current.json` in the runtime root.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePointer {
    pub active_version: String,
    pub source_manifest_digest: String,
    /// Previous version (used for rollback).
    pub previous_version: Option<String>,
}

/// Directory layout for the managed runtime.
pub struct RuntimeLayout {
    root: PathBuf,
}

impl RuntimeLayout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn versions_dir(&self) -> PathBuf {
        self.root.join("versions")
    }
    pub fn staging_dir(&self) -> PathBuf {
        self.root.join("staging")
    }
    pub fn backup_dir(&self) -> PathBuf {
        self.root.join("backup")
    }
    pub fn version_dir(&self, version: &str) -> PathBuf {
        self.versions_dir().join(version)
    }
    /// Cross-process lock guarding every mutation of the runtime tree.
    /// Spec 8.2 names this file; commit and rollback both take it so two
    /// Chimera processes cannot interleave a version swap.
    pub fn operation_lock_path(&self) -> PathBuf {
        self.root.join("operation.lock")
    }

    pub fn current_pointer_path(&self) -> PathBuf {
        self.root.join("current.json")
    }

    /// Write-ahead journal for an in-flight version swap (Spec 8.2).
    ///
    /// Present only while a commit is running. Its existence at startup means
    /// the process died mid-update, and its phase says how far it got.
    pub fn transaction_path(&self) -> PathBuf {
        self.root.join("transaction.json")
    }

    pub fn initialise(&self) -> Result<(), UpdateError> {
        fs::create_dir_all(self.versions_dir())?;
        fs::create_dir_all(self.staging_dir())?;
        fs::create_dir_all(self.backup_dir())?;
        Ok(())
    }

    pub fn read_current_pointer(&self) -> Result<Option<UpdatePointer>, UpdateError> {
        let p = self.current_pointer_path();
        if !p.exists() {
            return Ok(None);
        }
        let data = fs::read(&p)?;
        serde_json::from_slice(&data)
            .map_err(|e| UpdateError::PointerCorrupt(e.to_string()))
            .map(Some)
    }

    fn write_current_pointer(&self, pointer: &UpdatePointer) -> Result<(), UpdateError> {
        let json =
            serde_json::to_string_pretty(pointer).map_err(|e| UpdateError::Json(e.to_string()))?;
        let tmp = self.current_pointer_path().with_extension("json.tmp");
        let mut f = fs::File::create(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.flush()?;
        drop(f);
        fs::rename(tmp, self.current_pointer_path())?;
        Ok(())
    }
}

/// How far a version swap had progressed when the journal was last written.
///
/// Ordered by the sequence `commit_version` performs, because recovery decides
/// what to undo purely from this value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionPhase {
    /// Journal written; nothing on disk has been touched yet.
    Started,
    /// The previously active version was moved to `backup/<v>`.
    OldAsided,
    /// The staged tree was renamed into `versions/<v>`.
    Installed,
    /// `current.json` now names the new version. Only cleanup remains.
    Committed,
}

/// The write-ahead record of an in-flight swap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub version: String,
    pub source_manifest_digest: String,
    pub phase: TransactionPhase,
    /// The version that was active before this swap, so recovery knows what
    /// "last known good" means without re-reading a pointer it may have
    /// already overwritten.
    pub previous_version: Option<String>,
}

/// Record intent before touching anything, flushing before the rename.
///
/// The rename is what makes the record visible; writing to a temp file first
/// means a torn write can never leave a half-parsed journal in place.
///
/// `previous_version` is read from `current.json` at each call. That is exact
/// for every phase recovery acts on — the pointer is not rewritten until step 3
/// — and by the `Committed` phase the field is no longer consulted.
pub fn write_transaction(
    layout: &RuntimeLayout,
    version: &str,
    source_manifest_digest: &str,
    phase: TransactionPhase,
) -> Result<(), UpdateError> {
    let previous = layout
        .read_current_pointer()
        .ok()
        .flatten()
        .map(|p| p.active_version);
    let tx = Transaction {
        version: version.to_string(),
        source_manifest_digest: source_manifest_digest.to_string(),
        phase,
        previous_version: previous,
    };
    let json = serde_json::to_string_pretty(&tx).map_err(|e| UpdateError::Json(e.to_string()))?;
    let tmp = layout.transaction_path().with_extension("json.tmp");
    let mut f = fs::File::create(&tmp)?;
    f.write_all(json.as_bytes())?;
    f.sync_all()?;
    drop(f);
    fs::rename(tmp, layout.transaction_path())?;
    Ok(())
}

/// Read the journal, if one is present.
///
/// A journal that cannot be parsed reports `None` rather than an error: it is
/// evidence of a torn write, which recovery handles by clearing it. Returning
/// an error here would make a power cut at the wrong microsecond permanently
/// unbootable.
pub fn read_transaction(layout: &RuntimeLayout) -> Result<Option<Transaction>, UpdateError> {
    let p = layout.transaction_path();
    if !p.exists() {
        return Ok(None);
    }
    let data = fs::read(&p)?;
    Ok(serde_json::from_slice(&data).ok())
}

fn clear_transaction(layout: &RuntimeLayout) -> Result<(), UpdateError> {
    let p = layout.transaction_path();
    if p.exists() {
        fs::remove_file(p)?;
    }
    Ok(())
}

/// Replace `dst` with `src`, removing whatever `dst` held first.
fn move_over(src: &Path, dst: &Path) -> Result<(), UpdateError> {
    if dst.exists() {
        fs::remove_dir_all(dst)?;
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(src, dst)?;
    Ok(())
}

/// Create a staging directory for a new version.
/// Returns the staging directory path.
pub fn stage_version(layout: &RuntimeLayout, version: &str) -> Result<PathBuf, UpdateError> {
    let staged = layout.staging_dir().join(version);
    fs::create_dir_all(&staged)?;
    Ok(staged)
}

/// Commit a staged version: `staging/<v>` → `versions/<v>`, then `current.json`.
///
/// Every destructive step is preceded by a journal write, so an interruption at
/// any point is recoverable by `recover_if_interrupted` (G6). The previously
/// active version is moved to `backup/` rather than deleted, which is both what
/// makes rollback have a guaranteed target and what stops a reinstall of the
/// same version number from destroying the only working copy.
pub fn commit_version(
    layout: &RuntimeLayout,
    version: &str,
    source_manifest_digest: &str,
) -> Result<UpdatePointer, UpdateError> {
    // Hold the lock for the whole swap. Without it, two processes can each read
    // current.json, then both write it — losing one previous_version link and
    // leaving the rollback chain pointing at a version that no longer exists.
    let lock = OperationLock::new(layout.operation_lock_path());
    let _guard = lock.try_acquire("commit_version")?;

    let staged = layout.staging_dir().join(version);
    let version_dir = layout.version_dir(version);
    let previous = layout
        .read_current_pointer()
        .ok()
        .flatten()
        .map(|p| p.active_version);

    write_transaction(
        layout,
        version,
        source_manifest_digest,
        TransactionPhase::Started,
    )?;

    // Step 1 — preserve whatever occupies the destination. Only a reinstall of
    // the same version hits this; a normal upgrade writes a fresh directory.
    if version_dir.exists() {
        move_over(&version_dir, &layout.backup_dir().join(version))?;
        write_transaction(
            layout,
            version,
            source_manifest_digest,
            TransactionPhase::OldAsided,
        )?;
    }

    // Step 2 — install.
    fs::create_dir_all(layout.versions_dir())?;
    fs::rename(&staged, &version_dir)?;
    write_transaction(
        layout,
        version,
        source_manifest_digest,
        TransactionPhase::Installed,
    )?;

    // Step 3 — activate.
    let pointer = UpdatePointer {
        active_version: version.to_string(),
        source_manifest_digest: source_manifest_digest.to_string(),
        previous_version: previous,
    };
    layout.write_current_pointer(&pointer)?;
    write_transaction(
        layout,
        version,
        source_manifest_digest,
        TransactionPhase::Committed,
    )?;

    // Step 4 — the swap is durable; the backup copy is now redundant.
    let backup = layout.backup_dir().join(version);
    if backup.exists() {
        fs::remove_dir_all(&backup)?;
    }
    clear_transaction(layout)?;
    Ok(pointer)
}

/// Repair an update that was interrupted, returning to the last known good
/// version (G6). Safe to call on every start and safe to call repeatedly.
///
/// The rule is asymmetric on purpose. Before `current.json` is written the new
/// version has been verified by nothing, so recovery rolls back. Once the
/// pointer is written the update has succeeded and only cleanup is outstanding,
/// so recovery finishes the job instead of undoing good work.
pub fn recover_if_interrupted(layout: &RuntimeLayout) -> Result<(), UpdateError> {
    // A torn or absent journal both mean "nothing to replay"; the torn one is
    // cleared so startup cannot loop on it.
    let Some(tx) = read_transaction(layout)? else {
        clear_transaction(layout)?;
        return Ok(());
    };

    let lock = OperationLock::new(layout.operation_lock_path());
    let _guard = lock.try_acquire("recover_if_interrupted")?;

    match tx.phase {
        // The update was durable before the crash. Finish cleanup only.
        TransactionPhase::Committed => {}

        // Nothing was moved. There is nothing to undo.
        TransactionPhase::Started => {}

        // Roll back: drop the half-installed version, then restore the copy
        // that was moved aside, so the pointer again describes reality.
        TransactionPhase::OldAsided | TransactionPhase::Installed => {
            let restore_version = tx.previous_version.as_deref().unwrap_or(&tx.version);
            if tx.phase == TransactionPhase::Installed && restore_version != tx.version {
                let installed = layout.version_dir(&tx.version);
                if installed.exists() {
                    fs::remove_dir_all(&installed)?;
                }
            }
            let backup = layout.backup_dir().join(restore_version);
            if backup.exists() {
                move_over(&backup, &layout.version_dir(restore_version))?;
            }
        }
    }

    // The backup copy has served its purpose in every branch above.
    let backup = layout.backup_dir().join(&tx.version);
    if backup.exists() && tx.phase == TransactionPhase::Committed {
        fs::remove_dir_all(&backup)?;
    }
    clear_transaction(layout)
}

/// Roll back to the previous version.
pub fn rollback_to_last_known(layout: &RuntimeLayout) -> Result<UpdatePointer, UpdateError> {
    // Same lock as commit: a rollback racing an update would otherwise read a
    // pointer that the other operation is mid-way through replacing.
    let lock = OperationLock::new(layout.operation_lock_path());
    let _guard = lock.try_acquire("rollback_to_last_known")?;

    let current = layout
        .read_current_pointer()?
        .ok_or(UpdateError::NoPreviousVersion)?;

    let prev_version = current
        .previous_version
        .ok_or(UpdateError::NoPreviousVersion)?;

    // Verify the previous version directory still exists
    let prev_dir = layout.version_dir(&prev_version);
    if !prev_dir.exists() {
        return Err(UpdateError::NoPreviousVersion);
    }

    let pointer = UpdatePointer {
        active_version: prev_version.clone(),
        source_manifest_digest: String::new(),
        previous_version: None, // after rollback, no further rollback available
    };
    layout.write_current_pointer(&pointer)?;
    Ok(pointer)
}
