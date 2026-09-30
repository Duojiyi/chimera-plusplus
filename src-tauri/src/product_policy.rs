//! Chimera++ product policy for the CC Switch capability base.
//!
//! Upstream capabilities stay compiled and callable, but only Codex-owned
//! integrations may touch live application state during startup. Features
//! hidden by the product must never become background side effects.

use crate::app_config::AppType;
use crate::error::AppError;
use serde::Serialize;

const DEFAULT_VISIBLE_APPS: &[AppType] = &[AppType::Codex];

// Startup sets (D5). They are deliberately separate: one shared list used to
// drive recovery, live import and proxy auto-start at once, so adding an app
// for recovery silently imported its live config (API key included) too.
/// Apps whose proxy takeover leftovers are restored on exit and on startup.
const RECOVERY_APPS: &[AppType] = &[AppType::Codex, AppType::GrokBuild];
/// Apps whose live config may be read into the database during startup.
/// Everything else goes through an explicit first-enable flow.
const STARTUP_IMPORT_APPS: &[AppType] = &[AppType::Codex];
/// Apps whose proxy takeover may be resumed at startup, and only when the
/// app is visible and the user explicitly took it over before.
const PROXY_AUTOSTART_APPS: &[AppType] = &[AppType::Codex, AppType::GrokBuild];

/// Backend capability switches. Values are compile-time constants owned by
/// the backend: nothing the renderer sends can flip them, so [`require`] is
/// a real gate rather than a UI hint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    Providers,
    ModelDiscovery,
    LocalProxy,
    Failover,
    Usage,
    ManagedAccounts,
    Mcp,
    Skills,
    Prompts,
    Sessions,
    WebdavSync,
    S3Sync,
    CodexRuntimeManager,
    CodexThemes,
    OfficialAccounts,
    ConfigHealth,
    SessionExport,
    LiveBackups,
    CcSwitchImport,
    Context1m,
    ThreadUsage,
    CustomRequestHeaders,
    CodexAppServerDelete,
    MultiTool,
}

impl Capability {
    pub const ALL: [Capability; 24] = [
        Capability::Providers,
        Capability::ModelDiscovery,
        Capability::LocalProxy,
        Capability::Failover,
        Capability::Usage,
        Capability::ManagedAccounts,
        Capability::Mcp,
        Capability::Skills,
        Capability::Prompts,
        Capability::Sessions,
        Capability::WebdavSync,
        Capability::S3Sync,
        Capability::CodexRuntimeManager,
        Capability::CodexThemes,
        Capability::OfficialAccounts,
        Capability::ConfigHealth,
        Capability::SessionExport,
        Capability::LiveBackups,
        Capability::CcSwitchImport,
        Capability::Context1m,
        Capability::ThreadUsage,
        Capability::CustomRequestHeaders,
        Capability::CodexAppServerDelete,
        Capability::MultiTool,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Capability::Providers => "providers",
            Capability::ModelDiscovery => "model_discovery",
            Capability::LocalProxy => "local_proxy",
            Capability::Failover => "failover",
            Capability::Usage => "usage",
            Capability::ManagedAccounts => "managed_accounts",
            Capability::Mcp => "mcp",
            Capability::Skills => "skills",
            Capability::Prompts => "prompts",
            Capability::Sessions => "sessions",
            Capability::WebdavSync => "webdav_sync",
            Capability::S3Sync => "s3_sync",
            Capability::CodexRuntimeManager => "codex_runtime_manager",
            Capability::CodexThemes => "codex_themes",
            Capability::OfficialAccounts => "official_accounts",
            Capability::ConfigHealth => "config_health",
            Capability::SessionExport => "session_export",
            Capability::LiveBackups => "live_backups",
            Capability::CcSwitchImport => "cc_switch_import",
            Capability::Context1m => "context_1m",
            Capability::ThreadUsage => "thread_usage",
            Capability::CustomRequestHeaders => "custom_request_headers",
            Capability::CodexAppServerDelete => "codex_app_server_delete",
            Capability::MultiTool => "multi_tool",
        }
    }

    /// v2.8.0 matrix (plan §2 M2.0). Features that ship behind M5b stay off
    /// until the release flip (M9); `codex_app_server_delete` stays off until
    /// it passes a real-machine smoke test.
    pub const fn enabled(self) -> bool {
        match self {
            // Live features; `local_proxy`, `usage` and `sessions` are live
            // for Codex (the constants used to misreport them as off).
            Capability::Providers
            | Capability::ModelDiscovery
            | Capability::LocalProxy
            | Capability::Usage
            | Capability::Sessions
            | Capability::CodexRuntimeManager
            | Capability::CodexThemes => true,
            Capability::Failover
            | Capability::ManagedAccounts
            | Capability::Mcp
            | Capability::Skills
            | Capability::Prompts
            | Capability::WebdavSync
            | Capability::S3Sync
            | Capability::OfficialAccounts
            | Capability::ConfigHealth
            | Capability::SessionExport
            | Capability::LiveBackups
            | Capability::CcSwitchImport
            | Capability::Context1m
            | Capability::ThreadUsage
            | Capability::CustomRequestHeaders
            | Capability::CodexAppServerDelete
            | Capability::MultiTool => false,
        }
    }

    const fn starts_automatically(self) -> bool {
        matches!(self, Capability::Providers)
    }
}

