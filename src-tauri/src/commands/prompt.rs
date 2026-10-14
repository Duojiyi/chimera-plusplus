use indexmap::IndexMap;
use std::str::FromStr;

use tauri::State;

use crate::app_config::AppType;
use crate::error::AppError;
use crate::prompt::{Prompt, PromptCategory};
use crate::services::prompt::{CodexPromptResolution, CodexPromptStatus};
use crate::services::PromptService;
use crate::store::AppState;

#[tauri::command]
pub async fn get_prompts(
    app: String,
    state: State<'_, AppState>,
) -> Result<IndexMap<String, Prompt>, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    PromptService::get_prompts(&state, app_type).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upsert_prompt(
    app: String,
    id: String,
    prompt: Prompt,
    expected: Option<Prompt>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    run_blocking(move || {
        PromptService::upsert_prompt_checked(&state, app_type, &id, prompt, expected)
    })
    .await
}

#[tauri::command]
pub async fn delete_prompt(
    app: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    run_blocking(move || PromptService::delete_prompt(&state, app_type, &id)).await
}

#[tauri::command]
pub async fn enable_prompt(
    app: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    run_blocking(move || PromptService::enable_prompt(&state, app_type, &id)).await
}

#[tauri::command]
pub async fn set_prompt_enabled(
    app: String,
    id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    run_blocking(move || PromptService::set_prompt_enabled(&state, app_type, &id, enabled)).await
}

#[tauri::command]
pub async fn import_prompt_from_file(
    app: String,
    file_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    run_blocking(move || match file_path {
        Some(path) => {
            PromptService::import_markdown_file(&state, app_type, std::path::Path::new(&path))
        }
        None => PromptService::import_from_file(&state, app_type),
    })
    .await
}

#[tauri::command]
pub async fn get_current_prompt_file_content(app: String) -> Result<Option<String>, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    run_blocking(move || PromptService::get_current_file_content(app_type)).await
}

#[tauri::command]
pub async fn adopt_foreign_codex_prompt(
    expected_content: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    crate::product_policy::require(crate::product_policy::Capability::Prompts)
        .map_err(|error| error.to_string())?;
    let state = state.inner().clone();
    run_blocking(move || PromptService::adopt_foreign_codex(&state, &expected_content)).await
}

/// Whether the enabled Codex prompts are what Codex actually reads.
#[tauri::command]
pub async fn get_codex_prompt_status(
    state: State<'_, AppState>,
) -> Result<CodexPromptStatus, String> {
    crate::product_policy::require(crate::product_policy::Capability::Prompts)
        .map_err(|error| error.to_string())?;
    let state = state.inner().clone();
    let guard = state.proxy_service.lock_switch_for_app("codex").await;
    run_blocking(move || {
        let _guard = guard;
        PromptService::codex_status(&state)
    })
    .await
}

/// User-confirmed resolution of a removed or hand-edited Chimera block.
#[tauri::command]
pub async fn resolve_codex_prompt_file(
    action: CodexPromptResolution,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    crate::product_policy::require(crate::product_policy::Capability::Prompts)
        .map_err(|error| error.to_string())?;
    let state = state.inner().clone();
    let guard = state.proxy_service.lock_switch_for_app("codex").await;
    run_blocking(move || {
        let _guard = guard;
        PromptService::resolve_codex_file(&state, action)
    })
    .await
}

async fn run_blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| "提示词后台任务执行失败，请重试。".to_string())?
        .map_err(ipc_error)
}

/// Errors cross IPC as plain strings. Lead with a localized error's stable key
/// so the page can map it to guidance without parsing the localized prose.
fn ipc_error(error: AppError) -> String {
    match &error {
        AppError::Localized { key, .. } => format!("[{key}] {error}"),
        _ => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localized_errors_lead_with_their_stable_code() {
        let coded = AppError::localized("prompt.managed.duplicate", "重复", "Duplicate");
        assert_eq!(
            ipc_error(coded),
            "[prompt.managed.duplicate] 重复 (Duplicate)"
        );
        assert_eq!(
            ipc_error(AppError::InvalidInput("启用的提示词不能为空。".into())),
            "无效输入: 启用的提示词不能为空。"
        );
    }
}

#[tauri::command]
pub async fn get_prompt_categories(
    app: String,
    state: State<'_, AppState>,
) -> Result<Vec<PromptCategory>, String> {
    let app = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    let guard = state.proxy_service.lock_switch_for_app(app.as_str()).await;
    run_blocking(move || {
        let _guard = guard;
        state.db.get_prompt_categories(app.as_str())
    })
    .await
}

#[tauri::command]
pub async fn create_prompt_category(
    app: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let app = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    let guard = state.proxy_service.lock_switch_for_app(app.as_str()).await;
    run_blocking(move || {
        let _guard = guard;
        state.db.get_prompt_categories(app.as_str())?;
        state.db.create_prompt_category(app.as_str(), &name)
    })
    .await
}

#[tauri::command]
pub async fn rename_prompt_category(
    app: String,
    id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    let guard = state.proxy_service.lock_switch_for_app(app.as_str()).await;
    run_blocking(move || {
        let _guard = guard;
        state.db.rename_prompt_category(app.as_str(), &id, &name)
    })
    .await
}

#[tauri::command]
pub async fn delete_prompt_category(
    app: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let state = state.inner().clone();
    let guard = state.proxy_service.lock_switch_for_app(app.as_str()).await;
    run_blocking(move || {
        let _guard = guard;
        state.db.delete_prompt_category(app.as_str(), &id)
    })
    .await
}
