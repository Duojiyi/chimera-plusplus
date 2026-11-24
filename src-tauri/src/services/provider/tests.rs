use super::*;
#[cfg(any(target_os = "macos", windows))]
use crate::claude_desktop_config::PROFILE_ID;
use crate::config::{get_claude_settings_path, read_json_file, write_json_file};
use crate::database::Database;
#[cfg(any(target_os = "macos", windows))]
use crate::provider::{ClaudeDesktopMode, ClaudeDesktopModelRoute};
use crate::provider::{ProviderMeta, UsageScript};
use crate::proxy::types::ProxyConfig;
use crate::store::AppState;
use serde_json::json;
use serial_test::serial;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tempfile::TempDir;

#[test]
#[serial]
fn failed_update_compensates_database_but_preserves_external_live_write() {
    for app in [AppType::Claude, AppType::Gemini, AppType::OpenCode] {
        let _home = TempHome::new();
        crate::settings::reload_settings().unwrap();
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        let before = Provider::with_id("target".into(), "before".into(), json!({}), None);
        state.db.save_provider(app.as_str(), &before).unwrap();
        // Compare persisted snapshots: the DAO normalizes absent metadata.
        let before = state
            .db
            .get_provider_by_id("target", app.as_str())
            .unwrap()
            .unwrap();
        let path = crate::services::live_backup::live_files(&app)
            .unwrap()
            .remove(0);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"before").unwrap();
        let error = update::with_update_rollback(&state, &app, "target", "target", false, || {
            let mut edited = before.clone();
            edited.name = "edited".into();
            state.db.save_provider(app.as_str(), &edited)?;
            // Simulate an external writer after the operation's snapshot,
            // before the operation reports failure. This is not our receipt.
            fs::write(&path, b"external-secret").unwrap();
            Err(AppError::Message("injected operation failure".into()))
        })
        .unwrap_err()
        .to_string();
        assert!(error.contains("injected operation failure"), "{error}");
        assert!(error.contains("Live 回滚冲突"), "{error}");
        assert!(!error.contains("external-secret"));
        assert_eq!(fs::read(&path).unwrap(), b"external-secret");
        let restored = state
            .db
            .get_provider_by_id("target", app.as_str())
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
    }
    crate::settings::reload_settings().unwrap();
}

struct TempHome {
    #[allow(dead_code)]
    dir: TempDir,
    original_home: Option<String>,
    #[cfg(windows)]
    original_local_app_data: Option<String>,
    original_userprofile: Option<String>,
    original_test_home: Option<String>,
}

impl TempHome {
    fn new() -> Self {
        let temp_root = env::temp_dir();
        // Keep history tests outside macOS's /var system symlink.
        #[cfg(target_os = "macos")]
        let temp_root = temp_root.canonicalize().expect("resolve temp home parent");
        let dir = TempDir::new_in(temp_root).expect("failed to create temp home");
        let original_home = env::var("HOME").ok();
        #[cfg(windows)]
        let original_local_app_data = env::var("LOCALAPPDATA").ok();
        let original_userprofile = env::var("USERPROFILE").ok();
        let original_test_home = env::var("CC_SWITCH_TEST_HOME").ok();

        env::set_var("HOME", dir.path());
        #[cfg(windows)]
        env::set_var("LOCALAPPDATA", dir.path().join("AppData").join("Local"));
        env::set_var("USERPROFILE", dir.path());
        env::set_var("CC_SWITCH_TEST_HOME", dir.path());

        Self {
            dir,
            original_home,
            #[cfg(windows)]
            original_local_app_data,
            original_userprofile,
            original_test_home,
        }
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        match &self.original_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        #[cfg(windows)]
        {
            match &self.original_local_app_data {
                Some(value) => env::set_var("LOCALAPPDATA", value),
                None => env::remove_var("LOCALAPPDATA"),
            }
        }

        match &self.original_userprofile {
            Some(value) => env::set_var("USERPROFILE", value),
            None => env::remove_var("USERPROFILE"),
        }

        match &self.original_test_home {
            Some(value) => env::set_var("CC_SWITCH_TEST_HOME", value),
            None => env::remove_var("CC_SWITCH_TEST_HOME"),
        }
    }
}

#[cfg(windows)]
fn claude_desktop_profile_path(home: &Path) -> PathBuf {
    home.join("AppData")
        .join("Local")
        .join("Claude-3p")
        .join("configLibrary")
        .join(format!("{PROFILE_ID}.json"))
}

#[cfg(target_os = "macos")]
fn claude_desktop_profile_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Claude-3p")
        .join("configLibrary")
        .join(format!("{PROFILE_ID}.json"))
}

fn test_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

fn with_test_home<T>(test: impl FnOnce(&AppState, &Path) -> T) -> T {
    let _guard = test_guard();
    let temp = tempfile::tempdir().expect("tempdir");
    let old_test_home = std::env::var_os("CC_SWITCH_TEST_HOME");
    let old_home = std::env::var_os("HOME");
    std::env::set_var("CC_SWITCH_TEST_HOME", temp.path());
    std::env::set_var("HOME", temp.path());

    let db = Arc::new(Database::memory().expect("in-memory database"));
    let state = AppState::new(db);
    let result = test(&state, temp.path());

    match old_test_home {
        Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
        None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
    }
    match old_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }

    result
}

#[tokio::test]
async fn deletion_locks_follow_profile_lifecycle_app_order() {
    let state = AppState::new(Arc::new(Database::memory().unwrap()));
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let profile = state.profile_apply_lock.lock().await;
        let apps = [AppType::Codex];
        let mut deletion = Box::pin(ProviderService::lock_deletion(&state, &apps));
        assert!(futures::poll!(&mut deletion).is_pending());
        // A deletion waiting for profile must not own lifecycle or app.
        let lifecycle = state.proxy_service.lock_lifecycle().await;
        let app = state.proxy_service.lock_switch_for_app("codex").await;
        drop(profile);
        assert!(futures::poll!(&mut deletion).is_pending());
        assert!(state.profile_apply_lock.try_lock().is_err());
        drop(app);
        // Waiting for lifecycle must not acquire the app lock first.
        let app = state.proxy_service.lock_switch_for_app("codex").await;
        drop(lifecycle);
        assert!(futures::poll!(&mut deletion).is_pending());
        drop(app);
        let guards = deletion.await;
        assert!(state.profile_apply_lock.try_lock().is_err());
        let mut lifecycle = Box::pin(state.proxy_service.lock_lifecycle());
        let mut app = Box::pin(state.proxy_service.lock_switch_for_app("codex"));
        assert!(futures::poll!(&mut lifecycle).is_pending());
        assert!(futures::poll!(&mut app).is_pending());
        drop(guards);
        drop(lifecycle.await);
        drop(app.await);
    })
    .await
    .expect("deletion lock ordering must not deadlock");
}

#[test]
#[serial]
fn queued_switch_rechecks_target_after_deletion() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        let provider = Provider::with_id(
            "delete-race".into(),
            "Race".into(),
            json!({"env": {"ANTHROPIC_AUTH_TOKEN": "test"}}),
            None,
        );
        // Cover the ordinary path and the early Desktop return path.
        for app in [AppType::Claude, AppType::ClaudeDesktop] {
            state.db.save_provider(app.as_str(), &provider).unwrap();
            let guards = futures::executor::block_on(ProviderService::lock_deletion(
                state,
                std::slice::from_ref(&app),
            ));
            let switch_state = state.clone();
            let switch_app = app.clone();
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                let result = ProviderService::switch(&switch_state, switch_app, "delete-race");
                done_tx.send(result.map_err(|e| e.to_string())).unwrap();
            });
            started_rx
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            let before_unlock = done_rx.recv_timeout(std::time::Duration::from_millis(100));
            ProviderService::delete_with_locks_held(state, app.clone(), "delete-race").unwrap();
            drop(guards);
            let result = before_unlock.unwrap_or_else(|_| {
                done_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .expect("switch must not deadlock")
            });
            worker.join().unwrap();
            assert!(result.unwrap_err().contains("不存在"));
            assert!(state
                .db
                .get_provider_by_id("delete-race", app.as_str())
                .unwrap()
                .is_none());
            assert!(state
                .db
                .get_current_provider(app.as_str())
                .unwrap()
                .is_none());
            assert_ne!(
                crate::settings::get_current_provider(&app).as_deref(),
                Some("delete-race")
            );
        }
    });
}

#[test]
#[serial]
fn deletion_rechecks_current_after_waiting_for_switch() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        let provider = Provider::with_id("delete-race".into(), "Race".into(), json!({}), None);
        state.db.save_provider("codex", &provider).unwrap();
        let app = futures::executor::block_on(state.proxy_service.lock_switch_for_app("codex"));
        let delete_state = state.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            done_tx
                .send(
                    ProviderService::delete(&delete_state, AppType::Codex, "delete-race")
                        .map_err(|e| e.to_string()),
                )
                .unwrap();
        });
        started_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let before_unlock = done_rx.recv_timeout(std::time::Duration::from_millis(100));
        // Model the final current-ID commit of the switch that owns app.
        state
            .db
            .set_current_provider("codex", "delete-race")
            .unwrap();
        drop(app);
        let result = before_unlock.unwrap_or_else(|_| {
            done_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("delete must not deadlock")
        });
        worker.join().unwrap();
        assert!(result.unwrap_err().contains("无法删除"));
        assert!(state
            .db
            .get_provider_by_id("delete-race", "codex")
            .unwrap()
            .is_some());
    });
}

