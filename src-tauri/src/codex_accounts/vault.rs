//! The official-account credential vault: exactly one `auth.json` per ChatGPT
//! identity, outside the database.
//!
//! The location is fixed per platform and never follows the (relocatable)
//! app data directory: `%LOCALAPPDATA%\Chimera++\vault` on Windows,
//! `~/Library/Application Support/Chimera++/vault` on macOS and
//! `$XDG_DATA_HOME/Chimera++/vault` elsewhere. A vault root that is a
//! symlink or junction is refused, so it cannot be relocated by a link
//! either.
//!
//! Protection: directories 0700 and files 0600 on Unix; on Windows the root
//! gets a protected DACL (current user + SYSTEM, inheritance from the parent
//! disabled) and every file is encrypted with DPAPI for the current user.
//! Nothing here is backed up, exported or logged: rotated refresh tokens are
//! single-use, so a copy would be useless or harmful.
//!
//! Layout: `accounts/<key>.json` (trusted slots, updated only from Codex's
//! own live `auth.json` or our CLI capture), `pending/<key>.json` (imported
//! material waiting for the user's confirmation), `tombstones/<key>` (live
//! login disappeared: the account needs to sign in again) and private
//! `.login-*` homes for `codex login --device-auth`.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::identity::{
    classify, is_at_least_as_fresh, last_refresh_is_in_future, AccountIdentity, LoginClass,
};
use crate::config::cas::{Changeset, FileSnapshot};
use crate::error::AppError;

const ACCOUNTS_DIR: &str = "accounts";
const PENDING_DIR: &str = "pending";
const TOMBSTONES_DIR: &str = "tombstones";
const LOGIN_HOME_PREFIX: &str = ".login-";
const SLOT_VERSION: u32 = 1;

/// Where a stored login came from. Only `Live` (Codex's own `auth.json`)
/// and `Cli` (our `codex login --device-auth` capture) may create or update
/// a slot; `Migration` and `Import` material only becomes a candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SlotSource {
    Live,
    Cli,
    Migration,
    Import,
}

impl SlotSource {
    fn may_update_slot(self) -> bool {
        matches!(self, SlotSource::Live | SlotSource::Cli)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultSlot {
    version: u32,
    pub account_key: String,
    chatgpt_user_id: String,
    chatgpt_account_id: String,
    pub captured_at: String,
    pub source: SlotSource,
    /// The verbatim `auth.json` object.
    pub auth: Value,
}

impl VaultSlot {
    fn new(identity: &AccountIdentity, auth: &Value, source: SlotSource) -> Self {
        Self {
            version: SLOT_VERSION,
            account_key: identity.key(),
            chatgpt_user_id: identity.user_id.clone(),
            chatgpt_account_id: identity.account_id.clone(),
            captured_at: Utc::now().to_rfc3339(),
            source,
            auth: auth.clone(),
        }
    }

    pub fn account_id(&self) -> &str {
        &self.chatgpt_account_id
    }
}

impl fmt::Debug for VaultSlot {
    // Never print the login itself.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultSlot")
            .field("account_key", &self.account_key)
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

/// Outcome of offering a login to a slot or candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StoreOutcome {
    Stored,
    /// The stored copy is fresher; nothing was written.
    KeptExisting,
}

pub(crate) fn needs_login_error() -> AppError {
    AppError::localized(
        "official_accounts.needs_login",
        "此账号需要重新登录",
        "This account needs to sign in again",
    )
}

/// Account keys arrive over IPC; they name files, so accept exactly the
/// 64-hex-digit form `AccountIdentity::key` produces.
pub(crate) fn validate_account_key(key: &str) -> Result<(), AppError> {
    if key.len() == 64
        && key
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(AppError::InvalidInput("无效的账号标识".to_string()))
    }
}

fn local_data_base() -> PathBuf {
    let home = crate::config::get_home_dir;
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home().join("AppData").join("Local"))
    }
    #[cfg(target_os = "macos")]
    {
        home().join("Library").join("Application Support")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home().join(".local").join("share"))
    }
}

/// The fixed vault location (see the module docs). Deliberately not derived
/// from `get_app_config_dir()`, which the user can relocate.
pub(crate) fn default_vault_root() -> PathBuf {
    local_data_base()
        .join(crate::product_policy::PRODUCT_NAME)
        .join("vault")
}

