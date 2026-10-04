//! Codex App Manager integration for release discovery and install planning.
//!
//! The Windows package parser and installer are reused from the pinned MIT
//! `codex-win-engine`; this module keeps Chimera's public contract small and
//! prevents Tauri commands from depending on engine-specific details.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Public release asset base for the Chimera-controlled Codex mirror.
pub const DEFAULT_MIRROR_RELEASE_BASE: &str =
    "https://github.com/Duojiyi/codex-app-mirror/releases/latest/download";

/// How the application chooses where Codex update bytes come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateSource {
    /// Choose the best supported source for this platform. On Windows the
    /// official endpoint does not expose a complete installer contract, so
    /// automatic mode currently resolves to the verified mirror.
    Auto,
    /// Always use the configured mirror endpoints.
    Mirror,
}

impl FromStr for UpdateSource {
    type Err = ManagerError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(Self::Auto),
            "mirror" => Ok(Self::Mirror),
            _ => Err(ManagerError::UnsupportedSource),
        }
    }
}

/// Windows installation strategy selected by the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallMode {
    /// Register the official MSIX through Windows AppX deployment.
    Standard,
    /// Extract the official signed MSIX into a Chimera-managed user directory.
    Portable,
}

impl FromStr for InstallMode {
    type Err = ManagerError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "standard" => Ok(Self::Standard),
            "portable" => Ok(Self::Portable),
            _ => Err(ManagerError::UnsupportedInstallMode),
        }
    }
}

/// URLs needed to discover and download one Windows release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorEndpoints {
    pub manifest_url: String,
    pub checksums_url: String,
    pub release_download_base: String,
}

/// Resolve the stable endpoints for the selected architecture.
pub fn mirror_endpoints(source: UpdateSource, architecture: Option<&str>) -> MirrorEndpoints {
    let _ = (source, architecture);
    MirrorEndpoints {
        manifest_url: format!("{DEFAULT_MIRROR_RELEASE_BASE}/release-manifest.json"),
        checksums_url: format!("{DEFAULT_MIRROR_RELEASE_BASE}/SHA256SUMS-windows.txt"),
        release_download_base: DEFAULT_MIRROR_RELEASE_BASE.to_string(),
    }
}

/// A checksum-bound Windows package ready for comparison or installation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsReleasePlan {
    /// Human-facing Codex app version, for example `26.721.41059`.
    pub version: String,
    /// Four-part MSIX deployment version, for example `26.721.4979.0`.
    pub package_version: String,
    pub package_moniker: String,
    pub package_url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub released_at: Option<String>,
}

/// Installed Windows Codex information needed by Chimera's UI and planner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCodex {
    pub version: String,
    pub path: String,
    /// `standard` for MSIX, `portable` for the managed extracted package.
    pub install_mode: String,
}

/// Maintenance route selected from the detected Windows installation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaintenanceRoute {
    /// A registered Windows MSIX package.
    Standard,
    /// A Chimera-managed extracted package.
    Portable,
    /// No supported Codex installation was detected.
    NotInstalled,
}

/// One evidence-backed runtime diagnostic result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerDiagnostic {
    /// Stable diagnostic label rendered by the desktop UI.
    pub name: String,
    /// One of `pass`, `warn`, or `fail`.
    pub result: String,
}

/// Structured evidence returned after an installation transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOperationResult {
    pub version: String,
    pub requested_mode: String,
    /// May be `portable_fallback` when Windows cannot run a standard MSIX.
    pub actual_mode: String,
    pub affected_path: Option<String>,
    pub backup_path: Option<String>,
    pub message: String,
    pub notes: Vec<String>,
}

impl WindowsReleasePlan {
    /// Whether installing this plan would advance the detected application.
    pub fn is_update_available(&self, current: Option<&str>) -> bool {
        let Some(current) = current.map(str::trim).filter(|value| !value.is_empty()) else {
            return true;
        };
        if current.eq_ignore_ascii_case(&self.version)
            || current.eq_ignore_ascii_case(&self.package_version)
        {
            return false;
        }
        codex_win_engine::version::compare_versions(current, &self.version).is_lt()
    }
}

/// Errors surfaced by the manager service without local paths or credentials.
#[derive(Debug, Error)]
pub enum ManagerError {
    #[error("unsupported Codex update source")]
    UnsupportedSource,
    #[error("unsupported Codex installation mode")]
    UnsupportedInstallMode,
    #[error("the Codex release manifest is invalid")]
    InvalidManifest,
    #[error("the Codex release checksum is missing or invalid")]
    InvalidChecksum,
    #[error("the Codex release does not declare a download size")]
    MissingSize,
    #[error("the Codex release could not be fetched")]
    Fetch,
    #[error("the Codex package download failed")]
    Download,
    #[error("the Codex package failed integrity or publisher verification")]
    Verification,
    #[error("the Codex installation failed")]
    Install,
    #[error("Codex is not installed")]
    NotInstalled,
    #[error("no portable rollback backup is available")]
    NoRollback,
    #[error("the Codex maintenance operation failed")]
    Maintenance,
}

