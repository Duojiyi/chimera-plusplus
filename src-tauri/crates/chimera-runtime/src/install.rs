//! Managed install: turn a verified payload archive into the active version.
//!
//! This is the step between `download::fetch_payload` (bytes that match a
//! signed digest) and `process::launch_managed_codex` (an executable the
//! launcher can find). Without it the two halves never meet: an audit of Step
//! 6.3 found `stage_version`/`commit_version` had no production caller at all,
//! so a user on a working machine could never obtain a runnable Codex.
//!
//! ## Why extraction has its own rules
//!
//! The archive arrives digest-checked, so provenance is already settled. That
//! is not the same as safe. A digest says "these are the bytes that were signed
//! for" — it says nothing about what those bytes ask the filesystem to do. An
//! archive entry named `../../evil.dll` hashes exactly as well as a benign one,
//! and an upstream build server that is compromised, or simply wrong, produces
//! a perfectly-signed archive either way. So containment is enforced here,
//! independent of who signed what:
//!
//!   * no entry may resolve outside the directory being extracted into
//!   * no symlink entries, which would move that decision to open() time
//!   * bounded total size, per-entry size and entry count
//!
//! ## Why it commits through `update`
//!
//! Extraction lands in `staging/<version>` and the swap into `versions/<version>`
//! goes through `commit_version`, so the install inherits the write-ahead
//! journal, the operation lock, and the backup-then-activate ordering that make
//! an interrupted install recoverable (G6). Nothing here reimplements any of it.
//!
//! Every failure leaves the managed runtime exactly as it was — the same
//! contract `fetch_payload` honours, and what makes "try again" safe advice.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::update::{RuntimeLayout, UpdateError, UpdatePointer, commit_version, stage_version};

/// Executable names the launcher will look for, per `health::find_codex_exe`.
///
/// Kept in sync deliberately rather than shared: an install that succeeds while
/// producing a tree the launcher cannot use is the exact failure this module
/// exists to prevent, so the check belongs at install time too.
const EXECUTABLE_NAMES: [&str; 3] = ["Codex.exe", "codex", "Codex"];

/// Windows device names that cannot exist as ordinary files.
const RESERVED_STEMS: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Caps on what an archive may expand to.
///
/// Configurable so the tests can drive the refusals with kilobytes instead of
/// gigabytes; production always uses [`InstallLimits::default`], and a test
/// pins those defaults so they cannot drift quietly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallLimits {
    /// Ceiling on the sum of every entry's uncompressed size.
    pub max_total_bytes: u64,
    /// Ceiling on any single entry's uncompressed size.
    pub max_entry_bytes: u64,
    /// Ceiling on the number of entries.
    pub max_entries: usize,
}

impl Default for InstallLimits {
    /// Generous enough for a real Electron application, bounded enough that a
    /// hostile archive cannot fill the volume before anything notices.
    fn default() -> Self {
        Self {
            max_total_bytes: 4 * 1024 * 1024 * 1024,
            max_entry_bytes: 2 * 1024 * 1024 * 1024,
            max_entries: 200_000,
        }
    }
}

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("the downloaded package could not be read as an archive")]
    MalformedArchive,

    /// Names the archive entry, which is attacker-supplied but not a local
    /// path — the user needs to know *what* was refused, and a bare "refused"
    /// makes a genuine upstream packaging bug undiagnosable.
    #[error("the package contains an unsafe entry and was not installed: {name}")]
    UnsafeEntry { name: String },

    #[error("the package expands to more than this build will install ({limit} bytes)")]
    TooLarge { limit: u64 },

    #[error("the package contains no Codex executable, so it cannot be installed")]
    NoExecutable,

    #[error("the requested version name is not safe to install")]
    UnsafeVersion,

    #[error("the install could not be written to disk")]
    Storage(io::ErrorKind),

    #[error("the install could not be committed and was rolled back")]
    Commit(#[from] UpdateError),
}

impl InstallError {
    fn storage(e: io::Error) -> Self {
        InstallError::Storage(e.kind())
    }
}

/// Install a verified payload as `version`, with the production limits.
///
/// `source_manifest_digest` is recorded in the pointer so a later audit can say
/// which signed manifest a given install came from.
pub fn install_payload(
    layout: &RuntimeLayout,
    version: &str,
    payload: &Path,
    source_manifest_digest: &str,
) -> Result<UpdatePointer, InstallError> {
    if !safe_version(version) {
        return Err(InstallError::UnsafeVersion);
    }

    install_payload_with_limits(
        layout,
        version,
        payload,
        source_manifest_digest,
        &InstallLimits::default(),
    )
}

