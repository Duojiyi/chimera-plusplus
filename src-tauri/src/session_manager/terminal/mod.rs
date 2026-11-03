use std::process::Command;

/// The only commands a session terminal may run: a provider's resume command
/// with an inert session id, exactly as the session scanners build them.
const RESUME_COMMAND_PREFIXES: [&str; 5] = [
    "claude --resume",
    "codex resume",
    "gemini --resume",
    "grok --resume",
    "opencode -s",
];

fn is_resume_command(command: &str) -> bool {
    RESUME_COMMAND_PREFIXES.iter().any(|prefix| {
        command
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix(" \""))
            .and_then(|rest| rest.strip_suffix('"'))
            .is_some_and(|id| {
                id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
    })
}

pub fn launch_terminal(target: &str, command: &str, cwd: Option<&str>) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Resume command is empty".to_string());
    }
    if !is_resume_command(command) {
        return Err("Only a session resume command can be launched in a terminal".to_string());
    }

    if !cfg!(target_os = "macos") {
        return Err("Terminal resume is only supported on macOS".to_string());
    }

    match target {
        "terminal" => launch_macos_terminal(command, cwd),
        "iTerm" | "iterm" => launch_iterm(command, cwd),
        "ghostty" => launch_ghostty(command, cwd),
        "kitty" => launch_kitty(command, cwd),
        "wezterm" => launch_wezterm(command, cwd),
        "kaku" => launch_kaku(command, cwd),
        "alacritty" => launch_alacritty(command, cwd),
        #[cfg(unix)]
        "warp" => launch_warp(command, cwd),
        _ => Err(format!("Unsupported terminal target: {target}")),
    }
}

fn launch_macos_terminal(command: &str, cwd: Option<&str>) -> Result<(), String> {
    let full_command = build_shell_command(command, cwd);
    let escaped = escape_osascript(&full_command);
    let script = format!(
        r#"tell application "Terminal"
    activate
    do script "{escaped}"
end tell"#
    );

    let status = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|e| format!("Failed to launch Terminal: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Terminal command execution failed".to_string())
    }
}

fn launch_iterm(command: &str, cwd: Option<&str>) -> Result<(), String> {
    let full_command = build_shell_command(command, cwd);
    let escaped = escape_osascript(&full_command);
    // iTerm2 AppleScript to create a new window and execute command
    let script = format!(
        r#"tell application "iTerm"
    activate
    create window with default profile
    tell current session of current window
        write text "{escaped}"
    end tell
end tell"#
    );

    let status = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|e| format!("Failed to launch iTerm: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("iTerm command execution failed".to_string())
    }
}

fn launch_ghostty(command: &str, cwd: Option<&str>) -> Result<(), String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let mut args = vec![
        "-na".to_string(),
        "Ghostty".to_string(),
        "--args".to_string(),
        "--quit-after-last-window-closed=true".to_string(),
    ];

    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            args.push(format!("--working-directory={dir}"));
        }
    }

    args.push("-e".to_string());
    args.push(shell);
    args.push("-l".to_string());
    args.push("-c".to_string());
    args.push(command.to_string());

    let status = Command::new("open")
        .args(&args)
        .status()
        .map_err(|e| format!("Failed to launch Ghostty: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch Ghostty. Make sure it is installed.".to_string())
    }
}

fn launch_kitty(command: &str, cwd: Option<&str>) -> Result<(), String> {
    let full_command = build_shell_command(command, cwd);

    // 获取用户默认 shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let status = Command::new("open")
        .arg("-na")
        .arg("kitty")
        .arg("--args")
        .arg("-e")
        .arg(&shell)
        .arg("-l")
        .arg("-c")
        .arg(&full_command)
        .status()
        .map_err(|e| format!("Failed to launch Kitty: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch Kitty. Make sure it is installed.".to_string())
    }
}

fn launch_wezterm(command: &str, cwd: Option<&str>) -> Result<(), String> {
    // wezterm start --cwd ... -- command
    // To invoke via `open`, we use `open -na "WezTerm" --args start ...`
    let args = build_wezterm_compatible_args("WezTerm", command, cwd);

    let status = Command::new("open")
        .args(args.iter().map(String::as_str))
        .status()
        .map_err(|e| format!("Failed to launch WezTerm: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch WezTerm.".to_string())
    }
}

