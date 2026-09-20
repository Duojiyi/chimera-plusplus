#![allow(non_snake_case)]

use crate::session_manager;

#[tauri::command]
pub async fn list_sessions() -> Result<Vec<session_manager::SessionMeta>, String> {
    let sessions = tauri::async_runtime::spawn_blocking(|| {
        // 列表是「会话是否可见」的唯一出口，所以在扫描前先归拢一次：启动和切换
        // 线路后的自动归拢已覆盖常规路径，但 Codex 在应用运行期间自己写入的新
        // 桶（用户在 Codex 侧改了配置、或应用未运行时切过线路）只有这里能兜住。
        // 幂等且无事可做时不写文件，代价是一次目录扫描。
        crate::codex_history_migration::auto_reclaim_codex_history_if_needed();
        session_manager::scan_sessions()
    })
    .await
    .map_err(|e| format!("Failed to scan sessions: {e}"))?;
    Ok(sessions)
}

#[tauri::command]
pub async fn get_session_messages(
    providerId: String,
    sourcePath: String,
) -> Result<Vec<session_manager::SessionMessage>, String> {
    let provider_id = providerId.clone();
    let source_path = sourcePath.clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_manager::load_messages(&provider_id, &source_path)
    })
    .await
    .map_err(|e| format!("Failed to load session messages: {e}"))?
}

#[tauri::command]
pub async fn launch_session_terminal(
    command: String,
    cwd: Option<String>,
    custom_config: Option<String>,
) -> Result<bool, String> {
    let command = command.clone();
    let cwd = cwd.clone();
    let custom_config = custom_config.clone();

    // Read preferred terminal from global settings
    let preferred = crate::settings::get_preferred_terminal();
    // Map global setting terminal names to session terminal names
    // Global uses "iterm2", session terminal uses "iterm"
    let target = match preferred.as_deref() {
        Some("iterm2") => "iterm".to_string(),
        Some(t) => t.to_string(),
        None => "terminal".to_string(), // Default to Terminal.app on macOS
    };

    tauri::async_runtime::spawn_blocking(move || {
        session_manager::terminal::launch_terminal(
            &target,
            &command,
            cwd.as_deref(),
            custom_config.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Failed to launch terminal: {e}"))??;

    Ok(true)
}

#[tauri::command]
pub async fn delete_session(
    providerId: String,
    sessionId: String,
    sourcePath: String,
) -> Result<bool, String> {
    let provider_id = providerId.clone();
    let session_id = sessionId.clone();
    let source_path = sourcePath.clone();

    tauri::async_runtime::spawn_blocking(move || {
        session_manager::delete_session(&provider_id, &session_id, &source_path)
    })
    .await
    .map_err(|e| format!("Failed to delete session: {e}"))?
}

#[tauri::command]
pub async fn delete_sessions(
    items: Vec<session_manager::DeleteSessionRequest>,
) -> Result<Vec<session_manager::DeleteSessionOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || session_manager::delete_sessions(&items))
        .await
        .map_err(|e| format!("Failed to delete sessions: {e}"))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHistoryReclaimResult {
    pub reclaimed_jsonl_files: usize,
    pub reclaimed_state_rows: usize,
    pub deferred_jsonl_files: usize,
    pub source_provider_ids: Vec<String>,
    /// 被跳过的原因，前端据此区分「无需恢复」与「恢复了 0 项」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_reason: Option<String>,
}

/// 一键把所有第三方桶的 Codex 历史会话归拢到当前共享 custom 桶。
///
/// 切换中转供应商后会话列表看起来「丢失」时使用：会话文件仍在
/// `~/.codex/sessions`，只是记录的 `model_provider` 是旧桶 id，Codex 便不再列出。
/// 改写前自动备份；幂等，可反复执行。
#[tauri::command]
pub async fn reclaim_codex_history_sessions() -> Result<CodexHistoryReclaimResult, String> {
    let outcome = tauri::async_runtime::spawn_blocking(
        crate::codex_history_migration::reclaim_all_codex_history_into_current_bucket,
    )
    .await
    .map_err(|e| format!("恢复历史会话任务中断: {e}"))?
    .map_err(|e| e.to_string())?;

    if let Some(reason) = &outcome.skipped_reason {
        log::debug!("○ Codex history reclaim skipped: {reason}");
    } else {
        log::info!(
            "✓ Codex history reclaimed into current bucket: jsonl_files={}, state_rows={}, sources={:?}",
            outcome.reclaimed_jsonl_files,
            outcome.reclaimed_state_rows,
            outcome.source_provider_ids
        );
    }

    Ok(CodexHistoryReclaimResult {
        reclaimed_jsonl_files: outcome.reclaimed_jsonl_files,
        reclaimed_state_rows: outcome.reclaimed_state_rows,
        deferred_jsonl_files: outcome.deferred_jsonl_files,
        source_provider_ids: outcome.source_provider_ids,
        skipped_reason: outcome.skipped_reason,
    })
}
