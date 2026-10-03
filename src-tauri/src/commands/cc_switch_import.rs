//! Preview and selected-only import of legacy cc-switch provider managers.
//! This is NOT SQL restore and never activates a provider or executes metadata.
use crate::{app_config::AppType, provider::Provider, services::ProviderService, store::AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::Read,
    time::{Duration, Instant},
};
use tauri::State;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ROWS: usize = 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInventoryRow {
    app: String,
    source_id: String,
    name: String,
    status: &'static str,
    reason: &'static str,
    existing_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInventory {
    rows: Vec<ImportInventoryRow>,
    writes_live: bool,
    can_commit: bool,
    preview_id: Option<String>,
}

fn inventory(
    root: &Value,
    existing: &HashMap<String, Vec<Provider>>,
) -> Result<ImportInventory, String> {
    let root = root.as_object().ok_or("INVALID_CC_SWITCH_JSON")?;
    let mut rows = Vec::new();
    let mut managers = HashSet::new();
    // Ignore MCP, skills, prompts and common snippets: this action imports lines only.
    for (app_id, manager) in root {
        let Some(providers) = manager.get("providers") else {
            continue;
        };
        let providers = providers.as_object().ok_or("INVALID_PROVIDER_MANAGER")?;
        let app = AppType::parse_id(app_id).ok();
        let canonical_app = app.as_ref().map(AppType::as_str).unwrap_or(app_id);
        if !managers.insert(canonical_app.to_string()) {
            return Err("DUPLICATE_PROVIDER_MANAGER".into());
        }
        let mut incoming_names = HashMap::<String, usize>::new();
        for raw in providers.values() {
            if let Some(name) = raw.get("name").and_then(Value::as_str) {
                *incoming_names
                    .entry(name.trim().to_lowercase())
                    .or_default() += 1;
            }
        }
        for (source_id, raw) in providers {
            if rows.len() >= MAX_ROWS {
                return Err("TOO_MANY_IMPORT_ROWS".into());
            }
            let mut row = ImportInventoryRow {
                app: canonical_app.to_string(),
                source_id: source_id.clone(),
                name: raw
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("未命名线路")
                    .to_string(),
                status: "unsupported",
                reason: "配置格式不支持",
                existing_ids: Vec::new(),
            };
            let mut value = raw.clone();
            if let Some(object) = value.as_object_mut() {
                // The manager key is authoritative, not a possibly stale embedded id.
                object.insert("id".into(), Value::String(source_id.clone()));
            }
            if let (Some(app), Ok(provider)) =
                (app.as_ref(), serde_json::from_value::<Provider>(value))
            {
                let auth = provider.settings_config.get("auth");
                let auth_tokens = auth
                    .and_then(Value::as_object)
                    .is_some_and(|auth| auth.keys().any(|key| key != "OPENAI_API_KEY"));
                let external_auth = provider
                    .meta
                    .as_ref()
                    .and_then(|meta| meta.provider_type.as_deref());
                if provider.name.trim().is_empty() || source_id.trim().is_empty() {
                    row.reason = "线路名称或标识为空";
                } else if crate::product_policy::require_app(app).is_err() {
                    row.reason = "目标工具尚未开放";
                } else if provider.category.as_deref() == Some("official")
                    || auth_tokens
                    || external_auth.is_some()
                    || provider.uses_managed_account_auth()
                    || provider.official_account_key().is_some()
                    || provider.meta.as_ref().is_some_and(|meta| {
                        meta.usage_script.is_some()
                            || meta.auth_binding.as_ref().is_some_and(|binding| {
                                matches!(
                                    binding.source,
                                    crate::provider::AuthBindingSource::ManagedAccount
                                ) || binding.account_id.is_some()
                                    || binding.auth_provider.is_some()
                            })
                    })
                {
                    row.reason = "官方登录、专用认证或可执行脚本不支持迁移";
                } else if ProviderService::validate_provider_settings(app, &provider).is_err() {
                    row.reason = "供应商配置校验失败";
                } else {
                    let matches: Vec<&Provider> = existing
                        .get(canonical_app)
                        .into_iter()
                        .flatten()
                        .filter(|stored| {
                            stored.id == provider.id
                                || stored.name.trim().to_lowercase()
                                    == provider.name.trim().to_lowercase()
                        })
                        .collect();
                    row.existing_ids = matches.iter().map(|stored| stored.id.clone()).collect();
                    if incoming_names
                        .get(&provider.name.trim().to_lowercase())
                        .copied()
                        .unwrap_or(0)
                        > 1
                    {
                        row.status = "conflict";
                        row.reason = "源文件包含同名线路，需要逐项确认";
                    } else if matches.is_empty() {
                        row.status = "new";
                        row.reason = "可作为新线路导入，不自动启用";
                    } else if matches.len() == 1
                        && matches[0].settings_config == provider.settings_config
                        && serde_json::to_value(matches[0].meta.clone().unwrap_or_default()).ok()
                            == serde_json::to_value(provider.meta.clone().unwrap_or_default()).ok()
                    {
                        row.status = "identical";
                        row.reason = "配置与元数据相同，跳过";
                    } else {
                        row.status = "conflict";
                        row.reason = "同名或同标识线路存在差异，默认保留现有";
                    }
                }
            }
            rows.push(row);
        }
    }
    if rows.is_empty() {
        return Err("NO_PROVIDER_MANAGERS".into());
    }
    Ok(ImportInventory {
        rows,
        writes_live: false,
        can_commit: false,
        preview_id: None,
    })
}

/// One bounded, short-lived server-side preview per application instance.
/// Credentials never leave the backend; the client receives only a random handle.
pub struct CcSwitchPreviewSession {
    id: String,
    path: String,
    source_digest: Vec<u8>,
    existing: HashMap<String, Vec<Provider>>,
    created: Instant,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportSelection {
    app: String,
    source_id: String,
    replace_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReceipt {
    imported: usize,
    backup_id: String,
    writes_live: bool,
}

fn read_source(path: &str) -> Result<(Value, Vec<u8>), String> {
    let file = File::open(path).map_err(|_| "IMPORT_FILE_UNREADABLE")?;
    let metadata = file.metadata().map_err(|_| "IMPORT_FILE_UNREADABLE")?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err("IMPORT_FILE_TOO_LARGE_OR_NOT_REGULAR".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "IMPORT_FILE_UNREADABLE")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("IMPORT_FILE_TOO_LARGE".into());
    }
    let root = serde_json::from_slice(&bytes).map_err(|_| "INVALID_CC_SWITCH_JSON")?;
    Ok((root, Sha256::digest(&bytes).to_vec()))
}

fn existing_on_connection(
    conn: &rusqlite::Connection,
    root: &Value,
) -> Result<HashMap<String, Vec<Provider>>, String> {
    let mut existing = HashMap::new();
    if let Some(object) = root.as_object() {
        for key in object.keys() {
            if let Ok(app) = AppType::parse_id(key) {
                if crate::product_policy::require_app(&app).is_ok() {
                    let providers = crate::database::Database::get_all_providers_on_connection(
                        conn,
                        app.as_str(),
                    )
                    .map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
                    existing.insert(app.as_str().to_string(), providers.into_values().collect());
                }
            }
        }
    }
    Ok(existing)
}

fn plan_import(
    root: &Value,
    existing: &HashMap<String, Vec<Provider>>,
    selections: &[ImportSelection],
) -> Result<Vec<(String, Provider)>, String> {
    if selections.is_empty() || selections.len() > MAX_ROWS {
        return Err("INVALID_IMPORT_SELECTION".into());
    }
    let inventory = inventory(root, existing)?;
    let mut seen_sources = HashSet::new();
    let mut seen_targets = HashSet::new();
    let mut plan = Vec::new();
    for choice in selections {
        if !seen_sources.insert((&choice.app, &choice.source_id)) {
            return Err("DUPLICATE_IMPORT_SELECTION".into());
        }
        let row = inventory
            .rows
            .iter()
            .find(|row| row.app == choice.app && row.source_id == choice.source_id)
            .ok_or("INVALID_IMPORT_SELECTION")?;
        let target = match (row.status, choice.replace_id.as_ref()) {
            ("new", None) => &row.source_id,
            ("conflict", Some(id)) if row.existing_ids.len() == 1 && &row.existing_ids[0] == id => {
                id
            }
            _ => return Err("INVALID_IMPORT_SELECTION".into()),
        };
        if !seen_targets.insert((row.app.clone(), target.clone())) {
            return Err("DUPLICATE_IMPORT_TARGET".into());
        }
        let manager = root
            .as_object()
            .and_then(|root| {
                root.iter().find(|(key, _)| {
                    AppType::parse_id(key).is_ok_and(|app| app.as_str() == row.app)
                })
            })
            .map(|(_, manager)| manager)
            .ok_or("INVALID_IMPORT_SELECTION")?;
        let mut raw = manager["providers"][&row.source_id].clone();
        raw.as_object_mut()
            .ok_or("INVALID_IMPORT_SELECTION")?
            .insert("id".into(), Value::String(target.clone()));
        let mut provider: Provider =
            serde_json::from_value(raw).map_err(|_| "INVALID_IMPORT_SELECTION")?;
        // Imported records must never enroll themselves in failover or activate Live.
        provider.in_failover_queue = false;
        if let Some(stored) = existing
            .get(&row.app)
            .into_iter()
            .flatten()
            .find(|p| &p.id == target)
        {
            if stored.category.as_deref() == Some("official")
                || stored.uses_managed_account_auth()
                || stored.official_account_key().is_some()
                || stored.in_failover_queue
            {
                return Err("IMPORT_TARGET_PROTECTED".into());
            }
            provider.created_at = stored.created_at;
            provider.sort_index = stored.sort_index;
        }
        plan.push((row.app.clone(), provider));
    }
    Ok(plan)
}

#[tauri::command]
pub async fn preview_cc_switch_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<ImportInventory, String> {
    crate::product_policy::require(crate::product_policy::Capability::Providers)
        .map_err(|_| "IMPORT_PREVIEW_UNAVAILABLE")?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<ImportInventory, String> {
        // A new file invalidates the old handle, including failed previews.
        let mut session = state
            .cc_switch_preview
            .lock()
            .map_err(|_| "IMPORT_PREVIEW_FAILED")?;
        *session = None;
        let (root, source_digest) = read_source(&path)?;
        let conn = state
            .db
            .conn
            .lock()
            .map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
        let existing = existing_on_connection(&conn, &root)?;
        let mut result = inventory(&root, &existing)?;
        let id = uuid::Uuid::new_v4().to_string();
        result.preview_id = Some(id.clone());
        result.can_commit = crate::product_policy::Capability::CcSwitchImport.enabled();
        *session = Some(CcSwitchPreviewSession {
            id,
            path,
            source_digest,
            existing,
            created: Instant::now(),
        });
        Ok(result)
    })
    .await
    .map_err(|_| "IMPORT_PREVIEW_FAILED".to_string())?
}

#[tauri::command]
pub async fn commit_cc_switch_import(
    state: State<'_, AppState>,
    preview_id: String,
    selections: Vec<ImportSelection>,
) -> Result<ImportReceipt, String> {
    crate::product_policy::require(crate::product_policy::Capability::CcSwitchImport)
        .map_err(|_| "IMPORT_COMMIT_UNAVAILABLE")?;
    let state = state.inner().clone();
    let guard = state.profile_apply_lock.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || -> Result<ImportReceipt, String> {
        let _guard = guard;
        let mut slot = state.cc_switch_preview.lock().map_err(|_| "IMPORT_PREVIEW_FAILED")?;
        let preview = slot.as_ref().filter(|p| p.id == preview_id).ok_or("IMPORT_PREVIEW_EXPIRED")?;
        if preview.created.elapsed() > Duration::from_secs(15 * 60) {
            *slot = None;
            return Err("IMPORT_PREVIEW_EXPIRED".into());
        }
        // Consume once before IO; a failed or stale commit must be previewed again.
        let preview = slot.take().ok_or("IMPORT_PREVIEW_EXPIRED")?;
        let (root, digest) = read_source(&preview.path)?;
        if digest != preview.source_digest { return Err("IMPORT_SOURCE_CHANGED".into()); }
        let mut conn = state.db.conn.lock().map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
        let data_version: i64 = conn.query_row("PRAGMA data_version", [], |row| row.get(0))
            .map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
        let snapshot = crate::database::Database::snapshot_connection_to_memory(&conn)
            .map_err(|_| "IMPORT_BACKUP_FAILED")?;
        let tx = import_transaction(&mut conn, data_version)?;
        let existing = existing_on_connection(&tx, &root)?;
        if serde_json::to_value(&existing).map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?
            != serde_json::to_value(&preview.existing).map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")? {
            return Err("IMPORT_DATABASE_CHANGED".into());
        }
        let plan = plan_import(&root, &existing, &selections)?;
        for (app, provider) in &plan {
            let active: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM providers WHERE app_type = ?1 AND id = ?2 AND (is_current = 1 OR in_failover_queue = 1))",
                rusqlite::params![app, provider.id], |row| row.get(0),
            ).map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
            let app_type = AppType::parse_id(app).map_err(|_| "INVALID_IMPORT_SELECTION")?;
            if active || crate::settings::get_current_provider(&app_type).as_deref() == Some(provider.id.as_str()) {
                return Err("IMPORT_TARGET_ACTIVE".into());
            }
        }
        let backup = crate::database::Database::backup_database_snapshot(&snapshot)
            .map_err(|_| "IMPORT_BACKUP_FAILED")?.ok_or("IMPORT_BACKUP_FAILED")?;
        let backup_id = backup.file_name().and_then(|n| n.to_str()).ok_or("IMPORT_BACKUP_FAILED")?.to_string();
        apply_plan(&tx, &plan)?;
        tx.commit().map_err(|_| "IMPORT_COMMIT_FAILED")?;
        Ok(ImportReceipt { imported: plan.len(), backup_id, writes_live: false })
    }).await.map_err(|_| "IMPORT_COMMIT_FAILED".to_string())?
}

