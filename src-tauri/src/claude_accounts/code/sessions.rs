//! Parallel sessions: run a saved login in a terminal of its own while the
//! login Claude Code uses everywhere else stays as it is.
//!
//! Claude Code reads both its config and its credentials from
//! `CLAUDE_CONFIG_DIR`. Each saved login gets a folder
//! `<vault>/sessions/<id>/` seeded with its credentials and account; a
//! terminal started with that variable is signed in as that login.
//!
//! The one rule that matters: **a refresh token lives in one place at a
//! time.** Every refresh hands Claude Code a new refresh token and kills the
//! old one, so two copies of one login destroy each other. Hence:
//! - the login Claude Code is signed in with cannot also run as a session;
//! - while a session terminal is open, the login is not refreshed, switched
//!   to or deleted from here;
//! - before the saved copy is used, newer tokens the session wrote are taken
//!   back into it ([`harvest_locked`]).
//!
//! "A terminal is open" is a file lock: the launcher keeps `.session.lock`
//! open for as long as `claude` runs, and a crash or a closed window releases
//! it, so there is no process id that can go stale or be reused.
//!
//! Shared settings are copied, not linked (Windows links need privileges),
//! and copied again on every launch. Conversation history is not copied: a
//! copy would fork it; the usage overview reads every profile instead.

use super::*;

const SESSIONS_DIR: &str = "sessions";
const LOCK_PREFIX: &str = ".session.";
const LOCK_SUFFIX: &str = ".lock";
const LAUNCHER_FILE: &str = "start-claude.bat";
const REMOVED_DIR: &str = "sessions-removed";
const MANIFEST_FILE: &str = ".chimera-shared.json";
const CREDENTIALS_FILE: &str = ".credentials.json";
const CLAUDE_JSON_FILE: &str = ".claude.json";
const MCP_KEY: &str = "mcpServers";
/// Copied from the default config folder into every profile.
const SHARED_ITEMS: &[&str] = &[
    "settings.json",
    "keybindings.json",
    "CLAUDE.md",
    "skills",
    "commands",
    "agents",
];
const MAX_SHARED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SHARED_FILES: usize = 4000;

/// Environment variables that send Claude Code to another login or another
/// endpoint. A session (and a browser sign-in) is an explicit request for one
/// account, so they are cleared for it, in the process and, for a session, in
/// the copied `settings.json` too.
pub(crate) const AUTH_OVERRIDE_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];

/// Whether a `settings.json` `env` entry belongs to a provider or an endpoint
/// rather than to the account: all of `ANTHROPIC_*` (the model names a
/// provider writes next to its address too) and the cloud-provider switches.
fn is_provider_env(name: &str) -> bool {
    name.starts_with("ANTHROPIC_")
        || name.starts_with("CLAUDE_CODE_USE_")
        || AUTH_OVERRIDE_ENV.contains(&name)
}

/// Top-level `settings.json` keys that run a program to get a credential.
const CREDENTIAL_SETTINGS: &[&str] = &["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"];

pub(crate) fn sessions_root(vault: &CodeVault) -> PathBuf {
    vault.root.join(SESSIONS_DIR)
}

pub(crate) fn profile_dir(vault: &CodeVault, id: &str) -> Result<PathBuf, AppError> {
    crate::claude_accounts::validate_account_id(id)?;
    Ok(sessions_root(vault).join(id))
}

/// Whether any launcher of this folder still holds its lock file. Each
/// launch keeps a file of its own open for as long as `claude` runs (two
/// launches cannot share one: the redirection that holds it does not share
/// writes), so any file that cannot be opened is a terminal that is open. A
/// file that can be opened is left over from one that ended and is removed.
#[cfg(windows)]
fn locks_held(dir: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    let mut held = false;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !(name.starts_with(LOCK_PREFIX) && name.ends_with(LOCK_SUFFIX)) {
            continue;
        }
        let path = entry.path();
        // Share mode 0 conflicts with any handle that is still open.
        match fs::OpenOptions::new().read(true).share_mode(0).open(&path) {
            Ok(file) => {
                drop(file);
                let _ = fs::remove_file(&path);
            }
            Err(error) if error.raw_os_error() == Some(32) => held = true,
            Err(_) => {}
        }
    }
    held
}

#[cfg(not(windows))]
fn locks_held(_dir: &Path) -> bool {
    false
}

/// Whether a terminal is open on this login's session folder.
pub(crate) fn is_running(vault: &CodeVault, id: &str) -> bool {
    profile_dir(vault, id).is_ok_and(|dir| locks_held(&dir))
}

fn read_object(path: &Path) -> Option<Map<String, Value>> {
    read_optional(path)
        .ok()
        .flatten()
        .and_then(|bytes| parse_object(Some(&bytes)))
}

/// Who an account block names, without the token fingerprint.
fn account_identity(account: Option<&Value>) -> Identity {
    Identity {
        account_uuid: text_field(account, "accountUuid"),
        organization_uuid: text_field(account, "organizationUuid"),
        email: text_field(account, "emailAddress"),
        fingerprint: None,
    }
}

fn expires_at(oauth: &Value) -> i64 {
    oauth.get("expiresAt").and_then(Value::as_i64).unwrap_or(0)
}

