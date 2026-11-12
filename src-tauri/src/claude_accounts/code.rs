//! Claude Code accounts: saved logins switched in place.
//!
//! Every account uses the one Claude Code config directory, so sessions,
//! history, settings and MCP are shared and never move. An account is the
//! `claudeAiOauth` object of `<config>/.credentials.json` plus the
//! `oauthAccount` block of `.claude.json`; switching rewrites only those two
//! keys and keeps every other field (and key order) of both files.
//!
//! Saved logins live in a private vault next to the official-account vault
//! (`<per-user data>/Chimera++/claude-vault`, never the relocatable app data
//! directory), DPAPI-encrypted on Windows and 0600 on Unix like that vault.
//! Nothing here logs, exports or returns a token: the frontend gets email,
//! plan, a short fingerprint and flags.
//!
//! macOS keeps Claude Code's token in the Keychain, which is not handled
//! yet: saving and switching are refused there.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::{
    child_path, fitted_name, new_account_id, normalize_account_name, plan_label, strip_bom,
};
use crate::error::AppError;
use crate::security_limits::{is_link_or_reparse_point, read_limited};

pub(crate) mod bindings;
pub(crate) mod browser_login;
pub(crate) mod manage;
pub(crate) mod sessions;
pub(crate) mod transfer;

const VAULT_DIR: &str = "claude-vault";
const SLOTS_DIR: &str = "accounts";
const BACKUPS_DIR: &str = "backups";
const QUOTA_DIR: &str = "quota";
const SLOT_SUFFIX: &str = ".json";
const SLOT_VERSION: u32 = 1;
const KEEP_BACKUPS: usize = 5;
const MAX_SLOT_BYTES: u64 = 1024 * 1024;
const MAX_ACCOUNTS: usize = 50;
const MAX_EMAIL_LEN: usize = 320;
const DEFAULT_NAME: &str = "Claude 账号";
const UNREADABLE_NAME: &str = "无法读取的账号";
#[cfg(windows)]
const SEALED_MAGIC: &[u8] = b"CPPCLAUDE1\n";

pub(crate) const CREDENTIALS_KEY: &str = "claudeAiOauth";
pub(crate) const ACCOUNT_KEY: &str = "oauthAccount";
/// Where Claude Code keeps a Console API key it was given at `/login`.
const API_KEY_FIELD: &str = "primaryApiKey";
const API_KEY_RESPONSES: &str = "customApiKeyResponses";

/// Serializes every vault and live-file mutation.
static CODE_LOCK: Mutex<()> = Mutex::new(());

/// One async lock per account: a token refresh and a switch of the same
/// account never overlap, and at most one refresh per account runs.
/// Present in a vault whose permissions were set. Setting them walks every
/// file under the root (parallel session folders hold thousands), and folders
/// made later inherit them.
#[cfg(windows)]
const ACL_MARKER: &str = ".acl-set";

static ACCOUNT_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn account_lock(id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = ACCOUNT_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

pub(crate) fn switching_supported() -> bool {
    !cfg!(target_os = "macos")
}

const UNSUPPORTED_MESSAGE: &str =
    "macOS 上 Claude Code 把登录令牌存放在钥匙串中，暂不支持保存与切换账号。";

fn ensure_supported() -> Result<(), AppError> {
    if switching_supported() {
        Ok(())
    } else {
        Err(AppError::Message(UNSUPPORTED_MESSAGE.to_string()))
    }
}

// ===== DTOs (no secrets) =====

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeAccountDto {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    /// First 8 hex digits of SHA-256 of the saved access token.
    pub fingerprint: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// This saved login is the one Claude Code uses now.
    pub is_current: bool,
    /// The refresh token was rejected; sign in again and save.
    pub needs_relogin: bool,
    /// The saved entry cannot be decrypted here; it can only be deleted.
    pub unreadable: bool,
    /// A subscription sign-in, a setup-token or a Console API key.
    pub kind: SlotKind,
    /// Held out of use: not switched to, not opened in parallel, no quota reads.
    pub disabled: bool,
    /// A terminal is open on this login (a parallel session).
    pub session_running: bool,
    /// The user's note.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeLiveDto {
    pub signed_in: bool,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub fingerprint: Option<String>,
    /// The saved account matching the live login, if any.
    pub saved_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeAccountsDto {
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    /// Adding a login through the browser can be started from this app.
    pub browser_login_supported: bool,
    /// A terminal can be opened on a saved login (parallel sessions).
    pub sessions_supported: bool,
    pub live: CodeLiveDto,
    /// The live login files could not be read (shown instead of "signed out").
    pub live_error: Option<String>,
    pub accounts: Vec<CodeAccountDto>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SwitchStatus {
    Switched,
    AlreadyCurrent,
    /// A Claude Code process is running; nothing was changed.
    ClaudeRunning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchOutcome {
    pub status: SwitchStatus,
    /// The outgoing login was not saved yet and was saved under this id.
    pub auto_saved_id: Option<String>,
}

// ===== vault =====

/// What a saved login is made of.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotKind {
    /// A subscription sign-in: access and refresh token, and the account.
    #[default]
    Oauth,
    /// A long-lived `claude setup-token` token: inference only, no refresh token.
    SetupToken,
    /// A Console API key.
    ApiKey,
    /// Only Claude Desktop's sign-in of an account (a snapshot), saved from
    /// the Desktop on this computer. It has no Claude Code tokens: it cannot
    /// be switched to in Claude Code, opened in a terminal or exported, and
    /// becomes a subscription login once Claude Code's login of the same
    /// account is saved.
    DesktopOnly,
}

fn is_oauth_kind(kind: &SlotKind) -> bool {
    *kind == SlotKind::Oauth
}

/// A saved login. Deliberately not `Debug`: it holds tokens.
///
/// Fields added after the first version are skipped while they hold their
/// default, so a subscription login is written exactly as before.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Slot {
    version: u32,
    id: String,
    name: String,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    needs_relogin: bool,
    #[serde(default)]
    oauth_account: Option<Value>,
    /// `null` for an API key, which has no OAuth object.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    claude_ai_oauth: Value,
    #[serde(default, skip_serializing_if = "is_oauth_kind")]
    kind: SlotKind,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    disabled: bool,
    /// Manual order; `None` until the list is reordered once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    position: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    /// The user's own words about this login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

enum SlotEntry {
    Readable(Box<Slot>),
    Unreadable(String),
}

pub(crate) struct CodeVault {
    root: PathBuf,
}

fn default_vault_root() -> PathBuf {
    crate::codex_accounts::vault::default_vault_root().with_file_name(VAULT_DIR)
}

fn relocation_refused(path: &Path) -> AppError {
    AppError::Message(format!(
        "Claude 账号保险库路径不能是链接或其它位置的映射：{}",
        path.display()
    ))
}

fn ensure_private_dir(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|e| AppError::io(path, e))?;
        }
        Err(error) => return Err(AppError::io(path, error)),
    }
    let meta = fs::symlink_metadata(path).map_err(|e| AppError::io(path, e))?;
    if is_link_or_reparse_point(&meta) || !meta.is_dir() {
        return Err(relocation_refused(path));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|e| AppError::io(path, e))?;
    }
    Ok(())
}

fn seal(plain: &[u8]) -> Result<Vec<u8>, AppError> {
    #[cfg(windows)]
    {
        let blob =
            crate::codex_accounts::vault::win::protect(plain).map_err(|e| AppError::IoContext {
                context: "无法加密已保存的 Claude 登录".to_string(),
                source: e,
            })?;
        let mut sealed = SEALED_MAGIC.to_vec();
        sealed.extend_from_slice(&blob);
        Ok(sealed)
    }
    #[cfg(not(windows))]
    {
        Ok(plain.to_vec())
    }
}

fn unseal(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    #[cfg(windows)]
    {
        let blob = bytes
            .strip_prefix(SEALED_MAGIC)
            .ok_or_else(|| AppError::Config("已保存的 Claude 登录格式无效".to_string()))?;
        crate::codex_accounts::vault::win::unprotect(blob).map_err(|e| AppError::IoContext {
            context: "无法解密已保存的 Claude 登录".to_string(),
            source: e,
        })
    }
    #[cfg(not(windows))]
    {
        Ok(bytes.to_vec())
    }
}