fn relocation_refused(path: &Path) -> AppError {
    AppError::localized(
        "official_accounts.vault_relocated",
        format!(
            "账号保险库路径不能是链接或其它位置的映射：{}",
            path.display()
        ),
        format!(
            "The account vault must not be a link to another location: {}",
            path.display()
        ),
    )
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
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(relocation_refused(path));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(relocation_refused(path));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|e| AppError::io(path, e))?;
    }
    Ok(())
}

#[cfg(windows)]
const SEALED_MAGIC: &[u8] = b"CPPVAULT1\n";

fn seal(plain: Vec<u8>) -> Result<Vec<u8>, AppError> {
    #[cfg(windows)]
    {
        let blob = win::protect(&plain).map_err(|e| AppError::IoContext {
            context: "无法加密账号保险库条目".to_string(),
            source: e,
        })?;
        let mut sealed = SEALED_MAGIC.to_vec();
        sealed.extend_from_slice(&blob);
        Ok(sealed)
    }
    #[cfg(not(windows))]
    {
        Ok(plain)
    }
}

fn unseal(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    #[cfg(windows)]
    {
        let blob = bytes
            .strip_prefix(SEALED_MAGIC)
            .ok_or_else(|| AppError::Config("账号保险库条目格式无效".to_string()))?;
        win::unprotect(blob).map_err(|e| AppError::IoContext {
            context: "无法解密账号保险库条目".to_string(),
            source: e,
        })
    }
    #[cfg(not(windows))]
    {
        Ok(bytes.to_vec())
    }
}

fn remove_if_present(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Ok(());
    }
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

pub(crate) struct Vault {
    root: PathBuf,
}

impl Vault {
    pub fn open_default() -> Result<Self, AppError> {
        Self::open_at(default_vault_root())
    }

    pub fn open_at(root: PathBuf) -> Result<Self, AppError> {
        ensure_private_dir(&root)?;
        #[cfg(windows)]
        win::restrict_to_current_user(&root).map_err(|e| AppError::IoContext {
            context: format!("无法设置账号保险库权限: {}", root.display()),
            source: e,
        })?;
        for sub in [ACCOUNTS_DIR, PENDING_DIR, TOMBSTONES_DIR] {
            ensure_private_dir(&root.join(sub))?;
        }
        let vault = Self { root };
        for stale in vault.stale_login_homes() {
            secure_remove_dir(&stale);
        }
        Ok(vault)
    }

