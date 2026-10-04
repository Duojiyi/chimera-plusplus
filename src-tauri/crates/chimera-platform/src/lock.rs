use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LockError {
    #[error("operation lock already held (holder pid: {holder_pid:?})")]
    AlreadyHeld { holder_pid: Option<u32> },
    #[error("io error acquiring lock: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub struct OperationLock {
    path: PathBuf,
}

impl OperationLock {
    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    pub fn try_acquire(&self, operation: &str) -> Result<LockGuard, LockError> {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .read(true)
            .open(&self.path)
            .map_err(|e| LockError::Io {
                path: self.path.clone(),
                source: e,
            })?;

        match file.try_lock_exclusive() {
            Ok(()) => {
                let _ = file.set_len(0);
                let _ = file.seek(SeekFrom::Start(0));
                let op_clean = operation.replace('"', "'");
                let pid = std::process::id();
                let info = format!("{{\"pid\":{pid},\"op\":\"{op_clean}\"}}\n");
                let _ = file.write_all(info.as_bytes());
                let _ = file.flush();
                Ok(LockGuard {
                    file,
                    path: self.path.clone(),
                })
            }
            Err(_) => {
                let mut content = String::new();
                let _ = file.seek(SeekFrom::Start(0));
                let _ = file.read_to_string(&mut content);
                let holder_pid = parse_pid(&content);
                Err(LockError::AlreadyHeld { holder_pid })
            }
        }
    }
}

pub struct LockGuard {
    file: File,
    path: PathBuf,
}

impl LockGuard {
    /// Path of the lock file this guard holds. Used by diagnostics to report
    /// which operation lock is contended without re-deriving the path.
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = self.file.set_len(0);
        let _ = self.file.unlock();
    }
}

fn parse_pid(content: &str) -> Option<u32> {
    content
        .find("\"pid\":")
        .and_then(|i| content[i + 6..].split([',', '}']).next())
        .and_then(|s| s.trim().parse::<u32>().ok())
}