/// The OAuth object a session folder holds, if it holds a usable one.
pub(crate) fn profile_oauth(vault: &CodeVault, id: &str) -> Option<Value> {
    let dir = profile_dir(vault, id).ok()?;
    let creds = read_object(&dir.join(CREDENTIALS_FILE))?;
    usable_oauth(creds.get(CREDENTIALS_KEY))
}

fn profile_account(dir: &Path) -> Option<Value> {
    read_object(&dir.join(CLAUDE_JSON_FILE))?
        .get(ACCOUNT_KEY)
        .filter(|value| value.is_object())
        .cloned()
}

/// Takes newer tokens the session wrote back into the saved login. Only for
/// the same account, and only when the session's token is of a later
/// generation (later expiry). `true` when the saved login changed. The
/// caller holds `CODE_LOCK`.
pub(crate) fn harvest_locked(vault: &CodeVault, id: &str) -> Result<bool, AppError> {
    let Ok(dir) = profile_dir(vault, id) else {
        return Ok(false);
    };
    let Ok(mut slot) = vault.read_slot(id) else {
        return Ok(false);
    };
    if slot.kind != SlotKind::Oauth {
        return Ok(false);
    }
    let Some(oauth) = profile_oauth(vault, id) else {
        return Ok(false);
    };
    let account = profile_account(&dir);
    let same_account = {
        let theirs = account_identity(account.as_ref());
        let ours = account_identity(slot.oauth_account.as_ref());
        (theirs.account_uuid.is_some() || theirs.email.is_some()) && same_login(&theirs, &ours)
    };
    let newer = expires_at(&oauth) > expires_at(&slot.claude_ai_oauth)
        && refresh_token_of(&oauth).is_some()
        && refresh_token_of(&oauth) != refresh_token_of(&slot.claude_ai_oauth);
    if !same_account || !newer {
        return Ok(false);
    }
    slot.absorb(oauth, None);
    vault.write_slot(&slot)?;
    Ok(true)
}

#[cfg(test)]
pub(crate) fn harvest_in(vault: &CodeVault, id: &str) -> Result<bool, AppError> {
    let _guard = CODE_LOCK.lock()?;
    harvest_locked(vault, id)
}

/// [`harvest_locked`] for every saved login. The caller holds `CODE_LOCK`.
pub(crate) fn harvest_all_locked(vault: &CodeVault) {
    for id in vault.slot_ids() {
        if let Err(error) = harvest_locked(vault, &id) {
            log::warn!("收回并行会话的令牌失败: {error}");
        }
    }
}

// ===== seeding =====

/// Whether the folder's own credentials can stay: the same account, and a
/// token of the same or a later generation than the saved login's.
fn profile_credentials_current(dir: &Path, slot: &Slot) -> bool {
    let Some(have) = read_object(&dir.join(CREDENTIALS_FILE))
        .and_then(|creds| usable_oauth(creds.get(CREDENTIALS_KEY)))
    else {
        return false;
    };
    let want = &slot.claude_ai_oauth;
    match slot.kind {
        SlotKind::ApiKey => false,
        SlotKind::SetupToken => have.get("accessToken") == want.get("accessToken"),
        SlotKind::Oauth => {
            let theirs = account_identity(profile_account(dir).as_ref());
            let ours = account_identity(slot.oauth_account.as_ref());
            let same_account = (theirs.account_uuid.is_some() || theirs.email.is_some())
                && same_login(&theirs, &ours);
            same_account
                && refresh_token_of(&have).is_some()
                && (refresh_token_of(&have) == refresh_token_of(want)
                    || expires_at(&have) >= expires_at(want))
        }
    }
}

fn seed_credentials(dir: &Path, slot: &Slot) -> Result<(), AppError> {
    if profile_credentials_current(dir, slot) {
        return Ok(());
    }
    let path = dir.join(CREDENTIALS_FILE);
    let existing = read_optional(&path)?;
    let oauth = match slot.kind {
        SlotKind::ApiKey => None,
        SlotKind::Oauth | SlotKind::SetupToken => Some(slot.claude_ai_oauth.clone()),
    };
    if let Some(data) = replace_key(existing.as_deref(), CREDENTIALS_KEY, oauth, false)? {
        private_write(&path, &data)?;
    }
    Ok(())
}

#[derive(Default, Serialize, Deserialize)]
struct Manifest {
    #[serde(default)]
    items: Vec<String>,
    #[serde(default)]
    mcp: bool,
}

