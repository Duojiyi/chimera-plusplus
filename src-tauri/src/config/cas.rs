// Adapted from yynxxxxx/Codex-X apps/desktop/src-tauri/src/live_config.rs (MIT)
//! Compare-and-swap (CAS) multi-file changesets for live configuration files.
//!
//! A caller reads every file it intends to change with [`FileSnapshot::read`],
//! computes the replacement bytes, plans them into a [`Changeset`] and calls
//! [`Changeset::commit`]. Commit:
//!
//! 1. re-hashes every target and aborts with [`ChangesetError::Conflict`]
//!    before touching anything if a file changed since it was read (a missing
//!    file is its own state, so "created by someone else" is a conflict too);
//! 2. writes each file through [`crate::config::atomic_write_checked`] — the
//!    same primitive as `atomic_write`, so symlink refusal and the Windows
//!    `MoveFileExW` replace are unchanged — re-checking the hash once more
//!    right before each replace (a planned delete re-checks, then removes);
//! 3. re-reads every written file and verifies its hash;
//! 4. on any failure, restores already-written files to their prior bytes (or
//!    deletes files that did not exist before), each restore itself guarded by
//!    CAS so a concurrent external writer is never clobbered.
//!
//! Prior contents are held only in memory ([`FileSnapshot`]); nothing is
//! written to a backup file, so `auth.json` can take part in a changeset
//! without ever being persisted elsewhere. The module never touches the
//! database: callers must plan, commit the files, then run their short DB
//! transaction and call [`AppliedChangeset::rollback`] if that fails — never
//! hold the DB lock across [`Changeset::commit`].
//!
//! Errors carry paths only, never file contents.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::security_limits::{read_limited, MAX_CONFIG_FILE_BYTES};

/// SHA-256 of a file's bytes.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ContentHash([u8; 32]);

impl ContentHash {
    pub fn of(bytes: &[u8]) -> Self {
        let mut digest = [0u8; 32];
        digest.copy_from_slice(&Sha256::digest(bytes));
        Self(digest)
    }
}

impl fmt::Debug for ContentHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ContentHash(")?;
        for byte in &self.0[..8] {
            write!(f, "{byte:02x}")?;
        }
        f.write_str("..)")
    }
}

/// What a path held when it was observed. `Missing` is distinct from an
/// empty file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileState {
    Missing,
    Present(ContentHash),
}

impl FileState {
    fn of(contents: Option<&[u8]>) -> Self {
        contents.map_or(Self::Missing, |bytes| Self::Present(ContentHash::of(bytes)))
    }
}

/// Permission policy for a planned write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    /// Same as `atomic_write`: keep an existing file's mode; new files are
    /// created 0600 on Unix.
    Standard,
    /// Force 0600 on Unix even when the existing file is looser.
    Private,
}

/// A file's state at read time, with its bytes kept in memory for rollback.
pub struct FileSnapshot {
    path: PathBuf,
    state: FileState,
    contents: Option<Vec<u8>>,
}

