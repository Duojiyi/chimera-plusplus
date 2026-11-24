//! Provider service module
//!
//! Handles provider CRUD operations, switching, and configuration management.

mod codex_ownership;
mod endpoints;
pub(crate) mod first_write;
mod gemini_auth;
mod live;

mod pi;
mod update;
mod usage;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

use crate::app_config::AppType;
use crate::database::{validate_cost_multiplier, validate_pricing_source};
use crate::error::AppError;
use crate::provider::{Provider, UsageResult};
use crate::services::mcp::McpService;
use crate::settings::CustomEndpoint;
use crate::store::AppState;

// Re-export sub-module functions for external access
pub use live::{
    import_default_config, import_opencode_providers_from_live, read_live_settings,
    should_import_default_config_on_startup, sync_current_to_live, sync_current_to_live_except,
    update_toml_common_config_snippet,
};

// Internal re-exports (pub(crate))
pub(crate) use live::{
    build_effective_settings_with_common_config, codex_common_snippet,
    normalize_provider_common_config_for_storage, provider_exists_in_live_config,
    provider_uses_common_config, strip_common_config_from_live_settings,
    sync_current_provider_for_app_to_live, write_live_with_common_config, LiveSnapshot,
};
pub(crate) use live::{sanitize_claude_settings_for_live, write_claude_provider_settings};

// Internal re-exports
use live::{remove_opencode_provider_from_live, write_gemini_live};
use usage::validate_usage_script;

/// Save-time check for a line's custom request headers (CPP-A7), only while
/// the `custom_request_headers` capability is `enabled`: rows written before
/// the feature existed keep saving unchanged.
fn validate_request_header_overrides(
    overrides: &crate::provider::LocalProxyRequestOverrides,
    enabled: bool,
) -> Result<(), AppError> {
    if !enabled {
        return Ok(());
    }
    overrides.validate_headers()
}

/// The built-in Codex official provider is safe to select during takeover:
/// Codex keeps ownership of its ChatGPT login and the proxy only forwards the
/// authenticated request. Other official providers retain the existing block.
pub fn official_provider_supports_proxy_takeover(app_type: &AppType, provider: &Provider) -> bool {
    matches!(app_type, AppType::Codex)
        && crate::proxy::providers::is_codex_official_provider(provider)
}

pub(crate) fn official_provider_blocked_during_takeover(
    app_type: &AppType,
    provider: &Provider,
) -> bool {
    provider.category.as_deref() == Some("official")
        && !official_provider_supports_proxy_takeover(app_type, provider)
}

/// 统一会话开关变更后，立即按新开关状态重写当前官方 Codex 供应商的
/// live 配置，使开关即时生效（无需等下一次切换）。
/// 当前供应商非官方（或不存在）时为 no-op：注入只作用于官方配置，
/// 第三方 live 配置不受开关影响。
pub async fn reapply_current_codex_official_live(state: &AppState) -> Result<bool, AppError> {
    let current_id = ProviderService::current(state, AppType::Codex)?;
    if current_id.is_empty() {
        return Ok(false);
    }
    let providers = state.db.get_all_providers(AppType::Codex.as_str())?;
    let Some(provider) = providers.get(&current_id) else {
        return Ok(false);
    };
    if provider.category.as_deref() != Some("official") {
        return Ok(false);
    }

    // 代理接管期间 live 归代理所有（开启代理时官方供应商只警告不拦截，
    // 二者可以共存）。与切换/保存路径一致：以 backup/占位符为所有权信号，
    // 先更新备份（注入后的配置由接管释放时的恢复路径落盘）。
    let has_live_backup = state
        .db
        .get_live_backup(AppType::Codex.as_str())
        .await
        .ok()
        .flatten()
        .is_some();
    let live_taken_over = state
        .proxy_service
        .detect_takeover_in_live_config_for_app(&AppType::Codex);
    if has_live_backup || live_taken_over {
        let _switch_guard = state
            .proxy_service
            .lock_switch_for_app(AppType::Codex.as_str())
            .await;
        state
            .proxy_service
            .update_live_backup_from_provider_inner(AppType::Codex.as_str(), provider)
            .await
            .map_err(|e| AppError::Message(format!("更新 Live 备份失败: {e}")))?;
        // 2.8.6 起接管路由沿用直连时的会话桶（开关开 = custom 镜像，关 =
        // openai_base_url），所以接管中的 live 也要按新开关重写，否则到释放前
        // 新会话仍落旧桶。与保存供应商路径相同，只在代理运行且锁内复核仍处于
        // 接管时重写；失败只记警告：备份已是新形态，释放时照常落盘，回滚开关
        // 反而会让备份与开关分裂。
        if state
            .proxy_service
            .detect_takeover_in_live_config_for_app(&AppType::Codex)
            && state.proxy_service.is_running().await
        {
            if let Err(err) = state
                .proxy_service
                .sync_codex_live_from_provider_while_proxy_active(provider)
                .await
            {
                log::warn!(
                    "统一会话开关变更后重写接管中的 Codex live 失败（释放接管时按备份落盘）: {err}"
                );
            }
        }
        return Ok(true);
    }

    live::write_live_with_common_config(&state.db, &AppType::Codex, provider)?;
    // 写 live 按键所有权表投影（live 的 [mcp_servers] 保留），写完从 DB
    // 按投影台账重新投影启用的 MCP，使其与 DB 对齐。只投影 Codex 而非
    // sync_all_enabled：后者按 AppType::all() 顺序逐应用短路，排在 Codex
    // 前面的无关应用 live 损坏（如 ~/.claude.json 坏 JSON）会阻断 Codex
    // 的重投影，让刚被清掉的 [mcp_servers] 无人补回。
    // 投影失败降级为警告：走到这里 live 已按新开关状态落盘，开关事实上
    // 已生效；若把错误上抛，save_settings 会回滚开关设置，制造"设置=旧值、
    // live=新桶"的会话分裂——正是该回滚要防止的状态。MCP 投影可自愈
    // （下次切换 / 任一 MCP 启停操作都会重新投影）。
    if let Err(err) = McpService::sync_enabled_for_app(state, &AppType::Codex) {
        log::warn!("统一会话开关重写 live 后重投影 Codex MCP 失败（将在下次同步时自愈）: {err}");
    }
    Ok(true)
}

/// Provider business logic service
pub struct ProviderService;

/// Result of a provider switch operation, including any non-fatal warnings
#[derive(Debug, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    pub warnings: Vec<String>,
    /// Whether this switch automatically changed the app's local-routing takeover state.
    pub routing_changed: bool,
    /// The resulting takeover state when routing is managed automatically for this app.
    pub routing_enabled: Option<bool>,
}

#[cfg(test)]
mod tests;

impl ProviderService {
    /// MH-8c 1.7: store only `wire_api = "responses"`; the declared protocol
    /// moves to `meta.apiFormat` (see `normalize_codex_provider_wire_api`).
    fn normalize_codex_wire_api(app_type: &AppType, provider: &mut Provider) {
        if matches!(app_type, AppType::Codex) {
            crate::proxy::providers::normalize_codex_provider_wire_api(provider);
        }
    }

    fn normalize_provider_if_claude(app_type: &AppType, provider: &mut Provider) {
        if matches!(app_type, AppType::Claude) {
            let mut v = provider.settings_config.clone();
            if normalize_claude_models_in_value(&mut v) {
                provider.settings_config = v;
            }
        }
    }

    /// Check whether a provider exists in live config, tolerating parse errors
    /// only for providers that are explicitly marked as DB-only.
    fn check_live_config_exists(
        app_type: &AppType,
        provider_id: &str,
        live_config_managed: Option<bool>,
    ) -> Result<bool, AppError> {
        if live_config_managed == Some(false) {
            Ok(provider_exists_in_live_config(app_type, provider_id).unwrap_or(false))
        } else {
            provider_exists_in_live_config(app_type, provider_id)
        }
    }

    fn provider_live_config_managed(provider: &Provider) -> Option<bool> {
        provider
            .meta
            .as_ref()
            .and_then(|meta| meta.live_config_managed)
    }

    fn set_provider_live_config_managed(provider: &mut Provider, managed: bool) {
        provider
            .meta
            .get_or_insert_with(Default::default)
            .live_config_managed = Some(managed);
    }

    fn normalize_usage_script_credential_overrides(app_type: &AppType, provider: &mut Provider) {
        let current_credentials = provider.resolve_usage_credentials(app_type);

        let Some(usage_script) = provider
            .meta
            .as_mut()
            .and_then(|meta| meta.usage_script.as_mut())
        else {
            return;
        };

        if usage_script.template_type.as_deref() == Some("token_plan") {
            return;
        }

        if usage_script.api_key.as_deref().is_some_and(|api_key| {
            Self::should_clear_usage_api_key_override(api_key, &current_credentials)
        }) {
            usage_script.api_key = None;
        }

        if usage_script.base_url.as_deref().is_some_and(|base_url| {
            Self::should_clear_usage_base_url_override(base_url, &current_credentials)
        }) {
            usage_script.base_url = None;
        }
    }

    fn should_clear_usage_api_key_override(
        script_api_key: &str,
        current_credentials: &(String, String),
    ) -> bool {
        let candidate = script_api_key.trim();
        if candidate.is_empty() {
            return true;
        }

        let matches_provider_key = |api_key: &str| {
            let api_key = api_key.trim();
            !api_key.is_empty() && api_key == candidate
        };

        matches_provider_key(&current_credentials.1)
    }

    fn should_clear_usage_base_url_override(
        script_base_url: &str,
        current_credentials: &(String, String),
    ) -> bool {
        let candidate = Self::normalize_usage_base_url_for_compare(script_base_url);
        if candidate.is_empty() {
            return true;
        }

        let matches_provider_base_url = |base_url: &str| {
            let base_url = Self::normalize_usage_base_url_for_compare(base_url);
            !base_url.is_empty() && base_url == candidate
        };

        matches_provider_base_url(&current_credentials.0)
    }

    fn normalize_usage_base_url_for_compare(base_url: &str) -> String {
        base_url.trim().trim_end_matches('/').to_string()
    }

