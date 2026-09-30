// Adapted from farion1231/cc-switch src-tauri/src/services/provider/mod.rs (MIT)
//! MiniMax Code providers (additive, D4): membership is a `custom_provider`
//! entry in `config.yaml`; there is no current provider.
//!
//! - Listing is read-only: native entries and membership are merged in
//!   memory, never written back to the database.
//! - Mutations commit the database row first and restore it when the native
//!   write fails (lock busy, selected default model, account provider).
//! - `delete_locked` / `enable_locked` run under the per-app switch lock their
//!   `ProviderService` callers already hold; every other entry takes it here.

use super::pi::{
    align_native_display_name, merge_native_config, native_provider_name,
    strip_unsupported_metadata,
};
use super::{ProviderService, SwitchResult};
use crate::app_config::AppType;
use crate::error::AppError;
use crate::provider::Provider;
use crate::store::AppState;
use indexmap::IndexMap;
use serde_json::Value;
use std::path::PathBuf;

const MCODE_APP: &str = "mcode";

fn lock(state: &AppState) -> tokio::sync::OwnedMutexGuard<()> {
    futures::executor::block_on(state.proxy_service.lock_switch_for_app(MCODE_APP))
}

fn imported(id: &str, config: &Value) -> Provider {
    let name = native_provider_name(config).unwrap_or(id).to_string();
    let mut provider = Provider::with_id(id.to_string(), name, config.clone(), None);
    provider.category = Some("custom".to_string());
    provider.icon = Some("minimax".to_string());
    provider
}

fn report_backup(backup: Option<PathBuf>) {
    if let Some(path) = backup {
        log::warn!(
            "MiniMax Code config comments could not all be kept; backup saved at {}",
            path.display()
        );
    }
}

/// Put `previous` back after a failed native write.
fn restore_row(state: &AppState, id: &str, previous: Option<&Provider>) -> Result<(), AppError> {
    match previous {
        Some(previous) => state.db.save_provider(MCODE_APP, previous),
        None => state.db.delete_provider(MCODE_APP, id),
    }
}

fn with_row_rollback(
    state: &AppState,
    id: &str,
    previous: Option<&Provider>,
    native: impl FnOnce() -> Result<Option<PathBuf>, AppError>,
) -> Result<(), AppError> {
    match native() {
        Ok(backup) => {
            report_backup(backup);
            Ok(())
        }
        Err(error) => {
            if let Err(rollback) = restore_row(state, id, previous) {
                return Err(AppError::Config(format!(
                    "MiniMax Code update failed: {error}; restoring the saved provider also failed: {rollback}"
                )));
            }
            Err(error)
        }
    }
}

/// Saved catalog plus every native `kind: custom` entry, with native values
/// and membership applied in memory. A native file that cannot be read
/// leaves the saved catalog visible instead of failing the list.
pub(super) fn list(state: &AppState) -> Result<IndexMap<String, Provider>, AppError> {
    let mut providers = state.db.get_all_providers(MCODE_APP)?;
    let native = match crate::mcode_config::get_providers() {
        Ok(native) => native,
        Err(error) => {
            log::warn!("Failed to read MiniMax Code providers; showing saved catalog: {error}");
            return Ok(providers);
        }
    };
    for (id, config) in &native {
        if !providers.contains_key(id) {
            providers.insert(id.clone(), imported(id, config));
        }
    }
    for (id, provider) in providers.iter_mut() {
        if let Some(config) = native.get(id) {
            merge_native_config(provider, config.clone());
        }
        ProviderService::set_provider_live_config_managed(provider, native.contains_key(id));
    }
    Ok(providers)
}

