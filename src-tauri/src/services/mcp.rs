use indexmap::IndexMap;
use std::collections::{HashMap, HashSet};

use crate::app_config::{AppType, McpServer};
use crate::error::AppError;
use crate::mcp;
use crate::store::AppState;

/// MCP 相关业务逻辑（v3.7.0 统一结构）
pub struct McpService;

impl McpService {
    /// 获取所有 MCP 服务器（统一结构）
    pub fn get_all_servers(state: &AppState) -> Result<IndexMap<String, McpServer>, AppError> {
        state.db.get_all_mcp_servers()
    }

    /// 添加或更新 MCP 服务器
    pub fn upsert_server(state: &AppState, server: McpServer) -> Result<(), AppError> {
        crate::mcp::validation::validate_server_spec(&server.server)?;

        let previous = state.db.get_all_mcp_servers()?.get(&server.id).cloned();
        let mut snapshots = IndexMap::new();
        snapshots.insert(server.id.clone(), previous.clone());
        let affected_apps = Self::affected_apps(previous.as_ref(), Some(&server));

        state.db.save_mcp_server(&server)?;

        if let Err(primary_error) = Self::sync_apps(state, &affected_apps) {
            return Err(Self::rollback_changes(
                state,
                &snapshots,
                &affected_apps,
                primary_error,
            ));
        }

        Ok(())
    }

    /// 原子地写入一批 MCP 服务器。
    ///
    /// 数据库记录和各应用 live projection 不是同一个事务，因此先保存
    /// 全量旧快照，任何一步失败都逆序恢复数据库并重新投影受影响的应用。
    /// 这保证 deep link 批量导入不会出现“前几个成功、后一个失败”的半完成状态。
    pub fn upsert_servers_atomic(state: &AppState, servers: &[McpServer]) -> Result<(), AppError> {
        if servers.is_empty() {
            return Ok(());
        }

        let existing = state.db.get_all_mcp_servers()?;
        let mut snapshots: IndexMap<String, Option<McpServer>> = IndexMap::new();
        let mut affected_apps = HashSet::new();

        for server in servers {
            crate::mcp::validation::validate_server_spec(&server.server)?;
            if snapshots.contains_key(&server.id) {
                return Err(AppError::InvalidInput(format!(
                    "Duplicate MCP server id: {}",
                    server.id
                )));
            }

            let previous = existing.get(&server.id).cloned();
            affected_apps.extend(Self::affected_apps(previous.as_ref(), Some(server)));
            snapshots.insert(server.id.clone(), previous);
        }

        for server in servers {
            if let Err(primary_error) = state.db.save_mcp_server(server) {
                return Err(Self::rollback_changes(
                    state,
                    &snapshots,
                    &affected_apps,
                    primary_error,
                ));
            }
        }

        if let Err(primary_error) = Self::sync_apps(state, &affected_apps) {
            return Err(Self::rollback_changes(
                state,
                &snapshots,
                &affected_apps,
                primary_error,
            ));
        }

        Ok(())
    }

    /// 删除 MCP 服务器
    pub fn delete_server(state: &AppState, id: &str) -> Result<bool, AppError> {
        let previous = state.db.get_all_mcp_servers()?.get(id).cloned();

        if previous.is_none() {
            return Ok(false);
        }

        let mut snapshots = IndexMap::new();
        snapshots.insert(id.to_string(), previous);
        let affected_apps = Self::affected_apps(snapshots.get(id).and_then(|s| s.as_ref()), None);

        state.db.delete_mcp_server(id)?;

        // Once the DB row is gone, projection cannot discover its old ID.
        // Remove that exact entry first, retaining unrelated client-only servers.
        let previous_spec = snapshots
            .get(id)
            .and_then(|s| s.as_ref())
            .map(|server| &server.server);
        let removal = affected_apps
            .iter()
            .try_for_each(|app| Self::remove_server_from_app(state, id, previous_spec, app))
            .and_then(|_| Self::sync_apps(state, &affected_apps));
        if let Err(primary_error) = removal {
            return Err(Self::rollback_changes(
                state,
                &snapshots,
                &affected_apps,
                primary_error,
            ));
        }

        Ok(true)
    }