/// Rejects a gated entry point while its capability is off.
pub fn require(capability: Capability) -> Result<(), AppError> {
    check(capability, capability.enabled())
}

fn check(capability: Capability, enabled: bool) -> Result<(), AppError> {
    if enabled {
        return Ok(());
    }
    let id = capability.id();
    Err(AppError::localized(
        "capability.disabled",
        format!("此功能在当前版本未开放: {id}"),
        format!("This feature is not available in this build: {id}"),
    ))
}

/// Gate for `multi_tool` entry points that act on one app (non-Codex deep
/// link import, first-enable import): default-visible apps always pass.
pub fn require_app(app: &AppType) -> Result<(), AppError> {
    require_app_when(app, Capability::MultiTool.enabled())
}

fn require_app_when(app: &AppType, multi_tool: bool) -> Result<(), AppError> {
    if DEFAULT_VISIBLE_APPS.contains(app) {
        Ok(())
    } else {
        check(Capability::MultiTool, multi_tool)
    }
}

pub const PRODUCT_NAME: &str = "Chimera++";
pub const PRODUCT_DATA_DIR: &str = ".chimera-plus-plus";
pub const PRODUCT_DATABASE_FILE: &str = "chimera.db";
pub const PRODUCT_LOG_FILE: &str = "chimera-plus-plus";
pub const PRODUCT_TRAY_ID: &str = "chimera-plus-plus";
pub const PRODUCT_DEEP_LINK_SCHEME: &str = "chimera";
pub const LEGACY_DEEP_LINK_SCHEME: &str = "ccswitch";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackendCapability {
    pub id: &'static str,
    pub available: bool,
    pub enabled_by_default: bool,
    pub starts_automatically: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProductCapabilities {
    pub policy_version: u32,
    pub available_apps: Vec<String>,
    pub default_visible_apps: Vec<&'static str>,
    pub recovery_apps: Vec<&'static str>,
    pub startup_import_apps: Vec<&'static str>,
    pub proxy_autostart_apps: Vec<&'static str>,
    pub commercial_presets_enabled: bool,
    pub sponsor_content_enabled: bool,
    pub app_update_channel_configured: bool,
    pub capabilities: Vec<BackendCapability>,
}

/// Returns the complete backend capability inventory exposed to the renderer.
#[tauri::command]
pub fn get_product_capabilities() -> ProductCapabilities {
    ProductCapabilities {
        policy_version: 3,
        // `AppType::all()` yields values, so retain owned names in the
        // capability payload rather than borrowing from each temporary value.
        available_apps: AppType::all().map(|app| app.as_str().to_owned()).collect(),
        default_visible_apps: app_names(DEFAULT_VISIBLE_APPS),
        recovery_apps: app_names(RECOVERY_APPS),
        startup_import_apps: app_names(STARTUP_IMPORT_APPS),
        proxy_autostart_apps: app_names(PROXY_AUTOSTART_APPS),
        commercial_presets_enabled: false,
        sponsor_content_enabled: false,
        app_update_channel_configured: app_update_channel_configured(),
        capabilities: Capability::ALL
            .iter()
            .map(|capability| BackendCapability {
                id: capability.id(),
                available: true,
                enabled_by_default: capability.enabled(),
                starts_automatically: capability.starts_automatically(),
            })
            .collect(),
    }
}

fn app_names(apps: &'static [AppType]) -> Vec<&'static str> {
    apps.iter().map(AppType::as_str).collect()
}

pub fn recovery_apps() -> impl Iterator<Item = AppType> {
    RECOVERY_APPS.iter().cloned()
}

pub fn startup_import_apps() -> impl Iterator<Item = AppType> {
    STARTUP_IMPORT_APPS.iter().cloned()
}

pub fn proxy_autostart_candidates() -> impl Iterator<Item = &'static AppType> {
    PROXY_AUTOSTART_APPS.iter()
}

/// Whether a proxy takeover recorded for `app` may be resumed at startup.
pub fn should_autostart_proxy(app: &AppType, user_visible: bool, taken_over: bool) -> bool {
    taken_over
        && user_visible
        && PROXY_AUTOSTART_APPS.contains(app)
        && is_app_visible_by_product(app)
}

/// Product-level visibility. Non-default apps stay hard-hidden (main UI,
/// tray sections, proxy auto-start) until `multi_tool` is on; after that the
/// user's `visibleApps` setting alone decides.
pub fn is_app_visible_by_product(app: &AppType) -> bool {
    app_visible_when(app, Capability::MultiTool.enabled())
}

fn app_visible_when(app: &AppType, multi_tool: bool) -> bool {
    multi_tool || DEFAULT_VISIBLE_APPS.contains(app)
}

pub fn accepts_deep_link(url: &str) -> bool {
    let scheme = url.split_once("://").map(|(scheme, _)| scheme);
    matches!(
        scheme,
        Some(PRODUCT_DEEP_LINK_SCHEME | LEGACY_DEEP_LINK_SCHEME)
    )
}

pub const fn import_extended_apps_on_startup() -> bool {
    false
}

pub const fn import_content_on_startup() -> bool {
    false
}

pub const fn initialize_skills_on_startup() -> bool {
    false
}

pub const fn sync_session_usage_on_startup() -> bool {
    false
}

pub const fn start_cloud_sync_workers() -> bool {
    false
}

pub const fn refresh_usage_from_tray() -> bool {
    false
}

pub const fn app_update_channel_configured() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_upstream_app_adapters_remain_available() {
        let policy = get_product_capabilities();
        assert_eq!(
            policy.available_apps,
            vec![
                "claude",
                "claude-desktop",
                "codex",
                "gemini",
                "grokbuild",
                "opencode",
                "openclaw",
                "hermes",
                "pi",
            ]
        );
        assert_eq!(policy.default_visible_apps, vec!["codex"]);
    }

    #[test]
    fn startup_sets_are_split_by_purpose() {
        assert_eq!(
            recovery_apps().collect::<Vec<_>>(),
            vec![AppType::Codex, AppType::GrokBuild]
        );
        // Recovery of GrokBuild must not also import its live config.
        assert_eq!(
            startup_import_apps().collect::<Vec<_>>(),
            vec![AppType::Codex]
        );
        assert_eq!(
            proxy_autostart_candidates().cloned().collect::<Vec<_>>(),
            vec![AppType::Codex, AppType::GrokBuild]
        );

        let policy = get_product_capabilities();
        assert_eq!(policy.recovery_apps, vec!["codex", "grokbuild"]);
        assert_eq!(policy.startup_import_apps, vec!["codex"]);
        assert_eq!(policy.proxy_autostart_apps, vec!["codex", "grokbuild"]);
    }

    #[test]
    fn proxy_autostart_needs_visibility_and_an_explicit_takeover() {
        assert!(should_autostart_proxy(&AppType::Codex, true, true));
        assert!(!should_autostart_proxy(&AppType::Codex, true, false));
        assert!(!should_autostart_proxy(&AppType::Codex, false, true));
        // GrokBuild is a candidate but stays hard-hidden while multi_tool is off.
        assert!(!should_autostart_proxy(&AppType::GrokBuild, true, true));
        // Apps outside the set never auto-start, even when visible.
        assert!(!should_autostart_proxy(&AppType::Claude, true, true));
        assert!(!should_autostart_proxy(&AppType::Gemini, true, true));
    }

    #[test]
    fn capability_matrix_matches_the_v2_8_0_table() {
        let policy = get_product_capabilities();
        let enabled = |id: &str| {
            policy
                .capabilities
                .iter()
                .find(|capability| capability.id == id)
                .unwrap_or_else(|| panic!("missing capability {id}"))
                .enabled_by_default
        };
        for id in [
            "providers",
            "model_discovery",
            "local_proxy",
            "usage",
            "sessions",
            "codex_runtime_manager",
            "codex_themes",
        ] {
            assert!(enabled(id), "{id} should be on");
        }
        for id in [
            "failover",
            "managed_accounts",
            "mcp",
            "skills",
            "prompts",
            "webdav_sync",
            "s3_sync",
            "official_accounts",
            "config_health",
            "session_export",
            "live_backups",
            "cc_switch_import",
            "context_1m",
            "thread_usage",
            "custom_request_headers",
            "codex_app_server_delete",
            "multi_tool",
        ] {
            assert!(!enabled(id), "{id} should be off");
        }
        assert_eq!(policy.capabilities.len(), Capability::ALL.len());
        let mut ids: Vec<_> = policy.capabilities.iter().map(|c| c.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(
            ids.len(),
            Capability::ALL.len(),
            "capability ids must be unique"
        );
    }

    #[test]
    fn require_rejects_every_disabled_capability_with_a_typed_error() {
        for capability in Capability::ALL {
            let result = require(capability);
            if capability.enabled() {
                assert!(result.is_ok(), "{}", capability.id());
            } else {
                match result {
                    Err(AppError::Localized { key, en, .. }) => {
                        assert_eq!(key, "capability.disabled");
                        assert!(en.contains(capability.id()));
                    }
                    other => panic!("{} should be rejected, got {other:?}", capability.id()),
                }
            }
        }
    }

    #[test]
    fn non_codex_apps_are_hard_hidden_while_multi_tool_is_off() {
        assert!(is_app_visible_by_product(&AppType::Codex));
        for app in AppType::all().filter(|app| *app != AppType::Codex) {
            assert!(!is_app_visible_by_product(&app), "{}", app.as_str());
            assert!(!app_visible_when(&app, false), "{}", app.as_str());
            assert!(app_visible_when(&app, true), "{}", app.as_str());
        }
    }

    #[test]
    fn app_scoped_entry_points_reject_non_codex_while_multi_tool_is_off() {
        assert!(require_app(&AppType::Codex).is_ok());
        for app in AppType::all().filter(|app| *app != AppType::Codex) {
            assert!(
                matches!(
                    require_app(&app),
                    Err(AppError::Localized {
                        key: "capability.disabled",
                        ..
                    })
                ),
                "{}",
                app.as_str()
            );
            assert!(require_app_when(&app, true).is_ok(), "{}", app.as_str());
        }
    }

    #[test]
    fn commercial_content_and_upstream_networks_are_disabled() {
        let policy = get_product_capabilities();
        assert!(!policy.commercial_presets_enabled);
        assert!(!policy.sponsor_content_enabled);
        assert!(!import_extended_apps_on_startup());
        assert!(!import_content_on_startup());
        assert!(!initialize_skills_on_startup());
        assert!(!sync_session_usage_on_startup());
        assert!(!start_cloud_sync_workers());
        assert!(!refresh_usage_from_tray());
        assert!(app_update_channel_configured());
    }

    #[test]
    fn chimera_and_legacy_ccswitch_deep_links_are_accepted() {
        assert!(accepts_deep_link("chimera://providers/import"));
        assert!(accepts_deep_link("ccswitch://providers/import"));
        assert!(!accepts_deep_link("https://example.com"));
    }
}