#[test]
#[serial]
fn universal_deletion_and_disabled_sync_preserve_current_children() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        let mut universal = UniversalProvider::new(
            "race".into(),
            "Race".into(),
            "openai".into(),
            "https://example.invalid".into(),
            "test".into(),
        );
        universal.apps.codex = false;
        state.db.save_universal_provider(&universal).unwrap();
        let child = Provider::with_id(
            "universal-codex-race".into(),
            "Child".into(),
            json!({}),
            None,
        );
        state.db.save_provider("codex", &child).unwrap();
        // Device-local current must be protected even if DB current differs.
        crate::settings::set_current_provider(&AppType::Codex, Some(&child.id)).unwrap();
        assert!(ProviderService::delete_universal(state, "race").is_err());
        assert!(ProviderService::sync_universal_to_apps(state, "race").is_err());
        assert!(state.db.get_universal_provider("race").unwrap().is_some());
        assert!(state
            .db
            .get_provider_by_id(&child.id, "codex")
            .unwrap()
            .is_some());
        crate::settings::set_current_provider(&AppType::Codex, None).unwrap();
        ProviderService::delete_universal(state, "race").unwrap();
        assert!(state
            .db
            .get_provider_by_id(&child.id, "codex")
            .unwrap()
            .is_none());
    });
}

#[test]
#[serial]
fn stale_db_current_flag_does_not_block_deleting_an_idle_line() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        for id in ["a", "b", "c"] {
            let provider = Provider::with_id(id.into(), id.into(), json!({}), None);
            state.db.save_provider("claude", &provider).unwrap();
        }
        // The local pointer (what the line table shows) is `a`; the DB
        // fallback flag was left on `b`.
        state.db.set_current_provider("claude", "b").unwrap();
        crate::settings::set_current_provider(&AppType::Claude, Some("a")).unwrap();

        ProviderService::delete(state, AppType::Claude, "b").expect("idle line deletes");
        assert!(state
            .db
            .get_provider_by_id("b", "claude")
            .unwrap()
            .is_none());
        assert_eq!(
            state.db.get_current_provider("claude").unwrap().as_deref(),
            Some("a")
        );
        assert!(ProviderService::delete(state, AppType::Claude, "a").is_err());

        // Without a valid local pointer the DB flag still protects its line.
        state.db.set_current_provider("claude", "c").unwrap();
        crate::settings::set_current_provider(&AppType::Claude, Some("ghost")).unwrap();
        assert!(ProviderService::delete(state, AppType::Claude, "c").is_err());
        crate::settings::set_current_provider(&AppType::Claude, None).unwrap();
        assert!(ProviderService::delete(state, AppType::Claude, "c").is_err());
        assert!(state
            .db
            .get_provider_by_id("c", "claude")
            .unwrap()
            .is_some());
    });
}

#[test]
#[serial]
fn universal_sync_and_deletion_allow_missing_disabled_children() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        let mut parent = UniversalProvider::new(
            "empty".into(),
            "Empty".into(),
            "openai".into(),
            "https://example.invalid".into(),
            "test-only-key".into(),
        );
        parent.apps.claude = false;
        parent.apps.codex = false;
        parent.apps.gemini = false;
        state.db.save_universal_provider(&parent).unwrap();
        assert!(ProviderService::sync_universal_to_apps(state, &parent.id).unwrap());
        for app in ["claude", "codex", "gemini"] {
            assert!(state
                .db
                .get_provider_by_id(&format!("universal-{app}-empty"), app)
                .unwrap()
                .is_none());
        }
        assert!(ProviderService::delete_universal(state, &parent.id).unwrap());
        assert!(state
            .db
            .get_universal_provider(&parent.id)
            .unwrap()
            .is_none());
        assert!(ProviderService::delete(state, AppType::Codex, "missing-line").is_err());
    });
}

#[test]
#[serial]
fn universal_sync_preserves_child_metadata() {
    with_test_home(|state, _| {
        let mut parent = UniversalProvider::new(
            "metadata".into(),
            "Original".into(),
            "custom".into(),
            "https://old.example".into(),
            "old-key".into(),
        );
        parent.apps.claude = true;
        parent.apps.codex = true;
        parent.apps.gemini = true;
        state.db.save_universal_provider(&parent).unwrap();
        ProviderService::sync_universal_to_apps(state, &parent.id).unwrap();
        let mut expected = Vec::new();
        for app in ["claude", "codex", "gemini"] {
            let id = format!("universal-{app}-metadata");
            let mut child = state.db.get_provider_by_id(&id, app).unwrap().unwrap();
            child.meta = Some(
                serde_json::from_value(
                    json!({"commonConfigEnabled": false, "endpointAutoSelect": true}),
                )
                .unwrap(),
            );
            child.created_at = Some(123);
            child.sort_index = Some(7);
            child.settings_config["local_setting"] = json!(app);
            state.db.save_provider(app, &child).unwrap();
            expected.push((app, child));
        }
        parent.name = "Updated".into();
        parent.api_key = "new-key".into();
        for metadata in [None, Some(Default::default())] {
            parent.meta = metadata;
            state.db.save_universal_provider(&parent).unwrap();
            ProviderService::sync_universal_to_apps(state, &parent.id).unwrap();
            for (app, before) in &expected {
                let after = state
                    .db
                    .get_provider_by_id(&before.id, app)
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    serde_json::to_value(&after.meta).unwrap(),
                    serde_json::to_value(&before.meta).unwrap()
                );
                assert_eq!(after.created_at, before.created_at);
                assert_eq!(after.sort_index, before.sort_index);
                assert_eq!(after.name, "Updated");
                assert_eq!(after.settings_config["local_setting"], json!(app));
            }
        }
    });
}

fn codex_settings(base_url: &str, api_key: &str) -> Value {
    json!({
        "auth": {
            "OPENAI_API_KEY": api_key
        },
        "config": format!(
            "model_provider = \"custom\"\n\
             [model_providers.custom]\n\
             name = \"custom\"\n\
             base_url = \"{base_url}\"\n\
             wire_api = \"chat\"\n"
        )
    })
}

fn usage_script_with_credentials(
    api_key: Option<&str>,
    base_url: Option<&str>,
    template_type: Option<&str>,
) -> UsageScript {
    UsageScript {
        enabled: true,
        language: "javascript".to_string(),
        code: "return { remaining: 1, unit: 'USD' };".to_string(),
        timeout: Some(10),
        api_key: api_key.map(str::to_string),
        base_url: base_url.map(str::to_string),
        access_token: None,
        user_id: None,
        template_type: template_type.map(str::to_string),
        auto_query_interval: None,
        coding_plan_provider: None,
        access_key_id: Some("ak-test".to_string()),
        secret_access_key: Some("sk-test".to_string()),
        team_organization_id: None,
        team_project_id: None,
    }
}

fn codex_provider_with_usage(
    id: &str,
    base_url: &str,
    api_key: &str,
    usage_api_key: Option<&str>,
    usage_base_url: Option<&str>,
    template_type: Option<&str>,
) -> Provider {
    let mut provider = Provider::with_id(
        id.to_string(),
        format!("Provider {id}"),
        codex_settings(base_url, api_key),
        None,
    );
    provider.meta = Some(ProviderMeta {
        usage_script: Some(usage_script_with_credentials(
            usage_api_key,
            usage_base_url,
            template_type,
        )),
        ..Default::default()
    });
    provider
}

fn opencode_provider(id: &str) -> Provider {
    Provider {
        id: id.to_string(),
        name: format!("Provider {id}"),
        settings_config: json!({
            "npm": "@ai-sdk/openai-compatible",
            "name": format!("Provider {id}"),
            "options": {
                "baseURL": "https://api.example.com/v1",
                "apiKey": "test-key"
            },
            "models": {
                "gpt-4o": {
                    "name": "GPT-4o"
                }
            }
        }),
        website_url: None,
        category: Some("custom".to_string()),
        created_at: Some(1),
        sort_index: Some(0),
        notes: None,
        meta: None,
        icon: None,
        icon_color: None,
        in_failover_queue: false,
    }
}

fn opencode_omo_provider(id: &str, category: &str) -> Provider {
    let mut settings = serde_json::Map::new();
    settings.insert(
        "agents".to_string(),
        json!({
            "writer": {
                "model": "gpt-4o-mini"
            }
        }),
    );
    if category == "omo" {
        settings.insert(
            "categories".to_string(),
            json!({
                "default": ["writer"]
            }),
        );
    }
    settings.insert(
        "otherFields".to_string(),
        json!({
            "theme": "dark"
        }),
    );

    Provider {
        id: id.to_string(),
        name: format!("Provider {id}"),
        settings_config: Value::Object(settings),
        website_url: None,
        category: Some(category.to_string()),
        created_at: Some(1),
        sort_index: Some(0),
        notes: None,
        meta: None,
        icon: None,
        icon_color: None,
        in_failover_queue: false,
    }
}

fn additive_list_fixture(app_type: &AppType) -> (Provider, PathBuf, Value) {
    let native = json!({"api_key": "native-only-secret"});
    match app_type {
        AppType::OpenCode => (
            opencode_provider("saved"),
            crate::opencode_config::get_opencode_config_path(),
            json!({"provider": {"saved": native, "external": {}}}),
        ),

        _ => unreachable!(),
    }
}

#[test]
#[serial]
fn list_additive_providers_uses_live_membership_without_importing_or_writing() {
    let _guard = test_guard();
    let home = TempHome::new();
    let state = AppState::new(Arc::new(Database::memory().unwrap()));
    for app_type in [AppType::OpenCode] {
        let (template, path, native) = additive_list_fixture(&app_type);
        assert!(
            path.starts_with(home.dir.path()),
            "fixture must stay in temp home"
        );
        for stored_flag in [None, Some(false), Some(true)] {
            let mut provider = template.clone();
            if let Some(flag) = stored_flag {
                ProviderService::set_provider_live_config_managed(&mut provider, flag);
            }
            state
                .db
                .save_provider(app_type.as_str(), &provider)
                .unwrap();
            let stored =
                serde_json::to_value(state.db.get_all_providers(app_type.as_str()).unwrap())
                    .unwrap();
            for present in [true, false] {
                // a native configuration reset without removing the saved catalog.
                let config = if present { native.clone() } else { json!({}) };
                write_json_file(&path, &config).unwrap();
                let bytes = fs::read(&path).unwrap();
                let listed = ProviderService::list(&state, app_type.clone()).unwrap();
                assert_eq!(listed.len(), 1, "must not import the external entry");
                assert_eq!(
                    ProviderService::provider_live_config_managed(&listed["saved"]),
                    Some(present)
                );
                assert_eq!(
                    listed["saved"].settings_config, provider.settings_config,
                    "must not import native credentials"
                );
                assert_eq!(
                    serde_json::to_value(state.db.get_all_providers(app_type.as_str()).unwrap())
                        .unwrap(),
                    stored,
                    "listing must not persist derived flags or native entries"
                );
                assert_eq!(
                    fs::read(&path).unwrap(),
                    bytes,
                    "listing must not rewrite live config"
                );
            }
        }
    }
}