/// Overwrites a file with zeros before removing it (best effort against
/// recovering a token from free space).
fn scrub_file(path: &Path) -> Result<(), AppError> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.is_file() {
            if let Ok(mut file) = fs::OpenOptions::new().write(true).open(path) {
                use std::io::Write;
                let zeros = vec![0u8; meta.len().min(16 * 1024 * 1024) as usize];
                let _ = file.write_all(&zeros);
                let _ = file.sync_all();
            }
        }
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::io(path, error)),
    }
}

fn private_write(path: &Path, data: &[u8]) -> Result<(), AppError> {
    crate::config::atomic_write_checked::<AppError, _>(path, data, true, || Ok(()))
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

impl CodeVault {
    pub(crate) fn open_default() -> Result<Self, AppError> {
        Self::open_at(default_vault_root())
    }

    pub(crate) fn open_at(root: PathBuf) -> Result<Self, AppError> {
        ensure_private_dir(&root)?;
        #[cfg(windows)]
        {
            let marker = root.join(ACL_MARKER);
            if fs::symlink_metadata(&marker).is_err() {
                crate::codex_accounts::vault::win::restrict_to_current_user(&root).map_err(
                    |e| AppError::IoContext {
                        context: format!("无法设置 Claude 账号保险库权限: {}", root.display()),
                        source: e,
                    },
                )?;
                // Only after it worked, so a failure is tried again.
                let _ = fs::write(&marker, b"");
            }
        }
        for sub in [SLOTS_DIR, BACKUPS_DIR, QUOTA_DIR] {
            ensure_private_dir(&root.join(sub))?;
        }
        Ok(Self { root })
    }

    fn slot_path(&self, id: &str) -> Result<PathBuf, AppError> {
        child_path(&self.root.join(SLOTS_DIR), id, SLOT_SUFFIX)
    }

    pub(crate) fn quota_path(&self, id: &str) -> Result<PathBuf, AppError> {
        child_path(&self.root.join(QUOTA_DIR), id, SLOT_SUFFIX)
    }

    pub(crate) fn read_slot(&self, id: &str) -> Result<Slot, AppError> {
        let path = self.slot_path(id)?;
        let sealed = read_limited(&path, MAX_SLOT_BYTES).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                AppError::InvalidInput("账号不存在或已被删除".to_string())
            } else {
                AppError::io(&path, error)
            }
        })?;
        let plain = unseal(&sealed)?;
        let mut slot: Slot =
            serde_json::from_slice(&plain).map_err(|e| AppError::json(&path, e))?;
        // The file name is authoritative.
        slot.id = id.to_string();
        Ok(slot)
    }

    /// `read_slot`, retrying a file that is briefly locked (antivirus, a
    /// sync tool) so it is not listed as unreadable, which only offers delete.
    fn read_slot_retrying(&self, id: &str) -> Result<Slot, AppError> {
        let mut attempt = 0;
        loop {
            match self.read_slot(id) {
                Err(AppError::Io { .. }) if attempt < 2 => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(60 * attempt));
                }
                result => return result,
            }
        }
    }

    pub(crate) fn write_slot(&self, slot: &Slot) -> Result<(), AppError> {
        let path = self.slot_path(&slot.id)?;
        let plain = serde_json::to_vec(slot).map_err(|e| AppError::JsonSerialize { source: e })?;
        let sealed = seal(&plain)?;
        if sealed.len() as u64 > MAX_SLOT_BYTES {
            return Err(AppError::Message(
                "这份登录的内容太大，无法保存".to_string(),
            ));
        }
        private_write(&path, &sealed)
    }

    fn remove_slot(&self, id: &str) -> Result<(), AppError> {
        let path = self.slot_path(id)?;
        if fs::symlink_metadata(&path).is_err() {
            return Err(AppError::InvalidInput("账号不存在或已被删除".to_string()));
        }
        scrub_file(&path)?;
        if let Ok(quota) = self.quota_path(id) {
            let _ = fs::remove_file(quota);
        }
        Ok(())
    }

    fn slot_ids(&self) -> Vec<String> {
        let dir = self.root.join(SLOTS_DIR);
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut ids: Vec<String> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| {
                let name = entry.file_name();
                let id = name.to_str()?.strip_suffix(SLOT_SUFFIX)?.to_string();
                super::validate_account_id(&id).ok().map(|()| id)
            })
            .collect();
        ids.sort();
        ids
    }

    fn entries(&self) -> Vec<SlotEntry> {
        let mut entries: Vec<SlotEntry> = self
            .slot_ids()
            .into_iter()
            .map(|id| match self.read_slot_retrying(&id) {
                Ok(slot) => SlotEntry::Readable(Box::new(slot)),
                Err(_) => SlotEntry::Unreadable(id),
            })
            .collect();
        entries.sort_by_key(entry_order);
        entries
    }

    fn readable_slots(&self) -> Vec<Slot> {
        self.entries()
            .into_iter()
            .filter_map(|entry| match entry {
                SlotEntry::Readable(slot) => Some(*slot),
                SlotEntry::Unreadable(_) => None,
            })
            .collect()
    }

    /// Encrypted copies of both live files, kept for the last few switches.
    fn backup(&self, files: &[(&str, Option<&[u8]>)]) -> Result<(), AppError> {
        let backups = self.root.join(BACKUPS_DIR);
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let stamp = format!(
            "{}-{}",
            chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
            &suffix[..6]
        );
        let dir = backups.join(stamp);
        ensure_private_dir(&dir)?;
        for (name, content) in files {
            if let Some(content) = content {
                private_write(&dir.join(format!("{name}.sealed")), &seal(content)?)?;
            }
        }
        let mut existing: Vec<PathBuf> = fs::read_dir(backups)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                    .map(|entry| entry.path())
                    .collect()
            })
            .unwrap_or_default();
        existing.sort();
        let excess = existing.len().saturating_sub(KEEP_BACKUPS);
        for old in existing.into_iter().take(excess) {
            if let Ok(files) = fs::read_dir(&old) {
                for file in files.flatten() {
                    let _ = scrub_file(&file.path());
                }
            }
            let _ = fs::remove_dir(old);
        }
        Ok(())
    }
}

/// Manually ordered logins first, then the rest by when they were added;
/// entries that cannot be read last.
fn entry_order(entry: &SlotEntry) -> (u64, String, String) {
    match entry {
        SlotEntry::Readable(slot) => (
            slot.position.unwrap_or(u64::MAX - 1),
            slot.created_at.clone(),
            slot.id.clone(),
        ),
        SlotEntry::Unreadable(id) => (u64::MAX, "~".to_string(), id.clone()),
    }
}

// ===== live files =====

pub(crate) struct LivePaths {
    pub credentials: PathBuf,
    pub claude_json: PathBuf,
}

impl LivePaths {
    pub(crate) fn current() -> Self {
        Self {
            credentials: crate::config::get_claude_config_dir().join(".credentials.json"),
            claude_json: crate::config::get_claude_mcp_path(),
        }
    }
}

/// Raw bytes of a live file; `None` when it does not exist. Links are
/// refused: an atomic replace would turn the link into a plain file.
/// `.claude.json` also carries Claude Code's per-project history and grows
/// well past the usual config-file cap on busy machines.
const MAX_LIVE_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    match read_limited(path, MAX_LIVE_FILE_BYTES) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io(path, error)),
    }
}

struct Live {
    credentials: Option<Vec<u8>>,
    claude_json: Option<Vec<u8>>,
    oauth: Option<Value>,
    account: Option<Value>,
    /// The Console API key Claude Code was given, when it is not signed in
    /// with a subscription (a subscription login wins over a key).
    api_key: Option<String>,
    /// `primaryApiKey` as written, even beside a subscription login.
    primary_key: Option<String>,
}