    #[cfg(test)]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn slot_path(&self, key: &str) -> PathBuf {
        self.root.join(ACCOUNTS_DIR).join(format!("{key}.json"))
    }

    fn candidate_path(&self, key: &str) -> PathBuf {
        self.root.join(PENDING_DIR).join(format!("{key}.json"))
    }

    fn tombstone_path(&self, key: &str) -> PathBuf {
        self.root.join(TOMBSTONES_DIR).join(key)
    }

    fn read_entry(path: &Path) -> Result<(Option<VaultSlot>, FileSnapshot), AppError> {
        let snapshot = FileSnapshot::read(path)?;
        let slot = match snapshot.contents() {
            None => None,
            Some(bytes) => {
                let plain = unseal(bytes)?;
                let slot: VaultSlot = serde_json::from_slice(&plain)
                    .map_err(|_| AppError::Config("账号保险库条目格式无效".to_string()))?;
                Some(slot)
            }
        };
        Ok((slot, snapshot))
    }

    fn write_entry(snapshot: FileSnapshot, slot: &VaultSlot) -> Result<(), AppError> {
        let plain =
            serde_json::to_vec(slot).map_err(|source| AppError::JsonSerialize { source })?;
        let mut changeset = Changeset::new();
        changeset.write_private(snapshot, seal(plain)?)?;
        changeset.commit()?;
        Ok(())
    }

    /// Offers `auth` (already classified as `identity`) to `path`: written
    /// unless the stored copy of the same identity is fresher. Compare and
    /// write are CAS against the bytes read.
    fn offer(
        path: &Path,
        identity: &AccountIdentity,
        auth: &Value,
        source: SlotSource,
    ) -> Result<StoreOutcome, AppError> {
        if classify(auth) != LoginClass::Chatgpt(identity.clone()) {
            return Err(AppError::Config(
                "登录材料与账号身份不一致，已拒绝保存".to_string(),
            ));
        }
        if last_refresh_is_in_future(auth, Utc::now()) {
            return Err(AppError::localized(
                "official_accounts.future_refresh",
                "登录材料的刷新时间晚于当前时间，已拒绝保存",
                "The login's refresh time is in the future; it was not saved",
            ));
        }
        for _ in 0..5 {
            let (existing, snapshot) = Self::read_entry(path)?;
            if let Some(existing) = existing {
                if existing.account_key == identity.key()
                    && !is_at_least_as_fresh(auth, &existing.auth)
                {
                    return Ok(StoreOutcome::KeptExisting);
                }
            }
            match Self::write_entry(snapshot, &VaultSlot::new(identity, auth, source)) {
                Ok(()) => return Ok(StoreOutcome::Stored),
                Err(AppError::Conflict(_)) => continue,
                Err(err) => return Err(err),
            }
        }
        Err(AppError::Config("账号保险库写入冲突，请重试".to_string()))
    }

    /// Updates the identity's trusted slot. Only Codex's live `auth.json`
    /// and our CLI capture may do this.
    pub fn store_slot(
        &self,
        identity: &AccountIdentity,
        auth: &Value,
        source: SlotSource,
    ) -> Result<StoreOutcome, AppError> {
        if !source.may_update_slot() {
            return Err(AppError::Config(
                "导入的登录材料只能作为待确认候选保存".to_string(),
            ));
        }
        let key = identity.key();
        let outcome = Self::offer(&self.slot_path(&key), identity, auth, source)?;
        // A fresh login of the identity supersedes an earlier disappearance.
        self.clear_tombstone(&key)?;
        Ok(outcome)
    }

    /// Switch-away backfill may refresh a saved login, never recreate a deleted
    /// account or clear a needs-login marker from a stale provider snapshot.
    pub fn refresh_existing_slot(
        &self,
        identity: &AccountIdentity,
        auth: &Value,
    ) -> Result<(), AppError> {
        let _transaction = super::account_mutation()?;
        let key = identity.key();
        if self.has_tombstone(&key) || self.read_slot(&key)?.is_none() {
            return Ok(());
        }
        self.store_slot(identity, auth, SlotSource::Live)?;
        Ok(())
    }

    /// Records imported material as a candidate for its own identity. A
    /// trusted slot always wins, so a candidate for an identity that already
    /// has one is dropped.
    #[cfg(test)]
    pub fn store_candidate(
        &self,
        identity: &AccountIdentity,
        auth: &Value,
        source: SlotSource,
    ) -> Result<StoreOutcome, AppError> {
        let key = identity.key();
        if self.slot_path(&key).exists() {
            return Ok(StoreOutcome::KeptExisting);
        }
        Self::offer(&self.candidate_path(&key), identity, auth, source)
    }

    pub fn read_slot(&self, key: &str) -> Result<Option<VaultSlot>, AppError> {
        validate_account_key(key)?;
        Ok(Self::read_entry(&self.slot_path(key))?.0)
    }

    #[cfg(test)]
    pub fn has_slot(&self, key: &str) -> bool {
        self.slot_path(key).is_file()
    }

    /// The user confirmed a candidate: it becomes the slot (unless a trusted
    /// slot appeared meanwhile, which wins) and the candidate is removed.
    #[cfg(test)]
    pub fn promote_candidate(&self, key: &str) -> Result<VaultSlot, AppError> {
        validate_account_key(key)?;
        let (candidate, _) = Self::read_entry(&self.candidate_path(key))?;
        let candidate = candidate.ok_or_else(|| {
            AppError::localized(
                "official_accounts.no_candidate",
                "没有待确认的登录",
                "There is no pending login to confirm",
            )
        })?;
        if candidate.account_key != key {
            return Err(AppError::Config("待确认登录与账号不一致".to_string()));
        }
        if !self.has_slot(key) {
            let (_, snapshot) = Self::read_entry(&self.slot_path(key))?;
            Self::write_entry(snapshot, &candidate)?;
            self.clear_tombstone(key)?;
        }
        remove_if_present(&self.candidate_path(key))?;
        self.read_slot(key)?.ok_or_else(needs_login_error)
    }

    /// The slot a switch may write to live, or "needs login".
    pub fn applicable_slot(&self, key: &str) -> Result<VaultSlot, AppError> {
        validate_account_key(key)?;
        if self.has_tombstone(key) {
            return Err(needs_login_error());
        }
        let slot = self
            .read_slot(key)
            .map_err(|_| needs_login_error())?
            .ok_or_else(needs_login_error)?;
        match classify(&slot.auth) {
            LoginClass::Chatgpt(identity) if identity.key() == key => Ok(slot),
            _ => Err(needs_login_error()),
        }
    }

    fn keys_in(&self, dir: &str) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.root.join(dir)) else {
            return Vec::new();
        };
        let mut keys: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let key = name.strip_suffix(".json").unwrap_or(&name).to_string();
                validate_account_key(&key).is_ok().then_some(key)
            })
            .collect();
        keys.sort();
        keys.dedup();
        keys
    }

    pub fn slot_keys(&self) -> Vec<String> {
        self.keys_in(ACCOUNTS_DIR)
    }

    #[cfg(test)]
    pub fn candidate_keys(&self) -> Vec<String> {
        self.keys_in(PENDING_DIR)
    }

    pub fn has_tombstone(&self, key: &str) -> bool {
        self.tombstone_path(key).is_file()
    }

    /// The live login of this account disappeared without Chimera++ removing
    /// it. That is not treated as a logout (the slot stays), but the account
    /// needs to sign in again before it is applied.
    pub fn set_tombstone(&self, key: &str) -> Result<(), AppError> {
        validate_account_key(key)?;
        let marker = serde_json::json!({ "at": Utc::now().to_rfc3339() }).to_string();
        crate::config::atomic_write(&self.tombstone_path(key), marker.as_bytes())
    }

    pub fn clear_tombstone(&self, key: &str) -> Result<(), AppError> {
        remove_if_present(&self.tombstone_path(key))
    }

    pub fn remove_account(&self, key: &str) -> Result<(), AppError> {
        validate_account_key(key)?;
        // Keep the visible account until every auxiliary cleanup has succeeded.
        remove_if_present(&self.candidate_path(key))?;
        let had_tombstone = self.has_tombstone(key);
        remove_if_present(&self.tombstone_path(key))?;
        let slot = self.slot_path(key);
        // Do not zero the primary slot before unlink: a failed unlink must leave
        // usable credentials for retry, not a visible but corrupted account.
        match fs::remove_file(&slot) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => {
                // Failed deletion must not make a needs-login account applicable again.
                if had_tombstone {
                    self.set_tombstone(key).map_err(|restore| AppError::Message(format!(
                        "Account deletion failed: {error}; needs-login marker restoration failed: {restore}"
                    )))?;
                }
                Err(AppError::io(&slot, error))
            }
        }
    }

    /// A fresh private directory for one CLI login, inside the protected
    /// vault so the `auth.json` Codex writes there inherits its protection.
    pub fn new_login_home(&self) -> Result<PathBuf, AppError> {
        let path = self.root.join(format!(
            "{LOGIN_HOME_PREFIX}{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&path).map_err(|e| AppError::io(&path, e))?;
        ensure_private_dir(&path)?;
        Ok(path)
    }

    /// Login homes left behind by an interrupted run.
    pub fn stale_login_homes(&self) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(LOGIN_HOME_PREFIX)
            })
            .map(|entry| entry.path())
            .collect()
    }
}

