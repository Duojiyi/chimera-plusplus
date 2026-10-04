// Step 6.3 RED — managed install.
//
// The audit's finding on this step was not "undertested", it was "absent":
// `stage_version` and `commit_version` had no production caller anywhere, and
// `fetch_payload` produced a verified archive that nothing ever unpacked. A
// user on a perfect machine could reach the main UI and never obtain a working
// Codex, because the step between "verified bytes on disk" and "an executable
// the launcher can find" did not exist.
//
// This file specifies that step. The archive arrives already digest-checked, so
// authenticity is settled before we get here — but a digest says the bytes are
// the ones that were signed for, not that they are safe to extract. An approved
// upstream archive can still carry an entry that escapes the directory it is
// unpacked into, and the digest would match perfectly. So extraction gets its
// own containment rules, tested here independently of provenance.
//
// Every failure must leave the managed runtime exactly as it was. That is the
// same contract `fetch_payload` already honours for downloads, and it is what
// makes "try again" a safe instruction to give a user.

use chimera_runtime::install::{
    InstallError, InstallLimits, install_payload, install_payload_with_limits,
};
use chimera_runtime::update::RuntimeLayout;
use std::io::Write;
use std::path::Path;
use tempfile::TempDir;
use zip::write::SimpleFileOptions;

const DIGEST: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

/// Build a zip in memory from `(name, contents)` pairs and write it to `path`.
///
/// Entry names are written verbatim, including the ones a well-behaved zip
/// writer would normalise away — the traversal tests depend on the malicious
/// spelling surviving into the archive.
fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default();
    for (name, body) in entries {
        zip.start_file(*name, opts).unwrap();
        zip.write_all(body).unwrap();
    }
    zip.finish().unwrap();
}

/// A layout on a fresh temp root, initialised the way the app does at startup.
fn layout() -> (TempDir, RuntimeLayout) {
    let dir = TempDir::new().unwrap();
    let layout = RuntimeLayout::new(dir.path().join("runtime"));
    layout.initialise().unwrap();
    (dir, layout)
}

/// The smallest archive that counts as a real Codex payload.
fn good_payload(dir: &Path) -> std::path::PathBuf {
    let p = dir.join("codex.zip");
    write_zip(
        &p,
        &[
            ("Codex.exe", b"MZ fake executable"),
            ("resources/app.asar", b"resources"),
        ],
    );
    p
}

#[test]
fn a_verified_payload_becomes_the_active_version() {
    let (dir, layout) = layout();
    let payload = good_payload(dir.path());

    let pointer = install_payload(&layout, "26.721", &payload, DIGEST).unwrap();

    assert_eq!(pointer.active_version, "26.721");
    assert_eq!(pointer.source_manifest_digest, DIGEST);

    // The launcher looks for the executable at the top of the version dir; if
    // extraction put it anywhere else the install is useless even though every
    // step reported success.
    let health = chimera_runtime::health::check_runtime_health(&layout).unwrap();
    assert!(health.exe_present, "installed runtime has no executable");
    assert_eq!(health.version.as_deref(), Some("26.721"));

    // Non-executable content must survive too, or Codex starts and immediately
    // fails on its own missing resources.
    assert!(
        layout
            .version_dir("26.721")
            .join("resources/app.asar")
            .exists(),
        "extraction dropped a non-executable entry"
    );
}

#[test]
fn an_entry_that_escapes_the_staging_directory_is_refused() {
    let (dir, layout) = layout();
    let payload = dir.path().join("evil.zip");
    write_zip(
        &payload,
        &[
            ("Codex.exe", b"MZ"),
            ("../../escaped.txt", b"should never be written"),
        ],
    );

    let err = install_payload(&layout, "26.721", &payload, DIGEST).unwrap_err();
    assert!(
        matches!(err, InstallError::UnsafeEntry { .. }),
        "expected UnsafeEntry, got {err:?}"
    );

    // The refusal has to be worth something: prove the file is not on disk
    // anywhere above the runtime root, which is where `../..` would land it.
    assert!(
        !dir.path().join("escaped.txt").exists(),
        "traversal entry was written outside the runtime root"
    );
    assert!(!layout.root().join("escaped.txt").exists());
}

#[test]
fn a_backslash_traversal_is_refused() {
    // Zip stores forward slashes by convention, so a backslash is not a
    // separator to the format — but it is one to Windows. An entry spelled
    // `..\escaped.txt` is a single "file name" to a naive reader and a
    // traversal to the OS that opens it.
    let (dir, layout) = layout();
    let payload = dir.path().join("evil.zip");
    write_zip(
        &payload,
        &[("Codex.exe", b"MZ"), (r"..\..\escaped.txt", b"nope")],
    );

    let err = install_payload(&layout, "26.721", &payload, DIGEST).unwrap_err();
    assert!(
        matches!(err, InstallError::UnsafeEntry { .. }),
        "expected UnsafeEntry, got {err:?}"
    );
    assert!(!dir.path().join("escaped.txt").exists());
}

