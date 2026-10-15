use crate::deeplink::{
    import_mcp_from_deeplink, import_prompt_from_deeplink, import_provider_from_deeplink,
    import_skill_from_deeplink, parse_deeplink_url, DeepLinkImportRequest,
};
use crate::store::AppState;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

/// Kept in memory until the confirmation UI acknowledges the request. Events
/// only wake the reader; they never transfer ownership or trigger an import.
#[derive(Clone, serde::Serialize)]
pub struct PendingDeepLink {
    id: String,
    request: DeepLinkImportRequest,
    #[serde(skip)]
    source_url: String,
}

#[derive(Default)]
pub struct PendingDeepLinks(Mutex<VecDeque<PendingDeepLink>>);

/// Links the backend refused before queueing them, kept until the frontend has
/// read them. Unlike the import queue there is nothing to acknowledge, so an
/// error would otherwise be lost whenever no window was listening yet: a link
/// opened while the app runs hidden, a cold start that cannot subscribe before
/// `setup` runs, or the rebuilt window that follows lightweight mode.
///
/// Only reason codes reach the frontend, never the link itself, which may
/// carry a key. Reading drains the buffer, so each refusal is explained once.
#[derive(Default)]
pub struct DeepLinkRefusals(Mutex<RefusalBuffer>);

#[derive(Default)]
struct RefusalBuffer {
    reasons: VecDeque<String>,
    /// The last refused link and when. macOS delivers one open through both
    /// the deep-link plugin and the run loop; the second delivery is the same
    /// open, not a second refusal to explain.
    last: Option<(String, Instant)>,
}

/// Enough for every refusal a burst of links can produce, bounded so a broken
/// sender cannot grow the buffer without limit.
const MAX_DEEP_LINK_REFUSALS: usize = 8;

/// How long the same link counts as the same open.
const SAME_OPEN_WINDOW: Duration = Duration::from_secs(2);

impl DeepLinkRefusals {
    fn record(&self, reason: String, source_url: &str) {
        self.record_at(reason, source_url, Instant::now());
    }

    fn record_at(&self, reason: String, source_url: &str, now: Instant) {
        let mut buffer = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((last, at)) = &buffer.last {
            if last == source_url && now.saturating_duration_since(*at) < SAME_OPEN_WINDOW {
                return;
            }
        }
        buffer.last = Some((source_url.to_string(), now));
        buffer.reasons.push_back(reason);
        while buffer.reasons.len() > MAX_DEEP_LINK_REFUSALS {
            buffer.reasons.pop_front();
        }
    }

    fn take(&self) -> Vec<String> {
        let mut buffer = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        buffer.reasons.drain(..).collect()
    }
}

/// Records a refusal of `source_url` and wakes the frontend with a
/// payload-free event.
pub(crate) fn record_deeplink_refusal(
    app: &tauri::AppHandle,
    reason: impl Into<String>,
    source_url: &str,
) {
    app.state::<DeepLinkRefusals>()
        .record(reason.into(), source_url);
    if let Err(failed) = app.emit("deeplink-error", ()) {
        log::error!("✗ Failed to emit deeplink-error event: {failed}");
    }
}

/// Reason codes of the refusals the frontend has not shown yet, oldest first.
#[tauri::command]
pub fn take_deeplink_refusals(state: State<'_, DeepLinkRefusals>) -> Vec<String> {
    state.take()
}

impl PendingDeepLinks {
    /// Errors use the same codes as links opened from the system
    /// (`record_deeplink_refusal`), so the frontend explains both alike.
    fn submit_url(&self, url: &str) -> Result<(), String> {
        let url = url.trim();
        let request = parse_deeplink_url(url).map_err(|_| "DEEP_LINK_PARSE_FAILED".to_string())?;
        crate::deeplink::ensure_targets_allowed(&request)
            .map_err(|_| "DEEP_LINK_TARGET_UNAVAILABLE".to_string())?;
        self.enqueue(url, request)
    }

    fn enqueue(&self, source_url: &str, request: DeepLinkImportRequest) -> Result<(), String> {
        let mut queue = self.0.lock().map_err(|_| "DEEP_LINK_QUEUE_UNAVAILABLE")?;
        // macOS can deliver one open through both plugin and RunEvent paths.
        if queue.iter().any(|pending| pending.source_url == source_url) {
            return Ok(());
        }
        if queue.len() >= 16 {
            return Err("DEEP_LINK_QUEUE_FULL".to_string());
        }
        queue.push_back(PendingDeepLink {
            id: uuid::Uuid::new_v4().to_string(),
            request,
            source_url: source_url.to_string(),
        });
        Ok(())
    }

    fn peek(&self) -> Result<Option<PendingDeepLink>, String> {
        let queue = self.0.lock().map_err(|_| "DEEP_LINK_QUEUE_UNAVAILABLE")?;
        Ok(queue.front().cloned())
    }