/// Overwrites every regular file under `dir` with zeros, then removes it.
/// Best effort against recovery of the plaintext `auth.json` a CLI login
/// leaves in its private home.
pub(crate) fn secure_remove_dir(dir: &Path) {
    fn scrub(dir: &Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                let _ = fs::remove_file(&path);
                continue;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    let _ = fs::remove_dir(&path);
                    continue;
                }
            }
            if meta.is_dir() {
                scrub(&path);
            } else if meta.is_file() {
                if let Ok(mut file) = fs::OpenOptions::new().write(true).open(&path) {
                    use std::io::Write;
                    let zeros = vec![0u8; meta.len().min(16 * 1024 * 1024) as usize];
                    let _ = file.write_all(&zeros);
                    let _ = file.sync_all();
                }
            }
        }
    }
    scrub(dir);
    if let Err(error) = fs::remove_dir_all(dir) {
        if error.kind() != io::ErrorKind::NotFound {
            log::warn!("无法删除临时登录目录 {}: {error}", dir.display());
        }
    }
}

#[cfg(windows)]
pub(crate) mod win {
    //! DPAPI and DACL helpers for the vault.

    use std::ffi::OsStr;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_USER,
    };

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Reads a NUL-terminated UTF-16 string allocated by the system, then
    /// frees it with `LocalFree`.
    unsafe fn take_local_wide_string(ptr: *mut u16) -> String {
        let mut len = 0;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
        LocalFree(ptr.cast());
        text
    }

    fn blob_to_vec(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let len = blob.cbData as usize;
        let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, len) }.to_vec();
        unsafe {
            std::ptr::write_bytes(blob.pbData, 0, len);
            LocalFree(blob.pbData.cast());
        }
        bytes
    }

    fn input_blob(data: &[u8]) -> io::Result<CRYPT_INTEGER_BLOB> {
        Ok(CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(data.len()).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "vault entry too large")
            })?,
            pbData: data.as_ptr() as *mut u8,
        })
    }

    /// `CryptProtectData`, current-user scope, never prompting.
    pub(crate) fn protect(plain: &[u8]) -> io::Result<Vec<u8>> {
        let input = input_blob(plain)?;
        let mut output = CRYPT_INTEGER_BLOB::default();
        let ok = unsafe {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(blob_to_vec(&output))
    }

    pub(crate) fn unprotect(sealed: &[u8]) -> io::Result<Vec<u8>> {
        let input = input_blob(sealed)?;
        let mut output = CRYPT_INTEGER_BLOB::default();
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(blob_to_vec(&output))
    }

    /// SID of the user running this process, in string form.
    pub(crate) fn current_user_sid() -> io::Result<String> {
        // `GetCurrentProcessToken()` is an inline pseudo-handle in the SDK,
        // not an export; valid for token queries on Windows 8 and later.
        let token = -4isize as HANDLE;
        let mut needed = 0u32;
        unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed) };
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }
        // u64 storage keeps the TOKEN_USER header aligned.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
        let mut sid: *mut u16 = null_mut();
        if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { take_local_wide_string(sid) })
    }

    /// Replaces the DACL of `path` with a protected one granting full
    /// control to the current user and SYSTEM only; children inherit it.
    pub(crate) fn restrict_to_current_user(path: &Path) -> io::Result<()> {
        let sddl = format!("D:P(A;OICI;FA;;;{})(A;OICI;FA;;;SY)", current_user_sid()?);
        let sddl = wide(OsStr::new(&sddl));
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl: *mut ACL = null_mut();
            let ok = unsafe {
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
            };
            if ok == 0 || present == 0 {
                return Err(io::Error::last_os_error());
            }
            let name = wide(path.as_os_str());
            let status = unsafe {
                SetNamedSecurityInfoW(
                    name.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    dacl,
                    null(),
                )
            };
            if status != 0 {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            Ok(())
        })();
        unsafe { LocalFree(descriptor) };
        result
    }

    /// The DACL of `path` in SDDL form.
    #[cfg(test)]
    pub(crate) fn dacl_sddl(path: &Path) -> io::Result<String> {
        use windows_sys::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW,
        };
        let name = wide(path.as_os_str());
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let mut text: *mut u16 = null_mut();
        let ok = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                null_mut(),
            )
        };
        let result = if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { take_local_wide_string(text) })
        };
        unsafe { LocalFree(descriptor) };
        result
    }
}

