use indexmap::IndexMap;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use crate::app_config::{AppType, McpServer};
use crate::config::cas::AppliedChangeset;
use crate::error::AppError;
use crate::mcp;
use crate::store::AppState;

// ponytail: process-wide MCP lock; split by DB only if multiple workspaces become supported.
static MCP_OPERATION: Mutex<()> = Mutex::new(());

pub(crate) fn lock_operation() -> Result<MutexGuard<'static, ()>, AppError> {
    MCP_OPERATION
        .lock()
        .map_err(|_| AppError::Message("MCP operation lock poisoned".into()))
}

pub struct McpService;

impl McpService {
    pub fn get_all_servers(state: &AppState) -> Result<IndexMap<String, McpServer>, AppError> {
        let _guard = lock_operation()?;
        state.db.get_all_mcp_servers()
    }

    // Lock order: client switch locks (AppType::all order), then MCP, then short DB locks.
    // Provider re-projection already holds its client lock and only takes MCP.
    fn lock_clients(state: &AppState) -> Vec<tokio::sync::OwnedMutexGuard<()>> {
        AppType::all()
            .filter(|app| {
                matches!(
                    app,
                    AppType::Claude
                        | AppType::Codex
                        | AppType::Gemini
                        | AppType::GrokBuild
                        | AppType::OpenCode
                )
            })
            .map(|app| {
                futures::executor::block_on(state.proxy_service.lock_switch_for_app(app.as_str()))
            })
            .collect()
    }

    pub fn upsert_server(state: &AppState, server: McpServer) -> Result<(), AppError> {
        Self::upsert_servers_atomic(state, &[server])
    }

    pub fn upsert_servers_atomic(state: &AppState, servers: &[McpServer]) -> Result<(), AppError> {
        let mut ids = HashSet::new();
        for server in servers {
            mcp::validation::validate_server_spec(&server.server)?;
            if !ids.insert(&server.id) {
                return Err(AppError::InvalidInput(format!(
                    "Duplicate MCP server id: {}",
                    server.id
                )));
            }
        }
        let _clients = Self::lock_clients(state);
        let _guard = lock_operation()?;
        Self::transaction(state, |state| {
            let before = state.db.get_all_mcp_servers()?;
            for server in servers {
                let mut server = server.clone();
                if server.apps.codex
                    && server.server.get("enabled").is_none()
                    && before.get(&server.id).is_some_and(|old| {
                        old.server
                            .get("enabled")
                            .and_then(serde_json::Value::as_bool)
                            == Some(false)
                    })
                {
                    server.server["enabled"] = false.into();
                }
                state.db.save_mcp_server(&server)?;
            }
            Ok(())
        })
    }

    /// The legacy command's read/merge belongs inside the same operation as its write.
    pub fn upsert_legacy(
        state: &AppState,
        app: AppType,
        id: String,
        spec: serde_json::Value,
        all: bool,
    ) -> Result<(), AppError> {
        mcp::validation::validate_server_spec(&spec)?;
        let _clients = Self::lock_clients(state);
        let _guard = lock_operation()?;
        Self::transaction(state, |state| {
            let mut server = state
                .db
                .get_all_mcp_servers()?
                .get(&id)
                .cloned()
                .unwrap_or_else(|| McpServer {
                    name: spec
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(&id)
                        .into(),
                    id,
                    server: spec.clone(),
                    apps: Default::default(),
                    description: None,
                    homepage: None,
                    docs: None,
                    tags: Vec::new(),
                });
            let codex_disabled = server
                .server
                .get("enabled")
                .and_then(serde_json::Value::as_bool)
                == Some(false);
            server.server = spec;
            if app != AppType::Codex && codex_disabled {
                server.server["enabled"] = false.into();
            }
            server.apps.set_enabled_for(&app, true);
            if all {
                server.apps.claude = true;
                server.apps.codex = true;
                server.apps.gemini = true;
                server.apps.opencode = true;
            }
            state.db.save_mcp_server(&server)
        })
    }

    pub fn delete_server(state: &AppState, id: &str) -> Result<bool, AppError> {
        let _clients = Self::lock_clients(state);
        let _guard = lock_operation()?;
        Self::transaction(state, |state| {
            if !state.db.get_all_mcp_servers()?.contains_key(id) {
                return Ok(false);
            }
            state.db.delete_mcp_server(id)?;
            Ok(true)
        })
    }

