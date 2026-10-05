use serde::Serialize;
use std::collections::HashMap;

use crate::app_config::AppType;
use crate::codex_accounts::{self, login::LoginPoll, vault::Vault};
use crate::error::AppError;
use crate::services::subscription::{query_codex_quota, SubscriptionQuota};
use crate::store::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialAccountDto {
    pub key: String,
    pub account_id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub captured_at: String,
    pub is_current: bool,
    pub needs_relogin: bool,
    pub provider_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedLoginDto {
    pub flow_id: String,
    pub verification_url: String,
    pub user_code: String,
    pub expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollLoginDto {
    pub status: String,
    pub key: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn list_official_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<OfficialAccountDto>, AppError> {
    let vault = Vault::open_default()?;
    let lines = codex_accounts::official_lines(&state.db)?;
    let current_id = crate::settings::get_effective_current_provider(&state.db, &AppType::Codex)?;

    let mut accounts = Vec::new();
    for key in vault.slot_keys() {
        if let Ok(Some(slot)) = vault.read_slot(&key) {
            let display = codex_accounts::identity::auth_display_metadata(&slot.auth);
            let line = official_account_line(&lines, &key, current_id.as_deref());
            let is_current = line.is_some_and(|l| Some(&l.id) == current_id.as_ref());
            let needs_relogin = vault.has_tombstone(&key);
            accounts.push(OfficialAccountDto {
                key: key.clone(),
                account_id: slot.account_id().to_string(),
                display_name: codex_accounts::default_line_name(&display),
                email: display.email,
                captured_at: slot.captured_at,
                is_current,
                needs_relogin,
                provider_id: line.map(|l| l.id.clone()),
            });
        }
    }
    Ok(accounts)
}

fn official_account_line<'a>(
    lines: &'a [crate::provider::Provider],
    key: &str,
    current_id: Option<&str>,
) -> Option<&'a crate::provider::Provider> {
    let mut matching = lines
        .iter()
        .filter(|line| line.official_account_key() == Some(key));
    matching
        .clone()
        .find(|line| Some(line.id.as_str()) == current_id)
        .or_else(|| matching.next())
}

/// Quota-only IPC: credentials stay inside the Vault/live-auth backend path.
#[tauri::command]
pub async fn get_official_account_quota(key: String) -> Result<SubscriptionQuota, String> {
    codex_accounts::require_enabled().map_err(|err| err.to_string())?;
    let vault = Vault::open_default().map_err(|err| err.to_string())?;
    let codex_dir = crate::codex_config::get_codex_config_dir();
    let (access_token, account_id) = codex_accounts::quota_credentials(&vault, &codex_dir, &key)
        .map_err(|err| err.to_string())?;
    query_codex_quota(
        &access_token,
        Some(&account_id),
        "codex",
        "官方账号登录已过期或被拒绝，请在 Codex 中刷新登录后重试，或重新登录",
    )
    .await
}

#[tauri::command]
pub async fn save_current_official_login(
    state: tauri::State<'_, AppState>,
    name: Option<String>,
) -> Result<String, AppError> {
    let vault = Vault::open_default()?;
    let codex_dir = crate::codex_config::get_codex_config_dir();
    codex_accounts::save_current_login(&state.db, &vault, &codex_dir, name)
}

#[tauri::command]
pub async fn start_official_device_login() -> Result<StartedLoginDto, AppError> {
    start_official_login(false).await
}

#[tauri::command]
pub async fn start_official_browser_login() -> Result<StartedLoginDto, AppError> {
    start_official_login(true).await
}

async fn start_official_login(browser: bool) -> Result<StartedLoginDto, AppError> {
    let started = tauri::async_runtime::spawn_blocking(move || {
        let vault = Vault::open_default()?;
        if browser {
            codex_accounts::login::start_browser(&vault)
        } else {
            codex_accounts::login::start(&vault)
        }
    })
    .await
    .map_err(|_| AppError::Message("登录任务未完成，请重试".to_string()))??;
    Ok(StartedLoginDto {
        flow_id: started.flow_id,
        verification_url: started.prompt.verification_url,
        user_code: started.prompt.user_code,
        expires_at: started.expires_at.to_rfc3339(),
    })
}

#[tauri::command]
pub async fn poll_official_device_login(
    state: tauri::State<'_, AppState>,
    flow_id: String,
) -> Result<PollLoginDto, AppError> {
    let vault = Vault::open_default()?;
    match codex_accounts::login::poll(&flow_id)? {
        LoginPoll::Pending => Ok(PollLoginDto {
            status: "pending".to_string(),
            key: None,
            error: None,
        }),
        LoginPoll::Completed(identity, auth) => {
            let codex_dir = crate::codex_config::get_codex_config_dir();
            let key = codex_accounts::register_cli_login(
                &state.db, &vault, &codex_dir, &identity, &auth,
            )?;
            Ok(PollLoginDto {
                status: "completed".to_string(),
                key: Some(key),
                error: None,
            })
        }
        LoginPoll::Expired => Ok(PollLoginDto {
            status: "expired".to_string(),
            key: None,
            error: Some("登录已过期，请重试".to_string()),
        }),
        LoginPoll::Failed(err) => Ok(PollLoginDto {
            status: "failed".to_string(),
            key: None,
            error: Some(err.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn cancel_official_device_login(flow_id: String) -> Result<(), AppError> {
    codex_accounts::login::cancel(&flow_id)
}

#[tauri::command]
pub async fn remove_official_account(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<(), AppError> {
    let vault = Vault::open_default()?;
    remove_official_account_from(&state.db, &key, || vault.remove_account(&key))
}

fn remove_official_account_from(
    db: &crate::database::Database,
    key: &str,
    remove_credentials: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    let transaction = codex_accounts::account_mutation()?;
    // Never remove credentials until every binding is detached. A failed DB write
    // leaves the account present; retry only needs to detach the remaining lines.
    let lines = codex_accounts::official_lines(db)?;
    for mut line in lines {
        if line.official_account_key() == Some(key) {
            codex_accounts::set_pin(&mut line, None);
            db.save_provider_with_account_pin(&transaction, &line).map_err(|error| {
                AppError::Message(format!(
                    "Account retained: failed to detach provider {}: {error}. Some providers may already be detached; retry removal.", line.id
                ))
            })?;
        }
    }
    remove_credentials().map_err(|error| {
        AppError::Message(format!(
            "Providers detached, but credential removal is incomplete: {error}. Retry removal."
        ))
    })
}

#[tauri::command]
pub async fn get_notes(
    state: tauri::State<'_, AppState>,
    table: String,
) -> Result<HashMap<String, String>, AppError> {
    let notes_table = parse_notes_table(&table)?;
    state.db.get_notes(notes_table)
}

#[tauri::command]
pub async fn set_notes(
    state: tauri::State<'_, AppState>,
    table: String,
    id: String,
    notes: Option<String>,
) -> Result<(), AppError> {
    let notes_table = parse_notes_table(&table)?;
    if !state.db.set_notes(notes_table, &id, notes.as_deref())? {
        return Err(AppError::InvalidInput("备注对象不存在".to_string()));
    }
    Ok(())
}

#[tauri::command]
pub async fn get_codex_mcp_section_preview(
    id: String,
    spec: serde_json::Value,
    mask: Option<String>,
) -> Result<(String, String), AppError> {
    let mask_str = mask.unwrap_or_else(|| "[已设置]".to_string());
    crate::mcp::codex_mcp_section_preview(&id, &spec, move |_| mask_str.clone())
}

fn parse_notes_table(table: &str) -> Result<crate::database::NotesTable, AppError> {
    match table {
        "skills" => Ok(crate::database::NotesTable::Skills),
        "mcp_servers" => Ok(crate::database::NotesTable::McpServers),
        _ => Err(AppError::InvalidInput("不支持的备注类型".to_string())),
    }
}

#[cfg(test)]
mod account_line_tests {
    use super::*;
    use crate::provider::Provider;

    fn lines() -> Vec<Provider> {
        [
            ("other", "other-account"),
            ("first", "account"),
            ("second", "account"),
        ]
        .into_iter()
        .map(|(id, key)| {
            let mut line = Provider::with_id(
                id.into(),
                id.into(),
                serde_json::json!({"auth": {}, "config": ""}),
                None,
            );
            line.category = Some("official".into());
            codex_accounts::set_pin(&mut line, Some(key));
            line
        })
        .collect()
    }

    #[test]
    fn shared_account_prefers_current_line_even_when_it_is_second() {
        let lines = lines();
        for current_id in ["second", "first"] {
            let line = official_account_line(&lines, "account", Some(current_id)).unwrap();
            assert_eq!(line.id, current_id);
        }
    }

    #[test]
    fn shared_account_falls_back_to_first_matching_line() {
        let lines = lines();
        for current_id in [None, Some("other"), Some("missing")] {
            let line = official_account_line(&lines, "account", current_id).unwrap();
            assert_eq!(line.id, "first");
        }
        assert!(official_account_line(&lines, "missing-account", Some("second")).is_none());
    }
}

#[cfg(test)]
mod notes_contract_tests {
    use super::*;
    #[test]
    fn notes_table_rejects_unknown_targets() {
        assert!(parse_notes_table("providers").is_err());
        assert!(parse_notes_table("").is_err());
        assert_eq!(
            parse_notes_table("skills").unwrap(),
            crate::database::NotesTable::Skills
        );
        assert_eq!(
            parse_notes_table("mcp_servers").unwrap(),
            crate::database::NotesTable::McpServers
        );
    }
}

#[cfg(test)]
mod audit_b09_tests {
    use super::*;
    use crate::{database::Database, provider::Provider};
    use std::cell::Cell;

    fn fixture() -> Database {
        let db = Database::memory().unwrap();
        for id in ["audit-first", "audit-second"] {
            let mut line = Provider::with_id(
                id.into(),
                id.into(),
                serde_json::json!({"auth": {}, "config": ""}),
                None,
            );
            line.category = Some("official".into());
            codex_accounts::set_pin(&mut line, Some("audit-account"));
            db.save_provider_with_account_pin(&codex_accounts::account_mutation().unwrap(), &line)
                .unwrap();
        }
        db
    }

    #[test]
    fn second_detach_failure_retains_credentials_and_retry_completes() {
        let db = fixture();
        // Reject whichever write happens second, independent of provider ordering.
        db.conn.lock().unwrap().execute_batch(
            "CREATE TABLE audit_writes (n INTEGER); INSERT INTO audit_writes VALUES (0);
             CREATE TRIGGER audit_count AFTER UPDATE ON providers BEGIN UPDATE audit_writes SET n = n + 1; END;
             CREATE TRIGGER audit_reject BEFORE UPDATE ON providers WHEN (SELECT n FROM audit_writes) >= 1
             BEGIN SELECT RAISE(ABORT, 'injected second detach failure'); END;"
        ).unwrap();
        let removed = Cell::new(false);
        let result = remove_official_account_from(&db, "audit-account", || {
            removed.set(true);
            Ok(())
        });
        assert!(result.unwrap_err().to_string().contains("Account retained"));
        assert!(!removed.get());
        assert_eq!(
            codex_accounts::official_lines(&db)
                .unwrap()
                .iter()
                .filter(|line| line.official_account_key() == Some("audit-account"))
                .count(),
            1
        );
        db.conn
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER audit_reject;")
            .unwrap();
        remove_official_account_from(&db, "audit-account", || {
            removed.set(true);
            Ok(())
        })
        .unwrap();
        assert!(removed.get());
        assert!(codex_accounts::official_lines(&db)
            .unwrap()
            .iter()
            .all(|line| line.official_account_key().is_none()));
    }

    #[test]
    fn vault_failure_is_explicit_and_retryable_after_detach() {
        let db = fixture();
        let result = remove_official_account_from(&db, "audit-account", || {
            Err(AppError::Message("injected Vault failure".into()))
        });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("credential removal is incomplete"));
        assert!(codex_accounts::official_lines(&db)
            .unwrap()
            .iter()
            .all(|line| line.official_account_key().is_none()));
        remove_official_account_from(&db, "audit-account", || Ok(())).unwrap();
    }
}

#[cfg(test)]
mod audit_b05_tests {
    use super::*;
    use crate::codex_accounts::identity::test_support::{chatgpt_login, identity};
    use crate::codex_accounts::test_support::Fixture;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn deletion_serializes_live_save_and_cli_registration_through_vault_removal() {
        for cli in [false, true] {
            let fx = Fixture::new();
            let account = identity("b05");
            let auth = chatgpt_login("b05", "2020-01-01T00:00:00Z");
            let key = account.key();
            fx.write_live(&auth);
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
            let live_before = fx.live_bytes();
            let (detached_tx, detached_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let (started_tx, started_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();
            std::thread::scope(|scope| {
                let fx = &fx;
                let key = &key;
                let removal = scope.spawn(move || {
                    remove_official_account_from(&fx.db, key, move || {
                        detached_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        fx.vault.remove_account(key)
                    })
                });
                detached_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                let account = &account;
                let auth = &auth;
                let writer = scope.spawn(move || {
                    started_tx.send(()).unwrap();
                    let result = if cli {
                        codex_accounts::register_cli_login(
                            &fx.db,
                            &fx.vault,
                            &fx.codex_dir(),
                            account,
                            auth,
                        )
                    } else {
                        codex_accounts::save_current_login(&fx.db, &fx.vault, &fx.codex_dir(), None)
                    };
                    done_tx.send(result).unwrap();
                });
                started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                let early = done_rx.recv_timeout(Duration::from_millis(100));
                // Always unblock deletion before asserting, including on regression.
                release_tx.send(()).unwrap();
                removal.join().unwrap().unwrap();
                writer.join().unwrap();
                assert!(matches!(early, Err(mpsc::RecvTimeoutError::Timeout)));
                assert_eq!(&done_rx.recv().unwrap().unwrap(), key);
            });
            assert_eq!(fx.vault.read_slot(&key).unwrap().unwrap().auth, auth);
            assert_eq!(
                codex_accounts::official_lines(&fx.db)
                    .unwrap()
                    .iter()
                    .filter(|line| line.official_account_key() == Some(key.as_str()))
                    .count(),
                1
            );
            assert_eq!(fx.live_bytes(), live_before);
            // The opposite serial order ends with neither a slot nor a binding.
            remove_official_account_from(&fx.db, &key, || fx.vault.remove_account(&key)).unwrap();
            assert!(fx.vault.read_slot(&key).unwrap().is_none());
            assert!(codex_accounts::official_lines(&fx.db)
                .unwrap()
                .iter()
                .all(|line| line.official_account_key().is_none()));
            assert_eq!(fx.live_bytes(), live_before);
        }
    }

    #[test]
    fn stale_provider_writes_during_and_after_deletion_cannot_restore_the_pin() {
        let fx = Fixture::new();
        let account = identity("stale-edit");
        let auth = chatgpt_login("stale-edit", "2020-01-01T00:00:00Z");
        let key =
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
        let mut stale = codex_accounts::official_lines(&fx.db).unwrap().remove(0);
        stale.name = "edited while removing".into();
        remove_official_account_from(&fx.db, &key, || {
            // Same primitive used by provider updates/backfill/rollback, after
            // detachment but before the vault unlink. It must not re-lock accounts.
            fx.db.save_provider("codex", &stale)?;
            assert!(fx.line(&stale.id).official_account_key().is_none());
            fx.vault.remove_account(&key)
        })
        .unwrap();
        fx.db.save_provider("codex", &stale).unwrap();
        assert_eq!(fx.line(&stale.id).name, stale.name);
        assert!(fx.line(&stale.id).official_account_key().is_none());
        assert!(fx.vault.read_slot(&key).unwrap().is_none());

        // Caller-owned transactions (bulk import) must obey the same rule.
        let mut conn = fx.db.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        crate::database::Database::save_provider_on_connection(&tx, "codex", &stale).unwrap();
        stale.id = "copied-stale-line".into();
        crate::database::Database::save_provider_on_connection(&tx, "codex", &stale).unwrap();
        tx.commit().unwrap();
        drop(conn);
        assert!(codex_accounts::official_lines(&fx.db)
            .unwrap()
            .iter()
            .all(|line| line.official_account_key().is_none()));
    }

    #[test]
    fn generic_writes_preserve_the_current_pin_but_cannot_import_one() {
        let fx = Fixture::new();
        let account = identity("current-pin");
        let auth = chatgpt_login("current-pin", "2020-01-01T00:00:00Z");
        let key =
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
        let mut edited = codex_accounts::official_lines(&fx.db).unwrap().remove(0);
        for pin in [None, Some("forged-key")] {
            codex_accounts::set_pin(&mut edited, pin);
            fx.db.save_provider("codex", &edited).unwrap();
            assert_eq!(
                fx.line(&edited.id).official_account_key(),
                Some(key.as_str())
            );
        }
        let mut copy = edited.clone();
        copy.id = "copied-line".into();
        fx.db.save_provider("codex", &copy).unwrap();
        assert!(fx.line(&copy.id).official_account_key().is_none());
        // Changing category cannot hide a bound row from official-account deletion.
        edited.category = Some("custom".into());
        fx.db.save_provider("codex", &edited).unwrap();
        assert!(fx.line(&edited.id).official_account_key().is_none());
        remove_official_account_from(&fx.db, &key, || fx.vault.remove_account(&key)).unwrap();
        assert!(fx.vault.read_slot(&key).unwrap().is_none());
    }

    #[test]
    fn switch_backfill_waits_for_deletion_and_cannot_recreate_a_slot_or_pin() {
        let fx = Fixture::new();
        let account = identity("backfill");
        let auth = chatgpt_login("backfill", "2020-01-01T00:00:00Z");
        let key =
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
        let stale = codex_accounts::official_lines(&fx.db).unwrap().remove(0);
        let (detached_tx, detached_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            let fx = &fx;
            let key = &key;
            let removal = scope.spawn(move || {
                remove_official_account_from(&fx.db, key, move || {
                    detached_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    fx.vault.remove_account(key)
                })
            });
            detached_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            let account = &account;
            let auth = &auth;
            let stale = &stale;
            let backfill = scope.spawn(move || {
                started_tx.send(()).unwrap();
                let result = fx
                    .vault
                    .refresh_existing_slot(account, auth)
                    .and_then(|()| fx.db.save_provider("codex", stale));
                done_tx.send(result).unwrap();
            });
            started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            let early = done_rx.recv_timeout(Duration::from_millis(100));
            release_tx.send(()).unwrap();
            removal.join().unwrap().unwrap();
            backfill.join().unwrap();
            assert!(matches!(early, Err(mpsc::RecvTimeoutError::Timeout)));
            done_rx.recv().unwrap().unwrap();
        });
        assert!(fx.vault.read_slot(&key).unwrap().is_none());
        assert!(fx.line(&stale.id).official_account_key().is_none());
    }

    #[test]
    fn backfill_refreshes_existing_credentials_but_preserves_tombstones() {
        let fx = Fixture::new();
        let account = identity("rotation");
        let auth = chatgpt_login("rotation", "2020-01-01T00:00:00Z");
        let newer = chatgpt_login("rotation", "2020-01-02T00:00:00Z");
        let key =
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
        fx.vault.refresh_existing_slot(&account, &newer).unwrap();
        assert_eq!(fx.vault.read_slot(&key).unwrap().unwrap().auth, newer);
        fx.vault.set_tombstone(&key).unwrap();
        fx.vault.refresh_existing_slot(&account, &newer).unwrap();
        assert!(fx.vault.has_tombstone(&key));
        remove_official_account_from(&fx.db, &key, || fx.vault.remove_account(&key)).unwrap();
        fx.vault.refresh_existing_slot(&account, &newer).unwrap();
        assert!(fx.vault.read_slot(&key).unwrap().is_none());
    }

    #[test]
    fn database_snapshot_replacement_keeps_only_current_local_bindings() {
        let fx = Fixture::new();
        let account = identity("snapshot");
        let auth = chatgpt_login("snapshot", "2020-01-01T00:00:00Z");
        let key =
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
        let line = codex_accounts::official_lines(&fx.db).unwrap().remove(0);
        // Snapshot contains a formerly valid pin and another machine's line.
        let staged = fx.db.snapshot_to_memory().unwrap();
        let mut remote = line.clone();
        remote.id = "remote-only".into();
        crate::database::Database::save_provider_on_connection(&staged, "codex", &remote).unwrap();
        staged
            .execute(
                "UPDATE providers SET meta = ?1 WHERE id = ?2",
                rusqlite::params![serde_json::to_string(&line.meta).unwrap(), remote.id],
            )
            .unwrap();
        {
            let local = fx.db.conn.lock().unwrap();
            crate::database::Database::preserve_local_account_pins_on_connection(&local, &staged)
                .unwrap();
            let lines =
                crate::database::Database::get_all_providers_on_connection(&staged, "codex")
                    .unwrap();
            assert_eq!(lines[&line.id].official_account_key(), Some(key.as_str()));
            assert!(lines[&remote.id].official_account_key().is_none());
        }
        remove_official_account_from(&fx.db, &key, || fx.vault.remove_account(&key)).unwrap();
        {
            let mut local = fx.db.conn.lock().unwrap();
            crate::database::Database::preserve_local_account_pins_on_connection(&local, &staged)
                .unwrap();
            let backup = rusqlite::backup::Backup::new(&staged, &mut local).unwrap();
            backup.step(-1).unwrap();
        }
        assert!(codex_accounts::official_lines(&fx.db)
            .unwrap()
            .iter()
            .all(|line| line.official_account_key().is_none()));
        assert!(fx.vault.read_slot(&key).unwrap().is_none());

        // A damaged local catalog must not disable backup recovery or cause
        // recovery to trust an old pin from the backup instead.
        staged
            .execute(
                "UPDATE providers SET meta = ?1 WHERE id = ?2",
                rusqlite::params![serde_json::to_string(&line.meta).unwrap(), line.id],
            )
            .unwrap();
        let local = fx.db.conn.lock().unwrap();
        local
            .execute(
                "UPDATE providers SET meta = 'invalid-json' WHERE id = ?1",
                rusqlite::params![line.id],
            )
            .unwrap();
        crate::database::Database::preserve_local_account_pins_on_connection(&local, &staged)
            .unwrap();
        let lines =
            crate::database::Database::get_all_providers_on_connection(&staged, "codex").unwrap();
        assert!(lines[&line.id].official_account_key().is_none());
    }
}