fn parse_object(bytes: Option<&[u8]>) -> Option<Map<String, Value>> {
    let text = std::str::from_utf8(bytes?).ok()?;
    match serde_json::from_str::<Value>(strip_bom(text)).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// A usable `claudeAiOauth` object: one with a non-empty access token.
fn usable_oauth(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    value
        .get("accessToken")
        .and_then(Value::as_str)
        .is_some_and(|token| !token.is_empty())
        .then(|| value.clone())
}

fn parse_live(
    credentials: Option<&[u8]>,
    claude_json: Option<&[u8]>,
) -> (Option<Value>, Option<Value>) {
    let oauth = parse_object(credentials).and_then(|map| usable_oauth(map.get(CREDENTIALS_KEY)));
    let account = parse_object(claude_json).and_then(|map| {
        map.get(ACCOUNT_KEY)
            .filter(|value| value.is_object())
            .cloned()
    });
    (oauth, account)
}

fn parse_api_key(claude_json: Option<&[u8]>) -> Option<String> {
    parse_object(claude_json)?
        .get(API_KEY_FIELD)?
        .as_str()
        .map(str::trim)
        .filter(|key| !key.is_empty() && key.len() <= manage::MAX_SECRET_LEN)
        .filter(|key| manage::secret_chars_ok(key))
        .map(str::to_string)
}

fn read_live(paths: &LivePaths) -> Result<Live, AppError> {
    let credentials = read_optional(&paths.credentials)?;
    let claude_json = read_optional(&paths.claude_json)?;
    let (oauth, account) = parse_live(credentials.as_deref(), claude_json.as_deref());
    let primary_key = parse_api_key(claude_json.as_deref());
    let api_key = if oauth.is_none() {
        primary_key.clone()
    } else {
        None
    };
    Ok(Live {
        credentials,
        claude_json,
        oauth,
        account,
        api_key,
        primary_key,
    })
}

// ===== identity =====

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Identity {
    account_uuid: Option<String>,
    organization_uuid: Option<String>,
    email: Option<String>,
    fingerprint: Option<String>,
}

fn text_field(value: Option<&Value>, key: &str) -> Option<String> {
    value?
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.len() <= MAX_EMAIL_LEN)
        .filter(|text| !text.chars().any(char::is_control))
        .map(str::to_string)
}