    pub fn toggle_app(
        state: &AppState,
        id: &str,
        app: AppType,
        enabled: bool,
    ) -> Result<(), AppError> {
        let _clients = Self::lock_clients(state);
        let _guard = lock_operation()?;
        Self::transaction(state, |state| {
            let Some(previous) = state.db.get_all_mcp_servers()?.get(id).cloned() else {
                return Ok(());
            };
            let updated = app_toggle_target(&previous, &app, enabled);
            state.db.save_mcp_server(&updated)
        })
    }

    fn restore_rows(
        state: &AppState,
        before: &IndexMap<String, McpServer>,
        errors: &mut Vec<String>,
    ) {
        match state.db.get_all_mcp_servers() {
            Ok(current) => {
                for id in current.keys().filter(|id| !before.contains_key(*id)) {
                    if let Err(e) = state.db.delete_mcp_server(id) {
                        errors.push(format!("DB rollback: {e}"));
                    }
                }
            }
            Err(e) => errors.push(format!("DB rollback: {e}")),
        }
        for server in before.values() {
            if let Err(e) = state.db.save_mcp_server(server) {
                errors.push(format!("DB rollback: {e}"));
            }
        }
    }

    /// The undo set contains actual successful writes, including newly created files.
    /// Never reconstruct rollback from the restored DB or adopt externally changed bytes.
    fn transaction<T>(
        state: &AppState,
        mutate: impl FnOnce(&AppState) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let before = state.db.get_all_mcp_servers()?;
        let result = Self::with_projection_undo(state, |journal| {
            let value = mutate(state)?;
            let after = state.db.get_all_mcp_servers()?;
            let ids: std::collections::BTreeSet<_> = before.keys().chain(after.keys()).collect();
            for app in AppType::all() {
                for id in &ids {
                    let old_spec = before.get(*id).and_then(|server| app_spec(server, &app));
                    let new_spec = after.get(*id).and_then(|server| app_spec(server, &app));
                    if old_spec != new_spec {
                        Self::project_one(
                            state,
                            &app,
                            id,
                            new_spec.as_ref(),
                            old_spec.as_ref(),
                            journal,
                        )?;
                    }
                }
            }
            Ok(value)
        });
        result.map_err(|error| {
            let mut errors = vec![error.to_string()];
            Self::restore_rows(state, &before, &mut errors);
            AppError::Message(errors.join("; "))
        })
    }

    fn with_projection_undo<T>(
        state: &AppState,
        project: impl FnOnce(&mut Vec<AppliedChangeset>) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let keys = [
            mcp::CODEX_MCP_PROJECTION_LEDGER_KEY,
            mcp::projection::LEDGER_KEY,
        ];
        let ledgers = keys
            .iter()
            .map(|key| state.db.get_setting(key))
            .collect::<Result<Vec<_>, _>>()?;
        let mut journal = Vec::new();
        match project(&mut journal) {
            Ok(value) => Ok(value),
            Err(error) => {
                let mut errors = vec![error.to_string()];
                for applied in journal.into_iter().rev() {
                    if let Err(e) = applied.rollback() {
                        errors.push(format!("Live rollback: {e}"));
                    }
                }
                for (key, value) in keys.iter().zip(ledgers) {
                    let restored = match value {
                        Some(value) => state.db.set_setting(key, &value),
                        None => state.db.delete_setting(key),
                    };
                    if let Err(e) = restored {
                        errors.push(format!("Ledger rollback: {e}"));
                    }
                }
                Err(AppError::Message(format!(
                    "MCP 操作失败并已尝试回滚: {}",
                    errors.join("; ")
                )))
            }
        }
    }

    fn project_one(
        state: &AppState,
        app: &AppType,
        id: &str,
        spec: Option<&serde_json::Value>,
        old: Option<&serde_json::Value>,
        journal: &mut Vec<AppliedChangeset>,
    ) -> Result<(), AppError> {
        if *app != AppType::Codex {
            return mcp::projection::project(&state.db, app, id, spec, journal, old);
        }
        let mut ledger = mcp::CodexMcpLedger::load(&state.db)?;
        let result = match spec {
            Some(spec) => mcp::sync_single_server_to_codex_journal(&mut ledger, id, spec, journal),
            None => mcp::remove_server_from_codex_journal(&mut ledger, id, old, journal),
        };
        ledger.save(&state.db)?;
        result
    }

