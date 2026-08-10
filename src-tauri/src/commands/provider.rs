use indexmap::IndexMap;
use tauri::{Emitter, Manager, State};

use crate::app_config::AppType;
use crate::commands::copilot::CopilotAuthState;
use crate::error::AppError;
use crate::provider::{ClaudeDesktopMode, Provider};
use crate::services::provider::LiveSnapshot;
use crate::services::{
    EndpointLatency, ProviderService, ProviderSortUpdate, SpeedtestService, SwitchResult,
};
use crate::store::AppState;
use std::str::FromStr;

// 常量定义
const TEMPLATE_TYPE_GITHUB_COPILOT: &str = "github_copilot";
const TEMPLATE_TYPE_TOKEN_PLAN: &str = "token_plan";
const TEMPLATE_TYPE_BALANCE: &str = "balance";
const TEMPLATE_TYPE_OFFICIAL_SUBSCRIPTION: &str = "official_subscription";
const COPILOT_UNIT_PREMIUM: &str = "requests";

/// 获取所有供应商
#[tauri::command]
pub fn get_providers(
    state: State<'_, AppState>,
    app: String,
) -> Result<IndexMap<String, Provider>, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    ProviderService::list(state.inner(), app_type).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_current_provider(state: State<'_, AppState>, app: String) -> Result<String, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    ProviderService::current(state.inner(), app_type).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_provider(
    state: State<'_, AppState>,
    app: String,
    provider: Provider,
    #[allow(non_snake_case)] addToLive: Option<bool>,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    add_provider_with_automatic_routing_state(
        state.inner().clone(),
        app_type,
        provider,
        addToLive.unwrap_or(true),
    )
    .await
}

/// Add a provider and activate it in the same compensated routing transaction.
///
/// This command is intended for UI flows whose user-visible action is
/// "save and apply". Unlike calling `add_provider` and `switch_provider`
/// separately, a failed activation restores the previous provider, Live
/// configuration and proxy state instead of leaving an inactive staged row.
#[tauri::command]
pub async fn add_and_activate_provider(
    state: State<'_, AppState>,
    app: String,
    provider: Provider,
    #[allow(non_snake_case)] addToLive: Option<bool>,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    add_and_activate_provider_with_automatic_routing_state(
        state.inner().clone(),
        app_type,
        provider,
        addToLive.unwrap_or(true),
    )
    .await
}

#[tauri::command]
pub async fn update_provider(
    state: State<'_, AppState>,
    app: String,
    provider: Provider,
    #[allow(non_snake_case)] originalId: Option<String>,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    update_provider_with_automatic_routing_state(
        state.inner().clone(),
        app_type,
        originalId,
        provider,
    )
    .await
}

/// Update a provider and activate it in one compensated Codex-family
/// transaction. This is the UI's "save and apply" path for an existing row:
/// if switching the edited inactive provider fails, both its old row and the
/// prior current/Live/routing state are restored.
#[tauri::command]
pub async fn update_and_activate_provider(
    state: State<'_, AppState>,
    app: String,
    provider: Provider,
    #[allow(non_snake_case)] originalId: Option<String>,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    update_provider_with_automatic_routing_mode(
        state.inner().clone(),
        app_type,
        originalId,
        provider,
        true,
    )
    .await
}

/// Update a provider and atomically reconcile Codex-family routing when the
/// edited row is current. The old provider row, current pointers, Live files,
/// takeover backup and route/process state are captured under the same locks so
/// a failed Live write or protocol transition cannot leave DB and Live split.
pub(crate) async fn update_provider_with_automatic_routing_state(
    state: AppState,
    app_type: AppType,
    original_id: Option<String>,
    provider: Provider,
) -> Result<bool, String> {
    update_provider_with_automatic_routing_mode(state, app_type, original_id, provider, false).await
}

