// Steps 5.5/5.6 RED — Health check and process ownership verification.
// Spec 8.2: only close processes under owned runtime root; health = exe exists + responds.
use chimera_runtime::health::{check_runtime_health, is_process_owned_by_runtime};
use chimera_runtime::update::RuntimeLayout;
use std::fs;
use std::path::Path;
use tempfile::tempdir;

fn make_layout_with_version(tmp: &tempfile::TempDir, version: &str) -> RuntimeLayout {
    let layout = RuntimeLayout::new(tmp.path().join("runtime"));
    layout.initialise().unwrap();
    let staged = chimera_runtime::update::stage_version(&layout, version).unwrap();
    // Write a fake exe
    fs::write(staged.join("Codex.exe"), b"fake-codex-exe").unwrap();
    chimera_runtime::update::commit_version(&layout, version, "sha256:fake").unwrap();
    layout
}

// ── Health check ──────────────────────────────────────────────────────────────

#[test]
fn health_check_passes_when_exe_exists() {
    let tmp = tempdir().unwrap();
    let layout = make_layout_with_version(&tmp, "26.721");
    let result = check_runtime_health(&layout).unwrap();
    assert!(
        result.exe_present,
        "exe_present must be true when Codex.exe exists"
    );
}

#[test]
fn health_check_fails_when_no_version_installed() {
    let tmp = tempdir().unwrap();
    let layout = RuntimeLayout::new(tmp.path().join("rt"));
    layout.initialise().unwrap();
    // No version installed — no current.json
    let result = check_runtime_health(&layout);
    assert!(
        result.is_err() || result.map(|r| !r.exe_present).unwrap_or(true),
        "health check must fail/be unhealthy when no version installed"
    );
}

#[test]
fn health_result_reports_version() {
    let tmp = tempdir().unwrap();
    let layout = make_layout_with_version(&tmp, "26.721");
    let result = check_runtime_health(&layout).unwrap();
    assert_eq!(result.version.as_deref(), Some("26.721"));
}

// ── Process ownership ─────────────────────────────────────────────────────────

#[test]
fn process_under_runtime_root_is_owned() {
    let tmp = tempdir().unwrap();
    let runtime_root = tmp.path().join("runtime/versions/26.721");
    fs::create_dir_all(&runtime_root).unwrap();
    let exe_path = runtime_root.join("Codex.exe");
    fs::write(&exe_path, b"fake").unwrap();

    assert!(
        is_process_owned_by_runtime(&exe_path, &runtime_root),
        "exe inside runtime root must be considered owned"
    );
}

#[test]
fn process_outside_runtime_root_is_not_owned() {
    let tmp = tempdir().unwrap();
    let runtime_root = tmp.path().join("runtime");
    let other_path = tmp.path().join("other/Codex.exe");
    fs::create_dir_all(other_path.parent().unwrap()).unwrap();
    fs::write(&other_path, b"fake").unwrap();

    assert!(
        !is_process_owned_by_runtime(&other_path, &runtime_root),
        "exe outside runtime root must NOT be considered owned"
    );
}

#[test]
fn sibling_directory_sharing_a_name_prefix_is_not_owned() {
    // Regression: a raw string `starts_with` reports true here, which would let
    // us act on an install we do not own (G5). Segment comparison rejects it.
    let root = Path::new("C:/rt");
    assert!(
        !is_process_owned_by_runtime(Path::new("C:/rt-evil/Codex.exe"), root),
        "a sibling dir sharing a name prefix must not count as owned"
    );
    assert!(
        !is_process_owned_by_runtime(Path::new("C:/rtx/Codex.exe"), root),
        "a longer sibling name must not count as owned"
    );
    // The genuine child still passes.
    assert!(
        is_process_owned_by_runtime(Path::new("C:/rt/versions/1/Codex.exe"), root),
        "a real descendant must still count as owned"
    );
    // The root itself is not a process under the root.
    assert!(
        !is_process_owned_by_runtime(root, root),
        "the root path itself is not an owned process"
    );
}

#[test]
fn chatgpt_exe_outside_runtime_root_is_not_owned() {
    // Spec 8.2: must not kill ChatGPT.exe / external Codex by name matching
    let tmp = tempdir().unwrap();
    let runtime_root = tmp.path().join("runtime");
    // Simulate ChatGPT app in a completely different location
    let chatgpt = std::path::Path::new("C:/Users/User/AppData/Local/ChatGPT/ChatGPT.exe");
    assert!(
        !is_process_owned_by_runtime(chatgpt, &runtime_root),
        "ChatGPT.exe outside runtime root must not be owned"
    );
}
