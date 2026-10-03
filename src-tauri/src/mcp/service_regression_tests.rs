//! These tests never change HOME or resolve production client paths.
use super::*;
use crate::app_config::McpApps;
use crate::database::Database;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

struct Targets;
impl Targets {
    fn new(paths: HashMap<AppType, PathBuf>) -> Self {
        mcp::projection::TEST_TARGETS.with(|target| *target.borrow_mut() = Some(paths));
        Self
    }
}
impl Drop for Targets {
    fn drop(&mut self) {
        mcp::projection::TEST_TARGETS.with(|target| *target.borrow_mut() = None);
    }
}
fn state() -> AppState {
    AppState::new(Arc::new(Database::memory().unwrap()))
}
fn server(id: &str, command: &str, apps: McpApps) -> McpServer {
    McpServer {
        id: id.into(),
        name: id.into(),
        server: json!({"command":command}),
        apps,
        description: None,
        homepage: None,
        docs: None,
        tags: vec![],
    }
}
fn clients() -> McpApps {
    McpApps {
        claude: true,
        gemini: true,
        ..Default::default()
    }
}

#[test]
fn new_and_batch_failure_restore_db_ledger_and_exact_file_states() {
    for existed in [false, true] {
        for batch in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let claude = dir.path().join("claude.json");
            let gemini = dir.path().join("gemini.json");
            let original = b"{\n \"mcpServers\": {\"foreign\": {\"command\": \"external\"}}, \"other\": true\n}\n";
            if existed {
                std::fs::write(&claude, original).unwrap();
            }
            std::fs::write(&gemini, b"{invalid").unwrap();
            let _targets = Targets::new(HashMap::from([
                (AppType::Claude, claude.clone()),
                (AppType::Gemini, gemini.clone()),
            ]));
            let state = state();
            let servers = if batch {
                vec![server("a", "a", clients()), server("b", "b", clients())]
            } else {
                vec![server("a", "a", clients())]
            };
            assert!(McpService::upsert_servers_atomic(&state, &servers).is_err());
            assert!(state.db.get_all_mcp_servers().unwrap().is_empty());
            assert!(state
                .db
                .get_setting(mcp::projection::LEDGER_KEY)
                .unwrap()
                .is_none());
            assert_eq!(
                std::fs::read(&claude).ok().as_deref(),
                existed.then_some(original.as_slice())
            );
            assert_eq!(std::fs::read(&gemini).unwrap(), b"{invalid");
        }
    }
}

#[test]
fn failed_update_and_delete_restore_previous_version_and_ledger() {
    let dir = tempfile::tempdir().unwrap();
    let claude = dir.path().join("claude.json");
    let gemini = dir.path().join("gemini.json");
    let _targets = Targets::new(HashMap::from([
        (AppType::Claude, claude.clone()),
        (AppType::Gemini, gemini.clone()),
    ]));
    let state = state();
    let initial = server("foo", "original", clients());
    McpService::upsert_server(&state, initial.clone()).unwrap();
    let bytes = std::fs::read(&claude).unwrap();
    let ledger = state.db.get_setting(mcp::projection::LEDGER_KEY).unwrap();
    std::fs::write(&gemini, b"invalid").unwrap();
    assert!(McpService::upsert_server(&state, server("foo", "new", clients())).is_err());
    assert_eq!(std::fs::read(&claude).unwrap(), bytes);
    assert!(McpService::delete_server(&state, "foo").is_err());
    assert_eq!(std::fs::read(&claude).unwrap(), bytes);
    assert_eq!(
        state.db.get_all_mcp_servers().unwrap()["foo"].server,
        initial.server
    );
    assert_eq!(
        state.db.get_setting(mcp::projection::LEDGER_KEY).unwrap(),
        ledger
    );
}