async fn update_provider_with_automatic_routing_mode(
    state: AppState,
    app_type: AppType,
    original_id: Option<String>,
    provider: Provider,
    activate_when_inactive: bool,
) -> Result<bool, String> {
    // Profile application owns this lock for its complete multi-resource
    // transaction. Provider edits must wait until that transaction commits so
    // they cannot leave the current Profile marker pointing at mixed state.
    let _profile_guard = state.profile_apply_lock.lock().await;
    let auto_manage_routing = matches!(app_type, AppType::Codex | AppType::GrokBuild);
    if !auto_manage_routing {
        return ProviderService::update(&state, app_type, original_id.as_deref(), provider)
            .map_err(|e| e.to_string());
    }

    let proxy_service = state.proxy_service.clone();
    let _lifecycle_guard = proxy_service.lock_lifecycle().await;
    let _switch_guard = proxy_service.lock_switch_for_app(app_type.as_str()).await;
    let original_id = original_id.unwrap_or_else(|| provider.id.clone());
    let updated_id = provider.id.clone();
    let previous_provider = state
        .db
        .get_provider_by_id(&original_id, app_type.as_str())
        .map_err(|e| format!("读取 {} 原供应商失败: {e}", app_type.as_str()))?;
    let previous_current = crate::settings::get_effective_current_provider(&state.db, &app_type)
        .map_err(|e| format!("读取 {} 当前供应商失败: {e}", app_type.as_str()))?;
    let is_current = previous_current.as_deref() == Some(original_id.as_str());

    // A normal edit of an inactive provider only changes its stored row. The
    // explicit "save and apply" flow instead continues below with the same
    // snapshots and compensation used for a current-provider edit.
    if !is_current && !activate_when_inactive {
        return ProviderService::update(&state, app_type, Some(&original_id), provider)
            .map_err(|e| e.to_string());
    }

    let previous_local = crate::settings::get_current_provider(&app_type);
    let previous_db = state
        .db
        .get_current_provider(app_type.as_str())
        .map_err(|e| format!("读取 {} 数据库当前供应商失败: {e}", app_type.as_str()))?;
    let previous_live = LiveSnapshot::capture(&app_type)
        .map_err(|e| format!("读取 {} 原 Live 配置失败: {e}", app_type.as_str()))?;
    let previous_backup = state
        .db
        .get_live_backup(app_type.as_str())
        .await
        .map_err(|e| format!("读取 {} 原 Live 备份失败: {e}", app_type.as_str()))?;
    let previous_routing_enabled = state
        .db
        .get_proxy_config_for_app(app_type.as_str())
        .await
        .map_err(|e| format!("读取 {} 原路由状态失败: {e}", app_type.as_str()))?
        .enabled;
    let previous_proxy_running = proxy_service.is_running().await;
    let previous_global_proxy_config = state
        .db
        .get_global_proxy_config()
        .await
        .map_err(|e| format!("读取原代理全局配置失败: {e}"))?;

    // ProviderService::update is synchronous but may bridge into async proxy
    // backup refreshes when Live is currently taken over. Run it on a blocking
    // worker so those bridges cannot starve/deadlock the Tauri Tokio runtime.
    let update_state = state.clone();
    let update_app_type = app_type.clone();
    let update_original_id = original_id.clone();
    let update_result = tauri::async_runtime::spawn_blocking(move || {
        ProviderService::update_with_app_lock_held(
            &update_state,
            update_app_type,
            Some(&update_original_id),
            provider,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("供应商更新任务执行失败: {e}"))
    .and_then(|result| result);

    if let Err(error) = update_result {
        let rollback = compensate_failed_current_provider_update(
            &state,
            &app_type,
            &updated_id,
            previous_provider.as_ref(),
            previous_local.as_deref(),
            previous_db.as_deref(),
            previous_live.as_ref(),
            previous_backup.as_ref(),
            previous_routing_enabled,
            previous_proxy_running,
            &previous_global_proxy_config,
        )
        .await;
        return Err(match rollback {
            Some(rollback_error) => {
                format!("更新供应商失败: {error}；回滚失败: {rollback_error}")
            }
            None => format!("更新供应商失败: {error}"),
        });
    }

    match switch_provider_with_automatic_routing_locked(
        &state,
        app_type.clone(),
        updated_id.clone(),
        true,
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(error) => {
            let rollback = compensate_failed_current_provider_update(
                &state,
                &app_type,
                &updated_id,
                previous_provider.as_ref(),
                previous_local.as_deref(),
                previous_db.as_deref(),
                previous_live.as_ref(),
                previous_backup.as_ref(),
                previous_routing_enabled,
                previous_proxy_running,
                &previous_global_proxy_config,
            )
            .await;
            Err(match rollback {
                Some(rollback_error) => {
                    format!("{error}；更新供应商回滚失败: {rollback_error}")
                }
                None => error,
            })
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn compensate_failed_current_provider_update(
    state: &AppState,
    app_type: &AppType,
    updated_id: &str,
    previous_provider: Option<&Provider>,
    previous_local: Option<&str>,
    previous_db: Option<&str>,
    previous_live: Option<&LiveSnapshot>,
    previous_backup: Option<&crate::proxy::types::LiveBackup>,
    previous_routing_enabled: bool,
    previous_proxy_running: bool,
    previous_global_proxy_config: &crate::proxy::types::GlobalProxyConfig,
) -> Option<String> {
    let mut errors = Vec::new();

    if previous_provider.is_none() {
        if let Err(error) = state.db.delete_provider(app_type.as_str(), updated_id) {
            errors.push(format!("删除更新后的供应商失败: {error}"));
        }
    } else if let Some(previous_provider) = previous_provider {
        if previous_provider.id != updated_id {
            if let Err(error) = state.db.delete_provider(app_type.as_str(), updated_id) {
                errors.push(format!("删除改名后的供应商失败: {error}"));
            }
        }
        if let Err(error) = state.db.save_provider(app_type.as_str(), previous_provider) {
            errors.push(format!("恢复原供应商记录失败: {error}"));
        }
    }
    if let Some(previous_db) = previous_db {
        if let Err(error) = state
            .db
            .set_current_provider(app_type.as_str(), previous_db)
        {
            errors.push(format!("恢复数据库当前供应商失败: {error}"));
        }
    }
    if let Err(error) = crate::settings::set_current_provider(app_type, previous_local) {
        errors.push(format!("恢复本地当前供应商失败: {error}"));
    }

    if let Some(error) = rollback_automatic_routing(
        &state.proxy_service,
        app_type,
        previous_routing_enabled,
        previous_proxy_running,
        previous_global_proxy_config,
    )
    .await
    {
        errors.push(format!("恢复原路由状态失败: {error}"));
    }

    let backup_result = match previous_backup {
        Some(backup) => {
            state
                .db
                .save_live_backup(app_type.as_str(), &backup.original_config)
                .await
        }
        None => state.db.delete_live_backup(app_type.as_str()).await,
    };
    if let Err(error) = backup_result {
        errors.push(format!("恢复原 Live 备份失败: {error}"));
    }
    if let Some(previous_live) = previous_live {
        if let Err(error) = previous_live.restore() {
            errors.push(format!("恢复原 Live 配置失败: {error}"));
        }
    }

    (!errors.is_empty()).then(|| errors.join("；"))
}

#[tauri::command]
pub fn delete_provider(
    state: State<'_, AppState>,
    app: String,
    id: String,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    ProviderService::delete(state.inner(), app_type, &id)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_provider_from_live_config(
    state: tauri::State<'_, AppState>,
    app: String,
    id: String,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    ProviderService::remove_from_live_config(state.inner(), app_type, &id)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

fn switch_provider_internal(
    state: &AppState,
    app_type: AppType,
    id: &str,
) -> Result<SwitchResult, AppError> {
    ProviderService::switch(state, app_type, id)
}

fn switch_provider_with_app_lock_held_internal(
    state: &AppState,
    app_type: AppType,
    id: &str,
) -> Result<SwitchResult, AppError> {
    ProviderService::switch_with_app_lock_held(state, app_type, id)
}

/// Codex-family clients speak Responses natively. Chat Completions, Anthropic
/// Messages, full endpoint URLs, and managed OAuth credentials require the
/// local router to translate or inject authentication.
fn provider_requires_automatic_routing(app_type: &AppType, provider: &Provider) -> bool {
    if !matches!(app_type, AppType::Codex | AppType::GrokBuild)
        || provider.category.as_deref() == Some("official")
    {
        return false;
    }

    let meta = provider.meta.as_ref();
    let is_full_url = meta.and_then(|meta| meta.is_full_url).unwrap_or(false);
    let uses_local_proxy_features = meta.is_some_and(|meta| {
        meta.custom_user_agent
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            || meta
                .local_proxy_request_overrides
                .as_ref()
                .is_some_and(|overrides| !overrides.is_empty())
    });

    provider.uses_managed_account_auth()
        || is_full_url
        || uses_local_proxy_features
        || crate::proxy::providers::codex_provider_uses_chat_completions(provider)
        || crate::proxy::providers::codex_provider_uses_anthropic(provider)
        || crate::proxy::providers::codex_provider_has_model_level_routing(provider)
        // api_format=None ("自动") 的供应商需走代理，代理层才能触发 Responses→Chat 自动检测
        || crate::proxy::providers::codex_provider_is_auto_detect_candidate(provider)
}

async fn rollback_automatic_routing(
    proxy_service: &crate::services::ProxyService,
    app_type: &AppType,
    previous_enabled: bool,
    previous_proxy_running: bool,
    previous_global_proxy_config: &crate::proxy::types::GlobalProxyConfig,
) -> Option<String> {
    let mut errors = Vec::new();
    if let Err(error) = proxy_service
        .set_takeover_for_app_inner(app_type, previous_enabled)
        .await
    {
        errors.push(error);
    }

    // Route ownership and process lifetime are separate pieces of state. An
    // enabled takeover can legitimately have a stopped process after an abnormal
    // exit; compensation must reproduce that exact snapshot rather than starting
    // the server as an accidental side effect of set_takeover_for_app_inner(true).
    if let Err(error) = proxy_service
        .restore_runtime_state_inner(previous_proxy_running, previous_global_proxy_config)
        .await
    {
        errors.push(error);
    }

    (!errors.is_empty()).then(|| errors.join("；"))
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub fn switch_provider_test_hook(
    state: &AppState,
    app_type: AppType,
    id: &str,
) -> Result<SwitchResult, AppError> {
    switch_provider_internal(state, app_type, id)
}

/// Add a provider and, when it becomes the first selected Codex-family
/// provider, activate it through the same automatic routing transaction as a
/// normal switch. This is the fresh/unlogged-in path where no official current
/// provider exists yet.
pub(crate) async fn add_provider_with_automatic_routing_state(
    state: AppState,
    app_type: AppType,
    provider: Provider,
    add_to_live: bool,
) -> Result<bool, String> {
    add_provider_with_automatic_routing_mode(state, app_type, provider, add_to_live, false).await
}

/// Atomically stage and activate an enabled Codex-family provider import.
/// Snapshotting, first-provider detection, switching and compensation all run
/// under the same lifecycle/per-app locks so concurrent switches cannot be
/// overwritten by a stale Deep Link snapshot.
pub(crate) async fn add_and_activate_provider_with_automatic_routing_state(
    state: AppState,
    app_type: AppType,
    provider: Provider,
    add_to_live: bool,
) -> Result<bool, String> {
    add_provider_with_automatic_routing_mode(state, app_type, provider, add_to_live, true).await
}

async fn add_provider_with_automatic_routing_mode(
    state: AppState,
    app_type: AppType,
    provider: Provider,
    add_to_live: bool,
    activate_when_current_exists: bool,
) -> Result<bool, String> {
    // Keep Deep Link/UI imports outside an in-flight Profile transaction. Lock
    // order is always profile -> lifecycle -> per-app.
    let _profile_guard = state.profile_apply_lock.lock().await;
    let auto_manage_routing = matches!(app_type, AppType::Codex | AppType::GrokBuild);
    if !auto_manage_routing {
        if !activate_when_current_exists {
            return ProviderService::add(&state, app_type, provider, add_to_live)
                .map_err(|e| e.to_string());
        }

        // Enabled Deep Link imports for every other app use the same complete
        // Profile transaction boundary as UI/tray switches. Capture, staging,
        // activation and compensation all happen while profile_apply_lock is
        // held, so a Profile Apply cannot advance current/Live between them.
        let previous_local = crate::settings::get_current_provider(&app_type);
        let previous_db = state
            .db
            .get_current_provider(app_type.as_str())
            .map_err(|e| format!("读取 {} 数据库当前供应商失败: {e}", app_type.as_str()))?;
        let previous_live = LiveSnapshot::capture(&app_type)
            .map_err(|e| format!("读取 {} 原 Live 配置失败: {e}", app_type.as_str()))?;
        let previous_provider = state
            .db
            .get_provider_by_id(&provider.id, app_type.as_str())
            .map_err(|e| e.to_string())?;
        let provider_id = provider.id.clone();

        ProviderService::add_inactive(&state, app_type.clone(), provider, add_to_live)
            .map_err(|e| e.to_string())?;

        let switch_state = state.clone();
        let switch_app = app_type.clone();
        let switch_id = provider_id.clone();
        let switched = tauri::async_runtime::spawn_blocking(move || {
            switch_provider_internal(&switch_state, switch_app, &switch_id)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("供应商启用任务执行失败: {e}"))
        .and_then(|result| result.map(|_| ()));

        return match switched {
            Ok(()) => Ok(true),
            Err(error) => {
                let rollback = compensate_failed_direct_provider_add(
                    &state,
                    &app_type,
                    &provider_id,
                    previous_provider.as_ref(),
                    previous_local.as_deref(),
                    previous_db.as_deref(),
                    previous_live.as_ref(),
                );
                Err(match rollback {
                    Some(rollback_error) => {
                        format!("{error}；添加供应商回滚失败: {rollback_error}")
                    }
                    None => error,
                })
            }
        };
    }

    let proxy_service = state.proxy_service.clone();
    let _lifecycle_guard = proxy_service.lock_lifecycle().await;
    let _switch_guard = proxy_service.lock_switch_for_app(app_type.as_str()).await;
    let previous_current = crate::settings::get_effective_current_provider(&state.db, &app_type)
        .map_err(|e| format!("读取 {} 当前供应商失败: {e}", app_type.as_str()))?;
    let previous_local = crate::settings::get_current_provider(&app_type);
    let previous_db = state
        .db
        .get_current_provider(app_type.as_str())
        .map_err(|e| format!("读取 {} 数据库当前供应商失败: {e}", app_type.as_str()))?;
    let previous_live = LiveSnapshot::capture(&app_type)
        .map_err(|e| format!("读取 {} 原 Live 配置失败: {e}", app_type.as_str()))?;
    let previous_backup = state
        .db
        .get_live_backup(app_type.as_str())
        .await
        .map_err(|e| format!("读取 {} 原 Live 备份失败: {e}", app_type.as_str()))?;
    let previous_routing_enabled = state
        .db
        .get_proxy_config_for_app(app_type.as_str())
        .await
        .map_err(|e| format!("读取 {} 原路由状态失败: {e}", app_type.as_str()))?
        .enabled;
    let previous_proxy_running = proxy_service.is_running().await;
    let previous_global_proxy_config = state
        .db
        .get_global_proxy_config()
        .await
        .map_err(|e| format!("读取原代理全局配置失败: {e}"))?;
    let previous_provider = state
        .db
        .get_provider_by_id(&provider.id, app_type.as_str())
        .map_err(|e| e.to_string())?;
    let provider_id = provider.id.clone();

    ProviderService::add_inactive(&state, app_type.clone(), provider, add_to_live)
        .map_err(|e| e.to_string())?;
    if previous_current.is_some() && !activate_when_current_exists {
        return Ok(true);
    }

    let target = state
        .db
        .get_provider_by_id(&provider_id, app_type.as_str())
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("暂存供应商 {provider_id} 后无法读取"))?;

    // A fresh/unlogged-in Codex installation has no auth.json/config.toml to
    // back up. Establish the first provider's normal direct Live projection and
    // logical current pointer before takeover. The takeover can then preserve
    // that direct projection as its restore baseline, so disabling routing later
    // returns to a usable third-party configuration rather than an empty client.
    if provider_requires_automatic_routing(&app_type, &target) {
        let activate_state = state.clone();
        let activate_app = app_type.clone();
        let activate_id = provider_id.clone();
        let activation = tauri::async_runtime::spawn_blocking(move || {
            switch_provider_with_app_lock_held_internal(&activate_state, activate_app, &activate_id)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("首次供应商直连初始化任务执行失败: {e}"))
        .and_then(|result| result.map(|_| ()));

        if let Err(error) = activation {
            let rollback = compensate_failed_provider_add(
                &state,
                &app_type,
                &provider_id,
                previous_provider.as_ref(),
                previous_local.as_deref(),
                previous_db.as_deref(),
                previous_live.as_ref(),
                previous_backup.as_ref(),
                previous_routing_enabled,
                previous_proxy_running,
                &previous_global_proxy_config,
            )
            .await;
            return Err(match rollback {
                Some(rollback_error) => {
                    format!("首次供应商直连初始化失败: {error}；回滚失败: {rollback_error}")
                }
                None => format!("首次供应商直连初始化失败: {error}"),
            });
        }
    }

    match switch_provider_with_automatic_routing_locked(
        &state,
        app_type.clone(),
        provider_id.clone(),
        true,
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(error) => {
            let rollback = compensate_failed_provider_add(
                &state,
                &app_type,
                &provider_id,
                previous_provider.as_ref(),
                previous_local.as_deref(),
                previous_db.as_deref(),
                previous_live.as_ref(),
                previous_backup.as_ref(),
                previous_routing_enabled,
                previous_proxy_running,
                &previous_global_proxy_config,
            )
            .await;
            Err(match rollback {
                Some(rollback_error) => {
                    format!("{error}；添加供应商回滚失败: {rollback_error}")
                }
                None => error,
            })
        }
    }
}

fn compensate_failed_direct_provider_add(
    state: &AppState,
    app_type: &AppType,
    provider_id: &str,
    previous_provider: Option<&Provider>,
    previous_local: Option<&str>,
    previous_db: Option<&str>,
    previous_live: Option<&LiveSnapshot>,
) -> Option<String> {
    let mut errors = Vec::new();

    // Keep compensation inside profile_apply_lock. Delete the staged row first
    // so restoring an overwritten provider cannot inherit its is_current flag.
    if let Err(error) = state.db.delete_provider(app_type.as_str(), provider_id) {
        errors.push(format!("删除暂存供应商失败: {error}"));
    }
    if let Some(previous_provider) = previous_provider {
        if let Err(error) = state.db.save_provider(app_type.as_str(), previous_provider) {
            errors.push(format!("恢复原供应商记录失败: {error}"));
        }
    }
    if let Some(previous_db) = previous_db {
        if let Err(error) = state
            .db
            .set_current_provider(app_type.as_str(), previous_db)
        {
            errors.push(format!("恢复数据库当前供应商失败: {error}"));
        }
    }
    if let Err(error) = crate::settings::set_current_provider(app_type, previous_local) {
        errors.push(format!("恢复本地当前供应商失败: {error}"));
    }
    if let Some(previous_live) = previous_live {
        if let Err(error) = previous_live.restore() {
            errors.push(format!("恢复原 Live 配置失败: {error}"));
        }
    }

    (!errors.is_empty()).then(|| errors.join("；"))
}

#[allow(clippy::too_many_arguments)]
async fn compensate_failed_provider_add(
    state: &AppState,
    app_type: &AppType,
    provider_id: &str,
    previous_provider: Option<&Provider>,
    previous_local: Option<&str>,
    previous_db: Option<&str>,
    previous_live: Option<&LiveSnapshot>,
    previous_backup: Option<&crate::proxy::types::LiveBackup>,
    previous_routing_enabled: bool,
    previous_proxy_running: bool,
    previous_global_proxy_config: &crate::proxy::types::GlobalProxyConfig,
) -> Option<String> {
    let mut errors = Vec::new();

    // Delete first so restoring an overwritten provider cannot inherit the
    // staged row's is_current flag from Database::save_provider.
    if let Err(error) = state.db.delete_provider(app_type.as_str(), provider_id) {
        errors.push(format!("删除暂存供应商失败: {error}"));
    }
    if let Some(previous_provider) = previous_provider {
        if let Err(error) = state.db.save_provider(app_type.as_str(), previous_provider) {
            errors.push(format!("恢复原供应商记录失败: {error}"));
        }
    }
    if let Some(previous_db) = previous_db {
        if let Err(error) = state
            .db
            .set_current_provider(app_type.as_str(), previous_db)
        {
            errors.push(format!("恢复数据库当前供应商失败: {error}"));
        }
    }
    if let Err(error) = crate::settings::set_current_provider(app_type, previous_local) {
        errors.push(format!("恢复本地当前供应商失败: {error}"));
    }

    if let Some(error) = rollback_automatic_routing(
        &state.proxy_service,
        app_type,
        previous_routing_enabled,
        previous_proxy_running,
        previous_global_proxy_config,
    )
    .await
    {
        errors.push(format!("恢复原路由状态失败: {error}"));
    }

    let backup_result = match previous_backup {
        Some(backup) => {
            state
                .db
                .save_live_backup(app_type.as_str(), &backup.original_config)
                .await
        }
        None => state.db.delete_live_backup(app_type.as_str()).await,
    };
    if let Err(error) = backup_result {
        errors.push(format!("恢复原 Live 备份失败: {error}"));
    }
    if let Some(previous_live) = previous_live {
        if let Err(error) = previous_live.restore() {
            errors.push(format!("恢复原 Live 配置失败: {error}"));
        }
    }

    (!errors.is_empty()).then(|| errors.join("；"))
}

#[tauri::command]
pub async fn switch_provider(
    app_handle: tauri::AppHandle,
    app: String,
    id: String,
) -> Result<SwitchResult, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    switch_provider_with_automatic_routing(app_handle, app_type, id).await
}

/// Shared provider switch path for the main UI and tray. Codex-family apps
/// reconcile takeover automatically before switching; other apps retain their
/// existing routing behavior.
pub(crate) async fn switch_provider_with_automatic_routing(
    app_handle: tauri::AppHandle,
    app_type: AppType,
    id: String,
) -> Result<SwitchResult, String> {
    let state = app_handle
        .try_state::<AppState>()
        .ok_or_else(|| "应用状态不可用".to_string())?
        .inner()
        .clone();
    switch_provider_with_automatic_routing_state(state, app_type, id).await
}

/// State-based automatic routing transaction reused by UI, tray, Profile and
/// import paths. All Codex-family switches must pass through this function.
pub(crate) async fn switch_provider_with_automatic_routing_state(
    state: AppState,
    app_type: AppType,
    id: String,
) -> Result<SwitchResult, String> {
    let profile_lock = state.profile_apply_lock.clone();
    let _profile_guard = profile_lock.lock().await;
    switch_provider_with_automatic_routing_profile_lock_held_state(state, app_type, id).await
}

/// ProfileService already owns `profile_apply_lock` for its complete Provider +
/// MCP + Skills + Prompt transaction. This lock-held entry avoids re-entering
/// the non-reentrant mutex while preserving profile -> lifecycle -> app order.
pub(crate) async fn switch_provider_with_automatic_routing_profile_lock_held_state(
    state: AppState,
    app_type: AppType,
    id: String,
) -> Result<SwitchResult, String> {
    let auto_manage_routing = matches!(app_type, AppType::Codex | AppType::GrokBuild);
    let proxy_service = state.proxy_service.clone();

    // Hold the same per-app lock from the first state read through routing
    // reconciliation, provider commit, and rollback. ProviderService uses its
    // lock-free inner path below, so concurrent UI/tray switches cannot slip
    // between the routing and provider phases.
    let _lifecycle_guard = if auto_manage_routing {
        Some(proxy_service.lock_lifecycle().await)
    } else {
        None
    };
    let _switch_guard = if auto_manage_routing {
        Some(proxy_service.lock_switch_for_app(app_type.as_str()).await)
    } else {
        None
    };

    switch_provider_with_automatic_routing_locked(&state, app_type, id, auto_manage_routing).await
}

/// Execute the routing/provider transaction while the caller owns the lifecycle
/// and per-app locks for Codex-family apps.
async fn switch_provider_with_automatic_routing_locked(
    state: &AppState,
    app_type: AppType,
    id: String,
    auto_manage_routing: bool,
) -> Result<SwitchResult, String> {
    let proxy_service = state.proxy_service.clone();
    let db = state.db.clone();

    // Resolve the target only after acquiring the transaction lock. This makes
    // all routing decisions use a current, serialized provider snapshot.
    let target = db
        .get_provider_by_id(&id, app_type.as_str())
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("供应商 {id} 不存在"))?;
    let routing_required = provider_requires_automatic_routing(&app_type, &target);
    let previous_routing_enabled = if auto_manage_routing {
        db.get_proxy_config_for_app(app_type.as_str())
            .await
            .map_err(|e| format!("获取 {} 路由状态失败: {e}", app_type.as_str()))?
            .enabled
    } else {
        false
    };
    let previous_proxy_running = proxy_service.is_running().await;
    let previous_global_proxy_config = if auto_manage_routing {
        Some(
            db.get_global_proxy_config()
                .await
                .map_err(|e| format!("读取原代理全局配置失败: {e}"))?,
        )
    } else {
        None
    };
    let previous_provider_id = if auto_manage_routing {
        crate::settings::get_effective_current_provider(db.as_ref(), &app_type)
            .map_err(|e| format!("读取 {} 当前供应商失败: {e}", app_type.as_str()))?
    } else {
        None
    };

    // Do not turn off an active takeover merely to bypass the official-provider
    // safety policy. Only the built-in Codex official entry is explicitly
    // compatible; copied/forged `category = official` entries remain blocked.
    if auto_manage_routing
        && previous_routing_enabled
        && target.category.as_deref() == Some("official")
        && !crate::services::provider::official_provider_supports_proxy_takeover(&app_type, &target)
    {
        return Err(
            "代理接管模式下不能切换到此官方供应商。请先关闭接管，或选择受支持的官方供应商。"
                .to_string(),
        );
    }

    let routing_changed = auto_manage_routing && previous_routing_enabled != routing_required;
    let routing_reconciliation_required = if auto_manage_routing {
        let has_backup = db
            .get_live_backup(app_type.as_str())
            .await
            .map_err(|e| format!("读取 {} Live 备份失败: {e}", app_type.as_str()))?
            .is_some();
        let live_taken_over = proxy_service.detect_takeover_in_live_config_for_app(&app_type);
        let live_matches_current_proxy = match proxy_service
            .live_takeover_matches_current_proxy(&app_type)
            .await
        {
            Ok(matches) => matches,
            Err(error) if !previous_routing_enabled && !has_backup && !live_taken_over => {
                // Fresh/unlogged-in installs legitimately have no Live files yet.
                // The takeover transaction below will create them; absence is
                // not an ownership failure and must not block the first provider.
                log::debug!(
                    "{} 尚无可核对的 Live 路由，将按首次接管创建: {error}",
                    app_type.as_str()
                );
                false
            }
            Err(error) => {
                return Err(format!(
                    "核对 {} Live 路由所有权失败: {error}",
                    app_type.as_str()
                ));
            }
        };
        if routing_required {
            // enabled=true is not sufficient: backup/live can be missing or can
            // point at a stale proxy port. Reconcile unless the full route is
            // owned by the currently configured local proxy endpoint.
            !previous_routing_enabled || !has_backup || !live_matches_current_proxy
        } else {
            // When disabling, also clean a stale owned route left on another
            // local port; the recovery helper protects unrelated user config.
            previous_routing_enabled || has_backup || live_taken_over
        }
    } else {
        false
    };

    // Always reconcile Codex-family routing under the transaction lock. The
    // inner operation is idempotent and repairs both split-brain directions:
    // DB=false with stale Live, and DB=true with missing/stale takeover.
    if auto_manage_routing {
        if let Err(error) = proxy_service
            .set_takeover_for_app_inner(&app_type, routing_required)
            .await
        {
            let rollback = rollback_automatic_routing(
                &proxy_service,
                &app_type,
                previous_routing_enabled,
                previous_proxy_running,
                previous_global_proxy_config
                    .as_ref()
                    .expect("Codex-family transaction captured global proxy config"),
            )
            .await;
            return Err(match rollback {
                Some(rollback_error) => format!(
                    "自动{}本地路由失败: {error}；回滚失败: {rollback_error}",
                    if routing_required { "开启" } else { "关闭" }
                ),
                None => format!(
                    "自动{}本地路由失败: {error}",
                    if routing_required { "开启" } else { "关闭" }
                ),
            });
        }
    }

    let switch_app_type = app_type.clone();
    let switch_id = id.clone();
    let switch_state = state.clone();
    let switch_result = match tauri::async_runtime::spawn_blocking(move || {
        if auto_manage_routing {
            switch_provider_with_app_lock_held_internal(&switch_state, switch_app_type, &switch_id)
        } else {
            switch_provider_internal(&switch_state, switch_app_type, &switch_id)
        }
        .map_err(|e| e.to_string())
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!("供应商切换任务执行失败: {error}")),
    };

    match switch_result {
        Ok(mut result) => {
            result.routing_changed = routing_changed || routing_reconciliation_required;
            result.routing_enabled = auto_manage_routing.then_some(routing_required);

            // 线路切换是会话「看起来丢失」的触发点：新 live 的 model_provider 变了，
            // Codex 只列出与之相同的会话，旧桶里的历史就从列表消失。切换完成后把
            // 未归档历史归拢到当前桶，使列表始终完整，无需用户手动点恢复。
            //
            // 放在这里而不是切换事务内部：改写会话文件与供应商切换是两个独立的写
            // 域，归拢失败绝不能回滚一次成功的切换（函数内部只记日志）。大目录扫描
            // 可能耗时，因此丢到后台线程，不拖慢切换返回。
            if matches!(app_type, AppType::Codex) {
                tauri::async_runtime::spawn_blocking(
                    crate::codex_history_migration::auto_reclaim_codex_history_if_needed,
                );
            }

            Ok(result)
        }
        Err(error) => {
            if routing_changed {
                let rollback = rollback_automatic_routing(
                    &proxy_service,
                    &app_type,
                    previous_routing_enabled,
                    previous_proxy_running,
                    previous_global_proxy_config
                        .as_ref()
                        .expect("Codex-family transaction captured global proxy config"),
                )
                .await;
                if let Some(rollback_error) = rollback {
                    return Err(format!("{error}；本地路由回滚失败: {rollback_error}"));
                }
            } else {
                let mut compensation_errors = Vec::new();
                if routing_reconciliation_required {
                    // Reconciliation intentionally does not restore a stale Live
                    // takeover. Normalize the previously selected provider in the
                    // repaired route mode so a failed target commit cannot leave
                    // Live split from SSOT.
                    if let Some(previous_id) = previous_provider_id.as_deref() {
                        let rollback_app_type = app_type.clone();
                        let rollback_id = previous_id.to_string();
                        let rollback_state = state.clone();
                        let rollback = match tauri::async_runtime::spawn_blocking(move || {
                            switch_provider_with_app_lock_held_internal(
                                &rollback_state,
                                rollback_app_type,
                                &rollback_id,
                            )
                            .map_err(|e| e.to_string())
                        })
                        .await
                        {
                            Ok(result) => result,
                            Err(error) => Err(format!("恢复原供应商任务执行失败: {error}")),
                        };
                        if let Err(rollback_error) = rollback {
                            compensation_errors.push(format!("恢复原供应商失败: {rollback_error}"));
                        }
                    }
                }

                // set_takeover_for_app_inner(true) may start a previously stopped
                // proxy even when enabled/backup/Live already match and neither
                // routing flag above changes. A failed provider commit must still
                // restore the exact process state and complete global config.
                if auto_manage_routing {
                    if let Err(rollback_error) = proxy_service
                        .restore_runtime_state_inner(
                            previous_proxy_running,
                            previous_global_proxy_config
                                .as_ref()
                                .expect("Codex-family transaction captured global proxy config"),
                        )
                        .await
                    {
                        compensation_errors
                            .push(format!("恢复原代理运行状态失败: {rollback_error}"));
                    }
                }

                if !compensation_errors.is_empty() {
                    return Err(format!(
                        "{error}；切换失败补偿失败: {}",
                        compensation_errors.join("；")
                    ));
                }
            }
            Err(error)
        }
    }
}

fn import_default_config_internal(state: &AppState, app_type: AppType) -> Result<bool, AppError> {
    if matches!(app_type, AppType::GrokBuild) {
        // 官方登录态（live 语法合法且无自定义模型表）+ 用户手动导入：
        // 导入的正确结果是让 Grok Official 成为当前供应商，而非报错。
        // 只挂在命令层 = 只有手动动作可达；启动自动导入走 service 层、
        // 官方态照旧报错静默跳过，删掉的官方条目不会被重启复活
        //（全项目惯例：启动自动导入只产出 default，从不产出官方条目）。
        if let Ok(settings) = crate::grok_config::read_grok_live_settings() {
            let config = settings
                .get("config")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if crate::grok_config::is_official_live_config(config) {
                state.db.ensure_official_seed_by_id(
                    crate::database::GROKBUILD_OFFICIAL_PROVIDER_ID,
                    AppType::GrokBuild,
                )?;
                state.db.set_current_provider(
                    app_type.as_str(),
                    crate::database::GROKBUILD_OFFICIAL_PROVIDER_ID,
                )?;
                crate::settings::set_current_provider(
                    &app_type,
                    Some(crate::database::GROKBUILD_OFFICIAL_PROVIDER_ID),
                )?;
                return Ok(true);
            }
        }

        // Safety net: 与 claude-desktop 导入同语义 —— 用户主动点导入是"重新
        // 整理该表"的隐式信号，把官方入口补回来。覆盖导入必然失败的场景
        //（live 文件缺失 / TOML 语法错误 / 残缺的自定义配置），避免
        // "报错 + 空列表"死胡同。失败只 warn，不影响导入主流程。
        if let Err(e) = state.db.ensure_official_seed_by_id(
            crate::database::GROKBUILD_OFFICIAL_PROVIDER_ID,
            AppType::GrokBuild,
        ) {
            log::warn!("Failed to ensure grokbuild-official seed during import: {e}");
        }
    }

    let imported = ProviderService::import_default_config(state, app_type.clone())?;

    if imported {
        // Extract common config snippet (mirrors old startup logic in lib.rs)
        if state
            .db
            .should_auto_extract_config_snippet(app_type.as_str())?
        {
            match ProviderService::extract_common_config_snippet(state, app_type.clone()) {
                Ok(snippet) if !snippet.is_empty() && snippet != "{}" => {
                    let _ = state
                        .db
                        .set_config_snippet(app_type.as_str(), Some(snippet));
                    let _ = state
                        .db
                        .set_config_snippet_cleared(app_type.as_str(), false);
                }
                _ => {}
            }
        }

        ProviderService::migrate_legacy_common_config_usage_if_needed(state, app_type.clone())?;
    }

    Ok(imported)
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub fn import_default_config_test_hook(
    state: &AppState,
    app_type: AppType,
) -> Result<bool, AppError> {
    import_default_config_internal(state, app_type)
}

#[tauri::command]
pub fn import_default_config(state: State<'_, AppState>, app: String) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    import_default_config_internal(&state, app_type).map_err(Into::into)
}

#[tauri::command]
pub async fn get_claude_desktop_status(
    state: State<'_, AppState>,
) -> Result<crate::claude_desktop_config::ClaudeDesktopStatus, String> {
    let proxy_running = state.proxy_service.is_running().await;
    crate::claude_desktop_config::get_status(state.db.as_ref(), proxy_running)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_claude_desktop_default_routes(
) -> Vec<crate::claude_desktop_config::ClaudeDesktopDefaultRoute> {
    crate::claude_desktop_config::default_proxy_routes()
}

#[tauri::command]
pub fn import_claude_desktop_providers_from_claude(
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let claude_providers = state
        .db
        .get_all_providers(AppType::Claude.as_str())
        .map_err(|e| e.to_string())?;
    let existing_ids = state
        .db
        .get_provider_ids(AppType::ClaudeDesktop.as_str())
        .map_err(|e| e.to_string())?;

    let mut imported = 0usize;
    for provider in claude_providers.values() {
        if existing_ids.contains(&provider.id) {
            continue;
        }

        let mut desktop_provider = provider.clone();
        desktop_provider.in_failover_queue = false;
        let meta = desktop_provider.meta.get_or_insert_with(Default::default);

        if crate::claude_desktop_config::is_compatible_direct_provider(provider)
            && claude_provider_models_are_claude_safe(provider)
        {
            meta.claude_desktop_mode = Some(ClaudeDesktopMode::Direct);
        } else if let Some(routes) = suggested_claude_desktop_routes(provider) {
            meta.claude_desktop_mode = Some(ClaudeDesktopMode::Proxy);
            meta.claude_desktop_model_routes = routes;
        } else {
            continue;
        }

        state
            .db
            .save_provider(AppType::ClaudeDesktop.as_str(), &desktop_provider)
            .map_err(|e| e.to_string())?;
        imported += 1;
    }

    // Safety net: 用户可能手动删除过 claude-desktop-official seed。
    // 用户主动点 import 是"重新整理 ClaudeDesktop 表"的隐式信号，把官方入口补回来。
    // 失败只 warn，不影响 imported 主流程；imported 计数语义保持纯净。
    if let Err(e) = state.db.ensure_official_seed_by_id(
        crate::database::CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID,
        AppType::ClaudeDesktop,
    ) {
        log::warn!("Failed to ensure claude-desktop-official seed during import: {e}");
    }

    Ok(imported)
}

#[tauri::command]
pub fn ensure_claude_desktop_official_provider(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .db
        .ensure_official_seed_by_id(
            crate::database::CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID,
            AppType::ClaudeDesktop,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ensure_grokbuild_official_provider(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .db
        .ensure_official_seed_by_id(
            crate::database::GROKBUILD_OFFICIAL_PROVIDER_ID,
            AppType::GrokBuild,
        )
        .map_err(|e| e.to_string())
}

fn claude_provider_models_are_claude_safe(provider: &Provider) -> bool {
    let Some(env) = provider
        .settings_config
        .get("env")
        .and_then(|value| value.as_object())
    else {
        return true;
    };

    [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]
    .into_iter()
    .filter_map(|key| env.get(key).and_then(|value| value.as_str()))
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .all(crate::claude_desktop_config::is_claude_safe_model_id)
}

pub(crate) fn suggested_claude_desktop_routes(
    provider: &Provider,
) -> Option<std::collections::HashMap<String, crate::provider::ClaudeDesktopModelRoute>> {
    let env = provider
        .settings_config
        .get("env")
        .and_then(|value| value.as_object())?;
    let mut routes = std::collections::HashMap::new();
    let supports_1m_default = !matches!(
        provider
            .meta
            .as_ref()
            .and_then(|meta| meta.provider_type.as_deref()),
        Some("github_copilot") | Some("codex_oauth") | Some("xai_oauth")
    );

    fn add_route(
        routes: &mut std::collections::HashMap<String, crate::provider::ClaudeDesktopModelRoute>,
        env: &serde_json::Map<String, serde_json::Value>,
        route_key: &str,
        env_key: &str,
        supports_1m_default: bool,
    ) {
        let Some(raw_model) = env
            .get(env_key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return;
        };

        // Claude 端 env 值可能带 [1M] 后缀；Claude Desktop schema 不接受后缀，
        // 改用 supports1m 字段表达 1M 能力。在 import 边界做单向翻译。
        let marker = crate::claude_desktop_config::ONE_M_CONTEXT_MARKER.as_bytes();
        let raw_bytes = raw_model.as_bytes();
        let has_1m_marker = raw_bytes.len() >= marker.len()
            && raw_bytes[raw_bytes.len() - marker.len()..].eq_ignore_ascii_case(marker);
        let stripped_model: &str = if has_1m_marker {
            raw_model[..raw_model.len() - marker.len()].trim_end()
        } else {
            raw_model
        };
        if stripped_model.is_empty() {
            return;
        }
        let effective_supports_1m = supports_1m_default || has_1m_marker;
        let explicit_label_override = env
            .get(&format!("{env_key}_NAME"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let label_override = explicit_label_override.clone().or_else(|| {
            (!crate::claude_desktop_config::is_claude_safe_model_id(stripped_model))
                .then(|| stripped_model.to_string())
        });

        // 何时覆盖既有 label_override：原本为空 / 这次来的是 explicit _NAME /
        // 既有值只是 stripped_model 派生的占位（被 explicit 或更具体的值挤掉）。
        let should_overwrite = |existing: Option<&str>| {
            existing.is_none()
                || explicit_label_override.is_some()
                || existing == Some(stripped_model)
        };

        let merge_into = |existing: &mut crate::provider::ClaudeDesktopModelRoute| {
            let merged = existing.supports_1m.unwrap_or(false) || effective_supports_1m;
            existing.supports_1m = Some(merged);
            if should_overwrite(existing.label_override.as_deref()) {
                existing.label_override = label_override.clone();
            }
        };

        if let Some(existing) = routes
            .values_mut()
            .find(|existing| existing.model == stripped_model)
        {
            merge_into(existing);
            return;
        }

        routes
            .entry(route_key.to_string())
            .and_modify(merge_into)
            .or_insert_with(|| crate::provider::ClaudeDesktopModelRoute {
                model: stripped_model.to_string(),
                label_override,
                supports_1m: Some(effective_supports_1m),
            });
    }

    for spec in crate::claude_desktop_config::DEFAULT_PROXY_ROUTES {
        add_route(
            &mut routes,
            env,
            spec.route_id,
            spec.env_key,
            supports_1m_default,
        );
    }

    // 三个 default env_key 全空时用 ANTHROPIC_MODEL 派生兜底路由。
    if routes.is_empty() {
        let primary_route = crate::claude_desktop_config::DEFAULT_PROXY_ROUTES[0].route_id;
        add_route(
            &mut routes,
            env,
            primary_route,
            "ANTHROPIC_MODEL",
            supports_1m_default,
        );
    }

    (!routes.is_empty()).then_some(routes)
}

#[allow(non_snake_case)]
#[tauri::command]
pub async fn queryProviderUsage(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    copilot_state: State<'_, CopilotAuthState>,
    #[allow(non_snake_case)] providerId: String, // 使用 camelCase 匹配前端
    app: String,
) -> Result<crate::provider::UsageResult, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    // inner 可能以两种形式失败：
    //   1) 返回 Ok(UsageResult { success: false, .. }) —— 确定性失败（401、脚本
    //      报错、未知供应商等）。写进 UsageCache 并刷新托盘，让
    //      format_script_summary 的 success 守卫生效、suffix 自然消失。
    //   2) 返回 Err(String) —— 瞬时传输失败（网络/超时）及 DB/Copilot fetch 等。
    //      不写失败快照、不 emit：保留上一份托盘快照，与前端 react-query reject
    //      保留上次 data 的语义一致；否则失败快照会经 useUsageCacheBridge 盲写
    //      回 query 缓存，抹掉 reject 本该保留的旧值。
    let inner =
        query_provider_usage_inner(&state, &copilot_state, app_type.clone(), &providerId).await;
    if let Ok(snapshot) = &inner {
        let payload = serde_json::json!({
            "kind": "script",
            "appType": app_type.as_str(),
            "providerId": &providerId,
            "data": snapshot,
        });
        if let Err(e) = app_handle.emit("usage-cache-updated", payload) {
            log::error!("emit usage-cache-updated (script) 失败: {e}");
        }
        state
            .usage_cache
            .put_script(app_type, providerId, snapshot.clone());
        crate::tray::schedule_tray_refresh(&app_handle);
    }
    inner
}

/// Resolve `(base_url, api_key)` for native usage queries, delegating to the
/// per-app resolver on `Provider`. Missing provider → empty credentials.
fn resolve_native_credentials(app_type: &AppType, provider: Option<&Provider>) -> (String, String) {
    provider
        .map(|p| p.resolve_usage_credentials(app_type))
        .unwrap_or_default()
}

fn resolve_coding_plan_credentials(
    app_type: &AppType,
    provider: Option<&Provider>,
    usage_script: Option<&crate::provider::UsageScript>,
) -> (String, String) {
    let is_zenmux = usage_script
        .and_then(|s| s.coding_plan_provider.as_deref())
        .map(|provider| provider.eq_ignore_ascii_case("zenmux"))
        .unwrap_or(false);

    if !is_zenmux {
        return resolve_native_credentials(app_type, provider);
    }

    let script_base_url = usage_script
        .and_then(|s| s.base_url.as_deref())
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    let script_api_key = usage_script
        .and_then(|s| s.api_key.as_deref())
        .unwrap_or("")
        .to_string();

    if !script_base_url.is_empty() && !script_api_key.is_empty() {
        return (script_base_url, script_api_key);
    }

    let native = resolve_native_credentials(app_type, provider);
    if !native.0.is_empty() && !native.1.is_empty() {
        native
    } else {
        (script_base_url, script_api_key)
    }
}

async fn query_provider_usage_inner(
    state: &AppState,
    copilot_state: &CopilotAuthState,
    app_type: AppType,
    provider_id: &str,
) -> Result<crate::provider::UsageResult, String> {
    // 从数据库读取供应商信息，检查特殊模板类型
    let providers = state
        .db
        .get_all_providers(app_type.as_str())
        .map_err(|e| format!("Failed to get providers: {e}"))?;
    let provider = providers.get(provider_id);
    let usage_script = provider
        .and_then(|p| p.meta.as_ref())
        .and_then(|m| m.usage_script.as_ref());
    let template_type = usage_script
        .and_then(|s| s.template_type.as_deref())
        .unwrap_or("");

    // ── GitHub Copilot 专用路径 ──
    if template_type == TEMPLATE_TYPE_GITHUB_COPILOT {
        let copilot_account_id = provider
            .and_then(|p| p.meta.as_ref())
            .and_then(|m| m.managed_account_id_for(TEMPLATE_TYPE_GITHUB_COPILOT));

        let auth_manager = copilot_state.0.read().await;
        let usage = match copilot_account_id.as_deref() {
            Some(account_id) => auth_manager
                .fetch_usage_for_account(account_id)
                .await
                .map_err(|e| format!("Failed to fetch Copilot usage: {e}"))?,
            None => auth_manager
                .fetch_usage()
                .await
                .map_err(|e| format!("Failed to fetch Copilot usage: {e}"))?,
        };
        let premium = &usage.quota_snapshots.premium_interactions;
        let used = premium.entitlement - premium.remaining;

        return Ok(crate::provider::UsageResult {
            success: true,
            data: Some(vec![crate::provider::UsageData {
                plan_name: Some(usage.copilot_plan),
                remaining: Some(premium.remaining as f64),
                total: Some(premium.entitlement as f64),
                used: Some(used as f64),
                unit: Some(COPILOT_UNIT_PREMIUM.to_string()),
                is_valid: Some(true),
                invalid_message: None,
                extra: Some(format!("Reset: {}", usage.quota_reset_date)),
            }]),
            error: None,
        });
    }

    // ── Coding Plan 专用路径 ──
    if template_type == TEMPLATE_TYPE_TOKEN_PLAN {
        let (base_url, api_key) =
            resolve_coding_plan_credentials(&app_type, provider, usage_script);

        // 火山方舟用账号 AK/SK 签名查询用量（存于 usage_script，与推理 api_key 分离）；
        // 其他供应商为 None，service 层沿用 api_key。
        let access_key_id = usage_script.and_then(|s| s.access_key_id.clone());
        let secret_access_key = usage_script.and_then(|s| s.secret_access_key.clone());
        // 智谱团队版：显式 provider 标识 + 组织/项目 ID（与个人版智谱 base_url 相同，
        // 靠 coding_plan_provider == "zhipu_team" 在 service 层路由）。
        let coding_plan_provider = usage_script.and_then(|s| s.coding_plan_provider.clone());
        let team_organization_id = usage_script.and_then(|s| s.team_organization_id.clone());
        let team_project_id = usage_script.and_then(|s| s.team_project_id.clone());

        let quota = crate::services::coding_plan::get_coding_plan_quota(
            &base_url,
            &api_key,
            access_key_id.as_deref(),
            secret_access_key.as_deref(),
            coding_plan_provider.as_deref(),
            team_organization_id.as_deref(),
            team_project_id.as_deref(),
        )
        .await
        .map_err(|e| format!("Failed to query coding plan: {e}"))?;

        // 将 SubscriptionQuota 转换为 UsageResult
        if !quota.success {
            return Ok(crate::provider::UsageResult {
                success: false,
                data: None,
                error: quota.error,
            });
        }

        // ZenMux 的 tier 携带 USD 额度信息，需要编码为 JSON extra
        let has_usd = quota
            .tiers
            .first()
            .map(|t| t.used_value_usd.is_some())
            .unwrap_or(false);
        let plan_label = quota
            .credential_message
            .as_deref()
            .and_then(|msg| msg.split(' ').next())
            .map(|tier| format!("ZenMux·{}", tier.to_uppercase()));
        let mut first_tier = true;

        let data: Vec<crate::provider::UsageData> = quota
            .tiers
            .iter()
            .map(|tier| {
                let total = 100.0;
                let used = tier.utilization;
                let remaining = total - used;
                let extra = if has_usd {
                    let mut extra_json = serde_json::json!({
                        "resetsAt": tier.resets_at,
                    });
                    if let Some(v) = tier.used_value_usd {
                        extra_json["usedValueUsd"] = serde_json::json!(v);
                    }
                    if let Some(v) = tier.max_value_usd {
                        extra_json["maxValueUsd"] = serde_json::json!(v);
                    }
                    if first_tier {
                        if let Some(ref label) = plan_label {
                            extra_json["planLabel"] = serde_json::json!(label);
                        }
                        first_tier = false;
                    }
                    Some(extra_json.to_string())
                } else {
                    tier.resets_at.clone()
                };
                crate::provider::UsageData {
                    plan_name: Some(tier.name.clone()),
                    remaining: Some(remaining),
                    total: Some(total),
                    used: Some(used),
                    unit: Some("%".to_string()),
                    is_valid: Some(true),
                    invalid_message: None,
                    extra,
                }
            })
            .collect();

        return Ok(crate::provider::UsageResult {
            success: true,
            data: if data.is_empty() { None } else { Some(data) },
            error: None,
        });
    }

    // ── 官方余额查询路径 ──
    if template_type == TEMPLATE_TYPE_BALANCE {
        // 按 app 区分的凭据存储格式提取 Base URL 与 API Key
        let (base_url, api_key) = resolve_native_credentials(&app_type, provider);

        return crate::services::balance::get_balance(&base_url, &api_key)
            .await
            .map_err(|e| format!("Failed to query balance: {e}"));
    }

    // ── 官方订阅额度查询路径 ──
    if template_type == TEMPLATE_TYPE_OFFICIAL_SUBSCRIPTION {
        if !usage_script.map(|s| s.enabled).unwrap_or(false) {
            return Ok(crate::provider::UsageResult {
                success: false,
                data: None,
                error: Some("Usage query is disabled".to_string()),
            });
        }

        let quota = crate::services::subscription::get_subscription_quota(app_type.as_str())
            .await
            .map_err(|e| format!("Failed to query subscription quota: {e}"))?;

        if !quota.success {
            return Ok(crate::provider::UsageResult {
                success: false,
                data: None,
                error: quota.error.or(quota.credential_message),
            });
        }

        let data: Vec<crate::provider::UsageData> = quota
            .tiers
            .iter()
            .map(|tier| crate::provider::UsageData {
                plan_name: Some(tier.name.clone()),
                remaining: Some(100.0 - tier.utilization),
                total: Some(100.0),
                used: Some(tier.utilization),
                unit: Some("%".to_string()),
                is_valid: Some(true),
                invalid_message: None,
                extra: tier.resets_at.clone(),
            })
            .collect();

        return Ok(crate::provider::UsageResult {
            success: true,
            data: if data.is_empty() { None } else { Some(data) },
            error: None,
        });
    }

    // ── 通用 JS 脚本路径 ──
    ProviderService::query_usage(state, app_type, provider_id)
        .await
        .map_err(|e| e.to_string())
}

#[allow(non_snake_case)]
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn testUsageScript(
    state: State<'_, AppState>,
    #[allow(non_snake_case)] providerId: String,
    app: String,
    #[allow(non_snake_case)] scriptCode: String,
    timeout: Option<u64>,
    #[allow(non_snake_case)] apiKey: Option<String>,
    #[allow(non_snake_case)] baseUrl: Option<String>,
    #[allow(non_snake_case)] accessToken: Option<String>,
    #[allow(non_snake_case)] userId: Option<String>,
    #[allow(non_snake_case)] templateType: Option<String>,
) -> Result<crate::provider::UsageResult, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    ProviderService::test_usage_script(
        state.inner(),
        app_type,
        &providerId,
        &scriptCode,
        timeout.unwrap_or(10),
        apiKey.as_deref(),
        baseUrl.as_deref(),
        accessToken.as_deref(),
        userId.as_deref(),
        templateType.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_live_provider_settings(app: String) -> Result<serde_json::Value, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    ProviderService::read_live_settings(app_type).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_api_endpoints(
    urls: Vec<String>,
    #[allow(non_snake_case)] timeoutSecs: Option<u64>,
) -> Result<Vec<EndpointLatency>, String> {
    SpeedtestService::test_endpoints(urls, timeoutSecs)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_custom_endpoints(
    state: State<'_, AppState>,
    app: String,
    #[allow(non_snake_case)] providerId: String,
) -> Result<Vec<crate::settings::CustomEndpoint>, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    ProviderService::get_custom_endpoints(state.inner(), app_type, &providerId)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_custom_endpoint(
    state: State<'_, AppState>,
    app: String,
    #[allow(non_snake_case)] providerId: String,
    url: String,
) -> Result<(), String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    ProviderService::add_custom_endpoint(state.inner(), app_type, &providerId, url)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_custom_endpoint(
    state: State<'_, AppState>,
    app: String,
    #[allow(non_snake_case)] providerId: String,
    url: String,
) -> Result<(), String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    ProviderService::remove_custom_endpoint(state.inner(), app_type, &providerId, url)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_endpoint_last_used(
    state: State<'_, AppState>,
    app: String,
    #[allow(non_snake_case)] providerId: String,
    url: String,
) -> Result<(), String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    ProviderService::update_endpoint_last_used(state.inner(), app_type, &providerId, url)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_providers_sort_order(
    state: State<'_, AppState>,
    app: String,
    updates: Vec<ProviderSortUpdate>,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    ProviderService::update_sort_order(state.inner(), app_type, updates).map_err(|e| e.to_string())
}

use crate::provider::UniversalProvider;
use std::collections::HashMap;
use tauri::AppHandle;

#[derive(Clone, serde::Serialize)]
pub struct UniversalProviderSyncedEvent {
    pub action: String,
    pub id: String,
}

fn emit_universal_provider_synced(app: &AppHandle, action: &str, id: &str) {
    let _ = app.emit(
        "universal-provider-synced",
        UniversalProviderSyncedEvent {
            action: action.to_string(),
            id: id.to_string(),
        },
    );
}

#[tauri::command]
pub fn get_universal_providers(
    state: State<'_, AppState>,
) -> Result<HashMap<String, UniversalProvider>, String> {
    ProviderService::list_universal(state.inner()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_universal_provider(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<UniversalProvider>, String> {
    ProviderService::get_universal(state.inner(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_universal_provider(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: UniversalProvider,
) -> Result<bool, String> {
    let id = provider.id.clone();
    let result =
        ProviderService::upsert_universal(state.inner(), provider).map_err(|e| e.to_string())?;

    emit_universal_provider_synced(&app, "upsert", &id);

    Ok(result)
}

#[tauri::command]
pub fn delete_universal_provider(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let result =
        ProviderService::delete_universal(state.inner(), &id).map_err(|e| e.to_string())?;

    emit_universal_provider_synced(&app, "delete", &id);

    Ok(result)
}

#[tauri::command]
pub fn sync_universal_provider(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let result =
        ProviderService::sync_universal_to_apps(state.inner(), &id).map_err(|e| e.to_string())?;

    emit_universal_provider_synced(&app, "sync", &id);

    Ok(result)
}

#[tauri::command]
pub fn import_opencode_providers_from_live(state: State<'_, AppState>) -> Result<usize, String> {
    crate::services::provider::import_opencode_providers_from_live(state.inner())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_opencode_live_provider_ids() -> Result<Vec<String>, String> {
    crate::opencode_config::get_providers()
        .map(|providers| providers.keys().cloned().collect())
        .map_err(|e| e.to_string())
}

// ============================================================================
// OpenClaw 专属命令 → 已迁移至 commands/openclaw.rs
// ============================================================================

#[cfg(test)]
mod automatic_routing_tests {
    use super::{
        add_and_activate_provider_with_automatic_routing_state,
        add_provider_with_automatic_routing_state, provider_requires_automatic_routing,
        switch_provider_with_automatic_routing_state, update_provider_with_automatic_routing_mode,
        update_provider_with_automatic_routing_state,
    };
    use crate::app_config::AppType;
    use crate::codex_config::{
        get_codex_auth_path, get_codex_config_path, get_codex_model_catalog_path,
    };
    use crate::database::Database;
    use crate::provider::{Provider, ProviderMeta};
    use crate::proxy::types::ProxyConfig;
    use crate::services::ProviderService;
    use crate::store::AppState;
    use serde_json::json;
    use serial_test::serial;
    use std::sync::Arc;

    fn provider(config: serde_json::Value, api_format: Option<&str>) -> Provider {
        let mut provider = Provider::with_id("test".to_string(), "Test".to_string(), config, None);
        provider.meta = Some(ProviderMeta {
            api_format: api_format.map(str::to_string),
            ..ProviderMeta::default()
        });
        provider
    }

    #[test]
    fn native_responses_does_not_require_routing() {
        let provider = provider(json!({}), Some("openai_responses"));
        assert!(!provider_requires_automatic_routing(
            &AppType::Codex,
            &provider
        ));
    }

    #[test]
    fn auto_detect_candidate_requires_routing() {
        // api_format=None ("自动") 的供应商需要代理接管，才能触发 Responses→Chat 自动检测
        let auto_provider = provider(json!({}), None);
        assert!(provider_requires_automatic_routing(
            &AppType::Codex,
            &auto_provider
        ));
        // 明确指定 openai_responses 的供应商保持直连
        let responses_provider = provider(json!({}), Some("openai_responses"));
        assert!(!provider_requires_automatic_routing(
            &AppType::Codex,
            &responses_provider
        ));
        // 明确指定 openai_chat 的供应商需要代理（已有逻辑）
        let chat_provider = provider(json!({}), Some("openai_chat"));
        assert!(provider_requires_automatic_routing(
            &AppType::Codex,
            &chat_provider
        ));
    }

    #[test]
    fn mixed_model_catalog_requires_routing_even_when_default_model_is_responses() {
        let mut provider = provider(json!({}), Some("openai_responses"));
        provider.meta = Some(ProviderMeta {
            api_format: Some("openai_responses".to_string()),
            codex_model_api_formats: [
                ("gpt-responses".to_string(), "openai_responses".to_string()),
                ("claude-chat".to_string(), "openai_chat".to_string()),
            ]
            .into_iter()
            .collect(),
            ..ProviderMeta::default()
        });

        assert!(provider_requires_automatic_routing(
            &AppType::Codex,
            &provider
        ));
    }

    #[test]
    fn declared_native_responses_provider_stays_direct_even_on_auto() {
        // 前端把"自动"刻意不持久化，所以 meta.api_format 为 None 是默认状态。
        // 但 config.toml 已经声明了 wire_api = "responses"：这是第一方声明，
        // 上游原生支持 Responses，不需要任何协议转换，也就不该被强制接管。
        // 否则用户填入密钥拿到 GPT 模型，却看到 127.0.0.1:15721 和它的 502。
        let declared = provider(
            json!({
                "config": "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://api.example.com/v1\"\nwire_api = \"responses\"\n"
            }),
            None,
        );
        assert!(!provider_requires_automatic_routing(
            &AppType::Codex,
            &declared
        ));

        // 顶层 wire_api 形式同样采信。
        let top_level = provider(json!({ "config": "wire_api = \"responses\"\n" }), None);
        assert!(!provider_requires_automatic_routing(
            &AppType::Codex,
            &top_level
        ));

        // 没有任何声明时仍需接管，自动检测能力不受影响。
        let undeclared = provider(
            json!({ "config": "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://api.example.com/v1\"\n" }),
            None,
        );
        assert!(provider_requires_automatic_routing(
            &AppType::Codex,
            &undeclared
        ));

        // 声明 chat 的仍然需要接管（转换是必需的）。
        let declared_chat = provider(
            json!({
                "config": "model_provider = \"custom\"\n[model_providers.custom]\nwire_api = \"chat\"\n"
            }),
            None,
        );
        assert!(provider_requires_automatic_routing(
            &AppType::Codex,
            &declared_chat
        ));
    }

    #[test]
    fn full_url_provider_still_requires_routing_despite_declared_responses() {
        // 完整 API 地址需要代理注入/改写，声明了原生 Responses 也不能豁免；
        // 收窄自动检测候选不得削弱其他接管理由。
        let mut full_url = provider(
            json!({
                "config": "model_provider = \"custom\"\n[model_providers.custom]\nwire_api = \"responses\"\n"
            }),
            None,
        );
        full_url.meta.as_mut().unwrap().is_full_url = Some(true);
        assert!(provider_requires_automatic_routing(
            &AppType::Codex,
            &full_url
        ));
    }

    #[test]
    fn chat_and_anthropic_protocols_require_routing() {
        let chat = provider(json!({}), Some("openai_chat"));
        let anthropic = provider(
            json!({
                "config": "model_provider = \"third_party\"\n[model_providers.third_party]\nwire_api = \"anthropic-messages\"\n"
            }),
            None,
        );

        assert!(provider_requires_automatic_routing(&AppType::Codex, &chat));
        assert!(provider_requires_automatic_routing(
            &AppType::Codex,
            &anthropic
        ));
    }

    #[test]
    fn full_url_and_managed_oauth_require_routing() {
        let mut full_url = provider(json!({}), Some("openai_responses"));
        full_url.meta.as_mut().unwrap().is_full_url = Some(true);

        let mut oauth = provider(json!({}), Some("openai_responses"));
        oauth.meta.as_mut().unwrap().provider_type = Some("xai_oauth".to_string());

        assert!(provider_requires_automatic_routing(
            &AppType::Codex,
            &full_url
        ));
        assert!(provider_requires_automatic_routing(&AppType::Codex, &oauth));
    }

    #[test]
    fn local_proxy_only_features_require_routing() {
        let mut custom_ua = provider(json!({}), Some("openai_responses"));
        custom_ua.meta.as_mut().unwrap().custom_user_agent = Some("Chimera-Test/1.0".into());

        let mut overrides = provider(json!({}), Some("openai_responses"));
        let request_overrides = crate::provider::LocalProxyRequestOverrides {
            headers: std::collections::HashMap::from([("x-test".into(), "enabled".into())]),
            body: None,
        };
        overrides
            .meta
            .as_mut()
            .unwrap()
            .local_proxy_request_overrides = Some(request_overrides);

        assert!(provider_requires_automatic_routing(
            &AppType::Codex,
            &custom_ua
        ));
        assert!(provider_requires_automatic_routing(
            &AppType::Codex,
            &overrides
        ));
    }

    #[test]
    fn official_and_non_codex_apps_are_not_auto_managed() {
        let mut official = provider(json!({}), Some("openai_chat"));
        official.category = Some("official".to_string());
        let third_party = provider(json!({}), Some("openai_chat"));

        assert!(!provider_requires_automatic_routing(
            &AppType::Codex,
            &official
        ));
        assert!(!provider_requires_automatic_routing(
            &AppType::Claude,
            &third_party
        ));
    }

    #[tokio::test]
    #[serial]
    async fn first_unlogged_codex_chat_provider_activates_automatic_routing() {
        let original = std::env::var_os("CC_SWITCH_TEST_HOME");
        let home = tempfile::tempdir().expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(Database::memory().expect("init db"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve port");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("use available port");
        let state = AppState::new(db.clone());
        let mut first = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "test-only-key"},
                "config": "model_provider = \"third\"\nmodel = \"claude-test\"\n[model_providers.third]\nname = \"Third\"\nbase_url = \"https://example.invalid/v1\"\nwire_api = \"chat\"\n",
                "modelCatalog": {"models": [{"model": "claude-test", "displayName": "Claude Test"}]}
            }),
            Some("openai_chat"),
        );
        first.id = "first-chat".to_string();
        add_provider_with_automatic_routing_state(state.clone(), AppType::Codex, first, true)
            .await
            .expect("add first provider");
        assert_eq!(
            db.get_current_provider("codex")
                .expect("current")
                .as_deref(),
            Some("first-chat")
        );
        assert!(
            db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        assert!(state.proxy_service.is_running().await);
        let taken_over =
            std::fs::read_to_string(get_codex_config_path()).expect("read taken-over config");
        assert!(taken_over.contains("127.0.0.1"));
        assert!(get_codex_model_catalog_path().exists());

        state
            .proxy_service
            .set_takeover_for_app("codex", false)
            .await
            .expect("cleanup");
        let restored =
            std::fs::read_to_string(get_codex_config_path()).expect("read restored direct config");
        assert!(restored.contains("https://example.invalid/v1"));
        assert!(!restored.contains("127.0.0.1"));
        assert!(
            db.get_live_backup("codex")
                .await
                .expect("read backup")
                .is_none(),
            "disabling routing must remove the sensitive takeover backup"
        );
        match original {
            Some(v) => std::env::set_var("CC_SWITCH_TEST_HOME", v),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        crate::settings::reload_settings().expect("restore settings");
    }

    #[tokio::test]
    #[serial]
    async fn first_unlogged_codex_responses_provider_stays_direct() {
        let original = std::env::var_os("CC_SWITCH_TEST_HOME");
        let home = tempfile::tempdir().expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(Database::memory().expect("init db"));
        let state = AppState::new(db.clone());
        let mut first = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "test-only-key"},
                "config": "model_provider = \"third\"\nmodel = \"gpt-test\"\n[model_providers.third]\nname = \"Third\"\nbase_url = \"https://example.invalid/v1\"\nwire_api = \"responses\"\n",
                "modelCatalog": {"models": [{"model": "gpt-test", "displayName": "GPT Test"}]}
            }),
            Some("openai_responses"),
        );
        first.id = "first-responses".to_string();

        add_provider_with_automatic_routing_state(state.clone(), AppType::Codex, first, true)
            .await
            .expect("add first Responses provider");

        assert_eq!(
            db.get_current_provider("codex")
                .expect("current")
                .as_deref(),
            Some("first-responses")
        );
        assert!(
            !db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        assert!(!state.proxy_service.is_running().await);
        let direct = std::fs::read_to_string(get_codex_config_path()).expect("read direct config");
        assert!(direct.contains("https://example.invalid/v1"));
        assert!(!direct.contains("127.0.0.1"));

        match original {
            Some(v) => std::env::set_var("CC_SWITCH_TEST_HOME", v),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        crate::settings::reload_settings().expect("restore settings");
    }

    #[tokio::test]
    #[serial]
    async fn failed_enabled_codex_import_restores_existing_current_and_live_atomically() {
        let original = std::env::var_os("CC_SWITCH_TEST_HOME");
        let home = tempfile::tempdir().expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(Database::memory().expect("init db"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve port");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("use available port");
        let state = AppState::new(db.clone());

        let mut existing = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "existing-test-key"},
                "config": "model_provider = \"existing\"\nmodel = \"gpt-existing\"\n[model_providers.existing]\nname = \"Existing\"\nbase_url = \"https://existing.example.invalid/v1\"\nwire_api = \"responses\"\n",
                "modelCatalog": {"models": [{"model": "gpt-existing", "displayName": "Existing"}]}
            }),
            Some("openai_responses"),
        );
        existing.id = "existing-responses".to_string();
        add_provider_with_automatic_routing_state(state.clone(), AppType::Codex, existing, true)
            .await
            .expect("activate existing provider");

        {
            let conn = db.conn.lock().expect("lock database");
            conn.execute_batch(
                "CREATE TRIGGER reject_enabled_import_activation
                 BEFORE UPDATE OF is_current ON providers
                 WHEN NEW.id = 'enabled-chat' AND NEW.is_current = 1
                 BEGIN
                   SELECT RAISE(ABORT, 'forced enabled import activation failure');
                 END;",
            )
            .expect("install failure trigger");
        }

        let mut imported = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "import-test-key"},
                "config": "model_provider = \"imported\"\nmodel = \"claude-imported\"\n[model_providers.imported]\nname = \"Imported\"\nbase_url = \"https://imported.example.invalid/v1\"\nwire_api = \"chat\"\n",
                "modelCatalog": {"models": [{"model": "claude-imported", "displayName": "Imported"}]}
            }),
            Some("openai_chat"),
        );
        imported.id = "enabled-chat".to_string();

        let error = add_and_activate_provider_with_automatic_routing_state(
            state.clone(),
            AppType::Codex,
            imported,
            true,
        )
        .await
        .expect_err("forced enabled import failure must roll back");
        assert!(error.contains("forced enabled import activation failure"));
        assert_eq!(
            db.get_current_provider("codex")
                .expect("db current")
                .as_deref(),
            Some("existing-responses")
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Codex).as_deref(),
            Some("existing-responses")
        );
        assert!(db
            .get_provider_by_id("enabled-chat", "codex")
            .expect("read staged provider")
            .is_none());
        assert!(
            !db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        assert!(!state.proxy_service.is_running().await);
        assert!(db.get_live_backup("codex").await.expect("backup").is_none());
        let live = std::fs::read_to_string(get_codex_config_path()).expect("read restored live");
        assert!(live.contains("https://existing.example.invalid/v1"));
        assert!(!live.contains("127.0.0.1"));
        assert!(!live.contains("https://imported.example.invalid/v1"));

        match original {
            Some(v) => std::env::set_var("CC_SWITCH_TEST_HOME", v),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        crate::settings::reload_settings().expect("restore settings");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial]
    async fn provider_switch_waits_for_complete_profile_transaction() {
        let original = std::env::var_os("CC_SWITCH_TEST_HOME");
        let home = tempfile::tempdir().expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(Database::memory().expect("init db"));
        let state = AppState::new(db.clone());

        let provider_a = Provider::with_id(
            "profile-provider-a".to_string(),
            "Profile A".to_string(),
            json!({"env": {"ANTHROPIC_AUTH_TOKEN": "profile-a-test-token"}}),
            None,
        );
        let provider_b = Provider::with_id(
            "profile-provider-b".to_string(),
            "Profile B".to_string(),
            json!({"env": {"ANTHROPIC_AUTH_TOKEN": "profile-b-test-token"}}),
            None,
        );
        db.save_provider(AppType::Claude.as_str(), &provider_a)
            .expect("save provider A");
        db.save_provider(AppType::Claude.as_str(), &provider_b)
            .expect("save provider B");
        crate::services::ProviderService::switch(&state, AppType::Claude, &provider_a.id)
            .expect("seed provider A");

        // Model the interval after Profile Apply has switched its Provider but
        // before MCP/Skills/Prompt and the current-profile marker are committed.
        let profile_lock = state.profile_apply_lock.clone();
        let profile_guard = profile_lock.lock().await;
        let switch_state = state.clone();
        let switch_task = tokio::spawn(async move {
            switch_provider_with_automatic_routing_state(
                switch_state,
                AppType::Claude,
                "profile-provider-b".to_string(),
            )
            .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            !switch_task.is_finished(),
            "UI/tray switch must wait until Profile Apply releases its transaction lock"
        );
        assert_eq!(
            db.get_current_provider(AppType::Claude.as_str())
                .expect("current provider while profile locked")
                .as_deref(),
            Some("profile-provider-a")
        );

        drop(profile_guard);
        switch_task
            .await
            .expect("join provider switch")
            .expect("provider switch after profile transaction");
        assert_eq!(
            db.get_current_provider(AppType::Claude.as_str())
                .expect("current provider after profile unlock")
                .as_deref(),
            Some("profile-provider-b")
        );

        match original {
            Some(v) => std::env::set_var("CC_SWITCH_TEST_HOME", v),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        crate::settings::reload_settings().expect("restore settings");
    }

    #[tokio::test]
    #[serial]
    async fn current_provider_update_responses_to_chat_enables_routing() {
        let original = std::env::var_os("CC_SWITCH_TEST_HOME");
        let home = tempfile::tempdir().expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(Database::memory().expect("init db"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve port");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("use available port");
        let state = AppState::new(db.clone());

        let mut current = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "test-only-key"},
                "config": "model_provider = \"editable\"\nmodel = \"gpt-before\"\n[model_providers.editable]\nname = \"Editable\"\nbase_url = \"https://responses-before.example.invalid/v1\"\nwire_api = \"responses\"\n"
            }),
            Some("openai_responses"),
        );
        current.id = "editable".to_string();
        add_provider_with_automatic_routing_state(state.clone(), AppType::Codex, current, true)
            .await
            .expect("add Responses provider");

        let mut updated = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "test-only-key"},
                "config": "model_provider = \"editable\"\nmodel = \"claude-after\"\n[model_providers.editable]\nname = \"Editable\"\nbase_url = \"https://chat-after.example.invalid/v1\"\nwire_api = \"chat\"\n"
            }),
            Some("openai_chat"),
        );
        updated.id = "editable".to_string();
        update_provider_with_automatic_routing_state(
            state.clone(),
            AppType::Codex,
            Some("editable".to_string()),
            updated,
        )
        .await
        .expect("update current provider to Chat");

        assert!(
            db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        assert!(state.proxy_service.is_running().await);
        let live = std::fs::read_to_string(get_codex_config_path()).expect("read takeover live");
        assert!(live.contains(&format!("127.0.0.1:{port}")));
        let stored = db
            .get_provider_by_id("editable", "codex")
            .expect("read provider")
            .expect("provider exists");
        assert_eq!(
            stored
                .meta
                .as_ref()
                .and_then(|meta| meta.api_format.as_deref()),
            Some("openai_chat")
        );

        state
            .proxy_service
            .set_takeover_for_app("codex", false)
            .await
            .expect("cleanup takeover");
        match original {
            Some(v) => std::env::set_var("CC_SWITCH_TEST_HOME", v),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        crate::settings::reload_settings().expect("restore settings");
    }

    #[tokio::test]
    #[serial]
    async fn current_provider_update_chat_to_responses_disables_routing() {
        let original = std::env::var_os("CC_SWITCH_TEST_HOME");
        let home = tempfile::tempdir().expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(Database::memory().expect("init db"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve port");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("use available port");
        let state = AppState::new(db.clone());

        let mut current = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "test-only-key"},
                "config": "model_provider = \"editable\"\nmodel = \"claude-before\"\n[model_providers.editable]\nname = \"Editable\"\nbase_url = \"https://chat-before.example.invalid/v1\"\nwire_api = \"chat\"\n"
            }),
            Some("openai_chat"),
        );
        current.id = "editable".to_string();
        add_provider_with_automatic_routing_state(state.clone(), AppType::Codex, current, true)
            .await
            .expect("add Chat provider");
        assert!(state.proxy_service.is_running().await);

        let mut updated = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "test-only-key"},
                "config": "model_provider = \"editable\"\nmodel = \"gpt-after\"\n[model_providers.editable]\nname = \"Editable\"\nbase_url = \"https://responses-after.example.invalid/v1\"\nwire_api = \"responses\"\n"
            }),
            Some("openai_responses"),
        );
        updated.id = "editable".to_string();
        update_provider_with_automatic_routing_state(
            state.clone(),
            AppType::Codex,
            Some("editable".to_string()),
            updated,
        )
        .await
        .expect("update current provider to Responses");

        assert!(
            !db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        assert!(!state.proxy_service.is_running().await);
        assert!(db.get_live_backup("codex").await.expect("backup").is_none());
        let live = std::fs::read_to_string(get_codex_config_path()).expect("read direct live");
        assert!(live.contains("https://responses-after.example.invalid/v1"));
        assert!(!live.contains("127.0.0.1"));

        match original {
            Some(v) => std::env::set_var("CC_SWITCH_TEST_HOME", v),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        crate::settings::reload_settings().expect("restore settings");
    }

    #[tokio::test]
    #[serial]
    async fn failed_inactive_provider_update_and_activation_restores_everything() {
        let original = std::env::var_os("CC_SWITCH_TEST_HOME");
        let home = tempfile::tempdir().expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(Database::memory().expect("init db"));
        let occupied = std::net::TcpListener::bind("127.0.0.1:0").expect("occupy port");
        let port = occupied.local_addr().expect("local addr").port();
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set occupied port");
        let state = AppState::new(db.clone());

        let mut current = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "current-test-key"},
                "config": "model_provider = \"current\"\nmodel = \"gpt-current\"\n[model_providers.current]\nname = \"Current\"\nbase_url = \"https://current-responses.example.invalid/v1\"\nwire_api = \"responses\"\n"
            }),
            Some("openai_responses"),
        );
        current.id = "current-provider".to_string();
        add_provider_with_automatic_routing_state(state.clone(), AppType::Codex, current, true)
            .await
            .expect("activate direct current provider");

        let mut editable = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "editable-before-key"},
                "config": "model_provider = \"editable\"\nmodel = \"gpt-before\"\n[model_providers.editable]\nname = \"Editable\"\nbase_url = \"https://editable-before.example.invalid/v1\"\nwire_api = \"responses\"\n"
            }),
            Some("openai_responses"),
        );
        editable.id = "editable-provider".to_string();
        add_provider_with_automatic_routing_state(state.clone(), AppType::Codex, editable, true)
            .await
            .expect("stage inactive provider");

        let mut updated = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "editable-after-key"},
                "config": "model_provider = \"editable\"\nmodel = \"claude-after\"\n[model_providers.editable]\nname = \"Editable\"\nbase_url = \"https://editable-after.example.invalid/v1\"\nwire_api = \"chat\"\n"
            }),
            Some("openai_chat"),
        );
        updated.id = "editable-provider".to_string();
        let error = update_provider_with_automatic_routing_mode(
            state.clone(),
            AppType::Codex,
            Some("editable-provider".to_string()),
            updated,
            true,
        )
        .await
        .expect_err("occupied proxy port must fail save-and-apply");
        assert!(error.contains("自动开启本地路由失败") || error.contains("启动"));

        let stored = db
            .get_provider_by_id("editable-provider", "codex")
            .expect("read editable provider")
            .expect("editable provider exists");
        assert_eq!(
            stored
                .meta
                .as_ref()
                .and_then(|meta| meta.api_format.as_deref()),
            Some("openai_responses")
        );
        assert!(stored
            .settings_config
            .to_string()
            .contains("editable-before.example.invalid"));
        assert_eq!(
            db.get_current_provider("codex")
                .expect("db current")
                .as_deref(),
            Some("current-provider")
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Codex).as_deref(),
            Some("current-provider")
        );
        assert!(
            !db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        assert!(!state.proxy_service.is_running().await);
        assert!(db.get_live_backup("codex").await.expect("backup").is_none());
        let live = std::fs::read_to_string(get_codex_config_path()).expect("read restored live");
        assert!(live.contains("https://current-responses.example.invalid/v1"));
        assert!(!live.contains("editable-after.example.invalid"));
        drop(occupied);

        match original {
            Some(v) => std::env::set_var("CC_SWITCH_TEST_HOME", v),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        crate::settings::reload_settings().expect("restore settings");
    }

    #[tokio::test]
    #[serial]
    async fn failed_current_provider_route_start_restores_provider_current_live_and_backup() {
        let original = std::env::var_os("CC_SWITCH_TEST_HOME");
        let home = tempfile::tempdir().expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(Database::memory().expect("init db"));
        let occupied = std::net::TcpListener::bind("127.0.0.1:0").expect("occupy port");
        let port = occupied.local_addr().expect("local addr").port();
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set occupied port");
        let state = AppState::new(db.clone());

        let mut current = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "test-only-key"},
                "config": "model_provider = \"editable\"\nmodel = \"gpt-before\"\n[model_providers.editable]\nname = \"Editable\"\nbase_url = \"https://responses-before.example.invalid/v1\"\nwire_api = \"responses\"\n"
            }),
            Some("openai_responses"),
        );
        current.id = "editable".to_string();
        add_provider_with_automatic_routing_state(state.clone(), AppType::Codex, current, true)
            .await
            .expect("add Responses provider");

        let mut updated = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "test-only-key"},
                "config": "model_provider = \"editable\"\nmodel = \"claude-after\"\n[model_providers.editable]\nname = \"Editable\"\nbase_url = \"https://chat-after.example.invalid/v1\"\nwire_api = \"chat\"\n"
            }),
            Some("openai_chat"),
        );
        updated.id = "editable".to_string();
        let error = update_provider_with_automatic_routing_state(
            state.clone(),
            AppType::Codex,
            Some("editable".to_string()),
            updated,
        )
        .await
        .expect_err("occupied proxy port must fail route startup");
        assert!(error.contains("自动开启本地路由失败") || error.contains("启动"));

        let stored = db
            .get_provider_by_id("editable", "codex")
            .expect("read provider")
            .expect("provider exists");
        assert_eq!(
            stored
                .meta
                .as_ref()
                .and_then(|meta| meta.api_format.as_deref()),
            Some("openai_responses")
        );
        assert!(stored
            .settings_config
            .to_string()
            .contains("responses-before.example.invalid"));
        assert_eq!(
            db.get_current_provider("codex")
                .expect("db current")
                .as_deref(),
            Some("editable")
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Codex).as_deref(),
            Some("editable")
        );
        assert!(
            !db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        assert!(!state.proxy_service.is_running().await);
        assert!(db.get_live_backup("codex").await.expect("backup").is_none());
        let live = std::fs::read_to_string(get_codex_config_path()).expect("read restored live");
        assert!(live.contains("https://responses-before.example.invalid/v1"));
        assert!(!live.contains("chat-after.example.invalid"));
        drop(occupied);

        match original {
            Some(v) => std::env::set_var("CC_SWITCH_TEST_HOME", v),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        crate::settings::reload_settings().expect("restore settings");
    }

    #[tokio::test]
    #[serial]
    async fn failed_enabled_import_while_routed_restores_original_backup() {
        let original = std::env::var_os("CC_SWITCH_TEST_HOME");
        let home = tempfile::tempdir().expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(Database::memory().expect("init db"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve port");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("use available port");
        let state = AppState::new(db.clone());

        let mut existing = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "existing-test-key"},
                "config": "model_provider = \"existing\"\nmodel = \"claude-existing\"\n[model_providers.existing]\nname = \"Existing\"\nbase_url = \"https://existing-chat.example.invalid/v1\"\nwire_api = \"chat\"\n"
            }),
            Some("openai_chat"),
        );
        existing.id = "existing-chat".to_string();
        add_provider_with_automatic_routing_state(state.clone(), AppType::Codex, existing, true)
            .await
            .expect("activate existing routed provider");
        let original_backup = db
            .get_live_backup("codex")
            .await
            .expect("read original backup")
            .expect("backup exists");
        assert!(original_backup
            .original_config
            .contains("existing-chat.example.invalid"));

        // Preserve the inconsistent-but-valid crash snapshot reported by audit:
        // takeover remains enabled and Live/backup remain owned, but the shared
        // proxy process is stopped. Failed import compensation must not heal it.
        state
            .proxy_service
            .stop()
            .await
            .expect("simulate proxy process exit while takeover remains enabled");
        assert!(
            db.get_proxy_config_for_app("codex")
                .await
                .expect("routing after simulated exit")
                .enabled
        );
        assert!(!state.proxy_service.is_running().await);
        let previous_global_proxy_config = db
            .get_global_proxy_config()
            .await
            .expect("capture stopped global proxy config");

        {
            let conn = db.conn.lock().expect("lock database");
            conn.execute_batch(
                "CREATE TRIGGER reject_second_enabled_import_commit
                 BEFORE UPDATE OF is_current ON providers
                 WHEN OLD.id = 'enabled-chat' AND OLD.is_current = 1 AND NEW.is_current = 0
                 BEGIN
                   SELECT RAISE(ABORT, 'forced second enabled import commit failure');
                 END;",
            )
            .expect("install second-phase failure trigger");
        }

        let mut imported = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "import-test-key"},
                "config": "model_provider = \"imported\"\nmodel = \"claude-imported\"\n[model_providers.imported]\nname = \"Imported\"\nbase_url = \"https://imported-chat.example.invalid/v1\"\nwire_api = \"chat\"\n"
            }),
            Some("openai_chat"),
        );
        imported.id = "enabled-chat".to_string();
        let error = add_and_activate_provider_with_automatic_routing_state(
            state.clone(),
            AppType::Codex,
            imported,
            true,
        )
        .await
        .expect_err("second activation phase must fail");
        assert!(error.contains("forced second enabled import commit failure"));

        assert_eq!(
            db.get_current_provider("codex")
                .expect("db current")
                .as_deref(),
            Some("existing-chat")
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Codex).as_deref(),
            Some("existing-chat")
        );
        assert!(
            db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        assert!(
            !state.proxy_service.is_running().await,
            "rollback must restore the original stopped process state"
        );
        let restored_global_proxy_config = db
            .get_global_proxy_config()
            .await
            .expect("read restored global proxy config");
        assert_eq!(
            restored_global_proxy_config.proxy_enabled,
            previous_global_proxy_config.proxy_enabled
        );
        assert_eq!(
            restored_global_proxy_config.listen_address,
            previous_global_proxy_config.listen_address
        );
        assert_eq!(
            restored_global_proxy_config.listen_port,
            previous_global_proxy_config.listen_port
        );
        assert_eq!(
            restored_global_proxy_config.enable_logging,
            previous_global_proxy_config.enable_logging
        );
        let restored_backup = db
            .get_live_backup("codex")
            .await
            .expect("read restored backup")
            .expect("backup exists after rollback");
        assert!(restored_backup
            .original_config
            .contains("existing-chat.example.invalid"));
        assert!(!restored_backup
            .original_config
            .contains("imported-chat.example.invalid"));
        let live = std::fs::read_to_string(get_codex_config_path()).expect("read takeover live");
        assert!(live.contains(&format!("127.0.0.1:{port}")));

        state
            .proxy_service
            .set_takeover_for_app("codex", false)
            .await
            .expect("disable takeover after rollback");
        let restored = std::fs::read_to_string(get_codex_config_path()).expect("read direct live");
        assert!(restored.contains("https://existing-chat.example.invalid/v1"));
        assert!(!restored.contains("imported-chat.example.invalid"));

        match original {
            Some(v) => std::env::set_var("CC_SWITCH_TEST_HOME", v),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        crate::settings::reload_settings().expect("restore settings");
    }

    #[tokio::test]
    #[serial]
    async fn failed_public_switch_while_routed_and_stopped_restores_runtime_state() {
        let original = std::env::var_os("CC_SWITCH_TEST_HOME");
        let home = tempfile::tempdir().expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(Database::memory().expect("init db"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve port");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("use available port");
        let state = AppState::new(db.clone());

        let mut current = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "public-current-test-key"},
                "config": "model_provider = \"public_current\"\nmodel = \"claude-current\"\n[model_providers.public_current]\nname = \"Public Current\"\nbase_url = \"https://public-current.example.invalid/v1\"\nwire_api = \"chat\"\n"
            }),
            Some("openai_chat"),
        );
        current.id = "public-current".to_string();
        add_provider_with_automatic_routing_state(state.clone(), AppType::Codex, current, true)
            .await
            .expect("activate current routed provider");

        let mut target = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "public-target-test-key"},
                "config": "model_provider = \"public_target\"\nmodel = \"claude-target\"\n[model_providers.public_target]\nname = \"Public Target\"\nbase_url = \"https://public-target.example.invalid/v1\"\nwire_api = \"chat\"\n"
            }),
            Some("openai_chat"),
        );
        target.id = "public-target".to_string();
        ProviderService::add_inactive(&state, AppType::Codex, target, true)
            .expect("stage routed target");

        // Reproduce the audit snapshot: DB takeover and owned Live/backup stay
        // enabled, while only the proxy process has exited.
        state
            .proxy_service
            .stop()
            .await
            .expect("stop proxy without changing takeover");
        assert!(
            db.get_proxy_config_for_app("codex")
                .await
                .expect("read takeover")
                .enabled
        );
        assert!(!state.proxy_service.is_running().await);
        let previous_global_proxy_config = db
            .get_global_proxy_config()
            .await
            .expect("capture global proxy config");
        let previous_backup = db
            .get_live_backup("codex")
            .await
            .expect("read backup")
            .expect("backup exists");
        let previous_live =
            std::fs::read_to_string(get_codex_config_path()).expect("capture takeover live config");

        {
            let conn = db.conn.lock().expect("lock database");
            conn.execute_batch(
                "CREATE TRIGGER reject_public_switch_commit
                 BEFORE UPDATE OF is_current ON providers
                 WHEN OLD.id = 'public-current' AND OLD.is_current = 1 AND NEW.is_current = 0
                 BEGIN
                   SELECT RAISE(ABORT, 'forced public switch commit failure');
                 END;",
            )
            .expect("install switch failure trigger");
        }

        let error = switch_provider_with_automatic_routing_state(
            state.clone(),
            AppType::Codex,
            "public-target".to_string(),
        )
        .await
        .expect_err("provider commit must fail");
        assert!(error.contains("forced public switch commit failure"));

        assert_eq!(
            db.get_current_provider("codex")
                .expect("db current")
                .as_deref(),
            Some("public-current")
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Codex).as_deref(),
            Some("public-current")
        );
        assert!(
            db.get_proxy_config_for_app("codex")
                .await
                .expect("routing after failed switch")
                .enabled
        );
        assert!(
            !state.proxy_service.is_running().await,
            "failed public switch must restore the stopped process state"
        );
        let restored_global_proxy_config = db
            .get_global_proxy_config()
            .await
            .expect("read restored global proxy config");
        assert_eq!(
            restored_global_proxy_config.proxy_enabled,
            previous_global_proxy_config.proxy_enabled
        );
        assert_eq!(
            restored_global_proxy_config.listen_address,
            previous_global_proxy_config.listen_address
        );
        assert_eq!(
            restored_global_proxy_config.listen_port,
            previous_global_proxy_config.listen_port
        );
        assert_eq!(
            restored_global_proxy_config.enable_logging,
            previous_global_proxy_config.enable_logging
        );
        let restored_backup = db
            .get_live_backup("codex")
            .await
            .expect("read restored backup")
            .expect("backup remains");
        assert_eq!(
            restored_backup.original_config,
            previous_backup.original_config
        );
        let restored_live = std::fs::read_to_string(get_codex_config_path())
            .expect("read restored takeover live config");
        assert_eq!(restored_live, previous_live);

        state
            .proxy_service
            .set_takeover_for_app("codex", false)
            .await
            .expect("disable takeover after test");
        match original {
            Some(v) => std::env::set_var("CC_SWITCH_TEST_HOME", v),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        crate::settings::reload_settings().expect("restore settings");
    }

    #[tokio::test]
    #[serial]
    async fn failed_first_unlogged_codex_provider_add_leaves_no_state() {
        let original = std::env::var_os("CC_SWITCH_TEST_HOME");
        let home = tempfile::tempdir().expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        crate::settings::reload_settings().expect("reload settings");
        let db = Arc::new(Database::memory().expect("init db"));
        {
            let conn = db.conn.lock().expect("lock database");
            conn.execute_batch(
                "CREATE TRIGGER reject_first_provider_activation
                 BEFORE UPDATE OF is_current ON providers
                 WHEN NEW.is_current = 1
                 BEGIN
                   SELECT RAISE(ABORT, 'forced first-provider activation failure');
                 END;",
            )
            .expect("install failure trigger");
        }
        let state = AppState::new(db.clone());
        let mut first = provider(
            json!({
                "auth": {"OPENAI_API_KEY": "test-only-key"},
                "config": "model_provider = \"third\"\nmodel = \"claude-test\"\n[model_providers.third]\nname = \"Third\"\nbase_url = \"https://example.invalid/v1\"\nwire_api = \"chat\"\n"
            }),
            Some("openai_chat"),
        );
        first.id = "failed-first-chat".to_string();

        let error =
            add_provider_with_automatic_routing_state(state.clone(), AppType::Codex, first, true)
                .await
                .expect_err("forced activation failure must abort add");
        assert!(error.contains("forced first-provider activation failure"));
        assert!(db
            .get_all_providers("codex")
            .expect("providers after rollback")
            .is_empty());
        assert_eq!(db.get_current_provider("codex").expect("db current"), None);
        assert_eq!(crate::settings::get_current_provider(&AppType::Codex), None);
        assert!(!get_codex_auth_path().exists());
        assert!(!get_codex_config_path().exists());
        assert!(!get_codex_model_catalog_path().exists());
        assert!(
            !db.get_proxy_config_for_app("codex")
                .await
                .expect("routing")
                .enabled
        );
        assert!(!state.proxy_service.is_running().await);
        assert!(db.get_live_backup("codex").await.expect("backup").is_none());

        match original {
            Some(v) => std::env::set_var("CC_SWITCH_TEST_HOME", v),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        crate::settings::reload_settings().expect("restore settings");
    }
}