fn read_manifest(dir: &Path) -> Manifest {
    read_object(&dir.join(MANIFEST_FILE))
        .and_then(|map| serde_json::from_value(Value::Object(map)).ok())
        .unwrap_or_default()
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> Result<(), AppError> {
    let data = serde_json::to_vec(manifest).map_err(|e| AppError::JsonSerialize { source: e })?;
    private_write(&dir.join(MANIFEST_FILE), &data)
}

fn seed_claude_json(
    dir: &Path,
    default_claude_json: &Path,
    slot: &Slot,
    mirrored_mcp: bool,
) -> Result<bool, AppError> {
    let path = dir.join(CLAUDE_JSON_FILE);
    let existing = read_optional(&path)?;
    let default = read_object(default_claude_json);
    let servers = default
        .as_ref()
        .and_then(|map| map.get(MCP_KEY))
        .filter(|value| value.is_object())
        .cloned();
    let has_servers = servers.is_some();

    // Claude Code shows its setup wizard when there is no theme or the
    // onboarding flag is not set.
    let has_theme = existing
        .as_deref()
        .and_then(|bytes| parse_object(Some(bytes)))
        .is_some_and(|map| map.contains_key("theme"));
    let mut edits: Vec<(&str, Option<Value>)> =
        vec![("hasCompletedOnboarding", Some(Value::Bool(true)))];
    if !has_theme {
        let theme = default
            .as_ref()
            .and_then(|map| map.get("theme"))
            .and_then(Value::as_str)
            .unwrap_or("dark");
        edits.push(("theme", Some(Value::from(theme))));
    }
    match slot.kind {
        SlotKind::Oauth => {
            edits.push((ACCOUNT_KEY, slot.oauth_account.clone()));
            edits.push((API_KEY_FIELD, None));
        }
        SlotKind::SetupToken => {
            edits.push((ACCOUNT_KEY, None));
            edits.push((API_KEY_FIELD, None));
        }
        SlotKind::ApiKey => {
            let key = slot.api_key.as_deref().ok_or_else(|| {
                AppError::Message("已保存的 API Key 账号里没有密钥，无法打开".to_string())
            })?;
            edits.push((ACCOUNT_KEY, None));
            edits.push((API_KEY_FIELD, Some(Value::from(key))));
            edits.push((
                API_KEY_RESPONSES,
                Some(approved_responses(existing.as_deref(), key)),
            ));
        }
    }
    if has_servers {
        edits.push((MCP_KEY, servers));
    } else if mirrored_mcp {
        // We put them there; the default login no longer has any.
        edits.push((MCP_KEY, None));
    }
    if let Some(data) = replace_keys(existing.as_deref(), edits, true)? {
        private_write(&path, &data)?;
    }
    Ok(has_servers)
}

// ===== shared settings =====

struct Budget {
    bytes: u64,
    files: usize,
}

fn remove_path(path: &Path) {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !is_link_or_reparse_point(&meta) => {
            let _ = fs::remove_dir_all(path);
        }
        Ok(_) => {
            let _ = fs::remove_file(path);
        }
        Err(_) => {}
    }
}

fn copy_tree(src: &Path, dst: &Path, budget: &mut Budget) -> io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    // Links in the default folder (a dotfiles repo, say) are not followed.
    if is_link_or_reparse_point(&meta) {
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)?.flatten() {
            copy_tree(&entry.path(), &dst.join(entry.file_name()), budget)?;
        }
        return Ok(());
    }
    if !meta.is_file() {
        return Ok(());
    }
    budget.files += 1;
    budget.bytes = budget.bytes.saturating_add(meta.len());
    if budget.files > MAX_SHARED_FILES || budget.bytes > MAX_SHARED_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "共享的配置太大，已停止复制",
        ));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src, dst).map(|_| ())
}

/// `settings.json` without what would send the session to another login:
/// the `env` entries that name a credential or an endpoint (the local proxy
/// takeover and third-party providers write them there, and Claude Code
/// applies them over the process environment) and the keys that run a
/// program to get one. The names removed are returned.
fn shared_settings(text: &str) -> Result<(String, Vec<String>), AppError> {
    let mut value: Value = serde_json::from_str(strip_bom(text))
        .map_err(|_| AppError::Message("settings.json 不是有效的 JSON".to_string()))?;
    let map = value
        .as_object_mut()
        .ok_or_else(|| AppError::Message("settings.json 不是 JSON 对象".to_string()))?;
    let mut removed = Vec::new();
    for key in CREDENTIAL_SETTINGS {
        if map.shift_remove(*key).is_some() {
            removed.push((*key).to_string());
        }
    }
    if let Some(env) = map.get_mut("env").and_then(Value::as_object_mut) {
        let names: Vec<String> = env
            .keys()
            .filter(|name| is_provider_env(name))
            .cloned()
            .collect();
        for name in names {
            env.shift_remove(&name);
            removed.push(name);
        }
    }
    let text = serde_json::to_string_pretty(&value)
        .map_err(|e| AppError::JsonSerialize { source: e })?
        + "\n";
    Ok((text, removed))
}

fn copy_settings(src: &Path, dst: &Path, warnings: &mut Vec<String>) -> Result<(), AppError> {
    let bytes = read_limited(src, MAX_LIVE_FILE_BYTES).map_err(|e| AppError::io(src, e))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::Message("settings.json 不是 UTF-8 文本".to_string()))?;
    let (filtered, removed) = shared_settings(&text)?;
    if !removed.is_empty() {
        warnings.push(format!(
            "已忽略 settings.json 里的供应商和认证设置（{}），会话只用这个账号的登录",
            removed.join("、")
        ));
    }
    private_write(dst, filtered.as_bytes())
}

/// What was shared, and what could not be.
struct Shared {
    copied: Vec<String>,
    warnings: Vec<String>,
}

