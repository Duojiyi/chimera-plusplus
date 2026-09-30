//! Adding an account with the official CLI: `codex login --device-auth` in a
//! private temporary `CODEX_HOME` with the file credential store. The device
//! URL and one-time code are what the user types into the browser, so they
//! are shown; the `auth.json` the CLI writes goes straight into the vault
//! and the temporary home is scrubbed and removed. Codex's own client id,
//! endpoints and file format are used as-is; nothing here reimplements them.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::identity::{classify, AccountIdentity, LoginClass};
use super::vault::{secure_remove_dir, SlotSource, Vault};
use crate::error::AppError;

pub(crate) const LOGIN_COMMAND_LABEL: &str = "codex login --device-auth";
/// Codex prints "expires in 15 minutes" for the device code.
const DEVICE_CODE_LIFETIME_SECS: i64 = 15 * 60;
const PROMPT_WAIT: Duration = Duration::from_secs(30);
const MAX_CAPTURED_OUTPUT: usize = 64 * 1024;
/// `-c` goes before the subcommand: `codex login` takes the root overrides.
/// The bare value is not valid TOML, so Codex reads it as the string "file".
const LOGIN_ARGS: [&str; 4] = [
    "-c",
    "cli_auth_credentials_store=file",
    "login",
    "--device-auth",
];
const LOGIN_HOME_CONFIG: &str = "cli_auth_credentials_store = \"file\"\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DevicePrompt {
    pub verification_url: String,
    pub user_code: String,
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            // CSI sequences: ESC [ ... final byte in @..~
            if chars.next() == Some('[') {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn is_user_code(line: &str) -> bool {
    (4..=32).contains(&line.len())
        && line
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && line.bytes().any(|byte| byte.is_ascii_alphanumeric())
}

fn is_allowed_verification_url(url: &url::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host_ok = host.eq_ignore_ascii_case("auth.openai.com")
        || host.eq_ignore_ascii_case("chat.openai.com")
        || host.eq_ignore_ascii_case("chatgpt.com")
        || host.ends_with(".openai.com");
    host_ok && url.path().contains("/device")
}

/// Parses the prompt of `codex login --device-auth` (openai/codex
/// `login/src/device_code_auth.rs`, rust-v0.157.0): an https link on its
/// own line, then the one-time code on the next non-empty line.
pub(crate) fn parse_device_prompt(output: &str) -> Option<DevicePrompt> {
    let text = strip_ansi(output);
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let verification_url = lines.by_ref().find(|line| {
        !line.contains(char::is_whitespace)
            && url::Url::parse(line).is_ok_and(|url| is_allowed_verification_url(&url))
    })?;
    let user_code = lines.find(|line| is_user_code(line))?;
    Some(DevicePrompt {
        verification_url: verification_url.to_string(),
        user_code: user_code.to_string(),
    })
}

#[derive(Default)]
struct CapturedOutput {
    stdout: String,
    stderr: String,
}

fn pipe_into(
    mut source: impl Read + Send + 'static,
    output: Arc<Mutex<CapturedOutput>>,
    stderr: bool,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            let read = match source.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let Ok(mut output) = output.lock() else {
                break;
            };
            let target = if stderr {
                &mut output.stderr
            } else {
                &mut output.stdout
            };
            if target.len() < MAX_CAPTURED_OUTPUT {
                target.push_str(&String::from_utf8_lossy(&buffer[..read]));
            }
        }
    });
}

struct ActiveLogin {
    flow_id: String,
    home: PathBuf,
    child: Child,
    output: Arc<Mutex<CapturedOutput>>,
    expires_at: DateTime<Utc>,
}

impl ActiveLogin {
    fn stderr(&self) -> String {
        self.output
            .lock()
            .map(|output| output.stderr.clone())
            .unwrap_or_default()
    }

    fn finish(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        secure_remove_dir(&self.home);
    }
}

/// One login at a time: starting another cancels the previous one.
static ACTIVE_LOGIN: Mutex<Option<ActiveLogin>> = Mutex::new(None);