#[cfg(test)]
mod import_claude_desktop_tests {
    use super::suggested_claude_desktop_routes;
    use crate::provider::{Provider, ProviderMeta};
    use serde_json::json;

    fn make_provider(env: serde_json::Value, provider_type: Option<&str>) -> Provider {
        let mut p = Provider::with_id(
            "test-claude".to_string(),
            "Test".to_string(),
            json!({ "env": env }),
            None,
        );
        if let Some(pt) = provider_type {
            p.meta = Some(ProviderMeta {
                provider_type: Some(pt.to_string()),
                ..ProviderMeta::default()
            });
        }
        p
    }

    #[test]
    fn route_strips_1m_suffix_and_sets_supports_1m() {
        let p = make_provider(
            json!({
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-20250929[1M]",
            }),
            None,
        );
        let routes = suggested_claude_desktop_routes(&p).expect("routes built");
        let r = routes.get("claude-sonnet-5").expect("sonnet route present");
        assert_eq!(r.model, "claude-sonnet-4-5-20250929");
        assert!(
            !r.model.to_ascii_lowercase().contains("[1m]"),
            "model must not contain [1m] suffix"
        );
        assert_eq!(r.label_override, None);
        assert_eq!(r.supports_1m, Some(true));
    }

    #[test]
    fn route_preserves_model_without_suffix() {
        let p = make_provider(
            json!({
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k2",
            }),
            None,
        );
        let routes = suggested_claude_desktop_routes(&p).expect("routes built");
        let r = routes.get("claude-sonnet-5").expect("sonnet route present");
        assert_eq!(r.model, "kimi-k2");
        assert_eq!(r.label_override.as_deref(), Some("kimi-k2"));
        // 默认 provider_type 缺省 → supports_1m_default = true
        assert_eq!(r.supports_1m, Some(true));
    }

