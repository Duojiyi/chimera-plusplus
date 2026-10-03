//! Prompt import from deep link
//!
//! Handles importing prompt configurations via ccswitch:// URLs.

use super::utils::decode_base64_param;
use super::DeepLinkImportRequest;
use crate::error::AppError;
use crate::prompt::Prompt;
use crate::store::AppState;
use crate::AppType;
use std::str::FromStr;

/// Import a prompt from deep link request
pub fn import_prompt_from_deeplink(
    state: &AppState,
    request: DeepLinkImportRequest,
) -> Result<String, AppError> {
    // Verify this is a prompt request
    if request.resource != "prompt" {
        return Err(AppError::InvalidInput(format!(
            "Expected prompt resource, got '{}'",
            request.resource
        )));
    }

    // Extract required fields
    let app_str = request
        .app
        .as_ref()
        .ok_or_else(|| AppError::InvalidInput("Missing 'app' field for prompt".to_string()))?;

    let name = request
        .name
        .ok_or_else(|| AppError::InvalidInput("Missing 'name' field for prompt".to_string()))?;

    // Parse app type
    let app_type = AppType::from_str(app_str)
        .map_err(|_| AppError::InvalidInput(format!("Invalid app type: {app_str}")))?;

    // Decode content
    let content_b64 = request
        .content
        .as_ref()
        .ok_or_else(|| AppError::InvalidInput("Missing 'content' field for prompt".to_string()))?;

    let content = decode_base64_param("content", content_b64)?;
    let content = String::from_utf8(content)
        .map_err(|e| AppError::InvalidInput(format!("Invalid UTF-8 in content: {e}")))?;

    // Generate ID
    let timestamp = chrono::Utc::now().timestamp_millis();
    let sanitized_name = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>()
        .to_lowercase();
    let id = format!("{sanitized_name}-{timestamp}");

    // MH-4: a deep-linked prompt is always stored disabled, whatever the
    // link's `enabled` says, and nothing outside the database is touched.
    // `PromptService::upsert_prompt` is deliberately not used: with no other
    // prompt enabled it truncates the tool's live prompt file (AGENTS.md,
    // CLAUDE.md, ...), which would let a link wipe a hand-written file.
    if request.enabled == Some(true) {
        log::info!("Ignoring enabled=true on prompt deep link; prompts import disabled");
    }
    let prompt = Prompt {
        template_id: None,
        id: id.clone(),
        name: name.clone(),
        content,
        description: request.description,
        enabled: false,
        created_at: Some(timestamp),
        updated_at: Some(timestamp),
    };
    state.db.save_prompt(app_type.as_str(), &prompt)?;
    log::info!("Imported prompt '{name}' for {app_str} (disabled)");

    Ok(id)
}
