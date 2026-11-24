#![allow(non_snake_case)]

use indexmap::IndexMap;
use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use crate::app_config::AppType;
use crate::claude_mcp;
use crate::services::McpService;
use crate::store::AppState;

/// 获取 Claude MCP 状态
#[tauri::command]
pub async fn get_claude_mcp_status() -> Result<claude_mcp::McpStatus, String> {
    tauri::async_runtime::spawn_blocking(claude_mcp::get_mcp_status)
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
        .map_err(|e| e.to_string())
}

/// 读取 mcp.json 文本内容
#[tauri::command]
pub async fn read_claude_mcp_config() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(claude_mcp::read_mcp_json)
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
        .map_err(|e| e.to_string())
}

/// 新增或更新一个 MCP 服务器条目
#[tauri::command]
pub async fn upsert_claude_mcp_server(
    state: State<'_, AppState>,
    id: String,
    spec: serde_json::Value,
) -> Result<bool, String> {
    let _client = state.proxy_service.lock_switch_for_app("claude").await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::services::mcp::lock_operation().map_err(|e| e.to_string())?;
        claude_mcp::upsert_mcp_server(&id, spec).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 删除一个 MCP 服务器条目
#[tauri::command]
pub async fn delete_claude_mcp_server(
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let _client = state.proxy_service.lock_switch_for_app("claude").await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::services::mcp::lock_operation().map_err(|e| e.to_string())?;
        claude_mcp::delete_mcp_server(&id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 校验命令是否在 PATH 中可用（不执行）
#[tauri::command]
pub async fn validate_mcp_command(cmd: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || claude_mcp::validate_command_in_path(&cmd))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigResponse {
    pub config_path: String,
    pub servers: HashMap<String, serde_json::Value>,
}

/// 获取 MCP 配置（来自 ~/.cc-switch/config.json）
use std::str::FromStr;

#[tauri::command]
#[allow(deprecated)] // 兼容层命令，内部调用已废弃的 Service 方法
pub async fn get_mcp_config(
    state: State<'_, AppState>,
    app: String,
) -> Result<McpConfigResponse, String> {
    let app_ty = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config_path = crate::config::get_app_config_path()
            .to_string_lossy()
            .to_string();
        let servers = McpService::get_servers(&state, app_ty).map_err(|e| e.to_string())?;
        Ok(McpConfigResponse {
            config_path,
            servers,
        })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 在 config.json 中新增或更新一个 MCP 服务器定义
/// [已废弃] 该命令仍然使用旧的分应用API，会转换为统一结构
#[tauri::command]
pub async fn upsert_mcp_server_in_config(
    state: State<'_, AppState>,
    app: String,
    id: String,
    spec: serde_json::Value,
    sync_other_side: Option<bool>,
) -> Result<bool, String> {
    let app_ty = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        McpService::upsert_legacy(&state, app_ty, id, spec, sync_other_side.unwrap_or(false))
            .map(|_| true)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 在 config.json 中删除一个 MCP 服务器定义
#[tauri::command]
pub async fn delete_mcp_server_in_config(
    state: State<'_, AppState>,
    _app: String, // 参数保留用于向后兼容，但在统一结构中不再需要
    id: String,
) -> Result<bool, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || delete_mcp_server_result(&state, &id))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 设置启用状态并同步到客户端配置
#[tauri::command]
#[allow(deprecated)] // 兼容层命令，内部调用已废弃的 Service 方法
pub async fn set_mcp_enabled(
    state: State<'_, AppState>,
    app: String,
    id: String,
    enabled: bool,
) -> Result<bool, String> {
    let app_ty = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        McpService::set_enabled(&state, app_ty, &id, enabled).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

// ============================================================================
// v3.7.0 新增：统一 MCP 管理命令
// ============================================================================

use crate::app_config::McpServer;

/// 获取所有 MCP 服务器（统一结构）
#[tauri::command]
pub async fn get_mcp_servers(
    state: State<'_, AppState>,
) -> Result<IndexMap<String, McpServer>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        McpService::get_all_servers(&state).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 添加或更新 MCP 服务器
#[tauri::command]
pub async fn upsert_mcp_server(
    state: State<'_, AppState>,
    server: McpServer,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || upsert_mcp_server_result(&state, server))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 删除 MCP 服务器
#[tauri::command]
pub async fn delete_mcp_server(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || delete_mcp_server_result(&state, &id))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 切换 MCP 服务器在指定应用的启用状态
#[tauri::command]
pub async fn toggle_mcp_app(
    state: State<'_, AppState>,
    server_id: String,
    app: String,
    enabled: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        toggle_mcp_app_result(&state, &server_id, &app, enabled)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 从所有应用导入 MCP 服务器（复用已有的导入逻辑）
#[tauri::command]
pub async fn import_mcp_from_apps(state: State<'_, AppState>) -> Result<usize, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        McpService::import_from_all_apps(&state).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

// Keep the IPC result boundary testable without a GUI runtime or real HOME.
pub(crate) fn upsert_mcp_server_result(state: &AppState, server: McpServer) -> Result<(), String> {
    McpService::upsert_server(state, server).map_err(|e| e.to_string())
}

pub(crate) fn delete_mcp_server_result(state: &AppState, id: &str) -> Result<bool, String> {
    McpService::delete_server(state, id).map_err(|e| e.to_string())
}

pub(crate) fn toggle_mcp_app_result(
    state: &AppState,
    id: &str,
    app: &str,
    enabled: bool,
) -> Result<(), String> {
    let app = AppType::from_str(app).map_err(|e| e.to_string())?;
    McpService::toggle_app(state, id, app, enabled).map_err(|e| e.to_string())
}