    #[test]
    fn route_uses_claude_code_model_name_as_label_override() {
        let p = make_provider(
            json!({
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k2",
                "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Kimi K2",
            }),
            None,
        );
        let routes = suggested_claude_desktop_routes(&p).expect("routes built");
        let r = routes.get("claude-sonnet-5").expect("sonnet route present");
        assert_eq!(r.model, "kimi-k2");
        assert_eq!(r.label_override.as_deref(), Some("Kimi K2"));
    }

    #[test]
    fn route_1m_suffix_overrides_provider_type_default() {
        // github_copilot 默认 supports_1m_default = false，但 [1M] 后缀应强制 true
        let p = make_provider(
            json!({
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5-codex[1M]",
            }),
            Some("github_copilot"),
        );
        let routes = suggested_claude_desktop_routes(&p).expect("routes built");
        let r = routes.get("claude-sonnet-5").expect("sonnet route present");
        assert_eq!(r.model, "gpt-5-codex");
        assert_eq!(r.label_override.as_deref(), Some("gpt-5-codex"));
        assert_eq!(r.supports_1m, Some(true));
    }

    #[test]
    fn route_github_copilot_without_suffix_keeps_false() {
        let p = make_provider(
            json!({
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5-codex",
            }),
            Some("github_copilot"),
        );
        let routes = suggested_claude_desktop_routes(&p).expect("routes built");
        let r = routes.get("claude-sonnet-5").expect("sonnet route present");
        assert_eq!(r.model, "gpt-5-codex");
        assert_eq!(r.label_override.as_deref(), Some("gpt-5-codex"));
        assert_eq!(r.supports_1m, Some(false));
    }

