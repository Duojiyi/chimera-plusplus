// Step 5.4 RED — crash-safe version commit.
//
// G6: after a failure, exit or power loss at ANY stage of a Codex update, the
// runtime must come back to the last known good version by itself.
//
// commit_version was a three-step sequence with nothing recording intent:
//
//   1. remove_dir_all(versions/<v>)   <- the old version is destroyed here
//   2. rename(staging/<v>, versions/<v>)
//   3. write current.json
//
// A crash between 1 and 2 leaves current.json pointing at a directory that no
// longer exists, and there is no record that an update was ever in progress —
// so nothing can tell a half-applied update from a corrupt install. The module
// doc named a `transaction.json` that was never written.
//
// These tests drive the recovery contract: a journal is written before any
// destructive step, each crash point is recoverable, and the recovery is
// idempotent.

use chimera_runtime::update::{
    RuntimeLayout, TransactionPhase, commit_version, read_transaction, recover_if_interrupted,
    stage_version, write_transaction,
};
use std::fs;
use tempfile::TempDir;

/// A layout with `old` installed and active, and `new` fully staged.
fn layout_with_pending_update(dir: &TempDir) -> RuntimeLayout {
    let layout = RuntimeLayout::new(dir.path());
    layout.initialise().unwrap();

    let staged = stage_version(&layout, "1.0.0").unwrap();
    fs::write(staged.join("codex.exe"), b"old binary").unwrap();
    commit_version(&layout, "1.0.0", "sha256:old").unwrap();

    let staged = stage_version(&layout, "2.0.0").unwrap();
    fs::write(staged.join("codex.exe"), b"new binary").unwrap();
    layout
}

fn active_version(layout: &RuntimeLayout) -> String {
    layout
        .read_current_pointer()
        .unwrap()
        .expect("pointer must exist")
        .active_version
}

// ── The journal exists at all ───────────────────────────────────────────────

#[test]
fn a_successful_commit_leaves_no_transaction_behind() {
    let dir = TempDir::new().unwrap();
    let layout = layout_with_pending_update(&dir);

    commit_version(&layout, "2.0.0", "sha256:new").unwrap();

    assert_eq!(active_version(&layout), "2.0.0");
    assert!(
        read_transaction(&layout).unwrap().is_none(),
        "a completed commit must clear its journal, or every later start \
         would try to recover an update that already finished"
    );
}

#[test]
fn the_old_version_is_preserved_rather_than_deleted() {
    // The audit found backup/ was created and never written to: rollback
    // happened to work only because the old directory was left in place. Once
    // an upgrade reuses a version number that stops being true.
    let dir = TempDir::new().unwrap();
    let layout = layout_with_pending_update(&dir);
    commit_version(&layout, "2.0.0", "sha256:new").unwrap();

    assert!(
        layout.version_dir("1.0.0").exists(),
        "the previous version must survive a commit so rollback has a target"
    );
}

// ── Every crash point recovers to the last known good version ───────────────

#[test]
fn crash_before_anything_moved_recovers_to_the_old_version() {
    let dir = TempDir::new().unwrap();
    let layout = layout_with_pending_update(&dir);

    // Simulate: journal written, process killed before the first mutation.
    write_transaction(&layout, "2.0.0", "sha256:new", TransactionPhase::Started).unwrap();

    recover_if_interrupted(&layout).unwrap();

    assert_eq!(active_version(&layout), "1.0.0");
    assert!(read_transaction(&layout).unwrap().is_none());
}

#[test]
fn crash_after_the_old_version_was_moved_aside_restores_it() {
    let dir = TempDir::new().unwrap();
    let layout = layout_with_pending_update(&dir);

    // Simulate the exact state after step "old moved to backup/".
    write_transaction(&layout, "1.0.0", "sha256:new", TransactionPhase::OldAsided).unwrap();
    fs::create_dir_all(layout.backup_dir()).unwrap();
    fs::rename(
        layout.version_dir("1.0.0"),
        layout.backup_dir().join("1.0.0"),
    )
    .unwrap();
    assert!(!layout.version_dir("1.0.0").exists(), "precondition");

    recover_if_interrupted(&layout).unwrap();

    assert_eq!(active_version(&layout), "1.0.0");
    assert!(
        layout.version_dir("1.0.0").join("codex.exe").exists(),
        "the old version's files must be back where the pointer says they are"
    );
    assert!(read_transaction(&layout).unwrap().is_none());
}

#[test]
fn crash_after_the_new_version_landed_but_before_the_pointer_rolls_back() {
    // G6 says: return to the last known good version. The new version is
    // unverified at this point — nothing has confirmed it runs — so completing
    // forward would activate something no check ever passed.
    let dir = TempDir::new().unwrap();
    let layout = layout_with_pending_update(&dir);

    write_transaction(&layout, "2.0.0", "sha256:new", TransactionPhase::OldAsided).unwrap();
    fs::create_dir_all(layout.backup_dir()).unwrap();
    fs::rename(
        layout.version_dir("1.0.0"),
        layout.backup_dir().join("1.0.0"),
    )
    .unwrap();
    fs::rename(
        layout.staging_dir().join("2.0.0"),
        layout.version_dir("2.0.0"),
    )
    .unwrap();
    write_transaction(&layout, "2.0.0", "sha256:new", TransactionPhase::Installed).unwrap();

    recover_if_interrupted(&layout).unwrap();

    assert_eq!(
        active_version(&layout),
        "1.0.0",
        "an interrupted update must not leave an unverified version active"
    );
    assert!(layout.version_dir("1.0.0").join("codex.exe").exists());
}

#[test]
fn crash_after_the_pointer_was_written_completes_forward() {
    // Past this point the update genuinely succeeded; only cleanup is left.
    // Rolling back here would undo a good update.
    let dir = TempDir::new().unwrap();
    let layout = layout_with_pending_update(&dir);

    // Reach the real post-pointer state by doing the real commit, then put the
    // journal back to simulate dying in the window before it was cleared.
    commit_version(&layout, "2.0.0", "sha256:new").unwrap();
    write_transaction(&layout, "2.0.0", "sha256:new", TransactionPhase::Committed).unwrap();

    recover_if_interrupted(&layout).unwrap();

    assert_eq!(active_version(&layout), "2.0.0");
    assert!(read_transaction(&layout).unwrap().is_none());
}

// ── Recovery must be safe to run repeatedly ─────────────────────────────────

#[test]
fn recovery_is_idempotent_and_a_no_op_without_a_transaction() {
    let dir = TempDir::new().unwrap();
    let layout = layout_with_pending_update(&dir);
    commit_version(&layout, "2.0.0", "sha256:new").unwrap();

    for _ in 0..3 {
        recover_if_interrupted(&layout).unwrap();
        assert_eq!(active_version(&layout), "2.0.0");
    }
}

#[test]
fn a_corrupt_transaction_file_does_not_wedge_startup() {
    // A torn write during power loss is exactly the case this must survive:
    // refusing to start is worse than the interrupted update it describes.
    let dir = TempDir::new().unwrap();
    let layout = layout_with_pending_update(&dir);
    fs::write(layout.transaction_path(), b"{ not json").unwrap();

    recover_if_interrupted(&layout).expect("a corrupt journal must not be fatal");

    assert_eq!(active_version(&layout), "1.0.0");
    assert!(
        read_transaction(&layout).unwrap().is_none(),
        "an unreadable journal must be cleared, or startup loops on it forever"
    );
}
