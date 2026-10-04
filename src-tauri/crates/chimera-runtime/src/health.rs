//! Steps 5.5/5.6 — Runtime health check and process ownership guard.

use crate::update::RuntimeLayout;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct HealthResult {
    pub version: Option<String>,
    pub exe_present: bool,
    pub exe_path: Option<std::path::PathBuf>,
}

#[derive(Debug, Error)]
pub enum HealthError {
    #[error("no version installed (no current.json)")]
    NoVersionInstalled,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("update error: {0}")]
    Update(#[from] crate::update::UpdateError),
}

/// Check that the active version's executable is present on disk.
/// A deeper liveness check (launching the process) is done in integration tests.
pub fn check_runtime_health(layout: &RuntimeLayout) -> Result<HealthResult, HealthError> {
    let pointer = layout
        .read_current_pointer()?
        .ok_or(HealthError::NoVersionInstalled)?;

    let version_dir = layout.version_dir(&pointer.active_version);
    let exe = find_codex_exe(&version_dir);
    let exe_present = exe
        .as_ref()
        .map(|p: &std::path::PathBuf| p.exists())
        .unwrap_or(false);

    Ok(HealthResult {
        version: Some(pointer.active_version),
        exe_present,
        exe_path: exe,
    })
}

fn find_codex_exe(version_dir: &Path) -> Option<std::path::PathBuf> {
    // Windows: Codex.exe; macOS: Codex.app/Contents/MacOS/Codex (handled in Task 11)
    let candidates = ["Codex.exe", "codex", "Codex"];
    for name in &candidates {
        let p = version_dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Returns true iff the executable at `exe_path` is inside `runtime_root`.
/// Used to prevent accidentally killing external ChatGPT / MSIX Codex processes.
pub fn is_process_owned_by_runtime(exe_path: &Path, runtime_root: &Path) -> bool {
    // Compare path SEGMENTS, not the raw string. A string prefix test reports
    // true for `C:/rt-evil/Codex.exe` against root `C:/rt`, which would let us
    // terminate or replace an install we do not own — a G5 violation.
    fn segments(p: &Path) -> Vec<String> {
        p.to_string_lossy()
            .replace('\\', "/")
            .to_lowercase()
            .split('/')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    }

    let exe = segments(exe_path);
    let root = segments(runtime_root);

    // An empty root would match everything; the exe must also live strictly
    // below the root, never be the root itself.
    if root.is_empty() || exe.len() <= root.len() {
        return false;
    }
    exe[..root.len()] == root[..]
}