#[derive(Debug, Clone)]
pub(crate) struct StartedLogin {
    pub flow_id: String,
    pub prompt: DevicePrompt,
    pub expires_at: DateTime<Utc>,
}

pub(crate) enum LoginPoll {
    Pending,
    Completed(AccountIdentity, Value),
    Failed(AppError),
    Expired,
}

fn active_login() -> Result<std::sync::MutexGuard<'static, Option<ActiveLogin>>, AppError> {
    ACTIVE_LOGIN
        .lock()
        .map_err(|_| AppError::Lock("账号登录状态不可用".to_string()))
}

fn cli_not_found() -> AppError {
    AppError::localized(
        "official_accounts.cli_not_found",
        "未找到 Codex CLI，无法用设备码添加账号；也可以在 Codex 中登录后选择「保存当前登录」",
        "Codex CLI was not found; you can also sign in inside Codex and save the current login",
    )
}

/// Fixed messages only: the CLI's own output is never echoed.
fn login_failed(stderr: &str) -> AppError {
    if stderr.contains("device code login is not enabled") {
        return AppError::localized(
            "official_accounts.device_login_disabled",
            "此工作区未开启设备码登录，请在 Codex 中登录后选择「保存当前登录」",
            "Device-code login is disabled for this workspace; sign in inside Codex and save the current login",
        );
    }
    AppError::localized(
        "official_accounts.login_failed",
        "Codex 登录未完成，请重试",
        "The Codex login did not complete; try again",
    )
}

fn spawn_login(programs: &[PathBuf], home: &Path) -> Result<Child, AppError> {
    for program in programs {
        let mut command = crate::codex_config::codex_command(program, &LOGIN_ARGS, Some(home));
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error) => log::debug!(
                "Codex CLI candidate {} could not start login: {}",
                program.display(),
                error.kind()
            ),
        }
    }
    Err(cli_not_found())
}

/// Starts a device-code login and waits for its URL and code.
pub(crate) fn start(vault: &Vault) -> Result<StartedLogin, AppError> {
    start_with_programs(vault, &crate::codex_config::codex_cli_candidates())
}

fn start_with_programs(vault: &Vault, programs: &[PathBuf]) -> Result<StartedLogin, AppError> {
    {
        let mut active = active_login()?;
        if let Some(previous) = active.take() {
            previous.finish();
        }
    }
    for stale in vault.stale_login_homes() {
        secure_remove_dir(&stale);
    }

    let home = vault.new_login_home()?;
    let spawned =
        crate::config::atomic_write(&home.join("config.toml"), LOGIN_HOME_CONFIG.as_bytes())
            .and_then(|()| spawn_login(programs, &home));
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            secure_remove_dir(&home);
            return Err(error);
        }
    };
    let output = Arc::new(Mutex::new(CapturedOutput::default()));
    if let Some(stdout) = child.stdout.take() {
        pipe_into(stdout, output.clone(), false);
    }
    if let Some(stderr) = child.stderr.take() {
        pipe_into(stderr, output.clone(), true);
    }
    let started = Utc::now();
    let login = ActiveLogin {
        flow_id: uuid::Uuid::new_v4().to_string(),
        home,
        child,
        output,
        expires_at: started + chrono::Duration::seconds(DEVICE_CODE_LIFETIME_SECS),
    };
    let flow_id = login.flow_id.clone();
    let expires_at = login.expires_at;
    {
        let mut active = active_login()?;
        *active = Some(login);
    }

    let deadline = Instant::now() + PROMPT_WAIT;
    let prompt = loop {
        let (parsed, exited, stderr) = {
            let mut active = active_login()?;
            let Some(login) = active.as_mut().filter(|l| l.flow_id == flow_id) else {
                return Err(AppError::localized(
                    "official_accounts.login_cancelled",
                    "登录已取消",
                    "Login was cancelled",
                ));
            };
            let parsed = login
                .output
                .lock()
                .ok()
                .and_then(|output| parse_device_prompt(&output.stdout));
            let exited = !matches!(login.child.try_wait(), Ok(None));
            let stderr = login.stderr();
            (parsed, exited, stderr)
        };
        if let Some(prompt) = parsed {
            break prompt;
        }
        if exited || Instant::now() >= deadline {
            std::thread::sleep(Duration::from_millis(100));
            let mut active = active_login()?;
            let stderr = if let Some(login) = active.take() {
                let err = login.stderr();
                login.finish();
                err
            } else {
                stderr
            };
            return Err(login_failed(&stderr));
        }
        std::thread::sleep(Duration::from_millis(100));
    };

    let started = StartedLogin {
        flow_id,
        prompt,
        expires_at,
    };
    Ok(started)
}

