//! Safe `.codexskin` (zip) import — Step 8.1 (ADR-005).
//!
//! Everything here is written on the assumption that the archive is hostile:
//! every entry name, every declared size, every byte of content is checked
//! before it is trusted, and a single failure anywhere refuses the whole
//! import rather than skipping the one bad entry. Output is an in-memory
//! [`SkinPackage`] — this module never writes to disk on its own — so "did
//! importing a skin touch anything on the filesystem" has a trivial answer
//! independent of every check below; [`SkinPackage::write_to`] is the one
//! place that later, deliberately, writes bytes out, and only into a
//! caller-chosen directory it re-validates on the way in.

use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use thiserror::Error;
use zip::ZipArchive;

use crate::css_allowlist::{CssError, validate_css};
use crate::schema::{ManifestError, SkinManifest};

/// Hard caps. All three exist independently because each defeats a different
/// shape of decompression bomb:
///   - [`MAX_DECOMPRESSION_RATIO`] catches a small compressed entry that
///     claims (or, once actually decompressed, produces) a wildly larger
///     output — the classic quines/repeated-byte bomb.
///   - [`MAX_SINGLE_FILE_UNCOMPRESSED_BYTES`] catches one big-but-plausible
///     file (ratio-legitimate, just too large for a theme asset).
///   - [`MAX_TOTAL_UNCOMPRESSED_BYTES`] catches many merely-medium files
///     adding up, which neither of the other two would ever see individually.
const MAX_ENTRIES: usize = 256;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SINGLE_FILE_UNCOMPRESSED_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DECOMPRESSION_RATIO: u64 = 200;

/// Kind of a validated, bundled asset — decided by extension, then confirmed
/// against the file's actual magic bytes so a renamed payload cannot ride
/// through on its extension alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    Png,
    Jpeg,
    Webp,
    Svg,
    Woff,
    Woff2,
    Ttf,
    Otf,
}

/// One bundled, already-verified asset (image or font).
#[derive(Debug, Clone)]
pub struct SkinAsset {
    /// Forward-slash relative path, exactly as it will be written under a
    /// skin-state directory or referenced from `url()` in the entry CSS.
    pub name: String,
    pub bytes: Vec<u8>,
    pub kind: AssetKind,
}

/// A fully validated `.codexskin` package, held entirely in memory.
#[derive(Debug, Clone)]
pub struct SkinPackage {
    pub manifest: SkinManifest,
    /// The validated, allowlisted CSS text of `manifest.entry_css`.
    pub entry_css: String,
    pub assets: Vec<SkinAsset>,
}

/// Why a `.codexskin` package was refused.
#[derive(Debug, Error)]
pub enum ImportError {
    #[error("archive could not be opened: {0}")]
    CorruptArchive(String),
    #[error("archive contains too many entries (max {max})")]
    TooManyEntries { max: usize },
    #[error("archive is missing theme.json")]
    MissingManifest,
    #[error("theme.json is invalid: {0}")]
    Manifest(#[from] ManifestError),
    #[error("unsafe entry name {name:?}: {reason}")]
    UnsafeEntryName { name: String, reason: String },
    #[error("duplicate entry name (after case normalisation): {0:?}")]
    DuplicateEntry(String),
    #[error("symlink entries are refused: {0:?}")]
    SymlinkEntryRefused(String),
    #[error(
        "entry {name:?} declares {declared} bytes uncompressed from {compressed} bytes \
         compressed, exceeding the {ratio}x cap"
    )]
    DecompressionRatioExceeded {
        name: String,
        declared: u64,
        compressed: u64,
        ratio: u64,
    },
    #[error("entry {name:?} exceeds the per-file size cap of {cap} bytes")]
    FileTooLarge { name: String, cap: u64 },
    #[error("archive exceeds the total uncompressed size cap of {cap} bytes")]
    ArchiveTooLarge { cap: u64 },
    #[error("entry {name:?} decompressed past the {cap}-byte streaming cap")]
    DecompressionCapExceeded { name: String, cap: u64 },
    #[error("entry {name:?} declared {declared} bytes but {actual} were read")]
    DeclaredSizeMismatch {
        name: String,
        declared: u64,
        actual: u64,
    },
    #[error("file type not allowed: {0:?}")]
    DisallowedFileType(String),
    #[error(
        "a second, unreferenced CSS file is present: {0:?} (only the manifest's entry_css is permitted)"
    )]
    UnexpectedCssFile(String),
    #[error("unexpected additional JSON file: {0:?}")]
    UnexpectedJsonFile(String),
    #[error(
        "entry {name:?} does not match its declared type ({kind:?}): magic bytes did not match"
    )]
    MimeMismatch { name: String, kind: AssetKind },
    #[error("SVG asset {0:?} is not valid UTF-8 or does not look like an SVG document")]
    InvalidSvg(String),
    #[error("SVG asset {name:?} contains a script vector ({vector:?})")]
    ScriptVectorInAsset { name: String, vector: String },
    #[error("theme.css is not valid UTF-8")]
    InvalidCssEncoding,
    #[error("CSS validation failed: {0}")]
    Css(#[from] CssError),
    #[error("manifest names entry_css {0:?}, which is not present in the archive")]
    EntryCssMissing(String),
    #[error("io error: {0}")]
    Io(String),
}