#[cfg(test)]
mod tests {
    use super::super::identity::test_support::{chatgpt_login, identity};
    use super::*;
    use tempfile::TempDir;

    fn vault() -> (TempDir, Vault) {
        let dir = TempDir::new().unwrap();
        let vault = Vault::open_at(dir.path().join("vault")).unwrap();
        (dir, vault)
    }

    #[test]
    fn audit_b09_auxiliary_delete_failure_preserves_visible_slot_for_retry() {
        for block_candidate in [false, true] {
            let (_dir, vault) = vault();
            let a = identity("a");
            let auth = chatgpt_login("a", "2026-09-20T00:00:00Z");
            vault.store_slot(&a, &auth, SlotSource::Cli).unwrap();
            let blocked = if block_candidate {
                vault.candidate_path(&a.key())
            } else {
                vault.tombstone_path(&a.key())
            };
            // A directory cannot be unlinked as a file on either Windows or Unix.
            fs::create_dir(&blocked).unwrap();
            assert!(vault.remove_account(&a.key()).is_err());
            assert_eq!(vault.slot_keys(), vec![a.key()]);
            assert_eq!(vault.read_slot(&a.key()).unwrap().unwrap().auth, auth);
            fs::remove_dir(&blocked).unwrap();
            vault.remove_account(&a.key()).unwrap();
            assert!(vault.slot_keys().is_empty());
            vault.remove_account(&a.key()).unwrap();
        }
    }