#[test]
#[serial]
fn list_additive_providers_marks_missing_config_inactive_without_creating_it() {
    let _guard = test_guard();
    let home = TempHome::new();
    let state = AppState::new(Arc::new(Database::memory().unwrap()));
    let app_type = AppType::OpenCode;
    let (mut provider, path, _) = additive_list_fixture(&app_type);
    assert!(
        path.starts_with(home.dir.path()),
        "fixture must stay in temp home"
    );
    ProviderService::set_provider_live_config_managed(&mut provider, true);
    state
        .db
        .save_provider(app_type.as_str(), &provider)
        .unwrap();
    assert!(!path.exists());
    let listed = ProviderService::list(&state, app_type).unwrap();
    assert_eq!(
        ProviderService::provider_live_config_managed(&listed["saved"]),
        Some(false)
    );
    assert!(!path.exists(), "listing must not create a missing config");
}

#[test]
#[serial]
fn list_additive_providers_propagates_parse_and_read_errors_even_for_db_only_rows() {
    let _guard = test_guard();
    for directory in [false, true] {
        let home = TempHome::new();
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        for app_type in [AppType::OpenCode] {
            let (mut provider, path, _) = additive_list_fixture(&app_type);
            assert!(
                path.starts_with(home.dir.path()),
                "fixture must stay in temp home"
            );
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            if directory {
                fs::create_dir(&path).unwrap();
            } else {
                fs::write(&path, "[\n").unwrap();
            }
            for stored_flag in [false, true] {
                ProviderService::set_provider_live_config_managed(&mut provider, stored_flag);
                state
                    .db
                    .save_provider(app_type.as_str(), &provider)
                    .unwrap();
                assert!(
                    ProviderService::list(&state, app_type.clone()).is_err(),
                    "unreadable live state must not fall back to the stored flag"
                );
            }
        }
    }
}

#[test]
#[serial]
fn list_opencode_does_not_treat_omo_plugin_rows_as_provider_members() {
    let _guard = test_guard();
    let home = TempHome::new();
    assert!(crate::opencode_config::get_opencode_config_path().starts_with(home.dir.path()));
    let state = AppState::new(Arc::new(Database::memory().unwrap()));
    for category in ["omo", "omo-slim"] {
        let provider = opencode_omo_provider(category, category);
        state.db.save_provider("opencode", &provider).unwrap();
    }
    let listed = ProviderService::list(&state, AppType::OpenCode).unwrap();
    for provider in listed.values() {
        assert_eq!(
            ProviderService::provider_live_config_managed(provider),
            None
        );
    }
}

fn omo_config_path(home: &Path, category: &str) -> PathBuf {
    home.join(".config").join("opencode").join(match category {
        "omo" => crate::services::omo::STANDARD.preferred_filename,
        "omo-slim" => crate::services::omo::SLIM.preferred_filename,
        other => panic!("unexpected OMO category in test: {other}"),
    })
}

#[test]
#[serial]
fn add_clears_usage_credentials_that_match_provider_config() {
    with_test_home(|state, _| {
        let provider = codex_provider_with_usage(
            "codex-a",
            "https://api.a.example/v1/",
            "sk-a",
            Some(" sk-a "),
            Some(" https://api.a.example/v1/ "),
            None,
        );

        ProviderService::add(state, AppType::Codex, provider, false).expect("add provider");

        let saved = state
            .db
            .get_provider_by_id("codex-a", AppType::Codex.as_str())
            .expect("query saved provider")
            .expect("saved provider should exist");
        let script = saved
            .meta
            .as_ref()
            .and_then(|meta| meta.usage_script.as_ref())
            .expect("usage script should remain");

        assert_eq!(script.api_key, None);
        assert_eq!(script.base_url, None);
    });
}

#[test]
#[serial]
fn update_preserves_usage_credentials_that_only_match_previous_config() {
    with_test_home(|state, _| {
        let provider = codex_provider_with_usage(
            "codex-usage-old",
            "https://api.a.example/v1/",
            "sk-a",
            Some("sk-a"),
            Some("https://api.a.example/v1/"),
            None,
        );
        state
            .db
            .save_provider(AppType::Codex.as_str(), &provider)
            .expect("seed provider with explicit usage credentials");

        let mut updated = provider.clone();
        updated.settings_config = codex_settings("https://api.b.example/v1/", "sk-b");

        ProviderService::update(state, AppType::Codex, None, updated)
            .expect("update provider main credentials");

        let saved = state
            .db
            .get_provider_by_id("codex-usage-old", AppType::Codex.as_str())
            .expect("query updated provider")
            .expect("updated provider should exist");
        let script = saved
            .meta
            .as_ref()
            .and_then(|meta| meta.usage_script.as_ref())
            .expect("usage script should remain");

        assert_eq!(script.api_key.as_deref(), Some("sk-a"));
        assert_eq!(
            script.base_url.as_deref(),
            Some("https://api.a.example/v1/")
        );
        assert_eq!(
            saved.resolve_usage_credentials(&AppType::Codex),
            ("https://api.b.example/v1".to_string(), "sk-b".to_string())
        );
    });
}

#[test]
#[serial]
fn copied_provider_uses_edited_credentials_after_add_clears_mirrored_usage_credentials() {
    with_test_home(|state, _| {
        let copied_provider = codex_provider_with_usage(
            "codex-copy",
            "https://api.a.example/v1/",
            "sk-a",
            Some("sk-a"),
            Some("https://api.a.example/v1/"),
            None,
        );

        ProviderService::add(state, AppType::Codex, copied_provider, false)
            .expect("add copied provider");

        let saved_after_add = state
            .db
            .get_provider_by_id("codex-copy", AppType::Codex.as_str())
            .expect("query copied provider")
            .expect("copied provider should exist");
        let script_after_add = saved_after_add
            .meta
            .as_ref()
            .and_then(|meta| meta.usage_script.as_ref())
            .expect("usage script should remain");
        assert_eq!(script_after_add.api_key, None);
        assert_eq!(script_after_add.base_url, None);

        let mut edited_provider = saved_after_add.clone();
        edited_provider.settings_config = codex_settings("https://api.b.example/v1/", "sk-b");

        ProviderService::update(state, AppType::Codex, None, edited_provider)
            .expect("edit copied provider credentials");

        let saved_after_update = state
            .db
            .get_provider_by_id("codex-copy", AppType::Codex.as_str())
            .expect("query edited provider")
            .expect("edited provider should exist");
        let script_after_update = saved_after_update
            .meta
            .as_ref()
            .and_then(|meta| meta.usage_script.as_ref())
            .expect("usage script should remain");

        assert_eq!(script_after_update.api_key, None);
        assert_eq!(script_after_update.base_url, None);
        assert_eq!(
            saved_after_update.resolve_usage_credentials(&AppType::Codex),
            ("https://api.b.example/v1".to_string(), "sk-b".to_string())
        );
    });
}

#[test]
#[serial]
fn update_clears_usage_credentials_that_match_current_config() {
    with_test_home(|state, _| {
        let provider = codex_provider_with_usage(
            "codex-current",
            "https://api.a.example/v1",
            "sk-a",
            Some("sk-usage"),
            Some("https://usage.example/api"),
            None,
        );
        state
            .db
            .save_provider(AppType::Codex.as_str(), &provider)
            .expect("seed provider with distinct usage credentials");

        let mut updated = provider.clone();
        updated.settings_config = codex_settings("https://api.b.example/v1/", "sk-b");
        updated.meta = Some(ProviderMeta {
            usage_script: Some(usage_script_with_credentials(
                Some(" sk-b "),
                Some(" https://api.b.example/v1/ "),
                None,
            )),
            ..Default::default()
        });

        ProviderService::update(state, AppType::Codex, None, updated)
            .expect("update provider with redundant usage credentials");

        let saved = state
            .db
            .get_provider_by_id("codex-current", AppType::Codex.as_str())
            .expect("query updated provider")
            .expect("updated provider should exist");
        let script = saved
            .meta
            .as_ref()
            .and_then(|meta| meta.usage_script.as_ref())
            .expect("usage script should remain");

        assert_eq!(script.api_key, None);
        assert_eq!(script.base_url, None);
    });
}

#[test]
#[serial]
fn add_preserves_distinct_usage_credentials() {
    with_test_home(|state, _| {
        let provider = codex_provider_with_usage(
            "codex-distinct",
            "https://api.main.example/v1",
            "sk-main",
            Some("sk-usage"),
            Some("https://usage.example/api"),
            None,
        );

        ProviderService::add(state, AppType::Codex, provider, false).expect("add provider");

        let saved = state
            .db
            .get_provider_by_id("codex-distinct", AppType::Codex.as_str())
            .expect("query saved provider")
            .expect("saved provider should exist");
        let script = saved
            .meta
            .as_ref()
            .and_then(|meta| meta.usage_script.as_ref())
            .expect("usage script should remain");

        assert_eq!(script.api_key.as_deref(), Some("sk-usage"));
        assert_eq!(
            script.base_url.as_deref(),
            Some("https://usage.example/api")
        );
    });
}