impl FileSnapshot {
    /// Reads `path` (bounded by `MAX_CONFIG_FILE_BYTES`, refusing a final
    /// symlink/reparse point). A missing file yields [`FileState::Missing`].
    pub fn read(path: impl Into<PathBuf>) -> Result<Self, ChangesetError> {
        let path = path.into();
        let contents = read_current(&path)?;
        Ok(Self {
            state: FileState::of(contents.as_deref()),
            path,
            contents,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn state(&self) -> FileState {
        self.state
    }

    /// Bytes observed at read time; `None` when the file was missing.
    pub fn contents(&self) -> Option<&[u8]> {
        self.contents.as_deref()
    }
}

impl fmt::Debug for FileSnapshot {
    // Never print contents: snapshots routinely hold credentials.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileSnapshot")
            .field("path", &self.path)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub enum ChangesetError {
    /// The file changed after it was read; nothing was left half-written.
    Conflict {
        path: PathBuf,
    },
    /// A written file did not read back with the expected hash.
    VerifyFailed {
        path: PathBuf,
    },
    /// The same path was planned twice in one changeset.
    DuplicatePath {
        path: PathBuf,
    },
    /// Rollback could not restore these paths (typically because another
    /// program wrote them after us). `cause` is the failure that triggered
    /// the rollback; `None` for an explicit [`AppliedChangeset::rollback`].
    RollbackIncomplete {
        cause: Option<Box<ChangesetError>>,
        paths: Vec<PathBuf>,
    },
    App(AppError),
}

impl fmt::Display for ChangesetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict { path } => write!(
                f,
                "{} 在读取后已被其他程序修改，本次写入已取消",
                path.display()
            ),
            Self::VerifyFailed { path } => write!(f, "{} 写入后校验不一致", path.display()),
            Self::DuplicatePath { path } => {
                write!(f, "同一变更集重复写入同一文件: {}", path.display())
            }
            Self::RollbackIncomplete { cause, paths } => {
                if let Some(cause) = cause {
                    write!(f, "{cause}；")?;
                }
                f.write_str("以下文件未能回滚，需要人工检查: ")?;
                for (index, path) in paths.iter().enumerate() {
                    if index > 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{}", path.display())?;
                }
                Ok(())
            }
            Self::App(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for ChangesetError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::App(error) => Some(error),
            _ => None,
        }
    }
}

impl From<AppError> for ChangesetError {
    fn from(error: AppError) -> Self {
        Self::App(error)
    }
}

impl From<ChangesetError> for AppError {
    fn from(error: ChangesetError) -> Self {
        match error {
            ChangesetError::App(inner) => inner,
            ChangesetError::Conflict { path } => AppError::localized(
                "config.changeset_conflict",
                format!(
                    "{} 在读取后已被其他程序修改，本次写入已取消，请刷新后重试",
                    path.display()
                ),
                format!(
                    "{} was changed by another program after it was read; the write was cancelled. Refresh and try again.",
                    path.display()
                ),
            ),
            other => AppError::Config(other.to_string()),
        }
    }
}

fn read_current(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    match read_limited(path, MAX_CONFIG_FILE_BYTES) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io(path, error)),
    }
}

fn ensure_state(path: &Path, expected: FileState) -> Result<(), ChangesetError> {
    if FileState::of(read_current(path)?.as_deref()) == expected {
        Ok(())
    } else {
        Err(ChangesetError::Conflict {
            path: path.to_path_buf(),
        })
    }
}

fn write_if_state(
    path: &Path,
    contents: &[u8],
    mode: WriteMode,
    expected: FileState,
) -> Result<(), ChangesetError> {
    crate::config::atomic_write_checked(path, contents, mode == WriteMode::Private, || {
        ensure_state(path, expected)
    })
}

struct PlannedWrite {
    snapshot: FileSnapshot,
    /// `None` plans a delete.
    contents: Option<Vec<u8>>,
    mode: WriteMode,
}

/// Applies one planned change, CAS-guarded against `expected`.
fn apply_if_state(
    path: &Path,
    contents: Option<&[u8]>,
    mode: WriteMode,
    expected: FileState,
) -> Result<(), ChangesetError> {
    match contents {
        Some(bytes) => write_if_state(path, bytes, mode, expected),
        None => {
            ensure_state(path, expected)?;
            match fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(AppError::io(path, error).into()),
            }
        }
    }
}

/// Test-only fault injection points inside [`Changeset::commit`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    BeforeWrite,
    BeforeVerify,
}

#[cfg(test)]
type StageHook = Box<dyn FnMut(Stage) -> Result<(), AppError>>;

/// A set of planned writes committed all-or-nothing.
#[derive(Default)]
pub struct Changeset {
    writes: Vec<PlannedWrite>,
    #[cfg(test)]
    hook: Option<StageHook>,
}

impl Changeset {
    pub fn new() -> Self {
        Self::default()
    }

    /// Plans `contents` for `snapshot.path()` with [`WriteMode::Standard`].
    pub fn write(
        &mut self,
        snapshot: FileSnapshot,
        contents: impl Into<Vec<u8>>,
    ) -> Result<(), ChangesetError> {
        self.plan(snapshot, Some(contents.into()), WriteMode::Standard)
    }