fn sync_shared(dir: &Path, default_dir: &Path) -> Shared {
    let mut shared = Shared {
        copied: Vec::new(),
        warnings: Vec::new(),
    };
    for name in SHARED_ITEMS {
        let src = default_dir.join(name);
        let Ok(meta) = fs::symlink_metadata(&src) else {
            continue;
        };
        // A link at the top (a dotfiles repo, a sync tool) is followed once;
        // links inside what it points to are not.
        let src = if is_link_or_reparse_point(&meta) {
            match fs::canonicalize(&src) {
                Ok(real) => real,
                Err(_) => {
                    shared
                        .warnings
                        .push(format!("{name} 是个读不到目标的链接，没有共享"));
                    continue;
                }
            }
        } else {
            src
        };
        let dst = dir.join(name);
        remove_path(&dst);
        let mut budget = Budget { bytes: 0, files: 0 };
        let result = if *name == "settings.json" {
            copy_settings(&src, &dst, &mut shared.warnings).map_err(|e| e.to_string())
        } else {
            copy_tree(&src, &dst, &mut budget).map_err(|e| e.to_string())
        };
        match result {
            Ok(()) => shared.copied.push((*name).to_string()),
            Err(error) => {
                log::warn!("复制共享配置 {name} 失败: {error}");
                remove_path(&dst);
                shared.warnings.push(format!("{name} 没有共享：{error}"));
            }
        }
    }
    shared
}

// ===== operations =====

/// A session folder ready to start `claude` in.
pub(crate) struct Prepared {
    pub dir: PathBuf,
    pub name: String,
    /// The batch file that runs `claude` on this folder.
    pub launcher: PathBuf,
    /// Things that were not shared or were left out, for the user to read.
    pub warnings: Vec<String>,
}

fn live_matches(paths: &LivePaths, slot: &Slot) -> bool {
    read_live(paths)
        .ok()
        .as_ref()
        .is_some_and(|live| live_holds(live, slot))
}

/// The batch file that runs `claude` on a session folder: it clears what
/// would override the login, points `CLAUDE_CONFIG_DIR` at the folder, and
/// keeps a lock file of its own open for as long as `claude` runs. It
/// restores the console's code page and leaves nothing in the shell's
/// environment, so it can be run from a shell the user already has open.
pub(crate) fn launcher_script(dir: &Path) -> String {
    let mut lines = vec![
        "@echo off".to_string(),
        "setlocal DisableDelayedExpansion".to_string(),
        NO_CURRENT_DIR_LINE.to_string(),
        "for /f \"tokens=2 delims=:\" %%a in ('chcp') do set \"CHIMERA_CP=%%a\"".to_string(),
        "chcp 65001 >nul".to_string(),
    ];
    lines.extend(launcher_body(dir));
    lines.push("chcp %CHIMERA_CP% >nul".to_string());
    lines.push("endlocal".to_string());
    lines.join("\r\n") + "\r\n"
}

/// Keeps cmd from looking in the current folder before `PATH`: the folder a
/// session is opened in is a project the user may not trust, and a `claude.cmd`
/// in it would run before Claude Code's own trust prompt.
pub(crate) const NO_CURRENT_DIR_LINE: &str = "set \"NoDefaultCurrentDirectoryInExePath=1\"";

/// The lines that run `claude` on a session folder, for the launcher and for
/// the script that opens a terminal (which has them inline: `call` would read
/// a `%` or `^` in the launcher's path a second time).
pub(crate) fn launcher_body(dir: &Path) -> Vec<String> {
    let quoted = dir.to_string_lossy().replace('%', "%%");
    let mut lines = Vec::new();
    for name in AUTH_OVERRIDE_ENV {
        lines.push(format!("set \"{name}=\""));
    }
    // Whatever else a provider switch left in the environment: model names,
    // headers, timeouts.
    for prefix in ["ANTHROPIC_", "CLAUDE_CODE_USE_"] {
        lines.push(format!(
            "for /f \"delims==\" %%v in ('set {prefix} 2^>nul') do set \"%%v=\""
        ));
    }
    lines.push(format!("set \"CLAUDE_CONFIG_DIR={quoted}\""));
    lines.push(format!(
        "(call claude) 9>\"{quoted}\\{LOCK_PREFIX}%RANDOM%%RANDOM%{LOCK_SUFFIX}\""
    ));
    lines
}

fn write_launcher(dir: &Path) -> Result<PathBuf, AppError> {
    let path = dir.join(LAUNCHER_FILE);
    private_write(&path, launcher_script(dir).as_bytes())?;
    Ok(path)
}

/// Whether this login is the one Claude Code is signed in with now.
pub(crate) fn is_live_login(vault: &CodeVault, paths: &LivePaths, id: &str) -> bool {
    vault
        .read_slot(id)
        .is_ok_and(|slot| live_matches(paths, &slot))
}

fn live_login_error() -> AppError {
    AppError::Message(
        "这个账号正是 Claude Code 现在使用的登录，直接在终端运行 claude 就是它。要同时用多个账号，请先把默认登录切换到另一个账号。"
            .to_string(),
    )
}

