//! First-switch protection (plan §2 M2.1).
//!
//! Several tool writers replace the whole live file (the Claude writer
//! rewrites `~/.claude/settings.json` wholesale). Before Chimera++ writes a
//! tool's live config for the first time it:
//!
//! 1. backs up the live files (`services::live_backup`, reason `firstWrite`);
//! 2. when no line owns the file yet, adopts it: the file becomes a line
//!    named `default` (as cc-switch's first-run import does), so switching
//!    back gives the user their original config;
//! 3. moves the keys that survive switches into the tool's common snippet
//!    and opts the line being written into it, so the first write keeps them.
//!
//! What survives is per tool ([`preservation`]); for the snippet tools it is
//! "everything except the provider-owned keys" as defined by cc-switch's
//! `extract_*_common_config` exclusion lists (endpoint, model mapping,
//! context windows and every credential-shaped key).

use serde_json::json;

use crate::app_config::AppType;
use crate::error::AppError;
use crate::provider::Provider;
use crate::services::live_backup::{self, LiveBackupReason};
use crate::store::AppState;

use super::{normalize_claude_models_in_value, read_live_settings, ProviderService};

/// Settings key recording that a tool's first live write was protected.
const MARKER_PREFIX: &str = "live_first_write_v1:";

/// How a tool's writer treats what is already in its live file, and so what
/// the first write has to carry over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FirstWritePreservation {
    /// The writer replaces the whole file (Claude `settings.json`, Gemini
    /// `.env`). Every key outside the provider-owned set moves into the
    /// common snippet, which the first written line uses.
    SharedSnippet,
    /// The writer replaces the whole file and the tool has no common snippet
    /// (Grok Build, as in cc-switch). The original survives as the adopted
    /// line and in the backup.
    AdoptOnly,
    /// The writer merges into the existing file (Claude Desktop's own
    /// profile + `deploymentMode`, Gemini `settings.json`, the additive
    /// tools). Nothing is lost; the backup is the only extra step.
    MergedByWriter,
    /// Codex: the L3 key-ownership projection keeps every key the line does
    /// not own, and startup already imports its live config.
    KeyOwnership,
}

pub(crate) fn preservation(app: &AppType) -> FirstWritePreservation {
    #[allow(unreachable_patterns)]
    match app {
        AppType::Claude | AppType::Gemini => FirstWritePreservation::SharedSnippet,
        AppType::GrokBuild => FirstWritePreservation::AdoptOnly,
        AppType::Codex => FirstWritePreservation::KeyOwnership,
        AppType::ClaudeDesktop | AppType::OpenCode => FirstWritePreservation::MergedByWriter,
        // Tools added later (additive by design) are backed up only.
        _ => FirstWritePreservation::MergedByWriter,
    }
}

fn marker_key(app: &AppType) -> String {
    format!("{MARKER_PREFIX}{}", app.as_str())
}

/// Takes the first-write backup once per tool. Returns `None` when this is
/// not the first write, otherwise whether a live file existed.
fn claim_first_write(state: &AppState, app: &AppType) -> Result<Option<bool>, AppError> {
    let key = marker_key(app);
    if state.db.get_setting(&key)?.is_some() {
        return Ok(None);
    }
    // Fail closed: never replace a live file that could not be backed up.
    let backup = live_backup::create_backup(&state.db, app, LiveBackupReason::FirstWrite)?;
    let marker = json!({
        "completedAt": chrono::Utc::now().to_rfc3339(),
        "backupId": backup.as_ref().map(|backup| backup.id.clone()),
    });
    state.db.set_setting(&key, &marker.to_string())?;
    Ok(Some(backup.is_some()))
}

/// Backup-only protection for writers that project an existing line (the
/// post-import sync): the line is already chosen, so nothing is adopted.
pub(crate) fn backup_before_first_live_write(
    state: &AppState,
    app: &AppType,
) -> Result<(), AppError> {
    if preservation(app) == FirstWritePreservation::KeyOwnership {
        return Ok(());
    }
    claim_first_write(state, app).map(|_| ())
}

