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
const LOCK_FILE: &str = ".session.lock";
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

/// Environment variables that make Claude Code ignore a login. A session is
/// an explicit request for one account, so they are cleared for it.
pub(crate) const AUTH_OVERRIDE_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
];

pub(crate) fn sessions_root(vault: &CodeVault) -> PathBuf {
    vault.root.join(SESSIONS_DIR)
}

pub(crate) fn profile_dir(vault: &CodeVault, id: &str) -> Result<PathBuf, AppError> {
    crate::claude_accounts::validate_account_id(id)?;
    Ok(sessions_root(vault).join(id))
}

/// The file the launcher keeps open while `claude` runs.
pub(crate) fn lock_path(dir: &Path) -> PathBuf {
    dir.join(LOCK_FILE)
}

#[cfg(windows)]
fn lock_held(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    // Share mode 0 conflicts with any handle that is still open.
    match fs::OpenOptions::new().read(true).share_mode(0).open(path) {
        Ok(_) => false,
        Err(error) => error.raw_os_error() == Some(32),
    }
}

#[cfg(not(windows))]
fn lock_held(_path: &Path) -> bool {
    false
}

/// Whether a terminal is open on this login's session folder.
pub(crate) fn is_running(vault: &CodeVault, id: &str) -> bool {
    profile_dir(vault, id).is_ok_and(|dir| lock_held(&lock_path(&dir)))
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

fn sync_shared(dir: &Path, default_dir: &Path) -> Vec<String> {
    let mut copied = Vec::new();
    let mut budget = Budget { bytes: 0, files: 0 };
    for name in SHARED_ITEMS {
        let src = default_dir.join(name);
        let dst = dir.join(name);
        if fs::symlink_metadata(&src).is_err() {
            continue;
        }
        remove_path(&dst);
        match copy_tree(&src, &dst, &mut budget) {
            Ok(()) => copied.push((*name).to_string()),
            Err(error) => {
                log::warn!("复制共享配置 {name} 失败: {error}");
                remove_path(&dst);
            }
        }
    }
    copied
}

// ===== operations =====

/// A session folder ready to start `claude` in.
pub(crate) struct Prepared {
    pub dir: PathBuf,
    pub name: String,
}

fn live_matches(paths: &LivePaths, slot: &Slot) -> bool {
    read_live(paths)
        .ok()
        .as_ref()
        .and_then(live_identity)
        .is_some_and(|ident| same_login(&ident, &slot.identity()))
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
    let prepared = |slot: &Slot| Prepared {
        dir: dir.clone(),
        name: slot.name.clone(),
    };
    if lock_held(&lock_path(&dir)) {
        // A second terminal on the same folder shares the first one's tokens.
        return Ok(prepared(&slot));
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
    let items = sync_shared(&dir, &default_dir);
    // Items that were shared before and are gone from the default folder.
    for stale in manifest.items.iter().filter(|name| !items.contains(name)) {
        if SHARED_ITEMS.contains(&stale.as_str()) {
            remove_path(&dir.join(stale));
        }
    }
    write_manifest(&dir, &Manifest { items, mcp })?;
    Ok(prepared(&slot))
}

/// The commands that start `claude` on a prepared folder from a shell the
/// user already has open (cmd, PowerShell).
pub(crate) fn shell_commands(dir: &Path) -> (String, String) {
    let text = dir.to_string_lossy();
    (
        format!("set \"CLAUDE_CONFIG_DIR={text}\" && claude"),
        format!(
            "$env:CLAUDE_CONFIG_DIR = '{}'; claude",
            text.replace('\'', "''")
        ),
    )
}

/// Removes a login's session folder, tokens first overwritten. Refused while
/// a terminal is open on it. The caller holds `CODE_LOCK`.
pub(crate) fn remove_profile_locked(vault: &CodeVault, id: &str) -> Result<(), AppError> {
    let dir = profile_dir(vault, id)?;
    if fs::symlink_metadata(&dir).is_err() {
        return Ok(());
    }
    if lock_held(&lock_path(&dir)) {
        return Err(running_error());
    }
    for name in [CREDENTIALS_FILE, CLAUDE_JSON_FILE] {
        let _ = scrub_file(&dir.join(name));
    }
    fs::remove_dir_all(&dir).map_err(|e| AppError::io(&dir, e))
}

pub(crate) fn running_error() -> AppError {
    AppError::Message("这个账号正在一个并行会话的终端里使用。先关闭那个终端，再继续。".to_string())
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
        assert_eq!(
            fs::read_to_string(dir.join("settings.json")).unwrap(),
            "{\"model\":\"opus\"}"
        );
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
    fn an_open_terminal_is_a_held_lock_and_blocks_removing_the_folder() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = fixture();
        let (a, _b) = two(&f);
        let dir = prepare_in(&f.vault, &f.paths, &a).unwrap().dir;
        assert!(!is_running(&f.vault, &a));
        // What `9>file` in the launcher does: the file stays open, shared for read and write.
        let held = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .share_mode(3)
            .open(lock_path(&dir))
            .unwrap();
        assert!(is_running(&f.vault, &a));
        {
            let _guard = CODE_LOCK.lock().unwrap();
            assert!(remove_profile_locked(&f.vault, &a)
                .err()
                .unwrap()
                .to_string()
                .contains("并行会话"));
        }
        // A second prepare while it runs leaves the folder's credentials alone.
        let before = fs::read(dir.join(CREDENTIALS_FILE)).unwrap();
        prepare_in(&f.vault, &f.paths, &a).unwrap();
        assert_eq!(fs::read(dir.join(CREDENTIALS_FILE)).unwrap(), before);
        drop(held);
        assert!(!is_running(&f.vault, &a));
        let _guard = CODE_LOCK.lock().unwrap();
        remove_profile_locked(&f.vault, &a).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn shell_commands_set_the_folder_for_cmd_and_powershell() {
        let (cmd, powershell) = shell_commands(Path::new(r"C:\Users\me\it's\sessions\a1"));
        assert_eq!(
            cmd,
            "set \"CLAUDE_CONFIG_DIR=C:\\Users\\me\\it's\\sessions\\a1\" && claude"
        );
        assert_eq!(
            powershell,
            "$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\it''s\\sessions\\a1'; claude"
        );
    }
}
