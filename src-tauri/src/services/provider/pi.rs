// Adapted from farion1231/cc-switch src-tauri/src/services/provider/pi.rs (MIT)
//! Pi providers (additive, D6): membership is an entry in `models.json`;
//! there is no current provider and Pi's `settings.json` is never written.
//!
//! `delete_locked` / `enable_locked` run under the per-app switch lock their
//! `ProviderService` callers already hold; every other entry takes it here.

use super::{ProviderService, SwitchResult};
use crate::app_config::AppType;
use crate::error::AppError;
use crate::provider::{Provider, ProviderMeta};
use crate::store::AppState;
use indexmap::IndexMap;
use serde_json::Value;

const PI_APP: &str = "pi";

fn lock(state: &AppState) -> tokio::sync::OwnedMutexGuard<()> {
    futures::executor::block_on(state.proxy_service.lock_switch_for_app(PI_APP))
}

fn native_provider(id: &str, config: &Value) -> Provider {
    let name = native_provider_name(config).unwrap_or(id).to_string();
    let mut provider = Provider::with_id(id.to_string(), name, config.clone(), None);
    provider.category = Some("custom".to_string());
    provider.icon = Some("pi".to_string());
    provider
}

/// Merge native entries and membership in memory only. Reading the list is
/// not consent to persist credentials; unreadable native state is an error.
pub(super) fn list(state: &AppState) -> Result<IndexMap<String, Provider>, AppError> {
    let _guard = lock(state);
    let native = crate::pi_config::read_pi_native_providers()?;
    let mut providers = state.db.get_all_providers(PI_APP)?;
    for (id, config) in &native {
        let provider = providers
            .entry(id.clone())
            .or_insert_with(|| native_provider(id, config));
        merge_native_config(provider, config.clone());
    }
    for (id, provider) in providers.iter_mut() {
        ProviderService::set_provider_live_config_managed(provider, native.contains_key(id));
    }
    Ok(providers)
}

pub(super) fn add(
    state: &AppState,
    mut provider: Provider,
    add_to_live: bool,
) -> Result<bool, AppError> {
    let app_type = AppType::Pi;
    let _guard = lock(state);
    strip_unsupported_metadata(&mut provider);
    ProviderService::validate_provider_settings(&app_type, &provider)?;
    align_native_display_name(&mut provider);
    ProviderService::normalize_usage_script_credential_overrides(&app_type, &mut provider);

    if state.db.get_provider_by_id(&provider.id, PI_APP)?.is_some() {
        return Err(AppError::InvalidInput(format!(
            "Pi provider '{}' already exists",
            provider.id
        )));
    }

    if !add_to_live && crate::pi_config::pi_provider_exists(&provider.id)? {
        return Err(AppError::InvalidInput(format!(
            "Pi provider key '{}' already exists in models.json",
            provider.id
        )));
    }

    let native_inserted = if add_to_live {
        crate::pi_config::insert_pi_provider(&provider.id, &provider.settings_config)?
    } else {
        false
    };

    if let Err(error) = state.db.save_provider(PI_APP, &provider) {
        if native_inserted {
            if let Err(rollback) = crate::pi_config::remove_pi_provider_if_matches(
                &provider.id,
                &provider.settings_config,
            ) {
                return Err(AppError::Config(format!(
                    "failed to save Pi provider: {error}; native rollback failed: {rollback}"
                )));
            }
        }
        return Err(error);
    }
    Ok(true)
}

pub(super) fn update(
    state: &AppState,
    original_id: Option<&str>,
    mut provider: Provider,
    app_lock_held: bool,
) -> Result<bool, AppError> {
    let app_type = AppType::Pi;
    let _guard = (!app_lock_held).then(|| lock(state));
    let original_id = original_id.unwrap_or(&provider.id).to_string();
    if original_id != provider.id {
        return Err(AppError::InvalidInput(
            "Pi provider keys cannot be renamed".to_string(),
        ));
    }

    if state.db.get_provider_by_id(&original_id, PI_APP)?.is_none()
        && !crate::pi_config::pi_provider_exists(&original_id)?
    {
        return Err(AppError::InvalidInput(format!(
            "Pi provider '{original_id}' not found"
        )));
    }
    strip_unsupported_metadata(&mut provider);
    ProviderService::validate_provider_settings(&app_type, &provider)?;
    ProviderService::normalize_usage_script_credential_overrides(&app_type, &mut provider);

    let previous_native =
        crate::pi_config::replace_pi_provider_if_present(&original_id, &provider.settings_config)?;
    if let Err(error) = state.db.save_provider(PI_APP, &provider) {
        if let Some(previous_native) = previous_native.as_ref() {
            if let Err(rollback) = crate::pi_config::replace_pi_provider(
                &original_id,
                &provider.settings_config,
                previous_native,
            ) {
                return Err(AppError::Config(format!(
                    "failed to save Pi provider: {error}; native rollback failed: {rollback}"
                )));
            }
        }
        return Err(error);
    }
    Ok(true)
}