    pub fn sync_all_enabled(state: &AppState) -> Result<(), AppError> {
        let _clients = Self::lock_clients(state);
        let _guard = lock_operation()?;
        let mut errors = Vec::new();
        for app in AppType::all() {
            if let Err(error) = Self::sync_app_locked(state, &app) {
                errors.push(format!("{}: {error}", app.as_str()));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(AppError::Message(errors.join("; ")))
        }
    }

    /// Provider callers already hold the app switch lock: do not reacquire it here.
    pub fn sync_enabled_for_app(state: &AppState, app: &AppType) -> Result<(), AppError> {
        let _guard = lock_operation()?;
        Self::sync_app_locked(state, app)
    }

    fn sync_app_locked(state: &AppState, app: &AppType) -> Result<(), AppError> {
        let mut errors = Vec::new();
        for server in state.db.get_all_mcp_servers()?.values() {
            let spec = server.apps.is_enabled_for(app).then_some(&server.server);
            if let Err(error) = Self::with_projection_undo(state, |journal| {
                Self::project_one(state, app, &server.id, spec, None, journal)
            }) {
                errors.push(format!("{}: {error}", server.id));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(AppError::Message(errors.join("; ")))
        }
    }

    // ========================================================================
    // 兼容层：支持旧的 v3.6.x 命令（已废弃，将在 v4.0 移除）
    // ========================================================================

    /// [已废弃] 获取指定应用的 MCP 服务器（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use get_all_servers instead")]
    pub fn get_servers(
        state: &AppState,
        app: AppType,
    ) -> Result<HashMap<String, serde_json::Value>, AppError> {
        let all_servers = Self::get_all_servers(state)?;
        let mut result = HashMap::new();

        for (id, server) in all_servers {
            if server.apps.is_enabled_for(&app) {
                result.insert(id, server.server);
            }
        }

        Ok(result)
    }

    /// [已废弃] 设置 MCP 服务器在指定应用的启用状态（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use toggle_app instead")]
    pub fn set_enabled(
        state: &AppState,
        app: AppType,
        id: &str,
        enabled: bool,
    ) -> Result<bool, AppError> {
        Self::toggle_app(state, id, app, enabled)?;
        Ok(true)
    }

    /// [已废弃] 同步启用的 MCP 到指定应用（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use sync_all_enabled instead")]
    pub fn sync_enabled(state: &AppState, app: AppType) -> Result<(), AppError> {
        let _client =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app(app.as_str()));
        Self::sync_enabled_for_app(state, &app)
    }

    /// 从 Claude 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_claude(state: &AppState) -> Result<usize, AppError> {
        let _guard = lock_operation()?;
        Self::import_app_locked(state, &AppType::Claude)
    }