#[test]
fn an_absolute_entry_path_is_refused() {
    let (dir, layout) = layout();
    let payload = dir.path().join("evil.zip");
    write_zip(&payload, &[("Codex.exe", b"MZ"), ("/etc/passwd", b"nope")]);

    let err = install_payload(&layout, "26.721", &payload, DIGEST).unwrap_err();
    assert!(
        matches!(err, InstallError::UnsafeEntry { .. }),
        "expected UnsafeEntry, got {err:?}"
    );
}

#[test]
fn a_drive_qualified_entry_path_is_refused() {
    let (dir, layout) = layout();
    let payload = dir.path().join("evil.zip");
    write_zip(
        &payload,
        &[
            ("Codex.exe", b"MZ"),
            (r"C:\Windows\System32\evil.dll", b"nope"),
        ],
    );

    let err = install_payload(&layout, "26.721", &payload, DIGEST).unwrap_err();
    assert!(
        matches!(err, InstallError::UnsafeEntry { .. }),
        "expected UnsafeEntry, got {err:?}"
    );
}

#[test]
fn a_decompression_bomb_is_refused_before_it_fills_the_disk() {
    let (dir, layout) = layout();
    let payload = dir.path().join("bomb.zip");
    // 4 MiB of zeros deflates to a few kilobytes.
    let zeros = vec![0u8; 4 * 1024 * 1024];
    write_zip(&payload, &[("Codex.exe", b"MZ"), ("pad.bin", &zeros)]);

    let limits = InstallLimits {
        max_total_bytes: 1024 * 1024,
        ..InstallLimits::default()
    };
    let err =
        install_payload_with_limits(&layout, "26.721", &payload, DIGEST, &limits).unwrap_err();
    assert!(
        matches!(err, InstallError::TooLarge { .. }),
        "expected TooLarge, got {err:?}"
    );
}

#[test]
fn an_entry_over_the_per_file_cap_is_refused() {
    let (dir, layout) = layout();
    let payload = dir.path().join("big.zip");
    let zeros = vec![0u8; 2 * 1024 * 1024];
    write_zip(&payload, &[("Codex.exe", b"MZ"), ("pad.bin", &zeros)]);

    let limits = InstallLimits {
        max_entry_bytes: 1024 * 1024,
        ..InstallLimits::default()
    };
    let err =
        install_payload_with_limits(&layout, "26.721", &payload, DIGEST, &limits).unwrap_err();
    assert!(
        matches!(err, InstallError::TooLarge { .. }),
        "expected TooLarge, got {err:?}"
    );
}

#[test]
fn an_archive_with_no_codex_executable_is_refused() {
    let (dir, layout) = layout();
    let payload = dir.path().join("empty.zip");
    write_zip(&payload, &[("readme.txt", b"nothing runnable here")]);

    let err = install_payload(&layout, "26.721", &payload, DIGEST).unwrap_err();
    assert!(
        matches!(err, InstallError::NoExecutable),
        "expected NoExecutable, got {err:?}"
    );
}

#[test]
fn an_archive_wrapped_in_a_single_root_directory_still_installs() {
    // Upstream archives routinely wrap everything in one versioned folder.
    // Refusing those would mean the feature works only for archives we
    // repackage ourselves, which defeats the point of consuming the official
    // build.
    let (dir, layout) = layout();
    let payload = dir.path().join("wrapped.zip");
    write_zip(
        &payload,
        &[
            ("codex-26.721/Codex.exe", b"MZ"),
            ("codex-26.721/resources/app.asar", b"resources"),
        ],
    );

    install_payload(&layout, "26.721", &payload, DIGEST).unwrap();

    let health = chimera_runtime::health::check_runtime_health(&layout).unwrap();
    assert!(
        health.exe_present,
        "the wrapping directory was not stripped, so the launcher cannot find the exe"
    );
    assert!(
        layout
            .version_dir("26.721")
            .join("resources/app.asar")
            .exists()
    );
}

#[test]
fn two_root_directories_are_not_stripped() {
    // Stripping is only safe when there is exactly one candidate root. With
    // two, stripping either one silently discards half the archive — better to
    // extract faithfully and let the missing-executable check speak.
    let (dir, layout) = layout();
    let payload = dir.path().join("two.zip");
    write_zip(&payload, &[("a/Codex.exe", b"MZ"), ("b/other.txt", b"x")]);

    let err = install_payload(&layout, "26.721", &payload, DIGEST).unwrap_err();
    assert!(
        matches!(err, InstallError::NoExecutable),
        "expected NoExecutable, got {err:?}"
    );
}

