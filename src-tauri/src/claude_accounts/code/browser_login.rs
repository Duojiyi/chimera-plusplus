//! Adding a login through the browser without touching the one Claude Code
//! is using.
//!
//! This is claude-switch's staged login. The official `claude auth login
//! --claudeai` runs with its own private `CLAUDE_CONFIG_DIR`, so the live
//! `~/.claude` login is neither read nor written while the browser flow runs.
//! The CLI does the OAuth itself (it opens the browser, listens for the
//! callback, and asks for the pasted login code in its console window when
//! the callback cannot reach it). When it exits, the two files it wrote are
//! validated and the login is stored in the vault like any other, and the
//! staging folder is scrubbed. Nothing here handles an OAuth client or code.

use std::process::{Child, Command};
use std::time::{Duration, Instant};

use super::transfer::valid_oauth;
use super::*;

const STAGING_DIR: &str = "login-pending";
const FLOW_PREFIX: &str = "flow-";
const FLOW_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_OUTPUT_BYTES: usize = 64 * 1024;
const STAGED_FILE_BYTES: u64 = 8 * 1024 * 1024;
const LOGIN_FLAG: &str = "--claudeai";

// Variables that would send the login somewhere else or replace the
// subscription OAuth the flow is meant to produce.
use super::sessions::AUTH_OVERRIDE_ENV as SCRUBBED_ENV;

#[cfg(windows)]
const CLI_ENV: &str = "CHIMERA_LOGIN_CLI";

/// Where the flow stands. Carries the saved login (no tokens) once done.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LoginPoll {
    /// The browser (or the console window) is still waiting for the user.
    Waiting,
    Done {
        account: CodeAccountDto,
        /// False when the account was already saved and only got fresh tokens.
        created: bool,
    },
    Failed {
        message: String,
    },
    /// No such flow: it finished, was cancelled, or the app restarted.
    Unknown,
}

struct Flow {
    id: String,
    dir: PathBuf,
    child: Child,
    started: Instant,
}

static FLOW: Mutex<Option<Flow>> = Mutex::new(None);

pub(crate) fn browser_login_supported() -> bool {
    cfg!(windows)
}

fn unsupported() -> AppError {
    AppError::Message(
        "浏览器授权目前只支持 Windows。请在终端运行 claude auth login，再回到这里保存当前登录。"
            .to_string(),
    )
}

// ===== staging folder =====

fn staging_root(vault: &CodeVault) -> PathBuf {
    vault.root.join(STAGING_DIR)
}

fn is_flow_dir(vault: &CodeVault, dir: &Path) -> bool {
    dir.parent() == Some(staging_root(vault).as_path())
        && dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(FLOW_PREFIX))
}

fn new_staging(vault: &CodeVault) -> Result<(String, PathBuf), AppError> {
    ensure_private_dir(&vault.root)?;
    ensure_private_dir(&staging_root(vault))?;
    let id = format!("{FLOW_PREFIX}{}", new_account_id());
    let dir = staging_root(vault).join(&id);
    ensure_private_dir(&dir)?;
    Ok((id, dir))
}

/// Overwrites and removes everything in one staging folder. Refuses any path
/// that is not a flow folder directly under the vault's staging root.
fn remove_staging(vault: &CodeVault, dir: &Path) {
    if !is_flow_dir(vault, dir) {
        return;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_file()) {
                let _ = scrub_file(&entry.path());
            }
        }
    }
    if let Err(error) = fs::remove_dir_all(dir) {
        log::warn!("清理 Claude 授权临时目录失败: {error}");
    }
}

/// Folders left by a flow that never finished (a crash, a killed app). Only
/// one flow runs at a time and the app is single-instance, so any folder that
/// is not `keep` is an orphan holding tokens.
fn sweep_orphans(vault: &CodeVault, keep: Option<&Path>) {
    let Ok(entries) = fs::read_dir(staging_root(vault)) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry
            .file_type()
            .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink());
        if is_dir && Some(path.as_path()) != keep {
            remove_staging(vault, &path);
        }
    }
}

// ===== the CLI process =====

#[cfg_attr(not(windows), allow(dead_code))]
fn prepare_env(command: &mut Command, dir: &Path) {
    for name in SCRUBBED_ENV {
        command.env_remove(name);
    }
    command.env("CLAUDE_CONFIG_DIR", dir).current_dir(dir);
    // Node's HTTP stack understands plain HTTP(S) proxies only.
    if let Some(proxy) = crate::proxy::http_client::get_current_proxy_url()
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
    {
        command.env("HTTPS_PROXY", &proxy).env("HTTP_PROXY", &proxy);
    }
}

