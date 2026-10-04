// Step 6.3 RED — first-run payload download.
//
// D6 was revised on 2026-07-26: no Codex payload ships in our package. The
// client fetches it on first run. That moves the entire question of "is this
// the binary we approved" from build time to runtime, so this path is now the
// only thing standing between a user and an arbitrary executable.
//
// R7 requires a recovery drill covering download interruption, network loss and
// a full disk. Those are the tests below: every failure mode must leave the
// managed runtime exactly as it was, with no partial install and nothing for
// the user to clean up by hand.
//
// The source is a trait so none of this touches the network.

use chimera_runtime::download::{
    DownloadError, PayloadSource, PayloadSpec, Preflight, fetch_payload, preflight,
};
use chimera_runtime::update::RuntimeLayout;
use sha2::{Digest, Sha256};
use std::io::{self, Read};
use tempfile::TempDir;

fn digest_of(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn spec(bytes: &[u8]) -> PayloadSpec {
    PayloadSpec {
        version: "26.721".to_string(),
        url: "https://mirror.example.com/codex-26.721.zip".to_string(),
        size_bytes: bytes.len() as u64,
        sha256: digest_of(bytes),
    }
}

/// Serves bytes from memory, optionally truncating or erroring part way.
struct FakeSource {
    body: Vec<u8>,
    /// Stop after this many bytes and return an error, simulating a dropped
    /// connection. `None` serves the whole body.
    fail_after: Option<usize>,
}

impl FakeSource {
    fn ok(body: &[u8]) -> Self {
        Self {
            body: body.to_vec(),
            fail_after: None,
        }
    }
    fn drops_after(body: &[u8], n: usize) -> Self {
        Self {
            body: body.to_vec(),
            fail_after: Some(n),
        }
    }
}

struct FakeReader {
    body: Vec<u8>,
    pos: usize,
    fail_after: Option<usize>,
}

impl Read for FakeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if let Some(limit) = self.fail_after {
            if self.pos >= limit {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection reset",
                ));
            }
        }
        let remaining = self.body.len().saturating_sub(self.pos);
        if remaining == 0 {
            return Ok(0);
        }
        let n = buf.len().min(remaining).min(64);
        buf[..n].copy_from_slice(&self.body[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

impl PayloadSource for FakeSource {
    fn open(&self, _url: &str) -> Result<Box<dyn Read + Send>, DownloadError> {
        Ok(Box::new(FakeReader {
            body: self.body.clone(),
            pos: 0,
            fail_after: self.fail_after,
        }))
    }
}

/// A source that cannot connect at all.
struct OfflineSource;
impl PayloadSource for OfflineSource {
    fn open(&self, _url: &str) -> Result<Box<dyn Read + Send>, DownloadError> {
        Err(DownloadError::Unreachable)
    }
}

fn layout(dir: &TempDir) -> RuntimeLayout {
    let l = RuntimeLayout::new(dir.path().join("rt"));
    l.initialise().unwrap();
    l
}

/// Nothing beyond the directories `initialise` creates.
fn staging_is_clean(l: &RuntimeLayout) -> bool {
    std::fs::read_dir(l.staging_dir())
        .map(|d| d.count() == 0)
        .unwrap_or(false)
}

// ── The happy path ──────────────────────────────────────────────────────────

#[test]
fn a_matching_payload_lands_in_staging() {
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);
    let body = b"pretend this is a Codex archive".repeat(40);

    let staged = fetch_payload(&l, &spec(&body), &FakeSource::ok(&body)).expect("download");

    assert!(
        staged.exists(),
        "the payload must be where the caller was told"
    );
    assert_eq!(std::fs::read(&staged).unwrap(), body);
}

// ── Every failure leaves nothing behind ─────────────────────────────────────

#[test]
fn a_wrong_digest_is_refused_and_discarded() {
    // The whole point of D6's inversion: the bytes we fetched are only
    // trustworthy because they match a digest we approved beforehand.
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);
    let body = b"legitimate payload".repeat(50);
    let mut wrong = spec(&body);
    wrong.sha256 = "0".repeat(64);

    let err = fetch_payload(&l, &wrong, &FakeSource::ok(&body)).unwrap_err();

    assert!(
        matches!(err, DownloadError::DigestMismatch { .. }),
        "got {err:?}"
    );
    assert!(
        staging_is_clean(&l),
        "a payload that failed verification must not survive anywhere on disk"
    );
}

#[test]
fn a_size_mismatch_is_refused_before_the_whole_body_is_read() {
    // Size is checked as bytes arrive, not after. A mirror that serves a
    // multi-gigabyte body for a manifest claiming 40 MB must not be allowed to
    // fill the disk first and be rejected second.
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);
    let body = b"x".repeat(10_000);
    let mut lying = spec(&body);
    lying.size_bytes = 100;

    let err = fetch_payload(&l, &lying, &FakeSource::ok(&body)).unwrap_err();

    assert!(
        matches!(err, DownloadError::SizeMismatch { .. }),
        "got {err:?}"
    );
    assert!(staging_is_clean(&l));
}

#[test]
fn a_short_body_is_refused_even_though_it_never_exceeds_the_size() {
    // The mirror-image of the case above: truncation is not caught by the
    // "too big" check and would otherwise reach the digest check with a
    // partial file — correct but for the wrong reason, and only by luck.
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);
    let body = b"y".repeat(10_000);
    let s = spec(&body);

    let err = fetch_payload(&l, &s, &FakeSource::ok(&body[..5_000])).unwrap_err();

    assert!(
        matches!(
            err,
            DownloadError::SizeMismatch { .. } | DownloadError::DigestMismatch { .. }
        ),
        "got {err:?}"
    );
    assert!(staging_is_clean(&l));
}

