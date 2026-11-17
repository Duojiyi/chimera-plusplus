//! Claude Desktop data directory discovery and process lock probes.
//! Shared by account switching, configuration, and local history continuity.

#[cfg(windows)]
use std::fs;
use std::path::{Path, PathBuf};

/// Claude Desktop's own (default) data folder. A Microsoft Store install
/// may keep it in the package's redirected AppData, and newer packaged
/// builds move it to `%LOCALAPPDATA%\Claude-Data\claude_<publisher>`; the
/// one whose `config.json` changed last is the one in use.
pub(crate) fn default_user_data_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(roaming) = dirs::config_dir() {
        candidates.push(roaming.join("Claude"));
    }
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        candidates.extend(claude_data_dirs(&local));
    }
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        if let Ok(entries) = crate::security_limits::read_dir_without_links(&local.join("Packages"))
        {
            for entry in entries {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("Claude_") || name.starts_with("AnthropicPBC.Claude_") {
                    candidates.push(
                        entry
                            .path()
                            .join("LocalCache")
                            .join("Roaming")
                            .join("Claude"),
                    );
                }
            }
        }
    }
    candidates
        .into_iter()
        .filter_map(|dir| {
            let modified = std::fs::metadata(dir.join("config.json"))
                .ok()?
                .modified()
                .ok()?;
            Some((modified, dir))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, dir)| dir)
}

/// The per-install folders under `Claude-Data` (`claude_<publisher>`).
#[cfg(windows)]
fn claude_data_dirs(local_app_data: &Path) -> Vec<PathBuf> {
    let Ok(entries) =
        crate::security_limits::read_dir_without_links(&local_app_data.join("Claude-Data"))
    else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .starts_with("claude_")
        })
        .map(|entry| entry.path())
        .collect()
}

/// Files that, while Desktop runs, are held open.
#[cfg(windows)]
const LOCK_PROBES: &[&str] = &[
    "lockfile",
    "Network/Cookies",
    "Cookies",
    "Local Storage/leveldb/LOCK",
];

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