pub(super) fn add(
    state: &AppState,
    mut provider: Provider,
    add_to_live: bool,
) -> Result<bool, AppError> {
    let app_type = AppType::Mcode;
    let _guard = lock(state);
    strip_unsupported_metadata(&mut provider);
    align_native_display_name(&mut provider);
    ProviderService::validate_provider_settings(&app_type, &provider)?;
    ProviderService::normalize_usage_script_credential_overrides(&app_type, &mut provider);

    if state
        .db
        .get_provider_by_id(&provider.id, MCODE_APP)?
        .is_some()
    {
        return Err(AppError::InvalidInput(format!(
            "MiniMax Code provider '{}' already exists",
            provider.id
        )));
    }
    // A key already in config.yaml (including MiniMax Code's own account
    // providers) stays reserved; `add_provider` re-checks under the lock.
    if !add_to_live && crate::mcode_config::provider_key_exists(&provider.id)? {
        return Err(AppError::InvalidInput(format!(
            "MiniMax Code provider key '{}' already exists in config.yaml",
            provider.id
        )));
    }

    state.db.save_provider(MCODE_APP, &provider)?;
    if add_to_live {
        with_row_rollback(state, &provider.id, None, || {
            crate::mcode_config::add_provider(&provider.id, &provider.settings_config)
        })?;
    }
    Ok(true)
}

pub(super) fn update(
    state: &AppState,
    original_id: Option<&str>,
    mut provider: Provider,
    app_lock_held: bool,
) -> Result<bool, AppError> {
    let app_type = AppType::Mcode;
    let _guard = (!app_lock_held).then(|| lock(state));
    if original_id.is_some_and(|original| original != provider.id) {
        return Err(AppError::InvalidInput(
            "MiniMax Code provider keys cannot be renamed".to_string(),
        ));
    }
    strip_unsupported_metadata(&mut provider);
    align_native_display_name(&mut provider);
    ProviderService::validate_provider_settings(&app_type, &provider)?;
    ProviderService::normalize_usage_script_credential_overrides(&app_type, &mut provider);

    // Native-only entries have no saved row until their first edit.
    let previous = state.db.get_provider_by_id(&provider.id, MCODE_APP)?;
    let live = crate::mcode_config::get_providers()?.contains_key(&provider.id);
    if previous.is_none() && !live {
        return Err(AppError::InvalidInput(format!(
            "MiniMax Code provider '{}' not found",
            provider.id
        )));
    }

    state.db.save_provider(MCODE_APP, &provider)?;
    if live {
        with_row_rollback(state, &provider.id, previous.as_ref(), || {
            crate::mcode_config::set_provider(&provider.id, &provider.settings_config)
        })?;
    }
    Ok(true)
}

/// Remove the entry from `config.yaml` and keep its latest native value in
/// the saved catalog so re-enabling restores it exactly.
pub(super) fn remove(state: &AppState, id: &str) -> Result<(), AppError> {
    let _guard = lock(state);
    let Some(config) = crate::mcode_config::get_providers()?.shift_remove(id) else {
        return Ok(());
    };
    let previous = state.db.get_provider_by_id(id, MCODE_APP)?;
    let mut kept = previous.clone().unwrap_or_else(|| imported(id, &config));
    merge_native_config(&mut kept, config);
    state.db.save_provider(MCODE_APP, &kept)?;
    with_row_rollback(state, id, previous.as_ref(), || {
        crate::mcode_config::remove_provider(id)
    })
}

/// Delete the saved row and the native entry. A native entry that MiniMax
/// Code has selected as a default model blocks the delete and the row stays.
pub(super) fn delete_locked(state: &AppState, id: &str) -> Result<(), AppError> {
    let previous = state.db.get_provider_by_id(id, MCODE_APP)?;
    let live = crate::mcode_config::get_providers()?.contains_key(id);
    state.db.delete_provider(MCODE_APP, id)?;
    if live {
        with_row_rollback(state, id, previous.as_ref(), || {
            crate::mcode_config::remove_provider(id)
        })?;
    }
    Ok(())
}