    /// 从 Codex 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_codex(state: &AppState) -> Result<usize, AppError> {
        let _guard = lock_operation()?;
        Self::import_app_locked(state, &AppType::Codex)
    }

    /// 从 Gemini 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_gemini(state: &AppState) -> Result<usize, AppError> {
        let _guard = lock_operation()?;
        Self::import_app_locked(state, &AppType::Gemini)
    }

    /// 从 Grok Build 的 `[mcp_servers]` 导入 MCP。
    pub fn import_from_grokbuild(state: &AppState) -> Result<usize, AppError> {
        let _guard = lock_operation()?;
        Self::import_app_locked(state, &AppType::GrokBuild)
    }

    /// 从 OpenCode 导入 MCP（v3.9.2+ 新增）
    pub fn import_from_opencode(state: &AppState) -> Result<usize, AppError> {
        let _guard = lock_operation()?;
        Self::import_app_locked(state, &AppType::OpenCode)
    }

    fn import_app_locked(state: &AppState, app: &AppType) -> Result<usize, AppError> {
        let mut imported = crate::app_config::MultiAppConfig::default();
        let count = match app {
            AppType::Claude => mcp::import_from_claude(&mut imported)?,
            AppType::Codex => mcp::import_from_codex(&mut imported)?,
            AppType::Gemini => mcp::import_from_gemini(&mut imported)?,
            AppType::GrokBuild => mcp::import_from_grokbuild(&mut imported)?,
            AppType::OpenCode => mcp::import_from_opencode(&mut imported)?,

            _ => return Ok(0),
        };
        Self::save_imported(state, count, &imported, app)
    }

    fn save_imported(
        state: &AppState,
        count: usize,
        imported: &crate::app_config::MultiAppConfig,
        app: &AppType,
    ) -> Result<usize, AppError> {
        match &imported.mcp.servers {
            Some(servers) if count > 0 => Self::save_imported_servers(state, servers, app),
            _ => Ok(0),
        }
    }

    /// Store servers read from one app's live config; returns the number of
    /// new rows. A known id merges only when its configuration matches. A
    /// server whose content already exists under another id is skipped without enabling it, so
    /// an import never creates a duplicate that would then be projected a
    /// second time under the new id. Imports never write any live config.
    fn save_imported_servers(
        state: &AppState,
        servers: &HashMap<String, McpServer>,
        app: &AppType,
    ) -> Result<usize, AppError> {
        let existing = state.db.get_all_mcp_servers()?;
        let mut planned = Vec::new();
        for server in servers.values() {
            let mut incoming = server.clone();
            incoming.apps = crate::app_config::McpApps::default();
            incoming.apps.set_enabled_for(app, true);
            if *app != AppType::Codex {
                if let Some(spec) = incoming.server.as_object_mut() {
                    spec.remove("enabled");
                }
            }
            match import_target(&existing, &incoming) {
                ImportTarget::SameId(mut merged) => {
                    merged.apps.set_enabled_for(app, true);
                    // Only a Codex import may change Codex's soft-disabled intent.
                    if *app == AppType::Codex {
                        if incoming
                            .server
                            .get("enabled")
                            .and_then(serde_json::Value::as_bool)
                            == Some(false)
                        {
                            merged.server["enabled"] = false.into();
                        } else if let Some(spec) = merged.server.as_object_mut() {
                            spec.remove("enabled");
                        }
                    }
                    planned.push(merged);
                }
                ImportTarget::SameContent(existing_id) => {
                    log::info!(
                        "跳过 MCP 别名 {}（已有 {}），未自动启用目标应用",
                        incoming.id,
                        existing_id
                    );
                    // Same spec under another live ID is not the same projection identity.
                    // Leave both the DB and live config alone; never silently enable an alias.
                }
                ImportTarget::Conflict => {
                    return Err(AppError::McpValidation(format!(
                        "MCP '{}' has different configuration in {}",
                        incoming.id,
                        app.as_str()
                    )))
                }
                ImportTarget::New => planned.push(incoming),
            }
        }
        let count = planned
            .iter()
            .filter(|s| !existing.contains_key(&s.id))
            .count();
        for server in &planned {
            if let Err(error) = state.db.save_mcp_server(server) {
                let mut errors = vec![error.to_string()];
                Self::restore_rows(state, &existing, &mut errors);
                return Err(AppError::Message(errors.join("; ")));
            }
        }
        Ok(count)
    }

    /// 06B switch: only this server's Codex section changes. For a
    /// Codex-only server, off keeps the section (and the token in it) with
    /// `enabled = false`; for a server shared with other apps, off removes it
    /// from Codex only. Returns whether anything changed. The caller holds
    /// the Codex switch lock.
    pub fn set_codex_enabled(state: &AppState, id: &str, enabled: bool) -> Result<bool, AppError> {
        // Compatibility entry: caller already holds the Codex switch lock.
        let _guard = lock_operation()?;
        Self::transaction(state, |state| {
            let previous = state
                .db
                .get_all_mcp_servers()?
                .get(id)
                .cloned()
                .ok_or_else(|| AppError::InvalidInput(format!("MCP 服务器不存在: {id}")))?;
            let updated = codex_toggle_target(&previous, enabled);
            let changed = updated.apps != previous.apps || updated.server != previous.server;
            if changed {
                state.db.save_mcp_server(&updated)?;
            }
            Ok(changed)
        })
    }

    /// 从所有支持 MCP 的应用导入服务器，返回新导入的数量。
    ///
    /// Best-effort：单个应用导入失败（如坏 config.toml）不阻断其余应用；
    /// 全部跑完后若有失败，聚合成一个错误上报——历史实现逐应用
    /// `unwrap_or(0)` 吞错，坏文件只会表现为"导入成功 0 个"，用户
    /// 无从得知哪个应用出了问题。
    pub fn import_from_all_apps(state: &AppState) -> Result<usize, AppError> {
        let _guard = lock_operation()?;
        let mut total = 0;
        let mut failures: Vec<String> = Vec::new();
        for app in [
            AppType::Claude,
            AppType::Codex,
            AppType::Gemini,
            AppType::GrokBuild,
            AppType::OpenCode,
        ] {
            let result = Self::import_app_locked(state, &app);
            let app = app.as_str();
            match result {
                Ok(count) => total += count,
                Err(err) => {
                    log::warn!("从 {app} 导入 MCP 失败: {err}");
                    failures.push(format!("{app}: {err}"));
                }
            }
        }

        if failures.is_empty() {
            Ok(total)
        } else {
            Err(AppError::Message(format!(
                "已导入 {total} 个，部分应用导入失败: {}",
                failures.join("; ")
            )))
        }
    }
}

