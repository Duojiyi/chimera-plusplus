//! Step 5.1 — Runtime detection and ownership manifest.
//! Detects ManagedPortable (Chimera-owned), ExternalMsix, or ExternalPortable.
//! All operations verify canonical path before any mutation.

use chimera_domain::{InstallMode, InstallOwnership, TransactionState};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub use chimera_domain::InstallMode as InstallKind;

/// Result of scanning a directory for a managed runtime.
#[derive(Debug, Clone)]
pub enum DetectedRuntime {
    /// Chimera-owned portable installation; ownership.json verified.
    ManagedPortable(InstallOwnership),
    /// System-registered MSIX; detected but NOT owned by Chimera.
    ExternalMsix { version: String, path: PathBuf },
    /// User or other-manager-owned directory; NOT owned by Chimera.
    ExternalPortable {
        path: PathBuf,
        /// Human-facing app version when the portable payload can be inspected.
        version: Option<String>,
    },
    /// No Codex found at this path.
    Unknown,
}

/// Scan the standard OS locations for an official/external Codex or ChatGPT
/// desktop installation. This is read-only and deliberately returns an
/// external ownership verdict so Chimera never mutates a user's official app.
pub fn detect_external_runtime() -> Option<DetectedRuntime> {
    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
        let mut roots = windows_external_roots(local.as_deref(), program_files.as_deref());
        if let Some(program_w6432) = std::env::var_os("ProgramW6432").map(PathBuf::from) {
            let windows_apps = program_w6432.join("WindowsApps");
            if !roots.iter().any(|(root, _)| root == &windows_apps) {
                roots.push((windows_apps, true));
            }
        }
        for (root, msix) in roots {
            if let Some(found) = scan_external_root(&root, msix) {
                return Some(found);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        for root in [
            std::path::PathBuf::from("/Applications/Codex.app"),
            std::path::PathBuf::from("/Applications/ChatGPT.app"),
        ] {
            if root.exists() {
                return Some(DetectedRuntime::ExternalPortable {
                    path: root,
                    version: None,
                });
            }
        }
    }

    None
}

/// Ordered Windows locations for external Codex discovery.
///
/// User-installed portable payloads are checked before `WindowsApps`. Package
/// directories can remain on disk after deregistration, so filesystem order
/// must never let a stale MSIX shadow the live user installation.
pub fn windows_external_roots(
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
) -> Vec<(PathBuf, bool)> {
    let mut roots = Vec::new();
    if let Some(local) = local_app_data {
        roots.extend(
            [
                local.join("Programs").join("Codex"),
                local.join("OpenAI").join("Codex"),
                local.join("OpenAI.Codex"),
                local.join("Codex"),
                local.join("OpenAI").join("ChatGPT"),
                local.join("OpenAI.ChatGPT-Desktop"),
                local.join("ChatGPT"),
                local.join("Programs").join("ChatGPT"),
                local.join("Programs").join("OpenAI").join("ChatGPT"),
            ]
            .into_iter()
            .map(|path| (path, false)),
        );
    }
    if let Some(program_files) = program_files {
        roots.push((program_files.join("OpenAI").join("ChatGPT"), false));
        roots.push((program_files.join("WindowsApps"), true));
    }
    let fallback = PathBuf::from(r"C:\Program Files\WindowsApps");
    if !roots.iter().any(|(root, _)| root == &fallback) {
        roots.push((fallback, true));
    }
    roots
}

#[cfg(windows)]
fn scan_external_root(root: &Path, msix: bool) -> Option<DetectedRuntime> {
    if !msix {
        if let Some(installed) = codex_win_engine::detect_portable_install(root) {
            return Some(DetectedRuntime::ExternalPortable {
                path: PathBuf::from(installed.path),
                version: Some(installed.version),
            });
        }
    }
    let mut candidates = vec![root.join("app"), root.to_path_buf()];
    if msix {
        let entries = std::fs::read_dir(root).ok()?;
        for entry in entries.flatten() {
            let package = entry.path();
            if !package.is_dir() {
                continue;
            }
            let name = package
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if name.starts_with("OpenAI.Codex_") || name.starts_with("OpenAI.ChatGPT-") {
                candidates.push(package.join("app"));
                candidates.push(package);
            }
        }
    }
    let exe_names = ["Codex.exe", "ChatGPT.exe", "codex.exe"];
    for candidate in candidates {
        if !candidate.is_dir() {
            continue;
        }
        if exe_names.iter().any(|name| candidate.join(name).exists())
            || msix && candidate.file_name().is_some_and(|name| name == "app")
        {
            let version = candidate
                .parent()
                .and_then(|path| path.file_name())
                .and_then(|name| name.to_str())
                .map(|name| name.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            return if msix {
                Some(DetectedRuntime::ExternalMsix {
                    version,
                    path: candidate,
                })
            } else {
                Some(DetectedRuntime::ExternalPortable {
                    path: candidate,
                    version: None,
                })
            };
        }
    }
    None
}

#[derive(Debug, Error)]
pub enum OwnershipError {
    #[error("path traversal detected: {0:?}")]
    PathTraversal(PathBuf),
    #[error("canonical path mismatch — expected {expected:?}, found {actual:?}")]
    CanonicalPathMismatch { expected: PathBuf, actual: PathBuf },
    #[error("ownership.json parse error: {0}")]
    Parse(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

const OWNERSHIP_FILENAME: &str = "ownership.json";

/// Detect the runtime type at `dir`.
/// Returns an error if:
/// - `dir` contains `..` path components (traversal)
/// - `ownership.json` exists but its canonical_path does not match `dir`
pub fn detect_runtime(dir: &Path) -> Result<DetectedRuntime, OwnershipError> {
    // Reject path traversal
    for component in dir.components() {
        if component.as_os_str() == ".." {
            return Err(OwnershipError::PathTraversal(dir.to_path_buf()));
        }
    }

    let ownership_path = dir.join(OWNERSHIP_FILENAME);
    if !ownership_path.exists() {
        return Ok(DetectedRuntime::Unknown);
    }

    let ownership = read_ownership_manifest(dir)?.ok_or_else(|| {
        OwnershipError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "ownership.json disappeared",
        ))
    })?;

    // Canonical path check: ownership.json's recorded path must match `dir`
    // On Windows, compare case-insensitively and normalise separators.
    let recorded = &ownership.canonical_path;
    let actual = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());

    if !paths_equivalent(recorded, &actual) && !paths_equivalent(recorded, dir) {
        return Err(OwnershipError::CanonicalPathMismatch {
            expected: recorded.clone(),
            actual,
        });
    }

    Ok(DetectedRuntime::ManagedPortable(ownership))
}

fn paths_equivalent(a: &Path, b: &Path) -> bool {
    let a_str = a.to_string_lossy().replace('\\', "/").to_lowercase();
    let b_str = b.to_string_lossy().replace('\\', "/").to_lowercase();
    a_str == b_str
}

/// Read and parse `ownership.json` from `dir`. Returns None if file does not exist.
pub fn read_ownership_manifest(dir: &Path) -> Result<Option<InstallOwnership>, OwnershipError> {
    let path = dir.join(OWNERSHIP_FILENAME);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)?;
    let v: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| OwnershipError::Parse(e.to_string()))?;
    parse_ownership_from_value(v).map(Some)
}