impl From<std::io::Error> for ImportError {
    fn from(e: std::io::Error) -> Self {
        ImportError::Io(e.to_string())
    }
}

/// Parse, validate, and safely extract (into memory) a `.codexskin` package.
pub fn import_codexskin(zip_bytes: &[u8]) -> Result<SkinPackage, ImportError> {
    let mut archive = ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|e| ImportError::CorruptArchive(e.to_string()))?;

    if archive.len() > MAX_ENTRIES {
        return Err(ImportError::TooManyEntries { max: MAX_ENTRIES });
    }

    // ── Pass 1: structural validation only — no content is read yet ────────
    let mut seen_lower = HashSet::new();
    let mut entries: Vec<(usize, String, u64)> = Vec::with_capacity(archive.len());
    let mut total_declared: u64 = 0;

    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| ImportError::CorruptArchive(e.to_string()))?;
        let raw_name = entry
            .name()
            .map_err(|e| ImportError::CorruptArchive(e.to_string()))?
            .into_owned();
        let is_dir = entry.is_dir();
        let is_symlink = entry.is_symlink();
        let declared_size = entry.size();
        let compressed_size = entry.compressed_size();
        drop(entry);

        let path = validate_entry_name(&raw_name)?;

        let lower = path.to_ascii_lowercase();
        if !seen_lower.insert(lower) {
            return Err(ImportError::DuplicateEntry(path));
        }
        if is_symlink {
            return Err(ImportError::SymlinkEntryRefused(path));
        }
        if is_dir {
            continue;
        }

        check_decompression_ratio(&path, compressed_size, declared_size)?;
        if declared_size > MAX_SINGLE_FILE_UNCOMPRESSED_BYTES {
            return Err(ImportError::FileTooLarge {
                name: path,
                cap: MAX_SINGLE_FILE_UNCOMPRESSED_BYTES,
            });
        }
        total_declared = total_declared.saturating_add(declared_size);
        if total_declared > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err(ImportError::ArchiveTooLarge {
                cap: MAX_TOTAL_UNCOMPRESSED_BYTES,
            });
        }

        entries.push((i, path, declared_size));
    }

    // ── Manifest first: everything else is interpreted relative to it ──────
    let (manifest_index, manifest_declared) = entries
        .iter()
        .find(|(_, path, _)| path == "theme.json")
        .map(|(i, _, size)| (*i, *size))
        .ok_or(ImportError::MissingManifest)?;
    let manifest_bytes = read_entry_capped(
        &mut archive,
        manifest_index,
        manifest_declared,
        MAX_SINGLE_FILE_UNCOMPRESSED_BYTES,
    )?;
    let manifest = SkinManifest::parse(&manifest_bytes)?;

    // ── Pass 2: classify and read everything else ───────────────────────────
    let mut assets = Vec::new();
    let mut entry_css: Option<String> = None;

    for (index, path, declared_size) in &entries {
        if path == "theme.json" {
            continue;
        }

        if path.ends_with(".css") {
            if path != &manifest.entry_css {
                return Err(ImportError::UnexpectedCssFile(path.clone()));
            }
            let bytes = read_entry_capped(
                &mut archive,
                *index,
                *declared_size,
                MAX_SINGLE_FILE_UNCOMPRESSED_BYTES,
            )?;
            let text = String::from_utf8(bytes).map_err(|_| ImportError::InvalidCssEncoding)?;
            entry_css = Some(text);
            continue;
        }

        if path.ends_with(".json") {
            return Err(ImportError::UnexpectedJsonFile(path.clone()));
        }

        let kind = classify_extension(path)
            .ok_or_else(|| ImportError::DisallowedFileType(path.clone()))?;
        let bytes = read_entry_capped(
            &mut archive,
            *index,
            *declared_size,
            MAX_SINGLE_FILE_UNCOMPRESSED_BYTES,
        )?;
        verify_magic_bytes(kind, &bytes, path)?;
        if kind == AssetKind::Svg {
            scan_svg_for_script(&bytes, path)?;
        }
        assets.push(SkinAsset {
            name: path.clone(),
            bytes,
            kind,
        });
    }

    let entry_css =
        entry_css.ok_or_else(|| ImportError::EntryCssMissing(manifest.entry_css.clone()))?;

    let bundled: HashSet<String> = assets.iter().map(|a| a.name.clone()).collect();
    validate_css(&entry_css, &bundled)?;

    Ok(SkinPackage {
        manifest,
        entry_css,
        assets,
    })
}