/// Delete is keyed by provider ID: once the user confirms deleting the
/// provider, later field edits do not change that intent. The latest native
/// value is kept only for rollback.
pub(super) fn delete_locked(state: &AppState, id: &str) -> Result<(), AppError> {
    let in_db = state.db.get_provider_by_id(id, PI_APP)?.is_some();
    let in_native = crate::pi_config::pi_provider_exists(id)?;
    if !in_db && !in_native {
        return Ok(());
    }
    let removed = crate::pi_config::remove_pi_provider(id)?;

    if in_db {
        if let Err(error) = state.db.delete_provider(PI_APP, id) {
            if let Some(removed) = removed.as_ref() {
                if let Err(rollback) = crate::pi_config::restore_pi_provider_if_missing(id, removed)
                {
                    return Err(AppError::Config(format!(
                        "failed to delete Pi provider: {error}; native rollback failed: {rollback}"
                    )));
                }
            }
            return Err(error);
        }
    }
    Ok(())
}

/// Remove the entry from `models.json` and keep its latest native value in
/// the saved catalog so re-enabling restores it exactly.
pub(super) fn remove(state: &AppState, id: &str) -> Result<(), AppError> {
    let _guard = lock(state);
    let previous = state.db.get_provider_by_id(id, PI_APP)?;
    let Some(removed) = crate::pi_config::remove_pi_provider(id)? else {
        return Ok(());
    };
    let mut synced = previous.unwrap_or_else(|| native_provider(id, &removed));
    merge_native_config(&mut synced, removed.clone());
    if let Err(error) = state.db.save_provider(PI_APP, &synced) {
        if let Err(rollback) = crate::pi_config::restore_pi_provider_if_missing(id, &removed) {
            return Err(AppError::Config(format!(
                "failed to preserve Pi provider before removal: {error}; native rollback failed: {rollback}"
            )));
        }
        return Err(error);
    }
    Ok(())
}

pub(super) fn enable_locked(state: &AppState, id: &str) -> Result<SwitchResult, AppError> {
    let app_type = AppType::Pi;
    if crate::pi_config::pi_provider_exists(id)? {
        return Ok(SwitchResult::default());
    }
    let provider = state
        .db
        .get_provider_by_id(id, PI_APP)?
        .ok_or_else(|| AppError::InvalidInput(format!("Pi provider '{id}' not found")))?;

    ProviderService::validate_provider_settings(&app_type, &provider)?;
    crate::pi_config::insert_pi_provider(id, &provider.settings_config)?;
    Ok(SwitchResult::default())
}

pub(super) fn merge_native_config(provider: &mut Provider, config: Value) {
    if let Some(name) = native_provider_name(&config) {
        provider.name = name.to_string();
    }
    provider.settings_config = config;
}

pub(super) fn native_provider_name(config: &Value) -> Option<&str> {
    config
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
}

pub(super) fn align_native_display_name(provider: &mut Provider) {
    let Some(config) = provider.settings_config.as_object_mut() else {
        return;
    };
    if config.contains_key("name") {
        config.insert("name".to_string(), Value::String(provider.name.clone()));
    }
}