fn launch_kaku(command: &str, cwd: Option<&str>) -> Result<(), String> {
    // Kaku is a WezTerm-derived terminal and keeps a compatible `start` entrypoint.
    let args = build_wezterm_compatible_args("Kaku", command, cwd);

    let status = Command::new("open")
        .args(args.iter().map(String::as_str))
        .status()
        .map_err(|e| format!("Failed to launch Kaku: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch Kaku.".to_string())
    }
}

fn build_wezterm_compatible_args(app_name: &str, command: &str, cwd: Option<&str>) -> Vec<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    build_wezterm_compatible_args_with_shell(app_name, command, cwd, &shell)
}

fn build_wezterm_compatible_args_with_shell(
    app_name: &str,
    command: &str,
    cwd: Option<&str>,
    shell: &str,
) -> Vec<String> {
    let full_command = build_shell_command(command, None);
    let mut args = vec![
        "-na".to_string(),
        app_name.to_string(),
        "--args".to_string(),
        "start".to_string(),
    ];

    if let Some(dir) = cwd {
        args.push("--cwd".to_string());
        args.push(dir.to_string());
    }

    // Invoke shell to run the command string (to handle pipes, etc)
    args.push("--".to_string());
    args.push(shell.to_string());
    args.push("-c".to_string());
    args.push(full_command);
    args
}

#[cfg(unix)]
fn launch_warp(command: &str, cwd: Option<&str>) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let cwd = cwd.ok_or("Failed to resume session without cwd")?;

    let mut script_file = tempfile::Builder::new()
        .disable_cleanup(true)
        .permissions(std::fs::Permissions::from_mode(0o755))
        .tempfile_in(cwd)
        .map_err(|e| format!("Failed to create temporary script file for launching Warp: {e}"))?;

    writeln!(
        &mut script_file,
        r#"#!/usr/bin/env sh

        rm -- "$0"

        exec {command}
        "#,
    )
    .map_err(|e| format!("Failed to write to temporary script file for Warp: {e}"))?;

    let mut warp_url = url::Url::parse("warp://action/new_tab").unwrap();
    warp_url
        .query_pairs_mut()
        .append_pair("path", &script_file.path().to_string_lossy());
    let warp_url = warp_url.to_string();

    let script_path = script_file.path().to_path_buf();
    let status = Command::new("open")
        .args(["-a", "Warp", &warp_url])
        .status();

    match status {
        Ok(status) if status.success() => Ok(()),
        outcome => {
            // The script deletes itself only once it runs.
            let _ = std::fs::remove_file(&script_path);
            match outcome {
                Ok(_) => Err("Failed to launch Warp.".to_string()),
                Err(e) => Err(format!("Failed to launch Warp: {e}")),
            }
        }
    }
}

fn launch_alacritty(command: &str, cwd: Option<&str>) -> Result<(), String> {
    // Alacritty: open -na Alacritty --args --working-directory ... -e shell -c command
    let full_command = build_shell_command(command, None);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let mut args = vec!["-na", "Alacritty", "--args"];

    if let Some(dir) = cwd {
        args.push("--working-directory");
        args.push(dir);
    }

    args.push("-e");
    args.push(&shell);
    args.push("-c");
    args.push(&full_command);

    let status = Command::new("open")
        .args(&args)
        .status()
        .map_err(|e| format!("Failed to launch Alacritty: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch Alacritty.".to_string())
    }
}

fn build_shell_command(command: &str, cwd: Option<&str>) -> String {
    match cwd {
        Some(dir) if !dir.trim().is_empty() => {
            format!("cd {} && {}", shell_escape(dir), command)
        }
        _ => command.to_string(),
    }
}