impl SkinPackage {
    /// Write this package's CSS and assets under `dest_dir`.
    ///
    /// Every path is re-validated with [`safe_join`] on the way out, even
    /// though every name already passed [`validate_entry_name`] on the way
    /// in — belt and suspenders: this is the one function that actually
    /// touches a real filesystem path, so it does not rely solely on an
    /// invariant established several calls away.
    pub fn write_to(&self, dest_dir: &Path) -> Result<(), ImportError> {
        fs::create_dir_all(dest_dir)?;

        let css_path = safe_join(dest_dir, &self.manifest.entry_css)?;
        if let Some(parent) = css_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&css_path, &self.entry_css)?;

        for asset in &self.assets {
            let path = safe_join(dest_dir, &asset.name)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, &asset.bytes)?;
        }
        Ok(())
    }
}

/// Join `relative` onto `dest_dir`, refusing anything that would not stay
/// under `dest_dir` — a `..` component, an absolute path, or a root/prefix.
///
/// Kept independent of [`validate_entry_name`] on purpose: this is the last
/// line of defense at the point bytes actually hit disk, not a restatement
/// of the first check.
pub fn safe_join(dest_dir: &Path, relative: &str) -> Result<PathBuf, ImportError> {
    let rel_path = Path::new(relative);
    if rel_path.is_absolute() {
        return Err(ImportError::UnsafeEntryName {
            name: relative.to_string(),
            reason: "absolute path".to_string(),
        });
    }

    let mut result = dest_dir.to_path_buf();
    for component in rel_path.components() {
        match component {
            std::path::Component::Normal(part) => result.push(part),
            _ => {
                return Err(ImportError::UnsafeEntryName {
                    name: relative.to_string(),
                    reason: "non-normal path component (.., prefix, or root)".to_string(),
                });
            }
        }
    }

    if !result.starts_with(dest_dir) {
        return Err(ImportError::UnsafeEntryName {
            name: relative.to_string(),
            reason: "resolved path escapes the destination directory".to_string(),
        });
    }
    Ok(result)
}

/// Ratio guard: refuses an entry whose declared uncompressed size is more
/// than [`MAX_DECOMPRESSION_RATIO`] times its compressed size.
///
/// A pure function of two numbers so it is testable without a real archive
/// (see `check_decompression_ratio_rejects_a_bomb_by_the_numbers`), and reused
/// for real inside [`import_codexskin`].
pub fn check_decompression_ratio(
    name: &str,
    compressed: u64,
    declared: u64,
) -> Result<(), ImportError> {
    if declared > compressed.saturating_mul(MAX_DECOMPRESSION_RATIO) {
        return Err(ImportError::DecompressionRatioExceeded {
            name: name.to_string(),
            declared,
            compressed,
            ratio: MAX_DECOMPRESSION_RATIO,
        });
    }
    Ok(())
}

/// Validate a raw zip entry name and return it normalised to a plain
/// forward-slash relative path.
///
/// Refuses, independently: absolute paths, backslashes, any colon (blocks
/// both a Windows drive letter and an NTFS alternate-data-stream suffix),
/// `.`/`..` components, empty components, a trailing dot or space on any
/// component (Windows quietly strips these when resolving a path, which
/// would otherwise let two distinct zip entries collide on disk), and
/// Windows reserved device names (`CON`, `NUL`, `COM1`, ... — case
/// insensitive, checked against the stem so `con.png` is caught too).
pub fn validate_entry_name(raw: &str) -> Result<String, ImportError> {
    let refuse = |reason: &str| {
        Err(ImportError::UnsafeEntryName {
            name: raw.to_string(),
            reason: reason.to_string(),
        })
    };

    if raw.is_empty() {
        return refuse("empty name");
    }
    if raw.contains('\0') {
        return refuse("embedded NUL byte");
    }
    if raw.starts_with('/') {
        return refuse("absolute path");
    }
    if raw.contains('\\') {
        return refuse("backslash path separator");
    }
    if raw.contains(':') {
        return refuse("colon in path (drive letter or alternate data stream)");
    }

    let mut normalised = Vec::new();
    for component in raw.split('/') {
        if component.is_empty() {
            return refuse("empty path component");
        }
        if component == "." || component == ".." {
            return refuse("path traversal component");
        }
        if component.ends_with('.') || component.ends_with(' ') {
            return refuse("trailing dot or space in path component");
        }
        let stem = component.split('.').next().unwrap_or(component);
        if is_reserved_windows_name(stem) {
            return refuse("reserved Windows device name");
        }
        normalised.push(component);
    }
    Ok(normalised.join("/"))
}