#[test]
#[serial]
fn add_does_not_clear_token_plan_credentials() {
    with_test_home(|state, _| {
        let provider = codex_provider_with_usage(
            "codex-token-plan",
            "https://api.plan.example/v1",
            "sk-plan",
            Some("sk-plan"),
            Some("https://api.plan.example/v1"),
            Some("token_plan"),
        );

        ProviderService::add(state, AppType::Codex, provider, false).expect("add provider");

        let saved = state
            .db
            .get_provider_by_id("codex-token-plan", AppType::Codex.as_str())
            .expect("query saved provider")
            .expect("saved provider should exist");
        let script = saved
            .meta
            .as_ref()
            .and_then(|meta| meta.usage_script.as_ref())
            .expect("usage script should remain");

        assert_eq!(script.api_key.as_deref(), Some("sk-plan"));
        assert_eq!(
            script.base_url.as_deref(),
            Some("https://api.plan.example/v1")
        );
        assert_eq!(script.access_key_id.as_deref(), Some("ak-test"));
        assert_eq!(script.secret_access_key.as_deref(), Some("sk-test"));
    });
}

#[test]
fn custom_request_header_save_check_follows_the_capability() {
    let overrides = crate::provider::LocalProxyRequestOverrides {
        headers: std::collections::HashMap::from([(
            "Authorization".to_string(),
            "Bearer x".to_string(),
        )]),
        body: None,
    };
    // Off: rows written before the feature existed keep saving.
    assert!(super::validate_request_header_overrides(&overrides, false).is_ok());
    // On: a protected header is rejected by name.
    let error = super::validate_request_header_overrides(&overrides, true)
        .unwrap_err()
        .to_string();
    assert!(error.contains("authorization"), "{error}");
}
#[test]
fn validate_provider_settings_rejects_missing_auth() {
    let provider = Provider::with_id(
        "codex".into(),
        "Codex".into(),
        json!({ "config": "base_url = \"https://example.com\"" }),
        None,
    );
    let err = ProviderService::validate_provider_settings(&AppType::Codex, &provider)
        .expect_err("missing auth should be rejected");
    assert!(
        err.to_string().contains("auth"),
        "expected auth error, got {err:?}"
    );
}