    /// List all providers for an app type
    pub fn list(
        state: &AppState,
        app_type: AppType,
    ) -> Result<IndexMap<String, Provider>, AppError> {
        if app_type == AppType::Pi {
            return pi::list(state);
        }
        let mut providers = state.db.get_all_providers(app_type.as_str())?;
        // Read membership once, without importing native credentials or persisting
        // the derived flags. An unreadable config must not look enabled by default.
        let live = match app_type {
            AppType::OpenCode => crate::opencode_config::get_providers()?,

            _ => return Ok(providers),
        };
        for (id, provider) in providers.iter_mut() {
            // OMO variants use separate plugin files, not OpenCode's provider map.
            if app_type == AppType::OpenCode
                && matches!(provider.category.as_deref(), Some("omo" | "omo-slim"))
            {
                continue;
            }
            Self::set_provider_live_config_managed(provider, live.contains_key(id));
        }
        Ok(providers)
    }

    /// Get current provider ID
    ///
    /// 使用有效的当前供应商 ID（验证过存在性）。
    /// 优先从本地 settings 读取，验证后 fallback 到数据库的 is_current 字段。
    /// 这确保了云同步场景下多设备可以独立选择供应商，且返回的 ID 一定有效。
    ///
    pub fn current(state: &AppState, app_type: AppType) -> Result<String, AppError> {
        // Additive mode apps have no "current" provider concept
        if app_type.is_additive_mode() {
            return Ok(String::new());
        }
        crate::settings::get_effective_current_provider(&state.db, &app_type)
            .map(|opt| opt.unwrap_or_default())
    }

    /// Persist a provider without selecting it or mutating Live config.
    ///
    /// Used by multi-step transactions (for example enabled deep-link imports)
    /// that must not expose a provider until routing and Live reconciliation can
    /// commit successfully. The caller is responsible for deleting the staged
    /// row if the later transaction fails.
    pub(crate) fn add_inactive(
        state: &AppState,
        app_type: AppType,
        provider: Provider,
        intended_live_enabled: bool,
    ) -> Result<bool, AppError> {
        // Staging a Pi row never touches models.json (Pi deep links are import-only).
        if app_type == AppType::Pi {
            return pi::add(state, provider, false);
        }
        let mut provider = provider;
        Self::normalize_provider_if_claude(&app_type, &mut provider);
        Self::normalize_codex_wire_api(&app_type, &mut provider);
        Self::validate_provider_settings(&app_type, &provider)?;
        Self::sanitize_codex_provider_config(&app_type, &mut provider)?;
        normalize_provider_common_config_for_storage(state.db.as_ref(), &app_type, &mut provider)?;
        Self::normalize_usage_script_credential_overrides(&app_type, &mut provider);
        if app_type.is_additive_mode() {
            Self::set_provider_live_config_managed(&mut provider, intended_live_enabled);
        }
        state.db.save_provider(app_type.as_str(), &provider)?;
        Ok(true)
    }

    /// Add a new provider
    pub fn add(
        state: &AppState,
        app_type: AppType,
        provider: Provider,
        add_to_live: bool,
    ) -> Result<bool, AppError> {
        if app_type == AppType::Pi {
            return pi::add(state, provider, add_to_live);
        }
        let mut provider = provider;
        // Normalize Claude model keys
        Self::normalize_provider_if_claude(&app_type, &mut provider);
        Self::normalize_codex_wire_api(&app_type, &mut provider);
        Self::validate_provider_settings(&app_type, &provider)?;
        Self::sanitize_codex_provider_config(&app_type, &mut provider)?;
        normalize_provider_common_config_for_storage(state.db.as_ref(), &app_type, &mut provider)?;
        Self::normalize_usage_script_credential_overrides(&app_type, &mut provider);
        if app_type.is_additive_mode() {
            Self::set_provider_live_config_managed(&mut provider, add_to_live);
        }

        // Save to database
        state.db.save_provider(app_type.as_str(), &provider)?;
        if app_type.is_additive_mode() {
            // OMO / OMO Slim providers use exclusive mode and write to dedicated config file.
            if matches!(app_type, AppType::OpenCode)
                && matches!(provider.category.as_deref(), Some("omo") | Some("omo-slim"))
            {
                // Do not auto-enable newly added OMO / OMO Slim providers.
                // Users must explicitly switch/apply an OMO provider to activate it.
                return Ok(true);
            }
            if !add_to_live {
                return Ok(true);
            }
            if let Err(error) =
                write_live_with_common_config(state.db.as_ref(), &app_type, &provider)
            {
                // The row was added a moment ago; a live file that cannot be
                // written (damaged OpenCode config, for example) must not leave
                // an orphan that looks configured but is not applied.
                if let Err(rollback) = state.db.delete_provider(app_type.as_str(), &provider.id) {
                    log::warn!("回滚新增线路 {} 失败: {rollback}", provider.id);
                }
                return Err(error);
            }
            return Ok(true);
        }

        // For other apps: Check if sync is needed (if this is current provider, or no current provider)
        let current = state.db.get_current_provider(app_type.as_str())?;
        if current.is_none() {
            // No current provider, set as current and sync
            state
                .db
                .set_current_provider(app_type.as_str(), &provider.id)?;
            write_live_with_common_config(state.db.as_ref(), &app_type, &provider)?;
        }

        Ok(true)
    }

    fn lock_app(state: &AppState, app: &AppType) -> tokio::sync::OwnedMutexGuard<()> {
        futures::executor::block_on(state.proxy_service.lock_switch_for_app(app.as_str()))
    }

    /// Update a provider.
    pub fn update(
        state: &AppState,
        app_type: AppType,
        original_id: Option<&str>,
        provider: Provider,
    ) -> Result<bool, AppError> {
        if !matches!(app_type, AppType::Codex | AppType::GrokBuild) {
            let _guard = Self::lock_app(state, &app_type);
            return Self::update_direct_with_app_lock_held(
                state,
                app_type,
                original_id,
                provider,
                false,
            );
        }
        Self::update_internal(state, app_type, original_id, provider, false)
    }

    /// Update while the caller already owns the per-app provider/proxy switch
    /// lock. This avoids recursively acquiring that same lock when a current,
    /// takeover-owned provider refreshes its direct Live backup.
    pub(crate) fn update_with_app_lock_held(
        state: &AppState,
        app_type: AppType,
        original_id: Option<&str>,
        provider: Provider,
    ) -> Result<bool, AppError> {
        Self::update_internal(state, app_type, original_id, provider, true)
    }