#[test]
fn unrelated_foreign_ids_survive_toggle_and_full_reprojection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("claude.json");
    std::fs::write(&path, br#"{"mcpServers":{"foo":{"command":"external"}}}"#).unwrap();
    let _targets = Targets::new(HashMap::from([(AppType::Claude, path.clone())]));
    let state = state();
    state
        .db
        .save_mcp_server(&server("foo", "different", McpApps::default()))
        .unwrap();
    state
        .db
        .save_mcp_server(&server("bar", "bar", McpApps::default()))
        .unwrap();
    McpService::toggle_app(&state, "bar", AppType::Claude, true).unwrap();
    McpService::sync_enabled_for_app(&state, &AppType::Claude).unwrap();
    let live: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(live["mcpServers"]["foo"]["command"], "external");
    assert_eq!(live["mcpServers"]["bar"]["command"], "bar");
}

#[test]
fn other_app_enable_disable_and_import_preserve_codex_intent() {
    let original = server(
        "foo",
        "run",
        McpApps {
            codex: true,
            ..Default::default()
        },
    );
    let off = codex_toggle_target(&original, false);
    for app in [
        AppType::Claude,
        AppType::Gemini,
        AppType::GrokBuild,
        AppType::OpenCode,
        AppType::Hermes,
    ] {
        let shared = app_toggle_target(&off, &app, true);
        assert!(!is_codex_enabled(&shared));
        assert!(shared.apps.is_enabled_for(&app));
        let alone = app_toggle_target(&shared, &app, false);
        assert!(!is_codex_enabled(&alone));
        assert!(is_codex_enabled(&codex_toggle_target(&alone, true)));
        let state = state();
        state.db.save_mcp_server(&off).unwrap();
        let imported = HashMap::from([("foo".into(), original.clone())]);
        let _guard = lock_operation().unwrap();
        McpService::save_imported_servers(&state, &imported, &app).unwrap();
        let merged = state
            .db
            .get_all_mcp_servers()
            .unwrap()
            .shift_remove("foo")
            .unwrap();
        assert!(!is_codex_enabled(&merged));
        assert!(merged.apps.is_enabled_for(&app));
    }
}

#[test]
fn conflicting_import_is_preflighted_without_partial_merges_or_alias_enabling() {
    let state = state();
    let _guard = lock_operation().unwrap();
    let original = server("foo", "first", McpApps::default());
    state.db.save_mcp_server(&original).unwrap();
    let incoming = HashMap::from([
        ("new".into(), server("new", "new", clients())),
        ("foo".into(), server("foo", "other", clients())),
    ]);
    assert!(McpService::save_imported_servers(&state, &incoming, &AppType::Gemini).is_err());
    let rows = state.db.get_all_mcp_servers().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows["foo"].server, original.server);
    assert_eq!(rows["foo"].apps, original.apps);
    let alias = HashMap::from([("alias".into(), server("alias", "first", clients()))]);
    assert_eq!(
        McpService::save_imported_servers(&state, &alias, &AppType::Gemini).unwrap(),
        0
    );
    assert!(!state.db.get_all_mcp_servers().unwrap()["foo"].apps.gemini);
    let mut secret = original.clone();
    secret.server["env"] = json!({"TOKEN":"different"});
    assert!(matches!(
        import_target(&rows, &secret),
        ImportTarget::Conflict
    ));
}

