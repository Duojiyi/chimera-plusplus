//! Claude 多账号。
//!
//! - Claude Code（[`code`]）：账号 = 一份已保存的登录。所有账号共用同一个
//!   Claude Code 配置目录，会话、历史、设置、MCP 都不搬动；切换只改写
//!   `.credentials.json` 的 `claudeAiOauth` 与 `.claude.json` 的
//!   `oauthAccount`，其余字段原样保留。保存的登录加密存放在固定位置的
//!   保险库里，从不明文落盘、不写日志、不发给前端。
//! - Claude Desktop（[`desktop`]）：每个账号一个 Chromium `--user-data-dir`，
//!   登录态、设置、MCP 互相独立，多个账号可以同时开着。
//!
//! 不伪造或随机化任何设备标识，不做令牌池轮换。

use std::path::Path;

use crate::error::AppError;

pub(crate) mod code;
pub(crate) mod desktop;
pub(crate) mod quota;

const MAX_ID_LEN: usize = 64;
const MAX_NAME_CHARS: usize = 40;

/// Lowercase letters, digits and inner `-`: no separators, dots or drive
/// letters, so a valid id can only name a direct child of its root.
pub(crate) fn validate_account_id(id: &str) -> Result<(), AppError> {
    let valid = !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !id.starts_with('-')
        && !id.ends_with('-');
    if valid {
        Ok(())
    } else {
        Err(AppError::InvalidInput("账号标识无效".to_string()))
    }
}

/// `root/<id><suffix>`, checked to stay directly inside `root`.
pub(crate) fn child_path(
    root: &Path,
    id: &str,
    suffix: &str,
) -> Result<std::path::PathBuf, AppError> {
    validate_account_id(id)?;
    let path = root.join(format!("{id}{suffix}"));
    if path.parent() != Some(root) {
        return Err(AppError::InvalidInput("账号标识无效".to_string()));
    }
    Ok(path)
}

pub(crate) fn normalize_account_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("请输入账号名称".to_string()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::InvalidInput(format!(
            "账号名称最多 {MAX_NAME_CHARS} 个字符"
        )));
    }
    if name.chars().any(char::is_control) {
        return Err(AppError::InvalidInput(
            "账号名称不能包含控制字符".to_string(),
        ));
    }
    Ok(name.to_string())
}

/// A display name that fits [`normalize_account_name`], cut to length.
pub(crate) fn fitted_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    if cleaned.trim().is_empty() {
        fallback.to_string()
    } else {
        cleaned.trim().to_string()
    }
}

pub(crate) fn new_account_id() -> String {
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("a{}", &random[..11])
}

/// Text of a JSON file without a UTF-8 BOM (Notepad adds one).
pub(crate) fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

/// Plan label from `oauthAccount.organizationType` (refreshed by Claude Code
/// from the profile API) or, failing that, the credential's
/// `subscriptionType`. Unknown values show no plan.
pub(crate) fn plan_label(
    organization_type: Option<&str>,
    subscription_type: Option<&str>,
) -> Option<&'static str> {
    let from_org = organization_type.and_then(|value| match value {
        "claude_max" => Some("Max"),
        "claude_pro" => Some("Pro"),
        "claude_team" => Some("Team"),
        "claude_enterprise" => Some("Enterprise"),
        _ => None,
    });
    from_org.or_else(|| {
        subscription_type.and_then(|value| match value.to_ascii_lowercase().as_str() {
            "max" => Some("Max"),
            "pro" => Some("Pro"),
            "team" => Some("Team"),
            "enterprise" => Some("Enterprise"),
            _ => None,
        })
    })
}

// ===== running-process checks =====

/// Whether a Windows image path is the Claude Desktop app (Squirrel, MSIX or
/// a machine-wide install) — not the Claude Code CLI, which is also
/// `claude.exe` but lives elsewhere (`~\.local\bin`, npm, WinGet).
#[cfg(any(windows, test))]
pub(crate) fn is_claude_desktop_image(path: &str) -> bool {
    let text = path.replace('/', "\\").to_ascii_lowercase();
    text.ends_with("\\claude.exe")
        && [
            "\\anthropicclaude\\",
            "\\windowsapps\\claude_",
            "\\programs\\claude\\",
            "\\program files\\claude\\",
            "\\program files (x86)\\claude\\",
        ]
        .iter()
        .any(|marker| text.contains(marker))
}