    /// 切换指定应用的启用状态
    pub fn toggle_app(
        state: &AppState,
        server_id: &str,
        app: AppType,
        enabled: bool,
    ) -> Result<(), AppError> {
        let previous = state.db.get_all_mcp_servers()?.get(server_id).cloned();

        let Some(previous_server) = previous.clone() else {
            return Ok(());
        };

        let updated = if app == AppType::Codex {
            codex_toggle_target(&previous_server, enabled)
        } else {
            let mut u = previous_server.clone();
            u.apps.set_enabled_for(&app, enabled);
            if enabled {
                if let Some(obj) = u.server.as_object_mut() {
                    obj.remove("enabled");
                }
            }
            u
        };

        let mut snapshots = IndexMap::new();
        snapshots.insert(server_id.to_string(), previous.clone());
        let affected_apps = Self::affected_apps(previous.as_ref(), Some(&updated));

        state.db.save_mcp_server(&updated)?;

        if let Err(primary_error) = Self::sync_apps(state, &affected_apps) {
            return Err(Self::rollback_changes(
                state,
                &snapshots,
                &affected_apps,
                primary_error,
            ));
        }

        Ok(())
    }

    fn affected_apps(before: Option<&McpServer>, after: Option<&McpServer>) -> HashSet<AppType> {
        let mut affected = HashSet::new();
        if let Some(server) = before {
            affected.extend(server.apps.enabled_apps());
        }
        if let Some(server) = after {
            affected.extend(server.apps.enabled_apps());
        }
        affected
    }

    fn sync_apps(state: &AppState, apps: &HashSet<AppType>) -> Result<(), AppError> {
        let mut failures = Vec::new();
        for app in AppType::all().filter(|candidate| apps.contains(candidate)) {
            if let Err(error) = Self::sync_enabled_for_app(state, &app) {
                failures.push(format!("{}: {error}", app.as_str()));
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Message(format!(
                "MCP live 配置同步失败: {}",
                failures.join("; ")
            )))
        }
    }

    fn restore_snapshots(
        state: &AppState,
        snapshots: &IndexMap<String, Option<McpServer>>,
    ) -> Result<(), AppError> {
        for (id, previous) in snapshots {
            match previous {
                Some(server) => state.db.save_mcp_server(server)?,
                None => state.db.delete_mcp_server(id)?,
            }
        }
        Ok(())
    }

    fn rollback_changes(
        state: &AppState,
        snapshots: &IndexMap<String, Option<McpServer>>,
        affected_apps: &HashSet<AppType>,
        primary_error: AppError,
    ) -> AppError {
        let mut errors = vec![primary_error.to_string()];

        if let Err(error) = Self::restore_snapshots(state, snapshots) {
            errors.push(format!("数据库回滚失败: {error}"));
        }
        if let Err(error) = Self::sync_apps(state, affected_apps) {
            errors.push(format!("live 配置回滚失败: {error}"));
        }

        AppError::Message(format!("MCP 操作失败并已尝试回滚: {}", errors.join("; ")))
    }

    /// MH-24: run `f` with the Codex MCP projection ledger and store it
    /// afterwards, also when `f` failed part-way (live may already differ).
    fn with_codex_ledger(
        state: &AppState,
        f: impl FnOnce(&mut mcp::CodexMcpLedger) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let mut ledger = mcp::CodexMcpLedger::load(&state.db)?;
        let result = f(&mut ledger);
        ledger.save(&state.db)?;
        result
    }

