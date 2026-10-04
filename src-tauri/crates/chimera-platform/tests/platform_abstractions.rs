// Step 1.3 RED — platform abstraction tests.
// These fail until chimera-platform exposes the required traits and types.
// Run: cargo test -p chimera-platform

use chimera_platform::{CanonicalPath, LockGuard, OperationLock, ProcessIdentity};
use std::path::PathBuf;

// ── CanonicalPath ─────────────────────────────────────────────────────────────

#[test]
fn canonical_path_rejects_path_traversal() {
    let result = CanonicalPath::new("../../../etc/passwd");
    assert!(result.is_err(), "path traversal must be rejected");
}

#[test]
fn canonical_path_resolves_to_absolute() {
    // In tests we can only test the API shape; real resolution is platform-specific
    // and tested via integration fixtures with tempdir.
    let base = std::env::temp_dir();
    let p = base.join("chimera-test-canonical");
    // Just verify the type accepts an absolute path without erroring on the API
    let _ = CanonicalPath::new_unchecked(p);
}

// ── OperationLock ─────────────────────────────────────────────────────────────

#[test]
fn operation_lock_acquire_and_release_in_same_process() {
    let tmp = tempfile::tempdir().unwrap();
    let lock_path = tmp.path().join("chimera.lock");

    let lock = OperationLock::new(&lock_path);
    let _guard: LockGuard = lock
        .try_acquire("test_op")
        .expect("first acquire must succeed");
    // Guard released when it drops.
}

#[test]
fn operation_lock_second_acquire_fails_while_held() {
    let tmp = tempfile::tempdir().unwrap();
    let lock_path = tmp.path().join("chimera.lock");

    let lock = OperationLock::new(&lock_path);
    let _guard = lock.try_acquire("op_a").expect("first acquire");
    let second = lock.try_acquire("op_b");
    assert!(second.is_err(), "second acquire while lock held must fail");
}

#[test]
fn operation_lock_is_released_on_guard_drop() {
    let tmp = tempfile::tempdir().unwrap();
    let lock_path = tmp.path().join("chimera.lock");

    let lock = OperationLock::new(&lock_path);
    {
        let _guard = lock.try_acquire("op_a").expect("acquire");
        // guard drops here
    }
    // Should succeed now
    let _guard2 = lock
        .try_acquire("op_b")
        .expect("re-acquire after drop must succeed");
}

// ── ProcessIdentity ────────────────────────────────────────────────────────────

#[test]
fn process_identity_records_pid_and_path() {
    let id = ProcessIdentity::current(PathBuf::from("/tmp/fake/codex.exe"));
    assert!(id.pid > 0);
    assert_eq!(id.executable_path, PathBuf::from("/tmp/fake/codex.exe"));
}

#[test]
fn process_identity_matches_self() {
    let id = ProcessIdentity::current(std::env::current_exe().unwrap());
    assert_eq!(id.pid, std::process::id());
}