#[test]
fn rollback_cannot_overwrite_a_later_successful_operation() {
    use std::sync::{mpsc, Barrier};
    let state = state();
    state
        .db
        .save_mcp_server(&server("foo", "initial", McpApps::default()))
        .unwrap();
    let gate = Arc::new(Barrier::new(2));
    let (started_tx, started_rx) = mpsc::channel();
    let guard = lock_operation().unwrap();
    let worker_state = state.clone();
    let worker_gate = gate.clone();
    let worker = std::thread::spawn(move || {
        let _targets = Targets::new(HashMap::new());
        worker_gate.wait();
        started_tx.send(()).unwrap();
        McpService::upsert_server(&worker_state, server("foo", "success", McpApps::default()))
            .unwrap();
        McpService::sync_enabled_for_app(&worker_state, &AppType::Claude).unwrap();
    });
    let failed: Result<(), AppError> = McpService::transaction(&state, |state| {
        state
            .db
            .save_mcp_server(&server("foo", "failed", McpApps::default()))?;
        gate.wait();
        started_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(MCP_OPERATION.try_lock().is_err());
        Err(AppError::Message("injected failure".into()))
    });
    assert!(failed.is_err());
    assert_eq!(
        state.db.get_all_mcp_servers().unwrap()["foo"].server["command"],
        "initial"
    );
    drop(guard);
    worker.join().unwrap();
    assert_eq!(
        state.db.get_all_mcp_servers().unwrap()["foo"].server["command"],
        "success"
    );
}

#[test]
fn ledger_save_failure_undoes_new_file_in_mutation_and_repair_paths() {
    for repair in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claude.json");
        let _targets = Targets::new(HashMap::from([(AppType::Claude, path.clone())]));
        let state = state();
        let item = server(
            "foo",
            "run",
            McpApps {
                claude: true,
                ..Default::default()
            },
        );
        state
            .db
            .conn
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER fail_mcp_ledger BEFORE INSERT ON settings
             WHEN NEW.key = 'mcp_client_projection_ledger'
             BEGIN SELECT RAISE(FAIL, 'injected ledger write failure'); END;",
            )
            .unwrap();
        if repair {
            state.db.save_mcp_server(&item).unwrap();
            assert!(McpService::sync_enabled_for_app(&state, &AppType::Claude).is_err());
            assert!(state.db.get_all_mcp_servers().unwrap().contains_key("foo"));
        } else {
            assert!(McpService::upsert_server(&state, item).is_err());
            assert!(state.db.get_all_mcp_servers().unwrap().is_empty());
        }
        assert!(!path.exists());
        assert!(state
            .db
            .get_setting(mcp::projection::LEDGER_KEY)
            .unwrap()
            .is_none());
    }
}

#[test]
fn batch_db_failure_restores_earlier_rows_before_any_projection() {
    let _targets = Targets::new(HashMap::new());
    let state = state();
    state
        .db
        .conn
        .lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER fail_second_mcp BEFORE INSERT ON mcp_servers
         WHEN NEW.id = 'b' BEGIN SELECT RAISE(FAIL, 'injected row write failure'); END;",
        )
        .unwrap();
    let result = McpService::upsert_servers_atomic(
        &state,
        &[server("a", "a", clients()), server("b", "b", clients())],
    );
    assert!(result.is_err());
    assert!(state.db.get_all_mcp_servers().unwrap().is_empty());
}

#[test]
fn provider_reprojection_completes_while_mutation_waits_for_client_lock() {
    use std::sync::{mpsc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("claude.json");
    let paths = HashMap::from([(AppType::Claude, path.clone())]);
    let _targets = Targets::new(paths.clone());
    let state = state();
    let apps = McpApps {
        claude: true,
        ..Default::default()
    };
    McpService::upsert_server(&state, server("foo", "initial", apps.clone())).unwrap();
    let provider_lock =
        futures::executor::block_on(state.proxy_service.lock_switch_for_app("claude"));
    let gate = Arc::new(Barrier::new(2));
    let worker_gate = gate.clone();
    let worker_state = state.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _targets = Targets::new(paths);
        worker_gate.wait();
        started_tx.send(()).unwrap();
        McpService::upsert_server(&worker_state, server("foo", "next", apps)).unwrap();
    });
    gate.wait();
    started_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    McpService::sync_enabled_for_app(&state, &AppType::Claude).unwrap();
    drop(provider_lock);
    worker.join().unwrap();
    let live: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(live["mcpServers"]["foo"]["command"], "next");
}