/// Parse the mirror manifest and bind it to its declared MSIX checksum.
pub fn parse_windows_release_plan(
    manifest: &str,
    checksums: &str,
    source: UpdateSource,
    architecture: Option<&str>,
) -> Result<WindowsReleasePlan, ManagerError> {
    let release = codex_win_engine::manifest::parse_manifest_for_arch(manifest, architecture)
        .map_err(|_| ManagerError::InvalidManifest)?;
    if !safe_package_moniker(&release.package_moniker) {
        return Err(ManagerError::InvalidManifest);
    }
    let sha256 = codex_win_engine::find_msix_sha256(checksums, &release.package_moniker)
        .map_err(|_| ManagerError::InvalidChecksum)?;
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ManagerError::InvalidChecksum);
    }
    let endpoints = mirror_endpoints(source, release.download_architecture.as_deref());
    let package_moniker = release.package_moniker;
    let package_url = format!(
        "{}/{}.Msix",
        endpoints.release_download_base, package_moniker
    );
    Ok(WindowsReleasePlan {
        version: release.version,
        package_version: release.package_version,
        package_moniker,
        package_url,
        sha256: sha256.to_ascii_lowercase(),
        size_bytes: release.content_length.ok_or(ManagerError::MissingSize)?,
        released_at: release.released_at,
    })
}

fn safe_package_moniker(value: &str) -> bool {
    value.starts_with("OpenAI.Codex_")
        && value.len() <= 180
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Fetch and parse the latest Windows release using the reference engine's
/// bounded network implementation.
pub fn fetch_windows_release_plan(
    source: UpdateSource,
    architecture: Option<&str>,
) -> Result<WindowsReleasePlan, ManagerError> {
    let endpoints = mirror_endpoints(source, architecture);
    let manifest =
        codex_win_engine::fetch_text(&endpoints.manifest_url).map_err(|_| ManagerError::Fetch)?;
    let checksums =
        codex_win_engine::fetch_text(&endpoints.checksums_url).map_err(|_| ManagerError::Fetch)?;
    parse_windows_release_plan(&manifest, &checksums, source, architecture)
}

/// Detect an official MSIX first, then the supplied managed portable root.
/// The reference engine reads the app's internal version from `app.asar` when
/// available, avoiding the common package-version/display-version mix-up.
pub fn detect_windows_codex(portable_root: &std::path::Path) -> Option<InstalledCodex> {
    codex_win_engine::detect_installed_codex(portable_root).map(|installed| InstalledCodex {
        version: installed.version,
        path: installed.path,
        install_mode: if installed.source == "msix" {
            "standard".to_string()
        } else {
            "portable".to_string()
        },
    })
}

/// Detect only the Chimera-managed portable installation at the given root.
pub fn detect_portable_codex(portable_root: &Path) -> Option<InstalledCodex> {
    codex_win_engine::detect_portable_install(portable_root).map(|installed| InstalledCodex {
        version: installed.version,
        path: installed.path,
        install_mode: "portable".to_string(),
    })
}

/// Select the maintenance implementation for a detected installation.
pub fn maintenance_route(installed: Option<&InstalledCodex>) -> MaintenanceRoute {
    match installed.map(|value| value.install_mode.as_str()) {
        Some("standard") => MaintenanceRoute::Standard,
        Some("portable") => MaintenanceRoute::Portable,
        _ => MaintenanceRoute::NotInstalled,
    }
}

/// Find the most recently written portable rollback directory.
///
/// Only real sibling directories created by the reference engine are accepted;
/// files, symlinks, and paths outside the install parent are ignored.
pub fn latest_portable_rollback(portable_root: &Path) -> Result<Option<PathBuf>, ManagerError> {
    let parent = portable_root.parent().ok_or(ManagerError::Maintenance)?;
    let entries = std::fs::read_dir(parent).map_err(|_| ManagerError::Maintenance)?;
    let mut backups = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if name.starts_with("Codex.rollback-") && kind.is_dir() && !kind.is_symlink() {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            backups.push((modified, entry.path()));
        }
    }
    backups.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(backups.pop().map(|(_, path)| path))
}