    /// 将 MCP 服务器同步到指定应用
    fn sync_server_to_app(
        state: &AppState,
        server: &McpServer,
        app: &AppType,
    ) -> Result<(), AppError> {
        match app {
            AppType::Claude => {
                mcp::sync_single_server_to_claude(&Default::default(), &server.id, &server.server)?;
            }
            AppType::ClaudeDesktop => {
                log::debug!("Claude Desktop 3P profiles do not use CC Switch MCP sync, skipping");
            }
            AppType::Codex => {
                // Codex uses TOML format, must use the correct function
                Self::with_codex_ledger(state, |ledger| {
                    mcp::sync_single_server_to_codex(ledger, &server.id, &server.server)
                })?;
            }
            AppType::Gemini => {
                mcp::sync_single_server_to_gemini(&Default::default(), &server.id, &server.server)?;
            }
            AppType::GrokBuild => {
                mcp::sync_single_server_to_grokbuild(
                    &Default::default(),
                    &server.id,
                    &server.server,
                )?;
            }
            AppType::OpenCode => {
                mcp::sync_single_server_to_opencode(
                    &Default::default(),
                    &server.id,
                    &server.server,
                )?;
            }
            AppType::OpenClaw => {
                // OpenClaw MCP support is still in development (Issue #4834)
                // Skip for now
                log::debug!("OpenClaw MCP support is still in development, skipping sync");
            }
            AppType::Hermes => {
                mcp::sync_single_server_to_hermes(&Default::default(), &server.id, &server.server)?;
            }
            AppType::Pi | AppType::Mcode => {
                log::debug!("{} MCP is not managed, skipping sync", app.as_str());
            }
        }
        Ok(())
    }

    /// `spec` is the server's last DB definition, when known; Codex uses it
    /// to recognise an entry projected before the MH-24 ledger existed.
    fn remove_server_from_app(
        state: &AppState,
        id: &str,
        spec: Option<&serde_json::Value>,
        app: &AppType,
    ) -> Result<(), AppError> {
        match app {
            AppType::Claude => mcp::remove_server_from_claude(id)?,
            AppType::ClaudeDesktop => {
                log::debug!("Claude Desktop 3P profiles do not use CC Switch MCP sync, skipping");
            }
            AppType::Codex => Self::with_codex_ledger(state, |ledger| {
                mcp::remove_server_from_codex(ledger, id, spec)
            })?,
            AppType::Gemini => mcp::remove_server_from_gemini(id)?,
            AppType::GrokBuild => mcp::remove_server_from_grokbuild(id)?,
            AppType::OpenCode => {
                mcp::remove_server_from_opencode(id)?;
            }
            AppType::OpenClaw => {
                // OpenClaw MCP support is still in development
                log::debug!("OpenClaw MCP support is still in development, skipping remove");
            }
            AppType::Hermes => {
                mcp::remove_server_from_hermes(id)?;
            }
            AppType::Pi | AppType::Mcode => {
                log::debug!("{} MCP is not managed, skipping remove", app.as_str());
            }
        }
        Ok(())
    }

    /// 手动同步所有启用的 MCP 服务器到对应的应用。
    ///
    /// Best-effort：单个应用投影失败（如 ~/.claude.json 坏 JSON）不阻断
    /// 其余应用——各应用的 live 文件互相独立，一处损坏没有理由让其他
    /// 应用的 MCP 状态陈旧。全部跑完后若有失败，聚合成一个错误上报，
    /// 保留调用方的可见性。
    pub fn sync_all_enabled(state: &AppState) -> Result<(), AppError> {
        let servers = Self::get_all_servers(state)?;

        let mut failures: Vec<String> = Vec::new();
        for app in AppType::all() {
            if let Err(err) = Self::project_servers_to_app(state, &servers, &app) {
                log::warn!("同步 MCP 到 {app:?} 失败: {err}");
                failures.push(format!("{}: {err}", app.as_str()));
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Message(format!(
                "部分应用 MCP 同步失败: {}",
                failures.join("; ")
            )))
        }
    }

