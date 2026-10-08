//! Pi-family package management delegates to the native CLIs, never edits lockfiles.
use crate::app_config::AppType;
use std::sync::Mutex;
use std::time::Duration;

static PACKAGE_OPERATION: Mutex<()> = Mutex::new(());

pub(super) fn lock_package_operation() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    PACKAGE_OPERATION
        .try_lock()
        .map_err(|_| "已有 Pi / OMP 包管理或配置操作正在执行，请稍后重试".to_string())
}

#[derive(Clone, Copy, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PiRuntime {
    Pi,
    Omp,
}

#[derive(Clone, Copy, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PluginAction {
    Version,
    InstallRuntime,
    List,
    Install,
    Remove,
    Update,
    Enable,
    Disable,
    Discover,
    Markets,
    AddMarket,
    RemoveMarket,
    RefreshMarkets,
}

// Intentionally npm specs / marketplace IDs only. No flags, paths, URLs, shell
// syntax, feature expressions or version ranges cross this command boundary.
fn valid_package(value: &str) -> bool {
    value.len() <= 214
        && regex::Regex::new(
            r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9._+-]*)?$",
        )
        .expect("static package pattern")
        .is_match(value)
}

fn plan(
    runtime: PiRuntime,
    action: PluginAction,
    target: &str,
) -> Result<(&'static str, Vec<String>), String> {
    use PluginAction::*;
    let tool = if runtime == PiRuntime::Pi {
        "pi"
    } else {
        "omp"
    };
    if action == InstallRuntime {
        if runtime != PiRuntime::Omp || !target.is_empty() {
            return Err("仅支持安装 oh-my-pi，不能指定安装脚本".into());
        }
        return Ok((
            "bun",
            vec![
                "install".into(),
                "-g".into(),
                "@oh-my-pi/pi-coding-agent@18.8.3".into(),
            ],
        ));
    }
    let needs_target = matches!(
        action,
        Install | Remove | Enable | Disable | AddMarket | RemoveMarket
    ) || (runtime == PiRuntime::Omp && action == Update);
    if needs_target {
        let valid = if action == AddMarket {
            regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$")
                .expect("static repository pattern")
                .is_match(target)
                && target.len() <= 214
        } else {
            valid_package(target)
        };
        if !valid {
            return Err("请输入 npm 包名（可带固定版本）或 OMP 的 插件名@市场名；不接受路径、URL、空格或命令参数".into());
        }
    } else if !target.is_empty() {
        return Err("该操作不接受目标参数".into());
    }
    let args: Vec<&str> = match (runtime, action) {
        (_, Version) => vec!["--version"],
        (PiRuntime::Pi, List) => vec!["list"],
        (PiRuntime::Pi, Install) => vec!["install"],
        (PiRuntime::Pi, Remove) => vec!["remove"],
        (PiRuntime::Pi, Update) => vec!["update", "--extensions"],
        (PiRuntime::Omp, List) => vec!["plugin", "list", "--json"],
        (PiRuntime::Omp, Install) => vec!["plugin", "install", "--scope", "user"],
        (PiRuntime::Omp, Remove) => vec!["plugin", "uninstall", "--scope", "user"],
        (PiRuntime::Omp, Update) => vec!["plugin", "upgrade", "--scope", "user"],
        (PiRuntime::Omp, Enable) => vec!["plugin", "enable", "--scope", "user"],
        (PiRuntime::Omp, Disable) => vec!["plugin", "disable", "--scope", "user"],
        (PiRuntime::Omp, Discover) => vec!["plugin", "discover"],
        (PiRuntime::Omp, Markets) => vec!["plugin", "marketplace", "list"],
        (PiRuntime::Omp, AddMarket) => vec!["plugin", "marketplace", "add"],
        (PiRuntime::Omp, RemoveMarket) => vec!["plugin", "marketplace", "remove"],
        (PiRuntime::Omp, RefreshMarkets) => vec!["plugin", "marketplace", "update"],
        _ => return Err("该运行时不支持此操作".into()),
    };
    let mut args: Vec<String> = args.into_iter().map(str::to_owned).collect();
    if needs_target {
        args.push(if runtime == PiRuntime::Pi {
            format!("npm:{target}")
        } else {
            target.to_owned()
        });
    }
    Ok((tool, args))
}