/// Run real installation and launch checks without mutating user data.
pub fn diagnose_windows_codex(portable_root: &Path) -> Vec<ManagerDiagnostic> {
    let Some(installed) = detect_windows_codex(portable_root) else {
        return vec![ManagerDiagnostic {
            name: "installation".to_string(),
            result: "fail".to_string(),
        }];
    };
    let executable = codex_win_engine::installed_app_exe(Path::new(&installed.path));
    let mut diagnostics = vec![ManagerDiagnostic {
        name: "executable".to_string(),
        result: if executable.is_some() { "pass" } else { "fail" }.to_string(),
    }];
    if installed.install_mode == "standard" {
        let health = codex_win_engine::verify_msix_health();
        diagnostics.extend([
            ManagerDiagnostic {
                name: "package integrity".to_string(),
                result: if health.package_registered && health.status_ok {
                    "pass"
                } else {
                    "fail"
                }
                .to_string(),
            },
            ManagerDiagnostic {
                name: "package registration".to_string(),
                result: if health.package_registered {
                    "pass"
                } else {
                    "fail"
                }
                .to_string(),
            },
            ManagerDiagnostic {
                name: "dependencies".to_string(),
                result: if health.missing_dependencies.is_empty() {
                    "pass"
                } else {
                    "fail"
                }
                .to_string(),
            },
            ManagerDiagnostic {
                name: "launch".to_string(),
                result: if health.healthy {
                    "pass"
                } else if health.verified {
                    "fail"
                } else {
                    "warn"
                }
                .to_string(),
            },
        ]);
    } else {
        // MSIX trust is verified before extraction. The detached portable tree
        // no longer contains a Windows-verifiable package signature, so do not
        // fabricate a post-install pass or treat its absence as corruption.
        diagnostics.push(ManagerDiagnostic {
            name: "package signature".to_string(),
            result: "warn".to_string(),
        });
        diagnostics.push(ManagerDiagnostic {
            name: "ownership".to_string(),
            result: "pass".to_string(),
        });
    }
    diagnostics
}

/// Restore the newest portable backup while preserving the replaced build.
pub fn rollback_portable_install(
    portable_root: &Path,
) -> Result<InstallOperationResult, ManagerError> {
    if !portable_root.is_dir() {
        return Err(ManagerError::NotInstalled);
    }
    let backup = latest_portable_rollback(portable_root)?.ok_or(ManagerError::NoRollback)?;
    codex_win_engine::close_codex_gracefully_for_root(30, portable_root)
        .map_err(|_| ManagerError::Maintenance)?;
    let parent = portable_root.parent().ok_or(ManagerError::Maintenance)?;
    let operation_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ManagerError::Maintenance)?
        .as_nanos();
    let replaced = parent.join(format!(
        "Codex.replaced-{}-{operation_id}",
        std::process::id()
    ));
    codex_win_engine::rename_directory_with_retry(
        "preserve current portable install",
        portable_root,
        &replaced,
    )
    .map_err(|_| ManagerError::Maintenance)?;
    if codex_win_engine::rename_directory_with_retry(
        "restore portable rollback",
        &backup,
        portable_root,
    )
    .is_err()
    {
        let _ = codex_win_engine::rename_directory_with_retry(
            "restore current portable install",
            &replaced,
            portable_root,
        );
        return Err(ManagerError::Maintenance);
    }
    let restored = detect_portable_codex(portable_root).ok_or(ManagerError::Maintenance)?;
    Ok(InstallOperationResult {
        version: restored.version,
        requested_mode: "portable".to_string(),
        actual_mode: "portable".to_string(),
        affected_path: Some(portable_root.to_string_lossy().to_string()),
        backup_path: Some(replaced.to_string_lossy().to_string()),
        message: "Portable Codex was restored from the latest rollback backup.".to_string(),
        notes: Vec::new(),
    })
}

/// Uninstall the currently detected Codex package while preserving user data.
pub fn uninstall_windows_codex(
    portable_root: &Path,
) -> Result<InstallOperationResult, ManagerError> {
    let installed = detect_windows_codex(portable_root).ok_or(ManagerError::NotInstalled)?;
    let version = installed.version.clone();
    match maintenance_route(Some(&installed)) {
        MaintenanceRoute::Standard => {
            let report =
                codex_win_engine::remove_msix_package().map_err(|_| ManagerError::Maintenance)?;
            if !report.success {
                return Err(ManagerError::Maintenance);
            }
            Ok(InstallOperationResult {
                version,
                requested_mode: "standard".to_string(),
                actual_mode: "uninstalled".to_string(),
                affected_path: Some(installed.path),
                backup_path: None,
                message: report.message,
                notes: report.notes,
            })
        }
        MaintenanceRoute::Portable => {
            let report = codex_win_engine::uninstall_portable(portable_root, false)
                .map_err(|_| ManagerError::Maintenance)?;
            if !report.success {
                return Err(ManagerError::Maintenance);
            }
            Ok(InstallOperationResult {
                version,
                requested_mode: "portable".to_string(),
                actual_mode: "uninstalled".to_string(),
                affected_path: Some(report.install_root),
                backup_path: None,
                message: report.message,
                notes: report.notes,
            })
        }
        MaintenanceRoute::NotInstalled => Err(ManagerError::NotInstalled),
    }
}