    /// 只把启用状态投影到单个应用。某个应用的 live 被整体重写后用它做
    /// 定向重投影，避免把无关应用的失败面（如 ~/.claude.json 坏 JSON）
    /// 牵连进目标应用的关键路径。
    pub fn sync_enabled_for_app(state: &AppState, app: &AppType) -> Result<(), AppError> {
        let servers = Self::get_all_servers(state)?;
        Self::project_servers_to_app(state, &servers, app)
    }

    fn project_servers_to_app(
        state: &AppState,
        servers: &IndexMap<String, McpServer>,
        app: &AppType,
    ) -> Result<(), AppError> {
        // Pi and MiniMax Code MCP are not managed: never project into (or remove from) them.
        if matches!(
            app,
            AppType::OpenClaw | AppType::ClaudeDesktop | AppType::Pi | AppType::Mcode
        ) {
            return Ok(());
        }
        if matches!(app, AppType::Codex) {
            // One ledger round-trip for the whole projection.
            return Self::with_codex_ledger(state, |ledger| {
                servers.values().try_for_each(|server| {
                    if server.apps.is_enabled_for(app) {
                        mcp::sync_single_server_to_codex(ledger, &server.id, &server.server)
                    } else {
                        mcp::remove_server_from_codex(ledger, &server.id, Some(&server.server))
                    }
                })
            });
        }

        for server in servers.values() {
            if server.apps.is_enabled_for(app) {
                Self::sync_server_to_app(state, server, app)?;
            } else {
                Self::remove_server_from_app(state, &server.id, Some(&server.server), app)?;
            }
        }

        Ok(())
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
        let servers = Self::get_all_servers(state)?;

        for server in servers.values() {
            if server.apps.is_enabled_for(&app) {
                Self::sync_server_to_app(state, server, &app)?;
            }
        }

        Ok(())
    }