/// Makes the login's session folder ready: newest tokens, account, shared
/// settings. Refused for a login held out of use, one that needs a new
/// sign-in, and the one Claude Code is signed in with.
pub(crate) fn prepare_in(
    vault: &CodeVault,
    paths: &LivePaths,
    id: &str,
) -> Result<Prepared, AppError> {
    ensure_supported()?;
    let _guard = CODE_LOCK.lock()?;
    let dir = profile_dir(vault, id)?;
    let slot = vault.read_slot(id)?;
    if slot.disabled {
        return Err(manage::disabled_error(&slot));
    }
    if live_matches(paths, &slot) {
        return Err(live_login_error());
    }
    ensure_private_dir(&sessions_root(vault))?;
    ensure_private_dir(&dir)?;
    let launcher = write_launcher(&dir)?;
    let prepared = |slot: &Slot, warnings: Vec<String>| Prepared {
        dir: dir.clone(),
        name: slot.name.clone(),
        launcher: launcher.clone(),
        warnings,
    };
    if locks_held(&dir) {
        // A second terminal on the same folder shares the first one's tokens.
        return Ok(prepared(&slot, Vec::new()));
    }

    harvest_locked(vault, id)?;
    let slot = vault.read_slot(id)?;
    if slot.kind == SlotKind::Oauth && slot.needs_relogin {
        return Err(AppError::Message(
            "这个账号的登录已失效。请先重新登录该账号（例如从浏览器授权添加）。".to_string(),
        ));
    }
    seed_credentials(&dir, &slot)?;
    let default_dir = paths
        .credentials
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let manifest = read_manifest(&dir);
    let mcp = seed_claude_json(&dir, &paths.claude_json, &slot, manifest.mcp)?;
    let shared = sync_shared(&dir, &default_dir);
    // Items that were shared before and are gone from the default folder.
    for stale in manifest
        .items
        .iter()
        .filter(|name| !shared.copied.contains(name))
    {
        if SHARED_ITEMS.contains(&stale.as_str()) {
            remove_path(&dir.join(stale));
        }
    }
    write_manifest(
        &dir,
        &Manifest {
            items: shared.copied,
            mcp,
        },
    )?;
    Ok(prepared(&slot, shared.warnings))
}

/// PowerShell reads all four of these as a quote.
fn powershell_quoted(text: &str) -> String {
    let doubled: String = text
        .chars()
        .flat_map(|c| match c {
            '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => vec![c, c],
            other => vec![other],
        })
        .collect();
    format!("'{doubled}'")
}

/// The commands that start `claude` on a prepared folder from a shell the
/// user already has open (cmd, PowerShell). They run the folder's launcher,
/// so the lock and the cleared variables apply there too.
pub(crate) fn shell_commands(launcher: &Path) -> (String, String) {
    let text = launcher.to_string_lossy();
    (
        format!("\"{text}\""),
        format!("& {}", powershell_quoted(&text)),
    )
}

/// Removes a login's session folder, tokens first overwritten. Refused while
/// a terminal is open on it. The caller holds `CODE_LOCK`.
pub(crate) fn remove_profile_locked(vault: &CodeVault, id: &str) -> Result<(), AppError> {
    let dir = profile_dir(vault, id)?;
    if fs::symlink_metadata(&dir).is_err() {
        return Ok(());
    }
    if locks_held(&dir) {
        return Err(running_error());
    }
    // The conversations written there are the user's: they move aside instead
    // of going with the login.
    let projects = dir.join("projects");
    if fs::read_dir(&projects).is_ok_and(|mut entries| entries.next().is_some()) {
        let keep = removed_root(vault).join(format!(
            "{id}-{}",
            chrono::Utc::now().format("%Y%m%dT%H%M%S")
        ));
        ensure_private_dir(&removed_root(vault))?;
        fs::create_dir_all(&keep).map_err(|e| AppError::io(&keep, e))?;
        fs::rename(&projects, keep.join("projects")).map_err(|e| AppError::io(&projects, e))?;
    }
    for name in [CREDENTIALS_FILE, CLAUDE_JSON_FILE] {
        let _ = scrub_file(&dir.join(name));
    }
    fs::remove_dir_all(&dir).map_err(|e| AppError::io(&dir, e))
}

/// Where the conversations of deleted logins' session folders are kept.
pub(crate) fn removed_root(vault: &CodeVault) -> PathBuf {
    vault.root.join(REMOVED_DIR)
}