fn parse_ownership_from_value(v: serde_json::Value) -> Result<InstallOwnership, OwnershipError> {
    let install_mode = match v.get("install_mode").and_then(|m| m.as_str()) {
        Some("managed_portable") => InstallMode::ManagedPortable,
        Some("external_msix") => InstallMode::ExternalMsix,
        _ => InstallMode::ExternalPortable,
    };

    let canonical_path: PathBuf = v
        .get("canonical_path")
        .and_then(|p| p.as_str())
        .ok_or_else(|| OwnershipError::Parse("missing canonical_path".into()))?
        .into();

    let codex_version = v
        .get("codex_version")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    let source_manifest_digest = v
        .get("source_manifest_digest")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    let file_tree_digest = v
        .get("file_tree_digest")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    let created_by_chimera_version = v
        .get("created_by_chimera_version")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    Ok(InstallOwnership {
        install_mode,
        canonical_path,
        codex_version,
        source_manifest_digest,
        file_tree_digest,
        created_by_chimera_version,
        transaction_state: TransactionState::Clean,
        last_health_result: None,
    })
}

/// Write a new `ownership.json` to `dir`.
/// Returns the parsed ownership for immediate use.
pub fn write_ownership_manifest(
    dir: &Path,
    codex_version: &str,
    source_manifest_digest: &str,
    file_tree_digest: &str,
    created_by_chimera_version: &str,
) -> Result<InstallOwnership, OwnershipError> {
    let canonical_path = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let ownership = InstallOwnership {
        install_mode: InstallMode::ManagedPortable,
        canonical_path: canonical_path.clone(),
        codex_version: codex_version.to_string(),
        source_manifest_digest: source_manifest_digest.to_string(),
        file_tree_digest: file_tree_digest.to_string(),
        created_by_chimera_version: created_by_chimera_version.to_string(),
        transaction_state: TransactionState::Clean,
        last_health_result: None,
    };

    let json = serde_json::json!({
        "install_mode": "managed_portable",
        "canonical_path": canonical_path.to_string_lossy(),
        "codex_version": codex_version,
        "source_manifest_digest": source_manifest_digest,
        "file_tree_digest": file_tree_digest,
        "created_by_chimera_version": created_by_chimera_version,
        "transaction_state": { "state": "clean" },
        "last_health_result": null
    });

    let tmp = dir.join("ownership.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&json).unwrap())?;
    std::fs::rename(tmp, dir.join(OWNERSHIP_FILENAME))?;

    Ok(ownership)
}
