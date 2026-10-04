// Step 5.2 RED — MSIX identity verification and hash checks.
// Spec 8.2: verify architecture, Authenticode identity, SHA-256 before staging.
use chimera_runtime::verify::{
    MsixIdentityResult, VerifyError, check_msix_codex_identity, verify_payload_hash,
};
use std::fs;
use tempfile::tempdir;

// ── SHA-256 verification ──────────────────────────────────────────────────────

#[test]
fn correct_hash_passes_verification() {
    let tmp = tempdir().unwrap();
    let file = tmp.path().join("payload.bin");
    let content = b"test-payload-content";
    fs::write(&file, content).unwrap();
    // SHA-256 of b"test-payload-content"
    let expected = sha256_hex(content);
    let result = verify_payload_hash(&file, &expected);
    assert!(result.is_ok(), "correct hash must pass: {:?}", result);
}

#[test]
fn wrong_hash_fails_verification() {
    let tmp = tempdir().unwrap();
    let file = tmp.path().join("payload.bin");
    fs::write(&file, b"real-content").unwrap();
    let wrong_hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let result = verify_payload_hash(&file, wrong_hash);
    assert!(result.is_err(), "wrong hash must fail");
    assert!(matches!(
        result.unwrap_err(),
        VerifyError::HashMismatch { .. }
    ));
}

#[test]
fn hash_mismatch_error_carries_both_hashes() {
    let tmp = tempdir().unwrap();
    let file = tmp.path().join("f.bin");
    fs::write(&file, b"data").unwrap();
    let wrong = "0000000000000000000000000000000000000000000000000000000000000000";
    let err = verify_payload_hash(&file, wrong).unwrap_err();
    if let VerifyError::HashMismatch { expected, actual } = err {
        assert_eq!(expected, wrong, "expected hash must be preserved in error");
        assert!(!actual.is_empty(), "actual hash must be computed");
        assert_ne!(actual, wrong, "actual must differ from wrong expected");
    } else {
        panic!("expected HashMismatch, got {:?}", err);
    }
}

#[test]
fn missing_file_returns_error() {
    let tmp = tempdir().unwrap();
    let missing = tmp.path().join("nonexistent.msix");
    let result = verify_payload_hash(&missing, "abc");
    assert!(result.is_err(), "missing file must return error");
    assert!(matches!(result.unwrap_err(), VerifyError::Io(_)));
}

// ── MSIX identity checks ──────────────────────────────────────────────────────

#[test]
fn valid_codex_identity_passes() {
    let result = check_msix_codex_identity("OpenAI.Codex", "OpenAI, Inc.");
    assert!(
        matches!(result, MsixIdentityResult::Valid),
        "canonical Codex identity must be valid"
    );
}

#[test]
fn wrong_publisher_fails_identity_check() {
    let result = check_msix_codex_identity("OpenAI.Codex", "SomeOther Corp");
    assert!(matches!(result, MsixIdentityResult::UnknownPublisher(_)));
}

#[test]
fn wrong_package_name_fails_identity_check() {
    let result = check_msix_codex_identity("Evil.Codex", "OpenAI, Inc.");
    assert!(matches!(result, MsixIdentityResult::UnknownPackage(_)));
}

// ── helper ────────────────────────────────────────────────────────────────────

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(data);
    format!("{d:x}")
}