/// As [`install_payload`], with explicit limits.
pub fn install_payload_with_limits(
    layout: &RuntimeLayout,
    version: &str,
    payload: &Path,
    source_manifest_digest: &str,
    limits: &InstallLimits,
) -> Result<UpdatePointer, InstallError> {
    if !safe_version(version) {
        return Err(InstallError::UnsafeVersion);
    }

    // Pass one reads only the directory: every refusal below happens before a
    // single byte is written, so a hostile archive never gets to create even a
    // partial tree.
    let plan = plan_extraction(payload, limits)?;

    let staged = stage_version(layout, version)?;
    // A leftover directory from an interrupted attempt would merge with this
    // one and produce a tree that is neither version.
    if staged.exists() {
        fs::remove_dir_all(&staged).map_err(InstallError::storage)?;
    }
    fs::create_dir_all(&staged).map_err(InstallError::storage)?;

    let outcome = extract_into(payload, &staged, &plan, limits);

    if let Err(e) = outcome {
        let _ = fs::remove_dir_all(&staged);
        return Err(e);
    }

    if !EXECUTABLE_NAMES.iter().any(|n| staged.join(n).exists()) {
        let _ = fs::remove_dir_all(&staged);
        return Err(InstallError::NoExecutable);
    }

    let pointer = match commit_version(layout, version, source_manifest_digest) {
        Ok(p) => p,
        Err(e) => {
            // `commit_version` journals and unwinds its own steps; all that is
            // left is the staging tree it never consumed.
            let _ = fs::remove_dir_all(&staged);
            return Err(InstallError::Commit(e));
        }
    };

    // The archive is the size of the whole application and can never be reused:
    // a reinstall re-downloads and re-verifies from the manifest.
    let _ = fs::remove_file(payload);

    Ok(pointer)
}

/// What pass one decided.
struct ExtractionPlan {
    /// A single shared leading directory to drop, if the archive has one.
    strip_prefix: Option<String>,
}

/// Validate every entry and decide whether a wrapping directory is stripped.
///
/// Returns before anything is written. The size accounting uses the archive's
/// declared uncompressed sizes; `extract_into` re-checks against the bytes it
/// actually reads, so a lying header cannot buy more than its declared budget.
fn plan_extraction(payload: &Path, limits: &InstallLimits) -> Result<ExtractionPlan, InstallError> {
    let file = fs::File::open(payload).map_err(InstallError::storage)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| InstallError::MalformedArchive)?;

    if archive.len() > limits.max_entries {
        return Err(InstallError::TooLarge {
            limit: limits.max_entries as u64,
        });
    }

    let mut total: u64 = 0;
    let mut names: Vec<String> = Vec::with_capacity(archive.len());

    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|_| InstallError::MalformedArchive)?;
        let raw = entry.name().to_string();

        // A symlink would defer the containment decision to whatever opens it
        // later, which is exactly the decision this pass exists to make now.
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(InstallError::UnsafeEntry { name: raw });
        }

        check_entry_name(&raw)?;

        if entry.size() > limits.max_entry_bytes {
            return Err(InstallError::TooLarge {
                limit: limits.max_entry_bytes,
            });
        }
        total = total.saturating_add(entry.size());
        if total > limits.max_total_bytes {
            return Err(InstallError::TooLarge {
                limit: limits.max_total_bytes,
            });
        }

        names.push(raw);
    }

    Ok(ExtractionPlan {
        strip_prefix: common_root(&names),
    })
}

/// Refuse any entry name that could resolve outside the extraction directory.
///
/// Deliberately a refusal rather than a normalisation: silently rewriting
/// `../evil` to `evil` installs a file the archive did not describe, and an
/// archive that needs rewriting is one we should not be installing.
fn check_entry_name(name: &str) -> Result<(), InstallError> {
    let unsafe_entry = || InstallError::UnsafeEntry {
        name: name.to_string(),
    };

    if name.is_empty() {
        return Err(unsafe_entry());
    }
    // Zip stores `/`. A backslash is not a separator to the format but is one
    // to Windows, so a naive reader sees one file name where the OS sees a
    // traversal.
    if name.contains('\\') {
        return Err(unsafe_entry());
    }
    // Drive letters and NTFS alternate data streams.
    if name.contains(':') {
        return Err(unsafe_entry());
    }
    if name.starts_with('/') {
        return Err(unsafe_entry());
    }

    for component in name.split('/') {
        if component.is_empty() {
            continue; // trailing slash on a directory entry
        }
        if component == "." || component == ".." {
            return Err(unsafe_entry());
        }
        // Windows silently strips these, so two distinct archive entries can
        // collide into one file on disk.
        if component.ends_with('.') || component.ends_with(' ') {
            return Err(unsafe_entry());
        }
        let stem = component.split('.').next().unwrap_or(component);
        if RESERVED_STEMS.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
            return Err(unsafe_entry());
        }
    }

    Ok(())
}

/// Versions come from a signed manifest, but they are still used as directory
/// names. Keep the check local so a malformed or compromised manifest cannot
/// turn `versions/<v>` into an arbitrary path.
fn safe_version(version: &str) -> bool {
    !version.is_empty()
        && !version.chars().any(|c| matches!(c, '/' | '\\' | ':'))
        && !version.contains("..")
        && !version.chars().any(|c| c.is_control() || c.is_whitespace())
        && !version.ends_with('.')
        && !version.ends_with(' ')
        && !RESERVED_STEMS
            .iter()
            .any(|reserved| version.eq_ignore_ascii_case(reserved))
}

