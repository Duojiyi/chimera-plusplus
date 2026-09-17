//! MCP server import from deep link
//!
//! Handles batch import of MCP server configurations via ccswitch:// URLs.

use super::utils::decode_base64_param;
use super::DeepLinkImportRequest;
use crate::app_config::{McpApps, McpServer};
use crate::error::AppError;
use crate::mcp::validation::{validate_server_id, validate_server_spec, MAX_MCP_SERVERS};
use crate::services::McpService;
use crate::store::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// MCP import result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpImportResult {
    /// Number of successfully imported MCP servers
    pub imported_count: usize,
    /// IDs of successfully imported MCP servers
    pub imported_ids: Vec<String>,
    /// Failed imports with error messages
    pub failed: Vec<McpImportError>,
}

/// MCP import error
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpImportError {
    /// MCP server ID
    pub id: String,
    /// Error message
    pub error: String,
}

/// Import MCP servers from deep link request
///
/// This function handles batch import of MCP servers from standard MCP JSON format.
/// If a server already exists, only the apps flags are merged (existing config preserved).
pub fn import_mcp_from_deeplink(
    state: &AppState,
    request: DeepLinkImportRequest,
) -> Result<McpImportResult, AppError> {
    // Verify this is an MCP request
    if request.resource != "mcp" {
        return Err(AppError::InvalidInput(format!(
            "Expected mcp resource, got '{}'",
            request.resource
        )));
    }

    // Extract and validate apps parameter
    let apps_str = request
        .apps
        .as_ref()
        .ok_or_else(|| AppError::InvalidInput("Missing 'apps' parameter for MCP".to_string()))?;

    // Parse apps into McpApps struct
    let _target_apps = parse_mcp_apps(apps_str)?;

    // Extract config
    let config_b64 = request
        .config
        .as_ref()
        .ok_or_else(|| AppError::InvalidInput("Missing 'config' parameter for MCP".to_string()))?;

    // Decode Base64 config
    let decoded = decode_base64_param("config", config_b64)?;

    let config_str = String::from_utf8(decoded)
        .map_err(|e| AppError::InvalidInput(format!("Invalid UTF-8 in config: {e}")))?;

    // Parse JSON
    let config_json: Value = serde_json::from_str(&config_str)
        .map_err(|e| AppError::InvalidInput(format!("Invalid JSON in MCP config: {e}")))?;

    // Extract mcpServers object
    let mcp_servers = config_json
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .ok_or_else(|| {
            AppError::InvalidInput("MCP config must contain 'mcpServers' object".to_string())
        })?;

    if mcp_servers.is_empty() {
        return Err(AppError::InvalidInput(
            "No MCP servers found in config".to_string(),
        ));
    }
    if mcp_servers.len() > MAX_MCP_SERVERS {
        return Err(AppError::InvalidInput(format!(
            "Too many MCP servers (maximum {MAX_MCP_SERVERS})"
        )));
    }

    // Get existing servers to check for duplicates and preserve the historical
    // deep-link semantics: an existing server keeps its connection definition;
    // only the target apps are merged.
    let existing_servers = state.db.get_all_mcp_servers()?;
    let mut planned_servers = Vec::with_capacity(mcp_servers.len());
    let mut failed = Vec::new();

    // Preflight every entry before touching the database. A malformed server
    // must not allow the valid entries in the same deep link to be committed.
    for (id, server_spec) in mcp_servers.iter() {
        let mut validation_errors = Vec::new();
        if let Err(error) = validate_server_id(id) {
            validation_errors.push(error.to_string());
        }
        if let Err(error) = validate_server_spec(server_spec) {
            validation_errors.push(error.to_string());
        }
        if !validation_errors.is_empty() {
            failed.push(McpImportError {
                id: id.clone(),
                error: validation_errors.join("; "),
            });
            continue;
        }

        let server = if let Some(existing) = existing_servers.get(id) {
            log::info!("MCP server '{id}' already exists, merging apps only");
            McpServer {
                id: existing.id.clone(),
                name: existing.name.clone(),
                server: existing.server.clone(),
                // Never widen an existing server app projection from an
                // untrusted deep link. The user must opt in from MCP settings.
                apps: existing.apps.clone(),
                description: existing.description.clone(),
                homepage: existing.homepage.clone(),
                docs: existing.docs.clone(),
                tags: existing.tags.clone(),
            }
        } else {
            log::info!("Creating new MCP server: {id}");
            McpServer {
                id: id.clone(),
                name: id.clone(),
                server: server_spec.clone(),
                // MCP stdio definitions execute host commands. Import as inert
                // configuration; explicit user enablement controls projection.
                apps: McpApps::default(),
                description: None,
                homepage: None,
                docs: None,
                tags: vec!["imported".to_string()],
            }
        };
        planned_servers.push(server);
    }

    if !failed.is_empty() {
        return Ok(McpImportResult {
            imported_count: 0,
            imported_ids: Vec::new(),
            failed,
        });
    }

    // Commit the whole batch with compensating rollback for both the database
    // and affected live projections.
    McpService::upsert_servers_atomic(state, &planned_servers)?;
    let imported_ids = planned_servers
        .iter()
        .map(|server| server.id.clone())
        .collect::<Vec<_>>();

    Ok(McpImportResult {
        imported_count: imported_ids.len(),
        imported_ids,
        failed,
    })
}

/// Parse apps string into McpApps struct
pub(crate) fn parse_mcp_apps(apps_str: &str) -> Result<McpApps, AppError> {
    let mut apps = McpApps {
        claude: false,
        codex: false,
        gemini: false,
        grokbuild: false,
        opencode: false,
        hermes: false,
    };

    for app in apps_str.split(',') {
        match app.trim() {
            "claude" => apps.claude = true,
            "codex" => apps.codex = true,
            "gemini" => apps.gemini = true,
            "grokbuild" | "grok" => apps.grokbuild = true,
            "opencode" => apps.opencode = true,
            "openclaw" => {
                // OpenClaw doesn't support MCP, ignore silently
                log::debug!("OpenClaw doesn't support MCP, ignoring in apps parameter");
            }
            "hermes" => apps.hermes = true,
            other => {
                return Err(AppError::InvalidInput(format!(
                    "Invalid app in 'apps': {other}"
                )))
            }
        }
    }

    if apps.is_empty() {
        return Err(AppError::InvalidInput(
            "At least one app must be specified in 'apps'".to_string(),
        ));
    }

    Ok(apps)
}

#[cfg(test)]
mod tests {}
