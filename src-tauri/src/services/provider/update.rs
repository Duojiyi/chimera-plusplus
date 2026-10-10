//! Compensated updates for tools without automatic routing.
use super::{LiveSnapshot, ProviderService};
use crate::app_config::AppType;
use crate::config::cas::FileSnapshot;
use crate::error::AppError;
use crate::provider::Provider;
use crate::store::AppState;

impl ProviderService {
    /// Caller owns the app switch lock (and, at IPC, profile -> lifecycle).
    pub(crate) fn update_direct_with_app_lock_held(
        state: &AppState,
        app: AppType,
        original_id: Option<&str>,
        provider: Provider,
        activate: bool,
    ) -> Result<bool, AppError> {
        let original_id = original_id.unwrap_or(&provider.id).to_owned();
        let updated_id = provider.id.clone();
        let omo = matches!(provider.category.as_deref(), Some("omo" | "omo-slim"));
        with_update_rollback(state, &app, &original_id, &updated_id, omo, || {
            Self::update_internal(state, app.clone(), Some(&original_id), provider, true)?;
            if activate
                && (app.is_additive_mode()
                    || crate::settings::get_effective_current_provider(&state.db, &app)?.as_deref()
                        != Some(updated_id.as_str()))
            {
                Self::switch_with_app_lock_held(state, app.clone(), &updated_id)?;
            }
            Ok(true)
        })
    }
}

pub(super) fn with_update_rollback(
    state: &AppState,
    app: &AppType,
    original_id: &str,
    updated_id: &str,
    omo: bool,
    operation: impl FnOnce() -> Result<bool, AppError>,
) -> Result<bool, AppError> {
    let previous = state.db.get_provider_by_id(original_id, app.as_str())?;
    // Never delete another provider when a rename is rejected.
    if original_id != updated_id
        && state
            .db
            .get_provider_by_id(updated_id, app.as_str())?
            .is_some()
    {
        return Err(AppError::InvalidInput(format!(
            "Provider '{updated_id}' already exists"
        )));
    }
    let local = crate::settings::get_current_provider(app);
    let selection = state.db.snapshot_provider_update_selection(app.as_str())?;
    let effective = crate::settings::get_effective_current_provider(&state.db, app)?;
    let active = effective
        .as_deref()
        .filter(|id| *id != original_id)
        .map(|id| state.db.get_provider_by_id(id, app.as_str()))
        .transpose()?
        .flatten();
    let common = [
        format!("common_config_{}", app.as_str()),
        format!("common_config_{}_cleared", app.as_str()),
    ]
    .into_iter()
    .map(|key| state.db.get_setting(&key).map(|value| (key, value)))
    .collect::<Result<Vec<_>, _>>()?;
    let desktop = if matches!(app, AppType::ClaudeDesktop) {
        LiveSnapshot::capture(app)?
    } else {
        None
    };
    // Pi already compensates native edits with expected-value CAS. A second
    // whole-file restore would overwrite external changes rejected by that CAS.
    let mut paths = if matches!(app, AppType::Pi) || desktop.is_some() {
        Vec::new()
    } else {
        crate::services::live_backup::live_files(app)?
    };
    if matches!(app, AppType::OpenCode)
        && (omo
            || previous
                .as_ref()
                .is_some_and(|p| matches!(p.category.as_deref(), Some("omo" | "omo-slim"))))
    {
        let dir = crate::opencode_config::get_opencode_dir();
        for variant in [&crate::services::omo::STANDARD, &crate::services::omo::SLIM] {
            paths.extend(variant.config_candidates.iter().map(|name| dir.join(name)));
        }
        let unified = crate::config::get_home_dir().join(".omo");
        paths.extend([unified.join("omo.jsonc"), unified.join("omo.json")]);
    }
    let files = paths
        .into_iter()
        .map(FileSnapshot::read)
        .collect::<Result<Vec<_>, _>>()?;
    let error = match operation() {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    let mut errors = Vec::new();
    let mut record = |result: Result<(), AppError>| {
        if let Err(error) = result {
            errors.push(error.to_string());
        }
    };
    // Do not delete/reinsert existing rows: that cascades endpoints and failover state.
    if previous.is_none() || original_id != updated_id {
        record(state.db.delete_provider(app.as_str(), updated_id));
    }
    if let Some(previous) = previous.as_ref() {
        record(restore_provider(state, app, previous));
    }
    if let Some(active) = active.as_ref() {
        record(restore_provider(state, app, active));
    }
    record(
        state
            .db
            .restore_provider_update_selection(app.as_str(), &selection),
    );
    if crate::settings::get_current_provider(app) != local {
        record(crate::settings::set_current_provider(app, local.as_deref()));
    }
    for (key, value) in common {
        record((|| {
            if state.db.get_setting(&key)? == value {
                return Ok(());
            }
            match value.as_deref() {
                Some(value) => state.db.set_setting(&key, value),
                None => state.db.delete_setting(&key),
            }
        })());
    }
    if let Some(desktop) = desktop {
        record(desktop.restore());
    }
    record(verify_unreceipted_files(&files));
    if errors.is_empty() {
        Err(error)
    } else {
        Err(AppError::Message(format!(
            "{error}；更新供应商回滚失败: {}",
            errors.join("；")
        )))
    }
}

fn restore_provider(state: &AppState, app: &AppType, before: &Provider) -> Result<(), AppError> {
    let now = state.db.get_provider_by_id(&before.id, app.as_str())?;
    let now = serde_json::to_value(now).map_err(|source| AppError::JsonSerialize { source })?;
    let expected =
        serde_json::to_value(before).map_err(|source| AppError::JsonSerialize { source })?;
    if now == expected {
        return Ok(());
    }
    state.db.save_provider(app.as_str(), before)
}

// An app lock excludes our writers, not external editors. Without our own write
// receipt, neither a changed file nor a post-failure read authorizes restoration.
pub(super) fn verify_unreceipted_files(files: &[FileSnapshot]) -> Result<(), AppError> {
    let mut conflicts = Vec::new();
    for before in files {
        match FileSnapshot::read(before.path()) {
            Ok(after) if before.state() == after.state() => {}
            Ok(_) => conflicts.push(before.path().display().to_string()),
            Err(error) => conflicts.push(format!("{}: {error}", before.path().display())),
        }
    }
    if conflicts.is_empty() {
        Ok(())
    } else {
        Err(AppError::Message(format!(
            "Live 回滚冲突：缺少本次写入凭据，已保留当前文件，请检查配置: {}",
            conflicts.join("；")
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreceipted_rollback_preserves_external_edits_creations_and_deletions() {
        for change in ["edit", "create", "delete", "unchanged"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("live.json");
            if change != "create" {
                std::fs::write(&path, b"before").unwrap();
            }
            let before = FileSnapshot::read(&path).unwrap();
            match change {
                "edit" | "create" => std::fs::write(&path, b"external-secret").unwrap(),
                "delete" => std::fs::remove_file(&path).unwrap(),
                _ => {}
            }
            let current = std::fs::read(&path).ok();
            let result = verify_unreceipted_files(&[before]);
            if change == "unchanged" {
                result.unwrap();
            } else {
                let error = result.unwrap_err().to_string();
                assert!(error.contains("Live 回滚冲突"), "{error}");
                assert!(!error.contains("external-secret"));
            }
            assert_eq!(std::fs::read(&path).ok(), current);
        }
    }
}
