//! Multiple official ChatGPT accounts for Codex (plan §2 M4, D8 option (d)).
//!
//! An account is a ChatGPT identity (`chatgpt_user_id`, `chatgpt_account_id`)
//! whose `auth.json` is stored exactly once, in the [`vault`]. Official lines
//! stay `providers` rows that only pin an account (`meta.officialAccount`);
//! no token ever reaches the database, IPC, exports, deep links or logs.
//! Everything here sits behind the `official_accounts` capability.

pub(crate) mod identity;
pub(crate) mod login;
pub(crate) mod vault;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

use crate::app_config::AppType;
use crate::config::cas::FileSnapshot;
use crate::database::{Database, CODEX_OFFICIAL_PROVIDER_ID};
use crate::error::AppError;
use crate::product_policy::Capability;
use crate::provider::{OfficialAccountPin, Provider, ProviderMeta};
use identity::{auth_display_metadata, classify, mask_email, DisplayMetadata, LoginClass};
use vault::{SlotSource, Vault};

pub(crate) const PIN_VERSION: u32 = 1;

// ponytail: process-wide serialization; use per-vault locks if contention matters.
// Lock order: optional provider switch lock -> account mutation -> DB/vault.
// Never acquire a provider switch/lifecycle lock while holding this guard,
// or acquire this guard while holding a DB or login lock.
// Vault primitives deliberately do not reacquire this non-reentrant mutex.
static ACCOUNT_MUTATION: Mutex<()> = Mutex::new(());

pub(crate) fn account_mutation() -> Result<MutexGuard<'static, ()>, AppError> {
    ACCOUNT_MUTATION
        .lock()
        .map_err(|_| AppError::Lock("账号事务状态不可用".to_string()))
}

pub(crate) fn require_enabled() -> Result<(), AppError> {
    crate::product_policy::require(Capability::OfficialAccounts)
}

/// Codex's live `auth.json`, read the way Codex writes it: truncate and
/// rewrite, so a parse error may be a write in progress and is retried; it
/// is never mistaken for a logout.
pub(crate) enum LiveAuth {
    Missing,
    Unreadable,
    Present(Value),
}