#[test]
fn extract_claude_common_config_strips_all_credentials_keeps_shareable() {
    // env 混入多种凭据（Anthropic/OpenRouter/Google/OpenAI/Gemini + AWS/Vertex）
    // 与可共享配置；顶层混入非标准的 apiKey/api_key 凭据与正常设置。
    let settings = json!({
        "env": {
            "ANTHROPIC_API_KEY": "sk-ant",
            "ANTHROPIC_AUTH_TOKEN": "tok-ant",
            "OPENROUTER_API_KEY": "sk-or",
            "GOOGLE_API_KEY": "g-key",
            "OPENAI_API_KEY": "sk-oai",
            "GEMINI_API_KEY": "g-gem",
            "AWS_ACCESS_KEY_ID": "AKIA",
            "AWS_SECRET_ACCESS_KEY": "secret",
            "AWS_SESSION_TOKEN": "sess",
            "GOOGLE_APPLICATION_CREDENTIALS": "/path/creds.json",
            "AWS_BEARER_TOKEN_BEDROCK": "bedrock-tok",
            "ANTHROPIC_BASE_URL": "https://example.com",
            "ANTHROPIC_MODEL": "claude-x",
            "CLAUDE_CODE_SUBAGENT_MODEL": "gpt-5.4-mini",
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "400000",
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "400000",
            // 可共享、非机密配置（复数 _TOKENS 不应被误剥）
            "ENABLE_TOOL_SEARCH": "true",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8192"
        },
        "apiKey": "sk-top",
        "api_key": "sk-top2",
        "theme": "dark",
        "includeCoAuthoredBy": false
    });

    let snippet =
        ProviderService::extract_claude_common_config(&settings).expect("extract should succeed");
    let value: Value = serde_json::from_str(&snippet).expect("snippet is valid JSON");

    // 所有凭据都不得出现在共享片段里
    let env = value.get("env");
    for leaked in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENROUTER_API_KEY",
        "GOOGLE_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "AWS_BEARER_TOKEN_BEDROCK",
    ] {
        assert!(
            env.and_then(|e| e.get(leaked)).is_none(),
            "credential {leaked} must not leak into common config"
        );
    }
    assert!(
        value.get("apiKey").is_none() && value.get("api_key").is_none(),
        "top-level credentials must be stripped"
    );

    // 端点/模型（provider-specific 非机密）也应剥掉
    assert!(env.and_then(|e| e.get("ANTHROPIC_BASE_URL")).is_none());
    assert!(env.and_then(|e| e.get("ANTHROPIC_MODEL")).is_none());
    assert!(env
        .and_then(|e| e.get("CLAUDE_CODE_SUBAGENT_MODEL"))
        .is_none());
    assert!(env
        .and_then(|e| e.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"))
        .is_none());
    assert!(env
        .and_then(|e| e.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW"))
        .is_none());

    // 可共享的非机密配置必须保留（含复数 _TOKENS 不被误剥）
    assert_eq!(
        env.and_then(|e| e.get("ENABLE_TOOL_SEARCH"))
            .and_then(|v| v.as_str()),
        Some("true")
    );
    assert_eq!(
        env.and_then(|e| e.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS"))
            .and_then(|v| v.as_str()),
        Some("8192")
    );
    assert_eq!(value.get("theme").and_then(|v| v.as_str()), Some("dark"));
    assert_eq!(value.get("includeCoAuthoredBy"), Some(&json!(false)));
}

/// Regression for issue #4272: Fable tier env keys must not enter the shared
/// Claude common-config snippet (same class as haiku/sonnet/opus model pins).
#[test]
fn extract_claude_common_config_strips_fable_model_env_keys() {
    let settings = json!({
        "env": {
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku-mapped",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "Haiku Mapped",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet-mapped[1M]",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Sonnet Mapped",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus-mapped[1M]",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "Opus Mapped",
            "ANTHROPIC_DEFAULT_FABLE_MODEL": "deepseek-v4-flash[1M]",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "deepseek-v4-flash",
            "ANTHROPIC_MODEL": "default-mapped",
            "ENABLE_TOOL_SEARCH": "true"
        },
        "theme": "dark"
    });

    let snippet =
        ProviderService::extract_claude_common_config(&settings).expect("extract should succeed");
    let value: Value = serde_json::from_str(&snippet).expect("snippet is valid JSON");
    let env = value.get("env");

    for stripped in [
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
        "ANTHROPIC_MODEL",
    ] {
        assert!(
            env.and_then(|e| e.get(stripped)).is_none(),
            "provider-specific model key {stripped} must not enter common config"
        );
    }

    assert_eq!(
        env.and_then(|e| e.get("ENABLE_TOOL_SEARCH"))
            .and_then(|v| v.as_str()),
        Some("true")
    );
    assert_eq!(value.get("theme").and_then(|v| v.as_str()), Some("dark"));
}

#[test]
fn validate_provider_settings_rejects_negative_cost_multiplier() {
    let mut provider = Provider::with_id(
        "claude".into(),
        "Claude".into(),
        json!({
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "token",
                "ANTHROPIC_BASE_URL": "https://claude.example"
            }
        }),
        None,
    );
    provider.meta = Some(ProviderMeta {
        cost_multiplier: Some("-1".to_string()),
        ..ProviderMeta::default()
    });

    let err = ProviderService::validate_provider_settings(&AppType::Claude, &provider)
        .expect_err("negative multiplier should be rejected");
    assert!(matches!(
        err,
        AppError::Localized {
            key: "error.invalidMultiplier",
            ..
        }
    ));
}

#[test]
fn extract_codex_common_config_strips_provider_fields_and_injected_artifacts() {
    // 顶层 experimental_bearer_token 模拟无活跃路由时的 fallback 注入；
    // web_search = "disabled" 是 cc-switch 对黑名单网关注入的哨兵；
    // 顶层 wire_api 模拟无 model_provider 时的 fallback 写法；
    // [mcp.servers] 是历史错误格式，sync_all_enabled 清不掉它。
    let config_toml = r#"model_provider = "azure"
model = "gpt-4"
wire_api = "chat"
disable_response_storage = true
model_reasoning_effort = "high"
approval_policy = "on-request"
experimental_bearer_token = "sk-live-secret"
model_catalog_json = "cc-switch-model-catalog.json"
web_search = "disabled"

[model_providers.azure]
name = "Azure OpenAI"
base_url = "https://azure.example/v1"
wire_api = "responses"

[mcp_servers.my_server]
base_url = "http://localhost:8080"

[mcp.servers.legacy_server]
command = "legacy-cmd"
"#;

    let settings = json!({ "config": config_toml });
    let extracted = ProviderService::extract_codex_common_config(&settings)
        .expect("extract_codex_common_config should succeed");

    assert!(
        !extracted
            .lines()
            .any(|line| line.trim_start().starts_with("model_provider")),
        "should remove top-level model_provider"
    );
    assert!(
        !extracted
            .lines()
            .any(|line| line.trim_start().starts_with("model =")),
        "should remove top-level model"
    );
    assert!(
        !extracted.contains("[model_providers"),
        "should remove entire model_providers table"
    );
    // MCP 归 DB mcp_servers 表所有，不得进共享片段（含历史错误格式 [mcp.servers]）
    assert!(
        !extracted.contains("mcp_servers") && !extracted.contains("http://localhost:8080"),
        "should strip mcp_servers from the shared snippet, got: {extracted}"
    );
    assert!(
        !extracted.contains("[mcp") && !extracted.contains("legacy-cmd"),
        "should strip the legacy [mcp.servers] form from the shared snippet, got: {extracted}"
    );
    // 顶层 wire_api 是供应商路由语义（model_providers 整表已剥，
    // 剩余任何 wire_api 都意味着泄漏）
    assert!(
        !extracted.contains("wire_api"),
        "should strip top-level wire_api from the shared snippet, got: {extracted}"
    );
    // 注入产物不得进共享片段（bearer token 泄漏为密钥级问题）
    assert!(
        !extracted.contains("experimental_bearer_token") && !extracted.contains("sk-live-secret"),
        "should strip top-level fallback bearer token, got: {extracted}"
    );
    assert!(
        !extracted.contains("model_catalog_json"),
        "should strip catalog projection pointer, got: {extracted}"
    );
    assert!(
        !extracted.contains("web_search"),
        "should strip the cc-switch web_search disabled sentinel, got: {extracted}"
    );
    crate::codex_key_ownership::validate_codex_common_snippet(&extracted).unwrap();
    // 线路参数剥离，真正可共享的键保留
    assert!(
        !extracted.contains("disable_response_storage")
            && !extracted.contains("model_reasoning_effort")
            && extracted.contains("approval_policy"),
        "shareable keys must survive extraction, got: {extracted}"
    );
}

#[test]
fn extract_codex_common_config_strips_nested_and_profile_line_keys() {
    let input = "[features]\ngoals = true\nnetwork_proxy = true\n[agents]\ndefault_subagent_model = 'mini'\nmax_threads = 8\n[profiles.\"work.prod\"]\nmodel_reasoning_effort = 'high'\nsandbox_mode = 'workspace-write'\n";
    let text = ProviderService::extract_codex_common_config(&json!({"config": input})).unwrap();
    crate::codex_key_ownership::validate_codex_common_snippet(&text).unwrap();
    assert!(!text.contains("goals"));
    assert!(!text.contains("default_subagent_model"));
    assert!(!text.contains("model_reasoning_effort"));
    assert!(text.contains("network_proxy"));
    assert!(text.contains("max_threads"));
    assert!(text.contains("sandbox_mode"));
}

#[test]
fn extract_codex_common_config_keeps_user_set_web_search() {
    let config_toml = "web_search = \"enabled\"\ndisable_response_storage = true\n";
    let settings = json!({ "config": config_toml });
    let extracted =
        ProviderService::extract_codex_common_config(&settings).expect("extract should succeed");
    assert!(
        extracted.contains("web_search = \"enabled\""),
        "a user-set web_search value is a shareable preference, got: {extracted}"
    );
}

#[tokio::test]
#[serial]
async fn update_current_claude_provider_syncs_live_when_proxy_takeover_detected_without_backup() {
    let _home = TempHome::new();
    crate::settings::reload_settings().expect("reload settings");

    let db = Arc::new(Database::memory().expect("init db"));
    // Avoid hard-coding a port that can be occupied on the test host.
    let mut global = db
        .get_global_proxy_config()
        .await
        .expect("get global proxy config");
    global.listen_port = 0;
    db.update_global_proxy_config(global)
        .await
        .expect("use ephemeral proxy port");
    let state = AppState::new(db.clone());

    let original = Provider::with_id(
        "p1".into(),
        "Claude A".into(),
        json!({
            "env": {
                "ANTHROPIC_API_KEY": "token-a",
                "ANTHROPIC_BASE_URL": "https://api.a.example",
                "ANTHROPIC_MODEL": "model-a"
            },
            "permissions": { "allow": ["Bash"] }
        }),
        None,
    );
    db.save_provider("claude", &original)
        .expect("save provider");
    db.set_current_provider("claude", "p1")
        .expect("set current provider");
    crate::settings::set_current_provider(&AppType::Claude, Some("p1"))
        .expect("set local current provider");

    db.update_proxy_config(ProxyConfig {
        live_takeover_active: true,
        listen_port: 0,
        ..Default::default()
    })
    .await
    .expect("update proxy config");
    {
        let mut config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get app proxy config");
        config.enabled = true;
        db.update_proxy_config_for_app(config)
            .await
            .expect("update app proxy config");
    }

    write_json_file(
        &get_claude_settings_path(),
        &json!({
            "env": {
                "ANTHROPIC_BASE_URL": "http://127.0.0.1:15721",
                "ANTHROPIC_API_KEY": "PROXY_MANAGED",
                "ANTHROPIC_MODEL": "stale-model"
            },
            "permissions": { "allow": ["Bash"] }
        }),
    )
    .expect("seed taken-over live file");

    let proxy_info = state
        .proxy_service
        .start()
        .await
        .expect("start proxy service");

    let updated = Provider::with_id(
        "p1".into(),
        "Claude A".into(),
        json!({
            "env": {
                "ANTHROPIC_API_KEY": "token-updated",
                "ANTHROPIC_BASE_URL": "https://api.updated.example",
                "ANTHROPIC_MODEL": "model-updated"
            },
            "permissions": { "allow": ["Read"] }
        }),
        None,
    );

    ProviderService::update(&state, AppType::Claude, None, updated.clone())
        .expect("update current provider");

    let backup = db
        .get_live_backup("claude")
        .await
        .expect("get live backup")
        .expect("backup exists");
    let stored_provider = db
        .get_provider_by_id("p1", "claude")
        .expect("get stored provider")
        .expect("stored provider exists");
    let expected_backup =
        serde_json::to_string(&stored_provider.settings_config).expect("serialize");
    assert_eq!(backup.original_config, expected_backup);

    let live: Value = read_json_file(&get_claude_settings_path()).expect("read live");
    assert_eq!(
        live.get("permissions"),
        updated.settings_config.get("permissions"),
        "provider edits should propagate into Claude live config during takeover"
    );
    assert_eq!(
        live.get("env")
            .and_then(|env| env.get("ANTHROPIC_API_KEY"))
            .and_then(|v| v.as_str()),
        Some("PROXY_MANAGED"),
        "takeover placeholder should stay intact"
    );
    assert_eq!(
        live.get("env")
            .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
            .and_then(|v| v.as_str()),
        Some(format!("http://127.0.0.1:{}", proxy_info.port).as_str()),
        "proxy base URL should stay intact"
    );
    assert!(
        live.get("env")
            .and_then(|env| env.get("ANTHROPIC_MODEL"))
            .is_none(),
        "model override should be removed in takeover live config"
    );
}

#[tokio::test]
#[serial]
async fn update_current_codex_provider_refreshes_and_clears_catalog_during_takeover() {
    let _home = TempHome::new();
    crate::settings::reload_settings().expect("reload settings");

    let db = Arc::new(Database::memory().expect("init db"));
    let state = AppState::new(db.clone());

    let mut original = Provider::with_id(
        "p1".into(),
        "Codex A".into(),
        json!({
            "auth": { "OPENAI_API_KEY": "token-a" },
            "config": r#"model_provider = "custom"
model = "old-model"

[model_providers.custom]
name = "Codex A"
base_url = "https://api.a.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#,
            "modelCatalog": {
                "models": [{ "model": "old-model" }]
            }
        }),
        None,
    );
    original.meta = Some(ProviderMeta {
        api_format: Some("openai_responses".into()),
        common_config_enabled: Some(true),
        ..Default::default()
    });
    db.save_provider("codex", &original).expect("save provider");
    db.set_current_provider("codex", "p1")
        .expect("set current provider");
    crate::settings::set_current_provider(&AppType::Codex, Some("p1"))
        .expect("set local current provider");

    db.update_proxy_config(ProxyConfig {
        live_takeover_active: true,
        listen_port: 0,
        ..Default::default()
    })
    .await
    .expect("update proxy config");
    {
        let mut config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get app proxy config");
        config.enabled = true;
        db.update_proxy_config_for_app(config)
            .await
            .expect("enable Codex proxy config");
    }
    db.save_live_backup(
        "codex",
        &serde_json::to_string(&original.settings_config).expect("serialize backup"),
    )
    .await
    .expect("seed live backup");

    state
        .proxy_service
        .start()
        .await
        .expect("start proxy service");
    state
        .proxy_service
        .sync_codex_live_from_provider_while_proxy_active(&original)
        .await
        .expect("seed taken-over Codex live config");
    assert!(
        state
            .proxy_service
            .detect_takeover_in_live_config_for_app(&AppType::Codex),
        "seeded Codex live config should be recognized as takeover-owned"
    );

    db.set_config_snippet("codex", Some("approval_policy = \"never\"".into()))
        .expect("save common snippet");
    ProviderService::sync_current_provider_for_app(&state, AppType::Codex)
        .expect("sync common snippet during takeover");
    let live_after_common =
        fs::read_to_string(crate::codex_config::get_codex_config_path()).unwrap();
    assert!(live_after_common.contains("approval_policy = \"never\""));
    assert!(state
        .proxy_service
        .detect_takeover_in_live_config_for_app(&AppType::Codex));
    let backup = db.get_live_backup("codex").await.unwrap().unwrap();
    let restored: Value = serde_json::from_str(&backup.original_config).unwrap();
    assert!(restored["config"]
        .as_str()
        .unwrap()
        .contains("approval_policy = \"never\""));

    let mut updated = original.clone();
    updated.settings_config["config"] = json!(
        r#"model_provider = "custom"
model = "gpt-5.4"

[model_providers.custom]
name = "Codex A"
base_url = "https://api.updated.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
    );
    updated.settings_config["modelCatalog"] = json!({
        "models": [{ "model": "gpt-5.4", "displayName": "GPT 5.4" }]
    });

    ProviderService::update(&state, AppType::Codex, None, updated.clone())
        .expect("update current Codex provider mapping");

    let catalog_path = crate::codex_config::get_codex_model_catalog_path();
    let catalog: Value = read_json_file(&catalog_path).expect("read generated catalog");
    assert_eq!(catalog["models"][0]["slug"], "gpt-5.4");
    assert_eq!(
        catalog["models"][0]["input_modalities"],
        json!(["text", "image"]),
        "unknown/GPT models must fail open to image input"
    );
    let live_config = fs::read_to_string(crate::codex_config::get_codex_config_path())
        .expect("read Codex config.toml");
    assert!(live_config.contains("model_catalog_json"));

    updated.settings_config["modelCatalog"] = json!({ "models": [] });
    ProviderService::update(&state, AppType::Codex, None, updated)
        .expect("remove current Codex provider mapping");

    let live_config = fs::read_to_string(crate::codex_config::get_codex_config_path())
        .expect("read Codex config.toml after mapping removal");
    assert!(
        !live_config.contains("model_catalog_json"),
        "removing mappings during takeover must clear the stale catalog pointer"
    );

    state
        .proxy_service
        .stop()
        .await
        .expect("stop proxy service");
}

/// The official takeover keeps the session bucket of the direct form, so
/// toggling unified session history while taken over moves the live
/// takeover route into the new bucket at once (the backup follows too);
/// otherwise sessions created until the release land in the old bucket.
#[tokio::test]
#[serial]
async fn unify_toggle_during_official_takeover_rewrites_the_takeover_route() {
    use crate::codex_config::{codex_official_proxy_route, CodexOfficialProxyRoute};

    async fn backup_config(db: &Database) -> String {
        let backup = db
            .get_live_backup("codex")
            .await
            .expect("read backup")
            .expect("backup exists");
        let value: Value = serde_json::from_str(&backup.original_config).unwrap();
        value["config"].as_str().unwrap_or_default().to_string()
    }
    fn set_unified(unified: bool) {
        let mut settings = crate::settings::get_settings();
        settings.unify_codex_session_history = unified;
        crate::settings::update_settings(settings).expect("update settings");
    }
    let live = || fs::read_to_string(crate::codex_config::get_codex_config_path()).unwrap();

    let _home = TempHome::new();
    crate::settings::reload_settings().expect("reload settings");
    let db = Arc::new(Database::memory().expect("init db"));
    let mut global = db
        .get_global_proxy_config()
        .await
        .expect("get global proxy config");
    global.listen_port = 0;
    db.update_global_proxy_config(global)
        .await
        .expect("use ephemeral proxy port");
    let state = AppState::new(db.clone());

    let mut official = Provider::with_id(
        "codex-official".into(),
        "OpenAI Official".into(),
        json!({ "auth": {}, "config": "model = \"gpt-5.5\"\n" }),
        None,
    );
    official.category = Some("official".into());
    db.save_provider("codex", &official).expect("save official");
    db.set_current_provider("codex", "codex-official")
        .expect("set current provider");
    crate::settings::set_current_provider(&AppType::Codex, Some("codex-official"))
        .expect("set local current provider");
    let auth = json!({"auth_mode": "chatgpt", "tokens": {"access_token": "oauth"}});
    crate::codex_config::write_codex_live_atomic(&auth, Some("model = \"gpt-5.5\"\n"))
        .expect("seed direct live");

    set_unified(false);
    state
        .proxy_service
        .set_takeover_for_app("codex", true)
        .await
        .expect("take over");
    assert!(
        matches!(
            codex_official_proxy_route(&live(), |_| true),
            Some(CodexOfficialProxyRoute::OpenaiBaseUrl(_))
        ),
        "{}",
        live()
    );

    set_unified(true);
    assert!(
        futures::executor::block_on(reapply_current_codex_official_live(&state))
            .expect("reapply with unify on")
    );
    assert_eq!(
        codex_official_proxy_route(&live(), |_| true),
        Some(CodexOfficialProxyRoute::UnifiedMirror),
        "{}",
        live()
    );
    assert!(backup_config(&db)
        .await
        .contains("model_provider = \"custom\""));

    set_unified(false);
    assert!(
        futures::executor::block_on(reapply_current_codex_official_live(&state))
            .expect("reapply with unify off")
    );
    assert!(
        matches!(
            codex_official_proxy_route(&live(), |_| true),
            Some(CodexOfficialProxyRoute::OpenaiBaseUrl(_))
        ),
        "{}",
        live()
    );
    assert!(!backup_config(&db).await.contains("model_provider"));

    state
        .proxy_service
        .set_takeover_for_app("codex", false)
        .await
        .expect("release takeover");
    let restored = live();
    assert!(
        codex_official_proxy_route(&restored, |_| true).is_none(),
        "{restored}"
    );
    assert!(!restored.contains("openai_base_url"), "{restored}");
    // Releasing the last takeover stops the proxy; make sure of it anyway.
    if state.proxy_service.is_running().await {
        state
            .proxy_service
            .stop()
            .await
            .expect("stop proxy service");
    }
}

#[cfg(any(target_os = "macos", windows))]
#[tokio::test]
#[serial]
async fn update_current_claude_desktop_provider_syncs_profile_when_proxy_takeover_is_active() {
    let home = TempHome::new();
    crate::settings::reload_settings().expect("reload settings");

    let db = Arc::new(Database::memory().expect("init db"));
    // Avoid hard-coding a port that can be occupied on the test host.
    let mut global = db
        .get_global_proxy_config()
        .await
        .expect("get global proxy config");
    global.listen_port = 0;
    db.update_global_proxy_config(global)
        .await
        .expect("use ephemeral proxy port");
    let state = AppState::new(db.clone());

    let mut original = Provider::with_id(
        "p1".into(),
        "Desktop A".into(),
        json!({
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "token-a",
                "ANTHROPIC_BASE_URL": "https://opencode.ai/zen/go"
            }
        }),
        None,
    );
    original.meta = Some(ProviderMeta {
        api_format: Some("openai_chat".into()),
        claude_desktop_mode: Some(ClaudeDesktopMode::Proxy),
        claude_desktop_model_routes: std::collections::HashMap::from([(
            "claude-sonnet-4-6".into(),
            ClaudeDesktopModelRoute {
                model: "deepseek-v4-flash".into(),
                label_override: Some("DeepSeek V4 Flash".into()),
                supports_1m: None,
            },
        )]),
        ..Default::default()
    });
    db.save_provider("claude-desktop", &original)
        .expect("save provider");
    db.set_current_provider("claude-desktop", "p1")
        .expect("set current provider");
    crate::settings::set_current_provider(&AppType::ClaudeDesktop, Some("p1"))
        .expect("set local current provider");

    // Claude Desktop keeps backup state from takeover startup; this sentinel only
    // marks takeover as active so provider updates rewrite the 3P profile.
    db.save_live_backup("claude-desktop", "{}")
        .await
        .expect("seed live backup");
    {
        let mut config = db
            .get_proxy_config_for_app("claude-desktop")
            .await
            .expect("get app proxy config");
        config.enabled = true;
        db.update_proxy_config_for_app(config)
            .await
            .expect("update app proxy config");
    }

    let proxy_info = state
        .proxy_service
        .start()
        .await
        .expect("start proxy service");
    let gateway_url = format!("http://127.0.0.1:{}/claude-desktop", proxy_info.port);

    let mut updated = Provider::with_id(
        "p1".into(),
        "Desktop A".into(),
        json!({
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "token-updated",
                "ANTHROPIC_BASE_URL": "https://opencode.ai/zen/go"
            }
        }),
        None,
    );
    updated.meta = Some(ProviderMeta {
        api_format: Some("openai_chat".into()),
        claude_desktop_mode: Some(ClaudeDesktopMode::Proxy),
        claude_desktop_model_routes: std::collections::HashMap::from([(
            "claude-sonnet-4-6".into(),
            ClaudeDesktopModelRoute {
                model: "deepseek-v4-flash".into(),
                label_override: Some("DeepSeek V4 Flash Updated".into()),
                supports_1m: Some(true),
            },
        )]),
        ..Default::default()
    });

    ProviderService::update(&state, AppType::ClaudeDesktop, None, updated.clone())
        .expect("update current provider");

    let backup = db
        .get_live_backup("claude-desktop")
        .await
        .expect("get live backup")
        .expect("backup exists");
    assert_eq!(
        backup.original_config, "{}",
        "Claude Desktop provider edits should not rewrite takeover backup"
    );

    let profile_path = claude_desktop_profile_path(home.dir.path());
    let profile: Value = read_json_file(&profile_path).expect("read desktop profile");
    assert_eq!(
        profile["inferenceGatewayBaseUrl"],
        json!(gateway_url),
        "desktop profile should stay pointed at the local gateway during takeover"
    );
    assert_eq!(profile["inferenceGatewayAuthScheme"], json!("bearer"));
    assert_eq!(
        profile["inferenceModels"],
        json!([{ "name": "claude-sonnet-4-6", "labelOverride": "DeepSeek V4 Flash Updated", "supports1m": true, "prefer1m": true }]),
        "provider edits should propagate into the Claude Desktop 3P profile during takeover"
    );
}

