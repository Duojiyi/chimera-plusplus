//! Step 5.6 — Launch the managed Codex process.
//!
//! G5: never spawn anything outside the runtime root. The executable path is
//! resolved exclusively through `health::check_runtime_health` — this module
//! never re-derives a path of its own — and is then re-verified against the
//! runtime root via `is_process_owned_by_runtime` before the process is ever
//! spawned. Both sides of that comparison are canonicalised first: `current.json`
//! only stores a version string, and `RuntimeLayout::version_dir` builds the
//! exe path with a plain `Path::join`, which does not resolve `..` components.
//! A tampered or corrupted pointer containing `../../elsewhere` would still
//! textually start with the runtime root and slip past a non-canonicalising
//! ownership check. Canonicalising first collapses `..` to the real on-disk
//! location before the comparison, which is what actually enforces G5.

use crate::health::{HealthError, check_runtime_health, is_process_owned_by_runtime};
use crate::update::RuntimeLayout;
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use thiserror::Error;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Outcome of a successful launch, returned across the Tauri IPC boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchReport {
    pub pid: u32,
    pub exe_path: PathBuf,
}

#[derive(Debug, Error)]
pub enum LaunchError {
    #[error("no version of Codex is installed")]
    NotInstalled,
    #[error("resolved executable is not owned by the managed runtime: {path:?}")]
    NotOwned { path: PathBuf },
    #[error("failed to spawn process: {0}")]
    Spawn(#[from] std::io::Error),
}

/// Launch the managed Codex executable belonging to the active version.
///
/// Spawns detached: stdio is not inherited, and the returned `Child` is not
/// tracked, so closing Chimera's own process can never take Codex down with
/// it. This is deliberately fire-and-forget — callers get a `pid` for display
/// only, never a handle to wait on or kill.
pub fn launch_managed_codex(layout: &RuntimeLayout) -> Result<LaunchReport, LaunchError> {
    let health = match check_runtime_health(layout) {
        Ok(h) => h,
        Err(HealthError::NoVersionInstalled) => return Err(LaunchError::NotInstalled),
        // Any other health error (io, corrupt pointer, ...) is also "nothing
        // we can launch" from this call's point of view.
        Err(_) => return Err(LaunchError::NotInstalled),
    };

    let exe_path = match health.exe_path {
        Some(p) if health.exe_present => p,
        _ => return Err(LaunchError::NotInstalled),
    };

    // Canonicalise before the ownership check — see the module doc comment
    // for why a literal, unresolved path is not safe to compare here.
    let canonical_exe = std::fs::canonicalize(&exe_path).unwrap_or_else(|_| exe_path.clone());
    let canonical_root =
        std::fs::canonicalize(layout.root()).unwrap_or_else(|_| layout.root().to_path_buf());

    if !is_process_owned_by_runtime(&canonical_exe, &canonical_root) {
        return Err(LaunchError::NotOwned { path: exe_path });
    }

    let mut command = Command::new(&exe_path);
    // Detached: no inherited stdio, so Chimera exiting cannot close a pipe
    // Codex is reading/writing. We deliberately do not set CREATE_NO_WINDOW —
    // Codex draws its own window and that flag is only for hiding console
    // subsystem apps — and we do not attach a console of our own.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = command.spawn()?;
    let pid = child.id();

    Ok(LaunchReport { pid, exe_path })
}

/// Read-only liveness check for the official or Chimera-managed desktop app.
/// Ownership-sensitive operations must still use the managed runtime guard.
pub fn codex_process_running() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        let mut command = Command::new("tasklist");
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command.args(["/FO", "CSV", "/NH"]).output();
        let Ok(output) = output else {
            return false;
        };
        let text = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
        return text
            .lines()
            .any(|line| line.contains("\"codex.exe\"") || line.contains("\"chatgpt.exe\""));
    }

    #[cfg(not(windows))]
    {
        Command::new("pgrep")
            .args(["-f", "(^|/)(Codex|ChatGPT)(\\.app)?"])
            .output()
            .map(|value| value.status.success())
            .unwrap_or(false)
    }
}