    /// Plans deleting `snapshot.path()`; a file that was already missing is
    /// left alone.
    pub fn delete(&mut self, snapshot: FileSnapshot) -> Result<(), ChangesetError> {
        self.plan(snapshot, None, WriteMode::Standard)
    }

    /// Plans `contents` for `snapshot.path()` with [`WriteMode::Private`].
    pub fn write_private(
        &mut self,
        snapshot: FileSnapshot,
        contents: impl Into<Vec<u8>>,
    ) -> Result<(), ChangesetError> {
        self.plan(snapshot, Some(contents.into()), WriteMode::Private)
    }

    fn plan(
        &mut self,
        snapshot: FileSnapshot,
        contents: Option<Vec<u8>>,
        mode: WriteMode,
    ) -> Result<(), ChangesetError> {
        if self
            .writes
            .iter()
            .any(|planned| planned.snapshot.path == snapshot.path)
        {
            return Err(ChangesetError::DuplicatePath {
                path: snapshot.path,
            });
        }
        self.writes.push(PlannedWrite {
            snapshot,
            contents,
            mode,
        });
        Ok(())
    }

    fn checkpoint(&mut self, stage: Stage) -> Result<(), ChangesetError> {
        #[cfg(test)]
        if let Some(hook) = self.hook.as_mut() {
            hook(stage)?;
        }
        #[cfg(not(test))]
        let _ = stage;
        Ok(())
    }

    /// Applies every planned write or none of them (see the module docs).
    pub fn commit(mut self) -> Result<AppliedChangeset, ChangesetError> {
        let writes = std::mem::take(&mut self.writes);

        // Check everything before writing anything, so a stale plan never
        // leaves a partial state behind.
        for planned in &writes {
            ensure_state(&planned.snapshot.path, planned.snapshot.state)?;
        }

        let mut applied: Vec<AppliedWrite> = Vec::with_capacity(writes.len());
        for PlannedWrite {
            snapshot,
            contents,
            mode,
        } in writes
        {
            let written = FileState::of(contents.as_deref());
            if snapshot.state == written {
                continue;
            }
            let result = self.checkpoint(Stage::BeforeWrite).and_then(|()| {
                apply_if_state(&snapshot.path, contents.as_deref(), mode, snapshot.state)
            });
            if let Err(cause) = result {
                return Err(fail_with_rollback(cause, &applied));
            }
            applied.push(AppliedWrite {
                path: snapshot.path,
                prior: snapshot.contents,
                written,
                mode,
            });
        }

        let verified = self
            .checkpoint(Stage::BeforeVerify)
            .and_then(|()| verify(&applied));
        if let Err(cause) = verified {
            return Err(fail_with_rollback(cause, &applied));
        }
        Ok(AppliedChangeset { writes: applied })
    }
}

struct AppliedWrite {
    path: PathBuf,
    prior: Option<Vec<u8>>,
    /// State we left the file in (`Missing` after a delete).
    written: FileState,
    mode: WriteMode,
}

fn verify(applied: &[AppliedWrite]) -> Result<(), ChangesetError> {
    for write in applied {
        if FileState::of(read_current(&write.path)?.as_deref()) != write.written {
            return Err(ChangesetError::VerifyFailed {
                path: write.path.clone(),
            });
        }
    }
    Ok(())
}

fn rollback_one(write: &AppliedWrite) -> Result<(), ChangesetError> {
    apply_if_state(
        &write.path,
        write.prior.as_deref(),
        write.mode,
        write.written,
    )
}

/// Restores in reverse order; returns the paths that could not be restored.
fn rollback_all(applied: &[AppliedWrite]) -> Vec<PathBuf> {
    applied
        .iter()
        .rev()
        .filter_map(|write| match rollback_one(write) {
            Ok(()) => None,
            Err(error) => {
                log::error!("回滚 {} 失败: {error}", write.path.display());
                Some(write.path.clone())
            }
        })
        .collect()
}