/// POSIX 单引号转义。
///
/// **必须是单引号**：双引号内 `$(...)`、反引号、`$VAR` 照常展开，而这里包的是
/// `projectDir`——会话历史里记录的真实项目路径，macOS 允许目录名含 `$` `(` `)`，
/// 所以一个名为 `$(...)` 的目录就足以让命令替换在用户终端里执行。
///
/// 单引号内不做任何展开，唯一的特例是 `'` 自身无法被表示：用「闭合-转义-重开」
/// 的 `'\''` 序列绕过。
fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn escape_osascript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_shell_command_keeps_command_without_cwd_prefix_when_not_provided() {
        assert_eq!(
            build_shell_command("claude --resume abc-123", None),
            "claude --resume abc-123"
        );
    }

    #[test]
    fn wezterm_compatible_terminals_use_start_and_cwd_arguments() {
        let args = build_wezterm_compatible_args_with_shell(
            "Kaku",
            "claude --resume abc-123",
            Some("/tmp/project dir"),
            "/bin/zsh",
        );

        assert_eq!(
            args,
            vec![
                "-na".to_string(),
                "Kaku".to_string(),
                "--args".to_string(),
                "start".to_string(),
                "--cwd".to_string(),
                "/tmp/project dir".to_string(),
                "--".to_string(),
                "/bin/zsh".to_string(),
                "-c".to_string(),
                "claude --resume abc-123".to_string(),
            ]
        );
    }

    #[test]
    fn ghostty_uses_working_directory_arg_for_cwd() {
        // cwd should be passed as --working-directory, not embedded in the shell command string
        // This avoids shell expansion of special characters in directory paths
        let cwd = "/tmp/project dir";
        let command = "claude --resume abc-123";

        // Verify build_shell_command does NOT include cwd when used in ghostty context
        // (ghostty passes cwd via --working-directory flag instead)
        assert_eq!(
            build_shell_command(command, None),
            "claude --resume abc-123"
        );

        // Verify shell_escape works correctly for paths with spaces
        assert_eq!(shell_escape(cwd), "'/tmp/project dir'");
    }

    #[test]
    fn shell_escape_neutralizes_command_substitution_in_directory_names() {
        // 这些字符在 macOS 目录名里全部合法，而 `cwd` 就是会话历史里的
        // `projectDir`——一个名为 `$(...)` 的目录必须原样落到 `cd` 后面，
        // 不能被 shell 求值。旧的双引号实现对这三种全部失守。
        assert_eq!(shell_escape("/tmp/$(id -un)"), "'/tmp/$(id -un)'");
        assert_eq!(shell_escape("/tmp/`id -un`"), "'/tmp/`id -un`'");
        assert_eq!(shell_escape("/tmp/$HOME"), "'/tmp/$HOME'");
    }

    #[test]
    fn shell_escape_handles_embedded_single_quote() {
        // 单引号是单引号包裹法唯一表示不了的字符，靠「闭合-转义-重开」绕过。
        assert_eq!(shell_escape("/tmp/it's"), r"'/tmp/it'\''s'");
    }

    #[test]
    fn shell_escape_survives_the_osascript_layer() {
        // Terminal / iTerm 的链路是两层：shell_escape 的结果先被塞进 AppleScript
        // 字符串字面量，由 escape_osascript 再转义一次，AppleScript 求值后才交给
        // shell。反斜杠会在中间那层被加倍，必须确认最终落到 shell 的字节没变形。
        let escaped = shell_escape("/tmp/it's");
        assert_eq!(escaped, r"'/tmp/it'\''s'");

        let for_applescript = escape_osascript(&escaped);
        assert_eq!(for_applescript, r"'/tmp/it'\\''s'");

        // AppleScript 把 `\\` 求值回单个 `\`，于是 shell 拿到的正是 escaped 本身。
        assert_eq!(for_applescript.replace(r"\\", r"\"), escaped);
    }

    #[test]
    fn build_shell_command_quotes_the_cwd_it_prefixes() {
        // Terminal / iTerm / kitty 三条路径都经这里；ghostty / wezterm / alacritty
        // 走 `cwd = None` 并把目录当独立 argv 传，不受影响。
        assert_eq!(
            build_shell_command("claude --resume x", Some("/tmp/$(id -un)")),
            "cd '/tmp/$(id -un)' && claude --resume x"
        );
    }

    #[test]
    fn only_provider_resume_commands_may_be_launched() {
        for command in [
            "claude --resume \"0b6d-aa_1\"",
            "codex resume \"019a1d9c-7b5e-7c11-8a2e-0123456789ab\"",
            "gemini --resume \"abc123\"",
            "grok --resume \"abc123\"",
            "opencode -s \"ses_123-Ab\"",
        ] {
            assert!(is_resume_command(command), "{command}");
        }
        for command in [
            "",
            "rm -rf ~",
            "codex resume \"x\"; rm -rf ~",
            "codex resume \"$(id)\"",
            "codex resume \"-bad\"",
            "codex resume x",
            "codex resume \"a b\"",
            "codex resume \"a\" && id",
            "sh -c id",
            "claude --resume \"\"",
        ] {
            assert!(!is_resume_command(command), "{command}");
        }
        assert!(launch_terminal("terminal", "touch /tmp/pwned", None).is_err());
    }
}