/// "Switching" a MiniMax Code provider adds its `config.yaml` entry.
pub(super) fn enable_locked(state: &AppState, id: &str) -> Result<SwitchResult, AppError> {
    if crate::mcode_config::get_providers()?.contains_key(id) {
        return Ok(SwitchResult::default());
    }
    let provider = state
        .db
        .get_provider_by_id(id, MCODE_APP)?
        .ok_or_else(|| AppError::InvalidInput(format!("MiniMax Code provider '{id}' not found")))?;
    ProviderService::validate_provider_settings(&AppType::Mcode, &provider)?;
    report_backup(crate::mcode_config::add_provider(
        id,
        &provider.settings_config,
    )?);
    Ok(SwitchResult::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use crate::mcode_config::test_support::TestDataDir;
    use crate::provider::ProviderMeta;
    use serde_json::json;
    use serial_test::serial;
    use std::fs;
    use std::sync::Arc;

    fn state() -> AppState {
        AppState::new(Arc::new(
            Database::memory().expect("create in-memory database"),
        ))
    }

    fn input(model: &str) -> Provider {
        let mut provider = Provider::with_id(
            "mcode-test".to_string(),
            "Test provider".to_string(),
            json!({
                "name": "Test provider",
                "kind": "custom",
                "api": "openai-completions",
                "options": { "baseURL": "https://api.example.com/v1", "apiKey": "secret" },
                "models": { model: { "name": model } }
            }),
            None,
        );
        provider.category = Some("custom".to_string());
        provider.meta = Some(ProviderMeta {
            common_config_enabled: Some(true),
            is_partner: Some(true),
            ..ProviderMeta::default()
        });
        provider
    }

    fn native_text() -> String {
        fs::read_to_string(crate::mcode_config::config_path()).unwrap_or_default()
    }

    fn write_native(text: &str) {
        let path = crate::mcode_config::config_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn live(id: &str) -> bool {
        crate::mcode_config::get_providers()
            .expect("read config.yaml")
            .contains_key(id)
    }

    const NATIVE: &str = "\
# MiniMax Code settings
defaultModel: minimax/MiniMax-M3 # chosen in MiniMax Code
custom_provider:
  keep:
    kind: custom
    name: Keep
    models: {}
  account:
    kind: minimax
    name: Account
minimax_api:
  apiKey: keep-secret # account key
unknown: [a, b]
";

    /// Golden lifecycle in a temp `MINIMAX_DATA_DIR`: every operation leaves
    /// the rest of config.yaml byte-identical, and a full cycle restores it.
    #[test]
    #[serial]
    fn golden_lifecycle_keeps_the_rest_of_config_yaml() {
        let _home = TestDataDir::new();
        write_native(NATIVE);
        let state = state();

        let listed = ProviderService::list(&state, AppType::Mcode).expect("list");
        assert_eq!(listed.keys().collect::<Vec<_>>(), ["keep"]);
        assert_eq!(listed["keep"].name, "Keep");
        assert_eq!(
            listed["keep"].meta.as_ref().unwrap().live_config_managed,
            Some(true)
        );
        assert!(
            state.db.get_all_providers(MCODE_APP).unwrap().is_empty(),
            "listing never writes the database"
        );
        assert_eq!(native_text(), NATIVE, "listing never writes config.yaml");

        ProviderService::add(&state, AppType::Mcode, input("model-a"), false).expect("stage");
        assert!(!live("mcode-test"));
        assert_eq!(native_text(), NATIVE);
        let meta = state
            .db
            .get_provider_by_id("mcode-test", MCODE_APP)
            .unwrap()
            .unwrap()
            .meta
            .unwrap_or_default();
        assert_eq!(meta.common_config_enabled, None);
        assert_eq!(meta.is_partner, None);

        ProviderService::switch(&state, AppType::Mcode, "mcode-test").expect("enable");
        assert!(live("mcode-test"));
        assert!(ProviderService::current(&state, AppType::Mcode)
            .unwrap()
            .is_empty());
        let enabled = native_text();
        assert!(
            enabled.starts_with(
                "# MiniMax Code settings\ndefaultModel: minimax/MiniMax-M3 # chosen in MiniMax Code\n"
            ),
            "{enabled}"
        );
        assert!(
            enabled
                .ends_with("minimax_api:\n  apiKey: keep-secret # account key\nunknown: [a, b]\n"),
            "{enabled}"
        );
        assert!(!enabled.contains("defaultLightModel"));

        let mut edited = input("model-b");
        edited.name = "Renamed".to_string();
        ProviderService::update(&state, AppType::Mcode, Some("mcode-test"), edited)
            .expect("edit live entry");
        let providers = crate::mcode_config::get_providers().unwrap();
        assert_eq!(providers["mcode-test"]["name"], "Renamed");
        assert!(providers["mcode-test"]["models"].get("model-b").is_some());

        ProviderService::remove_from_live_config(&state, AppType::Mcode, "mcode-test")
            .expect("remove from live");
        assert!(!live("mcode-test"));
        let listed = ProviderService::list(&state, AppType::Mcode).unwrap();
        assert_eq!(
            listed["mcode-test"]
                .meta
                .as_ref()
                .unwrap()
                .live_config_managed,
            Some(false),
            "membership is fresh on the next list (cc #7578)"
        );

        ProviderService::switch(&state, AppType::Mcode, "mcode-test").expect("re-enable");
        ProviderService::delete(&state, AppType::Mcode, "mcode-test").expect("delete");
        assert!(!live("mcode-test"));
        assert!(state
            .db
            .get_provider_by_id("mcode-test", MCODE_APP)
            .unwrap()
            .is_none());
        let restored = native_text();
        assert_eq!(
            serde_yaml::from_str::<serde_yaml::Value>(&restored).unwrap(),
            serde_yaml::from_str::<serde_yaml::Value>(NATIVE).unwrap(),
            "a full cycle restores config.yaml"
        );
        for line in NATIVE.lines().filter(|line| line.contains('#')) {
            assert!(restored.contains(line), "comment kept: {line}");
        }
    }

    #[test]
    #[serial]
    fn selected_default_model_blocks_delete_and_keeps_the_row() {
        let _home = TestDataDir::new();
        let state = state();
        ProviderService::add(&state, AppType::Mcode, input("model-a"), true).expect("add");
        let mut text = native_text();
        text.insert_str(0, "defaultLightModel: custom_provider:mcode-test/model-a\n");
        write_native(&text);

        assert!(ProviderService::delete(&state, AppType::Mcode, "mcode-test").is_err());
        assert!(
            ProviderService::remove_from_live_config(&state, AppType::Mcode, "mcode-test").is_err()
        );
        assert!(ProviderService::update(&state, AppType::Mcode, None, input("model-b")).is_err());

        assert_eq!(native_text(), text);
        let saved = state
            .db
            .get_provider_by_id("mcode-test", MCODE_APP)
            .unwrap()
            .expect("row restored after the native write was refused");
        assert!(saved.settings_config["models"].get("model-a").is_some());
    }

    #[test]
    #[serial]
    fn busy_lock_rolls_back_the_saved_row() {
        let _home = TestDataDir::new();
        let state = state();
        let path = crate::mcode_config::config_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let lock = path.with_extension("yaml.lock");
        fs::create_dir(&lock).unwrap();

        assert!(matches!(
            ProviderService::add(&state, AppType::Mcode, input("model-a"), true),
            Err(AppError::Conflict(_))
        ));
        assert!(state.db.get_all_providers(MCODE_APP).unwrap().is_empty());
        assert!(
            lock.exists(),
            "an active MiniMax Code lock is never removed"
        );
        assert!(!path.exists());
    }

    #[test]
    #[serial]
    fn account_provider_keys_stay_reserved() {
        let _home = TestDataDir::new();
        write_native(NATIVE);
        let state = state();
        let mut account = input("model-a");
        account.id = "account".to_string();
        assert!(ProviderService::add(&state, AppType::Mcode, account.clone(), false).is_err());
        assert!(ProviderService::add(&state, AppType::Mcode, account, true).is_err());
        assert_eq!(native_text(), NATIVE);
        assert!(state.db.get_all_providers(MCODE_APP).unwrap().is_empty());
    }

    #[test]
    #[serial]
    fn lost_comments_are_backed_up_before_the_write() {
        let _home = TestDataDir::new();
        let text = "custom_provider:\n  # hand-written note\n  keep:\n    name: Keep\n";
        write_native(text);
        let state = state();
        ProviderService::add(&state, AppType::Mcode, input("model-a"), true).expect("add");

        let backups = crate::config::get_app_config_dir()
            .join("backups")
            .join("mcode");
        let copies: Vec<_> = fs::read_dir(&backups)
            .expect("backup directory")
            .map(|entry| fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect();
        assert_eq!(copies, [text]);
    }

    #[test]
    #[serial]
    fn malformed_native_file_keeps_the_saved_catalog_visible() {
        let _home = TestDataDir::new();
        let state = state();
        ProviderService::add(&state, AppType::Mcode, input("model-a"), false).expect("stage");
        write_native("custom_provider: [unclosed");
        let providers = ProviderService::list(&state, AppType::Mcode).expect("saved catalog");
        assert!(providers.contains_key("mcode-test"));
    }
}