pub(crate) fn read_live_auth(path: &Path) -> Result<(FileSnapshot, LiveAuth), AppError> {
    let mut attempt = 0;
    loop {
        let snapshot = FileSnapshot::read(path)?;
        let live = match snapshot.contents() {
            None => LiveAuth::Missing,
            Some(bytes) => match serde_json::from_slice::<Value>(bytes) {
                Ok(value) => LiveAuth::Present(value),
                Err(_) if attempt < 2 => {
                    attempt += 1;
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                Err(_) => LiveAuth::Unreadable,
            },
        };
        return Ok((snapshot, live));
    }
}

/// Resolve a Vault identity for quota queries, never the legacy OAuth store.
/// Codex owns refresh-token rotation: prefer its newer live access token for
/// this same identity, without refreshing or writing either credential store.
pub(crate) fn quota_credentials(
    vault: &Vault,
    codex_dir: &Path,
    key: &str,
) -> Result<(String, String), AppError> {
    let slot = vault.applicable_slot(key)?;
    let account_id = slot.account_id().to_string();
    let mut auth = slot.auth;
    if let Ok((_, LiveAuth::Present(live))) = read_live_auth(&codex_dir.join("auth.json")) {
        if let LoginClass::Chatgpt(identity) = classify(&live) {
            if identity.key() == key
                && !identity::last_refresh_is_in_future(&live, chrono::Utc::now())
                && identity::is_at_least_as_fresh(&live, &auth)
            {
                auth = live;
            }
        }
    }
    let token = auth
        .pointer("/tokens/access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(vault::needs_login_error)?;
    Ok((token.to_string(), account_id))
}

pub(crate) fn official_lines(db: &Database) -> Result<Vec<Provider>, AppError> {
    Ok(db
        .get_all_providers(AppType::Codex.as_str())?
        .into_values()
        .filter(|provider| provider.category.as_deref() == Some("official"))
        .collect())
}

pub(crate) fn set_pin(provider: &mut Provider, key: Option<&str>) {
    provider
        .meta
        .get_or_insert_with(ProviderMeta::default)
        .official_account = key.map(|key| OfficialAccountPin {
        v: PIN_VERSION,
        account_key: key.to_string(),
    });
}

pub(crate) fn default_line_name(display: &DisplayMetadata) -> String {
    match display.email.as_deref() {
        Some(email) => format!("ChatGPT · {}", mask_email(email)),
        None => "ChatGPT 账号".to_string(),
    }
}

fn create_line(
    transaction: &MutexGuard<'_, ()>,
    db: &Database,
    key: &str,
    name: String,
) -> Result<String, AppError> {
    let id = format!("{CODEX_OFFICIAL_PROVIDER_ID}-{}", uuid::Uuid::new_v4());
    let mut line = Provider::with_id(
        id.clone(),
        name,
        json!({ "auth": {}, "config": "" }),
        Some("https://chatgpt.com/codex".to_string()),
    );
    line.category = Some("official".to_string());
    line.created_at = Some(chrono::Utc::now().timestamp_millis());
    line.icon = Some("openai".to_string());
    line.icon_color = Some("#00A67E".to_string());
    set_pin(&mut line, Some(key));
    db.save_provider_with_account_pin(transaction, &line)?;
    Ok(id)
}

/// The line that carries account `key`: one already pinned to it, else
/// `adopt` when that is an unpinned official line (the default line that
/// followed this very login), else a new line. An identity never gets a
/// second credential set, only lines that share its slot.
fn register_account_line(
    transaction: &MutexGuard<'_, ()>,
    db: &Database,
    key: &str,
    display: &DisplayMetadata,
    name: Option<String>,
    adopt: Option<&str>,
) -> Result<String, AppError> {
    let lines = official_lines(db)?;
    if let Some(line) = lines
        .iter()
        .find(|line| line.official_account_key() == Some(key))
    {
        return Ok(line.id.clone());
    }
    if let Some(line) = adopt.and_then(|id| {
        lines
            .iter()
            .find(|line| line.id == id && line.official_account_key().is_none())
    }) {
        let mut line = line.clone();
        set_pin(&mut line, Some(key));
        if let Some(name) = name {
            line.name = name;
        }
        db.save_provider_with_account_pin(transaction, &line)?;
        return Ok(line.id);
    }
    create_line(
        transaction,
        db,
        key,
        name.unwrap_or_else(|| default_line_name(display)),
    )
}

fn no_live_login() -> AppError {
    AppError::localized(
        "official_accounts.no_live_login",
        "Codex 当前没有完整的 ChatGPT 登录可保存",
        "Codex has no complete ChatGPT login to save",
    )
}

/// "Save current login": registers the login Codex is using now. Codex's
/// own live `auth.json` may create or update a slot.
pub(crate) fn save_current_login(
    db: &Database,
    vault: &Vault,
    codex_dir: &Path,
    name: Option<String>,
) -> Result<String, AppError> {
    let transaction = account_mutation()?;
    let name = name.as_deref().map(identity::normalize_name).transpose()?;
    let (_, live) = read_live_auth(&codex_dir.join("auth.json"))?;
    let auth = match live {
        LiveAuth::Present(auth) => auth,
        LiveAuth::Unreadable => {
            return Err(AppError::localized(
                "official_accounts.unreadable_live_auth",
                "Codex 当前登录文件格式损坏或无法读取",
                "Codex's current auth file is unreadable or malformed",
            ))
        }
        LiveAuth::Missing => return Err(no_live_login()),
    };
    let LoginClass::Chatgpt(account) = classify(&auth) else {
        return Err(no_live_login());
    };
    vault.store_slot(&account, &auth, SlotSource::Live)?;
    let key = account.key();
    let current = crate::settings::get_effective_current_provider(db, &AppType::Codex)?;
    register_account_line(
        &transaction,
        db,
        &key,
        &auth_display_metadata(&auth),
        name,
        current.as_deref(),
    )?;
    Ok(key)
}

/// When a second account is added while the default line still follows
/// whatever Codex is logged into, pin the default line to that login first,
/// so it keeps meaning the same account afterwards.
pub(crate) fn pin_default_line_to_live(
    transaction: &MutexGuard<'_, ()>,
    db: &Database,
    vault: &Vault,
    codex_dir: &Path,
    added_key: &str,
) -> Result<(), AppError> {
    let lines = official_lines(db)?;
    let Some(default_line) = lines.iter().find(|line| {
        line.id == CODEX_OFFICIAL_PROVIDER_ID && line.official_account_key().is_none()
    }) else {
        return Ok(());
    };
    let (_, live_auth) = read_live_auth(&codex_dir.join("auth.json"))?;
    let LiveAuth::Present(auth) = live_auth else {
        return Ok(());
    };
    let LoginClass::Chatgpt(live) = classify(&auth) else {
        return Ok(());
    };
    let live_key = live.key();
    if live_key == added_key {
        vault.store_slot(&live, &auth, SlotSource::Live)?;
        let mut default_line = default_line.clone();
        set_pin(&mut default_line, Some(&live_key));
        return db.save_provider_with_account_pin(transaction, &default_line);
    }
    if lines
        .iter()
        .any(|line| line.official_account_key() == Some(live_key.as_str()))
    {
        return Ok(());
    }
    vault.store_slot(&live, &auth, SlotSource::Live)?;
    let mut default_line = default_line.clone();
    set_pin(&mut default_line, Some(&live_key));
    db.save_provider_with_account_pin(transaction, &default_line)
}

/// Persist the captured CLI login and register its line in one mutation boundary.
/// Capture/poll must release the login mutex before calling this function.
pub(crate) fn register_cli_login(
    db: &Database,
    vault: &Vault,
    codex_dir: &Path,
    account: &identity::AccountIdentity,
    auth: &Value,
) -> Result<String, AppError> {
    let transaction = account_mutation()?;
    vault.store_slot(account, auth, SlotSource::Cli)?;
    let key = account.key();
    pin_default_line_to_live(&transaction, db, vault, codex_dir, &key)?;
    register_account_line(
        &transaction,
        db,
        &key,
        &auth_display_metadata(auth),
        None,
        None,
    )?;
    Ok(key)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use tempfile::TempDir;

    pub(crate) struct Fixture {
        pub dir: TempDir,
        pub db: Database,
        pub vault: Vault,
    }

    impl Fixture {
        pub fn new() -> Self {
            let dir = TempDir::new().unwrap();
            let db = Database::memory().unwrap();
            let vault = Vault::open_at(dir.path().join("vault")).unwrap();
            std::fs::create_dir_all(dir.path().join("codex")).unwrap();
            Self { dir, db, vault }
        }

        pub fn codex_dir(&self) -> std::path::PathBuf {
            self.dir.path().join("codex")
        }

        pub fn write_live(&self, auth: &Value) {
            std::fs::write(
                self.codex_dir().join("auth.json"),
                serde_json::to_vec_pretty(auth).unwrap(),
            )
            .unwrap();
        }

        pub fn live_bytes(&self) -> Option<Vec<u8>> {
            std::fs::read(self.codex_dir().join("auth.json")).ok()
        }

        pub fn add_line(&self, id: &str, key: Option<&str>) {
            let mut line = Provider::with_id(
                id.to_string(),
                id.to_string(),
                json!({ "auth": {}, "config": "" }),
                None,
            );
            line.category = Some("official".to_string());
            set_pin(&mut line, key);
            self.db
                .save_provider_with_account_pin(&account_mutation().unwrap(), &line)
                .unwrap();
        }

        pub fn line(&self, id: &str) -> Provider {
            self.db
                .get_provider_by_id(id, AppType::Codex.as_str())
                .unwrap()
                .unwrap()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::identity::test_support::{chatgpt_login, identity};
    use super::test_support::Fixture;
    use super::*;

    #[test]
    fn quota_uses_the_requested_vault_identity_not_another_user_in_the_same_workspace() {
        let fx = Fixture::new();
        let login = chatgpt_login("a", "2020-01-01T00:00:00Z");
        fx.vault
            .store_slot(&identity("a"), &login, SlotSource::Cli)
            .unwrap();
        let mut other = chatgpt_login("b", "2020-01-02T00:00:00Z");
        other["tokens"]["account_id"] = json!("acct-a");
        other["tokens"]["id_token"] = json!(identity::test_support::jwt(json!({
            "https://api.openai.com/auth": {
                "chatgpt_user_id": "user-b",
                "chatgpt_account_id": "acct-a"
            }
        })));
        assert!(matches!(classify(&other), LoginClass::Chatgpt(_)));
        fx.write_live(&other);
        let live_before = fx.live_bytes();
        assert_eq!(
            quota_credentials(&fx.vault, &fx.codex_dir(), &identity("a").key()).unwrap(),
            ("access-a".to_string(), "acct-a".to_string())
        );
        assert_eq!(fx.live_bytes(), live_before);
        assert_eq!(fx.vault.slot_keys(), vec![identity("a").key()]);
    }

    #[test]
    fn quota_observes_codex_rotation_without_writing_credentials() {
        let fx = Fixture::new();
        let key = identity("a").key();
        let saved = chatgpt_login("a", "2020-01-01T00:00:00Z");
        fx.vault
            .store_slot(&identity("a"), &saved, SlotSource::Cli)
            .unwrap();
        let mut rotated = chatgpt_login("a", "2020-01-02T00:00:00Z");
        rotated["tokens"]["access_token"] = json!("rotated-access");
        rotated["tokens"]["refresh_token"] = json!("rotated-refresh");
        fx.write_live(&rotated);
        let live_before = fx.live_bytes();
        assert_eq!(
            quota_credentials(&fx.vault, &fx.codex_dir(), &key).unwrap(),
            ("rotated-access".to_string(), "acct-a".to_string())
        );
        assert_eq!(fx.live_bytes(), live_before);
        assert_eq!(fx.vault.read_slot(&key).unwrap().unwrap().auth, saved);
        assert!(official_lines(&fx.db).unwrap().is_empty());
    }

    #[test]
    fn quota_keeps_the_vault_token_when_live_is_missing_stale_future_or_conflicting() {
        let fx = Fixture::new();
        let key = identity("a").key();
        let saved = chatgpt_login("a", "2020-01-02T00:00:00Z");
        fx.vault
            .store_slot(&identity("a"), &saved, SlotSource::Cli)
            .unwrap();
        let expected = ("access-a".to_string(), "acct-a".to_string());
        assert_eq!(
            quota_credentials(&fx.vault, &fx.codex_dir(), &key).unwrap(),
            expected
        );
        let mut stale = chatgpt_login("a", "2020-01-01T00:00:00Z");
        stale["tokens"]["access_token"] = json!("stale-access");
        let mut future = stale.clone();
        future["last_refresh"] =
            json!((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339());
        let mut conflict = chatgpt_login("a", "2020-01-03T00:00:00Z");
        conflict["tokens"]["account_id"] = json!("acct-b");
        for live in [stale, future, conflict, json!({})] {
            fx.write_live(&live);
            assert_eq!(
                quota_credentials(&fx.vault, &fx.codex_dir(), &key).unwrap(),
                expected
            );
        }
        assert_eq!(fx.vault.read_slot(&key).unwrap().unwrap().auth, saved);
    }

    #[test]
    fn quota_does_not_revive_missing_or_tombstoned_slots_from_live() {
        let fx = Fixture::new();
        let key = identity("a").key();
        let login = chatgpt_login("a", "2020-01-01T00:00:00Z");
        fx.write_live(&login);
        assert!(quota_credentials(&fx.vault, &fx.codex_dir(), &key).is_err());
        assert!(quota_credentials(&fx.vault, &fx.codex_dir(), "../invalid").is_err());
        assert!(quota_credentials(&fx.vault, &fx.codex_dir(), "acct-a").is_err());
        assert!(fx.vault.slot_keys().is_empty());
        fx.vault
            .store_slot(&identity("a"), &login, SlotSource::Cli)
            .unwrap();
        fx.vault.set_tombstone(&key).unwrap();
        assert!(quota_credentials(&fx.vault, &fx.codex_dir(), &key).is_err());
        assert!(fx.vault.has_tombstone(&key));
    }

    #[test]
    fn saving_the_current_login_pins_the_default_line_it_was_following() {
        let fx = Fixture::new();
        fx.add_line(CODEX_OFFICIAL_PROVIDER_ID, None);
        fx.db
            .set_current_provider(AppType::Codex.as_str(), CODEX_OFFICIAL_PROVIDER_ID)
            .unwrap();
        let login = chatgpt_login("a", "2026-09-27T12:00:00Z");
        fx.write_live(&login);

        let key = save_current_login(&fx.db, &fx.vault, &fx.codex_dir(), None).unwrap();
        assert_eq!(key, identity("a").key());
        assert_eq!(
            fx.line(CODEX_OFFICIAL_PROVIDER_ID).official_account_key(),
            Some(key.as_str())
        );
        assert_eq!(fx.vault.read_slot(&key).unwrap().unwrap().auth, login);
        // Saving again never creates a second line or credential.
        save_current_login(&fx.db, &fx.vault, &fx.codex_dir(), None).unwrap();
        assert_eq!(official_lines(&fx.db).unwrap().len(), 1);
        assert_eq!(fx.vault.slot_keys(), vec![key]);
    }

    #[test]
    fn adding_a_second_account_pins_the_default_line_to_the_live_login_first() {
        let fx = Fixture::new();
        fx.add_line(CODEX_OFFICIAL_PROVIDER_ID, None);
        fx.write_live(&chatgpt_login("a", "2026-09-27T12:00:00Z"));
        let b = identity("b");
        let b_login = chatgpt_login("b", "2026-09-27T12:30:00Z");
        fx.vault.store_slot(&b, &b_login, SlotSource::Cli).unwrap();

        let key = register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &b, &b_login).unwrap();
        assert_eq!(key, b.key());
        let a_key = identity("a").key();
        assert_eq!(
            fx.line(CODEX_OFFICIAL_PROVIDER_ID).official_account_key(),
            Some(a_key.as_str())
        );
        assert!(fx.vault.has_slot(&a_key));
        let b_lines: Vec<_> = official_lines(&fx.db)
            .unwrap()
            .into_iter()
            .filter(|line| line.official_account_key() == Some(key.as_str()))
            .collect();
        assert_eq!(b_lines.len(), 1);
        assert_eq!(b_lines[0].name, "ChatGPT · b***@example.test");
        assert_eq!(b_lines[0].settings_config["auth"], json!({}));
    }

    #[test]
    fn failed_slot_write_never_registers_a_line() {
        for cli in [false, true] {
            let fx = Fixture::new();
            let account = identity("b05");
            let auth = chatgpt_login("b05", "2020-01-01T00:00:00Z");
            fx.write_live(&auth);
            // A directory where the slot file belongs injects an I/O failure.
            std::fs::create_dir(
                fx.dir
                    .path()
                    .join("vault/accounts")
                    .join(format!("{}.json", account.key())),
            )
            .unwrap();
            let result = if cli {
                register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
            } else {
                save_current_login(&fx.db, &fx.vault, &fx.codex_dir(), None)
            };
            assert!(result.is_err());
            assert!(official_lines(&fx.db).unwrap().is_empty());
        }
    }

    #[test]
    fn registration_failure_keeps_credentials_and_retry_registers_once() {
        for cli in [false, true] {
            let fx = Fixture::new();
            let account = identity("b05");
            let auth = chatgpt_login("b05", "2020-01-01T00:00:00Z");
            let key = account.key();
            fx.write_live(&auth);
            fx.db
                .conn
                .lock()
                .unwrap()
                .execute_batch(
                    "CREATE TRIGGER reject_b05 BEFORE INSERT ON providers
                 BEGIN SELECT RAISE(ABORT, 'injected registration failure'); END;",
                )
                .unwrap();
            let save = || {
                if cli {
                    register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                } else {
                    save_current_login(&fx.db, &fx.vault, &fx.codex_dir(), None)
                }
            };
            assert!(save().is_err());
            assert_eq!(fx.vault.read_slot(&key).unwrap().unwrap().auth, auth);
            assert!(official_lines(&fx.db).unwrap().is_empty());
            fx.db
                .conn
                .lock()
                .unwrap()
                .execute_batch("DROP TRIGGER reject_b05;")
                .unwrap();
            assert_eq!(save().unwrap(), key);
            assert_eq!(save().unwrap(), key);
            assert_eq!(official_lines(&fx.db).unwrap().len(), 1);
        }
    }

    #[test]
    fn only_a_complete_chatgpt_login_can_be_saved() {
        let fx = Fixture::new();
        assert!(save_current_login(&fx.db, &fx.vault, &fx.codex_dir(), None).is_err());
        fx.write_live(&json!({"auth_mode": "apikey", "OPENAI_API_KEY": "sk-x"}));
        assert!(save_current_login(&fx.db, &fx.vault, &fx.codex_dir(), None).is_err());
        assert!(fx.vault.slot_keys().is_empty());
        assert!(official_lines(&fx.db).unwrap().is_empty());
    }
}