/// First 8 hex digits of SHA-256 of a token or key.
pub(crate) fn secret_fingerprint(secret: &str) -> String {
    Sha256::digest(secret.as_bytes())
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn token_fingerprint(oauth: Option<&Value>) -> Option<String> {
    let token = oauth?.get("accessToken")?.as_str()?;
    if token.is_empty() {
        return None;
    }
    Some(secret_fingerprint(token))
}

fn refresh_token_of(oauth: &Value) -> Option<&str> {
    oauth
        .get("refreshToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
}

/// Another saved login whose tokens are exactly the live ones. Then the live
/// `.claude.json` names a different account than the tokens belong to (a
/// switch was undone halfway, or Claude Code wrote back its old login), and
/// the live tokens must not be saved under the account it names.
fn tokens_owned_elsewhere(vault: &CodeVault, oauth: &Value, ident: &Identity) -> bool {
    let Some(token) = refresh_token_of(oauth) else {
        return false;
    };
    vault.readable_slots().iter().any(|slot| {
        refresh_token_of(&slot.claude_ai_oauth) == Some(token)
            && !same_login(&slot.identity(), ident)
    })
}

const MISMATCHED_LOGIN: &str = "Claude Code 的账号信息和登录令牌不一致（可能是切换时 Claude Code 仍在运行）。请在 Claude Code 中用 /login 重新登录，再保存当前登录。";

fn identity(account: Option<&Value>, oauth: Option<&Value>) -> Identity {
    Identity {
        account_uuid: text_field(account, "accountUuid"),
        organization_uuid: text_field(account, "organizationUuid"),
        email: text_field(account, "emailAddress"),
        fingerprint: token_fingerprint(oauth),
    }
}

/// Same Claude login: account uuid (and organization, when both carry one),
/// else email, else the token fingerprint.
pub(crate) fn same_login(left: &Identity, right: &Identity) -> bool {
    if let (Some(a), Some(b)) = (&left.account_uuid, &right.account_uuid) {
        let same_org = match (&left.organization_uuid, &right.organization_uuid) {
            (Some(x), Some(y)) => x == y,
            _ => true,
        };
        return a == b && same_org;
    }
    if let (Some(a), Some(b)) = (&left.email, &right.email) {
        return a.eq_ignore_ascii_case(b);
    }
    matches!((&left.fingerprint, &right.fingerprint), (Some(a), Some(b)) if a == b)
}

fn plan_of(account: Option<&Value>, oauth: Option<&Value>) -> Option<String> {
    plan_label(
        account
            .and_then(|value| value.get("organizationType"))
            .and_then(Value::as_str),
        oauth
            .and_then(|value| value.get("subscriptionType"))
            .and_then(Value::as_str),
    )
    .map(str::to_string)
}

impl Slot {
    fn identity(&self) -> Identity {
        match self.kind {
            SlotKind::ApiKey => Identity {
                fingerprint: self.api_key.as_deref().map(secret_fingerprint),
                ..Identity::default()
            },
            _ => identity(self.oauth_account.as_ref(), Some(&self.claude_ai_oauth)),
        }
    }

    pub(crate) fn kind(&self) -> SlotKind {
        self.kind
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn oauth(&self) -> &Value {
        &self.claude_ai_oauth
    }

    pub(crate) fn needs_relogin(&self) -> bool {
        self.needs_relogin
    }

    fn dto(&self, live: Option<&Identity>) -> CodeAccountDto {
        let ident = self.identity();
        CodeAccountDto {
            id: self.id.clone(),
            name: self.name.clone(),
            email: ident.email.clone(),
            plan: match self.kind {
                SlotKind::Oauth => {
                    plan_of(self.oauth_account.as_ref(), Some(&self.claude_ai_oauth))
                }
                SlotKind::SetupToken | SlotKind::ApiKey | SlotKind::DesktopOnly => None,
            },
            fingerprint: ident.fingerprint.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            // Claude Code cannot be signed in with a Desktop-only login.
            is_current: self.kind != SlotKind::DesktopOnly
                && live.is_some_and(|live| same_login(live, &ident)),
            needs_relogin: self.needs_relogin,
            unreadable: false,
            kind: self.kind,
            disabled: self.disabled,
            session_running: false,
            note: self.note.clone(),
        }
    }

    /// Takes the newest tokens (and profile) of the same login.
    fn absorb(&mut self, oauth: Value, account: Option<Value>) {
        // A Desktop-only login of the same account gains its Claude Code
        // tokens and keeps its Desktop snapshot.
        if self.kind == SlotKind::DesktopOnly {
            self.kind = SlotKind::Oauth;
        }
        self.claude_ai_oauth = oauth;
        if account.is_some() {
            self.oauth_account = account;
        }
        self.needs_relogin = false;
        self.updated_at = now_rfc3339();
    }
}

fn unreadable_dto(id: String) -> CodeAccountDto {
    CodeAccountDto {
        id,
        name: UNREADABLE_NAME.to_string(),
        email: None,
        plan: None,
        fingerprint: None,
        created_at: String::new(),
        updated_at: String::new(),
        is_current: false,
        needs_relogin: true,
        unreadable: true,
        kind: SlotKind::Oauth,
        disabled: false,
        session_running: false,
        note: None,
    }
}

/// A long-lived `claude setup-token` token: no refresh token to rotate.
fn is_setup_token_oauth(oauth: &Value) -> bool {
    refresh_token_of(oauth).is_none()
        && oauth
            .get("accessToken")
            .and_then(Value::as_str)
            .is_some_and(|token| token.starts_with("sk-ant-oat"))
}

fn live_identity(live: &Live) -> Option<Identity> {
    if let Some(oauth) = &live.oauth {
        // The `oauthAccount` beside a token may be left over from another
        // login (Claude Code wrote it back); only the token says who it is.
        if is_setup_token_oauth(oauth) {
            return Some(Identity {
                fingerprint: token_fingerprint(Some(oauth)),
                ..Identity::default()
            });
        }
        return Some(identity(live.account.as_ref(), Some(oauth)));
    }
    live.api_key.as_deref().map(|key| Identity {
        fingerprint: Some(secret_fingerprint(key)),
        ..Identity::default()
    })
}

// ===== operations =====

pub(crate) fn list_in(vault: &CodeVault, paths: &LivePaths) -> CodeAccountsDto {
    let (live, live_error) = match read_live(paths) {
        Ok(live) => (Some(live), None),
        Err(error) => (None, Some(error.to_string())),
    };
    let live_ident = live.as_ref().and_then(live_identity);
    let mut saved_id = None;
    let accounts: Vec<CodeAccountDto> = vault
        .entries()
        .into_iter()
        .map(|entry| match entry {
            SlotEntry::Readable(slot) => {
                let mut dto = slot.dto(live_ident.as_ref());
                dto.session_running = sessions::is_running(vault, &slot.id);
                if dto.is_current && saved_id.is_none() {
                    saved_id = Some(dto.id.clone());
                }
                dto
            }
            SlotEntry::Unreadable(id) => unreadable_dto(id),
        })
        .collect();
    let live_dto = match (&live, &live_ident) {
        (Some(live), Some(ident)) => CodeLiveDto {
            signed_in: true,
            email: ident.email.clone(),
            plan: if live.api_key.is_some() {
                Some("API Key".to_string())
            } else {
                plan_of(live.account.as_ref(), live.oauth.as_ref())
            },
            fingerprint: ident.fingerprint.clone(),
            saved_id,
        },
        _ => CodeLiveDto::default(),
    };
    CodeAccountsDto {
        supported: switching_supported(),
        unsupported_reason: (!switching_supported()).then(|| UNSUPPORTED_MESSAGE.to_string()),
        browser_login_supported: switching_supported() && browser_login::browser_login_supported(),
        sessions_supported: switching_supported() && cfg!(windows),
        live: live_dto,
        live_error,
        accounts,
    }
}

fn find_matching(vault: &CodeVault, ident: &Identity) -> Option<Slot> {
    vault
        .readable_slots()
        .into_iter()
        .find(|slot| same_login(&slot.identity(), ident))
}

fn new_slot(
    vault: &CodeVault,
    name: String,
    oauth: Value,
    account: Option<Value>,
) -> Result<Slot, AppError> {
    let mut slot = blank_slot(vault, name)?;
    slot.claude_ai_oauth = oauth;
    slot.oauth_account = account;
    Ok(slot)
}

/// A new saved login with nothing in it yet.
fn blank_slot(vault: &CodeVault, name: String) -> Result<Slot, AppError> {
    if vault.slot_ids().len() >= MAX_ACCOUNTS {
        return Err(AppError::InvalidInput(format!(
            "最多保存 {MAX_ACCOUNTS} 个账号"
        )));
    }
    let mut id = new_account_id();
    while vault.slot_path(&id)?.exists() {
        id = new_account_id();
    }
    let now = now_rfc3339();
    Ok(Slot {
        version: SLOT_VERSION,
        id,
        name,
        created_at: now.clone(),
        updated_at: now,
        needs_relogin: false,
        oauth_account: None,
        claude_ai_oauth: Value::Null,
        kind: SlotKind::Oauth,
        disabled: false,
        position: None,
        api_key: None,
        note: None,
    })
}

const DESKTOP_ONLY_LOGIN: &str =
    "这个账号只保存了 Claude Desktop 的登录，Claude Code 用不了。在 Claude Code 里登录它并保存后即可切换。";

/// Saves the account Claude Desktop is signed in as, as a Desktop-only
/// login, unless a saved login of that account exists. Returns the saved
/// login (new or existing); its Desktop sign-in is captured separately.
pub(crate) fn save_desktop_only_in(
    vault: &CodeVault,
    account_uuid: &str,
    email: Option<&str>,
) -> Result<CodeAccountDto, AppError> {
    let uuid = account_uuid.trim();
    if uuid.is_empty() || uuid.len() > 64 {
        return Err(AppError::Message(
            "没有读到 Claude Desktop 登录的账号编号".to_string(),
        ));
    }
    let email = email
        .map(str::trim)
        .filter(|email| !email.is_empty() && email.len() <= 320 && email.contains('@'));
    let _guard = CODE_LOCK.lock()?;
    if let Some(id) = find_by_account_uuid(vault, uuid) {
        return Ok(vault.read_slot(&id)?.dto(None));
    }
    let name = fitted_name(email.unwrap_or_default(), DEFAULT_NAME);
    let mut slot = blank_slot(vault, name)?;
    slot.kind = SlotKind::DesktopOnly;
    let mut account = serde_json::Map::new();
    account.insert("accountUuid".to_string(), Value::from(uuid));
    if let Some(email) = email {
        account.insert("emailAddress".to_string(), Value::from(email));
    }
    slot.oauth_account = Some(Value::Object(account));
    vault.write_slot(&slot)?;
    Ok(slot.dto(None))
}

const NO_LIVE_LOGIN: &str =
    "当前没有可保存的 Claude Code 登录。请先在终端运行 claude 并用 /login 登录。";

pub(crate) fn save_current_in(
    vault: &CodeVault,
    paths: &LivePaths,
    name: Option<&str>,
) -> Result<CodeAccountDto, AppError> {
    ensure_supported()?;
    let name = name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(normalize_account_name)
        .transpose()?;
    let _guard = CODE_LOCK.lock()?;
    let live = read_live(paths)?;
    if live.oauth.is_none() {
        if let Some(key) = live.api_key.clone() {
            return save_api_key(vault, &key, name);
        }
    }
    let oauth = live
        .oauth
        .clone()
        .ok_or_else(|| AppError::Message(NO_LIVE_LOGIN.to_string()))?;
    if is_setup_token_oauth(&oauth) {
        return save_live_setup_token(vault, &oauth, name);
    }
    let ident = identity(live.account.as_ref(), Some(&oauth));
    if tokens_owned_elsewhere(vault, &oauth, &ident) {
        return Err(AppError::Message(MISMATCHED_LOGIN.to_string()));
    }
    let slot = match find_matching(vault, &ident) {
        // Already saved: take the newest tokens but keep its name. A name
        // typed for a "new" login that turned out to be this one (the
        // `/login` did not happen) must not rename it; renaming has its own
        // action.
        Some(mut slot) => {
            slot.absorb(oauth, live.account.clone());
            slot
        }
        None => {
            let name = name.unwrap_or_else(|| {
                fitted_name(ident.email.as_deref().unwrap_or_default(), DEFAULT_NAME)
            });
            new_slot(vault, name, oauth, live.account.clone())?
        }
    };
    vault.write_slot(&slot)?;
    Ok(slot.dto(Some(&ident)))
}

/// `original` with `key` set to `value` (or removed), other keys and their
/// order kept. Pretty-printed when the original was (Claude Code writes
/// `.claude.json` with two-space indent), with its trailing newline kept.
/// `None` when there is nothing to write.
pub(crate) fn replace_key(
    original: Option<&[u8]>,
    key: &str,
    value: Option<Value>,
    pretty_when_new: bool,
) -> Result<Option<Vec<u8>>, AppError> {
    replace_keys(original, vec![(key, value)], pretty_when_new)
}

/// [`replace_key`] for several keys in one pass: each is set, or removed for
/// `None`. `None` when there is nothing to write.
pub(crate) fn replace_keys(
    original: Option<&[u8]>,
    edits: Vec<(&str, Option<Value>)>,
    pretty_when_new: bool,
) -> Result<Option<Vec<u8>>, AppError> {
    let (mut map, pretty, newline) = match original {
        Some(bytes) => {
            let text = std::str::from_utf8(bytes).map_err(|_| {
                AppError::Message("登录文件不是 UTF-8 文本，已停止切换".to_string())
            })?;
            let map = match serde_json::from_str::<Value>(strip_bom(text)) {
                Ok(Value::Object(map)) => map,
                _ => {
                    return Err(AppError::Message(
                        "登录文件格式无法识别，已停止切换，未做任何改动".to_string(),
                    ))
                }
            };
            (map, text.contains('\n'), text.ends_with('\n'))
        }
        None if edits.iter().all(|(_, value)| value.is_none()) => return Ok(None),
        None => (Map::new(), pretty_when_new, pretty_when_new),
    };
    for (key, value) in edits {
        match value {
            Some(value) => {
                map.insert(key.to_string(), value);
            }
            None => {
                map.shift_remove(key);
            }
        }
    }
    let value = Value::Object(map);
    let mut text = if pretty {
        serde_json::to_string_pretty(&value)
    } else {
        serde_json::to_string(&value)
    }
    .map_err(|e| AppError::JsonSerialize { source: e })?;
    if newline {
        text.push('\n');
    }
    Ok(Some(text.into_bytes()))
}

/// Atomic replace that gives up if the file changed since it was read.
fn write_checked(
    path: &Path,
    data: &[u8],
    private: bool,
    expected: Option<&[u8]>,
) -> Result<(), AppError> {
    crate::config::atomic_write_checked::<AppError, _>(path, data, private, || {
        if read_optional(path)?.as_deref() == expected {
            Ok(())
        } else {
            Err(AppError::Conflict(
                "Claude Code 刚刚改写了登录文件，已停止切换。请重试。".to_string(),
            ))
        }
    })
}

fn restore(path: &Path, original: Option<&[u8]>, private: bool) -> Result<(), AppError> {
    let result = match original {
        Some(bytes) => {
            crate::config::atomic_write_checked::<AppError, _>(path, bytes, private, || Ok(()))
        }
        None => fs::remove_file(path).or_else(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(AppError::io(path, error))
            }
        }),
    };
    if let Err(error) = &result {
        log::error!(
            "切换 Claude 账号失败后恢复登录文件也失败: {}: {error}",
            path.display()
        );
    }
    result
}

/// The `customApiKeyResponses` object with the last 20 characters of `key`
/// approved, the form Claude Code looks for (otherwise it asks again).
fn approved_responses(original: Option<&[u8]>, key: &str) -> Value {
    let approved = manage::approved_form(key);
    let mut responses = parse_object(original)
        .and_then(|map| {
            map.get(API_KEY_RESPONSES)
                .and_then(Value::as_object)
                .cloned()
        })
        .unwrap_or_default();
    let mut list = responses
        .get("approved")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !list.iter().any(|value| value.as_str() == Some(approved)) {
        list.push(Value::from(approved));
    }
    responses.insert("approved".to_string(), Value::Array(list));
    responses
        .entry("rejected")
        .or_insert_with(|| Value::Array(Vec::new()));
    Value::Object(responses)
}

/// Whether `slot` is what Claude Code is signed in with: the same login, or
/// the very tokens it holds (its `.claude.json` may name someone else).
/// Refreshing or copying the saved tokens then would rotate them out from
/// under Claude Code.
fn live_holds(live: &Live, slot: &Slot) -> bool {
    let live_refresh = live.oauth.as_ref().and_then(refresh_token_of);
    live_identity(live).is_some_and(|ident| same_login(&ident, &slot.identity()))
        || (live_refresh.is_some() && live_refresh == refresh_token_of(&slot.claude_ai_oauth))
}

/// The new contents of `.credentials.json` and `.claude.json`; `None` for a
/// file that needs no write.
type LiveFiles = (Option<Vec<u8>>, Option<Vec<u8>>);

/// The two live files as they must look once `target` is the login.
fn files_for(live: &Live, target: &Slot) -> Result<LiveFiles, AppError> {
    let oauth = match target.kind {
        // Never written to Claude Code: switch_in refuses it first.
        SlotKind::DesktopOnly => {
            return Err(AppError::Message(DESKTOP_ONLY_LOGIN.to_string()));
        }
        SlotKind::ApiKey => None,
        SlotKind::Oauth | SlotKind::SetupToken => Some(target.claude_ai_oauth.clone()),
    };
    let credentials = replace_key(live.credentials.as_deref(), CREDENTIALS_KEY, oauth, false)?;
    let mut edits: Vec<(&str, Option<Value>)> = Vec::new();
    match target.kind {
        SlotKind::Oauth => edits.push((ACCOUNT_KEY, target.oauth_account.clone())),
        SlotKind::SetupToken | SlotKind::DesktopOnly => edits.push((ACCOUNT_KEY, None)),
        SlotKind::ApiKey => {
            let key = target.api_key.as_deref().ok_or_else(|| {
                AppError::Message("已保存的 API Key 账号里没有密钥，无法切换".to_string())
            })?;
            edits.push((ACCOUNT_KEY, None));
            edits.push((API_KEY_FIELD, Some(Value::from(key))));
            edits.push((
                API_KEY_RESPONSES,
                Some(approved_responses(live.claude_json.as_deref(), key)),
            ));
        }
    }
    // A login that was only an API key leaves with its key; a subscription
    // login that also has one keeps it.
    if target.kind != SlotKind::ApiKey && live.oauth.is_none() && live.api_key.is_some() {
        edits.push((API_KEY_FIELD, None));
    }
    let claude_json = replace_keys(live.claude_json.as_deref(), edits, true)?;
    Ok((credentials, claude_json))
}

/// Keeps an API key that is about to be replaced; `Some(id)` when it was not
/// saved yet and is now.
fn save_outgoing_api_key(vault: &CodeVault, key: &str) -> Result<Option<String>, AppError> {
    let ident = Identity {
        fingerprint: Some(secret_fingerprint(key)),
        ..Identity::default()
    };
    if find_matching(vault, &ident).is_some() {
        return Ok(None);
    }
    let slot = manage::new_secret_slot(
        vault,
        manage::API_KEY_NAME.to_string(),
        manage::Secret::ApiKey(key.to_string()),
    )?;
    vault.write_slot(&slot)?;
    Ok(Some(slot.id))
}

/// Saves the setup-token Claude Code is using as an account.
fn save_live_setup_token(
    vault: &CodeVault,
    oauth: &Value,
    name: Option<String>,
) -> Result<CodeAccountDto, AppError> {
    let token = oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let ident = Identity {
        fingerprint: token_fingerprint(Some(oauth)),
        ..Identity::default()
    };
    if let Some(slot) = find_matching(vault, &ident) {
        return Ok(slot.dto(Some(&ident)));
    }
    let slot = manage::new_secret_slot(
        vault,
        name.unwrap_or_else(|| manage::SETUP_TOKEN_NAME.to_string()),
        manage::Secret::SetupToken(token.to_string()),
    )?;
    vault.write_slot(&slot)?;
    Ok(slot.dto(Some(&ident)))
}

/// Saves the API key Claude Code is using as an account.
fn save_api_key(
    vault: &CodeVault,
    key: &str,
    name: Option<String>,
) -> Result<CodeAccountDto, AppError> {
    let ident = Identity {
        fingerprint: Some(secret_fingerprint(key)),
        ..Identity::default()
    };
    if let Some(slot) = find_matching(vault, &ident) {
        return Ok(slot.dto(Some(&ident)));
    }
    let slot = manage::new_secret_slot(
        vault,
        name.unwrap_or_else(|| manage::API_KEY_NAME.to_string()),
        manage::Secret::ApiKey(key.to_string()),
    )?;
    vault.write_slot(&slot)?;
    Ok(slot.dto(Some(&ident)))
}

pub(crate) fn switch_in(
    vault: &CodeVault,
    paths: &LivePaths,
    id: &str,
    allow_running: bool,
    claude_running: impl FnOnce() -> bool,
) -> Result<SwitchOutcome, AppError> {
    ensure_supported()?;
    let _guard = CODE_LOCK.lock()?;
    if sessions::is_running(vault, id) {
        return Err(sessions::running_error());
    }
    sessions::harvest_locked(vault, id)?;
    let mut target = vault.read_slot(id)?;
    let live = read_live(paths)?;
    let target_ident = target.identity();
    if target.disabled {
        return Err(manage::disabled_error(&target));
    }
    if target.kind == SlotKind::DesktopOnly {
        return Err(AppError::Message(DESKTOP_ONLY_LOGIN.to_string()));
    }

    if let Some(ident) = live_identity(&live) {
        // Not when `.claude.json` names this login but the tokens are another
        // saved login's: then they are written over, below.
        let tokens_are_its_own = !live
            .oauth
            .as_ref()
            .is_some_and(|oauth| tokens_owned_elsewhere(vault, oauth, &ident));
        if same_login(&ident, &target_ident) && tokens_are_its_own {
            // Take the newest tokens Claude Code holds for this login.
            if let (Some(oauth), SlotKind::Oauth) = (&live.oauth, target.kind) {
                target.absorb(oauth.clone(), live.account.clone());
                vault.write_slot(&target)?;
            }
            return Ok(SwitchOutcome {
                status: SwitchStatus::AlreadyCurrent,
                auto_saved_id: None,
            });
        }
    }
    if target.kind == SlotKind::Oauth && target.needs_relogin {
        return Err(AppError::Message(
            "这个账号的登录已失效。请在 Claude Code 中重新登录该账号，然后保存当前登录。"
                .to_string(),
        ));
    }
    if !allow_running && claude_running() {
        return Ok(SwitchOutcome {
            status: SwitchStatus::ClaudeRunning,
            auto_saved_id: None,
        });
    }

    // Both new files are prepared first: a file that cannot be parsed stops
    // the switch before anything is written.
    let (new_credentials, new_claude_json) = files_for(&live, &target)?;
    // Keep the outgoing login with its newest tokens (Claude Code refreshes
    // them, so a saved copy goes stale); save it if it never was.
    // Live tokens that are a copy of another saved login are skipped: that
    // login already holds them, and saving them under the account the live
    // `.claude.json` names would overwrite its real tokens.
    let mut auto_saved_id = None;
    let outgoing_live = match (&live.oauth, live_identity(&live)) {
        (Some(oauth), Some(ident)) if !tokens_owned_elsewhere(vault, oauth, &ident) => {
            Some((oauth, ident))
        }
        _ => None,
    };
    if let Some((oauth, ident)) = outgoing_live {
        if is_setup_token_oauth(oauth) {
            if find_matching(vault, &ident).is_none() {
                let token = oauth
                    .get("accessToken")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let slot = manage::new_secret_slot(
                    vault,
                    manage::SETUP_TOKEN_NAME.to_string(),
                    manage::Secret::SetupToken(token.to_string()),
                )?;
                vault.write_slot(&slot)?;
                auto_saved_id = Some(slot.id);
            }
        } else {
            let outgoing = match find_matching(vault, &ident) {
                Some(mut slot) => {
                    slot.absorb(oauth.clone(), live.account.clone());
                    slot
                }
                None => {
                    let name =
                        fitted_name(ident.email.as_deref().unwrap_or_default(), DEFAULT_NAME);
                    let slot = new_slot(vault, name, oauth.clone(), live.account.clone())?;
                    auto_saved_id = Some(slot.id.clone());
                    slot
                }
            };
            vault.write_slot(&outgoing)?;
        }
    }
    // A key that is the login is kept; so is one beside a subscription login
    // when an API key account is about to replace it.
    let outgoing_key = live
        .api_key
        .as_ref()
        .or(if target.kind == SlotKind::ApiKey {
            live.primary_key.as_ref()
        } else {
            None
        });
    if let Some(key) = outgoing_key {
        if let Some(saved) = save_outgoing_api_key(vault, key)? {
            auto_saved_id = auto_saved_id.or(Some(saved));
        }
    }

    vault.backup(&[
        ("credentials.json", live.credentials.as_deref()),
        ("claude.json", live.claude_json.as_deref()),
    ])?;

    if let Some(data) = &new_credentials {
        write_checked(&paths.credentials, data, true, live.credentials.as_deref())?;
    }
    if let Some(data) = &new_claude_json {
        if let Err(error) =
            write_checked(&paths.claude_json, data, false, live.claude_json.as_deref())
        {
            if restore(&paths.credentials, live.credentials.as_deref(), true).is_err() {
                // The tokens are the new account's but `.claude.json` still
                // names the old one; the user has to log in again to fix it.
                return Err(AppError::Message(format!(
                    "切换失败，且未能恢复原来的登录（{error}）。上一次登录已加密备份；请在 Claude Code 中用 /login 重新登录。"
                )));
            }
            return Err(error);
        }
    }
    Ok(SwitchOutcome {
        status: SwitchStatus::Switched,
        auto_saved_id,
    })
}

const MAX_NOTE_CHARS: usize = 200;

/// Sets or clears (empty text) a saved login's note.
pub(crate) fn set_note_in(vault: &CodeVault, id: &str, note: &str) -> Result<(), AppError> {
    let note = note.trim();
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err(AppError::InvalidInput(format!(
            "备注最多 {MAX_NOTE_CHARS} 个字"
        )));
    }
    if note.chars().any(|c| c.is_control() && c != '\n') {
        return Err(AppError::InvalidInput("备注里有不能使用的字符".to_string()));
    }
    let _guard = CODE_LOCK.lock()?;
    let mut slot = vault.read_slot(id)?;
    slot.note = (!note.is_empty()).then(|| note.to_string());
    slot.updated_at = now_rfc3339();
    vault.write_slot(&slot)
}