    fn update_internal(
        state: &AppState,
        app_type: AppType,
        original_id: Option<&str>,
        provider: Provider,
        app_lock_held: bool,
    ) -> Result<bool, AppError> {
        if app_type == AppType::Pi {
            return pi::update(state, original_id, provider, app_lock_held);
        }
        let mut provider = provider;
        let original_id = original_id.unwrap_or(provider.id.as_str()).to_string();
        let provider_id_changed = original_id != provider.id;
        let existing_provider = state
            .db
            .get_provider_by_id(&original_id, app_type.as_str())?;
        // Normalize Claude model keys
        Self::normalize_provider_if_claude(&app_type, &mut provider);
        Self::normalize_codex_wire_api(&app_type, &mut provider);
        Self::validate_provider_settings(&app_type, &provider)?;
        Self::sanitize_codex_provider_config(&app_type, &mut provider)?;
        normalize_provider_common_config_for_storage(state.db.as_ref(), &app_type, &mut provider)?;
        Self::normalize_usage_script_credential_overrides(&app_type, &mut provider);

        if provider_id_changed {
            if !app_type.is_additive_mode() {
                return Err(AppError::Message(
                    "Only additive-mode providers support changing provider key".to_string(),
                ));
            }

            let Some(existing_provider) = existing_provider else {
                return Err(AppError::Message(format!(
                    "Original provider '{}' does not exist in app '{}'",
                    original_id,
                    app_type.as_str()
                )));
            };

            // OMO / OMO Slim providers are activated via a dedicated current-state mechanism
            // (set_omo_provider_current) that is NOT captured by provider_exists_in_live_config,
            // which only checks opencode.json. A rename would orphan that current-state marker
            // and silently break subsequent OMO file syncs. Block it unconditionally.
            if matches!(app_type, AppType::OpenCode)
                && matches!(
                    existing_provider.category.as_deref(),
                    Some("omo") | Some("omo-slim")
                )
            {
                return Err(AppError::Message(
                    "Provider key cannot be changed for OMO/OMO Slim providers".to_string(),
                ));
            }

            let original_in_live = Self::check_live_config_exists(
                &app_type,
                &original_id,
                Self::provider_live_config_managed(&existing_provider),
            )?;
            if original_in_live {
                return Err(AppError::Message(
                    "Provider key cannot be changed after the provider has been added to the app config"
                        .to_string(),
                ));
            }

            let next_id_in_live = Self::check_live_config_exists(
                &app_type,
                &provider.id,
                Self::provider_live_config_managed(&existing_provider),
            )?;
            if state
                .db
                .get_provider_by_id(&provider.id, app_type.as_str())?
                .is_some()
                || next_id_in_live
            {
                return Err(AppError::Message(format!(
                    "Provider '{}' already exists in app '{}'",
                    provider.id,
                    app_type.as_str()
                )));
            }

            Self::set_provider_live_config_managed(&mut provider, false);
            state.db.save_provider(app_type.as_str(), &provider)?;
            state.db.delete_provider(app_type.as_str(), &original_id)?;

            if crate::settings::get_current_provider(&app_type).as_deref() == Some(&original_id) {
                crate::settings::set_current_provider(&app_type, Some(provider.id.as_str()))?;
            }

            return Ok(true);
        }
        // already exists in live config. Editing a DB-only provider must not auto-add it.
        if app_type.is_additive_mode() {
            let omo_variant = if matches!(app_type, AppType::OpenCode) {
                match provider.category.as_deref() {
                    Some("omo") => Some(&crate::services::omo::STANDARD),
                    Some("omo-slim") => Some(&crate::services::omo::SLIM),
                    _ => None,
                }
            } else {
                None
            };
            if let Some(variant) = omo_variant {
                let is_current = state.db.is_omo_provider_current(
                    app_type.as_str(),
                    &provider.id,
                    variant.category,
                )?;
                if is_current {
                    crate::services::OmoService::write_provider_config_to_file(&provider, variant)?;
                }
                // The outer compensated update checks the original file snapshots.
                // Rebuilding here has no write receipt and could clobber an editor.
                state.db.save_provider(app_type.as_str(), &provider)?;
                return Ok(true);
            }
            let live_config_managed = Self::check_live_config_exists(
                &app_type,
                &provider.id,
                Self::provider_live_config_managed(&provider).or_else(|| {
                    existing_provider
                        .as_ref()
                        .and_then(Self::provider_live_config_managed)
                }),
            )?;
            Self::set_provider_live_config_managed(&mut provider, live_config_managed);

            // Save to database after live-config presence is resolved so parse errors
            // do not report failure after already mutating DB state.
            state.db.save_provider(app_type.as_str(), &provider)?;

            if !live_config_managed {
                return Ok(true);
            }
            write_live_with_common_config(state.db.as_ref(), &app_type, &provider)?;
            return Ok(true);
        }

        // Save to database
        state.db.save_provider(app_type.as_str(), &provider)?;

        // For other apps: Check if this is current provider (use effective current, not just DB)
        let effective_current =
            crate::settings::get_effective_current_provider(&state.db, &app_type)?;
        let is_current = effective_current.as_deref() == Some(provider.id.as_str());

        if is_current {
            // 如果 Claude 代理接管处于激活状态，并且代理服务正在运行：
            // - 不直接走普通 Live 写入逻辑
            // - 改为更新 Live 备份，并在 Claude 下同步代理安全的 Live 配置
            let has_live_backup =
                futures::executor::block_on(state.db.get_live_backup(app_type.as_str()))
                    .ok()
                    .flatten()
                    .is_some();
            let live_taken_over = state
                .proxy_service
                .detect_takeover_in_live_config_for_app(&app_type);
            // Backup or live placeholders mean the live file is currently owned
            // by proxy takeover, including the short activation window before
            // proxy_config.enabled is committed.
            let should_sync_via_proxy = has_live_backup || live_taken_over;

            if should_sync_via_proxy {
                if matches!(app_type, AppType::ClaudeDesktop) {
                    write_live_with_common_config(state.db.as_ref(), &app_type, &provider)?;
                } else {
                    let backup_update = if app_lock_held {
                        futures::executor::block_on(
                            state.proxy_service.update_live_backup_from_provider_inner(
                                app_type.as_str(),
                                &provider,
                            ),
                        )
                    } else {
                        futures::executor::block_on(
                            state
                                .proxy_service
                                .update_live_backup_from_provider(app_type.as_str(), &provider),
                        )
                    };
                    backup_update
                        .map_err(|e| AppError::Message(format!("更新 Live 备份失败: {e}")))?;
                }

                if futures::executor::block_on(state.proxy_service.is_running()) {
                    if matches!(app_type, AppType::Claude) {
                        futures::executor::block_on(
                            state
                                .proxy_service
                                .sync_claude_live_from_provider_while_proxy_active(&provider),
                        )
                        .map_err(|e| {
                            AppError::Message(format!("同步 Claude Live 配置失败: {e}"))
                        })?;
                    } else if live_taken_over && matches!(app_type, AppType::Codex) {
                        // Codex model mappings are projected into a generated
                        // model_catalog_json file. Refresh takeover-owned Live
                        // immediately so adding/removing mappings cannot leave
                        // the previous catalog pointer and capabilities active.
                        futures::executor::block_on(
                            state
                                .proxy_service
                                .sync_codex_live_from_provider_while_proxy_active(&provider),
                        )
                        .map_err(|e| AppError::Message(format!("同步 Codex Live 配置失败: {e}")))?;
                    }
                }
            } else {
                write_live_with_common_config(state.db.as_ref(), &app_type, &provider)?;
                // 重写 live 后只重投影本应用的 MCP：全量 sync_all_enabled 会把
                // 无关应用的 live 损坏（如 ~/.claude.json 坏 JSON）牵连进保存
                // 流程。走到这里 DB 与 live 都已按新配置落盘，保存事实上已
                // 成功；投影失败降级为警告，避免制造"保存失败"假象（MCP
                // 投影可自愈：下次切换 / 任一 MCP 启停都会重新投影）。
                if let Err(err) = McpService::sync_enabled_for_app(state, &app_type) {
                    log::warn!(
                        "保存供应商后重投影 {app_type:?} MCP 失败（将在下次同步时自愈）: {err}"
                    );
                }
            }
        }

        Ok(true)
    }

    /// Delete a provider
    ///
    /// 同时检查本地 settings 和数据库的当前供应商，防止删除任一端正在使用的供应商。
    pub fn delete(state: &AppState, app_type: AppType, id: &str) -> Result<(), AppError> {
        let _guards = futures::executor::block_on(Self::lock_deletion(
            state,
            std::slice::from_ref(&app_type),
        ));
        Self::delete_with_locks_held(state, app_type, id)
    }

    // Lock order shared with profile application and automatic routing. Never
    // call this from a lock-held path or an async runtime worker: use a blocking
    // task at IPC boundaries. Universal operations pass apps in lexical order.
    async fn lock_deletion(
        state: &AppState,
        apps: &[AppType],
    ) -> Vec<tokio::sync::OwnedMutexGuard<()>> {
        let mut guards = vec![state.profile_apply_lock.clone().lock_owned().await];
        guards.push(state.proxy_service.lock_lifecycle().await);
        for app in apps {
            guards.push(state.proxy_service.lock_switch_for_app(app.as_str()).await);
        }
        guards
    }

    /// Refuse to delete the effective current line: the device-local pointer
    /// when it names an existing row, otherwise the DB `is_current` flag (the
    /// same choice as `settings::get_effective_current_provider`, which the
    /// line table uses to disable its delete button).
    ///
    /// With a valid local pointer the DB flag is only a fallback and can be
    /// stale. When it still names `id`, it is moved to the local pointer first
    /// so the DAO's atomic `is_current` guard does not refuse a line the table
    /// offers for deletion.
    // Adapted from farion1231/cc-switch 56ac4f9a
    fn ensure_not_current(state: &AppState, app_type: &AppType, id: &str) -> Result<(), AppError> {
        let in_use = || AppError::Message("无法删除当前正在使用的供应商".to_string());
        let local_current = crate::settings::get_current_provider(app_type);
        if local_current.as_deref() == Some(id) {
            return Err(in_use());
        }
        let db_current = state.db.get_current_provider(app_type.as_str())?;
        if db_current.as_deref() != Some(id) {
            return Ok(());
        }
        let valid_local = match local_current.as_deref() {
            Some(local) => state
                .db
                .get_provider_by_id(local, app_type.as_str())?
                .map(|_| local),
            None => None,
        };
        match valid_local {
            Some(local) => state.db.set_current_provider(app_type.as_str(), local),
            None => Err(in_use()),
        }
    }

    fn delete_with_locks_held(
        state: &AppState,
        app_type: AppType,
        id: &str,
    ) -> Result<(), AppError> {
        if app_type == AppType::Pi {
            return pi::delete_locked(state, id);
        }
        // Additive mode apps - no current provider concept
        if app_type.is_additive_mode() {
            // Single DB read shared across all additive-mode sub-paths below.
            let existing = state.db.get_provider_by_id(id, app_type.as_str())?;

            if matches!(app_type, AppType::OpenCode) {
                let provider_category = existing.as_ref().and_then(|p| p.category.clone());
                let omo_variant = match provider_category.as_deref() {
                    Some("omo") => Some(&crate::services::omo::STANDARD),
                    Some("omo-slim") => Some(&crate::services::omo::SLIM),
                    _ => None,
                };
                if let Some(variant) = omo_variant {
                    let was_current = state.db.is_omo_provider_current(
                        app_type.as_str(),
                        id,
                        variant.category,
                    )?;
                    state.db.delete_provider(app_type.as_str(), id)?;
                    if was_current {
                        crate::services::OmoService::delete_config_file(variant)?;
                    }
                    return Ok(());
                }
            }
            // remove from live first (atomicity), then DB.
            //
            // Use check_live_config_exists rather than trusting the flag alone: the flag
            // can be stale (Some(false) for a provider that was written to live before the
            // live_config_managed flip was introduced). check_live_config_exists reads the
            // actual file when the flag is Some(false), so it handles historical data correctly.
            let live_managed = existing
                .as_ref()
                .and_then(Self::provider_live_config_managed);
            if Self::check_live_config_exists(&app_type, id, live_managed)?
                && app_type == AppType::OpenCode
            {
                remove_opencode_provider_from_live(id)?;
            }
            state.db.delete_provider(app_type.as_str(), id)?;
            return Ok(());
        }

        Self::ensure_not_current(state, &app_type, id)?;
        state.db.delete_non_current_provider(app_type.as_str(), id)
    }

    fn delete_universal_child(state: &AppState, app: &AppType, id: &str) -> Result<(), AppError> {
        let child_id = format!("universal-{}-{id}", app.as_str());
        if state
            .db
            .get_provider_by_id(&child_id, app.as_str())?
            .is_some()
        {
            Self::delete_with_locks_held(state, app.clone(), &child_id)?;
        }
        Ok(())
    }
    ///
    /// Does NOT delete from database - provider remains in the list.
    /// This is used when user wants to "remove" a provider from active config
    /// but keep it available for future use.
    pub fn remove_from_live_config(
        state: &AppState,
        app_type: AppType,
        id: &str,
    ) -> Result<(), AppError> {
        if app_type == AppType::Pi {
            return pi::remove(state, id);
        }
        match app_type {
            AppType::OpenCode => {
                let provider_category = state
                    .db
                    .get_provider_by_id(id, app_type.as_str())?
                    .and_then(|p| p.category);

                let omo_variant = match provider_category.as_deref() {
                    Some("omo") => Some(&crate::services::omo::STANDARD),
                    Some("omo-slim") => Some(&crate::services::omo::SLIM),
                    _ => None,
                };
                if let Some(variant) = omo_variant {
                    state
                        .db
                        .clear_omo_provider_current(app_type.as_str(), id, variant.category)?;
                    let still_has_current = state
                        .db
                        .get_current_omo_provider("opencode", variant.category)?
                        .is_some();
                    if still_has_current {
                        crate::services::OmoService::write_config_to_file(state, variant)?;
                    } else {
                        crate::services::OmoService::delete_config_file(variant)?;
                    }
                } else {
                    remove_opencode_provider_from_live(id)?;
                }
            }

            _ => {
                return Err(AppError::Message(format!(
                    "App {} does not support remove from live config",
                    app_type.as_str()
                )));
            }
        }

        if let Some(mut provider) = state.db.get_provider_by_id(id, app_type.as_str())? {
            Self::set_provider_live_config_managed(&mut provider, false);
            state.db.save_provider(app_type.as_str(), &provider)?;
        }

        Ok(())
    }

