use thiserror::Error;

/// 操作错误分类。
/// 所有跨领域操作失败都应映射到此枚举，不得在 Tauri 命令层吞掉原始错误。
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum OperationError {
    #[error("operation lock acquire failed (holder pid: {holder_pid:?})")]
    LockAcquireFailed { holder_pid: Option<u32> },

    #[error("CAS conflict: expected hash {expected_hash}, found {actual_hash}")]
    CasConflict {
        expected_hash: String,
        actual_hash: String,
    },

    #[error("write journal corrupted: {0}")]
    JournalCorrupted(String),

    #[error("ownership mismatch: canonical path or manifest does not match")]
    OwnershipMismatch,

    #[error("canonical path mismatch: expected {expected:?}, got {actual:?}")]
    CanonicalPathMismatch {
        expected: std::path::PathBuf,
        actual: std::path::PathBuf,
    },

    #[error("invalid URL: {0}")]
    InvalidUrl(String),

    #[error("cross-origin redirect blocked: {from} -> {to}")]
    CrossOriginRedirect { from: String, to: String },

    #[error("unsupported protocol: {0}")]
    UnsupportedProtocol(String),

    #[error("signature verification failed: {0}")]
    SignatureInvalid(String),

    #[error("hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },

    #[error("TLS error: {0}")]
    TlsError(String),

    #[error("provider health check failed: {0}")]
    ProviderUnhealthy(String),

    #[error("io error: {0}")]
    Io(String),
}

/// Result alias scoped to this crate.
pub type DomainResult<T> = Result<T, OperationError>;