pub(crate) fn rename_in(vault: &CodeVault, id: &str, name: &str) -> Result<(), AppError> {
    let name = normalize_account_name(name)?;
    let _guard = CODE_LOCK.lock()?;
    let mut slot = vault.read_slot(id)?;
    slot.name = name;
    slot.updated_at = now_rfc3339();
    vault.write_slot(&slot)
}

/// Removes only the saved login; the live Claude Code login is untouched.
pub(crate) fn delete_in(vault: &CodeVault, id: &str) -> Result<(), AppError> {
    let _guard = CODE_LOCK.lock()?;
    // Its session folder holds a copy of the tokens, so it goes with it.
    sessions::remove_profile_locked(vault, id)?;
    vault.remove_slot(id)
}

// ===== used by quota =====

impl CodeVault {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
}

/// The Anthropic account id of a subscription login, for matching it with
/// the account Claude Desktop is signed in as.
/// The ids of every saved login file, readable or not.
pub(crate) fn all_account_ids(vault: &CodeVault) -> Vec<String> {
    vault.slot_ids()
}

pub(crate) fn account_uuid_of(vault: &CodeVault, id: &str) -> Result<Option<String>, AppError> {
    let slot = vault.read_slot(id)?;
    if !matches!(slot.kind, SlotKind::Oauth | SlotKind::DesktopOnly) {
        return Err(AppError::Message(
            "只有订阅登录的账号才有 Claude Desktop 登录".to_string(),
        ));
    }
    Ok(slot.identity().account_uuid)
}