    /// Switch to a provider
    ///
    /// Switch flow:
    /// 1. Validate target provider exists
    /// 2. Check if proxy takeover mode is active AND proxy server is running
    /// 3. If takeover mode active: hot-switch proxy target and refresh proxy-safe Live labels
    /// 4. If normal mode:
    ///    a. **Backfill mechanism**: Backfill current live config to current provider
    ///    b. Update local settings current_provider_xxx (device-level)
    ///    c. Update database is_current (as default for new devices)
    ///    d. Write target provider config to live files
    ///    e. Sync MCP configuration
    pub fn switch(state: &AppState, app_type: AppType, id: &str) -> Result<SwitchResult, AppError> {
        Self::switch_impl(state, app_type, id, true)
    }

    /// Switch while the caller already owns ProxyService's per-app switch lock.
    /// Used by the automatic-routing command so route reconciliation and the
    /// provider commit form one serialized transaction.
    pub(crate) fn switch_with_app_lock_held(
        state: &AppState,
        app_type: AppType,
        id: &str,
    ) -> Result<SwitchResult, AppError> {
        Self::switch_impl(state, app_type, id, false)
    }

    fn switch_impl(
        state: &AppState,
        app_type: AppType,
        id: &str,
        acquire_app_lock: bool,
    ) -> Result<SwitchResult, AppError> {
        // Acquire before reading the target, including Desktop/additive paths.
        // Otherwise a queued switch can resurrect a provider deleted while it waited.
        // Lock-held routing callers already own profile -> lifecycle -> app.
        let _switch_guard = if acquire_app_lock {
            Some(Self::lock_app(state, &app_type))
        } else {
            None
        };

        // "Switching" a Pi provider adds its models.json entry; nothing else moves.
        if app_type == AppType::Pi {
            return pi::enable_locked(state, id);
        }
        // Check if provider exists
        let providers = state.db.get_all_providers(app_type.as_str())?;
        let _provider = providers
            .get(id)
            .ok_or_else(|| AppError::Message(format!("供应商 {id} 不存在")))?;

        // OMO providers are switched through their own exclusive path.
        if matches!(app_type, AppType::OpenCode) && _provider.category.as_deref() == Some("omo") {
            return Self::switch_normal(state, app_type, id, &providers);
        }

        // OMO Slim providers are switched through their own exclusive path.
        if matches!(app_type, AppType::OpenCode)
            && _provider.category.as_deref() == Some("omo-slim")
        {
            return Self::switch_normal(state, app_type, id, &providers);
        }

        if matches!(app_type, AppType::ClaudeDesktop) {
            return Self::switch_normal(state, app_type, id, &providers);
        }

        // Backup or live placeholders mean the live file is owned by proxy
        // takeover, even if the proxy server is temporarily stopped or is in the
        // activation window before enabled=true is committed.
        let is_app_taken_over =
            futures::executor::block_on(state.db.get_live_backup(app_type.as_str()))
                .ok()
                .flatten()
                .is_some();
        let live_taken_over = state
            .proxy_service
            .detect_takeover_in_live_config_for_app(&app_type);

        let should_hot_switch = is_app_taken_over || live_taken_over;

        // Block switching to official providers when proxy takeover is active.
        // Using a proxy with official APIs (Anthropic/OpenAI/Google) may cause account bans.
        if should_hot_switch && official_provider_blocked_during_takeover(&app_type, _provider) {
            return Err(AppError::localized(
                "switch.official_blocked_by_proxy",
                "代理接管模式下不能切换到官方供应商，使用代理访问官方 API 可能导致账号被封禁。请先关闭代理接管，或选择第三方供应商。",
                "Cannot switch to official provider while proxy takeover is active. Using proxy with official APIs may cause account bans.",
            ));
        }

        if should_hot_switch {
            // Proxy takeover mode: hot-switch without restoring upstream Live config.
            // The proxy layer may still refresh proxy-safe Live fields so client labels
            // follow the selected provider while endpoints remain local.
            log::info!(
                "代理接管模式：热切换 {} 的目标供应商为 {}",
                app_type.as_str(),
                id
            );

            futures::executor::block_on(
                state
                    .proxy_service
                    .hot_switch_provider_inner(app_type.as_str(), id),
            )
            .map_err(|e| AppError::Message(format!("热切换失败: {e}")))?;

            // The proxy server will route requests to the new provider via is_current.
            // MCP sync is intentionally skipped while Live config is owned by takeover.
            return Ok(SwitchResult::default());
        }

        // Normal mode: full switch with Live config write
        Self::switch_normal(state, app_type, id, &providers)
    }