/// Pi has no proxy, failover, common config or partner
/// content: keep only the usage script from the renderer-supplied metadata.
pub(super) fn strip_unsupported_metadata(provider: &mut Provider) {
    provider.in_failover_queue = false;
    let Some(meta) = provider.meta.take() else {
        return;
    };
    provider.meta = Some(ProviderMeta {
        usage_script: meta.usage_script,
        ..ProviderMeta::default()
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use crate::pi_config::test_support::TestAgentDir;
    use serde_json::json;
    use serial_test::serial;
    use std::fs;
    use std::sync::Arc;

    fn state() -> AppState {
        AppState::new(Arc::new(
            Database::memory().expect("create in-memory database"),
        ))
    }

    fn input(model_id: &str) -> Provider {
        let mut provider = Provider::with_id(
            "pi-test".to_string(),
            "Test provider".to_string(),
            json!({
                "name": "Test provider",
                "baseUrl": "https://api.example.com/v1",
                "apiKey": "secret",
                "api": "openai-completions",
                "models": [{ "id": model_id }]
            }),
            None,
        );
        provider.category = Some("custom".to_string());
        provider.meta = Some(ProviderMeta {
            common_config_enabled: Some(true),
            endpoint_auto_select: Some(true),
            live_config_managed: Some(false),
            api_format: Some("openai_chat".to_string()),
            custom_user_agent: Some("legacy-route-agent".to_string()),
            is_partner: Some(true),
            ..ProviderMeta::default()
        });
        provider
    }

    fn saved(state: &AppState, id: &str) -> Option<Provider> {
        state.db.get_provider_by_id(id, PI_APP).expect("read row")
    }

    fn exists(id: &str) -> bool {
        crate::pi_config::pi_provider_exists(id).expect("read models.json")
    }

    #[test]
    #[serial]
    fn membership_is_derived_only_from_models_json() {
        let _agent = TestAgentDir::new();
        let state = state();

        ProviderService::add(&state, AppType::Pi, input("model-a"), false)
            .expect("save disabled provider");
        assert!(!exists("pi-test"));

        let meta = saved(&state, "pi-test").unwrap().meta.unwrap_or_default();
        assert_eq!(meta.common_config_enabled, None);
        assert_eq!(meta.live_config_managed, None);
        assert_eq!(meta.endpoint_auto_select, None);
        assert_eq!(meta.api_format, None);
        assert_eq!(meta.custom_user_agent, None);
        assert_eq!(meta.is_partner, None);

        ProviderService::switch(&state, AppType::Pi, "pi-test").expect("enable provider");
        assert!(exists("pi-test"));
        assert!(ProviderService::current(&state, AppType::Pi)
            .unwrap()
            .is_empty());

        ProviderService::remove_from_live_config(&state, AppType::Pi, "pi-test")
            .expect("remove provider");
        assert!(!exists("pi-test"));
        assert!(saved(&state, "pi-test").is_some());
    }

    #[test]
    #[serial]
    fn provider_membership_never_changes_pi_auth_or_settings() {
        let _agent = TestAgentDir::new();
        let state = state();
        let agent_dir = crate::pi_config::get_pi_agent_dir().expect("agent directory");
        fs::create_dir_all(&agent_dir).expect("create agent directory");
        let auth_path = agent_dir.join("auth.json");
        let settings_path = agent_dir.join("settings.json");
        let auth_contents = br#"{"anthropic": {"type":"oauth","refresh":"native-secret"}}"#;
        let settings_contents = br#"{"defaultProvider":"anthropic","defaultModel":"claude"}"#;
        fs::write(&auth_path, auth_contents).expect("write auth");
        fs::write(&settings_path, settings_contents).expect("write settings");
        fs::write(
            agent_dir.join("models.json"),
            r#"{"providers":{"anthropic":{"futureField":{"keep":true}}}}"#,
        )
        .expect("write explicit provider");

        ProviderService::list(&state, AppType::Pi).expect("list explicit provider");
        assert!(saved(&state, "anthropic").is_none());
        ProviderService::remove_from_live_config(&state, AppType::Pi, "anthropic")
            .expect("remove explicit provider");
        ProviderService::switch(&state, AppType::Pi, "anthropic")
            .expect("enable explicit provider");
        let mut edited = saved(&state, "anthropic").expect("provider");
        edited.settings_config["anotherField"] = json!(true);
        ProviderService::update(&state, AppType::Pi, Some("anthropic"), edited)
            .expect("edit explicit provider");
        ProviderService::delete(&state, AppType::Pi, "anthropic").expect("delete provider");

        assert_eq!(fs::read(auth_path).expect("read auth"), auth_contents);
        assert_eq!(
            fs::read(settings_path).expect("read settings"),
            settings_contents
        );
        assert!(!exists("anthropic"));
    }

    #[test]
    #[serial]
    fn failed_duplicate_create_rolls_back_native_insertion() {
        let _agent = TestAgentDir::new();
        let state = state();
        ProviderService::add(&state, AppType::Pi, input("model-a"), false)
            .expect("save DB-only provider");

        assert!(ProviderService::add(&state, AppType::Pi, input("model-a"), true).is_err());
        assert!(!exists("pi-test"));
    }

    #[test]
    #[serial]
    fn native_edits_merge_in_memory_and_survive_explicit_removal() {
        let _agent = TestAgentDir::new();
        let state = state();
        ProviderService::add(&state, AppType::Pi, input("model-a"), true).expect("add provider");
        let mut baseline = saved(&state, "pi-test").unwrap();
        baseline.icon = Some("user-icon".to_string());
        baseline.notes = Some("saved notes".to_string());
        baseline.meta = input("model-a").meta;
        state.db.save_provider(PI_APP, &baseline).unwrap();
        let mut external = baseline.settings_config.clone();
        external["name"] = json!("External edit");
        external["models"][0]["contextWindow"] = json!(1_000_000.0);
        crate::pi_config::replace_pi_provider("pi-test", &baseline.settings_config, &external)
            .expect("edit native provider");

        let listed = ProviderService::list(&state, AppType::Pi).expect("sync native providers");
        assert_eq!(listed["pi-test"].name, "External edit");
        assert_eq!(listed["pi-test"].settings_config, external);
        assert_eq!(listed["pi-test"].icon, baseline.icon);
        assert_eq!(listed["pi-test"].notes, baseline.notes);
        let mut expected_meta = baseline.meta.clone().unwrap();
        expected_meta.live_config_managed = Some(true);
        assert_eq!(
            serde_json::to_value(&listed["pi-test"].meta).unwrap(),
            serde_json::to_value(Some(expected_meta)).unwrap()
        );
        assert_eq!(
            serde_json::to_value(saved(&state, "pi-test")).unwrap(),
            serde_json::to_value(Some(&baseline)).unwrap(),
            "listing must not update saved data"
        );

        ProviderService::remove_from_live_config(&state, AppType::Pi, "pi-test")
            .expect("remove externally edited provider");
        assert!(!exists("pi-test"));
        let preserved = saved(&state, "pi-test").unwrap();
        assert_eq!(preserved.name, "External edit");
        assert_eq!(preserved.settings_config, external);
    }

    #[test]
    #[serial]
    fn enabled_provider_edit_rewrites_its_native_node() {
        let _agent = TestAgentDir::new();
        let state = state();
        ProviderService::add(&state, AppType::Pi, input("model-a"), true).expect("add provider");

        let mut edited = input("model-b");
        edited.settings_config["unknownField"] = json!({ "keep": true });
        ProviderService::update(&state, AppType::Pi, Some("pi-test"), edited.clone())
            .expect("edit enabled provider");

        assert_eq!(
            crate::pi_config::read_pi_native_provider("pi-test")
                .expect("read native provider")
                .expect("native provider"),
            edited.settings_config
        );
        let mut renamed = edited;
        renamed.id = "pi-renamed".to_string();
        assert!(
            ProviderService::update(&state, AppType::Pi, Some("pi-test"), renamed).is_err(),
            "Pi keys cannot be renamed"
        );
    }

    #[test]
    #[serial]
    fn listing_native_entries_never_persists_credentials() {
        let _agent = TestAgentDir::new();
        let state = state();
        let path = crate::pi_config::get_pi_models_path().unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{
                "providers": {
                    "native-custom": {
                        "name": "Native custom",
                        "baseUrl": "https://api.example.com/v1",
                        "apiKey": "secret",
                        "api": "openai-completions",
                        "models": [{ "id": "model-a" }]
                    },
                    "openai": {},
                    "deepseek": { "futureField": { "preserve": true } }
                }
            }"#,
        )
        .unwrap();

        let before = fs::read(&path).unwrap();
        let providers = ProviderService::list(&state, AppType::Pi).expect("list providers");
        assert!(state.db.get_all_providers(PI_APP).unwrap().is_empty());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(providers.len(), 3);
        let imported = &providers["native-custom"];
        assert_eq!(imported.name, "Native custom");
        assert_eq!(imported.category.as_deref(), Some("custom"));
        assert_eq!(imported.icon.as_deref(), Some("pi"));
        assert_eq!(providers["openai"].settings_config, json!({}));
        assert_eq!(
            providers["deepseek"].settings_config["futureField"],
            json!({ "preserve": true })
        );
    }

    #[test]
    #[serial]
    fn native_only_entries_support_explicit_mutations_without_prior_import() {
        let _agent = TestAgentDir::new();
        let path = crate::pi_config::get_pi_models_path().unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for operation in ["enable", "edit", "remove", "delete"] {
            let state = state();
            let config = input("model-a").settings_config;
            fs::write(
                &path,
                serde_json::to_vec(&json!({"providers": {"pi-test": config}})).unwrap(),
            )
            .unwrap();
            // No list call or implicit import is needed before any mutation.
            match operation {
                "enable" => {
                    ProviderService::switch(&state, AppType::Pi, "pi-test").unwrap();
                    assert!(saved(&state, "pi-test").is_none());
                    assert_eq!(
                        crate::pi_config::read_pi_native_provider("pi-test").unwrap(),
                        Some(config)
                    );
                }
                "edit" => {
                    ProviderService::update(&state, AppType::Pi, None, input("model-b")).unwrap();
                    let edited = saved(&state, "pi-test").unwrap();
                    assert_eq!(edited.settings_config["models"][0]["id"], "model-b");
                    assert_eq!(
                        crate::pi_config::read_pi_native_provider("pi-test").unwrap(),
                        Some(edited.settings_config)
                    );
                }
                "remove" => {
                    ProviderService::remove_from_live_config(&state, AppType::Pi, "pi-test")
                        .unwrap();
                    assert!(!exists("pi-test"));
                    assert_eq!(saved(&state, "pi-test").unwrap().settings_config, config);
                    ProviderService::switch(&state, AppType::Pi, "pi-test").unwrap();
                    assert_eq!(
                        crate::pi_config::read_pi_native_provider("pi-test").unwrap(),
                        Some(config)
                    );
                }
                "delete" => {
                    ProviderService::delete(&state, AppType::Pi, "pi-test").unwrap();
                    assert!(!exists("pi-test"));
                    assert!(saved(&state, "pi-test").is_none());
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    #[serial]
    fn database_only_create_does_not_overwrite_an_unsynced_native_key() {
        let _agent = TestAgentDir::new();
        let state = state();
        let path = crate::pi_config::get_pi_models_path().expect("models path");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"providers":{"pi-test":{"name":"Native OAuth","oauth":"example"}}}"#,
        )
        .unwrap();

        let error = ProviderService::add(&state, AppType::Pi, input("model-a"), false)
            .expect_err("an unsynced native provider key must stay reserved");
        assert!(error.to_string().contains("already exists in models.json"));
        assert!(saved(&state, "pi-test").is_none());
        assert!(exists("pi-test"));
    }

    #[test]
    #[serial]
    fn malformed_native_file_propagates_without_changing_saved_data() {
        let _agent = TestAgentDir::new();
        let state = state();
        ProviderService::add(&state, AppType::Pi, input("model-a"), false).expect("save provider");
        let path = crate::pi_config::get_pi_models_path().expect("models path");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{not-json").expect("write malformed models");
        let before = serde_json::to_value(saved(&state, "pi-test")).unwrap();
        assert!(ProviderService::list(&state, AppType::Pi).is_err());
        assert_eq!(
            serde_json::to_value(saved(&state, "pi-test")).unwrap(),
            before
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "{not-json");
    }

    #[test]
    #[serial]
    fn deeplink_style_inactive_import_never_touches_models_json() {
        let _agent = TestAgentDir::new();
        let state = state();
        ProviderService::add_inactive(&state, AppType::Pi, input("model-a"), true)
            .expect("stage provider");
        assert!(saved(&state, "pi-test").is_some());
        assert!(!exists("pi-test"));
        assert!(!crate::pi_config::get_pi_models_path().unwrap().exists());
    }
}