/// The subscription login with this Anthropic account id.
pub(crate) fn find_by_account_uuid(vault: &CodeVault, uuid: &str) -> Option<String> {
    vault
        .readable_slots()
        .into_iter()
        .find(|slot| {
            matches!(slot.kind, SlotKind::Oauth | SlotKind::DesktopOnly)
                && slot
                    .identity()
                    .account_uuid
                    .as_deref()
                    .is_some_and(|have| have.eq_ignore_ascii_case(uuid))
        })
        .map(|slot| slot.id)
}

pub(crate) fn is_disabled(vault: &CodeVault, id: &str) -> Result<bool, AppError> {
    Ok(vault.read_slot(id)?.disabled)
}

/// The id and name of every saved login that can be read.
pub(crate) fn saved_names(vault: &CodeVault) -> Vec<(String, String)> {
    vault
        .readable_slots()
        .into_iter()
        .map(|slot| (slot.id, slot.name))
        .collect()
}

/// Which credentials a quota query may use.
pub(crate) enum QuotaSource {
    /// The account Claude Code uses now: only the live credentials may be
    /// used, never refreshed from the vault copy (that would rotate the
    /// refresh token under Claude Code and log it out).
    Live,
    Saved(Box<Slot>),
    /// A token or key (no quota to read), or a login held out of use.
    Unsupported,
    /// A terminal is open on this login's session folder: that copy of the
    /// tokens is the live one and is never refreshed from here.
    Session(Value),
}

pub(crate) fn quota_source(
    vault: &CodeVault,
    paths: &LivePaths,
    id: &str,
) -> Result<QuotaSource, AppError> {
    let slot = vault.read_slot(id)?;
    if slot.kind != SlotKind::Oauth || slot.disabled {
        return Ok(QuotaSource::Unsupported);
    }
    if sessions::is_running(vault, id) {
        return Ok(match sessions::profile_oauth(vault, id) {
            Some(oauth) => QuotaSource::Session(oauth),
            None => QuotaSource::Unsupported,
        });
    }
    // Tokens a closed session left behind are newer than the saved ones.
    let slot = {
        let _guard = CODE_LOCK.lock()?;
        sessions::harvest_locked(vault, id)?;
        vault.read_slot(id)?
    };
    let live = read_live(paths).ok();
    // Same login by identity, or the very tokens Claude Code holds now (the
    // live `.claude.json` may name someone else): either way refreshing the
    // saved copy would rotate the refresh token out from under Claude Code.
    let is_live = live.as_ref().is_some_and(|live| live_holds(live, &slot));
    Ok(if is_live {
        QuotaSource::Live
    } else {
        QuotaSource::Saved(Box::new(slot))
    })
}

/// Writes refreshed tokens into the saved login right away (the refresh
/// token rotates, so the old one is already dead).
pub(crate) fn store_refreshed(
    vault: &CodeVault,
    id: &str,
    access_token: &str,
    refresh_token: Option<&str>,
    expires_at_ms: i64,
    scopes: Option<Vec<String>>,
) -> Result<(), AppError> {
    let _guard = CODE_LOCK.lock()?;
    let mut slot = vault.read_slot(id)?;
    let Some(oauth) = slot.claude_ai_oauth.as_object_mut() else {
        return Err(AppError::Message("已保存的登录格式无效".to_string()));
    };
    oauth.insert("accessToken".to_string(), Value::from(access_token));
    oauth.insert("expiresAt".to_string(), Value::from(expires_at_ms));
    if let Some(refresh_token) = refresh_token {
        oauth.insert("refreshToken".to_string(), Value::from(refresh_token));
    }
    if let Some(scopes) = scopes {
        oauth.insert("scopes".to_string(), Value::from(scopes));
    }
    slot.needs_relogin = false;
    slot.updated_at = now_rfc3339();
    vault.write_slot(&slot)
}