    #[cfg(windows)]
    #[test]
    fn audit_b09_locked_primary_slot_is_not_wiped_on_failed_delete() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_dir, vault) = vault();
        let a = identity("a");
        let auth = chatgpt_login("a", "2026-09-20T00:00:00Z");
        vault.store_slot(&a, &auth, SlotSource::Cli).unwrap();
        vault.set_tombstone(&a.key()).unwrap();
        let slot = vault.slot_path(&a.key());
        let bytes = fs::read(&slot).unwrap();
        // Permit reads/writes but deny FILE_SHARE_DELETE, reproducing unlink failure.
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(&slot)
            .unwrap();
        assert!(vault.remove_account(&a.key()).is_err());
        assert_eq!(fs::read(&slot).unwrap(), bytes);
        assert!(vault.has_tombstone(&a.key()));
        assert!(vault.applicable_slot(&a.key()).is_err());
        drop(held);
        vault.remove_account(&a.key()).unwrap();
    }

    #[test]
    fn slots_follow_freshness_within_one_identity() {
        let (_dir, vault) = vault();
        let a = identity("a");
        let newer = chatgpt_login("a", "2026-09-20T00:00:00Z");
        let older = chatgpt_login("a", "2026-09-01T00:00:00Z");
        assert_eq!(
            vault.store_slot(&a, &newer, SlotSource::Live).unwrap(),
            StoreOutcome::Stored
        );
        assert_eq!(
            vault.store_slot(&a, &older, SlotSource::Live).unwrap(),
            StoreOutcome::KeptExisting
        );
        assert_eq!(vault.read_slot(&a.key()).unwrap().unwrap().auth, newer);
        assert_eq!(vault.slot_keys(), vec![a.key()]);
    }

    #[test]
    fn material_of_another_identity_or_from_the_future_is_refused() {
        let (_dir, vault) = vault();
        assert!(vault
            .store_slot(
                &identity("a"),
                &chatgpt_login("b", "2026-09-20T00:00:00Z"),
                SlotSource::Live
            )
            .is_err());
        let future = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        assert!(vault
            .store_slot(
                &identity("a"),
                &chatgpt_login("a", &future),
                SlotSource::Live
            )
            .is_err());
        assert!(vault.slot_keys().is_empty());
    }

    #[test]
    fn imported_material_only_becomes_a_candidate_until_confirmed() {
        let (_dir, vault) = vault();
        let a = identity("a");
        let login = chatgpt_login("a", "2026-09-20T00:00:00Z");
        assert!(vault.store_slot(&a, &login, SlotSource::Import).is_err());
        vault
            .store_candidate(&a, &login, SlotSource::Import)
            .unwrap();
        assert!(vault.read_slot(&a.key()).unwrap().is_none());
        assert!(matches!(
            vault.applicable_slot(&a.key()),
            Err(AppError::Localized {
                key: "official_accounts.needs_login",
                ..
            })
        ));
        assert_eq!(vault.candidate_keys(), vec![a.key()]);

        let promoted = vault.promote_candidate(&a.key()).unwrap();
        assert_eq!(promoted.auth, login);
        assert!(vault.candidate_keys().is_empty());
        assert!(vault.applicable_slot(&a.key()).is_ok());

        // Once a trusted slot exists, imported material is dropped.
        let older = chatgpt_login("a", "2026-09-25T00:00:00Z");
        assert_eq!(
            vault
                .store_candidate(&a, &older, SlotSource::Import)
                .unwrap(),
            StoreOutcome::KeptExisting
        );
        assert!(vault.candidate_keys().is_empty());
    }

    // ACC-T13 (vault half)
    #[test]
    fn missing_corrupt_or_tombstoned_slots_need_login() {
        let (_dir, vault) = vault();
        let a = identity("a");
        assert!(vault.applicable_slot(&a.key()).is_err());

        vault
            .store_slot(
                &a,
                &chatgpt_login("a", "2026-09-20T00:00:00Z"),
                SlotSource::Live,
            )
            .unwrap();
        vault.set_tombstone(&a.key()).unwrap();
        assert!(vault.applicable_slot(&a.key()).is_err());
        // A fresh capture of the same identity clears it.
        vault
            .store_slot(
                &a,
                &chatgpt_login("a", "2026-09-21T00:00:00Z"),
                SlotSource::Cli,
            )
            .unwrap();
        assert!(!vault.has_tombstone(&a.key()));
        assert!(vault.applicable_slot(&a.key()).is_ok());

        fs::write(vault.slot_path(&a.key()), b"corrupt").unwrap();
        assert!(vault.applicable_slot(&a.key()).is_err());
        // Other accounts are unaffected.
        let b = identity("b");
        vault
            .store_slot(
                &b,
                &chatgpt_login("b", "2026-09-20T00:00:00Z"),
                SlotSource::Live,
            )
            .unwrap();
        assert!(vault.applicable_slot(&b.key()).is_ok());
    }

    #[test]
    fn account_keys_from_ipc_are_validated() {
        let (_dir, vault) = vault();
        let not_hex = "g".repeat(64);
        for key in ["../../etc/passwd", "", "ABC", not_hex.as_str()] {
            assert!(vault.read_slot(key).is_err(), "{key}");
            assert!(vault.remove_account(key).is_err(), "{key}");
        }
    }

    #[test]
    fn vault_location_never_follows_the_app_data_directory() {
        let root = default_vault_root();
        assert!(root.ends_with(Path::new(crate::product_policy::PRODUCT_NAME).join("vault")));
        assert!(!root.starts_with(crate::config::get_app_config_dir()));
    }

    #[test]
    fn secure_remove_deletes_the_login_home() {
        let (_dir, vault) = vault();
        let home = vault.new_login_home().unwrap();
        fs::write(home.join("auth.json"), b"{\"tokens\":{}}").unwrap();
        assert_eq!(vault.stale_login_homes(), vec![home.clone()]);
        secure_remove_dir(&home);
        assert!(!home.exists());
    }

    // ACC-T24
    #[cfg(unix)]
    #[test]
    fn vault_directories_are_0700_and_entries_0600() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, vault) = vault();
        let a = identity("a");
        vault
            .store_slot(
                &a,
                &chatgpt_login("a", "2026-09-20T00:00:00Z"),
                SlotSource::Live,
            )
            .unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(vault.root()), 0o700);
        assert_eq!(mode(&vault.root().join(ACCOUNTS_DIR)), 0o700);
        assert_eq!(mode(&vault.slot_path(&a.key())), 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_vault_root_is_refused() {
        let dir = TempDir::new().unwrap();
        let elsewhere = dir.path().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        let link = dir.path().join("vault");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        assert!(matches!(
            Vault::open_at(link),
            Err(AppError::Localized {
                key: "official_accounts.vault_relocated",
                ..
            })
        ));
    }

    #[cfg(windows)]
    #[test]
    fn vault_has_a_protected_owner_only_dacl_and_dpapi_entries() {
        let (_dir, vault) = vault();
        let a = identity("a");
        let login = chatgpt_login("a", "2026-09-20T00:00:00Z");
        vault.store_slot(&a, &login, SlotSource::Live).unwrap();

        let sid = win::current_user_sid().unwrap();
        let owner_only = |sddl: &str| {
            // Windows may canonicalize the built-in local Administrator
            // account (RID 500) to the well-known SDDL alias `LA`.
            let owner_ace = sddl.contains(&format!(";;;{sid})"))
                || (sid.ends_with("-500") && sddl.contains(";;;LA)"));
            sddl.matches("(A;").count() == 2
                && owner_ace
                && sddl.contains(";;;SY)")
                && !sddl.contains("(D;")
        };
        let root = win::dacl_sddl(vault.root()).unwrap();
        assert!(
            root.starts_with("D:P"),
            "root DACL must be protected: {root}"
        );
        assert!(owner_only(&root), "{root}");
        let entry = win::dacl_sddl(&vault.slot_path(&a.key())).unwrap();
        assert!(owner_only(&entry), "{entry}");

        // DPAPI: the file on disk is sealed, never plaintext.
        let raw = fs::read(vault.slot_path(&a.key())).unwrap();
        assert!(raw.starts_with(SEALED_MAGIC));
        let raw_text = String::from_utf8_lossy(&raw);
        assert!(!raw_text.contains("refresh-a"));
        assert!(!raw_text.contains("access-a"));
        assert_eq!(vault.read_slot(&a.key()).unwrap().unwrap().auth, login);
        assert_eq!(
            win::unprotect(&win::protect(b"round-trip").unwrap()).unwrap(),
            b"round-trip"
        );
    }
}