fn is_reserved_windows_name(stem: &str) -> bool {
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem))
}

/// Extension allowlist. Anything not listed here is refused outright —
/// notably `.js`, any executable extension, and any file with no extension
/// at all.
fn classify_extension(path: &str) -> Option<AssetKind> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    // A name with no '.' at all makes `rsplit('.').next()` return the whole
    // string, which then simply matches nothing below — refused, not
    // guessed at.
    match ext.as_str() {
        "png" => Some(AssetKind::Png),
        "jpg" | "jpeg" => Some(AssetKind::Jpeg),
        "webp" => Some(AssetKind::Webp),
        "svg" => Some(AssetKind::Svg),
        "woff" => Some(AssetKind::Woff),
        "woff2" => Some(AssetKind::Woff2),
        "ttf" => Some(AssetKind::Ttf),
        "otf" => Some(AssetKind::Otf),
        _ => None,
    }
}

/// Confirm an asset's magic bytes actually match its claimed [`AssetKind`],
/// so renaming `payload.exe` to `payload.png` is not sufficient to pass.
fn verify_magic_bytes(kind: AssetKind, bytes: &[u8], name: &str) -> Result<(), ImportError> {
    let matches = match kind {
        AssetKind::Png => bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        AssetKind::Jpeg => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        AssetKind::Webp => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        AssetKind::Woff => bytes.starts_with(b"wOFF"),
        AssetKind::Woff2 => bytes.starts_with(b"wOF2"),
        AssetKind::Ttf => {
            bytes.starts_with(&[0x00, 0x01, 0x00, 0x00])
                || bytes.starts_with(b"true")
                || bytes.starts_with(b"typ1")
        }
        AssetKind::Otf => bytes.starts_with(b"OTTO"),
        // SVG is text, not a fixed magic-byte format; its own structural
        // check is `scan_svg_for_script`, applied separately by the caller.
        AssetKind::Svg => return Ok(()),
    };
    if matches {
        Ok(())
    } else {
        Err(ImportError::MimeMismatch {
            name: name.to_string(),
            kind,
        })
    }
}

/// Reject any SVG asset that could carry script, and require that what
/// remains at least looks like an SVG document.
///
/// This is a conservative textual scan, not a full XML parser: it is meant
/// to fail closed on the well-known vectors (`<script>`, `on*=` handlers,
/// `javascript:` URIs, `<foreignObject>` which can embed arbitrary HTML,
/// `<iframe>`), not to prove a document is exhaustively safe.
fn scan_svg_for_script(bytes: &[u8], name: &str) -> Result<(), ImportError> {
    let text = std::str::from_utf8(bytes).map_err(|_| ImportError::InvalidSvg(name.to_string()))?;
    let lower = text.to_ascii_lowercase();

    const DANGEROUS: &[&str] = &[
        "<script",
        "javascript:",
        "onload=",
        "onerror=",
        "onclick=",
        "onmouseover=",
        "<foreignobject",
        "<iframe",
    ];
    for vector in DANGEROUS {
        if lower.contains(vector) {
            return Err(ImportError::ScriptVectorInAsset {
                name: name.to_string(),
                vector: (*vector).to_string(),
            });
        }
    }
    if !lower.contains("<svg") {
        return Err(ImportError::InvalidSvg(name.to_string()));
    }
    Ok(())
}

/// Read one entry's bytes under a hard streaming cap, independent of what the
/// archive's own metadata claims.
///
/// The cap is enforced by actually limiting the reader (`Read::take`), so a
/// deflate stream that would expand past it is cut off during decompression
/// rather than after the fact — the metadata-based [`check_decompression_ratio`]
/// guard is what usually catches a bomb first, but this is the backstop for a
/// declared size that itself was a lie.
fn read_entry_capped<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    index: usize,
    declared_size: u64,
    cap: u64,
) -> Result<Vec<u8>, ImportError> {
    let entry = archive
        .by_index(index)
        .map_err(|e| ImportError::CorruptArchive(e.to_string()))?;
    let name = entry
        .name()
        .map_err(|e| ImportError::CorruptArchive(e.to_string()))?
        .into_owned();
    let mut limited = entry.take(cap.saturating_add(1));
    let mut buf = Vec::new();
    limited.read_to_end(&mut buf)?;

    if buf.len() as u64 > cap {
        return Err(ImportError::DecompressionCapExceeded { name, cap });
    }
    if buf.len() as u64 != declared_size {
        return Err(ImportError::DeclaredSizeMismatch {
            name,
            declared: declared_size,
            actual: buf.len() as u64,
        });
    }
    Ok(buf)
}