pub(crate) fn mark_needs_relogin(vault: &CodeVault, id: &str) -> Result<(), AppError> {
    let _guard = CODE_LOCK.lock()?;
    let mut slot = vault.read_slot(id)?;
    slot.needs_relogin = true;
    vault.write_slot(&slot)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    pub(crate) struct Fixture {
        _temp: tempfile::TempDir,
        pub vault: CodeVault,
        pub paths: LivePaths,
    }

    pub(crate) fn fixture() -> Fixture {
        let temp = tempdir().unwrap();
        let vault = CodeVault::open_at(temp.path().join("claude-vault")).unwrap();
        let paths = LivePaths {
            credentials: temp.path().join(".claude").join(".credentials.json"),
            claude_json: temp.path().join(".claude.json"),
        };
        fs::create_dir_all(paths.credentials.parent().unwrap()).unwrap();
        Fixture {
            _temp: temp,
            vault,
            paths,
        }
    }

    pub(crate) fn login(paths: &LivePaths, email: &str, uuid: &str, token: &str) {
        fs::write(
            &paths.credentials,
            json!({
                "claudeAiOauth": {
                    "accessToken": token,
                    "refreshToken": format!("r-{token}"),
                    "expiresAt": 4_102_444_800_000_i64,
                    "subscriptionType": "pro"
                },
                "otherTool": {"keep": true}
            })
            .to_string(),
        )
        .unwrap();
        let mut claude = json!({
            "numStartups": 7,
            "projects": {"D:/work": {"history": ["hello"]}},
            "oauthAccount": {
                "accountUuid": uuid,
                "emailAddress": email,
                "organizationType": "claude_max"
            },
            "zLast": 1
        });
        if let Ok(text) = fs::read_to_string(&paths.claude_json) {
            if let Ok(old) = serde_json::from_str::<Value>(&text) {
                claude["projects"] = old["projects"].clone();
            }
        }
        fs::write(
            &paths.claude_json,
            serde_json::to_string_pretty(&claude).unwrap() + "\n",
        )
        .unwrap();
    }

    fn live_token(paths: &LivePaths) -> String {
        let value: Value =
            serde_json::from_str(&fs::read_to_string(&paths.credentials).unwrap()).unwrap();
        value["claudeAiOauth"]["accessToken"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn desktop_only_login_is_saved_once_refused_for_code_and_upgraded_by_its_code_login() {
        let f = fixture();
        let saved = save_desktop_only_in(&f.vault, "uuid-d", Some("d@example.com")).unwrap();
        assert_eq!(saved.kind, SlotKind::DesktopOnly);
        assert_eq!(saved.email.as_deref(), Some("d@example.com"));
        // The same account again is the same saved login.
        let again = save_desktop_only_in(&f.vault, "UUID-D", None).unwrap();
        assert_eq!(again.id, saved.id);
        assert_eq!(
            find_by_account_uuid(&f.vault, "uuid-d"),
            Some(saved.id.clone())
        );

        // Claude Code signed in to that account: the Desktop-only login is
        // not its login, and cannot be switched to.
        login(&f.paths, "d@example.com", "uuid-d", "tok-d");
        let list = list_in(&f.vault, &f.paths);
        assert_eq!(list.live.saved_id, None);
        assert!(list.accounts.iter().all(|account| !account.is_current));
        if switching_supported() {
            let refused = switch_in(&f.vault, &f.paths, &saved.id, true, || false);
            assert!(refused.is_err());

            // Saving Claude Code's login of it makes it a subscription login.
            let upgraded = save_current_in(&f.vault, &f.paths, None).unwrap();
            assert_eq!(upgraded.id, saved.id);
            assert_eq!(upgraded.kind, SlotKind::Oauth);
            assert!(upgraded.is_current);
        }
    }

    #[test]
    fn identity_matches_by_uuid_then_email_then_fingerprint() {
        let a = Identity {
            account_uuid: Some("u1".into()),
            email: Some("A@x.com".into()),
            ..Default::default()
        };
        let b = Identity {
            account_uuid: Some("u2".into()),
            email: Some("a@x.com".into()),
            ..Default::default()
        };
        assert!(!same_login(&a, &b), "uuid wins over email");
        let c = Identity {
            email: Some("a@x.com".into()),
            ..Default::default()
        };
        assert!(same_login(&a, &c));
        let f1 = Identity {
            fingerprint: Some("abcd1234".into()),
            ..Default::default()
        };
        assert!(same_login(&f1, &f1.clone()));
        assert!(!same_login(&f1, &Identity::default()));
        let org = |org: &str| Identity {
            account_uuid: Some("u1".into()),
            organization_uuid: Some(org.into()),
            ..Default::default()
        };
        assert!(!same_login(&org("o1"), &org("o2")));
    }

    #[test]
    fn fingerprint_is_eight_hex_digits_and_never_the_token() {
        let print = token_fingerprint(Some(&json!({"accessToken": "sk-ant-oat-secret"}))).unwrap();
        assert_eq!(print.len(), 8);
        assert!(print.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert!(!"sk-ant-oat-secret".contains(&print));
        assert_eq!(token_fingerprint(Some(&json!({"accessToken": ""}))), None);
        assert_eq!(token_fingerprint(None), None);
    }

    #[test]
    fn replace_key_keeps_other_fields_order_and_format() {
        let original = b"{\n  \"b\": 1,\n  \"oauthAccount\": {\"x\": 1},\n  \"a\": [1, 2]\n}\n";
        let out = replace_key(Some(original), "oauthAccount", Some(json!({"y": 2})), false)
            .unwrap()
            .unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(
            text,
            "{\n  \"b\": 1,\n  \"oauthAccount\": {\n    \"y\": 2\n  },\n  \"a\": [\n    1,\n    2\n  ]\n}\n"
        );
        let compact = replace_key(
            Some(b"{\"claudeAiOauth\":{},\"z\":0}"),
            "claudeAiOauth",
            Some(json!({"t": 1})),
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(compact, b"{\"claudeAiOauth\":{\"t\":1},\"z\":0}");
        let removed = replace_key(
            Some(b"{\"a\":1,\"oauthAccount\":{},\"b\":2}"),
            "oauthAccount",
            None,
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(removed, b"{\"a\":1,\"b\":2}");
        assert_eq!(replace_key(None, "k", None, true).unwrap(), None);
        assert!(replace_key(Some(b"[1]"), "k", Some(json!(1)), true).is_err());
        assert!(replace_key(Some(b"{broken"), "k", Some(json!(1)), true).is_err());
        // A BOM is dropped, the content kept.
        let bom = replace_key(
            Some("\u{feff}{\"a\":1}".as_bytes()),
            "k",
            Some(json!(2)),
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(bom, b"{\"a\":1,\"k\":2}");
    }

    #[test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    fn save_current_then_switch_keeps_sessions_and_both_logins() {
        let fx = fixture();
        assert!(
            save_current_in(&fx.vault, &fx.paths, None).is_err(),
            "nothing to save"
        );

        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = save_current_in(&fx.vault, &fx.paths, Some("工作")).unwrap();
        assert!(work.is_current);
        assert_eq!(work.plan.as_deref(), Some("Max"));
        assert_eq!(work.email.as_deref(), Some("work@example.com"));

        // `claude /login` as another account, then save it too.
        login(&fx.paths, "me@example.com", "u-me", "tok-me");
        let me = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        assert_eq!(me.name, "me@example.com");
        let listed = list_in(&fx.vault, &fx.paths);
        assert_eq!(listed.accounts.len(), 2);
        assert_eq!(listed.live.saved_id.as_deref(), Some(me.id.as_str()));

        let outcome = switch_in(&fx.vault, &fx.paths, &work.id, false, || false).unwrap();
        assert_eq!(outcome.status, SwitchStatus::Switched);
        assert_eq!(outcome.auto_saved_id, None);
        assert_eq!(live_token(&fx.paths), "tok-work");

        let creds: Value =
            serde_json::from_str(&fs::read_to_string(&fx.paths.credentials).unwrap()).unwrap();
        assert_eq!(creds["otherTool"], json!({"keep": true}));
        let claude_text = fs::read_to_string(&fx.paths.claude_json).unwrap();
        let claude: Value = serde_json::from_str(&claude_text).unwrap();
        assert_eq!(claude["oauthAccount"]["emailAddress"], "work@example.com");
        assert_eq!(claude["projects"]["D:/work"]["history"][0], "hello");
        assert_eq!(claude["numStartups"], 7);
        assert!(claude_text.ends_with("}\n") && claude_text.contains("\n  \"zLast\""));

        let listed = list_in(&fx.vault, &fx.paths);
        assert_eq!(listed.live.saved_id.as_deref(), Some(work.id.as_str()));
        let again = switch_in(&fx.vault, &fx.paths, &work.id, false, || true).unwrap();
        assert_eq!(again.status, SwitchStatus::AlreadyCurrent);
        assert!(
            fs::read_dir(fx.vault.root.join(BACKUPS_DIR))
                .unwrap()
                .count()
                >= 1
        );
    }

    #[test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    fn switching_recaptures_the_outgoing_login_first() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work-1");
        let work = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        login(&fx.paths, "me@example.com", "u-me", "tok-me");
        let me = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        switch_in(&fx.vault, &fx.paths, &work.id, false, || false).unwrap();
        // Claude Code refreshed the work token after the switch.
        login(&fx.paths, "work@example.com", "u-work", "tok-work-2");
        switch_in(&fx.vault, &fx.paths, &me.id, false, || false).unwrap();
        assert_eq!(
            fx.vault.read_slot(&work.id).unwrap().oauth()["accessToken"],
            "tok-work-2"
        );
    }

    #[test]
    #[cfg_attr(target_os = "macos", ignore = "the vault saves no login on macOS")]
    fn a_note_is_kept_trimmed_cleared_when_empty_and_bounded() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        set_note_in(&fx.vault, &work.id, "  团队账号\n别外借 ").unwrap();
        let listed = list_in(&fx.vault, &fx.paths);
        assert_eq!(listed.accounts[0].note.as_deref(), Some("团队账号\n别外借"));
        set_note_in(&fx.vault, &work.id, "   ").unwrap();
        assert!(list_in(&fx.vault, &fx.paths).accounts[0].note.is_none());
        assert!(set_note_in(&fx.vault, &work.id, &"字".repeat(201)).is_err());
        assert!(set_note_in(&fx.vault, &work.id, "a\u{7}b").is_err());
    }

    #[test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    fn tokens_of_another_saved_login_are_never_saved_under_the_named_account() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        // Saving the same login again under a new name keeps its name.
        let again = save_current_in(&fx.vault, &fx.paths, Some("别名")).unwrap();
        assert_eq!(
            (again.id.as_str(), again.name.as_str()),
            (work.id.as_str(), work.name.as_str())
        );
        login(&fx.paths, "me@example.com", "u-me", "tok-me");
        let me = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        // Half-switched: `.claude.json` names work, the tokens are me's.
        login(&fx.paths, "work@example.com", "u-work", "tok-me");

        assert!(save_current_in(&fx.vault, &fx.paths, None).is_err());
        // me's tokens are the live ones: never refreshed from the vault.
        assert!(matches!(
            quota_source(&fx.vault, &fx.paths, &me.id).unwrap(),
            QuotaSource::Live
        ));
        switch_in(&fx.vault, &fx.paths, &me.id, false, || false).unwrap();
        assert_eq!(
            fx.vault.read_slot(&work.id).unwrap().oauth()["accessToken"],
            "tok-work"
        );
    }

    #[test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    fn switching_to_the_login_a_half_switched_state_names_writes_its_own_tokens() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        login(&fx.paths, "me@example.com", "u-me", "tok-me");
        let me = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        // Half-switched: `.claude.json` names work, the tokens are me's.
        login(&fx.paths, "work@example.com", "u-work", "tok-me");

        let outcome = switch_in(&fx.vault, &fx.paths, &work.id, false, || false).unwrap();
        assert_eq!(outcome.status, SwitchStatus::Switched);
        // Work got its own tokens back; me's were not put under work.
        let live = read_live(&fx.paths).unwrap();
        assert_eq!(live.oauth.unwrap()["accessToken"], "tok-work");
        assert_eq!(
            fx.vault.read_slot(&me.id).unwrap().oauth()["accessToken"],
            "tok-me"
        );
        assert_eq!(
            fx.vault.read_slot(&work.id).unwrap().oauth()["accessToken"],
            "tok-work"
        );
    }

    #[test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    fn an_unsaved_outgoing_login_is_saved_automatically() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        login(&fx.paths, "new@example.com", "u-new", "tok-new");
        let outcome = switch_in(&fx.vault, &fx.paths, &work.id, false, || false).unwrap();
        let saved = outcome.auto_saved_id.expect("outgoing login saved");
        assert_eq!(
            fx.vault.read_slot(&saved).unwrap().oauth()["accessToken"],
            "tok-new"
        );
    }

    #[test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    fn a_running_claude_blocks_the_switch_unless_allowed() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        login(&fx.paths, "me@example.com", "u-me", "tok-me");
        let before = fs::read(&fx.paths.credentials).unwrap();
        let blocked = switch_in(&fx.vault, &fx.paths, &work.id, false, || true).unwrap();
        assert_eq!(blocked.status, SwitchStatus::ClaudeRunning);
        assert_eq!(fs::read(&fx.paths.credentials).unwrap(), before);
        let forced = switch_in(&fx.vault, &fx.paths, &work.id, true, || true).unwrap();
        assert_eq!(forced.status, SwitchStatus::Switched);
    }

    #[test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    fn a_damaged_live_file_stops_the_switch_without_changes() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        login(&fx.paths, "me@example.com", "u-me", "tok-me");
        fs::write(&fx.paths.claude_json, "{ broken").unwrap();
        let before = fs::read(&fx.paths.credentials).unwrap();
        assert!(switch_in(&fx.vault, &fx.paths, &work.id, false, || false).is_err());
        assert_eq!(fs::read(&fx.paths.credentials).unwrap(), before);
        assert_eq!(fx.vault.slot_ids().len(), 1, "nothing auto-saved");
        assert_eq!(
            fs::read_to_string(&fx.paths.claude_json).unwrap(),
            "{ broken"
        );
    }

    #[test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    fn rename_delete_and_relogin_flags() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        rename_in(&fx.vault, &work.id, "主力").unwrap();
        assert_eq!(fx.vault.read_slot(&work.id).unwrap().name, "主力");
        mark_needs_relogin(&fx.vault, &work.id).unwrap();
        assert!(list_in(&fx.vault, &fx.paths).accounts[0].needs_relogin);
        store_refreshed(&fx.vault, &work.id, "tok-new", Some("r-new"), 5, None).unwrap();
        let slot = fx.vault.read_slot(&work.id).unwrap();
        assert!(!slot.needs_relogin());
        assert_eq!(slot.oauth()["refreshToken"], "r-new");
        assert_eq!(slot.oauth()["expiresAt"], 5);
        assert_eq!(slot.oauth()["subscriptionType"], "pro", "other fields kept");
        delete_in(&fx.vault, &work.id).unwrap();
        assert!(list_in(&fx.vault, &fx.paths).accounts.is_empty());
        // The live login is untouched by deleting the saved one.
        assert_eq!(live_token(&fx.paths), "tok-work");
        assert!(delete_in(&fx.vault, &work.id).is_err());
        assert!(delete_in(&fx.vault, "../x").is_err());
    }

    #[test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    fn the_active_account_is_a_live_quota_source() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = save_current_in(&fx.vault, &fx.paths, None).unwrap();
        assert!(matches!(
            quota_source(&fx.vault, &fx.paths, &work.id).unwrap(),
            QuotaSource::Live
        ));
        login(&fx.paths, "me@example.com", "u-me", "tok-me");
        assert!(matches!(
            quota_source(&fx.vault, &fx.paths, &work.id).unwrap(),
            QuotaSource::Saved(_)
        ));
    }

    #[test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    fn listing_never_returns_tokens() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work-secret");
        save_current_in(&fx.vault, &fx.paths, None).unwrap();
        let text = serde_json::to_string(&list_in(&fx.vault, &fx.paths)).unwrap();
        assert!(!text.contains("tok-work-secret") && !text.contains("r-tok"));
    }

    #[test]
    fn an_unreadable_slot_is_listed_for_deletion_only() {
        let fx = fixture();
        fs::write(
            fx.vault.root.join(SLOTS_DIR).join("broken.json"),
            b"garbage",
        )
        .unwrap();
        let listed = list_in(&fx.vault, &fx.paths);
        assert_eq!(listed.accounts.len(), 1);
        assert!(listed.accounts[0].unreadable);
        delete_in(&fx.vault, "broken").unwrap();
    }
}
