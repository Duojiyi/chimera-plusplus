//! Preview and selected-only import of legacy cc-switch provider managers
//! (`config.json`). This is NOT SQL restore: an import never activates a
//! line, never writes a live config file and never executes metadata.

use crate::app_config::AppType;
use crate::database::Database;
use crate::provider::{AuthBindingSource, Provider};
use crate::services::ProviderService;
use crate::store::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::time::{Duration, Instant};

const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ROWS: usize = 1000;
/// A preview older than this must be read again before it can be imported.
const PREVIEW_TTL: Duration = Duration::from_secs(15 * 60);

/// Local lines per canonical app id, in display order.
type Lines = HashMap<String, Vec<Provider>>;
/// `(app, value)` pairs: line ids or normalized names within one app.
type AppKeys = HashSet<(String, String)>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInventoryRow {
    app: String,
    source_id: String,
    name: String,
    status: &'static str,
    reason: &'static str,
    existing_ids: Vec<String>,
    /// A conflict with exactly one local line that is not current, enabled
    /// or otherwise protected. Only such a row may replace that line.
    replaceable: bool,
    /// Keys the import removes from this row. Names only, never values.
    sanitized_keys: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInventory {
    rows: Vec<ImportInventoryRow>,
    writes_live: bool,
    can_commit: bool,
    preview_id: Option<String>,
}

/// The user's decision for one previewed row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportAction {
    /// Store a new row as a new line.
    Import,
    /// Write nothing for this row; a local line stays as it is.
    Skip,
    /// Store a conflicting row as a new line under an unused name.
    Duplicate,
    /// Overwrite the one local line a replaceable conflict matches.
    Replace,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportSelection {
    app: String,
    source_id: String,
    action: ImportAction,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowResult {
    app: String,
    source_id: String,
    /// The stored name; a duplicate carries its new name.
    name: String,
    outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

/// Names, ids and counts only: a receipt never carries a credential.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReceipt {
    rows: Vec<ImportRowResult>,
    imported: usize,
    replaced: usize,
    skipped: usize,
    failed: usize,
    backup_name: String,
    sanitized_keys: Vec<String>,
}

/// One bounded, short-lived server-side preview per application instance.
/// Credentials never leave the backend: the client receives only a random
/// handle, bound here to the source path, the SHA-256 of its bytes and the
/// local lines it was classified against. A commit consumes it.
pub struct CcSwitchPreviewSession {
    id: String,
    path: String,
    source_digest: Vec<u8>,
    existing: Lines,
    created: Instant,
}

/// A classified row plus, for a new or conflicting row, the line as it
/// would be stored.
struct Classified {
    row: ImportInventoryRow,
    prepared: Option<Provider>,
}

/// Validated writes and the per-row outcome of a commit.
struct ImportPlan {
    writes: Vec<(String, Provider)>,
    rows: Vec<ImportRowResult>,
    sanitized_keys: Vec<String>,
}

impl ImportPlan {
    fn into_receipt(self, backup_name: String) -> ImportReceipt {
        let count = |outcome: &str| self.rows.iter().filter(|r| r.outcome == outcome).count();
        let (imported, replaced, skipped, failed) = (
            count("imported"),
            count("replaced"),
            count("skipped"),
            count("failed"),
        );
        ImportReceipt {
            rows: self.rows,
            imported,
            replaced,
            skipped,
            failed,
            backup_name,
            sanitized_keys: self.sanitized_keys,
        }
    }
}

fn normalized_name(name: &str) -> String {
    name.trim().to_lowercase()
}

fn unsupported_reason(app: &AppType, provider: &Provider) -> Option<&'static str> {
    if provider.name.trim().is_empty() || provider.id.trim().is_empty() {
        return Some("线路名称或标识为空");
    }
    if crate::product_policy::require_app(app).is_err() {
        return Some("目标工具尚未开放");
    }
    // Their membership lives in their own config files, which an import never writes.
    if matches!(app, AppType::Pi | AppType::Mcode) {
        return Some("该工具暂不支持从文件导入");
    }
    let auth_tokens = provider
        .settings_config
        .get("auth")
        .and_then(Value::as_object)
        .is_some_and(|auth| auth.keys().any(|key| key != "OPENAI_API_KEY"));
    let special_meta = provider.meta.as_ref().is_some_and(|meta| {
        meta.provider_type.is_some()
            || meta.usage_script.is_some()
            || meta.auth_binding.as_ref().is_some_and(|binding| {
                matches!(binding.source, AuthBindingSource::ManagedAccount)
                    || binding.account_id.is_some()
                    || binding.auth_provider.is_some()
            })
    });
    if provider.category.as_deref() == Some("official")
        || auth_tokens
        || special_meta
        || provider.uses_managed_account_auth()
        || provider.official_account_key().is_some()
    {
        return Some("官方登录、专用认证或可执行脚本不支持迁移");
    }
    None
}

/// The row as it would be stored: the normalization and MH-13b sanitation
/// every provider add applies (`ProviderService::add_inactive`), never
/// enabled. Returns the removed key names, or `None` when the row is not a
/// valid line.
fn prepare(app: &AppType, provider: &mut Provider) -> Option<Vec<String>> {
    provider.in_failover_queue = false;
    match app {
        AppType::Claude => {
            let mut settings = provider.settings_config.clone();
            if crate::services::provider::normalize_claude_models_in_value(&mut settings) {
                provider.settings_config = settings;
            }
        }
        AppType::Codex => {
            crate::proxy::providers::normalize_codex_provider_wire_api(provider);
        }
        _ => {}
    }
    ProviderService::validate_provider_settings(app, provider).ok()?;
    let mut removed = Vec::new();
    // MH-4: loader, TLS-trust, proxy and shell variables never travel with an
    // imported line, whichever tool would export them.
    if let Some(env) = provider
        .settings_config
        .get_mut("env")
        .and_then(Value::as_object_mut)
    {
        env.retain(|key, _| {
            let denied = crate::deeplink::env_allowlist::is_denied_env_key(key);
            if denied {
                removed.push(format!("env.{key}"));
            }
            !denied
        });
    }
    if matches!(app, AppType::Codex) {
        let config = provider
            .settings_config
            .get("config")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(config) = config {
            let official = provider.category.as_deref() == Some("official");
            let (clean, report) =
                crate::codex_key_ownership::sanitize_untrusted_codex_config(&config, official)
                    .ok()?;
            if !report.stripped.is_empty() {
                provider.settings_config["config"] = Value::String(clean);
                removed.extend(report.stripped);
            }
        }
    }
    if app.is_additive_mode() {
        // Additive tools treat a line without this flag as enabled.
        provider
            .meta
            .get_or_insert_with(Default::default)
            .live_config_managed = Some(false);
    }
    Some(removed)
}

/// Settings and metadata are equal, ignoring state that is not
/// configuration: additive membership and endpoint usage times.
fn same_content(stored: &Provider, incoming: &Provider) -> bool {
    if stored.settings_config != incoming.settings_config {
        return false;
    }
    match (comparable_meta(stored), comparable_meta(incoming)) {
        (Some(stored), Some(incoming)) => stored == incoming,
        _ => false,
    }
}

fn comparable_meta(provider: &Provider) -> Option<Value> {
    let mut meta = provider.meta.clone().unwrap_or_default();
    meta.live_config_managed = None;
    for (url, endpoint) in meta.custom_endpoints.iter_mut() {
        endpoint.url = url.clone();
        endpoint.last_used = None;
    }
    serde_json::to_value(meta).ok()
}

/// A local line an import must never overwrite: official or account-bound,
/// queued for failover, or, for an additive tool, possibly enabled.
fn is_protected(app: &AppType, stored: &Provider) -> bool {
    let membership = stored.meta.as_ref().and_then(|m| m.live_config_managed);
    stored.category.as_deref() == Some("official")
        || stored.uses_managed_account_auth()
        || stored.official_account_key().is_some()
        || stored.in_failover_queue
        || (app.is_additive_mode() && membership != Some(false))
}

fn classify_row(
    app: Option<&AppType>,
    canonical_app: &str,
    source_id: &str,
    raw: &Value,
    stored: &[Provider],
    incoming_names: &HashMap<String, usize>,
) -> Classified {
    let mut row = ImportInventoryRow {
        app: canonical_app.to_string(),
        source_id: source_id.to_string(),
        name: raw
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("未命名线路")
            .to_string(),
        status: "unsupported",
        reason: "配置格式不支持",
        existing_ids: Vec::new(),
        replaceable: false,
        sanitized_keys: Vec::new(),
    };
    let mut value = raw.clone();
    if let Some(object) = value.as_object_mut() {
        // The manager key is authoritative, not a possibly stale embedded id.
        object.insert("id".into(), Value::String(source_id.to_string()));
    }
    let (Some(app), Ok(mut provider)) = (app, serde_json::from_value::<Provider>(value)) else {
        return Classified {
            row,
            prepared: None,
        };
    };
    if let Some(reason) = unsupported_reason(app, &provider) {
        row.reason = reason;
        return Classified {
            row,
            prepared: None,
        };
    }
    let Some(sanitized_keys) = prepare(app, &mut provider) else {
        row.reason = "供应商配置校验失败";
        return Classified {
            row,
            prepared: None,
        };
    };
    row.sanitized_keys = sanitized_keys;
    let name = normalized_name(&provider.name);
    let matched: Vec<&Provider> = stored
        .iter()
        .filter(|line| line.id == provider.id || normalized_name(&line.name) == name)
        .collect();
    // A copy imported earlier under a new name and id is already present.
    let copy = stored.iter().find(|line| {
        !matched.iter().any(|found| found.id == line.id) && same_content(line, &provider)
    });
    row.existing_ids = matched.iter().map(|line| line.id.clone()).collect();
    if matched.len() == 1 && same_content(matched[0], &provider) {
        row.status = "identical";
        row.reason = "配置与元数据相同，跳过";
    } else if let Some(copy) = copy {
        row.status = "identical";
        row.reason = "已有配置相同的线路，跳过";
        row.existing_ids = vec![copy.id.clone()];
    } else if incoming_names.get(&name).copied().unwrap_or(0) > 1 {
        row.status = "conflict";
        row.reason = "源文件包含同名线路，需要逐项确认";
    } else if matched.is_empty() {
        row.status = "new";
        row.reason = "可作为新线路导入，不自动启用";
    } else {
        row.status = "conflict";
        row.reason = "同名或同标识线路存在差异，默认保留现有";
    }
    row.replaceable =
        row.status == "conflict" && matched.len() == 1 && !is_protected(app, matched[0]);
    let prepared = matches!(row.status, "new" | "conflict").then_some(provider);
    Classified { row, prepared }
}

fn classify(root: &Value, existing: &Lines) -> Result<Vec<Classified>, String> {
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
                *incoming_names.entry(normalized_name(name)).or_default() += 1;
            }
        }
        let stored = existing
            .get(canonical_app)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for (source_id, raw) in providers {
            if rows.len() >= MAX_ROWS {
                return Err("TOO_MANY_IMPORT_ROWS".into());
            }
            rows.push(classify_row(
                app.as_ref(),
                canonical_app,
                source_id,
                raw,
                stored,
                &incoming_names,
            ));
        }
    }
    if rows.is_empty() {
        return Err("NO_PROVIDER_MANAGERS".into());
    }
    Ok(rows)
}