    #[test]
    fn same_upstream_across_three_aliases_merges_to_one_route() {
        let p = make_provider(
            json!({
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "MiniMax-M2",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "MiniMax-M2",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "MiniMax-M2",
            }),
            None,
        );
        let routes = suggested_claude_desktop_routes(&p).expect("routes built");
        assert_eq!(routes.len(), 1, "three aliases → one merged route");
        let r = routes.get("claude-sonnet-5").expect("merged route present");
        assert_eq!(r.model, "MiniMax-M2");
        assert_eq!(r.label_override.as_deref(), Some("MiniMax-M2"));
    }

    #[test]
    fn same_upstream_with_partial_1m_marker_takes_or_aggregation() {
        // sonnet 带 [1M]，opus/haiku 不带 → 合并后 supports_1m == Some(true)
        let p = make_provider(
            json!({
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "MiniMax-M2[1M]",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "MiniMax-M2",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "MiniMax-M2",
            }),
            None,
        );
        let routes = suggested_claude_desktop_routes(&p).expect("routes built");
        assert_eq!(routes.len(), 1);
        let r = routes.get("claude-sonnet-5").expect("merged route present");
        assert_eq!(r.supports_1m, Some(true));
    }

    #[test]
    fn different_upstream_models_produce_separate_routes() {
        let p = make_provider(
            json!({
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "GLM-4.6",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "GLM-4-Air",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "GLM-4-Flash",
            }),
            None,
        );
        let routes = suggested_claude_desktop_routes(&p).expect("routes built");
        assert_eq!(routes.len(), 3);
        assert_eq!(routes.get("claude-sonnet-5").unwrap().model, "GLM-4.6");
        assert_eq!(routes.get("claude-opus-4-8").unwrap().model, "GLM-4-Air");
        assert_eq!(routes.get("claude-haiku-4-5").unwrap().model, "GLM-4-Flash");
        assert_eq!(
            routes
                .get("claude-sonnet-5")
                .unwrap()
                .label_override
                .as_deref(),
            Some("GLM-4.6")
        );
    }

