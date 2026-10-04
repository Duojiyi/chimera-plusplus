//! Step 6.3 — fetch the Codex payload on first run.
//!
//! D6 (revised 2026-07-26) removed the payload from our package: the client
//! downloads it instead. That moves "is this the binary we approved?" from
//! build time to runtime, and makes this module the only thing between a user
//! and an arbitrary executable.
//!
//! Two rules follow from that, and everything here exists to serve them:
//!
//! 1. **Nothing is trusted until it matches a digest we approved beforehand.**
//!    The digest comes from a signed stable manifest, so verification here is
//!    the second half of a chain whose first half is `mirror-contract`.
//! 2. **Every failure leaves the runtime exactly as it was.** The download
//!    writes to a temporary file that is renamed into place only after
//!    verification passes, so an interruption, a truncated body or a wrong
//!    digest is always safe to retry with no manual cleanup (R7).
//!
//! Transport is a trait rather than a concrete HTTP client so the failure modes
//! that matter — a dropped connection, a lying `Content-Length`, being offline —
//! are ordinary unit tests rather than something only a live mirror can produce.

use crate::update::RuntimeLayout;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use thiserror::Error;

/// Extra free space required beyond the download itself.
///
/// The archive is downloaded *and* unpacked, so space equal to the payload is
/// not enough. Running out during extraction leaves a half-written version
/// directory, which is a far worse place to fail than before the first byte.
const UNPACK_HEADROOM: u64 = 2;

/// Read cap while streaming, so a mirror that ignores the declared size cannot
/// make us allocate without bound before the size check fires.
const CHUNK: usize = 64 * 1024;

/// Where the bytes come from. Implemented over HTTP in production and over a
/// buffer in tests.
pub trait PayloadSource {
    /// Open a byte stream for `url`.
    ///
    /// Returning a reader rather than a `Vec<u8>` is deliberate: the size check
    /// has to fire while bytes are still arriving, not after a multi-gigabyte
    /// body has already been buffered.
    fn open(&self, url: &str) -> Result<Box<dyn Read + Send>, DownloadError>;
}

/// What the signed manifest says we should receive.
#[derive(Debug, Clone)]
pub struct PayloadSpec {
    pub version: String,
    pub url: String,
    pub size_bytes: u64,
    /// Lowercase hex SHA-256.
    pub sha256: String,
}

#[derive(Debug, Error)]
pub enum DownloadError {
    /// Deliberately carries no URL: the message reaches screenshots and support
    /// tickets, and a mirror path is not the user's business.
    #[error("Could not reach the download server. Check your network and try again.")]
    Unreachable,

    /// Wraps the kind, never the raw `io::Error`, whose text is not actionable.
    #[error("The download was interrupted. Nothing was installed; try again.")]
    Transport(std::io::ErrorKind),

    #[error("The download did not match its expected size. Nothing was installed; try again.")]
    SizeMismatch { expected: u64, actual: u64 },

    #[error(
        "The downloaded file failed its integrity check and was discarded. \
         If this keeps happening, your connection may be altering downloads."
    )]
    DigestMismatch { expected: String, actual: String },

    #[error("Could not write to the Chimera folder. Check disk space and permissions.")]
    Storage(std::io::ErrorKind),

    #[error("The download server sent a malformed digest for this version.")]
    MalformedSpec,
}

impl DownloadError {
    fn storage(e: std::io::Error) -> Self {
        DownloadError::Storage(e.kind())
    }
}

/// Result of the checks that run before a single byte is fetched.
#[derive(Debug, PartialEq, Eq)]
pub enum Preflight {
    Ok,
    InsufficientSpace { needed: u64, available: u64 },
    NotWritable { path: PathBuf },
}

/// Decide whether it is worth starting a download at all.
///
/// `available_bytes` is passed in rather than measured here so the decision is
/// testable and so the caller owns the platform-specific query. `None` means
/// the filesystem did not report it, which is not a reason to refuse: the
/// write itself already fails safely, and blocking an install because we could
/// not measure a disk would be worse than letting it try.
pub fn preflight(
    layout: &RuntimeLayout,
    payload_bytes: u64,
    available_bytes: Option<u64>,
) -> Preflight {
    let root = layout.root();
    if !root.is_dir() {
        return Preflight::NotWritable {
            path: root.to_path_buf(),
        };
    }
    // Probing with a real write catches read-only mounts and ACLs that a
    // metadata check reports as fine.
    let probe = root.join(".chimera-write-probe");
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
        }
        Err(_) => {
            return Preflight::NotWritable {
                path: root.to_path_buf(),
            };
        }
    }

    if let Some(available) = available_bytes {
        let needed = payload_bytes.saturating_mul(UNPACK_HEADROOM);
        if available < needed {
            return Preflight::InsufficientSpace { needed, available };
        }
    }
    Preflight::Ok
}

/// Download `spec` into staging and return the verified file's path.
///
/// On any failure the temporary file is removed, so the caller can retry
/// without cleaning anything up and a later step can never mistake a partial
/// download for a finished one.
pub fn fetch_payload(
    layout: &RuntimeLayout,
    spec: &PayloadSpec,
    source: &dyn PayloadSource,
) -> Result<PathBuf, DownloadError> {
    if spec.sha256.len() != 64 || !spec.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(DownloadError::MalformedSpec);
    }

    let staging = layout.staging_dir();
    fs::create_dir_all(&staging).map_err(DownloadError::storage)?;

    let final_path = staging.join(format!("codex-{}.payload", spec.version));
    let part_path = staging.join(format!("codex-{}.payload.part", spec.version));

    // A leftover .part from a previous crash is not resumed. Resuming would
    // mean trusting bytes whose provenance we cannot re-check, and the digest
    // covers the whole file — so restarting is both simpler and safer.
    let _ = fs::remove_file(&part_path);

    let outcome = stream_to_file(&part_path, spec, source);

    match outcome {
        Ok(()) => {
            fs::rename(&part_path, &final_path).map_err(|e| {
                let _ = fs::remove_file(&part_path);
                DownloadError::storage(e)
            })?;
            Ok(final_path)
        }
        Err(e) => {
            // Best effort: if this fails the next attempt truncates it anyway.
            let _ = fs::remove_file(&part_path);
            Err(e)
        }
    }
}