/// Where an imported server lands in the DB (see `save_imported_servers`).
#[derive(Debug)]
pub(crate) enum ImportTarget {
    SameId(McpServer),
    SameContent(String),
    Conflict,
    New,
}

pub(crate) fn import_target(
    existing: &IndexMap<String, McpServer>,
    incoming: &McpServer,
) -> ImportTarget {
    if let Some(found) = existing.get(&incoming.id) {
        return if canonical_import_spec(&found.server) == canonical_import_spec(&incoming.server) {
            ImportTarget::SameId(found.clone())
        } else {
            ImportTarget::Conflict
        };
    }
    let wanted = canonical_import_spec(&incoming.server);
    existing
        .values()
        .find(|server| canonical_import_spec(&server.server) == wanted)
        .map_or(ImportTarget::New, |server| {
            ImportTarget::SameContent(server.id.clone())
        })
}

/// Spec as compared for import dedup: the transport Codex would infer when
/// `type` is absent, Codex's `http_headers` spelling folded into `headers`,
/// empty collections stripped, and the per-app `enabled` override ignored.
fn canonical_import_spec(spec: &serde_json::Value) -> serde_json::Value {
    let mut spec = spec.clone();
    if let Some(obj) = spec.as_object_mut() {
        let has_valid_cmd = obj
            .get("command")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|s| !s.trim().is_empty());
        let has_valid_url = obj
            .get("url")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|s| !s.trim().is_empty());

        let typ = obj
            .get("type")
            .and_then(serde_json::Value::as_str)
            .map(str::trim);
        let canonical_type = match typ {
            Some("http" | "streamable_http") => "http",
            Some("sse") => "sse",
            Some("stdio") => "stdio",
            _ if !has_valid_cmd && has_valid_url => "http",
            _ => "stdio",
        };
        obj.insert("type".into(), canonical_type.into());

        if let Some(headers) = obj.remove("http_headers") {
            obj.entry("headers").or_insert(headers);
        }
        obj.remove("enabled");

        if obj
            .get("args")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|a| a.is_empty())
        {
            obj.remove("args");
        }
        if obj
            .get("env")
            .and_then(serde_json::Value::as_object)
            .is_some_and(|e| e.is_empty())
        {
            obj.remove("env");
        }
        if obj
            .get("headers")
            .and_then(serde_json::Value::as_object)
            .is_some_and(|h| h.is_empty())
        {
            obj.remove("headers");
        }
    }
    spec
}

fn app_spec(server: &McpServer, app: &AppType) -> Option<serde_json::Value> {
    if !server.apps.is_enabled_for(app) {
        return None;
    }
    let mut spec = server.server.clone();
    if *app != AppType::Codex {
        if let Some(obj) = spec.as_object_mut() {
            obj.remove("enabled");
        }
    }
    Some(spec)
}

fn app_toggle_target(server: &McpServer, app: &AppType, enabled: bool) -> McpServer {
    if *app == AppType::Codex {
        return codex_toggle_target(server, enabled);
    }
    let mut updated = server.clone();
    updated.apps.set_enabled_for(app, enabled);
    updated
}

/// Whether Codex loads this server: enabled for Codex and not switched off
/// with the Codex `enabled = false` override.
#[allow(dead_code)]
pub(crate) fn is_codex_enabled(server: &McpServer) -> bool {
    server.apps.codex
        && server
            .server
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
}