    #[test]
    fn anthropic_model_fallback_only_triggers_when_empty() {
        // 三个 default env_key 都不填，仅 ANTHROPIC_MODEL
        let p = make_provider(
            json!({
                "ANTHROPIC_MODEL": "kimi-k2",
            }),
            None,
        );
        let routes = suggested_claude_desktop_routes(&p).expect("routes built");
        assert_eq!(routes.len(), 1);
        let r = routes
            .get("claude-sonnet-5")
            .expect("fallback route present");
        assert_eq!(r.model, "kimi-k2");
        assert_eq!(r.label_override.as_deref(), Some("kimi-k2"));
    }

    #[test]
    fn existing_claude_prefix_not_duplicated() {
        let p = make_provider(
            json!({
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-20250929",
            }),
            None,
        );
        let routes = suggested_claude_desktop_routes(&p).expect("routes built");
        assert!(routes.contains_key("claude-sonnet-5"));
        assert!(!routes.contains_key("claude-claude-sonnet-4-5-20250929"));
        assert_eq!(
            routes.get("claude-sonnet-5").expect("route").label_override,
            None
        );
    }
}

#[cfg(test)]
mod native_query_credentials_tests {
    use super::{resolve_coding_plan_credentials, resolve_native_credentials};
    use crate::app_config::AppType;
    use crate::provider::{Provider, UsageScript};
    use serde_json::json;