#[tauri::command]
pub(crate) async fn run_pi_plugin_action(
    runtime: PiRuntime,
    action: PluginAction,
    target: Option<String>,
) -> Result<String, String> {
    match runtime {
        PiRuntime::Pi => crate::product_policy::require_app(&AppType::Pi)?,
        PiRuntime::Omp => {
            crate::product_policy::require(crate::product_policy::Capability::MultiTool)?
        }
    }
    // Validate before spawning or acquiring a process slot.
    let (tool, args) = plan(runtime, action, target.as_deref().unwrap_or(""))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = lock_package_operation()?;
        let executable = super::misc::resolve_path_default(tool)
            .ok_or_else(|| format!("未找到 {tool}。请安装工具并重启 Chimera，使 PATH 生效。OMP 需要 Bun >= 1.3.14；Pi 需要 Node >= 22.19。"))?;
        // No project discovery: every action is explicitly user/global scoped.
        let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
        let mut command = std::process::Command::new(executable);
        command.args(args).current_dir(directory.path())
            .env("NO_COLOR", "1").env("FORCE_COLOR", "0");
        #[cfg(not(target_os = "windows"))]
        command.env("PATH", super::misc::cli_execution_path());
        if runtime == PiRuntime::Pi {
            command.env("PI_CODING_AGENT_DIR", crate::pi_config::get_pi_agent_dir().map_err(|e| e.to_string())?);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let timeout = if matches!(action, PluginAction::Version | PluginAction::List | PluginAction::Markets) {
            Duration::from_secs(30)
        } else { Duration::from_secs(10 * 60) };
        let output = crate::process_utils::output_with_timeout(command, timeout, 1024 * 1024)
            .map_err(|e| format!("命令未完成：{e}。请刷新状态；部分文件可能已由原生工具更新。"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() {
            return Err(format!("{tool} 执行失败（{:?}）：\n{}\n{}", output.status.code(), stdout, stderr));
        }
        // Preserve machine-readable stdout for OMP list. Warnings remain visible otherwise.
        if runtime == PiRuntime::Omp && action == PluginAction::List {
            serde_json::from_str::<serde_json::Value>(&stdout)
                .map_err(|_| format!("OMP 返回了无法识别的列表，请检查版本：\n{stdout}\n{stderr}"))?;
            Ok(stdout.into_owned())
        } else {
            Ok(format!("{stdout}\n{stderr}").trim().to_owned())
        }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_shell_paths_and_flags() {
        for input in [
            "--help",
            "../evil",
            "a & calc",
            "a;sh",
            "a%PATH%",
            "a\nwhoami",
            "https://evil",
            "git:repo",
            "a^b",
            "a$(id)",
            "a|b",
            "",
            "@scope",
            "a@^1",
        ] {
            assert!(!valid_package(input), "{input}");
            assert!(plan(PiRuntime::Pi, PluginAction::Install, input).is_err());
        }
    }
    #[test]
    fn scopes_and_native_commands_are_explicit() {
        assert_eq!(
            plan(PiRuntime::Pi, PluginAction::Install, "@scope/pkg@1.2.3")
                .unwrap()
                .1,
            ["install", "npm:@scope/pkg@1.2.3"]
        );
        assert_eq!(
            plan(PiRuntime::Omp, PluginAction::Disable, "review@official")
                .unwrap()
                .1,
            ["plugin", "disable", "--scope", "user", "review@official"]
        );
        assert!(plan(PiRuntime::Pi, PluginAction::Disable, "a").is_err());
        assert!(plan(PiRuntime::Omp, PluginAction::Update, "").is_err());
        assert!(plan(PiRuntime::Pi, PluginAction::List, "a").is_err());
        assert!(plan(PiRuntime::Pi, PluginAction::InstallRuntime, "").is_err());
        assert!(plan(PiRuntime::Omp, PluginAction::AddMarket, "https://evil").is_err());
    }
}