fn inventory(root: &Value, existing: &Lines) -> Result<ImportInventory, String> {
    Ok(ImportInventory {
        rows: classify(root, existing)?
            .into_iter()
            .map(|entry| entry.row)
            .collect(),
        writes_live: false,
        can_commit: false,
        preview_id: None,
    })
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

/// Apps in the file whose lines this importer reads from the database.
fn importable_apps(root: &Value) -> Vec<AppType> {
    let Some(object) = root.as_object() else {
        return Vec::new();
    };
    object
        .keys()
        .filter_map(|key| AppType::parse_id(key).ok())
        .filter(|app| {
            !matches!(app, AppType::Pi | AppType::Mcode)
                && crate::product_policy::require_app(app).is_ok()
        })
        .collect()
}

fn existing_on_connection(conn: &rusqlite::Connection, root: &Value) -> Result<Lines, String> {
    let mut existing = HashMap::new();
    for app in importable_apps(root) {
        let providers = Database::get_all_providers_on_connection(conn, app.as_str())
            .map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
        existing.insert(app.as_str().to_string(), providers.into_values().collect());
    }
    Ok(existing)
}

/// `(app, id)` of every current line of the importable apps: the database
/// flag and the id this device remembers, which may name a deleted line.
fn current_lines(conn: &rusqlite::Connection, root: &Value) -> Result<AppKeys, String> {
    let mut current = AppKeys::new();
    for app in importable_apps(root) {
        let mut statement = conn
            .prepare("SELECT id FROM providers WHERE app_type = ?1 AND is_current = 1")
            .map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
        let ids = statement
            .query_map([app.as_str()], |row| row.get::<_, String>(0))
            .map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
        for id in ids {
            let id = id.map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
            current.insert((app.as_str().to_string(), id));
        }
        if let Some(id) = crate::settings::get_current_provider(&app) {
            current.insert((app.as_str().to_string(), id));
        }
    }
    Ok(current)
}

/// The source id when it is free in this app, otherwise a random one. Never
/// an official seed id, and never an id this device remembers as current: a
/// row stored under it would become current without a switch.
fn allocate_id(app: &str, source_id: &str, reuse_source: bool, taken: &mut AppKeys) -> String {
    let source_free = reuse_source
        && !crate::database::is_official_seed_id(source_id)
        && !taken.contains(&(app.to_string(), source_id.to_string()));
    let id = if source_free {
        source_id.to_string()
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    taken.insert((app.to_string(), id.clone()));
    id
}

/// `name`, else `name (2)`, `name (3)`, ...: the first name not used in this
/// app. A row that matches a local line always takes a suffix, so the next
/// preview can tell its copy apart from that line.
fn unused_name(app: &str, name: &str, plain_allowed: bool, taken: &mut AppKeys) -> String {
    let base = name.trim();
    let mut candidate = base.to_string();
    let mut suffix = 2usize;
    let mut allowed = plain_allowed;
    while !allowed || taken.contains(&(app.to_string(), normalized_name(&candidate))) {
        candidate = format!("{base} ({suffix})");
        suffix += 1;
        allowed = true;
    }
    taken.insert((app.to_string(), normalized_name(&candidate)));
    candidate
}

fn plan_import(
    root: &Value,
    existing: &Lines,
    current: &AppKeys,
    selections: &[ImportSelection],
) -> Result<ImportPlan, String> {
    if selections.is_empty() || selections.len() > MAX_ROWS {
        return Err("INVALID_IMPORT_SELECTION".into());
    }
    let classified = classify(root, existing)?;
    // Validate every selection before planning any write.
    let mut seen = HashSet::new();
    let mut targets = HashSet::new();
    let mut picked = Vec::new();
    for selection in selections {
        if !seen.insert((selection.app.as_str(), selection.source_id.as_str())) {
            return Err("DUPLICATE_IMPORT_SELECTION".into());
        }
        let entry = classified
            .iter()
            .find(|entry| {
                entry.row.app == selection.app && entry.row.source_id == selection.source_id
            })
            .ok_or("INVALID_IMPORT_SELECTION")?;
        let permitted = match (entry.row.status, selection.action) {
            (_, ImportAction::Skip)
            | ("new", ImportAction::Import)
            | ("conflict", ImportAction::Duplicate) => true,
            ("conflict", ImportAction::Replace) => entry.row.existing_ids.len() == 1,
            _ => false,
        };
        if !permitted {
            return Err("INVALID_IMPORT_SELECTION".into());
        }
        if selection.action == ImportAction::Replace {
            if !entry.row.replaceable {
                return Err("IMPORT_TARGET_PROTECTED".into());
            }
            let target_id = entry.row.existing_ids[0].as_str();
            if !targets.insert((entry.row.app.as_str(), target_id)) {
                return Err("DUPLICATE_IMPORT_TARGET".into());
            }
        }
        picked.push((entry, selection.action));
    }
    if picked
        .iter()
        .all(|(_, action)| *action == ImportAction::Skip)
    {
        return Err("INVALID_IMPORT_SELECTION".into());
    }

    let mut taken_ids = current.clone();
    let mut taken_names = AppKeys::new();
    for (app, lines) in existing {
        for line in lines {
            taken_ids.insert((app.clone(), line.id.clone()));
            taken_names.insert((app.clone(), normalized_name(&line.name)));
        }
    }
    // Rows stored under their own name claim it before any copy is named.
    for (entry, action) in &picked {
        if matches!(action, ImportAction::Import | ImportAction::Replace) {
            taken_names.insert((entry.row.app.clone(), normalized_name(&entry.row.name)));
        }
    }

    let mut writes = Vec::new();
    let mut rows = Vec::new();
    let mut sanitized_keys = BTreeSet::new();
    for (entry, action) in picked {
        let app = entry.row.app.clone();
        let mut result = ImportRowResult {
            app: app.clone(),
            source_id: entry.row.source_id.clone(),
            name: entry.row.name.clone(),
            outcome: "skipped",
            reason: None,
        };
        let prepared = match (action, entry.prepared.as_ref()) {
            (ImportAction::Skip, _) | (_, None) => None,
            (_, Some(prepared)) => Some(prepared.clone()),
        };
        if let Some(mut provider) = prepared {
            if action == ImportAction::Replace {
                let target = &entry.row.existing_ids[0];
                if current.contains(&(app.clone(), target.clone())) {
                    // Switched to after the preview: the current line is never overwritten.
                    result.outcome = "failed";
                    result.reason = Some("该线路正在使用，未覆盖");
                } else {
                    let stored = existing
                        .get(&app)
                        .and_then(|lines| lines.iter().find(|line| line.id == *target))
                        .ok_or("INVALID_IMPORT_SELECTION")?;
                    provider.id = stored.id.clone();
                    provider.created_at = stored.created_at;
                    provider.sort_index = stored.sort_index;
                    result.outcome = "replaced";
                }
            } else {
                // A copy never reuses its source id, so it is never matched by id later.
                let duplicate = action == ImportAction::Duplicate;
                provider.id = allocate_id(&app, &provider.id, !duplicate, &mut taken_ids);
                if duplicate {
                    let plain_allowed = entry.row.existing_ids.is_empty();
                    provider.name =
                        unused_name(&app, &provider.name, plain_allowed, &mut taken_names);
                }
                result.name = provider.name.clone();
                result.outcome = "imported";
            }
            if result.outcome != "failed" {
                sanitized_keys.extend(entry.row.sanitized_keys.iter().cloned());
                writes.push((app, provider));
            }
        }
        rows.push(result);
    }
    Ok(ImportPlan {
        writes,
        rows,
        sanitized_keys: sanitized_keys.into_iter().collect(),
    })
}

/// Read and classify a cc-switch `config.json`, replacing any earlier preview.
pub fn preview(state: &AppState, path: String) -> Result<ImportInventory, String> {
    // A new file invalidates the old handle, including failed previews.
    let mut session = state
        .cc_switch_preview
        .lock()
        .map_err(|_| "IMPORT_PREVIEW_FAILED")?;
    *session = None;
    let (root, source_digest) = read_source(&path)?;
    let (existing, current) = {
        let conn = state
            .db
            .conn
            .lock()
            .map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
        (
            existing_on_connection(&conn, &root)?,
            current_lines(&conn, &root)?,
        )
    };
    let mut result = inventory(&root, &existing)?;
    for row in &mut result.rows {
        // The current line is never offered for replacement.
        let target_is_current = row
            .existing_ids
            .first()
            .is_some_and(|id| current.contains(&(row.app.clone(), id.clone())));
        if target_is_current {
            row.replaceable = false;
        }
    }
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
}

/// Serialize a commit with profile application and with switches of every
/// app it names, in the order deletion takes the same locks (profile, proxy
/// lifecycle, then each app), so no named line becomes current mid-import.
pub async fn lock_for_commit(
    state: &AppState,
    selections: &[ImportSelection],
) -> Vec<tokio::sync::OwnedMutexGuard<()>> {
    let mut apps: Vec<String> = selections
        .iter()
        .filter_map(|selection| AppType::parse_id(&selection.app).ok())
        .map(|app| app.as_str().to_string())
        .collect();
    apps.sort();
    apps.dedup();
    let mut guards = vec![state.profile_apply_lock.clone().lock_owned().await];
    guards.push(state.proxy_service.lock_lifecycle().await);
    for app in &apps {
        guards.push(state.proxy_service.lock_switch_for_app(app).await);
    }
    guards
}

fn take_preview(state: &AppState, preview_id: &str) -> Result<CcSwitchPreviewSession, String> {
    let mut slot = state
        .cc_switch_preview
        .lock()
        .map_err(|_| "IMPORT_PREVIEW_FAILED")?;
    if slot.as_ref().is_none_or(|p| p.id != preview_id) {
        return Err("IMPORT_PREVIEW_EXPIRED".into());
    }
    // Consume once before any IO: a failed or stale commit must be previewed again.
    let preview = slot.take().ok_or("IMPORT_PREVIEW_EXPIRED")?;
    if preview.created.elapsed() > PREVIEW_TTL {
        return Err("IMPORT_PREVIEW_EXPIRED".into());
    }
    Ok(preview)
}

fn same_lines(now: &Lines, then: &Lines) -> bool {
    match (serde_json::to_value(now), serde_json::to_value(then)) {
        (Ok(now), Ok(then)) => now == then,
        _ => false,
    }
}

fn data_version(conn: &rusqlite::Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(|_| "IMPORT_DATABASE_UNAVAILABLE".to_string())
}

/// Write the selected rows of a fresh preview: re-read the source and refuse
/// when it or the local lines changed, back up the database, then store every
/// write inactive in one transaction.
pub fn commit(
    state: &AppState,
    preview_id: &str,
    selections: &[ImportSelection],
) -> Result<ImportReceipt, String> {
    let preview = take_preview(state, preview_id)?;
    let (root, digest) = read_source(&preview.path)?;
    if digest != preview.source_digest {
        return Err("IMPORT_SOURCE_CHANGED".into());
    }
    let mut conn = state
        .db
        .conn
        .lock()
        .map_err(|_| "IMPORT_DATABASE_UNAVAILABLE")?;
    let version = data_version(&conn)?;
    let snapshot =
        Database::snapshot_connection_to_memory(&conn).map_err(|_| "IMPORT_BACKUP_FAILED")?;
    let tx = import_transaction(&mut conn, version)?;
    let existing = existing_on_connection(&tx, &root)?;
    if !same_lines(&existing, &preview.existing) {
        return Err("IMPORT_DATABASE_CHANGED".into());
    }
    let current = current_lines(&tx, &root)?;
    let plan = plan_import(&root, &existing, &current, selections)?;
    // Backed up only once the commit is known to be valid, so a refused import
    // never rotates an older backup away; still before any write.
    let backup_name = Database::backup_database_snapshot(&snapshot)
        .ok()
        .flatten()
        .and_then(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .ok_or("IMPORT_BACKUP_FAILED")?;
    apply_plan(&tx, &plan.writes)?;
    tx.commit().map_err(|_| "IMPORT_COMMIT_FAILED")?;
    Ok(plan.into_receipt(backup_name))
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
        Database::save_provider_on_connection(conn, app, &provider_without_endpoints)
            .map_err(|_| "IMPORT_COMMIT_FAILED")?;
        for (url, endpoint) in endpoints {
            conn.execute(
                "INSERT INTO provider_endpoints (provider_id, app_type, url, added_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![provider.id, app, url, endpoint.added_at],
            )
            .map_err(|_| "IMPORT_COMMIT_FAILED")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use serial_test::serial;
    use std::sync::Arc;

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

    fn pick(app: &str, source: &str, action: ImportAction) -> ImportSelection {
        ImportSelection {
            app: app.into(),
            source_id: source.into(),
            action,
        }
    }

    fn choice(source: &str, action: ImportAction) -> ImportSelection {
        pick("codex", source, action)
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
        let none = AppKeys::new();
        let import = [choice("incoming", ImportAction::Import)];
        assert!(plan_import(&root, &existing, &none, &import).is_err());
        let replace = [choice("incoming", ImportAction::Replace)];
        let plan = plan_import(&root, &existing, &none, &replace).unwrap();
        assert_eq!(plan.writes[0].1.id, "local");
        assert_eq!(plan.writes[0].1.created_at, Some(123));
        assert_eq!(plan.writes[0].1.sort_index, Some(4));
        assert!(!plan.writes[0].1.in_failover_queue);
    }

    #[test]
    fn plan_rejects_duplicate_sources_targets_and_protected_replacements() {
        let root = json!({"codex":{"providers":{"a":provider("same", "one"),"b":provider("same", "two")}}});
        let mut stored: Provider = serde_json::from_value(provider("same", "old")).unwrap();
        stored.id = "local".into();
        let existing = HashMap::from([("codex".into(), vec![stored.clone()])]);
        let none = AppKeys::new();
        let replace = ImportAction::Replace;
        let twice = [choice("a", replace), choice("a", replace)];
        let error = plan_import(&root, &existing, &none, &twice).err();
        assert_eq!(error.as_deref(), Some("DUPLICATE_IMPORT_SELECTION"));
        let both = [choice("a", replace), choice("b", replace)];
        let error = plan_import(&root, &existing, &none, &both).err();
        assert_eq!(error.as_deref(), Some("DUPLICATE_IMPORT_TARGET"));
        stored.in_failover_queue = true;
        let protected = HashMap::from([("codex".into(), vec![stored])]);
        let one = [choice("a", replace)];
        let error = plan_import(&root, &protected, &none, &one).err();
        assert_eq!(error.as_deref(), Some("IMPORT_TARGET_PROTECTED"));
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
        let selection = [choice("script", ImportAction::Import)];
        assert!(plan_import(&root, &HashMap::new(), &AppKeys::new(), &selection).is_err());
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
        let selection = [choice("new", ImportAction::Import)];
        let plan = plan_import(&root, &HashMap::new(), &AppKeys::new(), &selection).unwrap();
        let mut conn = db.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        apply_plan(&tx, &plan.writes).unwrap();
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

    #[test]
    fn new_rows_never_reuse_a_remembered_current_or_official_seed_id() {
        let seed = crate::database::CODEX_OFFICIAL_PROVIDER_ID;
        let mut root = json!({"codex":{"providers":{"stale":provider("Stale", "one")}}});
        root["codex"]["providers"][seed] = provider("Seed", "two");
        // A deleted line this device still remembers as current.
        let current = AppKeys::from([("codex".to_string(), "stale".to_string())]);
        let selections = [
            choice("stale", ImportAction::Import),
            choice(seed, ImportAction::Import),
        ];
        let plan = plan_import(&root, &HashMap::new(), &current, &selections).unwrap();
        assert_eq!(plan.writes.len(), 2);
        for (_, line) in &plan.writes {
            assert!(line.id != "stale" && line.id != seed, "{}", line.id);
        }
        assert_eq!(plan.writes[0].1.name, "Stale");
    }

    /// Isolated app directory holding a database file, so the real backup
    /// code runs; restores the previous test home on drop.
    struct TestHome {
        dir: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
    }

    impl TestHome {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let previous = std::env::var_os("CC_SWITCH_TEST_HOME");
            std::env::set_var("CC_SWITCH_TEST_HOME", dir.path());
            let app_dir = crate::config::get_app_config_dir();
            std::fs::create_dir_all(&app_dir).unwrap();
            let database = app_dir.join(crate::product_policy::PRODUCT_DATABASE_FILE);
            std::fs::write(database, b"").unwrap();
            Self { dir, previous }
        }

        fn source(&self, root: &Value) -> String {
            let path = self.dir.path().join("config.json");
            std::fs::write(&path, serde_json::to_vec(root).unwrap()).unwrap();
            path.to_string_lossy().into_owned()
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
                None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
            }
        }
    }

    fn state_with(lines: Vec<Provider>) -> AppState {
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        for line in &lines {
            state.db.save_provider("codex", line).unwrap();
        }
        state
    }

    fn local(name: &str, key: &str, id: &str) -> Provider {
        let mut line: Provider = serde_json::from_value(provider(name, key)).unwrap();
        line.id = id.into();
        line
    }

    fn stored(state: &AppState, app: &str, id: &str) -> Provider {
        state.db.get_provider_by_id(id, app).unwrap().unwrap()
    }

    fn row<'a>(inventory: &'a ImportInventory, source_id: &str) -> &'a ImportInventoryRow {
        let mut rows = inventory.rows.iter();
        rows.find(|row| row.source_id == source_id).unwrap()
    }

    fn outcome<'a>(receipt: &'a ImportReceipt, source_id: &str) -> &'a ImportRowResult {
        let mut rows = receipt.rows.iter();
        rows.find(|row| row.source_id == source_id).unwrap()
    }

    fn counts(receipt: &ImportReceipt) -> [usize; 4] {
        [
            receipt.imported,
            receipt.replaced,
            receipt.skipped,
            receipt.failed,
        ]
    }

    fn key_of(line: &Provider) -> &Value {
        &line.settings_config["auth"]["OPENAI_API_KEY"]
    }

    #[test]
    #[serial]
    fn commit_writes_selected_rows_inactive_after_a_backup() {
        let home = TestHome::new();
        let mut swap = local("Swap", "local-key", "swap-local");
        swap.created_at = Some(7);
        let state = state_with(vec![
            local("Shared", "local-key", "shared-local"),
            swap,
            local("Kept", "local-key", "kept-local"),
        ]);
        let db = &state.db;
        db.set_current_provider("codex", "kept-local").unwrap();
        let opencode = json!({"name":"Open line", "settingsConfig":{"npm":"@ai-sdk/openai-compatible", "options":{"apiKey":"opencode-secret"}}});
        let root = json!({
            "codex":{"providers":{
                "fresh":provider("Fresh", "fresh-secret"),
                "copy":provider("Shared", "copy-secret"),
                "swap":provider("Swap", "swap-secret"),
                "keep":provider("Kept", "keep-secret")
            }},
            "opencode":{"providers":{"open":opencode}}
        });
        let inventory = preview(&state, home.source(&root)).unwrap();
        assert!(inventory.can_commit);
        assert!(row(&inventory, "swap").replaceable);
        // Matches the current line: a conflict, never offered for replacement.
        let keep = row(&inventory, "keep");
        assert_eq!((keep.status, keep.replaceable), ("conflict", false));

        let selections = [
            choice("fresh", ImportAction::Import),
            choice("copy", ImportAction::Duplicate),
            choice("swap", ImportAction::Replace),
            choice("keep", ImportAction::Skip),
            pick("opencode", "open", ImportAction::Import),
        ];
        let id = inventory.preview_id.as_deref().unwrap();
        let receipt = commit(&state, id, &selections).unwrap();
        assert_eq!(counts(&receipt), [3, 1, 1, 0]);
        assert_eq!(outcome(&receipt, "copy").name, "Shared (2)");
        assert_eq!(outcome(&receipt, "swap").outcome, "replaced");
        assert_eq!(outcome(&receipt, "keep").outcome, "skipped");

        let lines = db.get_all_providers("codex").unwrap();
        assert_eq!(lines.len(), 5);
        let copy = lines
            .values()
            .find(|line| line.name == "Shared (2)")
            .unwrap();
        assert!(copy.id != "copy" && copy.id != "shared-local");
        assert_eq!(key_of(copy), &json!("copy-secret"));
        assert_eq!(key_of(&lines["fresh"]), &json!("fresh-secret"));
        assert_eq!(key_of(&lines["shared-local"]), &json!("local-key"));
        assert_eq!(key_of(&lines["swap-local"]), &json!("swap-secret"));
        assert_eq!(lines["swap-local"].created_at, Some(7));
        assert_eq!(key_of(&lines["kept-local"]), &json!("local-key"));
        let current = db.get_current_provider("codex").unwrap();
        assert_eq!(current.as_deref(), Some("kept-local"));
        assert!(lines.values().all(|line| !line.in_failover_queue));
        let open = stored(&state, "opencode", "open");
        let membership = open.meta.and_then(|meta| meta.live_config_managed);
        assert_eq!(membership, Some(false));
        assert!(receipt.backup_name.starts_with("db_backup_"));
        let backups = crate::config::get_app_config_dir().join("backups");
        assert!(backups.join(&receipt.backup_name).is_file());
        assert!(!serde_json::to_string(&receipt).unwrap().contains("secret"));
    }

    #[test]
    #[serial]
    fn commit_refuses_a_changed_source_or_database_without_writing() {
        let home = TestHome::new();
        let state = state_with(Vec::new());
        let root = json!({"codex":{"providers":{"fresh":provider("Fresh", "one")}}});
        let path = home.source(&root);
        let selection = [choice("fresh", ImportAction::Import)];

        let first = preview(&state, path.clone()).unwrap();
        home.source(&json!({"codex":{"providers":{"fresh":provider("Fresh", "two")}}}));
        let first_id = first.preview_id.as_deref().unwrap();
        let stale = commit(&state, first_id, &selection);
        assert_eq!(stale.err().as_deref(), Some("IMPORT_SOURCE_CHANGED"));
        // A refused commit consumes its preview.
        let reused = commit(&state, first_id, &selection);
        assert_eq!(reused.err().as_deref(), Some("IMPORT_PREVIEW_EXPIRED"));

        let second = preview(&state, path).unwrap();
        let other = local("Other", "three", "other");
        state.db.save_provider("codex", &other).unwrap();
        let second_id = second.preview_id.as_deref().unwrap();
        let changed = commit(&state, second_id, &selection);
        assert_eq!(changed.err().as_deref(), Some("IMPORT_DATABASE_CHANGED"));
        let fresh = state.db.get_provider_by_id("fresh", "codex").unwrap();
        assert!(fresh.is_none());
    }

    #[test]
    #[serial]
    fn failed_backup_leaves_the_database_untouched() {
        let home = TestHome::new();
        let state = state_with(vec![local("Kept", "local-key", "kept-local")]);
        let root = json!({"codex":{"providers":{"fresh":provider("Fresh", "one")}}});
        let inventory = preview(&state, home.source(&root)).unwrap();
        // A file where the backup directory belongs makes the backup fail.
        let backups = crate::config::get_app_config_dir().join("backups");
        std::fs::write(backups, b"not a directory").unwrap();
        let selection = [choice("fresh", ImportAction::Import)];
        let id = inventory.preview_id.as_deref().unwrap();
        let result = commit(&state, id, &selection);
        assert_eq!(result.err().as_deref(), Some("IMPORT_BACKUP_FAILED"));
        let lines = state.db.get_all_providers("codex").unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines.contains_key("kept-local"));
    }

    #[test]
    #[serial]
    fn a_line_switched_to_after_the_preview_is_never_overwritten() {
        let home = TestHome::new();
        let state = state_with(vec![local("Live", "live-key", "live-local")]);
        let root = json!({"codex":{"providers":{
            "live":provider("Live", "incoming-key"),
            "fresh":provider("Fresh", "fresh-key")
        }}});
        let inventory = preview(&state, home.source(&root)).unwrap();
        assert!(row(&inventory, "live").replaceable);
        let db = &state.db;
        db.set_current_provider("codex", "live-local").unwrap();

        let selections = [
            choice("live", ImportAction::Replace),
            choice("fresh", ImportAction::Import),
        ];
        let id = inventory.preview_id.as_deref().unwrap();
        let receipt = commit(&state, id, &selections).unwrap();
        let live = outcome(&receipt, "live");
        assert_eq!(live.outcome, "failed");
        assert_eq!(live.reason, Some("该线路正在使用，未覆盖"));
        assert_eq!(counts(&receipt), [1, 0, 0, 1]);
        let lines = db.get_all_providers("codex").unwrap();
        assert_eq!(key_of(&lines["live-local"]), &json!("live-key"));
        let current = db.get_current_provider("codex").unwrap();
        assert_eq!(current.as_deref(), Some("live-local"));
        assert!(!lines["fresh"].in_failover_queue);
    }

    #[test]
    #[serial]
    fn importing_the_same_selection_twice_creates_no_duplicates() {
        let home = TestHome::new();
        let state = state_with(vec![
            local("Shared", "local-key", "shared-local"),
            local("Swap", "local-key", "swap-local"),
        ]);
        let root = json!({"codex":{"providers":{
            "fresh":provider("Fresh", "fresh-key"),
            "copy":provider("Shared", "copy-key"),
            "swap":provider("Swap", "swap-key")
        }}});
        let path = home.source(&root);
        let selections = [
            choice("fresh", ImportAction::Import),
            choice("copy", ImportAction::Duplicate),
            choice("swap", ImportAction::Replace),
        ];
        let first = preview(&state, path.clone()).unwrap();
        let first_id = first.preview_id.as_deref().unwrap();
        commit(&state, first_id, &selections).unwrap();
        let count = state.db.get_all_providers("codex").unwrap().len();
        assert_eq!(count, 4);

        let second = preview(&state, path).unwrap();
        for source in ["fresh", "copy", "swap"] {
            assert_eq!(row(&second, source).status, "identical", "{source}");
        }
        let second_id = second.preview_id.as_deref().unwrap();
        let again = commit(&state, second_id, &selections);
        assert_eq!(again.err().as_deref(), Some("INVALID_IMPORT_SELECTION"));
        let after = state.db.get_all_providers("codex").unwrap().len();
        assert_eq!(after, count);
    }

    #[test]
    #[serial]
    fn unsafe_keys_are_removed_on_import_and_reported_by_name() {
        let home = TestHome::new();
        let state = state_with(Vec::new());
        let mut risky = provider("Risky", "codex-secret-key");
        risky["settingsConfig"]["config"] =
            json!("model = \"test\"\nnotify = [\"calc.exe\"]\napproval_policy = \"never\"\n");
        let claude = json!({"name":"Claude line", "settingsConfig":{"env":{
            "ANTHROPIC_AUTH_TOKEN":"claude-secret-key",
            "NODE_OPTIONS":"--require ./evil.js"
        }}});
        let root = json!({
            "codex":{"providers":{"risky":risky}},
            "claude":{"providers":{"claude":claude}}
        });
        let inventory = preview(&state, home.source(&root)).unwrap();
        let risky_row = row(&inventory, "risky");
        assert_eq!(risky_row.sanitized_keys, ["notify", "approval_policy"]);
        let claude_row = row(&inventory, "claude");
        assert_eq!(claude_row.sanitized_keys, ["env.NODE_OPTIONS"]);

        let selections = [
            choice("risky", ImportAction::Import),
            pick("claude", "claude", ImportAction::Import),
        ];
        let id = inventory.preview_id.as_deref().unwrap();
        let receipt = commit(&state, id, &selections).unwrap();
        let reported = ["approval_policy", "env.NODE_OPTIONS", "notify"];
        assert_eq!(receipt.sanitized_keys, reported);
        let codex = stored(&state, "codex", "risky");
        let config = codex.settings_config["config"].as_str().unwrap();
        assert!(config.contains("model"));
        assert!(!config.contains("notify") && !config.contains("approval_policy"));
        // The API key is copied as stored data.
        assert_eq!(key_of(&codex), &json!("codex-secret-key"));
        let claude = stored(&state, "claude", "claude");
        let env = &claude.settings_config["env"];
        assert!(env.get("NODE_OPTIONS").is_none());
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], json!("claude-secret-key"));
        let preview_json = serde_json::to_string(&inventory).unwrap();
        let receipt_json = serde_json::to_string(&receipt).unwrap();
        assert!(!preview_json.contains("secret-key") && !receipt_json.contains("secret-key"));
    }

    #[test]
    #[serial]
    fn oauth_rows_stay_unsupported_and_cannot_be_committed() {
        let home = TestHome::new();
        let state = state_with(Vec::new());
        let mut oauth = provider("OAuth", "");
        oauth["settingsConfig"]["auth"] = json!({"tokens":{"access_token":"oauth-secret"}});
        let root = json!({"codex":{"providers":{
            "oauth":oauth,
            "fresh":provider("Fresh", "one")
        }}});
        let inventory = preview(&state, home.source(&root)).unwrap();
        assert_eq!(row(&inventory, "oauth").status, "unsupported");
        let exported = serde_json::to_string(&inventory).unwrap();
        assert!(!exported.contains("oauth-secret"));
        let selections = [
            choice("oauth", ImportAction::Import),
            choice("fresh", ImportAction::Import),
        ];
        let id = inventory.preview_id.as_deref().unwrap();
        let result = commit(&state, id, &selections);
        assert_eq!(result.err().as_deref(), Some("INVALID_IMPORT_SELECTION"));
        assert!(state.db.get_all_providers("codex").unwrap().is_empty());
    }
}