    fn usage_script(
        coding_plan_provider: Option<&str>,
        base_url: Option<&str>,
        api_key: Option<&str>,
    ) -> UsageScript {
        UsageScript {
            enabled: true,
            language: "javascript".to_string(),
            code: String::new(),
            timeout: Some(10),
            api_key: api_key.map(str::to_string),
            base_url: base_url.map(str::to_string),
            access_token: None,
            user_id: None,
            template_type: Some("token_plan".to_string()),
            auto_query_interval: None,
            coding_plan_provider: coding_plan_provider.map(str::to_string),
            access_key_id: None,
            secret_access_key: None,
            team_organization_id: None,
            team_project_id: None,
        }
    }

    #[test]
    fn delegates_to_provider_for_codex() {
        let provider = Provider::with_id(
            "test".to_string(),
            "Test".to_string(),
            json!({
                "auth": { "OPENAI_API_KEY": "sk-codex" },
                "config": "model_provider = \"deepseek\"\n\
                           [model_providers.deepseek]\n\
                           base_url = \"https://api.deepseek.com\"\n",
            }),
            None,
        );
        let (base_url, api_key) = resolve_native_credentials(&AppType::Codex, Some(&provider));
        assert_eq!(base_url, "https://api.deepseek.com");
        assert_eq!(api_key, "sk-codex");
    }