/// The path without the `\\?\` prefix `canonicalize` adds; cmd.exe cannot
/// run a program named that way.
#[cfg(windows)]
fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// `cmd.exe /d /v:off /s /c "<script>"`. Only fixed words are in `script`;
/// the CLI's path travels in an environment variable, so a `%`, `&` or space
/// in an install path cannot become part of a command. Works for `claude.exe`
/// and for the `claude.cmd` shim npm installs.
#[cfg(windows)]
fn cmd_script(cli: &Path, script: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let system = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut command = Command::new(system.join("System32").join("cmd.exe"));
    command
        .raw_arg(format!("/d /v:off /s /c \"{script}\""))
        .env(CLI_ENV, plain_path(cli))
        .creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn probe_script() -> String {
    format!("\"%{CLI_ENV}%\" auth login --help")
}

/// `start /wait` gives the CLI a console window of its own, which the user
/// needs for pasting the login code, while this process waits for it to end.
#[cfg(windows)]
fn login_script() -> String {
    format!("start \"Claude Login\" /wait \"%{CLI_ENV}%\" auth login {LOGIN_FLAG}")
}

#[cfg(windows)]
fn probe_command(cli: &Path, dir: &Path) -> Result<Command, AppError> {
    let mut command = cmd_script(cli, &probe_script());
    prepare_env(&mut command, dir);
    Ok(command)
}

#[cfg(not(windows))]
fn probe_command(_cli: &Path, _dir: &Path) -> Result<Command, AppError> {
    Err(unsupported())
}

#[cfg(windows)]
fn login_command(cli: &Path, dir: &Path) -> Result<Command, AppError> {
    let mut command = cmd_script(cli, &login_script());
    prepare_env(&mut command, dir);
    Ok(command)
}

#[cfg(not(windows))]
fn login_command(_cli: &Path, _dir: &Path) -> Result<Command, AppError> {
    Err(unsupported())
}

fn stop(child: &mut Child) {
    #[cfg(windows)]
    crate::process_utils::terminate_process_tree(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

/// Whether this Claude Code can sign in with a claude.ai subscription from
/// the command line (older builds have no `--claudeai`).
fn check_login_supported(cli: &Path, dir: &Path) -> Result<(), AppError> {
    let command = probe_command(cli, dir)?;
    let output =
        crate::process_utils::output_with_timeout(command, PROBE_TIMEOUT, PROBE_OUTPUT_BYTES)
            .map_err(|_| {
                AppError::Message(
                    "无法运行 Claude Code，请确认 claude 命令可以在终端里运行。".to_string(),
                )
            })?;
    let text = format!(
        "{}{}",
        crate::process_utils::decode_console_output(&output.stdout),
        crate::process_utils::decode_console_output(&output.stderr)
    );
    if output.status.success() && text.contains(LOGIN_FLAG) {
        Ok(())
    } else {
        Err(AppError::Message(
            "这个版本的 Claude Code 不支持命令行授权登录，请先升级到最新版。".to_string(),
        ))
    }
}

// ===== what the CLI left behind =====

fn read_staged(path: &Path) -> Result<Option<Value>, AppError> {
    match read_limited(path, STAGED_FILE_BYTES) {
        Ok(bytes) => Ok(parse_object(Some(&bytes)).map(Value::Object)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io(path, error)),
    }
}

fn incomplete() -> AppError {
    AppError::Message("授权没有完成：没有拿到登录凭证。可能是授权页被关闭了，请重试。".to_string())
}

/// Validates the staged login and stores it. An account the vault already has
/// takes the fresh tokens (this is also how a login marked "needs sign-in"
/// is healed); anything else becomes a new saved login.
pub(crate) fn finish_in(vault: &CodeVault, dir: &Path) -> Result<(CodeAccountDto, bool), AppError> {
    let credentials = read_staged(&dir.join(".credentials.json"))?.ok_or_else(incomplete)?;
    let claude_json = read_staged(&dir.join(".claude.json"))?.ok_or_else(incomplete)?;
    let oauth = valid_oauth(credentials.get(CREDENTIALS_KEY), "授权结果")?;
    let account = claude_json
        .get(ACCOUNT_KEY)
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| {
            AppError::Message(
                "授权已完成，但 Claude 没有写入账号信息，无法识别是哪个账号。请重试。".to_string(),
            )
        })?;
    let ident = identity(Some(&account), Some(&oauth));
    if ident.email.is_none() || ident.account_uuid.is_none() {
        return Err(AppError::Message(
            "授权已完成，但账号信息不完整（缺少邮箱或账号 ID），无法保存。".to_string(),
        ));
    }
    let _guard = CODE_LOCK.lock()?;
    let (slot, created) = match find_matching(vault, &ident) {
        Some(mut slot) => {
            slot.absorb(oauth, Some(account));
            (slot, false)
        }
        None => {
            let name = fitted_name(ident.email.as_deref().unwrap_or_default(), DEFAULT_NAME);
            (new_slot(vault, name, oauth, Some(account))?, true)
        }
    };
    vault.write_slot(&slot)?;
    Ok((slot.dto(None), created))
}

// ===== the flow =====

/// Starts a browser authorization and returns its id. A flow that is still
/// waiting is returned again instead of starting a second one, so a page that
/// lost its id can pick it back up.
pub(crate) fn begin(vault: &CodeVault, cli: &Path) -> Result<String, AppError> {
    ensure_supported()?;
    if !browser_login_supported() {
        return Err(unsupported());
    }
    let mut flow = FLOW.lock()?;
    if let Some(running) = flow.as_mut() {
        if matches!(running.child.try_wait(), Ok(None)) {
            return Ok(running.id.clone());
        }
        if let Some(mut finished) = flow.take() {
            stop(&mut finished.child);
            remove_staging(vault, &finished.dir);
        }
    }
    sweep_orphans(vault, None);
    let (id, dir) = new_staging(vault)?;
    let started = check_login_supported(cli, &dir)
        .and_then(|()| login_command(cli, &dir))
        .and_then(|mut command| {
            command
                .spawn()
                .map_err(|_| AppError::Message("无法启动 Claude Code 的授权登录。".to_string()))
        });
    match started {
        Ok(child) => {
            *flow = Some(Flow {
                id: id.clone(),
                dir,
                child,
                started: Instant::now(),
            });
            Ok(id)
        }
        Err(error) => {
            remove_staging(vault, &dir);
            Err(error)
        }
    }
}

pub(crate) fn poll(vault: &CodeVault, id: &str) -> Result<LoginPoll, AppError> {
    let mut slot = FLOW.lock()?;
    let Some(flow) = slot.as_mut().filter(|flow| flow.id == id) else {
        return Ok(LoginPoll::Unknown);
    };
    match flow.child.try_wait() {
        Ok(None) if flow.started.elapsed() < FLOW_TIMEOUT => return Ok(LoginPoll::Waiting),
        Ok(None) => {
            if let Some(mut expired) = slot.take() {
                stop(&mut expired.child);
                remove_staging(vault, &expired.dir);
            }
            return Ok(LoginPoll::Failed {
                message: "等待授权超过 15 分钟，已取消。需要的话请重新开始。".to_string(),
            });
        }
        Ok(Some(_)) | Err(_) => {}
    }
    let Some(finished) = slot.take() else {
        return Ok(LoginPoll::Unknown);
    };
    let result = finish_in(vault, &finished.dir);
    remove_staging(vault, &finished.dir);
    Ok(match result {
        Ok((account, created)) => LoginPoll::Done { account, created },
        Err(error) => LoginPoll::Failed {
            message: error.to_string(),
        },
    })
}

pub(crate) fn cancel(vault: &CodeVault, id: &str) -> Result<(), AppError> {
    let mut slot = FLOW.lock()?;
    if slot.as_ref().is_some_and(|flow| flow.id == id) {
        if let Some(mut flow) = slot.take() {
            stop(&mut flow.child);
            remove_staging(vault, &flow.dir);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_accounts::code::tests::{fixture, Fixture};
    use serde_json::json;

    fn stage(dir: &Path, email: &str, uuid: &str, token: &str) {
        fs::write(
            dir.join(".credentials.json"),
            json!({"claudeAiOauth": {
                "accessToken": token, "refreshToken": format!("r-{token}"),
                "expiresAt": 4_102_444_800_000_i64, "subscriptionType": "max"
            }})
            .to_string(),
        )
        .unwrap();
        fs::write(
            dir.join(".claude.json"),
            json!({"numStartups": 1, "oauthAccount": {
                "accountUuid": uuid, "emailAddress": email, "organizationUuid": "org-1"
            }})
            .to_string(),
        )
        .unwrap();
    }

    fn staged(f: &Fixture) -> PathBuf {
        new_staging(&f.vault).unwrap().1
    }

    #[test]
    fn a_finished_login_is_saved_and_the_same_account_later_takes_the_new_tokens() {
        let f = fixture();
        let dir = staged(&f);
        stage(&dir, "a@example.com", "uuid-a", "token-1");
        let (account, created) = finish_in(&f.vault, &dir).unwrap();
        assert!(created);
        assert_eq!(account.email.as_deref(), Some("a@example.com"));
        assert_eq!(account.plan.as_deref(), Some("Max"));
        assert_eq!(account.name, "a@example.com");

        rename_in(&f.vault, &account.id, "工作号").unwrap();
        mark_needs_relogin(&f.vault, &account.id).unwrap();
        stage(&dir, "a@example.com", "uuid-a", "token-2");
        let (again, created) = finish_in(&f.vault, &dir).unwrap();
        assert!(!created);
        assert_eq!(again.id, account.id);
        assert_eq!(again.name, "工作号", "an existing name is kept");
        assert!(!again.needs_relogin);
        let slot = f.vault.read_slot(&account.id).unwrap();
        assert_eq!(slot.claude_ai_oauth["accessToken"], "token-2");
        assert_eq!(f.vault.readable_slots().len(), 1);
    }

    #[test]
    fn an_unfinished_or_odd_login_saves_nothing() {
        let f = fixture();
        let dir = staged(&f);
        assert!(finish_in(&f.vault, &dir).is_err(), "no files");

        stage(&dir, "a@example.com", "uuid-a", "token");
        fs::write(dir.join(".claude.json"), "{\"numStartups\":1}").unwrap();
        assert!(finish_in(&f.vault, &dir).is_err(), "no account block");

        stage(&dir, "a@example.com", "", "token");
        assert!(finish_in(&f.vault, &dir).is_err(), "no account id");

        stage(&dir, "a@example.com", "uuid-a", "token");
        fs::write(
            dir.join(".credentials.json"),
            json!({"claudeAiOauth": {"accessToken": "t"}}).to_string(),
        )
        .unwrap();
        assert!(finish_in(&f.vault, &dir).is_err(), "no refresh token");

        fs::write(dir.join(".credentials.json"), "{}").unwrap();
        assert!(
            finish_in(&f.vault, &dir).is_err(),
            "an API-key login has no oauth"
        );
        assert!(f.vault.readable_slots().is_empty());
    }

    #[test]
    fn staging_folders_are_scrubbed_and_only_flow_folders_are_removed() {
        let f = fixture();
        let dir = staged(&f);
        stage(&dir, "a@example.com", "uuid-a", "token");
        let other = staged(&f);
        fs::create_dir_all(other.join("nested")).unwrap();
        fs::write(other.join("nested").join("x"), "x").unwrap();

        sweep_orphans(&f.vault, Some(&dir));
        assert!(
            dir.exists() && !other.exists(),
            "only the kept folder survives"
        );

        remove_staging(&f.vault, &dir);
        assert!(!dir.exists());

        // Not a flow folder: untouched.
        let outside = f.vault.root.join("accounts");
        remove_staging(&f.vault, &outside);
        assert!(outside.exists());
        let wrong_name = staging_root(&f.vault).join("keep-me");
        fs::create_dir_all(&wrong_name).unwrap();
        remove_staging(&f.vault, &wrong_name);
        assert!(wrong_name.exists());
    }

    #[test]
    fn the_child_environment_drops_every_override_and_points_at_the_staging_folder() {
        let f = fixture();
        let dir = staged(&f);
        let mut command = Command::new("claude");
        prepare_env(&mut command, &dir);
        let envs: std::collections::HashMap<_, _> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_owned()),
                )
            })
            .collect();
        for name in SCRUBBED_ENV {
            assert_eq!(envs.get(*name), Some(&None), "{name} must be removed");
        }
        assert_eq!(
            envs.get("CLAUDE_CONFIG_DIR").and_then(|v| v.as_deref()),
            Some(dir.as_os_str())
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_command_line_holds_only_fixed_words_and_the_cli_path_travels_in_the_environment() {
        assert_eq!(probe_script(), "\"%CHIMERA_LOGIN_CLI%\" auth login --help");
        assert_eq!(
            login_script(),
            "start \"Claude Login\" /wait \"%CHIMERA_LOGIN_CLI%\" auth login --claudeai"
        );
        let hostile = Path::new(r"C:\Program Files\a&b %PATH%\claude.cmd");
        let command = cmd_script(hostile, &login_script());
        let cli = command
            .get_envs()
            .find(|(key, _)| *key == CLI_ENV)
            .and_then(|(_, value)| value)
            .unwrap();
        assert_eq!(cli, plain_path(hostile).as_os_str());
        assert_eq!(
            plain_path(Path::new(r"\\?\C:\Users\me\claude.cmd")),
            PathBuf::from(r"C:\Users\me\claude.cmd")
        );
        assert_eq!(
            plain_path(Path::new(r"\\?\UNC\server\share\claude.cmd")),
            PathBuf::from(r"\\?\UNC\server\share\claude.cmd")
        );
    }

    #[test]
    fn an_unknown_flow_is_reported_as_such_and_cancel_is_harmless() {
        let f = fixture();
        assert!(matches!(
            poll(&f.vault, "flow-nope").unwrap(),
            LoginPoll::Unknown
        ));
        cancel(&f.vault, "flow-nope").unwrap();
    }
}