    fn dismiss(&self, id: &str) -> Result<(), String> {
        let mut queue = self.0.lock().map_err(|_| "DEEP_LINK_QUEUE_UNAVAILABLE")?;
        queue.retain(|pending| pending.id != id);
        Ok(())
    }
}

pub(crate) fn queue_deeplink(
    app: &tauri::AppHandle,
    source_url: &str,
    request: DeepLinkImportRequest,
) -> Result<(), String> {
    app.state::<PendingDeepLinks>().enqueue(source_url, request)
}

#[tauri::command]
pub fn get_pending_deeplink(
    state: State<'_, PendingDeepLinks>,
) -> Result<Option<PendingDeepLink>, String> {
    state.peek()
}

#[tauri::command]
pub fn dismiss_pending_deeplink(
    state: State<'_, PendingDeepLinks>,
    id: String,
) -> Result<(), String> {
    state.dismiss(&id)
}

/// Manual paste follows the same durable-in-memory confirmation queue as OS links.
/// This command never imports or activates a resource.
#[tauri::command]
pub fn submit_deeplink_import(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.state::<PendingDeepLinks>().submit_url(&url)?;
    app.emit("deeplink-import", ())
        .map_err(|_| "IMPORT_NOTIFICATION_FAILED".to_string())
}

/// Parse a deep link URL and return the parsed request for frontend confirmation
#[tauri::command]
pub fn parse_deeplink(url: String) -> Result<DeepLinkImportRequest, String> {
    log::info!("Parsing deep link URL: {}", crate::url_for_log(&url));
    parse_deeplink_url(&url).map_err(|e| e.to_string())
}

/// Merge configuration from Base64/URL into a deep link request
/// This is used by the frontend to show the complete configuration in the confirmation dialog
#[tauri::command]
pub fn merge_deeplink_config(
    request: DeepLinkImportRequest,
) -> Result<DeepLinkImportRequest, String> {
    log::info!("Merging config for deep link request: {:?}", request.name);
    crate::deeplink::parse_and_merge_config(&request).map_err(|e| e.to_string())
}

/// What confirming this request stores and writes: full content, absolute
/// target paths, whether live files change now, and env-key verdicts (MH-4).
#[tauri::command]
pub fn preview_deeplink_import(
    request: DeepLinkImportRequest,
) -> Result<crate::deeplink::DeepLinkImportPreview, String> {
    crate::deeplink::preview_deeplink_import(&request).map_err(|e| e.to_string())
}

/// Import a provider from a deep link request (legacy, kept for compatibility)
#[tauri::command]
pub async fn import_from_deeplink(
    state: State<'_, AppState>,
    request: DeepLinkImportRequest,
) -> Result<String, String> {
    log::info!(
        "Importing provider from deep link: {:?} for app {:?}",
        request.name,
        request.app
    );
    crate::deeplink::ensure_targets_allowed(&request).map_err(|e| e.to_string())?;

    let state = state.inner().clone();
    let provider_id = import_provider_from_deeplink(&state, request)
        .await
        .map_err(|e| e.to_string())?;

    log::info!("Successfully imported provider with ID: {provider_id}");

    Ok(provider_id)
}

/// Import resource from a deep link request (unified handler)
#[tauri::command]
pub async fn import_from_deeplink_unified(
    state: State<'_, AppState>,
    request: DeepLinkImportRequest,
) -> Result<serde_json::Value, String> {
    log::info!("Importing {} resource from deep link", request.resource);
    crate::deeplink::ensure_targets_allowed(&request).map_err(|e| e.to_string())?;

    match request.resource.as_str() {
        "provider" => {
            let state = state.inner().clone();
            let provider_id = import_provider_from_deeplink(&state, request)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({
                "type": "provider",
                "id": provider_id
            }))
        }
        "prompt" => {
            let prompt_id =
                import_prompt_from_deeplink(&state, request).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({
                "type": "prompt",
                "id": prompt_id
            }))
        }
        "mcp" => {
            let result = import_mcp_from_deeplink(&state, request).map_err(|e| e.to_string())?;
            // Add type field to the result
            Ok(serde_json::json!({
                "type": "mcp",
                "importedCount": result.imported_count,
                "importedIds": result.imported_ids,
                "failed": result.failed
            }))
        }
        "skill" => {
            let skill_key =
                import_skill_from_deeplink(&state, request).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({
                "type": "skill",
                "key": skill_key
            }))
        }
        _ => Err(format!("Unsupported resource type: {}", request.resource)),
    }
}

#[cfg(test)]
mod pending_tests {
    use super::*;