    /// Normal switch flow (non-proxy mode)
    fn switch_normal(
        state: &AppState,
        app_type: AppType,
        id: &str,
        providers: &indexmap::IndexMap<String, Provider>,
    ) -> Result<SwitchResult, AppError> {
        let provider = providers
            .get(id)
            .ok_or_else(|| AppError::Message(format!("供应商 {id} 不存在")))?;

        // OMO ↔ OMO Slim are mutually exclusive; activating one removes the other's config file.
        if matches!(app_type, AppType::OpenCode) {
            let omo_pair = match provider.category.as_deref() {
                Some("omo") => Some((&crate::services::omo::STANDARD, &crate::services::omo::SLIM)),
                Some("omo-slim") => {
                    Some((&crate::services::omo::SLIM, &crate::services::omo::STANDARD))
                }
                _ => None,
            };
            if let Some((enable, disable)) = omo_pair {
                crate::services::OmoService::switch_provider(state, provider, enable, disable)?;
                return Ok(SwitchResult::default());
            }
        }

        let mut result = SwitchResult::default();

        // Backfill: Backfill current live config to current provider
        // Use effective current provider (validated existence) to ensure backfill targets valid provider
        let current_id = crate::settings::get_effective_current_provider(&state.db, &app_type)?;

        if let Some(current_id) = current_id {
            if current_id != id {
                // Additive mode apps - all providers coexist in the same file,
                // no backfill needed (backfill is for exclusive mode apps like Claude/Codex/Gemini).
                // Claude Desktop is exclusive-mode but has NO generic live read
                // by design (`read_live_settings` unconditionally errors for it;
                // its 3P config is imported through a dedicated flow), so a
                // backfill skip there is permanent designed behavior — attempting
                // it just to warn about the designed error would misreport every
                // single Claude Desktop switch as "your live edits may be lost".
                if !app_type.is_additive_mode() && !matches!(app_type, AppType::ClaudeDesktop) {
                    // The list hides damaged rows. Resolve the outgoing row strictly
                    // before touching Live, including when reading Live would fail.
                    let outgoing = state
                        .db
                        .get_provider_by_id(&current_id, app_type.as_str())?;
                    match read_live_settings(app_type.clone()) {
                        Ok(live_config) => {
                            if let Some(mut current_provider) = outgoing {
                                // 切走前先把 live 里的可共享改动（含用户直接在应用内
                                // 装插件/加 hook/改偏好）同步进通用配置片段，再做剥离回填。
                                // 详见 sync_common_config_snippet_from_live 的文档。
                                Self::sync_common_config_snippet_from_live(
                                    state,
                                    &app_type,
                                    &current_provider,
                                    &live_config,
                                    &mut result,
                                );

                                current_provider.settings_config =
                                    strip_common_config_from_live_settings(
                                        state.db.as_ref(),
                                        &app_type,
                                        &current_provider,
                                        live_config,
                                    );
                                if let Err(e) =
                                    state.db.save_provider(app_type.as_str(), &current_provider)
                                {
                                    log::warn!("Backfill failed: {e}");
                                    result
                                        .warnings
                                        .push(format!("backfill_failed:{current_id}"));
                                }
                            }
                        }
                        Err(e) => {
                            // Reading/validating live config.toml can fail for
                            // reasons that are transient and easy to hit —
                            // e.g. Codex itself holding the file open on
                            // Windows at the exact moment of a switch — not
                            // just "the file is genuinely corrupt". Silently
                            // skipping here used to mean the switch would go
                            // on to overwrite Live anyway, discarding
                            // whatever the user had just hand-edited into it
                            // for the outgoing provider, with no record of
                            // that having happened.
                            log::warn!(
                                "Backfill skipped: failed to read live {} config before switching away from '{current_id}': {e}",
                                app_type.as_str()
                            );
                            result
                                .warnings
                                .push(format!("backfill_skipped:{current_id}"));
                        }
                    }
                }
            }
        }

        // Without a native write receipt, compensation must preserve changed Live
        // files and report a conflict, including failures inside this switch.
        let unreceipted_files = if matches!(
            app_type,
            AppType::Claude | AppType::Gemini | AppType::OpenCode
        ) {
            crate::services::live_backup::live_files(&app_type)?
                .into_iter()
                .map(crate::config::cas::FileSnapshot::read)
                .collect::<Result<Vec<_>, _>>()?
        } else {
            Vec::new()
        };
        if !app_type.is_additive_mode() {
            let previous_local = crate::settings::get_current_provider(&app_type);
            let previous_db = state.db.get_current_provider(app_type.as_str())?;
            let live_snapshot = if unreceipted_files.is_empty() {
                LiveSnapshot::capture(&app_type)?
            } else {
                None
            };
            let restore_live = |receipt: &mut Option<crate::config::cas::AppliedChangeset>| -> Result<(), AppError> {
                if let Some(receipt) = receipt.take() {
                    return receipt.rollback().map_err(AppError::from);
                }
                update::verify_unreceipted_files(&unreceipted_files)?;
                if let Some(snapshot) = live_snapshot.as_ref() {
                    snapshot.restore_after_failed_write()?;
                }
                Ok(())
            };

            // We never touch `[profiles.*]` tables — they're the user's own —
            // but Codex's `profile` mechanism lets an active one override the
            // exact top-level routing keys this switch is about to write
            // (model_provider/model/model_catalog_json/...). Detect that
            // specific conflict up front: otherwise the switch reports
            // success while Codex keeps routing through the profile.
            if matches!(app_type, AppType::Codex) {
                if let Ok(current_config_text) = crate::codex_config::read_codex_config_text() {
                    if let Some(profile_name) =
                        crate::codex_config::detect_active_profile_routing_override(
                            &current_config_text,
                        )
                    {
                        result
                            .warnings
                            .push(format!("active_profile_overrides_routing:{profile_name}"));
                    }
                }
            }

            let provider_to_write =
                first_write::protect_first_live_write(state, &app_type, provider)?;
            let mut live_receipt = match live::write_live_with_common_config_receipted(
                state.db.as_ref(),
                &app_type,
                &provider_to_write,
            ) {
                Ok(receipt) => receipt,
                Err(error) => {
                    // The failed CAS changeset already compensates its own writes.
                    let rollback = restore_live(&mut None).err();
                    return match rollback {
                        Some(rollback_error) => Err(AppError::Message(format!(
                            "写入目标 Live 配置失败: {error}；恢复原 Live 配置失败: {rollback_error}"
                        ))),
                        None => Err(error),
                    };
                }
            };

            if let Err(error) = crate::settings::set_current_provider(&app_type, Some(id)) {
                let rollback = restore_live(&mut live_receipt).err();
                return match rollback {
                    Some(rollback_error) => Err(AppError::Message(format!(
                        "更新本地当前供应商失败: {error}；恢复原 Live 配置失败: {rollback_error}"
                    ))),
                    None => Err(error),
                };
            }

            if let Err(error) = state.db.set_current_provider(app_type.as_str(), id) {
                let mut rollback_errors = Vec::new();
                if let Err(rollback_error) =
                    crate::settings::set_current_provider(&app_type, previous_local.as_deref())
                {
                    rollback_errors.push(format!("恢复本地当前供应商失败: {rollback_error}"));
                }
                if let Some(previous_db) = previous_db.as_deref() {
                    if let Err(rollback_error) = state
                        .db
                        .set_current_provider(app_type.as_str(), previous_db)
                    {
                        rollback_errors.push(format!("恢复数据库当前供应商失败: {rollback_error}"));
                    }
                }
                if let Err(rollback_error) = restore_live(&mut live_receipt) {
                    rollback_errors.push(format!("恢复原 Live 配置失败: {rollback_error}"));
                }
                return if rollback_errors.is_empty() {
                    Err(error)
                } else {
                    Err(AppError::Message(format!(
                        "更新当前供应商失败: {error}；回滚失败: {}",
                        rollback_errors.join("；")
                    )))
                };
            }
        } else {
            // Additive apps merge providers into a shared Live file and keep
            // their existing specialized rollback path below.
            write_live_with_common_config(state.db.as_ref(), &app_type, provider)?;
        }
        // — we instead update the top-level `model:` section to point at this
        // provider's first declared model. Without this, clicking "switch" would
        // whatever `model.provider` was set before.
        // For additive-mode providers that were DB-only (live_config_managed == Some(false)),
        // flip the flag to true now that the provider has been successfully written to the live
        // file. This ensures sync_all_providers_to_live() will include it on future syncs.
        //
        // If persisting the marker fails, roll back the just-written live config so we don't leave
        // the provider in a silent inconsistent state (present in live, but still marked DB-only).
        if app_type.is_additive_mode() && Self::provider_live_config_managed(provider) != Some(true)
        {
            let mut updated = provider.clone();
            Self::set_provider_live_config_managed(&mut updated, true);
            if let Err(e) = state.db.save_provider(app_type.as_str(), &updated) {
                let rollback_result = match app_type {
                    AppType::OpenCode => update::verify_unreceipted_files(&unreceipted_files),

                    _ => Ok(()),
                };

                match rollback_result {
                    Ok(()) => {
                        return Err(AppError::Message(format!(
                            "Failed to persist live_config_managed for '{}' after writing live config; live changes were rolled back: {e}",
                            provider.id
                        )));
                    }
                    Err(rollback_err) => {
                        return Err(AppError::Message(format!(
                            "Failed to persist live_config_managed for '{}' after writing live config: {e}; additionally failed to roll back live config: {rollback_err}",
                            provider.id
                        )));
                    }
                }
            }
        }

        // 切换重写了目标应用的 live，只重投影该应用的 MCP（Codex 的
        // [mcp_servers] 与 live 同文件，按投影台账与 DB 对齐；其余应用的
        // MCP 文件独立于 live，投影是幂等维护）。不用全量 sync_all_enabled：
        // 无关应用的 live 损坏（如 ~/.claude.json 坏 JSON）不该阻断切换。
        // 走到这里 DB is_current 与 live 都已落盘，切换事实上已成功；
        // 投影失败上抛会让前端报"切换失败"制造分裂假象，故降级为警告
        // （MCP 投影可自愈：下次切换 / 任一 MCP 启停都会重新投影）。
        if let Err(err) = McpService::sync_enabled_for_app(state, &app_type) {
            log::warn!("切换供应商后重投影 {app_type:?} MCP 失败（将在下次同步时自愈）: {err}");
        }

        Ok(result)
    }

    /// Sync current provider to live configuration (re-export)
    pub fn sync_current_to_live(state: &AppState) -> Result<(), AppError> {
        sync_current_to_live(state)
    }

    /// Sync current providers to live, except `skip` (re-export)
    pub fn sync_current_to_live_except(
        state: &AppState,
        skip: Option<&AppType>,
    ) -> Result<(), AppError> {
        sync_current_to_live_except(state, skip)
    }

    /// Establish a fresh Codex restore baseline without committing current
    /// pointers or running a second MCP write. The caller holds the app lock
    /// and retains the receipt until routing and provider activation succeed.
    pub(crate) fn initialize_codex_live_for_takeover(
        state: &AppState,
        provider: &Provider,
    ) -> Result<Option<crate::config::cas::AppliedChangeset>, AppError> {
        live::write_live_with_common_config_receipted(state.db.as_ref(), &AppType::Codex, provider)
    }

