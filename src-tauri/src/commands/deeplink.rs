use crate::deeplink::{
    import_mcp_from_deeplink, import_prompt_from_deeplink, import_provider_from_deeplink,
    import_skill_from_deeplink, parse_deeplink_url, DeepLinkImportRequest,
};
use crate::store::AppState;
use std::collections::VecDeque;
use std::sync::Mutex;
use tauri::{Manager, State};

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

impl PendingDeepLinks {
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
}