    fn request(name: &str) -> DeepLinkImportRequest {
        DeepLinkImportRequest {
            resource: "provider".to_string(),
            name: Some(name.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn manual_submission_validates_and_queues_without_importing() {
        let queue = PendingDeepLinks::default();
        let url = "chimera://v1/import?resource=provider&app=codex&name=Manual&apiKey=secret";
        queue.submit_url(&format!("  {url}  ")).unwrap();
        queue.submit_url(url).unwrap();
        assert_eq!(queue.0.lock().unwrap().len(), 1);
        let pending = queue.peek().unwrap().unwrap();
        assert_eq!(pending.request.name.as_deref(), Some("Manual"));
        assert_eq!(pending.request.api_key.as_deref(), Some("secret"));
        assert_eq!(pending.source_url, url);
    }

    #[test]
    fn cold_start_reads_and_duplicate_notifications_keep_one_request_until_ack() {
        let queue = PendingDeepLinks::default();
        let url = "ccswitch://v1/import?apiKey=secret";
        queue.enqueue(url, request("first")).unwrap();
        let first = queue.peek().unwrap().unwrap();
        queue.enqueue(url, request("duplicate delivery")).unwrap();
        assert_eq!(queue.peek().unwrap().unwrap().id, first.id);
        assert_eq!(queue.0.lock().unwrap().len(), 1);
        let wire = serde_json::to_value(&first).unwrap();
        assert!(wire.get("source_url").is_none());
        assert!(!wire.to_string().contains(url));
        queue.dismiss(&first.id).unwrap();
        assert!(queue.peek().unwrap().is_none());
    }

    #[test]
    fn acknowledgement_is_idempotent_and_does_not_consume_the_next_request() {
        let queue = PendingDeepLinks::default();
        queue.enqueue("first", request("first")).unwrap();
        queue.enqueue("second", request("second")).unwrap();
        let first = queue.peek().unwrap().unwrap();
        queue.dismiss("unknown").unwrap();
        assert_eq!(queue.peek().unwrap().unwrap().id, first.id);
        queue.dismiss(&first.id).unwrap();
        queue.dismiss(&first.id).unwrap();
        assert_eq!(
            queue.peek().unwrap().unwrap().request.name.as_deref(),
            Some("second")
        );
        queue
            .enqueue("first", request("intentional reopen"))
            .unwrap();
        assert_eq!(queue.0.lock().unwrap().len(), 2);
    }

    #[test]
    fn overflow_rejects_new_requests_without_evicting_a_pending_confirmation() {
        let queue = PendingDeepLinks::default();
        for index in 0..16 {
            queue
                .enqueue(&index.to_string(), request("queued"))
                .unwrap();
        }
        let first_id = queue.peek().unwrap().unwrap().id;
        assert!(queue.enqueue("0", request("duplicate")).is_ok());
        assert_eq!(
            queue.enqueue("overflow", request("overflow")),
            Err("DEEP_LINK_QUEUE_FULL".to_string())
        );
        assert_eq!(queue.peek().unwrap().unwrap().id, first_id);
        assert_eq!(queue.0.lock().unwrap().len(), 16);
    }

    #[test]
    fn manual_submission_reports_the_codes_system_links_use() {
        let queue = PendingDeepLinks::default();
        assert_eq!(
            queue.submit_url("not an import link"),
            Err("DEEP_LINK_PARSE_FAILED".to_string())
        );
        assert!(queue.peek().unwrap().is_none());
    }

    #[test]
    fn refusals_wait_for_one_reader_and_keep_the_newest() {
        let refusals = DeepLinkRefusals::default();
        assert!(refusals.take().is_empty());
        refusals.record("DEEP_LINK_PARSE_FAILED".to_string(), "chimera://bad");
        assert_eq!(refusals.take(), vec!["DEEP_LINK_PARSE_FAILED".to_string()]);
        // Drained on read: a second reader has nothing to show again.
        assert!(refusals.take().is_empty());

        for index in 0..MAX_DEEP_LINK_REFUSALS + 3 {
            refusals.record(format!("E{index}"), &format!("chimera://{index}"));
        }
        let kept = refusals.take();
        assert_eq!(kept.len(), MAX_DEEP_LINK_REFUSALS);
        assert_eq!(kept[0], "E3");
        assert_eq!(
            kept.last().unwrap(),
            &format!("E{}", MAX_DEEP_LINK_REFUSALS + 2)
        );
    }

    #[test]
    fn one_open_delivered_twice_is_explained_once() {
        let refusals = DeepLinkRefusals::default();
        let start = Instant::now();
        let reason = || "DEEP_LINK_PARSE_FAILED".to_string();
        refusals.record_at(reason(), "chimera://bad", start);
        // macOS: the plugin and the run loop both deliver the same open.
        refusals.record_at(reason(), "chimera://bad", start + Duration::from_millis(50));
        assert_eq!(refusals.take().len(), 1);
        // A different link, or the same one opened again later, is new.
        refusals.record_at(
            reason(),
            "chimera://other",
            start + Duration::from_millis(60),
        );
        refusals.record_at(reason(), "chimera://other", start + SAME_OPEN_WINDOW * 2);
        assert_eq!(refusals.take().len(), 2);
    }
}