#[test]
fn codex_conflicts_reach_service_and_ipc_without_changing_db_or_external_content() {
    use crate::commands::{
        delete_mcp_server_result, toggle_mcp_app_result, upsert_mcp_server_result,
    };
    for recorded in [false, true] {
        for ipc in [false, true] {
            for operation in ["update", "disable", "enable", "delete"] {
                let dir = tempfile::tempdir().unwrap();
                let codex = dir.path().join("config.toml");
                let claude = dir.path().join("claude.json");
                let external = b"# user content\n[mcp_servers.foo]\ncommand = 'external'\n";
                std::fs::write(&codex, external).unwrap();
                let _targets = Targets::new(HashMap::from([
                    (AppType::Codex, codex.clone()),
                    (AppType::Claude, claude.clone()),
                ]));
                let state = state();
                let mut original = server(
                    "foo",
                    "original",
                    McpApps {
                        codex: true,
                        // Update/delete also exercise rollback of an earlier client write.
                        claude: matches!(operation, "update" | "delete"),
                        ..Default::default()
                    },
                );
                if operation == "enable" {
                    original.server["enabled"] = false.into();
                }
                state.db.save_mcp_server(&original).unwrap();
                McpService::sync_enabled_for_app(&state, &AppType::Claude).unwrap();
                if recorded {
                    let ledger: mcp::CodexMcpLedger = serde_json::from_value(json!({
                        "servers": {"foo": "previous-owned-hash"}, "conflicts": []
                    }))
                    .unwrap();
                    ledger.save(&state.db).unwrap();
                }
                let before =
                    serde_json::to_value(McpService::get_all_servers(&state).unwrap()).unwrap();
                let claude_before = std::fs::read(&claude).ok();
                let ledger_before = state
                    .db
                    .get_setting(mcp::CODEX_MCP_PROJECTION_LEDGER_KEY)
                    .unwrap();
                let client_ledger_before =
                    state.db.get_setting(mcp::projection::LEDGER_KEY).unwrap();
                let mut changed = original.clone();
                changed.server["command"] = "updated".into();
                let result: Result<(), String> = match (ipc, operation) {
                    (true, "update") => upsert_mcp_server_result(&state, changed),
                    (false, "update") => {
                        McpService::upsert_server(&state, changed).map_err(|e| e.to_string())
                    }
                    (true, "delete") => delete_mcp_server_result(&state, "foo").map(|_| ()),
                    (false, "delete") => McpService::delete_server(&state, "foo")
                        .map(|_| ())
                        .map_err(|e| e.to_string()),
                    (true, _) => {
                        toggle_mcp_app_result(&state, "foo", "codex", operation == "enable")
                    }
                    (false, _) => {
                        McpService::toggle_app(&state, "foo", AppType::Codex, operation == "enable")
                            .map_err(|e| e.to_string())
                    }
                };
                let error = result.unwrap_err();
                assert!(
                    error.contains("Codex MCP ownership conflict for 'foo'"),
                    "{error}"
                );
                assert_eq!(std::fs::read(&codex).unwrap(), external);
                assert_eq!(std::fs::read(&claude).ok(), claude_before);
                assert_eq!(
                    serde_json::to_value(McpService::get_all_servers(&state).unwrap()).unwrap(),
                    before
                );
                assert_eq!(
                    state
                        .db
                        .get_setting(mcp::CODEX_MCP_PROJECTION_LEDGER_KEY)
                        .unwrap(),
                    ledger_before
                );
                assert_eq!(
                    state.db.get_setting(mcp::projection::LEDGER_KEY).unwrap(),
                    client_ledger_before
                );
            }
        }
    }
}