#[test]
#[serial]
fn sync_current_provider_for_app_skips_db_only_opencode_provider() {
    with_test_home(|state, _| {
        let provider = opencode_provider("db-only-opencode");
        ProviderService::add(state, AppType::OpenCode, provider.clone(), false)
            .expect("seed db-only opencode provider");

        ProviderService::sync_current_provider_for_app(state, AppType::OpenCode)
            .expect("sync additive opencode providers");

        let live_providers =
            crate::opencode_config::get_providers().expect("read opencode providers after sync");
        assert!(
            !live_providers.contains_key(&provider.id),
            "db-only opencode provider should not be written to live during sync"
        );
    });
}

#[test]
#[serial]
fn sync_current_provider_for_app_preserves_legacy_live_opencode_provider() {
    with_test_home(|state, _| {
        let provider = opencode_provider("legacy-opencode");
        crate::opencode_config::set_provider(&provider.id, provider.settings_config.clone())
            .expect("seed opencode live provider");
        state
            .db
            .save_provider(AppType::OpenCode.as_str(), &provider)
            .expect("seed legacy opencode provider in db");

        let mut updated = provider.clone();
        updated.settings_config["options"]["apiKey"] = Value::String("updated-key".to_string());
        state
            .db
            .save_provider(AppType::OpenCode.as_str(), &updated)
            .expect("update legacy opencode provider in db");

        ProviderService::sync_current_provider_for_app(state, AppType::OpenCode)
            .expect("sync legacy opencode provider");

        let live_providers =
            crate::opencode_config::get_providers().expect("read opencode providers");
        assert_eq!(
            live_providers
                .get(&provider.id)
                .and_then(|config| config.get("options"))
                .and_then(|options| options.get("apiKey")),
            Some(&Value::String("updated-key".to_string())),
            "legacy provider that already exists in live should still be synced"
        );
    });
}