    pub fn sync_current_provider_for_app(
        state: &AppState,
        app_type: AppType,
    ) -> Result<(), AppError> {
        if app_type.is_additive_mode() {
            return sync_current_provider_for_app_to_live(state, &app_type);
        }

        let _switch_guard =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app(app_type.as_str()));
        Self::sync_current_provider_for_app_with_app_lock_held(state, app_type)
    }

    /// Caller owns profile -> lifecycle -> app locks. Do not reacquire the app lock.
    pub(crate) fn sync_current_provider_for_app_with_app_lock_held(
        state: &AppState,
        app_type: AppType,
    ) -> Result<(), AppError> {
        let current_id =
            match crate::settings::get_effective_current_provider(&state.db, &app_type)? {
                Some(id) => id,
                None => return Ok(()),
            };

        let providers = state.db.get_all_providers(app_type.as_str())?;
        let Some(provider) = providers.get(&current_id) else {
            return Ok(());
        };

        let has_live_backup =
            futures::executor::block_on(state.db.get_live_backup(app_type.as_str()))
                .map_err(|e| AppError::Message(e.to_string()))?
                .is_some();

        let live_taken_over = state
            .proxy_service
            .detect_takeover_in_live_config_for_app(&app_type);

        // See the save path above: backup/placeholders are the ownership signal
        // here, not just proxy_config.enabled.
        if has_live_backup || live_taken_over {
            if matches!(app_type, AppType::ClaudeDesktop) {
                write_live_with_common_config(state.db.as_ref(), &app_type, provider)?;
                return Ok(());
            }

            futures::executor::block_on(
                state
                    .proxy_service
                    .update_live_backup_from_provider_inner(app_type.as_str(), provider),
            )
            .map_err(|e| AppError::Message(format!("更新 Live 备份失败: {e}")))?;
            if live_taken_over {
                futures::executor::block_on(async {
                    match app_type {
                        AppType::Claude => {
                            state
                                .proxy_service
                                .sync_claude_live_from_provider_while_proxy_active(provider)
                                .await
                        }
                        AppType::Codex => {
                            state
                                .proxy_service
                                .sync_codex_live_from_provider_while_proxy_active(provider)
                                .await
                        }
                        AppType::GrokBuild => {
                            state
                                .proxy_service
                                .sync_grok_live_from_provider_while_proxy_active(provider)
                                .await
                        }
                        AppType::Gemini => {
                            state
                                .proxy_service
                                .sync_gemini_live_from_provider_while_proxy_active(provider)
                                .await
                        }
                        _ => Ok(()),
                    }
                })
                .map_err(|e| AppError::Message(format!("同步接管配置失败: {e}")))?;
            }
            return Ok(());
        }

        if matches!(app_type, AppType::Codex) {
            // A common-only save must not include a second, fallible MCP write
            // after committing the common/config/catalog CAS changeset.
            write_live_with_common_config(state.db.as_ref(), &app_type, provider)
        } else {
            sync_current_provider_for_app_to_live(state, &app_type)
        }
    }

    pub fn migrate_legacy_common_config_usage(
        state: &AppState,
        app_type: AppType,
        legacy_snippet: &str,
    ) -> Result<(), AppError> {
        if app_type.is_additive_mode() || legacy_snippet.trim().is_empty() {
            return Ok(());
        }

        let providers = state.db.get_all_providers(app_type.as_str())?;

        for provider in providers.values() {
            if provider
                .meta
                .as_ref()
                .and_then(|meta| meta.common_config_enabled)
                .is_some()
            {
                continue;
            }

            if !live::provider_uses_common_config(&app_type, provider, Some(legacy_snippet)) {
                continue;
            }

            let mut updated_provider = provider.clone();
            updated_provider
                .meta
                .get_or_insert_with(Default::default)
                .common_config_enabled = Some(true);

            updated_provider.settings_config = live::remove_common_config_from_settings(
                &app_type,
                &updated_provider.settings_config,
                legacy_snippet,
            )?;

            state
                .db
                .save_provider(app_type.as_str(), &updated_provider)?;
        }

        Ok(())
    }

    pub fn migrate_legacy_common_config_usage_if_needed(
        state: &AppState,
        app_type: AppType,
    ) -> Result<(), AppError> {
        if app_type.is_additive_mode() {
            return Ok(());
        }

        if matches!(app_type, AppType::Codex) {
            state.db.migrate_legacy_codex_common_config()?;
        }

        let Some(snippet) = state.db.get_config_snippet(app_type.as_str())? else {
            return Ok(());
        };

        if snippet.trim().is_empty() {
            return Ok(());
        }

        Self::migrate_legacy_common_config_usage(state, app_type, &snippet)
    }

    /// 切走某供应商前，把它 live 配置里的可共享部分重新提取并**整体替换**到
    /// 通用配置片段，使在 live 应用里直接做的改动不会因切换而丢失。
    ///
    /// 采用"整体重提取 + 替换"而非"只合并新增"，是为了同时覆盖三种情况：
    /// - **新增**：用户直接在应用里装了插件、加了 hook、改了 env/主题/权限等共享
    ///   偏好，被捕获进通用配置，切到别的供应商也带得过去；
    /// - **删除**：被删掉的键不在新提取结果里，于是从片段里消失、下次切换不会被
    ///   重新注入——否则会出现"插件怎么删也删不掉"的反直觉 bug；
    /// - **密钥安全**：提取器已剥掉 auth / model / endpoint，密钥永不进共享片段。
    ///
    /// 之所以"整体替换"是安全的：每次写 live 都会把当前片段合并进去，所以切走时
    /// 读到的 live 一定是"片段 + 本地改动"的超集，重提取只会丢掉用户真正删掉的键，
    /// 不会误删其它供应商共享的内容。
    ///
    /// **作用域**：仅 Claude。Codex 通用配置是用户明确保存的文本，不从
    /// 即将切出的 Live 自动回填；本地修改由所有权投影保留，避免覆盖新草稿。
    ///
    /// 仅对**显式勾选"写入通用配置"**（`meta.common_config_enabled == Some(true)`）的
    /// 供应商生效；用户**显式清空**过片段（`_cleared`）时跳过，避免把用户主动清掉的
    /// 配置又塞回来。所有失败均为非致命，只记 warning，绝不阻断切换。
    fn sync_common_config_snippet_from_live(
        state: &AppState,
        app_type: &AppType,
        provider: &Provider,
        live_config: &Value,
        result: &mut SwitchResult,
    ) {
        // Codex common snippets are explicit user intent. Re-extracting the
        // outgoing live file here would overwrite a newly staged draft, and
        // turn user-local keys into managed ones. Ownership projection keeps
        // those local edits without learning them back into the shared text.
        if !matches!(app_type, AppType::Claude) {
            return;
        }

        let opted_in = provider
            .meta
            .as_ref()
            .and_then(|meta| meta.common_config_enabled)
            == Some(true);
        if !opted_in {
            return;
        }

        match state.db.is_config_snippet_cleared(app_type.as_str()) {
            Ok(true) => return, // 用户显式清空过通用配置，尊重其选择，不再自动塞回
            Ok(false) => {}
            Err(err) => {
                log::warn!(
                    "Failed to read common config cleared flag for {}: {err}",
                    app_type.as_str()
                );
                return;
            }
        }

        let new_snippet = match Self::extract_common_config_snippet_from_settings(
            app_type.clone(),
            live_config,
        ) {
            Ok(snippet) => snippet,
            Err(err) => {
                log::warn!(
                    "Failed to extract common config from live for {} provider '{}': {err}",
                    app_type.as_str(),
                    provider.id
                );
                return;
            }
        };

        // 未变化则跳过，避免无谓写库（不切 live 配置时这是常态路径）。
        let current = state
            .db
            .get_config_snippet(app_type.as_str())
            .ok()
            .flatten();
        if current.as_deref() == Some(new_snippet.as_str()) {
            return;
        }

        if let Err(err) = state
            .db
            .set_config_snippet(app_type.as_str(), Some(new_snippet))
        {
            log::warn!(
                "Failed to persist synced common config for {} provider '{}': {err}",
                app_type.as_str(),
                provider.id
            );
            result
                .warnings
                .push(format!("common_config_sync_failed:{}", provider.id));
        }
    }

    /// Extract common config snippet from current provider
    ///
    /// Extracts the current provider's configuration and removes provider-specific fields
    /// (API keys, model settings, endpoints) to create a reusable common config snippet.
    pub fn extract_common_config_snippet(
        state: &AppState,
        app_type: AppType,
    ) -> Result<String, AppError> {
        // Get current provider
        let current_id = Self::current(state, app_type.clone())?;
        if current_id.is_empty() {
            return Err(AppError::Message("No current provider".to_string()));
        }

        let providers = state.db.get_all_providers(app_type.as_str())?;
        let provider = providers
            .get(&current_id)
            .ok_or_else(|| AppError::Message(format!("Provider {current_id} not found")))?;

        match app_type {
            AppType::Claude => Self::extract_claude_common_config(&provider.settings_config),
            AppType::ClaudeDesktop => Ok(String::new()),
            AppType::Codex => Self::extract_codex_common_config(&provider.settings_config),
            AppType::Gemini => Self::extract_gemini_common_config(&provider.settings_config),
            AppType::GrokBuild => Ok(String::new()),
            AppType::OpenCode => Self::extract_opencode_common_config(&provider.settings_config),
            AppType::Pi => Ok(String::new()),
        }
    }

    /// Extract common config snippet from a config value (e.g. editor content).
    pub fn extract_common_config_snippet_from_settings(
        app_type: AppType,
        settings_config: &Value,
    ) -> Result<String, AppError> {
        match app_type {
            AppType::Claude => Self::extract_claude_common_config(settings_config),
            AppType::ClaudeDesktop => Ok(String::new()),
            AppType::Codex => Self::extract_codex_common_config(settings_config),
            AppType::Gemini => Self::extract_gemini_common_config(settings_config),
            AppType::GrokBuild => Ok(String::new()),
            AppType::OpenCode => Self::extract_opencode_common_config(settings_config),
            AppType::Pi => Ok(String::new()),
        }
    }

    /// 判断一个 env / 顶层配置键名是否为凭据/机密：凡命中一律不得写入共享的
    /// 通用配置片段。**故意从严**——多剥一个非机密键只是它不被共享（可恢复的小
    /// 不便），漏剥一个凭据则会把密钥注入到每个供应商（不可恢复的泄漏）。因此用
    /// 模式匹配覆盖整类，而非枚举具体名字（枚举永远会漏掉下一个 `*_API_KEY`）。
    ///
    /// 覆盖：Anthropic / OpenRouter / Google / OpenAI / Gemini 等 `*_API_KEY`
    /// （Claude provider 的凭据见 `Provider::resolve_usage_credentials`，确实支持
    /// `OPENROUTER_API_KEY` / `GOOGLE_API_KEY` 等回退）、各类 `*_AUTH_TOKEN` /
    /// 单数 `*_TOKEN`、AWS Bedrock / Vertex 凭据、以及通用 secret / password /
    /// 私钥命名。
    fn is_sensitive_config_key(name: &str) -> bool {
        let upper = name.to_ascii_uppercase();

        // 单数 `_TOKEN` 命中 AWS_SESSION_TOKEN 等，但**不**误伤复数 `_TOKENS`
        // （CLAUDE_CODE_MAX_OUTPUT_TOKENS / MAX_THINKING_TOKENS 是正常可共享配置）。
        const SENSITIVE_SUFFIXES: &[&str] = &[
            "_API_KEY",
            "_APIKEY",
            "_AUTH_TOKEN",
            "_TOKEN",
            "_ACCESS_KEY",
            "_ACCESS_KEY_ID",
            "_KEY_ID",
            "_PRIVATE_KEY",
        ];
        const SENSITIVE_EXACT: &[&str] = &[
            "APIKEY",
            "API_KEY",
            "TOKEN",
            "SECRET",
            "PASSWORD",
            "CREDENTIALS",
        ];
        // contains：覆盖 AWS_SECRET_ACCESS_KEY / *_CLIENT_SECRET /
        // GOOGLE_APPLICATION_CREDENTIALS / AWS_BEARER_TOKEN_BEDROCK 等变体。
        const SENSITIVE_CONTAINS: &[&str] = &[
            "SECRET",
            "PASSWORD",
            "PASSWD",
            "CREDENTIAL",
            "PRIVATE_KEY",
            "BEARER_TOKEN",
        ];

        SENSITIVE_EXACT.contains(&upper.as_str())
            || SENSITIVE_SUFFIXES.iter().any(|s| upper.ends_with(s))
            || SENSITIVE_CONTAINS.iter().any(|c| upper.contains(c))
    }

    /// Extract common config for Claude (JSON format)
    fn extract_claude_common_config(settings: &Value) -> Result<String, AppError> {
        let mut config = settings.clone();

        // 供应商专属的**非机密**字段（模型 + 端点），不应共享。凭据/机密不在此列举，
        // 改由 `is_sensitive_config_key`（模式匹配）统一剥离，新供应商的 `*_API_KEY`
        // 等无需再手工补名单即可被覆盖。
        const ENV_PROVIDER_SPECIFIC_EXCLUDES: &[&str] = &[
            "ANTHROPIC_MODEL",
            "ANTHROPIC_REASONING_MODEL", // legacy: 已废弃，但旧配置可能残留
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
            // Fable 是 v3.16.3 新增的第四档模型映射，与 haiku/sonnet/opus 同属供应商专属，
            // 不得进入通用配置片段，否则会污染其它供应商（issue #4272）。
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
            "CLAUDE_CODE_SUBAGENT_MODEL",
            // Context limits follow the actual upstream model. Sharing these
            // across providers can cap GPT/Kimi to the wrong window and make
            // Claude Code compact too early or miss the upstream limit.
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
            "ANTHROPIC_BASE_URL",
        ];

        const TOP_LEVEL_EXCLUDES: &[&str] = &[
            "apiBaseUrl",
            // Legacy model fields
            "primaryModel",
            "smallFastModel",
        ];

        // Remove env fields: provider-specific (models/endpoint) + 任何凭据键。
        if let Some(env) = config.get_mut("env").and_then(|v| v.as_object_mut()) {
            let sensitive: Vec<String> = env
                .keys()
                .filter(|k| Self::is_sensitive_config_key(k))
                .cloned()
                .collect();
            for key in ENV_PROVIDER_SPECIFIC_EXCLUDES {
                env.remove(*key);
            }
            for key in &sensitive {
                env.remove(key);
            }
            // If env is empty after removal, remove the env object itself
            if env.is_empty() {
                config.as_object_mut().map(|obj| obj.remove("env"));
            }
        }

        // Remove top-level fields: legacy model fields + 任何凭据键
        // （例如非标准的顶层 apiKey / api_key / *_TOKEN）。
        if let Some(obj) = config.as_object_mut() {
            let sensitive: Vec<String> = obj
                .keys()
                .filter(|k| Self::is_sensitive_config_key(k))
                .cloned()
                .collect();
            for key in TOP_LEVEL_EXCLUDES {
                obj.remove(*key);
            }
            for key in &sensitive {
                obj.remove(key);
            }
        }

        // Check if result is empty
        if config.as_object().is_none_or(|obj| obj.is_empty()) {
            return Ok("{}".to_string());
        }

        serde_json::to_string_pretty(&config)
            .map_err(|e| AppError::Message(format!("Serialization failed: {e}")))
    }

    /// Extract common config for Codex (TOML format)
    fn extract_codex_common_config(settings: &Value) -> Result<String, AppError> {
        // Codex config is stored as { "auth": {...}, "config": "toml string" }
        let config_toml = settings
            .get("config")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if config_toml.is_empty() {
            return Ok(String::new());
        }

        let (shareable, _) =
            crate::codex_key_ownership::sanitize_codex_common_snippet_with_report(config_toml)?;
        let mut doc = shareable
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| AppError::Config("Codex 通用配置提取结果无效".to_string()))?;
        let root = doc.as_table_mut();
        // - web_search 只剥 cc-switch 注入的 "disabled" 哨兵；用户手设的其它值
        //   属于可共享偏好，保留。
        if root
            .get(crate::codex_config::CODEX_WEB_SEARCH_FIELD)
            .and_then(|item| item.as_str())
            == Some(crate::codex_config::CODEX_WEB_SEARCH_DISABLED)
        {
            root.remove(crate::codex_config::CODEX_WEB_SEARCH_FIELD);
        }

        // Clean up multiple empty lines (keep at most one blank line).
        let mut cleaned = String::new();
        let mut blank_run = 0usize;
        for line in doc.to_string().lines() {
            if line.trim().is_empty() {
                blank_run += 1;
                if blank_run <= 1 {
                    cleaned.push('\n');
                }
                continue;
            }
            blank_run = 0;
            cleaned.push_str(line);
            cleaned.push('\n');
        }

        Ok(cleaned.trim().to_string())
    }

    /// Extract common config for Gemini (JSON format)
    ///
    /// Extracts `.env` values while excluding provider-specific credentials:
    /// - GOOGLE_GEMINI_BASE_URL
    /// - GEMINI_API_KEY
    fn extract_gemini_common_config(settings: &Value) -> Result<String, AppError> {
        let env = settings.get("env").and_then(|v| v.as_object());

        let mut snippet = serde_json::Map::new();
        if let Some(env) = env {
            for (key, value) in env {
                if key == "GOOGLE_GEMINI_BASE_URL" || key == "GEMINI_API_KEY" {
                    continue;
                }
                let Value::String(v) = value else {
                    continue;
                };
                let trimmed = v.trim();
                if !trimmed.is_empty() {
                    snippet.insert(key.to_string(), Value::String(trimmed.to_string()));
                }
            }
        }

        if snippet.is_empty() {
            return Ok("{}".to_string());
        }

        serde_json::to_string_pretty(&Value::Object(snippet))
            .map_err(|e| AppError::Message(format!("Serialization failed: {e}")))
    }

    /// Extract common config for OpenCode (JSON format)
    fn extract_opencode_common_config(settings: &Value) -> Result<String, AppError> {
        // OpenCode uses a different config structure with npm, options, models
        // For common config, we exclude provider-specific fields like apiKey
        let mut config = settings.clone();

        // Remove provider-specific fields
        if let Some(obj) = config.as_object_mut() {
            if let Some(options) = obj.get_mut("options").and_then(|v| v.as_object_mut()) {
                options.remove("apiKey");
                options.remove("baseURL");
            }
            // Keep npm and models as they might be common
        }

        if config.is_null() || (config.is_object() && config.as_object().unwrap().is_empty()) {
            return Ok("{}".to_string());
        }

        serde_json::to_string_pretty(&config)
            .map_err(|e| AppError::Message(format!("Serialization failed: {e}")))
    }

    /// Import default configuration from live files (re-export)
    ///
    /// Returns `Ok(true)` if imported, `Ok(false)` if skipped.
    pub fn import_default_config(state: &AppState, app_type: AppType) -> Result<bool, AppError> {
        import_default_config(state, app_type)
    }

    pub fn should_import_default_config_on_startup(
        state: &AppState,
        app_type: &AppType,
    ) -> Result<bool, AppError> {
        should_import_default_config_on_startup(state, app_type)
    }

    /// Read current live settings (re-export)
    pub fn read_live_settings(app_type: AppType) -> Result<Value, AppError> {
        read_live_settings(app_type)
    }

    /// Get custom endpoints list (re-export)
    pub fn get_custom_endpoints(
        state: &AppState,
        app_type: AppType,
        provider_id: &str,
    ) -> Result<Vec<CustomEndpoint>, AppError> {
        endpoints::get_custom_endpoints(state, app_type, provider_id)
    }

    /// Add custom endpoint (re-export)
    pub fn add_custom_endpoint(
        state: &AppState,
        app_type: AppType,
        provider_id: &str,
        url: String,
    ) -> Result<(), AppError> {
        endpoints::add_custom_endpoint(state, app_type, provider_id, url)
    }

    /// Remove custom endpoint (re-export)
    pub fn remove_custom_endpoint(
        state: &AppState,
        app_type: AppType,
        provider_id: &str,
        url: String,
    ) -> Result<(), AppError> {
        endpoints::remove_custom_endpoint(state, app_type, provider_id, url)
    }

    /// Update endpoint last used timestamp (re-export)
    pub fn update_endpoint_last_used(
        state: &AppState,
        app_type: AppType,
        provider_id: &str,
        url: String,
    ) -> Result<(), AppError> {
        endpoints::update_endpoint_last_used(state, app_type, provider_id, url)
    }

    /// Update provider sort order
    pub fn update_sort_order(
        state: &AppState,
        app_type: AppType,
        updates: Vec<ProviderSortUpdate>,
    ) -> Result<bool, AppError> {
        state.db.update_provider_sort_indices(
            app_type.as_str(),
            updates
                .iter()
                .map(|update| (update.id.as_str(), update.sort_index)),
        )?;
        Ok(true)
    }

    /// Query provider usage (re-export)
    pub async fn query_usage(
        state: &AppState,
        app_type: AppType,
        provider_id: &str,
    ) -> Result<UsageResult, AppError> {
        usage::query_usage(state, app_type, provider_id).await
    }

    /// Test usage script (re-export)
    #[allow(clippy::too_many_arguments)]
    pub async fn test_usage_script(
        state: &AppState,
        app_type: AppType,
        provider_id: &str,
        script_code: &str,
        timeout: u64,
        api_key: Option<&str>,
        base_url: Option<&str>,
        access_token: Option<&str>,
        user_id: Option<&str>,
        template_type: Option<&str>,
    ) -> Result<UsageResult, AppError> {
        usage::test_usage_script(
            state,
            app_type,
            provider_id,
            script_code,
            timeout,
            api_key,
            base_url,
            access_token,
            user_id,
            template_type,
        )
        .await
    }

    pub(crate) fn write_gemini_live(provider: &Provider) -> Result<(), AppError> {
        write_gemini_live(provider)
    }

    /// MH-13b: every add/update (editor, deep link, tray) is untrusted TOML.
    /// Strip what a Codex line must never carry. Unknown env-var names are
    /// kept here: on this path the user typed them.
    fn sanitize_codex_provider_config(
        app_type: &AppType,
        provider: &mut Provider,
    ) -> Result<(), AppError> {
        if !matches!(app_type, AppType::Codex) {
            return Ok(());
        }
        let Some(config) = provider
            .settings_config
            .get("config")
            .and_then(Value::as_str)
        else {
            return Ok(());
        };
        let official = provider.category.as_deref() == Some("official");
        let (clean, report) =
            crate::codex_key_ownership::sanitize_untrusted_codex_config(config, official)?;
        if !report.stripped.is_empty() {
            log::warn!(
                "Removed keys a Codex line must not carry from '{}': {}",
                provider.id,
                report.stripped.join(", ")
            );
            provider.settings_config["config"] = Value::String(clean);
        }
        Ok(())
    }

    pub(crate) fn validate_provider_settings(
        app_type: &AppType,
        provider: &Provider,
    ) -> Result<(), AppError> {
        match app_type {
            AppType::Claude => {
                if !provider.settings_config.is_object() {
                    return Err(AppError::localized(
                        "provider.claude.settings.not_object",
                        "Claude 配置必须是 JSON 对象",
                        "Claude configuration must be a JSON object",
                    ));
                }
            }
            AppType::ClaudeDesktop => {
                crate::claude_desktop_config::validate_provider(provider)?;
            }
            AppType::Codex => {
                let settings = provider.settings_config.as_object().ok_or_else(|| {
                    AppError::localized(
                        "provider.codex.settings.not_object",
                        "Codex 配置必须是 JSON 对象",
                        "Codex configuration must be a JSON object",
                    )
                })?;

                let auth = settings.get("auth").ok_or_else(|| {
                    AppError::localized(
                        "provider.codex.auth.missing",
                        format!("供应商 {} 缺少 auth 配置", provider.id),
                        format!("Provider {} is missing auth configuration", provider.id),
                    )
                })?;
                if !auth.is_object() {
                    return Err(AppError::localized(
                        "provider.codex.auth.not_object",
                        format!("供应商 {} 的 auth 配置必须是 JSON 对象", provider.id),
                        format!(
                            "Provider {} auth configuration must be a JSON object",
                            provider.id
                        ),
                    ));
                }

                if let Some(config_value) = settings.get("config") {
                    if !(config_value.is_string() || config_value.is_null()) {
                        return Err(AppError::localized(
                            "provider.codex.config.invalid_type",
                            "Codex config 字段必须是字符串",
                            "Codex config field must be a string",
                        ));
                    }
                    if let Some(cfg_text) = config_value.as_str() {
                        crate::codex_config::validate_config_toml(cfg_text)?;
                        crate::codex_key_ownership::validate_line_numeric_keys(cfg_text)?;
                    }
                }
            }
            AppType::Gemini => {
                use crate::gemini_config::validate_gemini_settings;
                validate_gemini_settings(&provider.settings_config)?
            }
            AppType::GrokBuild => {
                let settings = provider.settings_config.as_object().ok_or_else(|| {
                    AppError::localized(
                        "provider.grokbuild.settings.not_object",
                        "Grok Build 配置必须是 JSON 对象",
                        "Grok Build configuration must be a JSON object",
                    )
                })?;
                let config = settings
                    .get("config")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AppError::localized(
                            "provider.grokbuild.config.missing",
                            "Grok Build 配置缺少 config 字段",
                            "Grok Build configuration is missing the config field",
                        )
                    })?;
                if provider.category.as_deref() == Some("official") {
                    // 官方条目走 Grok CLI 自带 OAuth：空 config 合法，
                    // 回填快照只要求 TOML 语法合法。
                    crate::grok_config::validate_config_toml_syntax(config)?;
                } else {
                    crate::grok_config::validate_config_toml(config)?;
                }
            }
            AppType::OpenCode => {
                // OpenCode uses a different config structure: { npm, options, models }
                // Basic validation - must be an object
                if !provider.settings_config.is_object() {
                    return Err(AppError::localized(
                        "provider.opencode.settings.not_object",
                        "OpenCode 配置必须是 JSON 对象",
                        "OpenCode configuration must be a JSON object",
                    ));
                }
            }

            AppType::Pi => {
                crate::pi_config::validate_provider_node(&provider.id, &provider.settings_config)?;
            }
        }

        // Validate and clean UsageScript configuration (common for all app types)
        if let Some(meta) = &provider.meta {
            if let Some(multiplier) = meta.cost_multiplier.as_deref() {
                validate_cost_multiplier(multiplier)?;
            }
            if let Some(source) = meta.pricing_model_source.as_deref() {
                validate_pricing_source(source)?;
            }
            if let Some(usage_script) = &meta.usage_script {
                validate_usage_script(usage_script)?;
            }
            // CPP-A7: custom request headers are validated at save while the
            // feature is on; the proxy filters them again either way.
            if let Some(overrides) = &meta.local_proxy_request_overrides {
                validate_request_header_overrides(
                    overrides,
                    crate::product_policy::Capability::CustomRequestHeaders.enabled(),
                )?;
            }
        }

        Ok(())
    }
}

