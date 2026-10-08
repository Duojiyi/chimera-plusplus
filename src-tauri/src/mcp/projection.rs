//! Ownership-checked projections for non-Codex clients. Codex retains its own ledger.
use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::app_config::AppType;
use crate::config::cas::{AppliedChangeset, Changeset, FileSnapshot};
use crate::database::Database;
use crate::error::AppError;

pub(crate) const LEDGER_KEY: &str = "mcp_client_projection_ledger";
type Ledger = BTreeMap<String, BTreeMap<String, String>>;

#[cfg(test)]
thread_local! {
    pub(crate) static TEST_TARGETS: std::cell::RefCell<Option<std::collections::HashMap<AppType, PathBuf>>> = const { std::cell::RefCell::new(None) };
}

fn target(app: &AppType) -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(target) =
        TEST_TARGETS.with(|paths| paths.borrow().as_ref().map(|paths| paths.get(app).cloned()))
    {
        return target;
    }
    match app {
        AppType::Claude
            if crate::config::get_claude_config_dir().exists()
                || crate::config::get_claude_mcp_path().exists() =>
        {
            Some(crate::config::get_claude_mcp_path())
        }
        AppType::Gemini if crate::gemini_config::get_gemini_dir().exists() => {
            Some(crate::gemini_config::get_gemini_settings_path())
        }
        AppType::GrokBuild if crate::grok_config::get_grok_config_dir().exists() => {
            Some(crate::grok_config::get_grok_config_path())
        }
        AppType::OpenCode if crate::opencode_config::get_opencode_dir().exists() => {
            Some(crate::opencode_config::get_opencode_config_path())
        }

        _ => None,
    }
}

fn hash(value: &Value) -> String {
    // Writers/parsers can reorder object keys (serde_json preserves insertion
    // order). Ownership must depend on content, while retaining array order.
    let mut canonical = value.clone();
    canonical.sort_all_objects();
    format!("{:x}", Sha256::digest(canonical.to_string().as_bytes()))
}

fn invalid() -> AppError {
    // Parser diagnostics may contain a credential from the document.
    AppError::McpValidation("Invalid MCP client configuration".into())
}

/// An enabled=false spec belongs to Codex only, never to another client.
fn client_spec(spec: &Value) -> Value {
    let mut spec = spec.clone();
    if let Some(obj) = spec.as_object_mut() {
        obj.remove("enabled");
    }
    spec
}

fn projected_spec(app: &AppType, spec: &Value) -> Result<Value, AppError> {
    let spec = client_spec(spec);
    match app {
        AppType::OpenCode => super::opencode::convert_to_opencode_format(&spec),

        AppType::GrokBuild => {
            let mut doc = toml_edit::DocumentMut::new();
            doc["server"] = toml_edit::Item::Table(
                super::grokbuild::json_server_to_grokbuild_toml_table(&spec)?,
            );
            let value: toml::Value = toml::from_str(&doc.to_string()).map_err(|_| invalid())?;
            serde_json::to_value(&value["server"]).map_err(|_| invalid())
        }
        _ => Ok(spec),
    }
}

/// All decisions use the same snapshot that is later passed to CAS.
fn plan_with_previous(
    app: &AppType,
    snapshot: FileSnapshot,
    id: &str,
    spec: Option<&Value>,
    owned: &mut BTreeMap<String, String>,
    previous: Option<&Value>,
) -> Result<Option<AppliedChangeset>, AppError> {
    let text =
        std::str::from_utf8(snapshot.contents().unwrap_or_default()).map_err(|_| invalid())?;
    let key = match app {
        AppType::GrokBuild => "mcp_servers",
        AppType::OpenCode => "mcp",
        _ => "mcpServers",
    };
    let mut toml_doc = None;
    let mut root: Value = if text.trim().is_empty() {
        serde_json::json!({})
    } else {
        match app {
            AppType::GrokBuild => {
                toml_doc = Some(
                    text.parse::<toml_edit::DocumentMut>()
                        .map_err(|_| invalid())?,
                );
                let value: toml::Value = toml::from_str(text).map_err(|_| invalid())?;
                serde_json::to_value(value).map_err(|_| invalid())?
            }

            AppType::OpenCode => json5::from_str(text).map_err(|_| invalid())?,
            _ => serde_json::from_str(text).map_err(|_| invalid())?,
        }
    };
    let root_obj = root.as_object_mut().ok_or_else(invalid)?;
    let entries = root_obj
        .entry(key)
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(invalid)?;
    let live = entries.get(id);
    let desired = spec.map(|spec| projected_spec(app, spec)).transpose()?;
    let live_hash = live.map(hash);
    let recorded = owned.get(id);
    let legacy_match = if recorded.is_none() && live.is_some() {
        previous
            .map(|spec| projected_spec(app, spec))
            .transpose()?
            .as_ref()
            == live
    } else {
        false
    };
    let matches_owner = (recorded.is_some() && recorded == live_hash.as_ref()) || legacy_match;
    if live.is_some() && !matches_owner {
        if desired.is_none() && recorded.is_none() && previous.is_none() {
            return Ok(None); // Never managed here: a disabled DB row grants no ownership.
        }
        if desired.as_ref() != live {
            return Err(AppError::McpValidation(format!(
                "{} MCP '{id}' has an ownership conflict",
                app.as_str()
            )));
        }
    }
    if desired.as_ref() == live {
        if let Some(value) = desired {
            owned.insert(id.into(), hash(&value));
        } else {
            owned.remove(id);
        }
        return Ok(None);
    }
    if let Some(value) = &desired {
        entries.insert(id.into(), value.clone());
    } else {
        entries.remove(id);
    }
    let bytes = match app {
        AppType::GrokBuild => {
            let mut doc = toml_doc.unwrap_or_default();
            if let Some(spec) = spec {
                if !doc.contains_key(key) {
                    doc[key] = toml_edit::table();
                }
                doc[key][id] = toml_edit::Item::Table(
                    super::grokbuild::json_server_to_grokbuild_toml_table(&client_spec(spec))?,
                );
            } else if let Some(table) = doc
                .get_mut(key)
                .and_then(toml_edit::Item::as_table_like_mut)
            {
                table.remove(id);
            }
            doc.to_string().into_bytes()
        }

        _ => crate::config::json_file_text(&root)?.into_bytes(),
    };
    let mut changes = Changeset::new();
    changes.write(snapshot, bytes)?;
    let applied = changes.commit()?;
    if let Some(value) = desired {
        owned.insert(id.into(), hash(&value));
    } else {
        owned.remove(id);
    }
    Ok(Some(applied))
}

pub(crate) fn project(
    db: &Database,
    app: &AppType,
    id: &str,
    spec: Option<&Value>,
    journal: &mut Vec<AppliedChangeset>,
    previous: Option<&Value>,
) -> Result<(), AppError> {
    let Some(path) = target(app) else {
        return Ok(());
    };
    let mut ledger: Ledger = db
        .get_setting(LEDGER_KEY)?
        .map(|raw| serde_json::from_str(&raw))
        .transpose()
        .map_err(|_| AppError::McpValidation("Invalid MCP ownership ledger".into()))?
        .unwrap_or_default();
    let owner = ledger
        .entry(format!("{}:{}", app.as_str(), path.display()))
        .or_default();
    if let Some(applied) =
        plan_with_previous(app, FileSnapshot::read(path)?, id, spec, owner, previous)?
    {
        journal.push(applied);
    }
    db.set_setting(
        LEDGER_KEY,
        &serde_json::to_string(&ledger).map_err(|source| AppError::JsonSerialize { source })?,
    )
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