/// Runs right before a switch or add writes `target` to the tool's live
/// config. Returns the provider to write: `target`, re-read and opted into
/// the common snippet when this first write created one.
pub(crate) fn protect_first_live_write(
    state: &AppState,
    app: &AppType,
    target: &Provider,
) -> Result<Provider, AppError> {
    let mode = preservation(app);
    if mode == FirstWritePreservation::KeyOwnership {
        return Ok(target.clone());
    }
    let had_live = match claim_first_write(state, app)? {
        None => return Ok(target.clone()),
        Some(had_live) => had_live,
    };
    let adopts = matches!(
        mode,
        FirstWritePreservation::SharedSnippet | FirstWritePreservation::AdoptOnly
    );
    // A line that is already current owns the file; switching away from it
    // backfills live into it, which is the normal protection.
    if !had_live
        || !adopts
        || crate::settings::get_effective_current_provider(&state.db, app)?.is_some()
    {
        return Ok(target.clone());
    }
    // The backup exists; adoption is best effort and never blocks the write.
    if let Err(error) = adopt_live(state, app, mode) {
        log::warn!(
            "首次写入 {} 前采纳现有 Live 配置失败（已备份）: {error}",
            app.as_str()
        );
    }
    if mode == FirstWritePreservation::SharedSnippet {
        return opt_into_snippet(state, app, target);
    }
    Ok(target.clone())
}

fn adopt_live(
    state: &AppState,
    app: &AppType,
    mode: FirstWritePreservation,
) -> Result<(), AppError> {
    // A taken-over file holds proxy placeholders, not the user's config.
    if state
        .proxy_service
        .detect_takeover_in_live_config_for_app(app)
    {
        return Ok(());
    }
    let mut live = read_live_settings(app.clone())?;
    match app {
        AppType::Claude => {
            normalize_claude_models_in_value(&mut live);
        }
        AppType::GrokBuild => crate::grok_config::strip_grok_mcp_servers_from_settings(&mut live)?,
        _ => {}
    }

    let providers = state.db.get_all_providers(app.as_str())?;
    if !providers
        .values()
        .any(|provider| provider.settings_config == live)
    {
        let mut id = "default".to_string();
        let mut name = "default".to_string();
        let mut counter = 2;
        while providers.contains_key(&id) {
            id = format!("default-{counter}");
            name = format!("default ({counter})");
            counter += 1;
        }
        let mut adopted = Provider::with_id(id, name, live.clone(), None);
        adopted.category = Some("custom".to_string());
        state.db.save_provider(app.as_str(), &adopted)?;
    }

    if mode == FirstWritePreservation::SharedSnippet
        && state.db.should_auto_extract_config_snippet(app.as_str())?
    {
        let snippet =
            ProviderService::extract_common_config_snippet_from_settings(app.clone(), &live)?;
        if snippet_has_content(&snippet) {
            state
                .db
                .set_config_snippet(app.as_str(), Some(snippet.clone()))?;
            // The adopted line contains the snippet: mark it as using it and
            // store it without the shared keys (legacy migration rules).
            ProviderService::migrate_legacy_common_config_usage(state, app.clone(), &snippet)?;
        }
    }
    Ok(())
}

fn snippet_has_content(snippet: &str) -> bool {
    let trimmed = snippet.trim();
    !trimmed.is_empty() && trimmed != "{}"
}

/// The first written line uses the snippet unless it already chose.
fn opt_into_snippet(
    state: &AppState,
    app: &AppType,
    target: &Provider,
) -> Result<Provider, AppError> {
    let mut target = state
        .db
        .get_provider_by_id(&target.id, app.as_str())?
        .unwrap_or_else(|| target.clone());
    let has_snippet = state
        .db
        .get_config_snippet(app.as_str())?
        .is_some_and(|snippet| snippet_has_content(&snippet));
    let undecided = target
        .meta
        .as_ref()
        .and_then(|meta| meta.common_config_enabled)
        .is_none();
    if has_snippet && undecided {
        target
            .meta
            .get_or_insert_with(Default::default)
            .common_config_enabled = Some(true);
        state.db.save_provider(app.as_str(), &target)?;
    }
    Ok(target)
}
