//! Step 5.2 — Payload hash verification and MSIX identity checks.

use sha2::{Digest, Sha256};
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum VerifyError {
    #[error("hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },
    #[error("io error: {0}")]
    Io(String),
}

/// Verify SHA-256 hash of a file.
pub fn verify_payload_hash(path: &Path, expected_hex: &str) -> Result<(), VerifyError> {
    let bytes = std::fs::read(path).map_err(|e| VerifyError::Io(e.to_string()))?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    let expected_lower = expected_hex.to_ascii_lowercase();
    if actual != expected_lower {
        return Err(VerifyError::HashMismatch {
            expected: expected_lower,
            actual,
        });
    }
    Ok(())
}

// ── MSIX identity ─────────────────────────────────────────────────────────────

/// Official Codex package name prefix.
const CODEX_PACKAGE_NAME: &str = "OpenAI.Codex";
/// Accepted OpenAI publisher strings (Authenticode subject).
const OPENAI_PUBLISHERS: &[&str] = &["OpenAI, Inc.", "OpenAI OpCo, LLC"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MsixIdentityResult {
    Valid,
    UnknownPublisher(String),
    UnknownPackage(String),
}

/// Check MSIX package name + publisher identity.
pub fn check_msix_codex_identity(package_name: &str, publisher: &str) -> MsixIdentityResult {
    if !package_name.starts_with(CODEX_PACKAGE_NAME) {
        return MsixIdentityResult::UnknownPackage(package_name.to_string());
    }
    if !OPENAI_PUBLISHERS
        .iter()
        .any(|&p| publisher.eq_ignore_ascii_case(p))
    {
        return MsixIdentityResult::UnknownPublisher(publisher.to_string());
    }
    MsixIdentityResult::Valid
}
