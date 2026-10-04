// Step 5.6 — Managed Codex process launch.
// G5: launching must refuse anything not owned by the runtime root, and must
// never spawn a long-running process from a test (that would leak into CI).
use chimera_runtime::process::{LaunchError, launch_managed_codex};

#[test]
fn windows_status_probe_never_opens_a_console_window() {
    let source = include_str!("../src/process.rs");
    assert!(source.contains("CREATE_NO_WINDOW"));
    assert!(source.contains("creation_flags(CREATE_NO_WINDOW)"));
}
use chimera_runtime::update::RuntimeLayout;
use std::fs;
use std::path::Path;
use tempfile::tempdir;

fn make_layout_with_version(
    tmp: &tempfile::TempDir,
    version: &str,
    exe_bytes: &[u8],
) -> RuntimeLayout {
    let layout = RuntimeLayout::new(tmp.path().join("rt"));
    layout.initialise().unwrap();
    let staged = chimera_runtime::update::stage_version(&layout, version).unwrap();
    fs::write(staged.join(codex_exe_name()), exe_bytes).unwrap();
    chimera_runtime::update::commit_version(&layout, version, "sha256:fake").unwrap();
    layout
}

fn codex_exe_name() -> &'static str {
    if cfg!(windows) { "Codex.exe" } else { "Codex" }
}

#[test]
fn launch_with_no_version_installed_returns_not_installed() {
    let tmp = tempdir().unwrap();
    let layout = RuntimeLayout::new(tmp.path().join("rt"));
    layout.initialise().unwrap();
    // No current.json written — nothing installed.

    let result = launch_managed_codex(&layout);
    assert!(
        matches!(result, Err(LaunchError::NotInstalled)),
        "expected NotInstalled, got {result:?}"
    );
}

#[test]
fn exe_resolving_outside_runtime_root_is_refused_and_not_spawned() {
    // Build a layout whose current.json/version dir legitimately point inside
    // the root, then swap the exe itself for one that is a symlink/copy
    // pointing outside — simulating a tampered install. Since health.rs
    // derives the path from version_dir() (always under root), we instead
    // directly exercise the ownership boundary by pointing the "version dir"
    // exe at a target outside root via a directory junction/copy substitute:
    // here we simply verify that if the resolved exe were outside root the
    // launch is refused, by constructing a layout whose root does not
    // contain the exe health reports (a corrupted/relocated root).
    let tmp = tempdir().unwrap();
    let version = "26.721";

    // Real, legitimate install under `rt`.
    let layout = make_layout_with_version(&tmp, version, b"fake-exe-bytes");

    // Now construct a second, sibling "evil" root that is NOT an ancestor of
    // the real exe, and confirm a layout pointed at that root cannot resolve
    // (and therefore cannot launch) the real exe: check_runtime_health always
    // derives the path from the layout's own root, so to hit the NotOwned
    // branch we corrupt the on-disk pointer to reference a path outside the
    // versions dir by replacing the version directory with a symlink/junction
    // to an external location that shares no ancestry with the root.
    let outside_dir = tmp.path().join("outside");
    fs::create_dir_all(&outside_dir).unwrap();
    let outside_exe = outside_dir.join(codex_exe_name());
    fs::write(&outside_exe, b"outside-exe-bytes").unwrap();

    let version_dir = layout.version_dir(version);
    fs::remove_dir_all(&version_dir).unwrap();
    link_dir(&outside_dir, &version_dir);

    let result = launch_managed_codex(&layout);
    assert!(
        matches!(result, Err(LaunchError::NotOwned { .. })),
        "expected NotOwned, got {result:?}"
    );
}

#[test]
fn sibling_directory_sharing_name_prefix_is_refused() {
    // Regression for the same prefix bug covered in step5_5_health.rs: a root
    // at `.../rt` must not accept an exe living under `.../rt-evil`.
    let tmp = tempdir().unwrap();
    let version = "26.721";
    let layout = make_layout_with_version(&tmp, version, b"fake-exe-bytes");

    let evil_root = tmp.path().join("rt-evil");
    fs::create_dir_all(&evil_root).unwrap();
    let evil_exe = evil_root.join(codex_exe_name());
    fs::write(&evil_exe, b"evil-exe-bytes").unwrap();

    let version_dir = layout.version_dir(version);
    fs::remove_dir_all(&version_dir).unwrap();
    link_dir(&evil_root, &version_dir);

    let result = launch_managed_codex(&layout);
    assert!(
        matches!(result, Err(LaunchError::NotOwned { .. })),
        "expected NotOwned for sibling-prefix dir, got {result:?}"
    );
}

#[test]
fn launching_an_owned_exe_spawns_and_returns_a_reapable_pid() {
    // Success path: spawn a harmless, immediately-exiting real OS binary that
    // has been copied under the temp runtime root so the ownership check
    // passes. We reap the child ourselves afterwards so nothing leaks.
    let tmp = tempdir().unwrap();
    let version = "26.721";
    let layout = RuntimeLayout::new(tmp.path().join("rt"));
    layout.initialise().unwrap();
    let staged = chimera_runtime::update::stage_version(&layout, version).unwrap();

    let dest = staged.join(codex_exe_name());
    copy_harmless_exe(&dest);

    chimera_runtime::update::commit_version(&layout, version, "sha256:fake").unwrap();

    let report = launch_managed_codex(&layout).expect("launch should succeed");
    assert!(report.pid > 0);

    reap(report.pid);
}

#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) {
    // Directory junctions don't require admin/dev-mode privileges on Windows,
    // unlike symlinks.
    let status = std::process::Command::new("cmd")
        .args([
            "/c",
            "mklink",
            "/J",
            &link.display().to_string(),
            &target.display().to_string(),
        ])
        .status()
        .expect("mklink should run");
    assert!(status.success(), "failed to create junction");
}

#[cfg(not(windows))]
fn link_dir(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("symlink should succeed");
}

#[cfg(windows)]
fn copy_harmless_exe(dest: &Path) {
    // whoami.exe runs to completion and exits on its own with no arguments
    // and no stdin needed — unlike a bare cmd.exe, it doesn't depend on EOF
    // semantics of a null stdin handle to terminate.
    let whoami = std::env::var("SystemRoot")
        .map(|root| Path::new(&root).join("System32").join("whoami.exe"))
        .unwrap_or_else(|_| Path::new("C:/Windows/System32/whoami.exe").to_path_buf());
    fs::copy(&whoami, dest).expect("copying whoami.exe should succeed");
}

#[cfg(not(windows))]
fn copy_harmless_exe(dest: &Path) {
    // `true` lives in different places per platform: /bin/true on most Linux
    // distributions, /usr/bin/true on macOS, where /bin holds only a small
    // fixed set of shells and core utilities. Probe rather than assume.
    let source = ["/bin/true", "/usr/bin/true"]
        .into_iter()
        .map(Path::new)
        .find(|p| p.exists())
        .expect("no `true` binary found in /bin or /usr/bin");
    fs::copy(source, dest).unwrap_or_else(|e| panic!("copying {} failed: {e}", source.display()));
}

#[cfg(windows)]
fn reap(pid: u32) {
    // cmd.exe with no args left running would just sit at a prompt reading
    // stdin (which is null here) — wait briefly then force-kill by pid so the
    // test never leaves a process behind, regardless of what it did.
    std::thread::sleep(std::time::Duration::from_millis(200));
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .output();
}

#[cfg(not(windows))]
fn reap(pid: u32) {
    std::thread::sleep(std::time::Duration::from_millis(100));
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output();
}