    /// 从 Claude 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_claude(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_claude(&mut temp_config)?;
        Self::save_imported(state, count, &temp_config, &AppType::Claude)
    }

    /// 从 Codex 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_codex(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_codex(&mut temp_config)?;
        Self::save_imported(state, count, &temp_config, &AppType::Codex)
    }

    /// 从 Gemini 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_gemini(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_gemini(&mut temp_config)?;
        Self::save_imported(state, count, &temp_config, &AppType::Gemini)
    }

    /// 从 Grok Build 的 `[mcp_servers]` 导入 MCP。
    pub fn import_from_grokbuild(state: &AppState) -> Result<usize, AppError> {
        let mut temp_config = crate::app_config::MultiAppConfig::default();
        let count = crate::mcp::import_from_grokbuild(&mut temp_config)?;
        Self::save_imported(state, count, &temp_config, &AppType::GrokBuild)
    }

    /// 从 OpenCode 导入 MCP（v3.9.2+ 新增）
    pub fn import_from_opencode(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp/opencode.rs）
        let count = crate::mcp::import_from_opencode(&mut temp_config)?;
        Self::save_imported(state, count, &temp_config, &AppType::OpenCode)
    }

    /// 从 Hermes 导入 MCP
    pub fn import_from_hermes(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用导入逻辑（从 mcp/hermes.rs）
        let count = crate::mcp::import_from_hermes(&mut temp_config)?;
        Self::save_imported(state, count, &temp_config, &AppType::Hermes)
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
    /// new rows. A known id only gets `app` enabled (other fields kept). A
    /// server whose content already exists under another id is skipped, so
    /// an import never creates a duplicate that would then be projected a
    /// second time under the new id. Imports never write any live config.
    fn save_imported_servers(
        state: &AppState,
        servers: &HashMap<String, McpServer>,
        app: &AppType,
    ) -> Result<usize, AppError> {
        let mut existing = state.db.get_all_mcp_servers()?;
        let mut new_count = 0;
        for server in servers.values() {
            let to_save = match import_target(&existing, server) {
                ImportTarget::SameId(mut merged) => {
                    merged.apps.set_enabled_for(app, true);
                    merged
                }
                ImportTarget::SameContent(other) => {
                    log::info!(
                        "跳过重复创建 MCP 服务器 '{}'：与已有的 '{other}' 内容相同，关联到该应用",
                        server.id
                    );
                    if let Some(existing_server) = existing.get_mut(&other) {
                        if !existing_server.apps.is_enabled_for(app) {
                            existing_server.apps.set_enabled_for(app, true);
                            state.db.save_mcp_server(existing_server)?;
                        }
                    }
                    continue;
                }
                ImportTarget::New => {
                    new_count += 1;
                    server.clone()
                }
            };
            state.db.save_mcp_server(&to_save)?;
            existing.insert(to_save.id.clone(), to_save);
        }
        Ok(new_count)
    }

    /// 06B switch: only this server's Codex section changes. For a
    /// Codex-only server, off keeps the section (and the token in it) with
    /// `enabled = false`; for a server shared with other apps, off removes it
    /// from Codex only. Returns whether anything changed. The caller holds
    /// the Codex switch lock.
    pub fn set_codex_enabled(state: &AppState, id: &str, enabled: bool) -> Result<bool, AppError> {
        let Some(previous) = state.db.get_all_mcp_servers()?.get(id).cloned() else {
            return Err(AppError::InvalidInput(format!("MCP 服务器不存在: {id}")));
        };
        let updated = codex_toggle_target(&previous, enabled);
        if updated.apps == previous.apps && updated.server == previous.server {
            return Ok(false);
        }
        crate::mcp::validation::validate_server_spec(&updated.server)?;
        state.db.save_mcp_server(&updated)?;
        if let Err(primary_error) = Self::sync_enabled_for_app(state, &AppType::Codex) {
            let mut snapshots = IndexMap::new();
            snapshots.insert(id.to_string(), Some(previous));
            let apps = HashSet::from([AppType::Codex]);
            return Err(Self::rollback_changes(
                state,
                &snapshots,
                &apps,
                primary_error,
            ));
        }
        Ok(true)
    }

    /// 从所有支持 MCP 的应用导入服务器，返回新导入的数量。
    ///
    /// Best-effort：单个应用导入失败（如坏 config.toml）不阻断其余应用；
    /// 全部跑完后若有失败，聚合成一个错误上报——历史实现逐应用
    /// `unwrap_or(0)` 吞错，坏文件只会表现为"导入成功 0 个"，用户
    /// 无从得知哪个应用出了问题。
    pub fn import_from_all_apps(state: &AppState) -> Result<usize, AppError> {
        let mut total = 0;
        let mut failures: Vec<String> = Vec::new();

        let results: [(&str, Result<usize, AppError>); 6] = [
            ("claude", Self::import_from_claude(state)),
            ("codex", Self::import_from_codex(state)),
            ("gemini", Self::import_from_gemini(state)),
            ("grokbuild", Self::import_from_grokbuild(state)),
            ("opencode", Self::import_from_opencode(state)),
            ("hermes", Self::import_from_hermes(state)),
        ];
        for (app, result) in results {
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
    New,
}

pub(crate) fn import_target(
    existing: &IndexMap<String, McpServer>,
    incoming: &McpServer,
) -> ImportTarget {
    if let Some(found) = existing.get(&incoming.id) {
        return ImportTarget::SameId(found.clone());
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
            Some("http" | "sse" | "streamable_http") => "http",
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

/// Whether Codex loads this server: enabled for Codex and not switched off
/// with the Codex `enabled = false` override.
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
        // Same id: merged into the stored row.
        let same_id = server("gh", json!({"command": "other"}), McpApps::default());
        assert!(matches!(
            import_target(&existing, &same_id),
            ImportTarget::SameId(found) if found.server["command"] == "npx"
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
