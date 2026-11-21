//! 项目 Profile 管理命令

use serde::Serialize;
use tauri::{Emitter, Manager, State};

use crate::database::Profile;
use crate::services::profile::{ProfilePayload, ProfileScope, ProfileService};
use crate::store::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDto {
    pub id: String,
    pub name: String,
    pub payload: ProfilePayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

impl From<Profile> for ProfileDto {
    fn from(profile: Profile) -> Self {
        // 单条 payload 损坏不应拖垮整个列表：降级为默认值并记日志
        let payload = serde_json::from_str(&profile.payload).unwrap_or_else(|e| {
            log::warn!(
                "解析 profile '{}' payload 失败，使用默认值: {e}",
                profile.id
            );
            ProfilePayload::default()
        });
        Self {
            id: profile.id,
            name: profile.name,
            payload,
            created_at: profile.created_at,
            updated_at: profile.updated_at,
        }
    }
}

/// 每个分组当前激活的项目 id（未使用项目时为 null）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentProfileIds {
    pub claude: Option<String>,
    pub claude_desktop: Option<String>,
    pub codex: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesResponse {
    pub profiles: Vec<ProfileDto>,
    pub current_ids: CurrentProfileIds,
}

/// Profile 应用完成后的统一收尾：发事件 + 重建托盘菜单
///
/// 只对项目所属分组内的应用发 provider-switched。UI 与托盘两个入口必须
/// 共用此函数，保证事件 payload 形状一致（前端 App.tsx 的
/// provider-switched 监听依赖该形状）。
pub fn emit_profile_apply_events(
    app: &tauri::AppHandle,
    state: &AppState,
    profile_id: Option<&str>,
    scope: ProfileScope,
) {
    for app_type in scope.apps().iter() {
        let app_str = app_type.as_str();
        let (proxy_enabled, auto_failover_enabled) = state.db.get_proxy_flags_sync(app_str);
        let provider_id = crate::settings::get_effective_current_provider(&state.db, app_type)
            .ok()
            .flatten()
            .unwrap_or_default();
        let event_data = serde_json::json!({
            "appType": app_str,
            "proxyEnabled": proxy_enabled,
            "autoFailoverEnabled": auto_failover_enabled,
            "providerId": provider_id,
        });
        if let Err(e) = app.emit("provider-switched", event_data) {
            log::error!("发射 provider-switched 事件失败: {e}");
        }
    }
    if let Err(e) = app.emit(
        "profile-applied",
        serde_json::json!({ "profileId": profile_id, "scope": scope.as_str() }),
    ) {
        log::error!("发射 profile-applied 事件失败: {e}");
    }
    crate::tray::refresh_tray_menu(app);
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Result<ProfilesResponse, String> {
    let profiles = ProfileService::list(&state).map_err(|e| e.to_string())?;
    let current_ids = CurrentProfileIds {
        claude: state
            .db
            .get_current_profile_id(ProfileScope::Claude.as_str())
            .map_err(|e| e.to_string())?,
        claude_desktop: state
            .db
            .get_current_profile_id(ProfileScope::ClaudeDesktop.as_str())
            .map_err(|e| e.to_string())?,
        codex: state
            .db
            .get_current_profile_id(ProfileScope::Codex.as_str())
            .map_err(|e| e.to_string())?,
    };
    Ok(ProfilesResponse {
        profiles: profiles.into_iter().map(ProfileDto::from).collect(),
        current_ids,
    })
}

#[tauri::command]
pub fn create_profile(
    state: State<'_, AppState>,
    name: String,
    scope: String,
) -> Result<ProfileDto, String> {
    let scope = ProfileScope::parse(&scope).map_err(|e| e.to_string())?;
    ProfileService::create(&state, &name, scope)
        .map(ProfileDto::from)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_profile(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    resnapshot: Option<bool>,
    scope: Option<String>,
) -> Result<ProfileDto, String> {
    let scope = scope
        .map(|s| ProfileScope::parse(&s))
        .transpose()
        .map_err(|e| e.to_string())?;
    ProfileService::update(&state, &id, name, resnapshot.unwrap_or(false), scope)
        .map(ProfileDto::from)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    ProfileService::delete(&state, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_current_profile(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scope: String,
) -> Result<(), String> {
    let scope = ProfileScope::parse(&scope).map_err(|e| e.to_string())?;
    {
        let _profile_guard = state.profile_apply_lock.lock().await;
        state
            .db
            .set_current_profile_id(scope.as_str(), None)
            .map_err(|e| e.to_string())?;
        #[cfg(target_os = "windows")]
        crate::tray::send_tray_project_result(
            &app,
            &_profile_guard,
            scope,
            None,
            crate::tray::TrayProjectResult::Cleared,
        );
    }
    crate::tray::refresh_tray_menu(&app);
    Ok(())
}

/// 应用项目快照（只作用于发起页所属分组内的应用）。
///
/// 供应商切换复用异步自动路由事务，因此命令本身也必须是 async。
#[tauri::command]
pub async fn apply_profile(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    scope: String,
) -> Result<Vec<String>, String> {
    let scope = ProfileScope::parse(&scope).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    let outcome = {
        let _profile_guard = state.profile_apply_lock.lock().await;
        let outcome = ProfileService::apply_profile_lock_held(&state, &id, scope).await;
        // The main window shows this operation's own result. Invalidate any
        // older tray notice even when the main window reports a partial failure.
        #[cfg(target_os = "windows")]
        crate::tray::send_tray_project_result(
            &app,
            &_profile_guard,
            scope,
            Some(&id),
            crate::tray::TrayProjectResult::Cleared,
        );
        outcome
    };
    let outcome = outcome.map_err(|e| e.to_string())?;
    let current_id = outcome.bound.then_some(id);

    if outcome.should_stop_proxy {
        // sync 命令线程没有 Tokio runtime，无法直接 await stop()；
        // 把停止服务放到 Tauri async runtime，停止后再补发事件刷新 UI。
        let app_handle = app.clone();
        let proxy_service = state.proxy_service.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = proxy_service.stop_if_no_takeover().await {
                log::warn!("切换项目后停止代理服务失败: {e}");
            }
            if let Some(app_state) = app_handle.try_state::<AppState>() {
                emit_profile_apply_events(
                    &app_handle,
                    app_state.inner(),
                    current_id.as_deref(),
                    scope,
                );
            }
        });
    } else {
        emit_profile_apply_events(&app, &state, current_id.as_deref(), scope);
    }

    Ok(outcome.warnings)
}
