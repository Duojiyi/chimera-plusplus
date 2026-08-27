//! Shared resource and path limits for untrusted local/network input.
//!
//! The application reads files written by other tools and buffers responses
//! from gateways. Keep those boundaries explicit and centralised so a new
//! caller does not accidentally re-introduce an unbounded read.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// Maximum size for JSON/JSON5/TOML configuration files read into memory.
pub const MAX_CONFIG_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// Maximum size for one session log read into memory.
pub const MAX_SESSION_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Maximum size for an imported deep-link/config payload.
pub const MAX_IMPORT_BYTES: u64 = 4 * 1024 * 1024;
/// Maximum size for a buffered proxy response before decompression.
pub const MAX_PROXY_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
/// Maximum size for a decoded proxy response.
pub const MAX_DECOMPRESSED_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum combined stdout/stderr captured from an external helper process.
pub const MAX_PROCESS_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Maximum number of nested content codings accepted in one response.
pub const MAX_COMPRESSION_LAYERS: usize = 4;
/// Maximum depth for recursive session discovery.
pub const MAX_SESSION_SCAN_DEPTH: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceLimitError {
    Symlink,
    TooLarge { size: u64, limit: u64 },
}

impl std::fmt::Display for ResourceLimitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Symlink => f.write_str("symbolic links and reparse points are not allowed"),
            Self::TooLarge { size, limit } => {
                write!(f, "resource is {size} bytes, exceeding limit {limit}")
            }
        }
    }
}

impl std::error::Error for ResourceLimitError {}

/// Read a regular file with a hard byte limit and without following a final
/// symbolic link/reparse point.
pub fn read_limited(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let file = open_limited_regular_file(path, limit)?;
    let metadata = file.metadata()?;
    let mut output = Vec::with_capacity(metadata.len() as usize);
    file.take(limit.saturating_add(1))
        .read_to_end(&mut output)?;
    if output.len() as u64 > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            ResourceLimitError::TooLarge {
                size: output.len() as u64,
                limit,
            },
        ));
    }
    Ok(output)
}

/// Open a regular file after rejecting a symbolic link / reparse point at
/// the final path component, without enforcing any size limit.
///
/// For callers that parse a file incrementally (line-by-line, chunked, ...)
/// and therefore never hold the whole file in memory at once: the actual
/// resource to bound in that case is the size of one unit of work (one
/// line, one chunk), not the size of the file on disk. Gating the open on
/// total file size in front of a streaming parser only produces a hard
/// failure with no corresponding safety benefit. Callers that read a file
/// fully into memory should use [`open_limited_regular_file`] instead.
pub fn open_regular_file_no_symlink(path: &Path) -> io::Result<File> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            ResourceLimitError::Symlink,
        ));
    }
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a regular file",
        ));
    }

    let file = File::open(path)?;
    let opened_metadata = file.metadata()?;
    if !opened_metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a regular file",
        ));
    }
    Ok(file)
}

/// Open a regular file after rejecting links/reparse points and enforcing a
/// maximum size. Callers that read a file fully into memory should use this
/// helper instead of opening session/config files directly.
pub fn open_limited_regular_file(path: &Path, limit: u64) -> io::Result<File> {
    let file = open_regular_file_no_symlink(path)?;
    let metadata = file.metadata()?;
    if metadata.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            ResourceLimitError::TooLarge {
                size: metadata.len(),
                limit,
            },
        ));
    }
    Ok(file)
}

pub fn read_to_string_limited(path: &Path, limit: u64) -> io::Result<String> {
    let bytes = read_limited(path, limit)?;
    String::from_utf8(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

/// Canonicalise an existing path and require it to remain below `root`.
///
/// Every component between the root and the target is checked with
/// `symlink_metadata`, so a symlink/junction cannot smuggle a path outside the
/// intended configuration/session directory.
pub fn canonicalize_within_root(path: &Path, root: &Path) -> io::Result<PathBuf> {
    // Check the original path before canonicalisation.  Only inspect the
    // root and descendants, not every ancestor up to the filesystem root:
    // macOS exposes `/var` as a symlink to `/private/var`, and rejecting
    // unrelated system-level aliases would make ordinary temp directories
    // unusable.
    let mut current = root.to_path_buf();
    if let Ok(relative) = path.strip_prefix(root) {
        for component in relative.components() {
            match component {
                std::path::Component::Normal(value) => current.push(value),
                std::path::Component::CurDir => continue,
                std::path::Component::ParentDir => {
                    if !current.pop() || !current.starts_with(root) {
                        break;
                    }
                    continue;
                }
                _ => continue,
            }

            match fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            ResourceLimitError::Symlink,
                        ));
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }

    let canonical_root = fs::canonicalize(root)?;
    let canonical_path = fs::canonicalize(path)?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "path escapes its permitted root",
        ));
    }

    Ok(canonical_path)
}

/// Read directory entries without following directory links.
pub fn read_dir_without_links(path: &Path) -> io::Result<Vec<fs::DirEntry>> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            ResourceLimitError::Symlink,
        ));
    }
    fs::read_dir(path)?.collect()
}

/// Iteratively collect regular files with one of the requested extensions.
/// Directory symlinks/reparse points are skipped and recursion is capped.
pub fn collect_files_with_extensions(
    root: &Path,
    extensions: &[&str],
    max_depth: usize,
) -> io::Result<Vec<PathBuf>> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = pending.pop() {
        for entry in read_dir_without_links(&dir)? {
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                if depth < max_depth {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            if metadata.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extensions.contains(&extension))
            {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn rejects_oversized_files_before_reading() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("large.json");
        let mut file = File::create(&path).unwrap();
        file.write_all(b"0123456789").unwrap();

        let error = read_limited(&path, 4).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("exceeding limit"));
    }

    #[test]
    fn unlimited_open_ignores_file_size() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        let mut file = File::create(&path).unwrap();
        // Larger than any of the crate's whole-file byte limits, to prove
        // this helper genuinely does not gate on size.
        file.write_all(&vec![b'a'; MAX_SESSION_FILE_BYTES as usize + 1024])
            .unwrap();

        let opened = open_regular_file_no_symlink(&path);
        assert!(opened.is_ok(), "unexpected error: {opened:?}");
    }

    #[test]
    fn unlimited_open_rejects_missing_or_non_regular_paths() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("does-not-exist.jsonl");
        assert!(open_regular_file_no_symlink(&missing).is_err());
        assert!(open_regular_file_no_symlink(dir.path()).is_err());
    }

    #[test]
    fn open_limited_regular_file_still_enforces_its_limit() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("large.jsonl");
        fs::write(&path, b"0123456789").unwrap();

        let error = open_limited_regular_file(&path, 4).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("exceeding limit"));

        assert!(open_limited_regular_file(&path, 10).is_ok());
    }

    #[test]
    fn canonicalized_file_must_stay_below_root() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&outside, "outside").unwrap();

        let error = canonicalize_within_root(&outside, &root).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn bounded_collection_stops_at_requested_depth() {
        let dir = tempdir().unwrap();
        let level_one = dir.path().join("one");
        let level_two = level_one.join("two");
        fs::create_dir_all(&level_two).unwrap();
        fs::write(level_one.join("visible.jsonl"), "{}").unwrap();
        fs::write(level_two.join("too-deep.jsonl"), "{}").unwrap();

        let files = collect_files_with_extensions(dir.path(), &["jsonl"], 1).unwrap();
        assert_eq!(files, vec![level_one.join("visible.jsonl")]);
    }
}