#[test]
#[serial]
fn sync_current_provider_for_app_restores_legacy_opencode_provider_after_live_reset() {
    with_test_home(|state, _| {
        let provider = opencode_provider("legacy-opencode-reset");
        state
            .db
            .save_provider(AppType::OpenCode.as_str(), &provider)
            .expect("seed legacy opencode provider in db");

        ProviderService::sync_current_provider_for_app(state, AppType::OpenCode)
            .expect("sync legacy opencode provider after reset");

        let live_providers =
            crate::opencode_config::get_providers().expect("read opencode providers");
        assert!(
            live_providers.contains_key(&provider.id),
            "legacy opencode provider should be restored when live config is reset"
        );
    });
}

#[test]
#[serial]
fn import_opencode_providers_from_live_marks_provider_as_live_managed() {
    with_test_home(|state, _| {
        let provider = opencode_provider("imported-opencode");
        crate::opencode_config::set_provider(&provider.id, provider.settings_config.clone())
            .expect("seed opencode live provider");

        let imported = import_opencode_providers_from_live(state)
            .expect("import opencode providers from live");
        assert_eq!(imported, 1);

        let saved = state
            .db
            .get_provider_by_id(&provider.id, AppType::OpenCode.as_str())
            .expect("query imported opencode provider")
            .expect("imported opencode provider should exist");
        assert_eq!(
            saved
                .meta
                .as_ref()
                .and_then(|meta| meta.live_config_managed),
            Some(true),
            "providers imported from live should be treated as live-managed"
        );
    });
}

#[test]
#[serial]
fn import_opencode_providers_from_live_updates_existing_provider_from_live() {
    with_test_home(|state, _| {
        let provider = opencode_provider("existing-opencode");
        state
            .db
            .save_provider(AppType::OpenCode.as_str(), &provider)
            .expect("seed existing opencode provider");

        let mut live_settings = provider.settings_config.clone();
        live_settings.as_object_mut().unwrap().remove("name");
        live_settings["npm"] = Value::String("@ai-sdk/anthropic".to_string());
        live_settings["models"]["gpt-4o"]["name"] = Value::String("Claude Sonnet".to_string());
        crate::opencode_config::set_provider(&provider.id, live_settings)
            .expect("seed edited live opencode provider");

        let updated = import_opencode_providers_from_live(state)
            .expect("import opencode providers from live");
        assert_eq!(updated, 1);

        let saved = state
            .db
            .get_provider_by_id(&provider.id, AppType::OpenCode.as_str())
            .expect("query updated opencode provider")
            .expect("opencode provider should exist");
        assert_eq!(saved.name, provider.name);
        assert_eq!(saved.settings_config["npm"], json!("@ai-sdk/anthropic"));
        assert_eq!(
            saved.settings_config["models"]["gpt-4o"]["name"],
            json!("Claude Sonnet")
        );
    });
}

#[test]
#[serial]
fn update_persists_non_current_omo_variants_in_database() {
    with_test_home(|state, _| {
        for category in ["omo", "omo-slim"] {
            let provider = opencode_omo_provider(&format!("{category}-provider"), category);
            state
                .db
                .save_provider(AppType::OpenCode.as_str(), &provider)
                .unwrap_or_else(|err| panic!("seed {category} provider: {err}"));

            let mut updated = provider.clone();
            updated.name = format!("Updated {category}");
            updated.settings_config["agents"]["writer"]["model"] =
                Value::String(format!("{category}-next-model"));

            ProviderService::update(state, AppType::OpenCode, None, updated)
                .unwrap_or_else(|err| panic!("update {category} provider: {err}"));

            let saved = state
                .db
                .get_provider_by_id(&provider.id, AppType::OpenCode.as_str())
                .unwrap_or_else(|err| panic!("query updated {category} provider: {err}"))
                .unwrap_or_else(|| panic!("{category} provider should exist"));

            assert_eq!(saved.name, format!("Updated {category}"));
            assert_eq!(
                saved.settings_config["agents"]["writer"]["model"],
                Value::String(format!("{category}-next-model")),
                "{category} updates should persist in the database"
            );
        }
    });
}

#[test]
#[serial]
fn update_current_omo_variant_rewrites_config_from_saved_provider() {
    with_test_home(|state, home| {
        for category in ["omo", "omo-slim"] {
            let provider = opencode_omo_provider(&format!("{category}-current"), category);
            state
                .db
                .save_provider(AppType::OpenCode.as_str(), &provider)
                .unwrap_or_else(|err| panic!("seed current {category} provider: {err}"));
            state
                .db
                .set_omo_provider_current(AppType::OpenCode.as_str(), &provider.id, category)
                .unwrap_or_else(|err| panic!("set current {category} provider: {err}"));

            let mut updated = provider.clone();
            updated.name = format!("Current {category} updated");
            updated.settings_config["agents"]["writer"]["model"] =
                Value::String(format!("{category}-saved-model"));
            updated.settings_config["otherFields"]["theme"] =
                Value::String(format!("{category}-light"));

            ProviderService::update(state, AppType::OpenCode, None, updated)
                .unwrap_or_else(|err| panic!("update current {category} provider: {err}"));

            let saved = state
                .db
                .get_provider_by_id(&provider.id, AppType::OpenCode.as_str())
                .unwrap_or_else(|err| panic!("query current {category} provider: {err}"))
                .unwrap_or_else(|| panic!("current {category} provider should exist"));
            assert_eq!(saved.name, format!("Current {category} updated"));

            let written = fs::read_to_string(omo_config_path(home, category))
                .unwrap_or_else(|err| panic!("read written {category} config: {err}"));
            let written_json: Value = serde_json::from_str(&written)
                .unwrap_or_else(|err| panic!("parse written {category} config: {err}"));

            assert_eq!(
                written_json["agents"]["writer"]["model"],
                Value::String(format!("{category}-saved-model")),
                "{category} config should be written from the saved provider state"
            );
            assert_eq!(
                written_json["theme"],
                Value::String(format!("{category}-light")),
                "{category} top-level config should reflect updated otherFields"
            );
        }
    });
}

#[test]
#[serial]
fn update_current_omo_variant_does_not_persist_database_when_file_write_fails() {
    with_test_home(|state, home| {
        let provider = opencode_omo_provider("omo-current", "omo");
        state
            .db
            .save_provider(AppType::OpenCode.as_str(), &provider)
            .unwrap_or_else(|err| panic!("seed current omo provider: {err}"));
        state
            .db
            .set_omo_provider_current(AppType::OpenCode.as_str(), &provider.id, "omo")
            .unwrap_or_else(|err| panic!("set current omo provider: {err}"));

        let config_dir = home.join(".config").join("opencode");
        fs::create_dir_all(config_dir.parent().expect("config dir parent"))
            .expect("create .config dir");
        fs::write(&config_dir, "not a directory").expect("block opencode config dir");

        let mut updated = provider.clone();
        updated.name = "Current omo updated".to_string();
        updated.settings_config["agents"]["writer"]["model"] =
            Value::String("omo-saved-model".to_string());

        ProviderService::update(state, AppType::OpenCode, None, updated)
            .expect_err("update should fail when current omo file write fails");

        let saved = state
            .db
            .get_provider_by_id(&provider.id, AppType::OpenCode.as_str())
            .unwrap_or_else(|err| panic!("query current omo provider: {err}"))
            .unwrap_or_else(|| panic!("current omo provider should exist"));

        assert_eq!(saved.name, provider.name);
        assert_eq!(
            saved.settings_config["agents"]["writer"]["model"],
            provider.settings_config["agents"]["writer"]["model"],
            "database should remain unchanged when file write fails"
        );
    });
}