/// Reads the `auth.json` a CLI login wrote into `home` and stores it in the
/// identity's slot. This and the live `auth.json` are the only sources that
/// may update a slot.
pub(crate) fn capture_cli_login(
    vault: &Vault,
    home: &Path,
) -> Result<(AccountIdentity, Value), AppError> {
    let path = home.join("auth.json");
    let bytes =
        crate::security_limits::read_limited(&path, crate::security_limits::MAX_CONFIG_FILE_BYTES)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    AppError::localized(
                        "official_accounts.no_login_file",
                        "Codex 没有写出登录文件（可能被系统策略改为钥匙串存储）",
                        "Codex did not write a login file (a policy may force the keyring store)",
                    )
                } else {
                    AppError::io(&path, error)
                }
            })?;
    let auth: Value = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::Config("Codex 登录文件无法解析".to_string()))?;
    let LoginClass::Chatgpt(identity) = classify(&auth) else {
        return Err(AppError::localized(
            "official_accounts.incomplete_login",
            "登录结果不是完整的 ChatGPT 登录，未保存",
            "The login is not a complete ChatGPT login; nothing was saved",
        ));
    };
    vault.store_slot(&identity, &auth, SlotSource::Cli)?;
    Ok((identity, auth))
}

pub(crate) fn poll(vault: &Vault, flow_id: &str) -> Result<LoginPoll, AppError> {
    let mut active = active_login()?;
    let Some(login) = active.as_mut().filter(|login| login.flow_id == flow_id) else {
        return Err(AppError::localized(
            "official_accounts.no_login",
            "登录流程不存在或已结束",
            "This login is not running",
        ));
    };
    let exit = login.child.try_wait();
    let outcome = match exit {
        Ok(None) if Utc::now() < login.expires_at => return Ok(LoginPoll::Pending),
        Ok(None) => LoginPoll::Expired,
        Ok(Some(status)) if status.success() => match capture_cli_login(vault, &login.home) {
            Ok((identity, auth)) => LoginPoll::Completed(identity, auth),
            Err(error) => LoginPoll::Failed(error),
        },
        Ok(Some(_)) | Err(_) => LoginPoll::Failed(login_failed(&login.stderr())),
    };
    if let Some(login) = active.take() {
        login.finish();
    }
    Ok(outcome)
}