fn fail_with_rollback(cause: ChangesetError, applied: &[AppliedWrite]) -> ChangesetError {
    let paths = rollback_all(applied);
    if paths.is_empty() {
        cause
    } else {
        ChangesetError::RollbackIncomplete {
            cause: Some(Box::new(cause)),
            paths,
        }
    }
}

/// Files written by a successful [`Changeset::commit`]. Dropping it keeps the
/// changes; call [`AppliedChangeset::rollback`] when a later step (such as the
/// DB transaction that goes with these files) fails.
pub struct AppliedChangeset {
    writes: Vec<AppliedWrite>,
}

impl AppliedChangeset {
    /// Paths actually written (unchanged plans are skipped).
    pub fn paths(&self) -> impl Iterator<Item = &Path> {
        self.writes.iter().map(|write| write.path.as_path())
    }

    /// Restores every written file to its pre-commit state, skipping (and
    /// reporting) any file another program has changed since.
    pub fn rollback(self) -> Result<(), ChangesetError> {
        let paths = rollback_all(&self.writes);
        if paths.is_empty() {
            Ok(())
        } else {
            Err(ChangesetError::RollbackIncomplete { cause: None, paths })
        }
    }
}

impl fmt::Debug for AppliedChangeset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.paths()).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const SECRET: &str = "sk-cas-test-secret-value";

    fn with_hook(
        changeset: &mut Changeset,
        hook: impl FnMut(Stage) -> Result<(), AppError> + 'static,
    ) {
        changeset.hook = Some(Box::new(hook));
    }

    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn missing_file_is_distinct_from_empty_file() {
        let dir = tempdir().unwrap();
        let missing = FileSnapshot::read(dir.path().join("missing.toml")).unwrap();
        assert_eq!(missing.state(), FileState::Missing);
        assert!(missing.contents().is_none());

        let empty_path = dir.path().join("empty.toml");
        fs::write(&empty_path, b"").unwrap();
        let empty = FileSnapshot::read(&empty_path).unwrap();
        assert_eq!(empty.state(), FileState::Present(ContentHash::of(b"")));
        assert_ne!(empty.state(), missing.state());
    }

    #[test]
    fn commit_writes_every_file_including_new_ones() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("nested").join("auth.json");
        fs::write(&config, b"old").unwrap();

        let mut changeset = Changeset::new();
        changeset
            .write(FileSnapshot::read(&config).unwrap(), "new config")
            .unwrap();
        changeset
            .write_private(FileSnapshot::read(&auth).unwrap(), "new auth")
            .unwrap();
        let applied = changeset.commit().unwrap();

        assert_eq!(applied.paths().count(), 2);
        assert_eq!(fs::read(&config).unwrap(), b"new config");
        assert_eq!(fs::read(&auth).unwrap(), b"new auth");
        assert_eq!(file_names(dir.path()), vec!["config.toml", "nested"]);
    }

    #[test]
    fn conflict_before_commit_aborts_without_writing_anything() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("config.toml");
        let second = dir.path().join("auth.json");
        fs::write(&first, b"first-old").unwrap();
        fs::write(&second, b"second-old").unwrap();

        let mut changeset = Changeset::new();
        changeset
            .write(FileSnapshot::read(&first).unwrap(), "first-new")
            .unwrap();
        changeset
            .write(FileSnapshot::read(&second).unwrap(), "second-new")
            .unwrap();
        fs::write(&second, b"external").unwrap();

        let error = changeset.commit().unwrap_err();
        assert!(
            matches!(&error, ChangesetError::Conflict { path } if path == &second),
            "unexpected error: {error}"
        );
        assert_eq!(fs::read(&first).unwrap(), b"first-old");
        assert_eq!(fs::read(&second).unwrap(), b"external");
    }

    #[test]
    fn file_created_by_someone_else_after_a_missing_read_is_a_conflict() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let snapshot = FileSnapshot::read(&path).unwrap();
        fs::write(&path, b"created elsewhere").unwrap();

        let mut changeset = Changeset::new();
        changeset.write(snapshot, "ours").unwrap();
        assert!(matches!(
            changeset.commit(),
            Err(ChangesetError::Conflict { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), b"created elsewhere");
    }

    #[test]
    fn conflict_on_second_file_mid_commit_rolls_back_the_first() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("config.toml");
        let second = dir.path().join("auth.json");
        fs::write(&first, b"first-old").unwrap();
        fs::write(&second, b"second-old").unwrap();

        let mut changeset = Changeset::new();
        changeset
            .write(FileSnapshot::read(&first).unwrap(), "first-new")
            .unwrap();
        changeset
            .write(FileSnapshot::read(&second).unwrap(), "second-new")
            .unwrap();
        let external_target = second.clone();
        let mut writes = 0;
        with_hook(&mut changeset, move |stage| {
            if stage == Stage::BeforeWrite {
                writes += 1;
                if writes == 2 {
                    fs::write(&external_target, b"external").unwrap();
                }
            }
            Ok(())
        });

        let error = changeset.commit().unwrap_err();
        assert!(
            matches!(&error, ChangesetError::Conflict { path } if path == &second),
            "unexpected error: {error}"
        );
        assert_eq!(fs::read(&first).unwrap(), b"first-old");
        assert_eq!(fs::read(&second).unwrap(), b"external");
        // The aborted replace must not leave its temp file behind.
        assert_eq!(file_names(dir.path()), vec!["auth.json", "config.toml"]);
    }

    #[test]
    fn second_write_failure_restores_prior_bytes_and_deletes_created_file() {
        let dir = tempdir().unwrap();
        let created = dir.path().join("models.json");
        let existing = dir.path().join("config.toml");
        fs::write(&existing, b"existing-old").unwrap();

        let mut changeset = Changeset::new();
        changeset
            .write(FileSnapshot::read(&created).unwrap(), "created")
            .unwrap();
        changeset
            .write(FileSnapshot::read(&existing).unwrap(), "existing-new")
            .unwrap();
        let mut writes = 0;
        with_hook(&mut changeset, move |stage| {
            if stage == Stage::BeforeWrite {
                writes += 1;
                if writes == 2 {
                    return Err(AppError::Config("injected write failure".to_string()));
                }
            }
            Ok(())
        });

        let error = changeset.commit().unwrap_err();
        assert!(
            matches!(&error, ChangesetError::App(AppError::Config(message)) if message == "injected write failure"),
            "unexpected error: {error}"
        );
        assert!(
            !created.exists(),
            "a file created by the changeset must be removed"
        );
        assert_eq!(fs::read(&existing).unwrap(), b"existing-old");
        assert_eq!(file_names(dir.path()), vec!["config.toml"]);
    }

    #[test]
    fn verify_failure_rolls_back_but_never_clobbers_an_external_writer() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("config.toml");
        let second = dir.path().join("auth.json");
        fs::write(&first, b"first-old").unwrap();
        fs::write(&second, b"second-old").unwrap();

        let mut changeset = Changeset::new();
        changeset
            .write(FileSnapshot::read(&first).unwrap(), "first-new")
            .unwrap();
        changeset
            .write(FileSnapshot::read(&second).unwrap(), "second-new")
            .unwrap();
        let external_target = first.clone();
        with_hook(&mut changeset, move |stage| {
            if stage == Stage::BeforeVerify {
                fs::write(&external_target, b"external").unwrap();
            }
            Ok(())
        });

        let error = changeset.commit().unwrap_err();
        match &error {
            ChangesetError::RollbackIncomplete {
                cause: Some(cause),
                paths,
            } => {
                assert!(
                    matches!(cause.as_ref(), ChangesetError::VerifyFailed { path } if path == &first)
                );
                assert_eq!(paths, &vec![first.clone()]);
            }
            other => panic!("unexpected error: {other}"),
        }
        assert_eq!(fs::read(&first).unwrap(), b"external");
        assert_eq!(fs::read(&second).unwrap(), b"second-old");
    }

    #[test]
    fn explicit_rollback_undoes_a_committed_changeset() {
        let dir = tempdir().unwrap();
        let existing = dir.path().join("config.toml");
        let created = dir.path().join("auth.json");
        fs::write(&existing, b"old").unwrap();

        let mut changeset = Changeset::new();
        changeset
            .write(FileSnapshot::read(&existing).unwrap(), "new")
            .unwrap();
        changeset
            .write_private(FileSnapshot::read(&created).unwrap(), SECRET)
            .unwrap();
        let applied = changeset.commit().unwrap();
        assert!(created.exists());

        applied.rollback().unwrap();
        assert_eq!(fs::read(&existing).unwrap(), b"old");
        assert!(!created.exists());
        assert_eq!(file_names(dir.path()), vec!["config.toml"]);
    }

    #[test]
    fn planned_delete_is_cas_guarded_and_rolled_back() {
        let dir = tempdir().unwrap();
        let deleted = dir.path().join("auth.json");
        let written = dir.path().join("config.toml");
        fs::write(&deleted, SECRET).unwrap();
        fs::write(&written, b"old").unwrap();

        // Deleting a file that changed after it was read is a conflict.
        let mut changeset = Changeset::new();
        changeset
            .delete(FileSnapshot::read(&deleted).unwrap())
            .unwrap();
        fs::write(&deleted, b"external").unwrap();
        assert!(matches!(
            changeset.commit(),
            Err(ChangesetError::Conflict { .. })
        ));
        assert_eq!(fs::read(&deleted).unwrap(), b"external");

        let mut changeset = Changeset::new();
        changeset
            .delete(FileSnapshot::read(&deleted).unwrap())
            .unwrap();
        changeset
            .write(FileSnapshot::read(&written).unwrap(), "new")
            .unwrap();
        let applied = changeset.commit().unwrap();
        assert!(!deleted.exists());
        assert_eq!(fs::read(&written).unwrap(), b"new");

        // The deleted bytes come back from memory.
        applied.rollback().unwrap();
        assert_eq!(fs::read(&deleted).unwrap(), b"external");
        assert_eq!(fs::read(&written).unwrap(), b"old");

        // Deleting an already missing file is a no-op.
        let missing = dir.path().join("missing.json");
        let mut changeset = Changeset::new();
        changeset
            .delete(FileSnapshot::read(&missing).unwrap())
            .unwrap();
        assert_eq!(changeset.commit().unwrap().paths().count(), 0);
    }

    #[test]
    fn unchanged_plan_is_not_rewritten() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, b"same").unwrap();

        let mut changeset = Changeset::new();
        changeset
            .write(FileSnapshot::read(&path).unwrap(), "same")
            .unwrap();
        let applied = changeset.commit().unwrap();
        assert_eq!(applied.paths().count(), 0);
        assert_eq!(fs::read(&path).unwrap(), b"same");
    }

    #[test]
    fn duplicate_paths_are_rejected_when_planned() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut changeset = Changeset::new();
        changeset
            .write(FileSnapshot::read(&path).unwrap(), "a")
            .unwrap();
        assert!(matches!(
            changeset.write(FileSnapshot::read(&path).unwrap(), "b"),
            Err(ChangesetError::DuplicatePath { .. })
        ));
    }

    #[test]
    fn errors_and_debug_output_never_contain_file_contents() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("auth.json");
        fs::write(&path, SECRET).unwrap();
        let snapshot = FileSnapshot::read(&path).unwrap();
        assert!(!format!("{snapshot:?}").contains(SECRET));

        let mut changeset = Changeset::new();
        changeset.write(snapshot, format!("{SECRET}-new")).unwrap();
        fs::write(&path, format!("{SECRET}-external")).unwrap();
        let error = changeset.commit().unwrap_err();

        assert!(!error.to_string().contains(SECRET));
        assert!(!format!("{error:?}").contains(SECRET));
        let app_error: AppError = error.into();
        assert!(matches!(
            app_error,
            AppError::Localized {
                key: "config.changeset_conflict",
                ..
            }
        ));
        assert!(!app_error.to_string().contains(SECRET));
    }

    #[cfg(unix)]
    fn make_file_symlink(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).unwrap();
        true
    }

    #[cfg(windows)]
    fn make_file_symlink(target: &Path, link: &Path) -> bool {
        match std::os::windows::fs::symlink_file(target, link) {
            Ok(()) => true,
            // Creating symlinks needs developer mode or elevation on Windows.
            Err(error) if error.raw_os_error() == Some(1314) => false,
            Err(error) => panic!("create symlink: {error}"),
        }
    }

    #[test]
    fn symlink_target_is_refused_without_partial_state() {
        let dir = tempdir().unwrap();
        let regular = dir.path().join("config.toml");
        let link = dir.path().join("auth.json");
        let outside = dir.path().join("outside.json");
        fs::write(&regular, b"regular-old").unwrap();
        fs::write(&outside, b"outside-old").unwrap();

        let mut changeset = Changeset::new();
        changeset
            .write(FileSnapshot::read(&regular).unwrap(), "regular-new")
            .unwrap();
        changeset
            .write(FileSnapshot::read(&link).unwrap(), "through-link")
            .unwrap();
        if !make_file_symlink(&outside, &link) {
            return;
        }

        // Reading a symlinked target is refused outright, not treated as a
        // conflict or followed.
        assert!(matches!(
            FileSnapshot::read(&link),
            Err(ChangesetError::App(AppError::Io { .. }))
        ));
        let error = changeset.commit().unwrap_err();
        assert!(
            matches!(error, ChangesetError::App(AppError::Io { .. })),
            "unexpected error: {error}"
        );
        assert_eq!(fs::read(&regular).unwrap(), b"regular-old");
        assert_eq!(fs::read(&outside).unwrap(), b"outside-old");
    }

    #[test]
    fn atomic_write_symlink_refusal_propagates_and_rolls_back_earlier_writes() {
        let dir = tempdir().unwrap();
        let probe = dir.path().join("probe-link");
        let outside = dir.path().join("outside.json");
        fs::write(&outside, b"outside-old").unwrap();
        if !make_file_symlink(&outside, &probe) {
            return;
        }
        fs::remove_file(&probe).unwrap();

        let regular = dir.path().join("config.toml");
        let link = dir.path().join("auth.json");
        fs::write(&regular, b"regular-old").unwrap();

        let mut changeset = Changeset::new();
        changeset
            .write(FileSnapshot::read(&regular).unwrap(), "regular-new")
            .unwrap();
        changeset
            .write(FileSnapshot::read(&link).unwrap(), "through-link")
            .unwrap();
        // The link appears between the pre-commit check and the second write,
        // so it is `atomic_write`'s own symlink refusal that has to fire.
        let (link_target, link_path) = (outside.clone(), link.clone());
        let mut writes = 0;
        with_hook(&mut changeset, move |stage| {
            if stage == Stage::BeforeWrite {
                writes += 1;
                if writes == 2 {
                    assert!(make_file_symlink(&link_target, &link_path));
                }
            }
            Ok(())
        });

        let error = changeset.commit().unwrap_err();
        assert!(
            matches!(&error, ChangesetError::App(AppError::Config(message)) if message.contains("符号链接")),
            "unexpected error: {error}"
        );
        assert_eq!(fs::read(&regular).unwrap(), b"regular-old");
        assert_eq!(fs::read(&outside).unwrap(), b"outside-old");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            file_names(dir.path()),
            vec!["auth.json", "config.toml", "outside.json"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn private_writes_force_0600_while_standard_writes_keep_the_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let private = dir.path().join("auth.json");
        let standard = dir.path().join("config.toml");
        for path in [&private, &standard] {
            fs::write(path, b"old").unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();
        }

        let mut changeset = Changeset::new();
        changeset
            .write_private(FileSnapshot::read(&private).unwrap(), "new")
            .unwrap();
        changeset
            .write(FileSnapshot::read(&standard).unwrap(), "new")
            .unwrap();
        let _applied = changeset.commit().unwrap();

        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&private), 0o600);
        assert_eq!(mode(&standard), 0o644);
    }
}