#[test]
fn a_refused_archive_leaves_the_previous_version_active() {
    let (dir, layout) = layout();
    install_payload(&layout, "26.721", &good_payload(dir.path()), DIGEST).unwrap();

    let evil = dir.path().join("evil.zip");
    write_zip(&evil, &[("Codex.exe", b"MZ"), ("../escaped.txt", b"nope")]);
    let _ = install_payload(&layout, "26.800", &evil, DIGEST).unwrap_err();

    let pointer = layout.read_current_pointer().unwrap().unwrap();
    assert_eq!(
        pointer.active_version, "26.721",
        "a refused install changed which version is active"
    );
    let health = chimera_runtime::health::check_runtime_health(&layout).unwrap();
    assert!(
        health.exe_present,
        "a refused install broke the working runtime"
    );
}

#[test]
fn a_refused_archive_leaves_no_staging_residue() {
    let (dir, layout) = layout();
    let evil = dir.path().join("evil.zip");
    write_zip(&evil, &[("Codex.exe", b"MZ"), ("../escaped.txt", b"nope")]);

    let _ = install_payload(&layout, "26.721", &evil, DIGEST).unwrap_err();

    let staged = layout.staging_dir().join("26.721");
    assert!(
        !staged.exists(),
        "half-extracted staging directory survived a refused install"
    );
    assert!(
        !layout.version_dir("26.721").exists(),
        "a refused install created a version directory"
    );
}

#[test]
fn a_corrupt_archive_is_refused_without_touching_the_runtime() {
    let (dir, layout) = layout();
    let payload = dir.path().join("corrupt.zip");
    std::fs::write(&payload, b"this is not a zip file at all").unwrap();

    let err = install_payload(&layout, "26.721", &payload, DIGEST).unwrap_err();
    assert!(
        matches!(err, InstallError::MalformedArchive),
        "expected MalformedArchive, got {err:?}"
    );
    assert!(layout.read_current_pointer().unwrap().is_none());
}

#[test]
fn reinstalling_the_same_version_leaves_it_launchable() {
    let (dir, layout) = layout();
    install_payload(&layout, "26.721", &good_payload(dir.path()), DIGEST).unwrap();
    install_payload(&layout, "26.721", &good_payload(dir.path()), DIGEST).unwrap();

    let health = chimera_runtime::health::check_runtime_health(&layout).unwrap();
    assert!(
        health.exe_present,
        "reinstalling the active version destroyed the only working copy"
    );
}

#[test]
fn upgrading_records_the_previous_version_so_rollback_has_a_target() {
    let (dir, layout) = layout();
    install_payload(&layout, "26.721", &good_payload(dir.path()), DIGEST).unwrap();
    install_payload(&layout, "26.800", &good_payload(dir.path()), DIGEST).unwrap();

    let pointer = layout.read_current_pointer().unwrap().unwrap();
    assert_eq!(pointer.active_version, "26.800");
    assert_eq!(pointer.previous_version.as_deref(), Some("26.721"));
}

#[test]
fn the_verified_payload_is_removed_once_it_is_installed() {
    // The archive is the size of the whole application. Leaving it in staging
    // doubles the install's footprint for no benefit — it can never be reused,
    // because a reinstall re-downloads and re-verifies from the manifest.
    let (dir, layout) = layout();
    let payload = good_payload(dir.path());
    install_payload(&layout, "26.721", &payload, DIGEST).unwrap();
    assert!(
        !payload.exists(),
        "the payload archive was left behind after a successful install"
    );
}

#[test]
fn an_install_error_never_names_a_filesystem_path() {
    // Same rule the download path already follows: paths carry the account
    // name, and the user cannot act on them. `UnsafeEntry` names the archive
    // entry, which is attacker-supplied but not a local path.
    let (dir, layout) = layout();
    let payload = dir.path().join("corrupt.zip");
    std::fs::write(&payload, b"not a zip").unwrap();

    let err = install_payload(&layout, "26.721", &payload, DIGEST).unwrap_err();
    let text = err.to_string();
    let root = layout.root().to_string_lossy().to_string();
    assert!(
        !text.contains(&root),
        "error text leaked the runtime root: {text}"
    );
}

#[test]
fn the_default_limits_are_the_documented_production_values() {
    // The caps are the only thing standing between a hostile archive and the
    // user's disk. A silent loosening should be a test failure, not a code
    // review that happened not to look.
    let d = InstallLimits::default();
    assert_eq!(d.max_total_bytes, 4 * 1024 * 1024 * 1024);
    assert_eq!(d.max_entry_bytes, 2 * 1024 * 1024 * 1024);
    assert_eq!(d.max_entries, 200_000);
}