/// Re-check a staged payload immediately before installation. The download
/// path verifies bytes before renaming them, but the file remains user-writable
/// while it sits in staging; a second digest check prevents a local edit from
/// becoming an executable install.
pub fn verify_payload_file(
    path: &std::path::Path,
    expected_sha256: &str,
) -> Result<(), DownloadError> {
    if expected_sha256.len() != 64 || !expected_sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(DownloadError::MalformedSpec);
    }
    let mut file = fs::File::open(path).map_err(DownloadError::storage)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| DownloadError::Transport(e.kind()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(DownloadError::DigestMismatch {
            expected: expected_sha256.to_string(),
            actual,
        });
    }
    Ok(())
}

/// Stream the body to `part_path`, checking size as it goes and the digest at
/// the end. Split out so `fetch_payload` has exactly one cleanup path.
fn stream_to_file(
    part_path: &std::path::Path,
    spec: &PayloadSpec,
    source: &dyn PayloadSource,
) -> Result<(), DownloadError> {
    let mut reader = source.open(&spec.url)?;
    let mut file = fs::File::create(part_path).map_err(DownloadError::storage)?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut buf = vec![0u8; CHUNK];

    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return Err(DownloadError::Transport(e.kind())),
        };

        written += n as u64;
        // Checked mid-stream, not after: a body that ignores the declared size
        // must not be allowed to fill the disk and then be rejected.
        if written > spec.size_bytes {
            return Err(DownloadError::SizeMismatch {
                expected: spec.size_bytes,
                actual: written,
            });
        }

        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(DownloadError::storage)?;
    }

    // Truncation never trips the check above, so it needs its own.
    if written != spec.size_bytes {
        return Err(DownloadError::SizeMismatch {
            expected: spec.size_bytes,
            actual: written,
        });
    }

    file.flush().map_err(DownloadError::storage)?;
    file.sync_all().map_err(DownloadError::storage)?;
    drop(file);

    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(&spec.sha256) {
        return Err(DownloadError::DigestMismatch {
            expected: spec.sha256.clone(),
            actual,
        });
    }

    Ok(())
}

// ── The real transport ─────────────────────────────────────────────────────

/// Maximum redirects to follow before giving up.
const MAX_REDIRECTS: usize = 5;

/// How long to wait for the server to start responding.
///
/// Only the handshake, not the transfer: a large payload on a slow connection
/// is legitimately slow, and a total timeout would make the download impossible
/// rather than just slow for exactly the users least able to retry it.
const CONNECT_TIMEOUT_SECS: u64 = 15;

/// May a redirect be followed while fetching a payload?
///
/// The manifest names one host and vouches for one digest. A redirect to a
/// different origin is a different host than the one that was signed for, so it
/// is refused even though the digest check would eventually catch a substituted
/// file — refusing early means we never spend the bandwidth, and it keeps the
/// failure attributable to the redirect rather than surfacing as "corrupt
/// download" and sending the user to re-try forever.
///
/// The rule lives in `chimera-domain` because `chimera-provider`'s probe needs
/// the identical one and adapter crates may not depend on each other.
pub fn redirect_allowed(from: &str, to: &str) -> bool {
    chimera_domain::same_origin(from, to)
}

/// Fetches payloads over HTTPS.
///
/// Deliberately blocking. The download is one streamed file behind a
/// `std::io::Read`, and introducing an async runtime here would push it onto
/// every caller for no benefit the sync path does not already have.
pub struct HttpPayloadSource {
    client: reqwest::blocking::Client,
}

impl HttpPayloadSource {
    /// Build the client. Performs no I/O, so an offline machine fails at the
    /// download with a network error rather than at construction with something
    /// unrelated to what the user attempted.
    pub fn new() -> Self {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                return attempt.error("too many redirects");
            }
            let from = attempt
                .previous()
                .last()
                .map(|u| u.to_string())
                .unwrap_or_default();
            if redirect_allowed(&from, attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });

        // A builder failure here would mean TLS could not be initialised at
        // all. Falling back to the default client keeps construction
        // infallible; the request itself then fails with a real network error
        // the caller can report, instead of a panic at startup.
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .redirect(policy)
            .build()
            .unwrap_or_default();

        Self { client }
    }
}

impl Default for HttpPayloadSource {
    fn default() -> Self {
        Self::new()
    }
}

impl PayloadSource for HttpPayloadSource {
    fn open(&self, url: &str) -> Result<Box<dyn Read + Send>, DownloadError> {
        // Only https. The manifest is signed, but a plaintext fetch would let
        // anyone on the path see exactly which version a user is installing.
        if !url.starts_with("https://") {
            return Err(DownloadError::MalformedSpec);
        }

        let response = self.client.get(url).send().map_err(|e| {
            if e.is_timeout() {
                DownloadError::Transport(std::io::ErrorKind::TimedOut)
            } else {
                DownloadError::Unreachable
            }
        })?;

        let status = response.status();
        if status.is_redirection() {
            // The policy stopped rather than followed, which only happens when
            // the destination left the origin the manifest named.
            return Err(DownloadError::Unreachable);
        }
        if !status.is_success() {
            return Err(DownloadError::Unreachable);
        }

        Ok(Box::new(response))
    }
}