/// The row after the 06B switch (see `McpService::set_codex_enabled`).
pub(crate) fn codex_toggle_target(server: &McpServer, enabled: bool) -> McpServer {
    let mut updated = server.clone();
    let codex_only = updated
        .apps
        .enabled_apps()
        .iter()
        .all(|app| *app == AppType::Codex);
    let obj = updated.server.as_object_mut();
    match (enabled, obj) {
        (true, Some(obj)) => {
            updated.apps.codex = true;
            if obj.get("enabled").and_then(serde_json::Value::as_bool) == Some(false) {
                obj.remove("enabled");
            }
        }
        (true, None) => {
            updated.apps.codex = true;
        }
        (false, Some(obj)) if server.apps.codex && codex_only => {
            obj.insert("enabled".into(), serde_json::Value::Bool(false));
        }
        (false, Some(obj)) => {
            updated.apps.codex = false;
            // Clean up any lingering "enabled": false so it never leaks to other apps
            if obj.get("enabled").and_then(serde_json::Value::as_bool) == Some(false) {
                obj.remove("enabled");
            }
        }
        (false, None) => {
            updated.apps.codex = false;
        }
    }
    updated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::McpApps;
    use serde_json::json;

    fn server(id: &str, spec: serde_json::Value, apps: McpApps) -> McpServer {
        McpServer {
            id: id.into(),
            name: id.into(),
            server: spec,
            apps,
            description: None,
            homepage: None,
            docs: None,
            tags: Vec::new(),
        }
    }

    fn codex_only() -> McpApps {
        McpApps {
            codex: true,
            ..McpApps::default()
        }
    }

    #[test]
    fn import_dedups_by_content_not_only_by_id() {
        let mut existing = IndexMap::new();
        existing.insert(
            "gh".to_string(),
            server(
                "gh",
                json!({"type": "stdio", "command": "npx", "args": ["-y", "server-github"]}),
                codex_only(),
            ),
        );

        // Same content, other id, `type` left for inference: skipped.
        let same = server(
            "github",
            json!({"command": "npx", "args": ["-y", "server-github"], "enabled": false}),
            McpApps::default(),
        );
        assert!(matches!(
            import_target(&existing, &same),
            ImportTarget::SameContent(id) if id == "gh"
        ));
        // Same id with different content is an explicit conflict.
        let same_id = server("gh", json!({"command": "other"}), McpApps::default());
        assert!(matches!(
            import_target(&existing, &same_id),
            ImportTarget::Conflict
        ));
        // Different args: a real new server.
        let other = server(
            "fs",
            json!({"command": "npx", "args": ["-y", "server-filesystem"]}),
            McpApps::default(),
        );
        assert!(matches!(
            import_target(&existing, &other),
            ImportTarget::New
        ));
        // Codex's `http_headers` spelling matches the unified `headers`.
        existing.insert(
            "remote".to_string(),
            server(
                "remote",
                json!({"type": "http", "url": "https://mcp.example.com", "headers": {"A": "1"}}),
                codex_only(),
            ),
        );
        let remote = server(
            "remote-2",
            json!({"url": "https://mcp.example.com", "http_headers": {"A": "1"}}),
            McpApps::default(),
        );
        assert!(matches!(
            import_target(&existing, &remote),
            ImportTarget::SameContent(id) if id == "remote"
        ));
    }

    #[test]
    fn codex_switch_keeps_a_codex_only_section_and_its_token() {
        let github = server(
            "github",
            json!({"type": "stdio", "command": "npx", "env": {"TOKEN": "ghp_x"}}),
            codex_only(),
        );
        assert!(is_codex_enabled(&github));

        let off = codex_toggle_target(&github, false);
        assert!(off.apps.codex, "the section stays projected");
        assert_eq!(off.server["enabled"], false);
        assert_eq!(off.server["env"]["TOKEN"], "ghp_x");
        assert!(!is_codex_enabled(&off));

        let on = codex_toggle_target(&off, true);
        assert!(on.server.get("enabled").is_none());
        assert!(is_codex_enabled(&on));
        assert_eq!(on.server, github.server);
    }

    #[test]
    fn codex_switch_never_touches_other_apps() {
        let shared = server(
            "fs",
            json!({"type": "stdio", "command": "npx"}),
            McpApps {
                codex: true,
                claude: true,
                ..McpApps::default()
            },
        );
        let off = codex_toggle_target(&shared, false);
        assert!(!off.apps.codex);
        assert!(off.apps.claude);
        assert!(
            off.server.get("enabled").is_none(),
            "no Codex override leaks to Claude"
        );

        let never = server("x", json!({"command": "x"}), McpApps::default());
        let on = codex_toggle_target(&never, true);
        assert!(on.apps.codex);
        assert!(!on.apps.claude);
    }
}

#[cfg(test)]
#[path = "../mcp/service_regression_tests.rs"]
mod regression_tests;