/// Download, verify and install one exact release plan.
///
/// The MSIX is accepted only when its byte size and SHA-256 match the mirror
/// manifest and Windows validates the pinned OpenAI Marketplace publisher.
pub fn install_windows_release(
    plan: &WindowsReleasePlan,
    requested_mode: InstallMode,
    staging_root: &std::path::Path,
    portable_root: &std::path::Path,
    on_progress: &dyn Fn(u64),
) -> Result<InstallOperationResult, ManagerError> {
    if !safe_package_moniker(&plan.package_moniker) {
        return Err(ManagerError::InvalidManifest);
    }
    std::fs::create_dir_all(staging_root).map_err(|_| ManagerError::Download)?;
    let package_path = staging_root.join(format!("{}.Msix", plan.package_moniker));
    codex_win_engine::download_to_with_progress_bounded(
        &plan.package_url,
        &package_path,
        plan.size_bytes,
        on_progress,
    )
    .map_err(|_| ManagerError::Download)?;

    let size = package_path
        .metadata()
        .map_err(|_| ManagerError::Verification)?
        .len();
    let digest =
        codex_win_engine::sha256_file(&package_path).map_err(|_| ManagerError::Verification)?;
    if size != plan.size_bytes || !digest.eq_ignore_ascii_case(&plan.sha256) {
        let _ = std::fs::remove_file(&package_path);
        return Err(ManagerError::Verification);
    }
    let signature = codex_win_engine::verify_openai_authenticode(&package_path)
        .map_err(|_| ManagerError::Verification)?;
    if !signature.is_valid_openai() {
        let _ = std::fs::remove_file(&package_path);
        return Err(ManagerError::Verification);
    }

    let result = match requested_mode {
        InstallMode::Portable => {
            install_portable(plan, &package_path, portable_root, "portable", Vec::new())
        }
        InstallMode::Standard => install_standard_or_fallback(plan, &package_path, portable_root),
    };
    if result.is_ok() {
        let _ = std::fs::remove_file(&package_path);
    }
    result
}

fn install_standard_or_fallback(
    plan: &WindowsReleasePlan,
    package_path: &std::path::Path,
    portable_root: &std::path::Path,
) -> Result<InstallOperationResult, ManagerError> {
    let capability = codex_win_engine::probe_capabilities();
    if capability.recommendation == codex_win_engine::SideloadRecommendation::PortableFallback {
        return install_portable(
            plan,
            package_path,
            portable_root,
            "portable_fallback",
            capability.notes,
        );
    }

    let _ = codex_win_engine::close_msix_codex_processes(20);
    let report = codex_win_engine::install_msix_sideload(package_path, &plan.package_moniker)
        .map_err(|_| ManagerError::Install)?;
    if report.success {
        let health = codex_win_engine::verify_msix_health();
        if health.healthy {
            return Ok(InstallOperationResult {
                version: plan.version.clone(),
                requested_mode: "standard".to_string(),
                actual_mode: "standard".to_string(),
                affected_path: report.installed.map(|installed| installed.path),
                backup_path: None,
                message: "Codex standard installation completed and passed its launch check."
                    .to_string(),
                notes: capability.notes,
            });
        }
    }

    let mut notes = capability.notes;
    notes.push(
        "Standard MSIX installation was unavailable or unhealthy; the verified package was installed in portable mode instead."
            .to_string(),
    );
    let fallback = install_portable(
        plan,
        package_path,
        portable_root,
        "portable_fallback",
        notes,
    )?;
    let _ = codex_win_engine::remove_msix_package();
    Ok(fallback)
}

fn install_portable(
    plan: &WindowsReleasePlan,
    package_path: &std::path::Path,
    portable_root: &std::path::Path,
    actual_mode: &str,
    mut notes: Vec<String>,
) -> Result<InstallOperationResult, ManagerError> {
    let report = codex_win_engine::install_portable_from_msix(package_path, portable_root, false)
        .map_err(|_| ManagerError::Install)?;
    notes.extend(report.notes);
    Ok(InstallOperationResult {
        version: plan.version.clone(),
        requested_mode: if actual_mode == "portable_fallback" {
            "standard".to_string()
        } else {
            "portable".to_string()
        },
        actual_mode: actual_mode.to_string(),
        affected_path: Some(report.install_root),
        backup_path: report.backup_path,
        message: report.message,
        notes,
    })
}
