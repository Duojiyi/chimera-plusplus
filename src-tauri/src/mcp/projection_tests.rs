use super::*;
use serde_json::json;

fn plan(
    app: &AppType,
    snapshot: FileSnapshot,
    id: &str,
    spec: Option<&Value>,
    owned: &mut BTreeMap<String, String>,
) -> Result<Option<AppliedChangeset>, AppError> {
    plan_with_previous(app, snapshot, id, spec, owned, None)
}

#[test]
fn foreign_disabled_id_is_untouched_in_every_client_format() {
    for (app, text) in [
        (
            AppType::Claude,
            r#"{"mcpServers":{"foreign":{"command":"external"}},"other":1}"#,
        ),
        (
            AppType::Gemini,
            r#"{"mcpServers":{"foreign":{"command":"external"}},"other":1}"#,
        ),
        (
            AppType::OpenCode,
            "{ // comment\n mcp: {foreign: {type: 'local', command: ['external']}}}",
        ),
        (
            AppType::GrokBuild,
            "# keep me\n[mcp_servers.foreign]\ncommand = 'external'\n",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, text).unwrap();
        let mut owned = BTreeMap::new();
        assert!(plan(
            &app,
            FileSnapshot::read(&path).unwrap(),
            "foreign",
            None,
            &mut owned
        )
        .unwrap()
        .is_none());
        assert_eq!(std::fs::read(&path).unwrap(), text.as_bytes());
        assert!(owned.is_empty());
        assert!(plan(
            &app,
            FileSnapshot::read(&path).unwrap(),
            "foreign",
            Some(&json!({"command":"managed"})),
            &mut owned
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), text.as_bytes());
    }
}

#[test]
fn external_edit_blocks_owned_update_and_removal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let mut owned = BTreeMap::new();
    plan(
        &AppType::Gemini,
        FileSnapshot::read(&path).unwrap(),
        "foo",
        Some(&json!({"command":"managed"})),
        &mut owned,
    )
    .unwrap();
    let external = br#"{"mcpServers":{"foo":{"command":"external"}}}"#;
    std::fs::write(&path, external).unwrap();
    for spec in [None, Some(json!({"command":"new"}))] {
        assert!(plan(
            &AppType::Gemini,
            FileSnapshot::read(&path).unwrap(),
            "foo",
            spec.as_ref(),
            &mut owned
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), external);
    }
}

#[test]
fn rollback_restores_bytes_or_missing_file_and_rejects_external_changes() {
    for original in [None, Some(b"{\n \"other\": 1\n}\n".as_slice())] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        if let Some(bytes) = original {
            std::fs::write(&path, bytes).unwrap();
        }
        let mut owned = BTreeMap::new();
        let applied = plan(
            &AppType::Claude,
            FileSnapshot::read(&path).unwrap(),
            "new",
            Some(&json!({"command":"run"})),
            &mut owned,
        )
        .unwrap()
        .unwrap();
        applied.rollback().unwrap();
        assert_eq!(std::fs::read(&path).ok().as_deref(), original);
        let applied = plan(
            &AppType::Claude,
            FileSnapshot::read(&path).unwrap(),
            "new",
            Some(&json!({"command":"run"})),
            &mut owned,
        )
        .unwrap()
        .unwrap();
        std::fs::write(&path, b"external writer").unwrap();
        assert!(applied.rollback().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"external writer");
    }
}

#[test]
fn snapshot_cas_rejects_intervening_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let observed = FileSnapshot::read(&path).unwrap();
    std::fs::write(&path, b"{}").unwrap();
    assert!(plan(
        &AppType::Gemini,
        observed,
        "new",
        Some(&json!({"command":"run"})),
        &mut BTreeMap::new()
    )
    .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"{}");
}

#[test]
fn codex_soft_disable_does_not_disable_other_clients() {
    for app in [
        AppType::Claude,
        AppType::Gemini,
        AppType::OpenCode,
        AppType::GrokBuild,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        let mut owned = BTreeMap::new();
        let disabled = json!({"type":"stdio", "command":"run", "enabled":false});
        plan(
            &app,
            FileSnapshot::read(&path).unwrap(),
            "foo",
            Some(&disabled),
            &mut owned,
        )
        .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("false"), "{}: {text}", app.as_str());
        assert_eq!(disabled["enabled"], false);
        // Ownership hash must match the serialized/read-back entry on deletion.
        plan(
            &app,
            FileSnapshot::read(&path).unwrap(),
            "foo",
            None,
            &mut owned,
        )
        .unwrap();
        assert!(owned.is_empty());
    }
}

#[test]
fn migration_requires_matching_previous_enabled_projection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let original = br#"{"mcpServers":{"foo":{"command":"old"}}}"#;
    std::fs::write(&path, original).unwrap();
    let mut owned = BTreeMap::new();
    assert!(plan_with_previous(
        &AppType::Claude,
        FileSnapshot::read(&path).unwrap(),
        "foo",
        Some(&json!({"command":"new"})),
        &mut owned,
        Some(&json!({"command":"different"}))
    )
    .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);
    let applied = plan_with_previous(
        &AppType::Claude,
        FileSnapshot::read(&path).unwrap(),
        "foo",
        Some(&json!({"command":"new"})),
        &mut owned,
        Some(&json!({"command":"old"})),
    )
    .unwrap()
    .unwrap();
    applied.rollback().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), original);
}

#[test]
fn ownership_hash_ignores_object_order_but_detects_content_and_array_changes() {
    let original: Value = serde_json::from_str(
        r#"{"type":"stdio","command":"run","env":{"Z":"last","A":"first"},"args":[{"z":2,"a":1},"tail"]}"#,
    ).unwrap();
    let reordered: Value = serde_json::from_str(
        r#"{"args":[{"a":1,"z":2},"tail"],"command":"run","env":{"A":"first","Z":"last"},"type":"stdio"}"#,
    ).unwrap();
    assert_eq!(hash(&original), hash(&reordered));
    let mut changed = reordered.clone();
    changed["env"]["A"] = "external".into();
    assert_ne!(hash(&original), hash(&changed));
    let mut changed = reordered;
    changed["args"].as_array_mut().unwrap().reverse();
    assert_ne!(hash(&original), hash(&changed));
}