#[test]
#[serial]
fn update_current_omo_variant_rolls_back_file_when_plugin_sync_fails() {
    with_test_home(|state, home| {
        let provider = opencode_omo_provider("omo-current", "omo");
        state
            .db
            .save_provider(AppType::OpenCode.as_str(), &provider)
            .unwrap_or_else(|err| panic!("seed current omo provider: {err}"));
        state
            .db
            .set_omo_provider_current(AppType::OpenCode.as_str(), &provider.id, "omo")
            .unwrap_or_else(|err| panic!("set current omo provider: {err}"));

        let config_path = omo_config_path(home, "omo");
        fs::create_dir_all(config_path.parent().expect("omo config parent"))
            .expect("create omo config dir");
        let previous_content = serde_json::to_string_pretty(&json!({
            "theme": "legacy-live-theme",
            "agents": {
                "writer": {
                    "model": "legacy-live-model"
                }
            },
            "categories": {
                "default": ["writer"]
            }
        }))
        .expect("serialize previous config");
        fs::write(&config_path, &previous_content).expect("seed previous omo config");

        let opencode_config_path = home.join(".config").join("opencode").join("opencode.json");
        fs::write(&opencode_config_path, "{ invalid json").expect("seed malformed opencode");

        let mut updated = provider.clone();
        updated.name = "Current omo updated".to_string();
        updated.settings_config["agents"]["writer"]["model"] =
            Value::String("omo-saved-model".to_string());
        updated.settings_config["otherFields"]["theme"] = Value::String("omo-light".to_string());

        ProviderService::update(state, AppType::OpenCode, None, updated)
            .expect_err("update should fail when plugin sync fails");

        let saved = state
            .db
            .get_provider_by_id(&provider.id, AppType::OpenCode.as_str())
            .unwrap_or_else(|err| panic!("query current omo provider: {err}"))
            .unwrap_or_else(|| panic!("current omo provider should exist"));

        assert_eq!(saved.name, provider.name);
        assert_eq!(
            saved.settings_config["agents"]["writer"]["model"],
            provider.settings_config["agents"]["writer"]["model"],
            "database should remain unchanged when plugin sync fails"
        );

        let written =
            fs::read_to_string(&config_path).expect("read rolled back omo config content");
        assert_eq!(
            written, previous_content,
            "OMO config should roll back to its previous on-disk contents"
        );
    });
}
#[test]
#[serial]
fn switch_omo_target_write_failure_preserves_active_variant() {
    with_test_home(|state, home| {
        for (category, opposite) in [("omo", "omo-slim"), ("omo-slim", "omo")] {
            let target = opencode_omo_provider(&format!("{category}-next"), category);
            let current = opencode_omo_provider(&format!("{opposite}-old"), opposite);
            state.db.save_provider("opencode", &target).unwrap();
            state.db.save_provider("opencode", &current).unwrap();
            state
                .db
                .set_omo_provider_current("opencode", &current.id, opposite)
                .unwrap();
            let target_path = omo_config_path(home, category);
            let old_path = omo_config_path(home, opposite);
            fs::create_dir_all(&target_path).unwrap();
            fs::write(&old_path, "{\"old\": true}").unwrap();
            let plugin_path = target_path.parent().unwrap().join("opencode.json");
            let plugin_bytes = format!(
                r#"{{"plugin":["oh-my-opencode{}","keep-me"]}}"#,
                if opposite == "omo-slim" { "-slim" } else { "" }
            );
            fs::write(&plugin_path, &plugin_bytes).unwrap();
            let providers = IndexMap::from([(target.id.clone(), target.clone())]);

            ProviderService::switch_normal(state, AppType::OpenCode, &target.id, &providers)
                .expect_err("a blocked target must leave the current variant usable");

            assert!(state
                .db
                .is_omo_provider_current("opencode", &current.id, opposite)
                .unwrap());
            assert!(!state
                .db
                .is_omo_provider_current("opencode", &target.id, category)
                .unwrap());
            assert_eq!(fs::read_to_string(&old_path).unwrap(), "{\"old\": true}");
            assert_eq!(fs::read_to_string(&plugin_path).unwrap(), plugin_bytes);
            assert!(target_path.is_dir());
            fs::remove_dir(&target_path).unwrap();
            fs::remove_file(&old_path).unwrap();
        }
    });
}

#[test]
#[serial]
fn switch_omo_disable_failure_does_not_write_target_or_change_selection() {
    with_test_home(|state, home| {
        let target = opencode_omo_provider("omo-next", "omo");
        let current = opencode_omo_provider("slim-current", "omo-slim");
        state.db.save_provider("opencode", &target).unwrap();
        state.db.save_provider("opencode", &current).unwrap();
        state
            .db
            .set_omo_provider_current("opencode", &current.id, "omo-slim")
            .unwrap();
        let target_path = omo_config_path(home, "omo");
        let blocked = omo_config_path(home, "omo-slim");
        fs::create_dir_all(&blocked).unwrap();
        fs::write(&target_path, "{\"savedBefore\": true}").unwrap();
        let plugin_path = blocked.parent().unwrap().join("opencode.json");
        let plugins = r#"{"plugin":["oh-my-opencode-slim","other-plugin"]}"#;
        fs::write(&plugin_path, plugins).unwrap();
        let providers = IndexMap::from([(target.id.clone(), target.clone())]);

        ProviderService::switch_normal(state, AppType::OpenCode, &target.id, &providers)
            .expect_err("failure to disable the old variant must be reported");

        assert!(state
            .db
            .is_omo_provider_current("opencode", &current.id, "omo-slim")
            .unwrap());
        assert!(!state
            .db
            .is_omo_provider_current("opencode", &target.id, "omo")
            .unwrap());
        assert_eq!(
            fs::read_to_string(target_path).unwrap(),
            "{\"savedBefore\": true}"
        );
        assert_eq!(fs::read_to_string(plugin_path).unwrap(), plugins);
        assert!(blocked.is_dir());
    });
}

#[test]
#[serial]
fn switch_omo_invalid_plugin_config_leaves_all_variants_unchanged() {
    with_test_home(|state, home| {
        let target = opencode_omo_provider("slim-next", "omo-slim");
        let current = opencode_omo_provider("omo-current", "omo");
        state.db.save_provider("opencode", &target).unwrap();
        state.db.save_provider("opencode", &current).unwrap();
        state
            .db
            .set_omo_provider_current("opencode", &current.id, "omo")
            .unwrap();
        let target_path = omo_config_path(home, "omo-slim");
        let current_path = omo_config_path(home, "omo");
        fs::create_dir_all(current_path.parent().unwrap()).unwrap();
        fs::write(&target_path, "{\"targetBefore\": 1}").unwrap();
        fs::write(&current_path, "{\"currentBefore\": 2}").unwrap();
        let plugin_path = current_path.parent().unwrap().join("opencode.json");
        fs::write(&plugin_path, "{ broken").unwrap();
        let providers = IndexMap::from([(target.id.clone(), target.clone())]);

        ProviderService::switch_normal(state, AppType::OpenCode, &target.id, &providers)
            .expect_err("invalid plugin JSON must fail before any file change");

        assert!(state
            .db
            .is_omo_provider_current("opencode", &current.id, "omo")
            .unwrap());
        assert_eq!(
            fs::read_to_string(target_path).unwrap(),
            "{\"targetBefore\": 1}"
        );
        assert_eq!(
            fs::read_to_string(current_path).unwrap(),
            "{\"currentBefore\": 2}"
        );
        assert_eq!(fs::read_to_string(plugin_path).unwrap(), "{ broken");
    });
}

#[test]
#[serial]
fn switch_omo_selection_failure_restores_unified_config_and_plugins() {
    with_test_home(|state, home| {
        let target = opencode_omo_provider("removed-slim", "omo-slim");
        let current = opencode_omo_provider("omo-current", "omo");
        state.db.save_provider("opencode", &current).unwrap();
        state
            .db
            .set_omo_provider_current("opencode", &current.id, "omo")
            .unwrap();
        let target_path = omo_config_path(home, "omo-slim");
        fs::create_dir_all(target_path.parent().unwrap()).unwrap();
        let unified_path = home.join(".omo").join("omo.jsonc");
        fs::create_dir_all(unified_path.parent().unwrap()).unwrap();
        let unified = "{\n  // keep other tools\n  \"[opencode]\": {\"agents\": {\"writer\": {\"model\": \"old\"}}},\n  \"[claude]\": {\"enabled\": true}\n}\n";
        fs::write(&unified_path, unified).unwrap();
        let plugin_path = target_path.parent().unwrap().join("opencode.json");
        let plugins = r#"{"plugin":["oh-my-opencode@latest","other-plugin"],"theme":"dark"}"#;
        fs::write(&plugin_path, plugins).unwrap();
        let providers = IndexMap::from([(target.id.clone(), target.clone())]);

        // The stale UI still knows the target, but it was removed from the DB.
        ProviderService::switch_normal(state, AppType::OpenCode, &target.id, &providers)
            .expect_err("a failed database selection must restore every file");

        assert!(state
            .db
            .is_omo_provider_current("opencode", &current.id, "omo")
            .unwrap());
        assert!(!target_path.exists());
        assert_eq!(fs::read_to_string(unified_path).unwrap(), unified);
        assert_eq!(fs::read_to_string(plugin_path).unwrap(), plugins);
    });
}

#[test]
#[serial]
fn switch_omo_success_keeps_unrelated_plugins_and_excludes_opposite_variant() {
    with_test_home(|state, home| {
        for (category, opposite, plugin) in [
            ("omo", "omo-slim", "oh-my-openagent@latest"),
            ("omo-slim", "omo", "oh-my-opencode-slim@latest"),
        ] {
            let target = opencode_omo_provider(&format!("{category}-next"), category);
            let current = opencode_omo_provider(&format!("{opposite}-old"), opposite);
            state.db.save_provider("opencode", &target).unwrap();
            state.db.save_provider("opencode", &current).unwrap();
            state
                .db
                .set_omo_provider_current("opencode", &current.id, opposite)
                .unwrap();
            let old_path = omo_config_path(home, opposite);
            fs::create_dir_all(old_path.parent().unwrap()).unwrap();
            fs::write(&old_path, "{}").unwrap();
            let plugin_path = old_path.parent().unwrap().join("opencode.json");
            fs::write(&plugin_path, r#"{"plugin":["oh-my-opencode@old","oh-my-opencode-slim@old","keep-me"],"theme":"dark"}"#).unwrap();
            let providers = IndexMap::from([(target.id.clone(), target.clone())]);

            ProviderService::switch_normal(state, AppType::OpenCode, &target.id, &providers)
                .expect("switch both variants successfully");

            assert!(state
                .db
                .is_omo_provider_current("opencode", &target.id, category)
                .unwrap());
            assert!(!state
                .db
                .is_omo_provider_current("opencode", &current.id, opposite)
                .unwrap());
            assert!(!old_path.exists());
            let written: Value =
                serde_json::from_str(&fs::read_to_string(omo_config_path(home, category)).unwrap())
                    .unwrap();
            assert_eq!(written["agents"]["writer"]["model"], "gpt-4o-mini");
            let config: Value =
                serde_json::from_str(&fs::read_to_string(&plugin_path).unwrap()).unwrap();
            assert_eq!(config["plugin"], json!(["keep-me", plugin]));
            assert_eq!(config["theme"], "dark");
            fs::remove_file(omo_config_path(home, category)).unwrap();
        }
    });
}
