//! Adding an account with the official CLI: browser or device-code login in a
//! private temporary `CODEX_HOME` with the file credential store. The device
//! URL and one-time code are what the user types into the browser, so they
//! are shown; the captured `auth.json` is returned for transactional vault/line
//! registration and the temporary home is scrubbed and removed. Codex's own client id,
//! endpoints and file format are used as-is; nothing here reimplements them.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::identity::{classify, AccountIdentity, LoginClass};
use super::vault::{secure_remove_dir, Vault};
use crate::error::AppError;

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
        #[cfg(target_os = "windows")]
        if matches!(self.child.try_wait(), Ok(None)) {
            crate::process_utils::terminate_process_tree(self.child.id());
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        secure_remove_dir(&self.home);
    }
}

/// One login at a time: starting another cancels the previous one.
static ACTIVE_LOGIN: Mutex<Option<ActiveLogin>> = Mutex::new(None);
static SHUTTING_DOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static LOGIN_SUSPENDED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn shutdown() {
    SHUTTING_DOWN.store(true, std::sync::atomic::Ordering::SeqCst);
    suspend();
}

pub(crate) fn suspend() {
    LOGIN_SUSPENDED.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut active) = active_login() {
        if let Some(login) = active.take() {
            login.finish();
        }
    }
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn resume_after_failed_shutdown() {
    LOGIN_SUSPENDED.store(false, std::sync::atomic::Ordering::SeqCst);
}

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

pub(super) fn cleanup_orphaned_login_homes(vault: &Vault) -> Result<(), AppError> {
    let active = active_login()?;
    for home in vault.stale_login_homes() {
        if active.as_ref().is_none_or(|login| login.home != home) {
            secure_remove_dir(&home);
        }
    }
    Ok(())
}

fn cli_not_found() -> AppError {
    AppError::localized(
        "official_accounts.cli_not_found",
        "未找到 Codex CLI，无法添加账号；也可以在 Codex 中登录后选择「导入本机登录」",
        "Codex CLI was not found; you can also sign in inside Codex and save the current login",
    )
}

/// Fixed messages only: the CLI's own output is never echoed.
fn login_failed(stderr: &str) -> AppError {
    if stderr.contains("device code login is not enabled") {
        return AppError::localized(
            "official_accounts.device_login_disabled",
            "账号或工作区未开启设备码登录；请在 ChatGPT 安全设置中开启或联系工作区管理员，也可改用浏览器登录或导入本机登录",
            "Device-code login is disabled for this account or workspace; enable it in ChatGPT security settings, contact your administrator, or use browser login or import a local login",
        );
    }
    AppError::localized(
        "official_accounts.login_failed",
        "Codex 登录未完成，请重试",
        "The Codex login did not complete; try again",
    )
}

fn spawn_login(programs: &[PathBuf], home: &Path, browser: bool) -> Result<Child, AppError> {
    for program in programs {
        let args = if browser {
            &LOGIN_ARGS[..3]
        } else {
            &LOGIN_ARGS[..]
        };
        let mut command = crate::codex_config::codex_command(program, args, Some(home));
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
    start_with_mode(vault, programs, false)
}

pub(crate) fn start_browser(vault: &Vault) -> Result<StartedLogin, AppError> {
    start_with_mode(vault, &crate::codex_config::codex_cli_candidates(), true)
}

fn parse_browser_prompt(output: &str) -> Option<DevicePrompt> {
    let text = strip_ansi(output);
    let complete = &text[..text.rfind('\n')?];
    let verification_url = complete.split_whitespace().find(|candidate| {
        url::Url::parse(candidate).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("auth.openai.com")
                && url.path() == "/oauth/authorize"
                && url.username().is_empty()
                && url.password().is_none()
                && url.port_or_known_default() == Some(443)
        })
    })?;
    Some(DevicePrompt {
        verification_url: verification_url.to_string(),
        user_code: String::new(),
    })
}