/// The single directory every entry lives under, if there is exactly one.
///
/// Upstream archives routinely wrap their contents in one versioned folder;
/// refusing those would restrict the feature to archives we repackage
/// ourselves, which defeats the point of consuming the official build. With
/// two or more candidate roots there is no safe choice — stripping either
/// discards half the archive — so nothing is stripped and the
/// missing-executable check speaks instead.
fn common_root(names: &[String]) -> Option<String> {
    let mut root: Option<&str> = None;
    for name in names {
        let (head, rest) = name.split_once('/')?;
        if head.is_empty() || rest.is_empty() {
            // A bare directory entry `foo/` is fine as the root itself.
            if rest.is_empty() && !head.is_empty() {
                match root {
                    None => root = Some(head),
                    Some(r) if r == head => {}
                    Some(_) => return None,
                }
                continue;
            }
            return None;
        }
        match root {
            None => root = Some(head),
            Some(r) if r == head => {}
            Some(_) => return None,
        }
    }
    root.map(|r| r.to_string())
}

/// Pass two: write the entries.
fn extract_into(
    payload: &Path,
    staged: &Path,
    plan: &ExtractionPlan,
    limits: &InstallLimits,
) -> Result<(), InstallError> {
    let file = fs::File::open(payload).map_err(InstallError::storage)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| InstallError::MalformedArchive)?;

    let mut written: u64 = 0;
    let mut targets = HashSet::new();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|_| InstallError::MalformedArchive)?;
        let raw = entry.name().to_string();

        // Pass one already refused everything unsafe; re-running the check here
        // keeps the guarantee local to the code that does the writing, so a
        // future refactor that reorders the passes cannot quietly drop it.
        check_entry_name(&raw)?;

        let Some(relative) = strip(&raw, plan.strip_prefix.as_deref()) else {
            continue;
        };
        if relative.is_empty() {
            continue;
        }

        let target = join_contained(staged, &relative)?;

        // Duplicate names are ambiguous across archive readers and can make a
        // later entry overwrite a file already validated by the first pass.
        // Refuse them before writing either copy.
        if !targets.insert(relative.clone()) {
            return Err(InstallError::UnsafeEntry { name: raw });
        }

        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(InstallError::storage)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(InstallError::storage)?;
        }

        let mut out = fs::File::create(&target).map_err(InstallError::storage)?;
        // `take` bounds the read against the bytes actually delivered rather
        // than the size the header claimed, so a header that under-reports
        // cannot expand past its budget.
        let remaining = limits.max_total_bytes.saturating_sub(written);
        let copied = io::copy(&mut (&mut entry).take(remaining + 1), &mut out)
            .map_err(InstallError::storage)?;
        if copied > remaining {
            return Err(InstallError::TooLarge {
                limit: limits.max_total_bytes,
            });
        }
        written += copied;
    }

    Ok(())
}

/// Drop the wrapping directory from an entry name, if there is one.
fn strip<'a>(name: &'a str, prefix: Option<&str>) -> Option<String> {
    match prefix {
        None => Some(name.trim_end_matches('/').to_string()),
        Some(p) => {
            let rest = name.strip_prefix(p)?.trim_start_matches('/');
            Some(rest.trim_end_matches('/').to_string())
        }
    }
}

/// Join `relative` onto `base`, refusing anything that lands outside it.
///
/// `check_entry_name` has already refused the spellings that could escape, so
/// this is the belt to that braces: a containment guarantee stated in terms of
/// the resulting path rather than the input's syntax, which is what actually
/// matters and what survives a change to the parser above it.
fn join_contained(base: &Path, relative: &str) -> Result<PathBuf, InstallError> {
    let mut out = base.to_path_buf();
    for component in relative.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            return Err(InstallError::UnsafeEntry {
                name: relative.to_string(),
            });
        }
        out.push(component);
    }
    if !out.starts_with(base) {
        return Err(InstallError::UnsafeEntry {
            name: relative.to_string(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_traversal_component_is_refused_wherever_it_appears() {
        assert!(check_entry_name("../x").is_err());
        assert!(check_entry_name("a/../../x").is_err());
        assert!(check_entry_name("a/b/..").is_err());
        assert!(check_entry_name("ok/path.txt").is_ok());
    }

    #[test]
    fn a_single_shared_root_is_detected_and_two_are_not() {
        let one = vec!["c-1/Codex.exe".to_string(), "c-1/res/a".to_string()];
        assert_eq!(common_root(&one).as_deref(), Some("c-1"));

        let two = vec!["a/Codex.exe".to_string(), "b/other".to_string()];
        assert_eq!(common_root(&two), None);

        // A top-level file means there is no wrapping directory at all.
        let flat = vec!["Codex.exe".to_string(), "res/a".to_string()];
        assert_eq!(common_root(&flat), None);
    }

    #[test]
    fn containment_is_enforced_on_the_joined_path_not_only_the_name() {
        let base = Path::new("/base");
        assert!(join_contained(base, "a/b.txt").is_ok());
        assert!(join_contained(base, "../b.txt").is_err());
    }
}