    #[test]
    fn missing_provider_yields_empty() {
        let (base_url, api_key) = resolve_native_credentials(&AppType::Codex, None);
        assert!(base_url.is_empty());
        assert!(api_key.is_empty());
    }

    #[test]
    fn zenmux_coding_plan_uses_script_credentials_first() {
        let provider = Provider::with_id(
            "test".to_string(),
            "Test".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://provider.zenmux.example/v1",
                    "ANTHROPIC_AUTH_TOKEN": "sk-provider"
                }
            }),
            None,
        );
        let script = usage_script(
            Some("zenmux"),
            Some("https://script.zenmux.example/api/usage/"),
            Some("sk-script"),
        );

        let (base_url, api_key) =
            resolve_coding_plan_credentials(&AppType::Claude, Some(&provider), Some(&script));

        assert_eq!(base_url, "https://script.zenmux.example/api/usage");
        assert_eq!(api_key, "sk-script");
    }

    #[test]
    fn zenmux_coding_plan_falls_back_to_provider_credentials() {
        let provider = Provider::with_id(
            "test".to_string(),
            "Test".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://provider.zenmux.example/v1",
                    "ANTHROPIC_AUTH_TOKEN": "sk-provider"
                }
            }),
            None,
        );
        let script = usage_script(Some("zenmux"), Some("https://script.zenmux.example"), None);

        let (base_url, api_key) =
            resolve_coding_plan_credentials(&AppType::Claude, Some(&provider), Some(&script));

        assert_eq!(base_url, "https://provider.zenmux.example/v1");
        assert_eq!(api_key, "sk-provider");
    }
}
