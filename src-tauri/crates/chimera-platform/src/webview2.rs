//! Step 6.1 — is the WebView2 runtime available?
//!
//! ADR-009 decided not to redistribute it: our installer is unsigned
//! (ADR-008), so bundling a Microsoft installer would ask the user to trust
//! that we did not modify it with nothing to check against, and a pinned
//! fixed-version runtime would mean owning a browser engine's vulnerabilities
//! until we notice and re-release.
//!
//! What replaces it is this check, and one property: it runs **before** any
//! configuration or runtime state is written. A machine without WebView2 is
//! left exactly as it was. The alternative — discovering it while creating the
//! window — leaves a half-configured install and no window in which to explain
//! that.
//!
//! The registry read sits behind a trait so "absent", "present" and the
//! genuinely awkward "present but a tombstone" cases are ordinary tests rather
//! than states only reproducible on a machine that happens to be in them.

/// Microsoft's official download page for the Evergreen runtime.
///
/// Deliberately Microsoft's own URL. Serving it from one of our mirrors would
/// put us back inside the trust chain ADR-009 chose to step out of — the whole
/// value of not redistributing is that the user gets a Microsoft-signed
/// installer from Microsoft.
const DOWNLOAD_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// Where a version string can be read from.
///
/// Two sources because a per-user install is what a non-administrator gets, and
/// Chimera installs per-user itself (R15). Checking only the machine-wide key
/// would reject exactly the configuration we tell users to create.
pub trait RuntimeProbe {
    /// `HKLM` value, if any.
    fn machine_version(&self) -> Option<String>;
    /// `HKCU` value, if any.
    fn user_version(&self) -> Option<String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Webview2Status {
    Present { version: String },
    Missing,
}

impl Webview2Status {
    /// i18n key for what to tell the user.
    ///
    /// A key, not a sentence: this crate holds no translated text, and the
    /// message must never carry a registry path — that is not something a user
    /// can act on, and it is what they would screenshot instead of the part
    /// that helps.
    pub fn user_message_key(&self) -> &'static str {
        match self {
            Webview2Status::Present { .. } => "preflight.webview2Present",
            Webview2Status::Missing => "preflight.webview2Missing",
        }
    }

    pub fn is_present(&self) -> bool {
        matches!(self, Webview2Status::Present { .. })
    }
}

/// Where to send a user whose machine lacks the runtime.
pub fn download_url() -> &'static str {
    DOWNLOAD_URL
}

/// A version string that means "installed".
///
/// Rejects empty, whitespace and all-zero values. The key survives a failed or
/// partially-removed install holding `""` or `0.0.0.0`; treating either as
/// installed is how preflight passes and window creation then fails — the
/// exact sequence this check exists to prevent.
fn is_real_version(raw: &str) -> bool {
    let v = raw.trim();
    if v.is_empty() {
        return false;
    }
    !v.split('.')
        .all(|part| part.chars().all(|c| c == '0') && !part.is_empty())
}

/// Decide from whatever the probe reports.
pub fn check_webview2(probe: &dyn RuntimeProbe) -> Webview2Status {
    // Machine-wide first: when both exist it is the one that wins at runtime.
    for candidate in [probe.machine_version(), probe.user_version()]
        .into_iter()
        .flatten()
    {
        if is_real_version(&candidate) {
            return Webview2Status::Present {
                version: candidate.trim().to_string(),
            };
        }
    }
    Webview2Status::Missing
}

// ── The real probe ─────────────────────────────────────────────────────────

#[cfg(windows)]
mod real {
    use super::RuntimeProbe;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Evergreen runtime's registered client GUID. Stable across versions —
    /// it identifies the runtime itself, not a release of it.
    const CLIENT_KEY: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const CLIENT_KEY_NATIVE: &str =
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    pub struct RegistryProbe;

    /// Read `pv` from a registry key via `reg.exe`.
    ///
    /// Shelling out rather than taking a registry crate: this runs once at
    /// startup, so the cost is irrelevant, and it keeps a Windows-only
    /// dependency out of a crate that also builds on macOS. Any failure —
    /// missing key, missing reg.exe, unparseable output — reads as "not
    /// installed", which is the safe direction: the worst case is telling a
    /// user to install something they already have, and preflight has not
    /// modified anything either way.
    fn read_pv(root: &str, key: &str) -> Option<String> {
        let mut command = Command::new("reg");
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command
            .args(["query", &format!("{root}\\{key}"), "/v", "pv"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines()
            .find(|l| l.trim_start().starts_with("pv"))
            .and_then(|l| l.split_whitespace().last())
            .map(str::to_string)
    }

    impl RuntimeProbe for RegistryProbe {
        fn machine_version(&self) -> Option<String> {
            read_pv("HKLM", CLIENT_KEY).or_else(|| read_pv("HKLM", CLIENT_KEY_NATIVE))
        }
        fn user_version(&self) -> Option<String> {
            read_pv("HKCU", CLIENT_KEY).or_else(|| read_pv("HKCU", CLIENT_KEY_NATIVE))
        }
    }
}

/// Check the machine Chimera is running on.
#[cfg(windows)]
pub fn check_installed() -> Webview2Status {
    check_webview2(&real::RegistryProbe)
}

/// Non-Windows platforms do not use WebView2 at all.
///
/// Reporting `Present` rather than adding a platform branch at every call site
/// keeps the preflight sequence identical everywhere (ADR-007). macOS has its
/// own WKWebView preflight, which is Task 11's concern, not this one's.
#[cfg(not(windows))]
pub fn check_installed() -> Webview2Status {
    Webview2Status::Present {
        version: "n/a".to_string(),
    }
}
