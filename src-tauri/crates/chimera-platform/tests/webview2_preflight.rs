// Step 6.1 — WebView2 preflight.
//
// ADR-009: we do not redistribute WebView2. The app checks for it and, when it
// is missing, says so and points at Microsoft's own download — BEFORE touching
// any configuration or runtime state. A machine without WebView2 must be left
// exactly as it was, not half-configured by an app that then cannot draw a
// window to explain itself.
//
// The registry lookup is behind a trait so the interesting cases — absent,
// present, present-but-unusable — are ordinary tests rather than something
// that can only be observed on a machine that happens to lack it.

use chimera_platform::webview2::{RuntimeProbe, Webview2Status, check_webview2, download_url};

/// Answers whatever the test wants, without touching a real registry.
struct FakeProbe {
    machine: Option<String>,
    user: Option<String>,
}

impl FakeProbe {
    fn absent() -> Self {
        Self {
            machine: None,
            user: None,
        }
    }
    fn machine_wide(v: &str) -> Self {
        Self {
            machine: Some(v.to_string()),
            user: None,
        }
    }
    fn per_user(v: &str) -> Self {
        Self {
            machine: None,
            user: Some(v.to_string()),
        }
    }
}

impl RuntimeProbe for FakeProbe {
    fn machine_version(&self) -> Option<String> {
        self.machine.clone()
    }
    fn user_version(&self) -> Option<String> {
        self.user.clone()
    }
}

#[test]
fn a_machine_wide_install_is_present() {
    assert!(matches!(
        check_webview2(&FakeProbe::machine_wide("120.0.2210.91")),
        Webview2Status::Present { .. }
    ));
}

#[test]
fn a_per_user_install_counts_too() {
    // A per-user install is what a non-administrator gets, and Chimera itself
    // installs per-user (R15). Requiring the machine-wide key would reject
    // exactly the configuration we tell users to create.
    assert!(matches!(
        check_webview2(&FakeProbe::per_user("120.0.2210.91")),
        Webview2Status::Present { .. }
    ));
}

#[test]
fn the_reported_version_is_the_one_that_was_found() {
    match check_webview2(&FakeProbe::machine_wide("131.0.2903.86")) {
        Webview2Status::Present { version } => assert_eq!(version, "131.0.2903.86"),
        other => panic!("expected Present, got {other:?}"),
    }
}

#[test]
fn no_install_at_all_is_missing() {
    assert!(matches!(
        check_webview2(&FakeProbe::absent()),
        Webview2Status::Missing
    ));
}

#[test]
fn an_empty_version_string_is_missing_not_present() {
    // The key exists but holds "" after a failed or partially-removed install.
    // Treating a present-but-empty key as installed is how preflight passes and
    // the window then fails to create, which is the exact failure this exists
    // to prevent.
    assert!(matches!(
        check_webview2(&FakeProbe::machine_wide("")),
        Webview2Status::Missing
    ));
    assert!(matches!(
        check_webview2(&FakeProbe::machine_wide("   ")),
        Webview2Status::Missing
    ));
}

#[test]
fn a_version_of_all_zeroes_is_missing() {
    // Uninstalling the Evergreen runtime can leave the key behind reading
    // 0.0.0.0. It is a tombstone, not an install.
    assert!(matches!(
        check_webview2(&FakeProbe::machine_wide("0.0.0.0")),
        Webview2Status::Missing
    ));
}

#[test]
fn the_download_url_is_microsofts_own_over_https() {
    // We send users to Microsoft rather than redistributing (ADR-009), so this
    // link is the entire mitigation. Pointing it anywhere else — including at
    // one of our own mirrors — would put us back in a trust chain we chose to
    // step out of.
    let url = download_url();
    assert!(url.starts_with("https://"), "must be https: {url}");
    assert!(
        url.contains("microsoft.com"),
        "must point at Microsoft, not a mirror of ours: {url}"
    );
}

#[test]
fn a_missing_runtime_is_reported_without_a_registry_path() {
    // The message reaches a user who is about to decide whether to trust us.
    // A registry path is not something they can act on.
    let status = check_webview2(&FakeProbe::absent());
    let message = status.user_message_key();
    assert!(
        message.starts_with("preflight."),
        "expected an i18n key, got {message}"
    );
}

#[cfg(windows)]
#[test]
fn the_real_probe_answers_without_panicking() {
    // Whatever this machine has, reading the registry must not panic. The
    // result is not asserted — CI runners vary — but a probe that throws would
    // take down startup before anything could report it.
    let status = chimera_platform::webview2::check_installed();
    match status {
        Webview2Status::Present { ref version } => assert!(!version.trim().is_empty()),
        Webview2Status::Missing => {}
    }
}