// Compare on the same connection after acquiring the writer lock. An external
// commit during backup would otherwise make the saved snapshot stale.
fn import_transaction(
    conn: &mut rusqlite::Connection,
    snapshot_version: i64,
) -> Result<rusqlite::Transaction<'_>, String> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
    let version: i64 = tx
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
    if version != snapshot_version {
        return Err("IMPORT_DATABASE_CHANGED".into());
    }
    Ok(tx)
}

fn apply_plan(conn: &rusqlite::Connection, plan: &[(String, Provider)]) -> Result<(), String> {
    for (app, provider) in plan {
        // The shared save path deliberately preserves endpoints on normal edits.
        // An explicit import replacement replaces that metadata in the same transaction.
        conn.execute(
            "DELETE FROM provider_endpoints WHERE app_type = ?1 AND provider_id = ?2",
            rusqlite::params![app, provider.id],
        )
        .map_err(|_| "IMPORT_COMMIT_FAILED")?;
        let mut provider_without_endpoints = provider.clone();
        let endpoints = provider_without_endpoints
            .meta
            .as_mut()
            .map(|m| std::mem::take(&mut m.custom_endpoints))
            .unwrap_or_default();
        crate::database::Database::save_provider_on_connection(
            conn,
            app,
            &provider_without_endpoints,
        )
        .map_err(|_| "IMPORT_COMMIT_FAILED")?;
        for (url, endpoint) in endpoints {
            conn.execute("INSERT INTO provider_endpoints (provider_id, app_type, url, added_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![provider.id, app, url, endpoint.added_at]).map_err(|_| "IMPORT_COMMIT_FAILED")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider(name: &str, key: &str) -> Value {
        json!({"id":"source", "name":name, "settingsConfig":{"auth":{"OPENAI_API_KEY":key},"config":"model = \"test\""}})
    }

    #[test]
    fn classifies_all_four_states_without_returning_credentials() {
        let original = provider("same", "secret-original");
        let stored: Provider = serde_json::from_value(original.clone()).unwrap();
        let other: Provider =
            serde_json::from_value(provider("changed", "secret-existing")).unwrap();
        let mut root = json!({"codex":{"providers":{
            "new":provider("new", "secret-new"),
            "same":original,
            "changed":provider("changed", "secret-incoming"),
            "official":provider("official", "secret-official")
        }}});
        root["codex"]["providers"]["official"]["category"] = json!("official");
        let existing = HashMap::from([("codex".into(), vec![stored, other])]);
        let result = inventory(&root, &existing).unwrap();
        for (id, expected) in [
            ("new", "new"),
            ("same", "identical"),
            ("changed", "conflict"),
            ("official", "unsupported"),
        ] {
            assert_eq!(
                result
                    .rows
                    .iter()
                    .find(|row| row.source_id == id)
                    .unwrap()
                    .status,
                expected
            );
        }
        assert!(!serde_json::to_string(&result).unwrap().contains("secret-"));
        assert!(!result.writes_live);
        assert!(!result.can_commit);
    }

    #[test]
    fn refuses_non_manager_files_and_malformed_config() {
        assert!(inventory(&json!({"settings":{}}), &HashMap::new()).is_err());
        assert!(inventory(&json!({"codex":{"providers":[]}}), &HashMap::new()).is_err());
        let root = json!({"codex":{"providers":{"bad":{"name":"bad","settingsConfig":{}}}}});
        assert_eq!(
            inventory(&root, &HashMap::new()).unwrap().rows[0].status,
            "unsupported"
        );
    }

    #[test]
    fn rejects_oauth_and_unknown_tools_but_allows_supported_tools() {
        let mut oauth = provider("oauth", "");
        oauth["settingsConfig"]["auth"] = json!({"tokens":{"access_token":"private"}});
        let claude = json!({"id":"claude", "name":"Claude", "settingsConfig":{"env":{"ANTHROPIC_AUTH_TOKEN":"test-only-key", "ANTHROPIC_BASE_URL":"https://example.invalid"}}});
        let root = json!({"codex":{"providers":{"oauth":oauth}}, "claude":{"providers":{"claude":claude}}, "not-a-tool":{"providers":{"unknown":provider("Unknown", "")}}});
        let result = inventory(&root, &HashMap::new()).unwrap();
        for (source_id, expected) in [
            ("oauth", "unsupported"),
            ("claude", "new"),
            ("unknown", "unsupported"),
        ] {
            assert_eq!(
                result
                    .rows
                    .iter()
                    .find(|row| row.source_id == source_id)
                    .unwrap()
                    .status,
                expected
            );
        }
        let exported = serde_json::to_string(&result).unwrap();
        assert!(!exported.contains("private"));
        assert!(!exported.contains("test-only-key"));
    }
    #[test]
    fn treats_ambiguous_existing_names_as_conflicts() {
        let mut first: Provider = serde_json::from_value(provider("same", "key")).unwrap();
        first.id = "first".into();
        let mut second = first.clone();
        second.id = "second".into();
        let root = json!({"codex":{"providers":{"incoming":provider("same", "key")}}});
        let existing = HashMap::from([("codex".into(), vec![first, second])]);
        let result = inventory(&root, &existing).unwrap();
        assert_eq!(result.rows[0].status, "conflict");
        assert_eq!(result.rows[0].existing_ids.len(), 2);
    }

    #[test]
    fn rejects_alias_duplicates_and_overlarge_inventories() {
        let duplicate = json!({"codex":{"providers":{"a":provider("a", "key")}},"Codex":{"providers":{"b":provider("b", "key")}}});
        assert!(inventory(&duplicate, &HashMap::new()).is_err());
        let mut providers = serde_json::Map::new();
        for index in 0..=MAX_ROWS {
            providers.insert(index.to_string(), provider("line", "key"));
        }
        assert!(inventory(&json!({"codex":{"providers":providers}}), &HashMap::new()).is_err());
    }
    #[test]
    fn duplicate_source_names_are_not_offered_as_independent_new_lines() {
        let root = json!({"codex":{"providers":{"a":provider("Same", "one"), "b":provider(" same ", "two")}}});
        let result = inventory(&root, &HashMap::new()).unwrap();
        assert!(result.rows.iter().all(|row| row.status == "conflict"));
    }

    fn choice(source: &str, target: Option<&str>) -> ImportSelection {
        ImportSelection {
            app: "codex".into(),
            source_id: source.into(),
            replace_id: target.map(str::to_string),
        }
    }

    #[test]
    fn plan_preserves_local_identity_order_and_never_imports_failover() {
        let mut stored: Provider = serde_json::from_value(provider("same", "old")).unwrap();
        stored.id = "local".into();
        stored.created_at = Some(123);
        stored.sort_index = Some(4);
        let mut incoming = provider("same", "new");
        incoming["inFailoverQueue"] = json!(true);
        let root = json!({"codex":{"providers":{"incoming":incoming}}});
        let existing = HashMap::from([("codex".into(), vec![stored])]);
        assert!(plan_import(&root, &existing, &[choice("incoming", None)]).is_err());
        assert!(plan_import(&root, &existing, &[choice("incoming", Some("wrong"))]).is_err());
        let plan = plan_import(&root, &existing, &[choice("incoming", Some("local"))]).unwrap();
        assert_eq!(plan[0].1.id, "local");
        assert_eq!(plan[0].1.created_at, Some(123));
        assert_eq!(plan[0].1.sort_index, Some(4));
        assert!(!plan[0].1.in_failover_queue);
    }

    #[test]
    fn plan_rejects_duplicate_sources_targets_and_protected_replacements() {
        let root = json!({"codex":{"providers":{"a":provider("same", "one"),"b":provider("same", "two")}}});
        let mut stored: Provider = serde_json::from_value(provider("same", "old")).unwrap();
        stored.id = "local".into();
        let existing = HashMap::from([("codex".into(), vec![stored.clone()])]);
        assert_eq!(
            plan_import(
                &root,
                &existing,
                &[choice("a", Some("local")), choice("a", Some("local"))]
            )
            .unwrap_err(),
            "DUPLICATE_IMPORT_SELECTION"
        );
        assert_eq!(
            plan_import(
                &root,
                &existing,
                &[choice("a", Some("local")), choice("b", Some("local"))]
            )
            .unwrap_err(),
            "DUPLICATE_IMPORT_TARGET"
        );
        stored.in_failover_queue = true;
        let protected = HashMap::from([("codex".into(), vec![stored])]);
        assert_eq!(
            plan_import(&root, &protected, &[choice("a", Some("local"))]).unwrap_err(),
            "IMPORT_TARGET_PROTECTED"
        );
    }

    #[test]
    fn rejects_executable_metadata_even_when_script_is_disabled() {
        let mut incoming = provider("script", "key");
        incoming["meta"] = json!({"usage_script":{"enabled":false,"language":"javascript","code":"throw new Error('not executable')"}});
        let root = json!({"codex":{"providers":{"script":incoming}}});
        assert_eq!(
            inventory(&root, &HashMap::new()).unwrap().rows[0].status,
            "unsupported"
        );
        assert!(plan_import(&root, &HashMap::new(), &[choice("script", None)]).is_err());
    }

    #[test]
    fn failed_batch_rolls_back_provider_and_endpoint_replacement() {
        let db = crate::database::Database::memory().unwrap();
        let mut original: Provider = serde_json::from_value(provider("original", "old")).unwrap();
        original.id = "first".into();
        db.save_provider("codex", &original).unwrap();
        let mut conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO provider_endpoints (provider_id, app_type, url, added_at) VALUES ('first','codex','https://old.example',1)", []).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_second BEFORE INSERT ON providers WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        let mut replacement = original.clone();
        replacement.name = "replacement".into();
        let mut second = original.clone();
        second.id = "second".into();
        {
            let tx = conn.transaction().unwrap();
            assert!(apply_plan(
                &tx,
                &[("codex".into(), replacement), ("codex".into(), second)]
            )
            .is_err());
        }
        let providers =
            crate::database::Database::get_all_providers_on_connection(&conn, "codex").unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers["first"].name, "original");
        let endpoint: String = conn
            .query_row(
                "SELECT url FROM provider_endpoints WHERE provider_id = 'first'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(endpoint, "https://old.example");
    }

    #[test]
    fn successful_batch_persists_endpoints_without_activating_new_lines() {
        let db = crate::database::Database::memory().unwrap();
        let mut value = provider("new", "key");
        value["meta"] = json!({"custom_endpoints":{"https://new.example":{"url":"https://new.example","addedAt":123}}});
        let root = json!({"codex":{"providers":{"new":value}}});
        let plan = plan_import(&root, &HashMap::new(), &[choice("new", None)]).unwrap();
        let mut conn = db.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        apply_plan(&tx, &plan).unwrap();
        tx.commit().unwrap();
        let flags: (bool, bool) = conn
            .query_row(
                "SELECT is_current, in_failover_queue FROM providers WHERE id = 'new'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(flags, (false, false));
        let endpoint: (String, i64) = conn
            .query_row(
                "SELECT url, added_at FROM provider_endpoints WHERE provider_id = 'new'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(endpoint, ("https://new.example".into(), 123));
    }

    #[test]
    fn rejects_snapshot_invalidated_by_another_connection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("import.db");
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE sample(value INTEGER);")
            .unwrap();
        let version: i64 = conn
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .unwrap();
        let snapshot = crate::database::Database::snapshot_connection_to_memory(&conn).unwrap();
        let writer = rusqlite::Connection::open(&path).unwrap();
        writer.execute("INSERT INTO sample VALUES (1)", []).unwrap();
        assert!(
            matches!(import_transaction(&mut conn, version), Err(code) if code == "IMPORT_DATABASE_CHANGED")
        );
        assert!(conn.is_autocommit());
        let count: i64 = snapshot
            .query_row("SELECT COUNT(*) FROM sample", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let current: i64 = conn
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .unwrap();
        import_transaction(&mut conn, current)
            .unwrap()
            .commit()
            .unwrap();
    }

    #[test]
    fn incomplete_snapshot_is_not_reported_as_a_successful_backup() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sample(value INTEGER); BEGIN IMMEDIATE; INSERT INTO sample VALUES (1);",
        )
        .unwrap();
        assert!(crate::database::Database::snapshot_connection_to_memory(&conn).is_err());
        conn.execute_batch("ROLLBACK;").unwrap();
        assert!(crate::database::Database::snapshot_connection_to_memory(&conn).is_ok());
    }
}
