//! The tool registry: the one backend table of every tool Chimera++ can
//! manage (plan "工具注册表", 10 tools). The renderer reads it through
//! `get_tool_registry` instead of keeping its own tool lists.
//!
//! Visibility and capability gating stay in `product_policy`; this table only
//! describes what each tool is.

use crate::app_config::AppType;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolMode {
    /// One current provider is written to the live config.
    Switch,
    /// Providers are entries in the tool's own config, enabled independently.
    Additive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeeplinkPolicy {
    ImportConfirm,
    ImportOnly,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub id: AppType,
    pub mode: ToolMode,
    /// Default locations; overrides and platform specifics are resolved by
    /// each tool's config module.
    pub live_files: &'static [&'static str],
    pub tray: bool,
    pub deeplink: DeeplinkPolicy,
    pub proxy: bool,
}

const fn tool(
    id: AppType,
    mode: ToolMode,
    live_files: &'static [&'static str],
    tray: bool,
    deeplink: DeeplinkPolicy,
    proxy: bool,
) -> ToolInfo {
    ToolInfo {
        id,
        mode,
        live_files,
        tray,
        deeplink,
        proxy,
    }
}

use DeeplinkPolicy::{ImportConfirm, ImportOnly, Reject};
use ToolMode::{Additive, Switch};

/// In plan order.
pub static TOOLS: [ToolInfo; 10] = [
    tool(
        AppType::Codex,
        Switch,
        &[
            "~/.codex/config.toml",
            "~/.codex/auth.json",
            "~/.codex/cc-switch-model-catalog.json",
        ],
        true,
        ImportConfirm,
        true,
    ),
    tool(
        AppType::Claude,
        Switch,
        &["~/.claude/settings.json", "~/.claude.json"],
        true,
        ImportOnly,
        false,
    ),
    tool(
        AppType::ClaudeDesktop,
        Switch,
        &["<app data>/Claude-3p"],
        false,
        ImportOnly,
        false,
    ),
    tool(
        AppType::Gemini,
        Switch,
        &["~/.gemini/.env", "~/.gemini/settings.json"],
        true,
        ImportOnly,
        false,
    ),
    tool(
        AppType::GrokBuild,
        Switch,
        &["~/.grok/config.toml"],
        true,
        ImportOnly,
        true,
    ),
    tool(
        AppType::OpenCode,
        Additive,
        &[
            "~/.config/opencode/opencode.json",
            "~/.config/opencode/.env",
        ],
        false,
        ImportOnly,
        false,
    ),
    tool(
        AppType::OpenClaw,
        Additive,
        &["~/.openclaw/openclaw.json"],
        false,
        ImportOnly,
        false,
    ),
    tool(
        AppType::Hermes,
        Additive,
        &["~/.hermes/config.yaml"],
        false,
        ImportOnly,
        false,
    ),
    tool(
        AppType::Pi,
        Additive,
        &["~/.pi/agent/models.json"],
        false,
        ImportOnly,
        false,
    ),
    tool(
        AppType::Mcode,
        Additive,
        &["~/.minimax/config.yaml"],
        false,
        Reject,
        false,
    ),
];

#[tauri::command]
pub fn get_tool_registry() -> Vec<ToolInfo> {
    TOOLS.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(filter: impl Fn(&ToolInfo) -> bool) -> Vec<&'static str> {
        TOOLS
            .iter()
            .filter(|tool| filter(*tool))
            .map(|tool| tool.id.as_str())
            .collect()
    }

    #[test]
    fn table_matches_the_plan() {
        assert_eq!(
            ids(|_| true),
            [
                "codex",
                "claude",
                "claude-desktop",
                "gemini",
                "grokbuild",
                "opencode",
                "openclaw",
                "hermes",
                "pi",
                "mcode"
            ]
        );
        assert_eq!(
            ids(|tool| tool.mode == Switch),
            ["codex", "claude", "claude-desktop", "gemini", "grokbuild"]
        );
        assert_eq!(
            ids(|tool| tool.tray),
            ["codex", "claude", "gemini", "grokbuild"]
        );
        assert_eq!(ids(|tool| tool.deeplink == ImportConfirm), ["codex"]);
        assert_eq!(ids(|tool| tool.deeplink == Reject), ["mcode"]);
        assert_eq!(ids(|tool| tool.proxy), ["codex", "grokbuild"]);
        assert_eq!(TOOLS[9].live_files, ["~/.minimax/config.yaml"]);
        assert_eq!(TOOLS[8].live_files, ["~/.pi/agent/models.json"]);
    }

    #[test]
    fn every_app_type_is_registered_once() {
        let mut registered: Vec<_> = TOOLS.iter().map(|tool| tool.id.clone()).collect();
        let mut all: Vec<_> = AppType::all().collect();
        registered.sort_by_key(|app| app.as_str().to_owned());
        all.sort_by_key(|app| app.as_str().to_owned());
        assert_eq!(registered, all);
        assert!(TOOLS.iter().all(|tool| !tool.live_files.is_empty()));
    }

    #[test]
    fn table_agrees_with_the_code_it_describes() {
        for tool in &TOOLS {
            assert_eq!(
                tool.mode == Additive,
                tool.id.is_additive_mode(),
                "{:?}",
                tool.id
            );
        }
        let mut tray: Vec<String> = crate::tray::TRAY_SECTIONS
            .iter()
            .map(|section| section.app_type.as_str().to_owned())
            .collect();
        tray.sort_unstable();
        let mut registered_tray = ids(|tool| tool.tray);
        registered_tray.sort_unstable();
        assert_eq!(registered_tray, tray);
        let mut proxy: Vec<_> = crate::product_policy::proxy_autostart_candidates()
            .map(AppType::as_str)
            .collect();
        proxy.sort_unstable();
        let mut registered_proxy = ids(|tool| tool.proxy);
        registered_proxy.sort_unstable();
        assert_eq!(registered_proxy, proxy);
        for tool in TOOLS.iter().filter(|tool| tool.deeplink == Reject) {
            let url = format!(
                "ccswitch://v1/import?resource=provider&app={}&name=Test",
                tool.id.as_str()
            );
            assert!(crate::deeplink::parse_deeplink_url(&url).is_err(), "{url}");
        }
    }

    #[test]
    fn serializes_with_renderer_ids() {
        let json = serde_json::to_value(get_tool_registry()).unwrap();
        assert_eq!(
            json[2],
            serde_json::json!({
                "id": "claude-desktop",
                "mode": "switch",
                "liveFiles": ["<app data>/Claude-3p"],
                "tray": false,
                "deeplink": "importOnly",
                "proxy": false
            })
        );
        assert_eq!(json[9]["deeplink"], "reject");
        assert_eq!(json[9]["mode"], "additive");
    }
}