/// A Claude Code CLI process on Windows: the native `claude.exe` (anything
/// but the Desktop app) or Node / Bun running the npm package.
#[cfg(any(windows, test))]
pub(crate) fn windows_process_is_claude_code(executable: &str, command_line: &str) -> bool {
    let exe = executable.replace('/', "\\").to_ascii_lowercase();
    let name = exe.rsplit('\\').next().unwrap_or_default();
    if name == "claude.exe" {
        return !is_claude_desktop_image(executable);
    }
    command_line
        .replace('\\', "/")
        .to_ascii_lowercase()
        .contains("@anthropic-ai/claude-code")
}

/// A `ps -axo command=` line of a Claude Code CLI process.
#[cfg(any(unix, test))]
pub(crate) fn ps_line_is_claude_code(line: &str) -> bool {
    let line = line.trim();
    let program = line.split_whitespace().next().unwrap_or_default();
    program.rsplit('/').next() == Some("claude") || line.contains("@anthropic-ai/claude-code")
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
fn ps_command_lines() -> Option<String> {
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

/// Whether a Claude Code CLI is running. Unknown (the check itself failed)
/// reads as not running; the switch still re-checks the files it writes.
pub(crate) fn claude_code_running() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Command lines are needed to tell the npm CLI from other Node
        // processes; `Get-Process` does not expose them.
        // No double quotes: they would need escaping through the command line.
        let script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; \
            Get-CimInstance Win32_Process | \
            Where-Object { @('claude.exe','node.exe','bun.exe') -contains $_.Name } | \
            ForEach-Object { [string]$_.ExecutablePath + '|' + [string]$_.CommandLine }";
        let mut command = std::process::Command::new("powershell");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW);
        match crate::process_utils::output_with_timeout(
            command,
            std::time::Duration::from_secs(10),
            crate::security_limits::MAX_PROCESS_OUTPUT_BYTES,
        ) {
            Ok(output) if output.status.success() => {
                crate::process_utils::decode_console_output(&output.stdout)
                    .lines()
                    .filter_map(|line| line.split_once('|'))
                    .any(|(exe, command_line)| windows_process_is_claude_code(exe, command_line))
            }
            // Unknown counts as running: the user is asked before switching
            // instead of the switch going ahead unchecked.
            Ok(output) => {
                log::warn!(
                    "读取进程列表失败（{}），无法确认 Claude Code 是否在运行",
                    output.status
                );
                true
            }
            Err(error) => {
                log::warn!("读取进程列表失败，无法确认 Claude Code 是否在运行: {error}");
                true
            }
        }
    }
    #[cfg(unix)]
    {
        // Unknown (no `ps`) counts as running, as on Windows.
        ps_command_lines().is_none_or(|text| text.lines().any(ps_line_is_claude_code))
    }
    #[cfg(not(any(windows, unix)))]
    {
        false
    }
}

/// Any Claude Desktop process with a top-level window, including one hidden
/// in the tray. Same native, path-checked enumeration as the Codex startup
/// probe (no `Get-Process`, whose `.Path` is often empty for packaged apps).
#[cfg(windows)]
pub(crate) fn claude_desktop_running() -> bool {
    use std::collections::HashSet;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId};

    unsafe extern "system" fn record_window(hwnd: HWND, param: LPARAM) -> i32 {
        let pids = unsafe { &mut *(param as *mut HashSet<u32>) };
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid != 0 {
            pids.insert(pid);
        }
        1
    }
    fn image_path(pid: u32) -> Option<String> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let mut buffer = vec![0_u16; 32_768];
        let mut size = buffer.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size)
        };
        unsafe { CloseHandle(handle) };
        if ok == 0 {
            return None;
        }
        Some(
            std::ffi::OsString::from_wide(&buffer[..size as usize])
                .to_string_lossy()
                .into_owned(),
        )
    }

    let mut pids: HashSet<u32> = HashSet::new();
    if unsafe { EnumWindows(Some(record_window), &mut pids as *mut _ as LPARAM) } == 0 {
        log::warn!("枚举窗口失败，无法确认 Claude Desktop 是否在运行");
        return false;
    }
    pids.into_iter()
        .filter_map(image_path)
        .any(|path| is_claude_desktop_image(&path))
}