pub(crate) fn running_error() -> AppError {
    AppError::Message(
        "这个账号正在一个并行会话的终端里使用。先关闭那个终端，再继续。（终端已经关了还这样提示，是有后台进程还占着它，在任务管理器里结束它们。）"
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_accounts::code::tests::{fixture, login, Fixture};
    use serde_json::json;

    fn saved(f: &Fixture, email: &str, uuid: &str, token: &str) -> String {
        login(&f.paths, email, uuid, token);
        save_current_in(&f.vault, &f.paths, None).unwrap().id
    }

    /// Two saved logins; the second one is the live one.
    fn two(f: &Fixture) -> (String, String) {
        let a = saved(f, "a@example.com", "uuid-a", "token-a");
        let b = saved(f, "b@example.com", "uuid-b", "token-b");
        (a, b)
    }

    fn profile_creds(dir: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(dir.join(CREDENTIALS_FILE)).unwrap()).unwrap()
    }

    fn profile_json(dir: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(dir.join(CLAUDE_JSON_FILE)).unwrap()).unwrap()
    }

    #[test]
    fn a_session_folder_is_seeded_with_the_account_and_leaves_the_live_login_alone() {
        let f = fixture();
        let (a, b) = two(&f);
        let live_before = fs::read(&f.paths.credentials).unwrap();

        let prepared = prepare_in(&f.vault, &f.paths, &a).unwrap();
        assert!(prepared.dir.ends_with(&a));
        assert_eq!(
            profile_creds(&prepared.dir)[CREDENTIALS_KEY]["accessToken"],
            "token-a"
        );
        let json = profile_json(&prepared.dir);
        assert_eq!(json[ACCOUNT_KEY]["emailAddress"], "a@example.com");
        assert_eq!(json["hasCompletedOnboarding"], true);
        assert_eq!(json["theme"], "dark");
        assert!(json.get("projects").is_none(), "history is not copied");
        assert_eq!(fs::read(&f.paths.credentials).unwrap(), live_before);
        assert!(!is_running(&f.vault, &a));

        // The live login (b) cannot also be a session.
        let error = prepare_in(&f.vault, &f.paths, &b)
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("正是 Claude Code 现在使用"), "{error}");
    }

    #[test]
    fn a_login_held_out_of_use_or_needing_a_new_sign_in_is_not_opened() {
        let f = fixture();
        let (a, _b) = two(&f);
        manage::set_disabled_in(&f.vault, &f.paths, &a, true).unwrap();
        assert!(prepare_in(&f.vault, &f.paths, &a)
            .err()
            .unwrap()
            .to_string()
            .contains("已停用"));
        manage::set_disabled_in(&f.vault, &f.paths, &a, false).unwrap();
        mark_needs_relogin(&f.vault, &a).unwrap();
        assert!(prepare_in(&f.vault, &f.paths, &a)
            .err()
            .unwrap()
            .to_string()
            .contains("已失效"));
        assert!(prepare_in(&f.vault, &f.paths, "../x").is_err());
        assert!(!sessions_root(&f.vault).join("..").join("x").exists());
    }

    #[test]
    fn tokens_a_session_refreshed_come_back_into_the_saved_login() {
        let f = fixture();
        let (a, _b) = two(&f);
        let dir = prepare_in(&f.vault, &f.paths, &a).unwrap().dir;

        // Claude Code inside the session refreshed: a later expiry and a new refresh token.
        let mut creds = profile_creds(&dir);
        creds[CREDENTIALS_KEY]["accessToken"] = json!("token-a-2");
        creds[CREDENTIALS_KEY]["refreshToken"] = json!("r-token-a-2");
        creds[CREDENTIALS_KEY]["expiresAt"] = json!(4_102_444_900_000_i64);
        fs::write(dir.join(CREDENTIALS_FILE), creds.to_string()).unwrap();

        assert!(harvest_in(&f.vault, &a).unwrap());
        let slot = f.vault.read_slot(&a).unwrap();
        assert_eq!(slot.claude_ai_oauth["refreshToken"], "r-token-a-2");
        assert_eq!(
            slot.oauth_account.as_ref().unwrap()["emailAddress"],
            "a@example.com"
        );
        assert!(
            !harvest_in(&f.vault, &a).unwrap(),
            "nothing newer the second time"
        );

        // Preparing again keeps the session's tokens.
        prepare_in(&f.vault, &f.paths, &a).unwrap();
        assert_eq!(
            profile_creds(&dir)[CREDENTIALS_KEY]["refreshToken"],
            "r-token-a-2"
        );
    }

    #[test]
    fn older_or_foreign_tokens_in_a_session_folder_are_never_taken() {
        let f = fixture();
        let (a, _b) = two(&f);
        let dir = prepare_in(&f.vault, &f.paths, &a).unwrap().dir;

        // The session folder now belongs to another account (a /login inside it).
        let mut creds = profile_creds(&dir);
        creds[CREDENTIALS_KEY]["refreshToken"] = json!("r-someone-else");
        creds[CREDENTIALS_KEY]["expiresAt"] = json!(4_102_444_900_000_i64);
        fs::write(dir.join(CREDENTIALS_FILE), creds.to_string()).unwrap();
        let mut json = profile_json(&dir);
        json[ACCOUNT_KEY]["emailAddress"] = json!("other@example.com");
        json[ACCOUNT_KEY]["accountUuid"] = json!("uuid-other");
        fs::write(dir.join(CLAUDE_JSON_FILE), json.to_string()).unwrap();
        assert!(!harvest_in(&f.vault, &a).unwrap());
        assert_eq!(
            f.vault.read_slot(&a).unwrap().claude_ai_oauth["refreshToken"],
            "r-token-a"
        );

        // Preparing puts the right account back.
        prepare_in(&f.vault, &f.paths, &a).unwrap();
        assert_eq!(
            profile_creds(&dir)[CREDENTIALS_KEY]["refreshToken"],
            "r-token-a"
        );
        assert_eq!(
            profile_json(&dir)[ACCOUNT_KEY]["emailAddress"],
            "a@example.com"
        );
    }

    #[test]
    fn a_saved_login_that_moved_on_replaces_a_stale_session_copy() {
        let f = fixture();
        let (a, _b) = two(&f);
        let dir = prepare_in(&f.vault, &f.paths, &a).unwrap().dir;
        // The saved login got newer tokens (it was live for a while).
        let mut slot = f.vault.read_slot(&a).unwrap();
        slot.claude_ai_oauth["refreshToken"] = json!("r-token-a-live");
        slot.claude_ai_oauth["accessToken"] = json!("token-a-live");
        slot.claude_ai_oauth["expiresAt"] = json!(4_102_444_990_000_i64);
        f.vault.write_slot(&slot).unwrap();
        prepare_in(&f.vault, &f.paths, &a).unwrap();
        assert_eq!(
            profile_creds(&dir)[CREDENTIALS_KEY]["refreshToken"],
            "r-token-a-live"
        );
    }

    #[test]
    fn tokens_and_keys_are_seeded_the_way_claude_code_reads_them() {
        let f = fixture();
        saved(&f, "a@example.com", "uuid-a", "token-a");
        const KEY: &str = concat!(
            "sk-ant-api03-",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-xyz_1234567890"
        );
        const TOKEN: &str = concat!(
            "sk-ant-oat01-",
            "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB-xyz_1234567890"
        );
        let key = manage::add_secret_in(&f.vault, None, KEY).unwrap();
        let token = manage::add_secret_in(&f.vault, None, TOKEN).unwrap();

        let dir = prepare_in(&f.vault, &f.paths, &key.id).unwrap().dir;
        assert!(
            !dir.join(CREDENTIALS_FILE).exists(),
            "no OAuth login for a key"
        );
        let json = profile_json(&dir);
        assert_eq!(json[API_KEY_FIELD], KEY);
        assert!(json.get(ACCOUNT_KEY).is_none());

        let dir = prepare_in(&f.vault, &f.paths, &token.id).unwrap().dir;
        let oauth = &profile_creds(&dir)[CREDENTIALS_KEY];
        assert_eq!(oauth["accessToken"], TOKEN);
        assert!(oauth.get("refreshToken").is_none());
        assert!(profile_json(&dir).get(API_KEY_FIELD).is_none());
    }

    #[test]
    fn shared_settings_and_mcp_servers_follow_the_default_login_on_every_launch() {
        let f = fixture();
        let (a, _b) = two(&f);
        let default_dir = f.paths.credentials.parent().unwrap().to_path_buf();
        fs::write(default_dir.join("settings.json"), "{\"model\":\"opus\"}").unwrap();
        fs::write(default_dir.join("CLAUDE.md"), "# rules").unwrap();
        fs::create_dir_all(default_dir.join("skills").join("one")).unwrap();
        fs::write(
            default_dir.join("skills").join("one").join("SKILL.md"),
            "skill",
        )
        .unwrap();
        fs::create_dir_all(default_dir.join("projects")).unwrap();
        fs::write(default_dir.join("projects").join("history.jsonl"), "{}").unwrap();
        let mut claude: Value =
            serde_json::from_str(&fs::read_to_string(&f.paths.claude_json).unwrap()).unwrap();
        claude[MCP_KEY] = json!({"docs": {"command": "docs-mcp"}});
        claude["theme"] = json!("light");
        fs::write(&f.paths.claude_json, claude.to_string()).unwrap();

        let dir = prepare_in(&f.vault, &f.paths, &a).unwrap().dir;
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings, json!({"model": "opus"}));
        assert_eq!(
            fs::read_to_string(dir.join("skills/one/SKILL.md")).unwrap(),
            "skill"
        );
        assert!(!dir.join("projects").exists(), "history is not shared");
        let json = profile_json(&dir);
        assert_eq!(json[MCP_KEY]["docs"]["command"], "docs-mcp");
        assert_eq!(json["theme"], "light");

        // The default login drops its skills and servers; the session follows.
        fs::remove_dir_all(default_dir.join("skills")).unwrap();
        fs::write(default_dir.join("CLAUDE.md"), "# new rules").unwrap();
        let mut claude: Value =
            serde_json::from_str(&fs::read_to_string(&f.paths.claude_json).unwrap()).unwrap();
        claude.as_object_mut().unwrap().remove(MCP_KEY);
        fs::write(&f.paths.claude_json, claude.to_string()).unwrap();
        prepare_in(&f.vault, &f.paths, &a).unwrap();
        assert!(!dir.join("skills").exists());
        assert_eq!(
            fs::read_to_string(dir.join("CLAUDE.md")).unwrap(),
            "# new rules"
        );
        assert!(profile_json(&dir).get(MCP_KEY).is_none());
    }

    #[test]
    fn the_session_keeps_the_projects_it_has_recorded_across_launches() {
        let f = fixture();
        let (a, _b) = two(&f);
        let dir = prepare_in(&f.vault, &f.paths, &a).unwrap().dir;
        let mut json = profile_json(&dir);
        json["projects"] = json!({"D:/work": {"history": ["hi"]}});
        json["theme"] = json!("light-daltonized");
        fs::write(dir.join(CLAUDE_JSON_FILE), json.to_string()).unwrap();
        prepare_in(&f.vault, &f.paths, &a).unwrap();
        let json = profile_json(&dir);
        assert_eq!(json["projects"]["D:/work"]["history"][0], "hi");
        assert_eq!(
            json["theme"], "light-daltonized",
            "a theme the user chose stays"
        );
    }

    #[cfg(windows)]
    #[test]
    fn open_terminals_hold_lock_files_and_block_removing_the_folder() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = fixture();
        let (a, _b) = two(&f);
        let dir = prepare_in(&f.vault, &f.paths, &a).unwrap().dir;
        assert!(!is_running(&f.vault, &a));
        // What `9>file` in a launcher does: the file stays open, writes unshared.
        let hold = |name: &str| {
            fs::OpenOptions::new()
                .write(true)
                .create(true)
                .share_mode(1)
                .open(dir.join(name))
                .unwrap()
        };
        let first = hold(".session.1.lock");
        let second = hold(".session.2.lock");
        assert!(is_running(&f.vault, &a));
        {
            let _guard = CODE_LOCK.lock().unwrap();
            assert!(remove_profile_locked(&f.vault, &a)
                .err()
                .unwrap()
                .to_string()
                .contains("并行会话"));
        }
        // A second prepare while they run leaves the folder's credentials alone.
        let before = fs::read(dir.join(CREDENTIALS_FILE)).unwrap();
        prepare_in(&f.vault, &f.paths, &a).unwrap();
        assert_eq!(fs::read(dir.join(CREDENTIALS_FILE)).unwrap(), before);

        drop(first);
        assert!(is_running(&f.vault, &a), "the other terminal is still open");
        assert!(
            !dir.join(".session.1.lock").exists(),
            "the ended one is swept"
        );
        drop(second);
        assert!(!is_running(&f.vault, &a));
        assert!(!dir.join(".session.2.lock").exists());
        let _guard = CODE_LOCK.lock().unwrap();
        remove_profile_locked(&f.vault, &a).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn the_launcher_clears_overrides_holds_its_own_lock_and_leaves_no_trace() {
        let script = launcher_script(Path::new(r"C:\Users\me\v\sessions\a1"));
        assert!(script.starts_with("@echo off\r\nsetlocal DisableDelayedExpansion\r\n"));
        for name in AUTH_OVERRIDE_ENV {
            assert!(script.contains(&format!("set \"{name}=\"\r\n")), "{name}");
        }
        assert!(script.contains("set \"ANTHROPIC_BASE_URL=\"\r\n"));
        // Whatever else begins that way goes too, and cmd does not run what
        // sits in the folder it is opened in.
        assert!(script
            .contains("for /f \"delims==\" %%v in ('set ANTHROPIC_ 2^>nul') do set \"%%v=\"\r\n"));
        assert!(script.contains(
            "for /f \"delims==\" %%v in ('set CLAUDE_CODE_USE_ 2^>nul') do set \"%%v=\"\r\n"
        ));
        assert!(script.contains("set \"NoDefaultCurrentDirectoryInExePath=1\"\r\n"));
        assert!(script.contains("set \"CLAUDE_CONFIG_DIR=C:\\Users\\me\\v\\sessions\\a1\"\r\n"));
        // Its own lock file per launch, so two terminals can both run.
        assert!(script.contains(
            "(call claude) 9>\"C:\\Users\\me\\v\\sessions\\a1\\.session.%RANDOM%%RANDOM%.lock\"\r\n"
        ));
        // The console and the shell it was run from are left as they were.
        assert!(script.contains("chcp 65001 >nul\r\n"));
        assert!(script.ends_with("chcp %CHIMERA_CP% >nul\r\nendlocal\r\n"));
        assert!(launcher_script(Path::new(r"C:\100%\x")).contains("100%%"));
    }

    #[test]
    fn shell_commands_run_the_launcher_from_cmd_and_powershell() {
        let launcher = Path::new(r"C:\Users\me\it's\sessions\a1\start-claude.bat");
        let (cmd, powershell) = shell_commands(launcher);
        assert_eq!(
            cmd,
            "\"C:\\Users\\me\\it's\\sessions\\a1\\start-claude.bat\""
        );
        assert_eq!(
            powershell,
            "& 'C:\\Users\\me\\it''s\\sessions\\a1\\start-claude.bat'"
        );
        // PowerShell also reads curly quotes as quotes.
        let (_, curly) = shell_commands(Path::new("C:\\Users\\O\u{2019}Brien\\start-claude.bat"));
        assert_eq!(
            curly,
            "& 'C:\\Users\\O\u{2019}\u{2019}Brien\\start-claude.bat'"
        );
    }

    #[test]
    fn shared_settings_drop_every_provider_entry_but_keep_the_rest() {
        let (text, removed) = shared_settings(
            r#"{"model":"opus","apiKeyHelper":"x","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1","ANTHROPIC_AUTH_TOKEN":"PROXY_MANAGED.k","ANTHROPIC_MODEL":"kimi-k2","ANTHROPIC_DEFAULT_SONNET_MODEL":"kimi-k2","CLAUDE_CODE_USE_BEDROCK":"1","API_TIMEOUT_MS":"600000","EDITOR":"vim"}}"#,
        )
        .unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["model"], "opus");
        assert_eq!(
            value["env"],
            json!({"API_TIMEOUT_MS": "600000", "EDITOR": "vim"})
        );
        assert!(value.get("apiKeyHelper").is_none());
        for name in [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_BASE_URL",
            "apiKeyHelper",
        ] {
            assert!(removed.contains(&name.to_string()), "{name}");
        }
    }
}