#[test]
fn a_dropped_connection_leaves_no_partial_file() {
    // R7's interruption drill. A .part left behind would be picked up as a
    // finished download by anything that only checks for existence.
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);
    let body = b"z".repeat(10_000);

    let err = fetch_payload(&l, &spec(&body), &FakeSource::drops_after(&body, 3_000)).unwrap_err();

    assert!(matches!(err, DownloadError::Transport(_)), "got {err:?}");
    assert!(
        staging_is_clean(&l),
        "an interrupted download must clean up after itself"
    );
}

#[test]
fn being_offline_is_reported_as_unreachable_not_as_corruption() {
    // These need different advice. Telling someone their download is corrupt
    // when their wifi is off sends them to re-download forever.
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);
    let body = b"anything".to_vec();

    let err = fetch_payload(&l, &spec(&body), &OfflineSource).unwrap_err();

    assert!(matches!(err, DownloadError::Unreachable), "got {err:?}");
    assert!(staging_is_clean(&l));
}

#[test]
fn a_failed_download_can_simply_be_retried() {
    // No manual cleanup, no half-state to reason about: the second attempt
    // must behave exactly like a first attempt.
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);
    let body = b"retry me".repeat(100);
    let s = spec(&body);

    let _ = fetch_payload(&l, &s, &FakeSource::drops_after(&body, 100)).unwrap_err();
    let staged = fetch_payload(&l, &s, &FakeSource::ok(&body)).expect("retry must succeed");

    assert_eq!(std::fs::read(&staged).unwrap(), body);
}

// ── Preflight ───────────────────────────────────────────────────────────────

#[test]
fn preflight_refuses_when_free_space_is_below_what_the_payload_needs() {
    // Refusing before the download is the difference between "not enough disk
    // space" and a half-written runtime plus a full disk.
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);

    let verdict = preflight(&l, 500, /* available_bytes */ Some(400));

    assert!(
        matches!(verdict, Preflight::InsufficientSpace { .. }),
        "got {verdict:?}"
    );
}

#[test]
fn preflight_demands_headroom_beyond_the_payload_itself() {
    // The payload is downloaded AND unpacked, so free space equal to the
    // download is not enough — it would fail during extraction instead, which
    // is a far worse place to run out.
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);

    let verdict = preflight(&l, 1_000, Some(1_100));

    assert!(
        matches!(verdict, Preflight::InsufficientSpace { .. }),
        "space barely above the payload size must still be refused: {verdict:?}"
    );
}

#[test]
fn preflight_passes_with_ample_space() {
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);
    assert!(matches!(
        preflight(&l, 1_000, Some(1_000_000_000)),
        Preflight::Ok
    ));
}

#[test]
fn unknown_free_space_does_not_block_the_download() {
    // Some filesystems do not report it. Refusing to install because we could
    // not measure the disk would be worse than letting the write itself fail,
    // which is already handled and recoverable.
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);
    assert!(matches!(preflight(&l, 1_000, None), Preflight::Ok));
}

#[test]
fn preflight_refuses_an_unwritable_runtime_root() {
    let dir = TempDir::new().unwrap();
    let l = RuntimeLayout::new(dir.path().join("never-created"));
    // initialise() deliberately not called: the directory does not exist.
    let verdict = preflight(&l, 1_000, Some(1_000_000_000));
    assert!(
        matches!(verdict, Preflight::NotWritable { .. }),
        "got {verdict:?}"
    );
}

// ── Errors are safe to show a user ──────────────────────────────────────────

#[test]
fn error_messages_do_not_leak_the_url_or_raw_io_text() {
    // The URL can carry a mirror path we do not want in a screenshot, and a
    // raw io::Error is not actionable. Both would end up in a support ticket.
    let dir = TempDir::new().unwrap();
    let l = layout(&dir);
    let body = b"leaky".repeat(20);
    let mut s = spec(&body);
    s.url = "https://internal-mirror.example.com/secret-path/codex.zip".to_string();
    s.sha256 = "1".repeat(64);

    let err = fetch_payload(&l, &s, &FakeSource::ok(&body)).unwrap_err();
    let shown = err.to_string();

    assert!(
        !shown.contains("secret-path"),
        "URL leaked into the message: {shown}"
    );
    assert!(!shown.contains("os error"), "raw io text leaked: {shown}");
    assert!(
        shown.len() > 10,
        "message must actually say something: {shown}"
    );
}

// ── The real HTTP source ────────────────────────────────────────────────────
// Its network behaviour cannot be unit-tested without a server, so what is
// pinned here is the part that does not need one: the redirect rule, which is
// what stops a mirror from bouncing the request to a host the manifest never
// named.

#[test]
fn the_http_source_refuses_an_off_origin_redirect() {
    use chimera_runtime::download::redirect_allowed;

    assert!(redirect_allowed(
        "https://mirror.example.com/a/codex.zip",
        "https://mirror.example.com/b/codex.zip",
    ));
    assert!(!redirect_allowed(
        "https://mirror.example.com/codex.zip",
        "https://elsewhere.example.net/codex.zip",
    ));
    assert!(!redirect_allowed(
        "https://mirror.example.com/codex.zip",
        "http://mirror.example.com/codex.zip",
    ));
    // Fails closed on anything unparseable.
    assert!(!redirect_allowed(
        "https://mirror.example.com/codex.zip",
        "«"
    ));
}

#[test]
fn the_http_source_is_constructible_without_touching_the_network() {
    // Building the client must not perform I/O. If it did, an offline machine
    // would fail at construction with an error that has nothing to do with the
    // download the user actually attempted.
    use chimera_runtime::download::HttpPayloadSource;
    let _ = HttpPayloadSource::new();
}