#[cfg(target_os = "macos")]
pub(crate) fn claude_desktop_running() -> bool {
    ps_command_lines().is_some_and(|text| text.lines().any(ps_line_is_claude_desktop))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn claude_desktop_running() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_ids_are_plain_lowercase_names() {
        for id in ["a1b2c3d4e5f6", "work", "team-2"] {
            assert!(validate_account_id(id).is_ok(), "{id}");
        }
        let long = "a".repeat(MAX_ID_LEN + 1);
        for id in [
            "",
            "-lead",
            "trail-",
            "Upper",
            "a/b",
            "a\\b",
            "..",
            ".deleting-a",
            "c:",
            "名字",
            long.as_str(),
        ] {
            assert!(validate_account_id(id).is_err(), "{id}");
        }
        let generated = new_account_id();
        assert_eq!(generated.len(), 12);
        assert!(validate_account_id(&generated).is_ok());
    }

    #[test]
    fn child_paths_stay_directly_under_root() {
        let root = Path::new("/data/accounts");
        assert_eq!(
            child_path(root, "work", ".json").unwrap(),
            root.join("work.json")
        );
        assert!(child_path(root, "../work", "").is_err());
        assert!(child_path(root, "work/../../x", "").is_err());
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(normalize_account_name("  工作号 ").unwrap(), "工作号");
        assert!(normalize_account_name("   ").is_err());
        assert!(normalize_account_name("a\u{0007}b").is_err());
        assert!(normalize_account_name(&"号".repeat(MAX_NAME_CHARS)).is_ok());
        assert!(normalize_account_name(&"号".repeat(MAX_NAME_CHARS + 1)).is_err());
        assert_eq!(fitted_name(" \u{0007} ", "Claude 账号"), "Claude 账号");
        assert_eq!(
            fitted_name(&"x".repeat(80), "f").chars().count(),
            MAX_NAME_CHARS
        );
    }

    #[test]
    fn plans_come_from_the_profile_then_the_credential() {
        assert_eq!(plan_label(Some("claude_max"), Some("pro")), Some("Max"));
        assert_eq!(plan_label(Some("claude_future"), Some("pro")), Some("Pro"));
        assert_eq!(plan_label(None, Some("Team")), Some("Team"));
        assert_eq!(plan_label(None, Some("free")), None);
        assert_eq!(plan_label(None, None), None);
    }

    #[test]
    fn only_the_desktop_app_counts_as_running_claude_desktop() {
        for path in [
            r"C:\Users\me\AppData\Local\AnthropicClaude\app-1.0.0\Claude.exe",
            r"C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe",
            r"C:\Users\me\AppData\Local\Programs\Claude\Claude.exe",
            r"C:\Program Files\Claude\Claude.exe",
        ] {
            assert!(is_claude_desktop_image(path), "{path}");
        }
        for path in [
            r"C:\Users\me\.local\bin\claude.exe",
            r"C:\Users\me\AppData\Local\Microsoft\WinGet\Packages\Anthropic.ClaudeCode\claude.exe",
            r"C:\Users\me\AppData\Local\AnthropicClaude\Update.exe",
            r"C:\Program Files\nodejs\node.exe",
        ] {
            assert!(!is_claude_desktop_image(path), "{path}");
        }
        assert!(ps_line_is_claude_desktop(
            "/Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=/p"
        ));
        assert!(ps_line_is_claude_desktop(
            "/Applications/Claude.app/Contents/MacOS/Claude"
        ));
        assert!(!ps_line_is_claude_desktop(
            "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu"
        ));
    }

    #[test]
    fn claude_code_cli_is_told_apart_from_desktop_and_other_node() {
        assert!(windows_process_is_claude_code(
            r"C:\Users\me\.local\bin\claude.exe",
            "claude"
        ));
        assert!(windows_process_is_claude_code(
            r"C:\Program Files\nodejs\node.exe",
            r#""node" C:\Users\me\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js"#
        ));
        assert!(!windows_process_is_claude_code(
            r"C:\Users\me\AppData\Local\AnthropicClaude\app-1.0.0\Claude.exe",
            "Claude.exe"
        ));
        assert!(!windows_process_is_claude_code(
            r"C:\Program Files\nodejs\node.exe",
            "node server.js"
        ));
        assert!(ps_line_is_claude_code("claude --resume"));
        assert!(ps_line_is_claude_code("/Users/me/.local/bin/claude"));
        assert!(ps_line_is_claude_code(
            "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"
        ));
        assert!(!ps_line_is_claude_code(
            "/Applications/Claude.app/Contents/MacOS/Claude"
        ));
        assert!(!ps_line_is_claude_code("vim claude.md"));
    }
}