/// Normalize Claude model keys in a JSON value
///
/// Reads old key (ANTHROPIC_SMALL_FAST_MODEL), writes new keys (DEFAULT_*), and deletes old key.
pub(crate) fn normalize_claude_models_in_value(settings: &mut Value) -> bool {
    let mut changed = false;
    let env = match settings.get_mut("env").and_then(|v| v.as_object_mut()) {
        Some(obj) => obj,
        None => return changed,
    };

    let model = env
        .get("ANTHROPIC_MODEL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let small_fast = env
        .get("ANTHROPIC_SMALL_FAST_MODEL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let current_haiku = env
        .get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let current_sonnet = env
        .get("ANTHROPIC_DEFAULT_SONNET_MODEL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let current_opus = env
        .get("ANTHROPIC_DEFAULT_OPUS_MODEL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let target_haiku = current_haiku
        .or_else(|| small_fast.clone())
        .or_else(|| model.clone());
    let target_sonnet = current_sonnet
        .or_else(|| model.clone())
        .or_else(|| small_fast.clone());
    let target_opus = current_opus
        .or_else(|| model.clone())
        .or_else(|| small_fast.clone());

    if env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").is_none() {
        if let Some(v) = target_haiku {
            env.insert(
                "ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(),
                Value::String(v),
            );
            changed = true;
        }
    }
    if env.get("ANTHROPIC_DEFAULT_SONNET_MODEL").is_none() {
        if let Some(v) = target_sonnet {
            env.insert(
                "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
                Value::String(v),
            );
            changed = true;
        }
    }
    if env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").is_none() {
        if let Some(v) = target_opus {
            env.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), Value::String(v));
            changed = true;
        }
    }

    if env.remove("ANTHROPIC_SMALL_FAST_MODEL").is_some() {
        changed = true;
    }

    changed
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderSortUpdate {
    pub id: String,
    #[serde(rename = "sortIndex")]
    pub sort_index: usize,
}

// ============================================================================
// 统一供应商（Universal Provider）服务方法
// ============================================================================

use crate::provider::UniversalProvider;
use std::collections::HashMap;

impl ProviderService {
    /// 获取所有统一供应商
    pub fn list_universal(
        state: &AppState,
    ) -> Result<HashMap<String, UniversalProvider>, AppError> {
        state.db.get_all_universal_providers()
    }

    /// 获取单个统一供应商
    pub fn get_universal(
        state: &AppState,
        id: &str,
    ) -> Result<Option<UniversalProvider>, AppError> {
        state.db.get_universal_provider(id)
    }

    /// 添加或更新统一供应商（不自动同步，需手动调用 sync_universal_to_apps）
    pub fn upsert_universal(
        state: &AppState,
        provider: UniversalProvider,
    ) -> Result<bool, AppError> {
        // 保存统一供应商
        state.db.save_universal_provider(&provider)?;

        Ok(true)
    }

    /// 删除统一供应商
    pub fn delete_universal(state: &AppState, id: &str) -> Result<bool, AppError> {
        let apps = [AppType::Claude, AppType::Codex, AppType::Gemini];
        let _guards = futures::executor::block_on(Self::lock_deletion(state, &apps));
        // Check every child before deleting anything, including disabled children
        // left behind by an earlier sync. Do not silently remove an active child.
        for app in &apps {
            Self::ensure_not_current(state, app, &format!("universal-{}-{id}", app.as_str()))?;
        }
        for app in &apps {
            Self::delete_universal_child(state, app, id)?;
        }
        state.db.delete_universal_provider(id)?;

        Ok(true)
    }

    /// 同步统一供应商到各应用
    pub fn sync_universal_to_apps(state: &AppState, id: &str) -> Result<bool, AppError> {
        let apps = [AppType::Claude, AppType::Codex, AppType::Gemini];
        let _guards = futures::executor::block_on(Self::lock_deletion(state, &apps));
        let provider = state
            .db
            .get_universal_provider(id)?
            .ok_or_else(|| AppError::Message(format!("统一供应商 {id} 不存在")))?;

        for (app, enabled) in [
            (AppType::Claude, provider.apps.claude),
            (AppType::Codex, provider.apps.codex),
            (AppType::Gemini, provider.apps.gemini),
        ] {
            if !enabled {
                Self::ensure_not_current(state, &app, &format!("universal-{}-{id}", app.as_str()))?;
            }
        }

        // 同步到 Claude
        if let Some(mut claude_provider) = provider.to_claude_provider() {
            // 合并已有配置
            if let Some(existing) = state.db.get_provider_by_id(&claude_provider.id, "claude")? {
                let mut merged = existing.settings_config.clone();
                Self::merge_json(&mut merged, &claude_provider.settings_config);
                claude_provider.settings_config = merged;
                claude_provider.meta = existing.meta;
                claude_provider.created_at = existing.created_at;
                claude_provider.sort_index = existing.sort_index;
            }
            state.db.save_provider("claude", &claude_provider)?;
        } else {
            // 如果禁用了 Claude，删除对应的子供应商
            Self::delete_universal_child(state, &AppType::Claude, id)?;
        }

        // 同步到 Codex
        if let Some(mut codex_provider) = provider.to_codex_provider() {
            // 合并已有配置
            if let Some(existing) = state.db.get_provider_by_id(&codex_provider.id, "codex")? {
                let mut merged = existing.settings_config.clone();
                Self::merge_json(&mut merged, &codex_provider.settings_config);
                codex_provider.settings_config = merged;
                codex_provider.meta = existing.meta;
                codex_provider.created_at = existing.created_at;
                codex_provider.sort_index = existing.sort_index;
            }
            state.db.save_provider("codex", &codex_provider)?;
        } else {
            Self::delete_universal_child(state, &AppType::Codex, id)?;
        }

        // 同步到 Gemini
        if let Some(mut gemini_provider) = provider.to_gemini_provider() {
            // 合并已有配置
            if let Some(existing) = state.db.get_provider_by_id(&gemini_provider.id, "gemini")? {
                let mut merged = existing.settings_config.clone();
                Self::merge_json(&mut merged, &gemini_provider.settings_config);
                gemini_provider.settings_config = merged;
                gemini_provider.meta = existing.meta;
                gemini_provider.created_at = existing.created_at;
                gemini_provider.sort_index = existing.sort_index;
            }
            state.db.save_provider("gemini", &gemini_provider)?;
        } else {
            Self::delete_universal_child(state, &AppType::Gemini, id)?;
        }

        Ok(true)
    }

    /// 递归合并 JSON：base 为底，patch 覆盖同名字段
    fn merge_json(base: &mut serde_json::Value, patch: &serde_json::Value) {
        use serde_json::Value;

        match (base, patch) {
            (Value::Object(base_map), Value::Object(patch_map)) => {
                for (k, v_patch) in patch_map {
                    match base_map.get_mut(k) {
                        Some(v_base) => Self::merge_json(v_base, v_patch),
                        None => {
                            base_map.insert(k.clone(), v_patch.clone());
                        }
                    }
                }
            }
            // 其它类型：直接覆盖
            (base_val, patch_val) => {
                *base_val = patch_val.clone();
            }
        }
    }
}