#[test]
fn single_client_repair_continues_after_multiple_errors_and_keeps_successes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("claude.json");
    let _targets = Targets::new(HashMap::from([(AppType::Claude, path.clone())]));
    std::fs::write(&path, br#"{"mcpServers":{"b":{"command":"external-b"},"c":{"command":"external-c"},"foreign":{"command":"untouched"}}}"#).unwrap();
    let state = state();
    for id in ["a", "b", "c", "d"] {
        state
            .db
            .save_mcp_server(&server(
                id,
                id,
                McpApps {
                    claude: true,
                    ..Default::default()
                },
            ))
            .unwrap();
    }
    let before = serde_json::to_value(state.db.get_all_mcp_servers().unwrap()).unwrap();
    let error = McpService::sync_enabled_for_app(&state, &AppType::Claude)
        .unwrap_err()
        .to_string();
    assert!(error.contains("b:") && error.contains("c:"), "{error}");
    let live: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(live["mcpServers"]["a"]["command"], "a");
    assert_eq!(live["mcpServers"]["d"]["command"], "d");
    assert_eq!(live["mcpServers"]["b"]["command"], "external-b");
    assert_eq!(live["mcpServers"]["c"]["command"], "external-c");
    assert_eq!(live["mcpServers"]["foreign"]["command"], "untouched");
    assert_eq!(
        serde_json::to_value(state.db.get_all_mcp_servers().unwrap()).unwrap(),
        before
    );
    // Successful rows retained their ownership, so a subsequent user update works.
    McpService::upsert_server(
        &state,
        server(
            "a",
            "updated",
            McpApps {
                claude: true,
                ..Default::default()
            },
        ),
    )
    .unwrap();
}

#[test]
fn user_batch_remains_atomic_when_a_later_server_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("claude.json");
    let _targets = Targets::new(HashMap::from([(AppType::Claude, path.clone())]));
    let original = br#"{"mcpServers":{"b":{"command":"external"}}}"#;
    std::fs::write(&path, original).unwrap();
    let state = state();
    let apps = McpApps {
        claude: true,
        ..Default::default()
    };
    let error = McpService::upsert_servers_atomic(
        &state,
        &[
            server("a", "first", apps.clone()),
            server("b", "conflicting", apps.clone()),
            server("c", "last", apps),
        ],
    )
    .unwrap_err();
    assert!(error.to_string().contains('b'));
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert!(state.db.get_all_mcp_servers().unwrap().is_empty());
    assert!(state
        .db
        .get_setting(mcp::projection::LEDGER_KEY)
        .unwrap()
        .is_none());
}

#[test]
fn codex_repair_reports_each_conflict_but_ignores_unmanaged_disabled_names() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.toml");
    let _targets = Targets::new(HashMap::from([(AppType::Codex, path.clone())]));
    let external = b"# external\n[mcp_servers.a]\ncommand = 'external-a'\n[mcp_servers.b]\ncommand = 'external-b'\n[mcp_servers.foreign]\ncommand = 'keep'\n";
    std::fs::write(&path, external).unwrap();
    let state = state();
    for id in ["a", "b", "foreign"] {
        state
            .db
            .save_mcp_server(&server(
                id,
                "managed",
                McpApps {
                    codex: id != "foreign",
                    ..Default::default()
                },
            ))
            .unwrap();
    }
    let before = serde_json::to_value(state.db.get_all_mcp_servers().unwrap()).unwrap();
    let error = McpService::sync_enabled_for_app(&state, &AppType::Codex)
        .unwrap_err()
        .to_string();
    assert!(error.contains("ownership conflict for 'a'"), "{error}");
    assert!(error.contains("ownership conflict for 'b'"), "{error}");
    assert!(!error.contains("foreign"), "{error}");
    assert_eq!(std::fs::read(&path).unwrap(), external);
    assert_eq!(
        serde_json::to_value(state.db.get_all_mcp_servers().unwrap()).unwrap(),
        before
    );
    let ledger = mcp::CodexMcpLedger::load(&state.db).unwrap();
    assert!(ledger.servers.is_empty());
    assert!(ledger.conflicts.is_empty());
}
