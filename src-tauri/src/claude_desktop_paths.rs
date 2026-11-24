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
    let isolated_home = crate::config::test_home_override();
    let roaming = isolated_home
        .as_ref()
        .map(|path| {
            #[cfg(windows)]
            let folder = "AppData/Roaming";
            #[cfg(target_os = "macos")]
            let folder = "Library/Application Support";
            #[cfg(not(any(windows, target_os = "macos")))]
            let folder = ".config";
            path.join(folder)
        })
        .or_else(dirs::config_dir);
    let mut candidates = Vec::new();
    if let Some(roaming) = roaming {
        candidates.push(roaming.join("Claude"));
    }
    #[cfg(windows)]
    if let Some(local) = isolated_home
        .map(|path| path.join("AppData/Local"))
        .or_else(dirs::data_local_dir)
    {
        candidates.extend(claude_data_dirs(&local));
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

/// A `ps -axo command=` line of the Claude Desktop main process on macOS
/// (helpers live in `Frameworks/… Helper.app` and do not match).
#[cfg(any(target_os = "macos", test))]
pub(crate) fn ps_line_is_claude_desktop(line: &str) -> bool {
    const MAIN: &str = "/Claude.app/Contents/MacOS/Claude";
    line.find(MAIN).is_some_and(|start| {
        let rest = &line[start + MAIN.len()..];
        rest.is_empty() || rest.starts_with(' ')
    })
}

#[cfg(unix)]
pub(crate) fn ps_command_lines() -> Option<String> {
    let mut command = std::process::Command::new("ps");
    command.args(["-axo", "command="]);
    match crate::process_utils::output_with_timeout(
        command,
        std::time::Duration::from_secs(5),
        crate::security_limits::MAX_PROCESS_OUTPUT_BYTES,
    ) {
        Ok(output) => Some(String::from_utf8_lossy(&output.stdout).into_owned()),
        Err(error) => {
            log::warn!("读取进程列表失败: {error}");
            None
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn claude_desktop_running_macos() -> bool {
    ps_command_lines().is_some_and(|text| text.lines().any(ps_line_is_claude_desktop))
}

#[cfg(any(target_os = "macos", test))]
fn parse_singleton_lock_pid(target: &str) -> Option<i32> {
    let (host, pid_str) = target.rsplit_once('-')?;
    if host.is_empty()
        || host.ends_with('-')
        || pid_str.is_empty()
        || !pid_str.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let pid = pid_str.parse::<i32>().ok()?;
    (pid > 0).then_some(pid)
}

#[cfg(target_os = "macos")]
fn singleton_lock_held(dir: &Path) -> bool {
    let lock = dir.join("SingletonLock");
    let Ok(target) = std::fs::read_link(&lock) else {
        return false;
    };
    let Some(pid) = target.to_str().and_then(parse_singleton_lock_pid) else {
        return false;
    };
    // kill(pid, 0) returns 0 if process exists or -1 with EPERM if owned by another user.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(target_os = "macos")]
pub(crate) fn data_locked(dir: &Path) -> bool {
    if singleton_lock_held(dir) {
        return true;
    }
    // Only fall back to the global process list for the real macOS Claude data
    // directories (never for isolated test homes or temp dirs).
    if crate::config::test_home_override().is_some() {
        return false;
    }
    let Some(config_dir) = dirs::config_dir() else {
        return false;
    };
    let is_real_claude_dir = dir == config_dir.join("Claude")
        || dir == config_dir.join("Claude-3p")
        || default_user_data_dir().is_some_and(|default_dir| default_dir == dir);
    is_real_claude_dir && claude_desktop_running_macos()
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn data_locked(_dir: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_singleton_lock_pid_extracts_positive_pid() {
        assert_eq!(parse_singleton_lock_pid("MacBook.local-4219"), Some(4219));
        assert_eq!(parse_singleton_lock_pid("host-name-99"), Some(99));
        assert_eq!(parse_singleton_lock_pid("host-0"), None);
        assert_eq!(parse_singleton_lock_pid("host--5"), None);
        assert_eq!(parse_singleton_lock_pid("not-a-pid"), None);
    }
}
