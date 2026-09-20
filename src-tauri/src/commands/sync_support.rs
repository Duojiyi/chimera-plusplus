use serde_json::{json, Value};
use tokio::sync::OwnedMutexGuard;

use crate::app_config::AppType;
use crate::error::AppError;
use crate::services::provider::ProviderService;
use crate::store::AppState;

// Owned guards can move into post-sync workers, so cancellation never releases
// lifecycle/profile protection while a detached blocking sync is still writing.
pub(crate) async fn lock_import_runtime(
    state: &AppState,
) -> Result<(OwnedMutexGuard<()>, OwnedMutexGuard<()>), AppError> {
    let profile_guard = state.profile_apply_lock.clone().lock_owned().await;
    let lifecycle_guard = state.proxy_service.lock_lifecycle().await;
    if state.proxy_service.is_running().await {
        return Err(AppError::Message(
            "请先停止代理并关闭接管，再恢复、导入或同步配置；数据库尚未修改。".into(),
        ));
    }
    ensure_no_takeover(state)?;
    Ok((profile_guard, lifecycle_guard))
}

pub(crate) async fn lock_import_apps(state: &AppState) -> Vec<OwnedMutexGuard<()>> {
    let mut guards = Vec::new();
    for app in AppType::all() {
        guards.push(state.proxy_service.lock_switch_for_app(app.as_str()).await);
    }
    guards
}

// Own the shared guards inside the blocking job: cancelling the command must
// not unlock a still-running database replacement or Live write. Match the
// existing profile -> lifecycle -> per-app lock order.
pub(crate) fn with_stopped_proxy<T>(
    state: &AppState,
    operation: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _guards = futures::executor::block_on(lock_import_runtime(state))?;
    operation()
}

fn ensure_no_takeover(state: &AppState) -> Result<(), AppError> {
    state.db.validate_stopped_proxy_state()?;
    for app in AppType::all() {
        let app_id = app.as_str();
        if state
            .proxy_service
            .detect_takeover_in_live_config_for_app(&app)
        {
            return Err(AppError::Message(format!(
                "{app_id} 仍有代理接管状态。请关闭接管后重新应用当前供应商并同步 Live 配置。"
            )));
        }
    }
    Ok(())
}

pub(crate) fn replace_database(
    state: &AppState,
    replace: impl FnOnce() -> Result<String, AppError>,
) -> Result<String, AppError> {
    let _app_guards = futures::executor::block_on(lock_import_apps(state));
    ensure_no_takeover(state)?;
    // Already inside the real blocking job. Hold from before the callback's
    // snapshot until replacement completes, even if the command is cancelled.
    // Lock order: profile -> lifecycle -> apps -> session -> database.
    let _session_guard =
        futures::executor::block_on(crate::services::session_usage::session_sync_mutex().lock());
    replace()
    // Drop app/session guards before post-import sync, which may acquire app locks.
}

pub(crate) fn run_post_import_sync(state: &AppState) -> Result<(), AppError> {
    // Same post-import path, but never construct an isolated AppState. Reload
    // settings even when the imported DB contains takeover data we cannot apply.
    crate::settings::reload_settings()?;
    ensure_no_takeover(state)?;
    ProviderService::sync_current_to_live(state)
}

pub(crate) fn post_import_warning(state: &AppState) -> Option<String> {
    // A panic in post-sync is still partial success: the DB is already committed.
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_post_import_sync(state)))
            .map_err(|_| {
                "后置同步任务异常退出，请重新应用当前供应商并同步 Live 配置。".to_string()
            });
    let warning = post_sync_warning_from_result(result);
    if let Some(message) = warning.as_ref() {
        log::warn!("[Import/Restore] {message}");
    }
    warning
}

fn post_sync_warning<E: std::fmt::Display>(err: E) -> String {
    AppError::localized(
        "sync.post_operation_sync_failed",
        format!("后置同步状态失败: {err}"),
        format!("Post-operation synchronization failed: {err}"),
    )
    .to_string()
}

pub(crate) fn post_sync_warning_from_result(
    result: Result<Result<(), AppError>, String>,
) -> Option<String> {
    match result {
        Ok(Ok(())) => None,
        Ok(Err(err)) => Some(post_sync_warning(err)),
        Err(err) => Some(post_sync_warning(err)),
    }
}

pub(crate) fn attach_warning(mut value: Value, warning: Option<String>) -> Value {
    if let Some(message) = warning {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("warning".to_string(), Value::String(message));
        }
    }
    value
}

pub(crate) fn success_payload_with_warning(backup_id: String, warning: Option<String>) -> Value {
    attach_warning(
        json!({
            "success": true,
            "message": "SQL imported successfully",
            "backupId": backup_id
        }),
        warning,
    )
}

#[cfg(test)]
#[path = "sync_support_session_tests.rs"]
mod session_tests;

#[cfg(test)]
mod tests {
    use super::{attach_warning, post_sync_warning_from_result};
    use serde_json::json;

    #[test]
    fn post_sync_warning_from_result_returns_none_on_success() {
        let warning = post_sync_warning_from_result(Ok(Ok(())));
        assert!(warning.is_none());
    }

    #[test]
    fn post_sync_warning_from_result_returns_some_on_sync_error() {
        let warning =
            post_sync_warning_from_result(Ok(Err(crate::error::AppError::Config("boom".into()))));
        assert!(warning.is_some());
    }

    #[tokio::test]
    async fn post_sync_warning_from_result_returns_some_on_join_error() {
        let handle = tokio::spawn(async move {
            panic!("forced join error");
        });
        let join_err = handle.await.expect_err("task should panic");
        let warning = post_sync_warning_from_result(Err(join_err.to_string()));
        assert!(warning.is_some());
    }

    #[test]
    fn attach_warning_adds_warning_without_dropping_existing_fields() {
        let payload = json!({ "status": "downloaded" });
        let updated = attach_warning(payload, Some("post sync warning".to_string()));
        assert_eq!(
            updated.get("status").and_then(|v| v.as_str()),
            Some("downloaded")
        );
        assert_eq!(
            updated.get("warning").and_then(|v| v.as_str()),
            Some("post sync warning")
        );
    }
}