fn start_with_mode(
    vault: &Vault,
    programs: &[PathBuf],
    browser: bool,
) -> Result<StartedLogin, AppError> {
    let mut active = active_login()?;
    if SHUTTING_DOWN.load(std::sync::atomic::Ordering::SeqCst)
        || LOGIN_SUSPENDED.load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err(AppError::Message("应用正在退出，无法开始登录".to_string()));
    }
    if let Some(previous) = active.take() {
        previous.finish();
    }
    for stale in vault.stale_login_homes() {
        secure_remove_dir(&stale);
    }

    let home = vault.new_login_home()?;
    let spawned =
        crate::config::atomic_write(&home.join("config.toml"), LOGIN_HOME_CONFIG.as_bytes())
            .and_then(|()| spawn_login(programs, &home, browser));
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
    *active = Some(login);
    drop(active);

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
            let parsed = login.output.lock().ok().and_then(|output| {
                if browser {
                    parse_browser_prompt(&output.stdout)
                        .or_else(|| parse_browser_prompt(&output.stderr))
                } else {
                    parse_device_prompt(&output.stdout)
                }
            });
            let exited = !matches!(login.child.try_wait(), Ok(None));
            let stderr = login.stderr();
            (parsed, exited, stderr)
        };
        if let Some(prompt) = parsed {
            break prompt;
        }
        if exited || Instant::now() >= deadline {
            std::thread::sleep(Duration::from_millis(100));
            let stderr = cleanup_failed_start(&flow_id, stderr)?;
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

fn cleanup_failed_start(flow_id: &str, stderr: String) -> Result<String, AppError> {
    let mut active = active_login()?;
    if let Some(login) = active.take_if(|login| login.flow_id == flow_id) {
        let stderr = login.stderr();
        login.finish();
        Ok(stderr)
    } else {
        Ok(stderr)
    }
}

/// Reads and validates the CLI login without mutating the vault.
/// register_cli_login persists it together with its line after the login lock
/// has been released; no account transaction is acquired under ACTIVE_LOGIN.
pub(crate) fn capture_cli_login(home: &Path) -> Result<(AccountIdentity, Value), AppError> {
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
    Ok((identity, auth))
}

pub(crate) fn poll(flow_id: &str) -> Result<LoginPoll, AppError> {
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
        Ok(Some(status)) if status.success() => match capture_cli_login(&login.home) {
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
    fn browser_prompt_accepts_only_the_official_authorize_endpoint() {
        let address = "https://auth.openai.com/oauth/authorize?state=test&code_challenge=challenge";
        assert!(parse_browser_prompt(address).is_none());
        let prompt = parse_browser_prompt(&format!("{address}\n")).unwrap();
        assert_eq!(prompt.verification_url, address);
        assert!(prompt.user_code.is_empty());
        for rejected in [
            "http://auth.openai.com/oauth/authorize",
            "https://auth.openai.com.evil.test/oauth/authorize",
            "https://auth.openai.com/codex/device",
            "https://user@auth.openai.com/oauth/authorize",
            "https://auth.openai.com:444/oauth/authorize",
        ] {
            assert!(parse_browser_prompt(&format!("{rejected}\n")).is_none());
        }
    }

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

    // ACC-T23: capture returns credentials without writing a slot or live login.
    // The registration transaction owns the vault write.
    #[test]
    fn cli_capture_defers_the_slot_write_until_registration() {
        let dir = TempDir::new().unwrap();
        let vault = Vault::open_at(dir.path().join("vault")).unwrap();
        let home = vault.new_login_home().unwrap();
        let login = chatgpt_login("new", "2026-09-27T14:20:00Z");
        std::fs::write(home.join("auth.json"), login.to_string()).unwrap();

        let (captured, auth) = capture_cli_login(&home).unwrap();
        assert_eq!(captured, identity("new"));
        assert_eq!(auth, login);
        assert!(vault.slot_keys().is_empty());

        // An API-key or partial login is refused and stores nothing.
        let other = vault.new_login_home().unwrap();
        std::fs::write(
            other.join("auth.json"),
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-x"}"#,
        )
        .unwrap();
        assert!(capture_cli_login(&other).is_err());
        assert!(capture_cli_login(&dir.path().join("missing")).is_err());
        assert!(vault.slot_keys().is_empty());
    }

    #[cfg(any(unix, windows))]
    struct LoginCleanup;

    #[cfg(any(unix, windows))]
    impl Drop for LoginCleanup {
        fn drop(&mut self) {
            if let Ok(mut active) = active_login() {
                if let Some(login) = active.take() {
                    login.finish();
                }
            }
        }
    }

    #[cfg(any(unix, windows))]
    fn fake_cli(dir: &Path) -> PathBuf {
        std::fs::write(
            dir.join("auth.json"),
            chatgpt_login("device", "2026-09-27T14:20:00Z").to_string(),
        )
        .unwrap();
        #[cfg(unix)]
        let (name, script) = (
            "fake-codex",
            "#!/bin/sh\n\
             [ \"$1 $2 $3 $4\" = \"-c cli_auth_credentials_store=file login --device-auth\" ] || exit 3\n\
             grep -q 'cli_auth_credentials_store = \"file\"' \"$CODEX_HOME/config.toml\" || exit 4\n\
             printf 'https://auth.openai.com/codex/device\\nK7QD-9XMP\\n'\n\
             while [ ! -f \"$CODEX_HOME/finish\" ]; do sleep 0.01; done\n\
             [ ! -f \"$CODEX_HOME/fail\" ] || exit 1\n\
             cat \"$(dirname \"$0\")/auth.json\" > \"$CODEX_HOME/auth.json\"\n",
        );
        #[cfg(windows)]
        let (name, script) = (
            "fake-codex.cmd",
            "@echo off\r\n\
             if not \"%~1\"==\"-c\" exit /b 3\r\n\
             if not \"%~2\"==\"cli_auth_credentials_store=file\" exit /b 3\r\n\
             if not \"%~3\"==\"login\" exit /b 3\r\n\
             if not \"%~4\"==\"--device-auth\" exit /b 3\r\n\
             if not \"%~5\"==\"\" exit /b 3\r\n\
             if not exist \"%CODEX_HOME%\\config.toml\" exit /b 4\r\n\
             echo https://auth.openai.com/codex/device\r\n\
             echo K7QD-9XMP\r\n\
             :wait\r\n\
             if not exist \"%CODEX_HOME%\\finish\" goto wait\r\n\
             if exist \"%CODEX_HOME%\\fail\" exit /b 1\r\n\
             copy /y \"%~dp0auth.json\" \"%CODEX_HOME%\\auth.json\" >nul\r\n\
             exit /b 0\r\n",
        );
        let path = dir.join(name);
        std::fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[cfg(any(unix, windows))]
    fn finish_cli(home: &Path) {
        std::fs::write(home.join("finish"), b"").unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let exited = active_login()
                .unwrap()
                .as_mut()
                .unwrap()
                .child
                .try_wait()
                .unwrap()
                .is_some();
            if exited {
                return;
            }
            assert!(Instant::now() < deadline, "stand-in CLI did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    #[serial_test::serial(official_device_login)]
    fn browser_login_reuses_capture_and_cancellation() {
        let dir = TempDir::new().unwrap();
        let _cleanup = LoginCleanup;
        let vault = Vault::open_at(dir.path().join("vault")).unwrap();
        let program = fake_cli(dir.path());
        let script = std::fs::read_to_string(&program)
            .unwrap()
            .replace("--device-auth", "")
            .replace(
                "https://auth.openai.com/codex/device",
                "https://auth.openai.com/oauth/authorize?state=test",
            );
        std::fs::write(&program, script).unwrap();
        let started = start_with_mode(&vault, std::slice::from_ref(&program), true).unwrap();
        assert!(started.prompt.user_code.is_empty());
        assert!(matches!(
            poll(&started.flow_id).unwrap(),
            LoginPoll::Pending
        ));
        let home = active_login().unwrap().as_ref().unwrap().home.clone();
        finish_cli(&home);
        assert!(matches!(
            poll(&started.flow_id).unwrap(),
            LoginPoll::Completed(_, _)
        ));
        assert!(!home.exists());
        let started = start_with_mode(&vault, &[program], true).unwrap();
        let home = active_login().unwrap().as_ref().unwrap().home.clone();
        cancel(&started.flow_id).unwrap();
        assert!(!home.exists());
        assert!(poll(&started.flow_id).is_err());
    }

    #[test]
    #[serial_test::serial(official_device_login)]
    fn failed_shutdown_can_resume_login_startup() {
        let dir = TempDir::new().unwrap();
        let vault = Vault::open_at(dir.path().join("vault")).unwrap();
        suspend();
        let blocked = start_with_mode(&vault, &[], true).unwrap_err().to_string();
        resume_after_failed_shutdown();
        assert!(blocked.contains("应用正在退出"));
        let resumed = start_with_mode(&vault, &[], true).unwrap_err().to_string();
        assert!(!resumed.contains("应用正在退出"));
        assert!(vault.stale_login_homes().is_empty());
        shutdown();
        resume_after_failed_shutdown();
        let still_exiting = start_with_mode(&vault, &[], true).unwrap_err().to_string();
        SHUTTING_DOWN.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(still_exiting.contains("应用正在退出"));
    }

    #[cfg(any(unix, windows))]
    #[test]
    #[serial_test::serial(official_device_login)]
    fn device_login_survives_vault_reopen_before_pending_and_completed_polls() {
        let dir = TempDir::new().unwrap();
        let _cleanup = LoginCleanup;
        let root = dir.path().join("vault");
        let vault = Vault::open_at(root.clone()).unwrap();
        let started = start_with_programs(&vault, &[fake_cli(dir.path())]).unwrap();
        assert_eq!(started.prompt.user_code, "K7QD-9XMP");
        let home = active_login().unwrap().as_ref().unwrap().home.clone();
        let orphan = vault.new_login_home().unwrap();
        std::fs::write(orphan.join("auth.json"), b"orphaned credential").unwrap();

        let reopened = Vault::open_at(root.clone()).unwrap();
        assert!(!orphan.exists());
        assert_eq!(
            std::fs::read_to_string(home.join("config.toml")).unwrap(),
            LOGIN_HOME_CONFIG
        );
        assert!(matches!(
            poll(&started.flow_id).unwrap(),
            LoginPoll::Pending
        ));
        assert!(reopened.slot_keys().is_empty());

        finish_cli(&home);
        let reopened = Vault::open_at(root).unwrap();
        let expected = chatgpt_login("device", "2026-09-27T14:20:00Z");
        assert_eq!(
            std::fs::read(home.join("auth.json")).unwrap(),
            expected.to_string().as_bytes()
        );
        let LoginPoll::Completed(captured, auth) = poll(&started.flow_id).unwrap() else {
            panic!("device login did not complete");
        };
        assert_eq!(captured, identity("device"));
        assert_eq!(auth, expected);
        assert!(!home.exists());
        let db = crate::database::Database::memory().unwrap();
        let key = super::super::register_cli_login(
            &db,
            &reopened,
            &dir.path().join("live"),
            &captured,
            &auth,
        )
        .unwrap();
        assert_eq!(reopened.read_slot(&key).unwrap().unwrap().auth, expected);
        assert!(reopened.stale_login_homes().is_empty());
        assert!(poll(&started.flow_id).is_err());
    }

    #[cfg(any(unix, windows))]
    #[test]
    #[serial_test::serial(official_device_login)]
    fn cancelled_and_failed_device_logins_remove_their_homes() {
        let dir = TempDir::new().unwrap();
        let _cleanup = LoginCleanup;
        let root = dir.path().join("vault");
        let vault = Vault::open_at(root.clone()).unwrap();
        let script = fake_cli(dir.path());
        for fail in [false, true] {
            let started = start_with_programs(&vault, std::slice::from_ref(&script)).unwrap();
            let home = active_login().unwrap().as_ref().unwrap().home.clone();
            Vault::open_at(root.clone()).unwrap();
            assert!(home.exists());
            if fail {
                std::fs::write(home.join("fail"), b"").unwrap();
                finish_cli(&home);
                Vault::open_at(root.clone()).unwrap();
                assert!(matches!(
                    poll(&started.flow_id).unwrap(),
                    LoginPoll::Failed(_)
                ));
            } else {
                cancel(&started.flow_id).unwrap();
            }
            assert!(!home.exists());
            assert!(active_login().unwrap().is_none());
        }
        assert!(start_with_programs(&vault, &[dir.path().join("missing-cli")]).is_err());
        assert!(vault.stale_login_homes().is_empty());
        assert!(vault.slot_keys().is_empty());
    }

    #[cfg(any(unix, windows))]
    #[test]
    #[serial_test::serial(official_device_login)]
    fn failed_start_cleanup_preserves_a_replacement_login() {
        let dir = TempDir::new().unwrap();
        let _cleanup = LoginCleanup;
        let vault = Vault::open_at(dir.path().join("vault")).unwrap();
        let script = fake_cli(dir.path());

        for replace in [false, true] {
            let previous = start_with_programs(&vault, std::slice::from_ref(&script)).unwrap();
            let previous_home = active_login().unwrap().as_ref().unwrap().home.clone();
            std::fs::write(previous_home.join("fail"), b"").unwrap();
            finish_cli(&previous_home);
            let stderr = {
                let mut active = active_login().unwrap();
                let login = active.as_mut().unwrap();
                assert!(!login.child.try_wait().unwrap().unwrap().success());
                login.stderr()
            };

            let next = replace
                .then(|| start_with_programs(&vault, std::slice::from_ref(&script)).unwrap());
            cleanup_failed_start(&previous.flow_id, stderr).unwrap();
            assert!(!previous_home.exists());

            if let Some(next) = next {
                let home = {
                    let active = active_login().unwrap();
                    let login = active.as_ref().expect("replacement login must survive");
                    assert_eq!(login.flow_id, next.flow_id);
                    login.home.clone()
                };
                assert_eq!(
                    std::fs::read_to_string(home.join("config.toml")).unwrap(),
                    LOGIN_HOME_CONFIG
                );
                assert!(matches!(poll(&next.flow_id).unwrap(), LoginPoll::Pending));
                finish_cli(&home);
                let LoginPoll::Completed(account, auth) = poll(&next.flow_id).unwrap() else {
                    panic!("replacement login did not complete");
                };
                assert_eq!(account, identity("device"));
                assert_eq!(auth, chatgpt_login("device", "2026-09-27T14:20:00Z"));
                assert!(!home.exists());
            }
            assert!(active_login().unwrap().is_none());
        }
        assert!(vault.stale_login_homes().is_empty());
    }

    #[cfg(any(unix, windows))]
    #[test]
    #[serial_test::serial(official_device_login)]
    fn replacement_device_login_removes_only_the_previous_home() {
        let dir = TempDir::new().unwrap();
        let _cleanup = LoginCleanup;
        let root = dir.path().join("vault");
        let vault = Vault::open_at(root.clone()).unwrap();
        let script = fake_cli(dir.path());
        let previous = start_with_programs(&vault, std::slice::from_ref(&script)).unwrap();
        let previous_home = active_login().unwrap().as_ref().unwrap().home.clone();
        let reopened = Vault::open_at(root.clone()).unwrap();
        let next = start_with_programs(&reopened, &[script]).unwrap();
        let next_home = active_login().unwrap().as_ref().unwrap().home.clone();
        assert!(!previous_home.exists());
        cancel(&previous.flow_id).unwrap();
        Vault::open_at(root).unwrap();
        assert!(next_home.exists());
        cancel(&next.flow_id).unwrap();
        assert!(!next_home.exists());
    }
}
