//! Step 6.4 — what a portable install cannot do, and how to remove it.
//!
//! ADR-002 makes the managed portable install the primary shape. A portable
//! install genuinely lacks capabilities an MSIX install has, and the Spec is
//! explicit that Chimera states those limits rather than faking them: no
//! package identity, no Store updates, no `codex://` registration, no file
//! associations, no Apps & Features entry.
//!
//! Faking any of them is a small change that makes the disclosure a lie.
//! Registering a protocol handler "so links work" would also create a second
//! uninstall path that can disagree with ours, which is how a user ends up
//! with a half-removed install and no way to tell.
//!
//! Because there is no Apps & Features entry, removal has to live in our own
//! UI — hence `cleanup_plan`, which is deliberately a two-step: describe, then
//! execute. Nothing here deletes a path the caller did not name.

use std::fs;
use std::path::{Path, PathBuf};

/// A capability a portable install does not have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limitation {
    /// No MSIX package identity, so anything keyed on it does not see Chimera.
    NoPackageIdentity,
    /// The Store does not update it; Chimera updates itself.
    NoStoreUpdates,
    /// `codex://` links are not handled.
    NoProtocolRegistration,
    /// Double-clicking an associated file does not open Chimera.
    NoFileAssociations,
    /// It does not appear in Apps & Features; removal is in Chimera's own UI.
    NoAppsAndFeaturesEntry,
}

impl Limitation {
    /// i18n key for the sentence explaining what this costs the user.
    ///
    /// A key rather than text: this crate must not hold translated strings, and
    /// a bare list of flags is not a disclosure — the consequence is the part
    /// that matters.
    pub fn detail_key(&self) -> &'static str {
        match self {
            Limitation::NoPackageIdentity => "portable.noPackageIdentity",
            Limitation::NoStoreUpdates => "portable.noStoreUpdates",
            Limitation::NoProtocolRegistration => "portable.noProtocolRegistration",
            Limitation::NoFileAssociations => "portable.noFileAssociations",
            Limitation::NoAppsAndFeaturesEntry => "portable.noAppsAndFeaturesEntry",
        }
    }
}

/// Everything a portable install cannot do, in the order the UI shows them.
pub fn limitations() -> Vec<Limitation> {
    vec![
        Limitation::NoPackageIdentity,
        Limitation::NoStoreUpdates,
        Limitation::NoProtocolRegistration,
        Limitation::NoFileAssociations,
        Limitation::NoAppsAndFeaturesEntry,
    ]
}

/// Whether Chimera registers itself in Apps & Features.
///
/// Always false, and a function rather than a constant so the test that pairs
/// it with the disclosure above reads as a behavioural assertion. If this ever
/// becomes true, `NoAppsAndFeaturesEntry` is a lie and the user has two
/// uninstall paths that can disagree.
pub fn uninstall_registration() -> bool {
    false
}

/// One thing cleanup would remove.
#[derive(Debug, Clone)]
pub struct CleanupEntry {
    pub path: PathBuf,
    /// The file or folder's own name, never a full path.
    ///
    /// A real path contains the account name, and this list is exactly what
    /// gets screenshotted when someone asks whether it is safe to click.
    pub display_label: String,
    pub bytes: u64,
}

/// What cleanup will do, before it does it.
#[derive(Debug, Clone)]
pub struct CleanupPlan {
    pub entries: Vec<CleanupEntry>,
    pub total_bytes: u64,
    /// True when API keys live in the OS credential store rather than in these
    /// files. A file-deletion plan silently leaves them behind, so "clean up"
    /// would mean something different from what the user assumed unless the UI
    /// says so.
    pub leaves_keychain_entries: bool,
    roots: Vec<PathBuf>,
}

fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    // Not followed: a symlink out of the tree must not be counted, and it is
    // not deleted either — `remove_dir_all` removes the link, not the target.
    if meta.file_type().is_symlink() {
        return 0;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries.flatten().map(|e| dir_size(&e.path())).sum()
}

/// Describe what removing this installation would delete.
///
/// Only ever reports paths inside `data_root` or `runtime_root`. An absent
/// install yields an empty plan rather than an error: cleanup is a recovery
/// path, and failing because there is nothing to clean is the opposite of
/// useful.
pub fn cleanup_plan(data_root: &Path, runtime_root: &Path) -> CleanupPlan {
    let mut entries = Vec::new();
    let mut roots = Vec::new();

    for root in [data_root, runtime_root] {
        if !root.exists() {
            continue;
        }
        roots.push(root.to_path_buf());
        let Ok(read) = fs::read_dir(root) else {
            continue;
        };
        for child in read.flatten() {
            let path = child.path();
            entries.push(CleanupEntry {
                display_label: child.file_name().to_string_lossy().into_owned(),
                bytes: dir_size(&path),
                path,
            });
        }
    }

    let total_bytes = entries.iter().map(|e| e.bytes).sum();
    CleanupPlan {
        entries,
        total_bytes,
        // Keys are stored via the OS credential store (G4), never on disk.
        leaves_keychain_entries: true,
        roots,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CleanupError {
    #[error("Could not remove {label}. Close Chimera and any Codex window, then try again.")]
    Remove { label: String },
}

impl CleanupPlan {
    /// Remove everything the plan listed, then the roots themselves.
    ///
    /// Idempotent: running it again after a successful run is a no-op, not an
    /// error, because a user who is unsure whether it worked will click twice.
    pub fn execute(&self) -> Result<(), CleanupError> {
        for entry in &self.entries {
            if !entry.path.exists() {
                continue;
            }
            let result = if entry.path.is_dir() {
                fs::remove_dir_all(&entry.path)
            } else {
                fs::remove_file(&entry.path)
            };
            result.map_err(|_| CleanupError::Remove {
                label: entry.display_label.clone(),
            })?;
        }

        for root in &self.roots {
            if root.exists() {
                // The children are gone; this only removes the now-empty root.
                // A failure here is not fatal — an empty leftover directory is
                // harmless, and reporting it would send the user chasing it.
                let _ = fs::remove_dir(root);
            }
        }
        Ok(())
    }
}
