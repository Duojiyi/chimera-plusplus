// Step 5.1 RED — Runtime detection: ManagedPortable / ExternalMsix / ExternalPortable.
// Spec 8.1: only operations on owned runtime; path/ownership boundary checks.
use chimera_runtime::detection::{
    DetectedRuntime, InstallKind, OwnershipError, detect_runtime, windows_external_roots,
};
use std::fs;
use std::path::Path;
use tempfile::tempdir;

// ── ManagedPortable detection ────────────────────────────────────────────────

#[test]
fn detects_managed_portable_by_ownership_file() {
    let tmp = tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    fs::create_dir_all(&runtime_dir).unwrap();

    // Write a minimal ownership manifest
    let ownership = serde_json::json!({
        "install_mode": "managed_portable",
        "canonical_path": runtime_dir.to_string_lossy(),
        "codex_version": "26.721.41059",
        "source_manifest_digest": "sha256:abc123",
        "file_tree_digest": "sha256:def456",
        "created_by_chimera_version": "2.0.0-beta",
        "transaction_state": { "state": "clean" },
        "last_health_result": null
    });
    fs::write(
        runtime_dir.join("ownership.json"),
        serde_json::to_string_pretty(&ownership).unwrap(),
    )
    .unwrap();

    let result = detect_runtime(&runtime_dir).unwrap();
    assert!(
        matches!(result, DetectedRuntime::ManagedPortable(_)),
        "must detect ManagedPortable via ownership.json: {:?}",
        result
    );

    if let DetectedRuntime::ManagedPortable(own) = result {
        assert_eq!(own.codex_version, "26.721.41059");
    }
}

#[test]
fn no_ownership_file_returns_not_managed() {
    let tmp = tempdir().unwrap();
    let result = detect_runtime(tmp.path()).unwrap();
    assert!(
        matches!(result, DetectedRuntime::Unknown),
        "directory without ownership.json must be Unknown"
    );
}

// ── Canonical path boundary ───────────────────────────────────────────────────

#[test]
fn ownership_canonical_path_mismatch_returns_error() {
    let tmp = tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    fs::create_dir_all(&runtime_dir).unwrap();

    // Write ownership with a DIFFERENT canonical path (mismatch)
    let ownership = serde_json::json!({
        "install_mode": "managed_portable",
        "canonical_path": "/completely/different/path",
        "codex_version": "26.721",
        "source_manifest_digest": "sha256:abc",
        "file_tree_digest": "sha256:def",
        "created_by_chimera_version": "2.0.0-beta",
        "transaction_state": { "state": "clean" },
        "last_health_result": null
    });
    fs::write(
        runtime_dir.join("ownership.json"),
        serde_json::to_string_pretty(&ownership).unwrap(),
    )
    .unwrap();

    let result = detect_runtime(&runtime_dir);
    assert!(
        result.is_err(),
        "canonical path mismatch must return an error"
    );
    assert!(matches!(
        result.unwrap_err(),
        OwnershipError::CanonicalPathMismatch { .. }
    ));
}

// ── Path traversal rejection ──────────────────────────────────────────────────

#[test]
fn path_traversal_in_runtime_dir_is_rejected() {
    let result = detect_runtime(std::path::Path::new("/tmp/../etc/passwd"));
    assert!(
        result.is_err(),
        "path with .. must be rejected by detect_runtime"
    );
}

// ── InstallKind variants ─────────────────────────────────────────────────────

#[test]
fn install_kind_variants_are_exhaustive() {
    let _kinds = [
        InstallKind::ManagedPortable,
        InstallKind::ExternalMsix,
        InstallKind::ExternalPortable,
    ];
}

#[test]
fn user_portable_install_is_checked_before_stale_windowsapps_directories() {
    let roots = windows_external_roots(
        Some(Path::new(r"C:\Users\tester\AppData\Local")),
        Some(Path::new(r"C:\Program Files")),
    );
    let expected_portable = Path::new(r"C:\Users\tester\AppData\Local")
        .join("Programs")
        .join("Codex");

    assert_eq!(
        roots.first().map(|(path, _)| path.as_path()),
        Some(expected_portable.as_path())
    );
    let portable_index = roots
        .iter()
        .position(|(path, _)| path.ends_with(Path::new("Programs").join("Codex")))
        .unwrap();
    let windows_apps_index = roots
        .iter()
        .position(|(path, _)| path.ends_with("WindowsApps"))
        .unwrap();
    assert!(portable_index < windows_apps_index);
}

#[test]
fn external_portable_detection_carries_its_real_version() {
    let detected = DetectedRuntime::ExternalPortable {
        path: r"C:\Users\tester\AppData\Local\Programs\Codex".into(),
        version: Some("26.721.41059".into()),
    };

    match detected {
        DetectedRuntime::ExternalPortable { version, .. } => {
            assert_eq!(version.as_deref(), Some("26.721.41059"));
        }
        other => panic!("unexpected runtime: {other:?}"),
    }
}

// ── Ownership JSON survives roundtrip ─────────────────────────────────────────

#[test]
fn ownership_serialisation_roundtrip() {
    let tmp = tempdir().unwrap();
    let dir = tmp.path().join("rt");
    fs::create_dir_all(&dir).unwrap();

    let original = chimera_runtime::detection::write_ownership_manifest(
        &dir,
        "26.721.41059",
        "sha256:abc",
        "sha256:def",
        "2.0.0-beta",
    )
    .unwrap();

    let loaded = chimera_runtime::detection::read_ownership_manifest(&dir)
        .unwrap()
        .unwrap();
    assert_eq!(original.codex_version, loaded.codex_version);
    assert_eq!(
        original.source_manifest_digest,
        loaded.source_manifest_digest
    );
}