pub(crate) fn cancel(flow_id: &str) -> Result<(), AppError> {
    let mut active = active_login()?;
    if active
        .as_ref()
        .is_some_and(|login| login.flow_id == flow_id)
    {
        if let Some(login) = active.take() {
            login.finish();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::identity::test_support::{chatgpt_login, identity};
    use super::*;
    use tempfile::TempDir;

    const PROMPT: &str = "\nWelcome to Codex [v\x1b[90m0.157.0\x1b[0m]\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mK7QD-9XMP\x1b[0m\n\n\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\x1b[0m\n";

    #[test]
    fn device_prompt_is_parsed_from_the_cli_output() {
        assert_eq!(
            parse_device_prompt(PROMPT),
            Some(DevicePrompt {
                verification_url: "https://auth.openai.com/codex/device".to_string(),
                user_code: "K7QD-9XMP".to_string(),
            })
        );
        // Partial output (code not printed yet) is not a prompt.
        let partial = &PROMPT[..PROMPT.find("2. Enter").unwrap()];
        assert!(parse_device_prompt(partial).is_none());
        assert!(parse_device_prompt("http://insecure.example/device\nABCD-1234\n").is_none());
    }

    #[test]
    fn login_runs_with_a_private_home_and_the_file_credential_store() {
        assert_eq!(
            LOGIN_ARGS,
            [
                "-c",
                "cli_auth_credentials_store=file",
                "login",
                "--device-auth"
            ]
        );
        let dir = TempDir::new().unwrap();
        let command =
            crate::codex_config::codex_command(Path::new("codex"), &LOGIN_ARGS, Some(dir.path()));
        let home = command
            .get_envs()
            .find(|(key, _)| *key == "CODEX_HOME")
            .and_then(|(_, value)| value);
        assert_eq!(home, Some(dir.path().as_os_str()));
    }

    // ACC-T23: the CLI capture stores a Codex-format auth.json in its own
    // identity's slot and never touches the live login.
    #[test]
    fn cli_capture_stores_the_login_in_its_own_slot() {
        let dir = TempDir::new().unwrap();
        let vault = Vault::open_at(dir.path().join("vault")).unwrap();
        let home = vault.new_login_home().unwrap();
        let login = chatgpt_login("new", "2026-09-27T14:20:00Z");
        std::fs::write(home.join("auth.json"), login.to_string()).unwrap();

        let (captured, auth) = capture_cli_login(&vault, &home).unwrap();
        assert_eq!(captured, identity("new"));
        assert_eq!(auth, login);
        let slot = vault.read_slot(&captured.key()).unwrap().unwrap();
        assert_eq!(slot.source, SlotSource::Cli);
        assert_eq!(slot.auth, login);

        // An API-key or partial login is refused and stores nothing.
        let other = vault.new_login_home().unwrap();
        std::fs::write(
            other.join("auth.json"),
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-x"}"#,
        )
        .unwrap();
        assert!(capture_cli_login(&vault, &other).is_err());
        assert!(capture_cli_login(&vault, &dir.path().join("missing")).is_err());
        assert_eq!(vault.slot_keys(), vec![captured.key()]);
    }

    // ACC-T23 end to end with a stand-in CLI.
    #[cfg(unix)]
    #[test]
    fn device_login_flow_captures_the_cli_login_and_removes_its_home() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let vault = Vault::open_at(dir.path().join("vault")).unwrap();
        let login = chatgpt_login("device", "2026-09-27T14:20:00Z");
        let script = dir.path().join("fake-codex");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n\
                 [ \"$1 $2 $3 $4\" = \"-c cli_auth_credentials_store=file login --device-auth\" ] || exit 3\n\
                 grep -q 'cli_auth_credentials_store = \"file\"' \"$CODEX_HOME/config.toml\" || exit 4\n\
                 printf '1. Open this link\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n2. Enter this one-time code\\n   \\033[94mK7QD-9XMP\\033[0m\\n'\n\
                 sleep 1\n\
                 cat > \"$CODEX_HOME/auth.json\" <<'EOF'\n{login}\nEOF\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let started = start_with_programs(&vault, &[script]).unwrap();
        assert_eq!(started.prompt.user_code, "K7QD-9XMP");
        assert_eq!(
            started.prompt.verification_url,
            "https://auth.openai.com/codex/device"
        );

        let deadline = Instant::now() + Duration::from_secs(20);
        let captured = loop {
            match poll(&vault, &started.flow_id).unwrap() {
                LoginPoll::Pending if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                LoginPoll::Completed(identity, _) => break identity,
                _ => panic!("device login did not complete"),
            }
        };
        assert_eq!(captured, identity("device"));
        assert_eq!(
            vault.read_slot(&captured.key()).unwrap().unwrap().auth,
            login
        );
        assert!(vault.stale_login_homes().is_empty());
        assert!(poll(&vault, &started.flow_id).is_err());
    }
}
