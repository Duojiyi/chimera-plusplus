// Step 6.4 RED — portable limitations and cleanup.
//
// ADR-002 makes the managed portable install the primary shape. A portable
// install genuinely cannot do several things an MSIX install can, and the Spec
// is explicit that Chimera must not pretend otherwise: no fake package
// identity, no `codex://` registration, no file associations, no Apps &
// Features entry. Instead it states the limits and offers its own cleanup.
//
// The temptation this guards against is the quiet one — registering a
// protocol handler "just to make links work" is a one-line change that makes
// the disclosure a lie and creates a second uninstaller nobody knows about.

use chimera_runtime::portable::{
    CleanupPlan, Limitation, cleanup_plan, limitations, uninstall_registration,
};
use std::fs;
use tempfile::TempDir;

#[test]
fn every_limitation_the_spec_names_is_disclosed() {
    let disclosed = limitations();
    for required in [
        Limitation::NoPackageIdentity,
        Limitation::NoStoreUpdates,
        Limitation::NoProtocolRegistration,
        Limitation::NoFileAssociations,
        Limitation::NoAppsAndFeaturesEntry,
    ] {
        assert!(
            disclosed.contains(&required),
            "{required:?} must be disclosed to the user, not silently absent"
        );
    }
}

#[test]
fn each_limitation_has_something_to_say_for_itself() {
    // A list of bare flags is not a disclosure. Each needs a key the UI can
    // translate into a sentence explaining the consequence.
    for l in limitations() {
        let key = l.detail_key();
        assert!(
            key.starts_with("portable."),
            "{l:?} key must be namespaced: {key}"
        );
        assert!(
            key.len() > "portable.".len() + 3,
            "{l:?} key is too vague: {key}"
        );
    }
}

#[test]
fn chimera_registers_no_uninstall_entry() {
    // The counterpart to disclosing "no Apps & Features entry": if this ever
    // returns true, the disclosure above becomes false and the user has two
    // uninstall paths that can disagree.
    assert!(
        !uninstall_registration(),
        "a portable install must not register itself in Apps & Features"
    );
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

fn populated(dir: &TempDir) -> (std::path::PathBuf, std::path::PathBuf) {
    let data = dir.path().join("data");
    let runtime = dir.path().join("runtime");
    fs::create_dir_all(data.join("logs")).unwrap();
    fs::create_dir_all(runtime.join("versions/26.721")).unwrap();
    fs::write(data.join("providers.db"), b"db").unwrap();
    fs::write(data.join("settings.json"), b"{}").unwrap();
    fs::write(runtime.join("current.json"), b"{}").unwrap();
    (data, runtime)
}

#[test]
fn the_plan_says_what_it_will_delete_before_deleting_anything() {
    let dir = TempDir::new().unwrap();
    let (data, runtime) = populated(&dir);

    let plan = cleanup_plan(&data, &runtime);

    assert!(
        !plan.entries.is_empty(),
        "a populated install must have something to clean"
    );
    assert!(
        plan.total_bytes > 0,
        "the user should see how much space this frees"
    );
    assert!(
        data.exists() && runtime.exists(),
        "building a plan must not delete anything"
    );
}

#[test]
fn the_plan_separates_credentials_from_files() {
    // Keys live in the OS credential store, not on disk, so a file-deletion
    // plan silently leaves them behind. The user has to be told that, or
    // "clean up" means something different from what they assumed.
    let dir = TempDir::new().unwrap();
    let (data, runtime) = populated(&dir);

    let plan = cleanup_plan(&data, &runtime);

    assert!(
        plan.leaves_keychain_entries,
        "the plan must state that stored API keys are not files and need separate removal"
    );
}

#[test]
fn the_plan_never_reaches_outside_the_two_roots_it_was_given() {
    // The single most dangerous thing this feature could do. Every entry has
    // to be inside a directory the caller named.
    let dir = TempDir::new().unwrap();
    let (data, runtime) = populated(&dir);
    let outsider = dir.path().join("someone-elses-files");
    fs::create_dir_all(&outsider).unwrap();
    fs::write(outsider.join("important.txt"), b"not ours").unwrap();

    let plan = cleanup_plan(&data, &runtime);

    for entry in &plan.entries {
        assert!(
            entry.path.starts_with(&data) || entry.path.starts_with(&runtime),
            "cleanup would touch {} which is outside both roots",
            entry.path.display()
        );
    }
}

#[test]
fn an_absent_install_produces_an_empty_plan_rather_than_an_error() {
    // Cleanup is a recovery path. Failing because there is nothing to clean is
    // the opposite of useful.
    let dir = TempDir::new().unwrap();
    let plan = cleanup_plan(&dir.path().join("nope"), &dir.path().join("also-nope"));
    assert!(plan.entries.is_empty());
    assert_eq!(plan.total_bytes, 0);
}

#[test]
fn executing_a_plan_removes_exactly_what_it_listed() {
    let dir = TempDir::new().unwrap();
    let (data, runtime) = populated(&dir);
    let outsider = dir.path().join("someone-elses-files");
    fs::create_dir_all(&outsider).unwrap();
    fs::write(outsider.join("important.txt"), b"not ours").unwrap();

    let plan = cleanup_plan(&data, &runtime);
    plan.execute().expect("cleanup should succeed");

    assert!(!data.exists(), "data root should be gone");
    assert!(!runtime.exists(), "runtime root should be gone");
    assert!(
        outsider.join("important.txt").exists(),
        "cleanup must not have touched anything outside its roots"
    );
}

#[test]
fn executing_a_plan_twice_is_not_an_error() {
    let dir = TempDir::new().unwrap();
    let (data, runtime) = populated(&dir);
    let plan = cleanup_plan(&data, &runtime);
    plan.execute().unwrap();
    plan.execute()
        .expect("a second run must be a no-op, not a failure");
}

#[test]
fn a_plan_can_be_rendered_without_leaking_a_username() {
    // Real paths contain the account name, and this list is exactly what ends
    // up in a screenshot when someone asks "is it safe to click this?".
    let dir = TempDir::new().unwrap();
    let (data, runtime) = populated(&dir);
    let plan: CleanupPlan = cleanup_plan(&data, &runtime);

    for entry in &plan.entries {
        assert!(
            !entry.display_label.contains(std::path::MAIN_SEPARATOR),
            "labels must be names, not paths: {}",
            entry.display_label
        );
    }
}
