//! Renderer-facing views of provider rows and live settings.
//!
//! `ProviderService::list` and `read_live_settings` keep returning raw values:
//! the tray, the local proxy and the switch transaction all need the real
//! credentials. Only what crosses the IPC boundary into the renderer is
//! narrowed here, and renderer-originated writes are merged back against the
//! stored row so a withheld secret is never mistaken for a deleted one.

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::app_config::AppType;
use crate::provider::Provider;

/// Codex login-identity material. Any one of these is enough to act as the
/// signed-in account, and the renderer never needs them.
const OAUTH_AUTH_FIELDS: &[&str] = &[
    "tokens",
    "id_token",
    "access_token",
    "refresh_token",
    "account_id",
    "last_refresh",
    "agent_identity",
    "personal_access_token",
];
const OAUTH_AUTH_FIELD_PREFIXES: &[&str] = &["bedrock_"];
const API_KEY_FIELD: &str = "OPENAI_API_KEY";

fn is_oauth_auth_field(key: &str) -> bool {
    OAUTH_AUTH_FIELDS.contains(&key)
        || OAUTH_AUTH_FIELD_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
}

/// Codex resolves a missing `auth_mode` from the fields present: login tokens
/// mean a ChatGPT session, a bare key means API-key mode. Next to a ChatGPT
/// session `OPENAI_API_KEY` is a key exchanged from that login, not one the
/// user entered.
fn auth_is_api_key_mode(auth: &Map<String, Value>) -> bool {
    match auth.get("auth_mode").and_then(Value::as_str) {
        Some(mode) => mode == "apikey",
        None => !auth.keys().any(|key| is_oauth_auth_field(key)),
    }
}

/// Same shape the app already uses for masked keys in logs
/// (`proxy::providers::auth::AuthInfo::masked_key`): first and last four
/// characters, or `***` for anything short enough to guess.
fn mask_secret(secret: &str) -> String {
    let count = secret.chars().count();
    if count <= 8 {
        return "***".to_string();
    }
    let prefix: String = secret.chars().take(4).collect();
    let suffix: String = secret.chars().skip(count - 4).collect();
    format!("{prefix}...{suffix}")
}

/// Whether a value has the exact shape `mask_secret` produces. A masked value
/// echoed back is never a real key, even when the stored key has changed
/// since the renderer read it.
fn is_masked_secret(value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    value == "***" || (chars.len() == 11 && chars[4..7] == ['.', '.', '.'])
}

/// A provider row as the renderer sees it: `settingsConfig.auth` without
/// OAuth material. The API key of an API-key row is kept as-is because the
/// edit form and the balance query read it.
#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct ProviderDto(Provider);

impl From<Provider> for ProviderDto {
    fn from(mut provider: Provider) -> Self {
        if let Some(auth) = provider
            .settings_config
            .get_mut("auth")
            .and_then(Value::as_object_mut)
        {
            let api_key_mode = auth_is_api_key_mode(auth);
            auth.retain(|key, _| {
                !(is_oauth_auth_field(key) || (key == API_KEY_FIELD && !api_key_mode))
            });
        }
        Self(provider)
    }
}

pub fn provider_dtos(providers: IndexMap<String, Provider>) -> IndexMap<String, ProviderDto> {
    providers
        .into_iter()
        .map(|(id, provider)| (id, ProviderDto::from(provider)))
        .collect()
}

/// Live settings as the renderer sees them. For Codex, `auth` is reduced to
/// `auth_mode` plus a masked `OPENAI_API_KEY` when the login is API-key mode;
/// everything else in `auth.json` stays in the backend.
#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct LiveSettingsDto(Value);

impl LiveSettingsDto {
    pub fn new(app_type: &AppType, mut live: Value) -> Self {
        if matches!(app_type, AppType::Codex) {
            if let Some(auth) = live.get_mut("auth") {
                *auth = live_auth_view(auth);
            }
        }
        Self(live)
    }
}

fn live_auth_view(auth: &Value) -> Value {
    let mut view = Map::new();
    let Some(auth) = auth.as_object() else {
        return Value::Object(view);
    };
    if let Some(mode) = auth.get("auth_mode").filter(|mode| mode.is_string()) {
        view.insert("auth_mode".to_string(), mode.clone());
    }
    if auth_is_api_key_mode(auth) {
        if let Some(key) = auth.get(API_KEY_FIELD).and_then(Value::as_str) {
            view.insert(API_KEY_FIELD.to_string(), Value::String(mask_secret(key)));
        }
    }
    Value::Object(view)
}

/// Merge a renderer-originated provider write with the stored row.
///
/// A secret the DTO withheld arrives missing; an API key echoed back from a
/// masked view arrives masked; an untouched key field (the editor always
/// writes one, even for a row whose key was withheld) arrives empty. All
/// three mean "unchanged" and get the stored value back. Removing the API key
/// is an explicit request (`clear_api_key`), never inferred from an empty
/// field. OAuth material has no clear path here: Codex owns that login.
pub fn merge_withheld_secrets(
    incoming: &mut Provider,
    stored: Option<&Provider>,
    clear_api_key: bool,
) {
    keep_stored_official_account_pin(incoming, stored);
    let stored_auth = stored
        .and_then(|provider| provider.settings_config.get("auth"))
        .and_then(Value::as_object);
    if stored_auth.is_none() && !clear_api_key {
        return;
    }
    let Some(settings) = incoming.settings_config.as_object_mut() else {
        return;
    };
    let Some(incoming_auth) = settings
        .entry("auth")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return;
    };

    for (key, stored_value) in stored_auth.into_iter().flatten() {
        let restore = if is_oauth_auth_field(key) {
            !incoming_auth.contains_key(key)
        } else if key == API_KEY_FIELD && !clear_api_key {
            api_key_unchanged(incoming_auth.get(API_KEY_FIELD))
        } else {
            false
        };
        if restore {
            incoming_auth.insert(key.clone(), stored_value.clone());
        }
    }
    if clear_api_key {
        incoming_auth.insert(API_KEY_FIELD.to_string(), Value::String(String::new()));
    }
}

/// `meta.officialAccount` is owned by the official-account commands: a
/// renderer write can neither add, change nor remove a line's pin.
fn keep_stored_official_account_pin(incoming: &mut Provider, stored: Option<&Provider>) {
    let stored_pin = stored
        .and_then(|provider| provider.meta.as_ref())
        .and_then(|meta| meta.official_account.clone());
    match incoming.meta.as_mut() {
        Some(meta) => meta.official_account = stored_pin,
        None if stored_pin.is_some() => {
            incoming.meta = Some(crate::provider::ProviderMeta {
                official_account: stored_pin,
                ..Default::default()
            });
        }
        None => {}
    }
}

fn api_key_unchanged(incoming: Option<&Value>) -> bool {
    match incoming {
        None | Some(Value::Null) => true,
        Some(Value::String(value)) => value.trim().is_empty() || is_masked_secret(value),
        Some(_) => false,
    }
}

/// Which provider the live Codex config currently runs, and how that was
/// decided. `source` is one of `live` (matched against live config),
/// `stored` (the saved selection), `external` (live config matches no row)
/// or `none` (no providers).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CurrentProviderResolution {
    pub id: Option<String>,
    pub source: &'static str,
}

impl CurrentProviderResolution {
    fn of(provider: Option<&Provider>, source: &'static str) -> Self {
        Self {
            id: provider.map(|provider| provider.id.clone()),
            source,
        }
    }
}

fn normalize_endpoint(value: Option<String>) -> String {
    value
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_lowercase()
}

fn config_text(settings: &Value) -> &str {
    settings.get("config").and_then(Value::as_str).unwrap_or("")
}

fn config_model(config: &str) -> String {
    config
        .parse::<toml::Value>()
        .ok()
        .and_then(|doc| {
            doc.get("model")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .map(|model| model.trim().to_string())
        .unwrap_or_default()
}

fn auth_credential(settings: &Value) -> String {
    let Some(auth) = settings.get("auth") else {
        return String::new();
    };
    for field in [
        API_KEY_FIELD,
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "api_key",
    ] {
        if let Some(value) = auth.get(field).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    String::new()
}

/// Bearer token in the TOML wins over `auth`, matching how Codex itself
/// authenticates a custom provider.
fn credential(settings: &Value) -> String {
    crate::codex_config::extract_codex_experimental_bearer_token(config_text(settings))
        .unwrap_or_else(|| auth_credential(settings))
}

/// Decide the current Codex provider from the raw live settings, so the
/// renderer never needs raw credentials to do it. `live` is `None` when the
/// live files could not be read.
pub fn resolve_current_provider(
    providers: &IndexMap<String, Provider>,
    stored_id: &str,
    live: Option<&Value>,
) -> CurrentProviderResolution {
    let mut sorted: Vec<&Provider> = providers.values().collect();
    sorted.sort_by_key(|provider| provider.sort_index.unwrap_or(0));
    if sorted.is_empty() {
        return CurrentProviderResolution::of(None, "none");
    }

    let stored = sorted
        .iter()
        .copied()
        .find(|provider| provider.id == stored_id);
    let Some(live) = live else {
        return match stored {
            Some(stored) => CurrentProviderResolution::of(Some(stored), "stored"),
            None => CurrentProviderResolution::of(None, "none"),
        };
    };

    let live_config = config_text(live);
    let live_endpoint =
        normalize_endpoint(crate::codex_config::extract_codex_base_url(live_config));
    let live_model = config_model(live_config);

    // Under proxy takeover live points at the local router, which no saved
    // row ever matches; the stored selection is the real current line.
    let is_local_proxy = live_endpoint.starts_with("127.0.0.1")
        || live_endpoint.starts_with("localhost")
        || live_endpoint.contains("://127.0.0.1")
        || live_endpoint.contains("://localhost");
    if is_local_proxy {
        if let Some(stored) = stored {
            return CurrentProviderResolution::of(Some(stored), "stored");
        }
    }

    let live_key = credential(live);
    let exact = sorted.iter().copied().find(|provider| {
        let candidate = config_text(&provider.settings_config);
        let endpoint = normalize_endpoint(crate::codex_config::extract_codex_base_url(candidate));
        let model = config_model(candidate);
        if endpoint != live_endpoint {
            return false;
        }
        if !live_model.is_empty() && !model.is_empty() && live_model != model {
            return false;
        }
        live_key.is_empty() || credential(&provider.settings_config) == live_key
    });
    if let Some(exact) = exact {
        return CurrentProviderResolution::of(Some(exact), "live");
    }

    if live_endpoint.is_empty() {
        if let Some(stored) = stored {
            let stored_endpoint = normalize_endpoint(crate::codex_config::extract_codex_base_url(
                config_text(&stored.settings_config),
            ));
            if stored_endpoint.is_empty() {
                return CurrentProviderResolution::of(Some(stored), "stored");
            }
        }
    }

    CurrentProviderResolution::of(None, "external")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE_ACCESS: &str = "fixture-access-token-5f1c0e7a";
    const FIXTURE_REFRESH: &str = "fixture-refresh-token-9b2d44c1";
    const FIXTURE_ID: &str = "fixture-id-token-3a7e9910";
    const FIXTURE_ACCOUNT: &str = "fixture-account-id-c0ffee";
    const FIXTURE_EXCHANGED_KEY: &str = "sk-fixture-exchanged-key-77aa";
    const FIXTURE_PAT: &str = "fixture-personal-access-token-d00d";
    const FIXTURE_AGENT: &str = "fixture-agent-identity-beef";
    const FIXTURE_LAST_REFRESH: &str = "2026-09-01T00:00:00.123456Z";

    fn oauth_auth() -> Value {
        json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": FIXTURE_EXCHANGED_KEY,
            "tokens": {
                "id_token": FIXTURE_ID,
                "access_token": FIXTURE_ACCESS,
                "refresh_token": FIXTURE_REFRESH,
                "account_id": FIXTURE_ACCOUNT,
            },
            "last_refresh": FIXTURE_LAST_REFRESH,
            "agent_identity": FIXTURE_AGENT,
            "personal_access_token": FIXTURE_PAT,
            "bedrock_session": FIXTURE_ACCESS,
        })
    }

    fn fixture_secrets() -> [&'static str; 8] {
        [
            FIXTURE_ACCESS,
            FIXTURE_REFRESH,
            FIXTURE_ID,
            FIXTURE_ACCOUNT,
            FIXTURE_EXCHANGED_KEY,
            FIXTURE_PAT,
            FIXTURE_AGENT,
            FIXTURE_LAST_REFRESH,
        ]
    }

    fn provider(id: &str, settings: Value) -> Provider {
        Provider::with_id(id.to_string(), id.to_string(), settings, None)
    }

    fn assert_no_fixture_secret(json: &str) {
        for secret in fixture_secrets() {
            assert!(!json.contains(secret), "DTO JSON leaked {secret}: {json}");
        }
    }

    // ACC-T18: generic provider writes cannot pin, re-pin or unpin a line.
    #[test]
    fn renderer_writes_keep_the_stored_official_account_pin() {
        use crate::provider::{OfficialAccountPin, ProviderMeta};
        let pin = |key: &str| OfficialAccountPin {
            v: 1,
            account_key: key.to_string(),
        };
        let with_pin = |key: Option<&str>| {
            let mut line = provider("codex-official-x", json!({ "auth": {}, "config": "" }));
            line.meta = Some(ProviderMeta {
                official_account: key.map(pin),
                ..Default::default()
            });
            line
        };

        let stored = with_pin(Some("stored-key"));
        let mut repinned = with_pin(Some("forged-key"));
        merge_withheld_secrets(&mut repinned, Some(&stored), false);
        assert_eq!(repinned.official_account_key(), Some("stored-key"));

        let mut unpinned = with_pin(None);
        merge_withheld_secrets(&mut unpinned, Some(&stored), false);
        assert_eq!(unpinned.official_account_key(), Some("stored-key"));

        let mut without_meta = provider("codex-official-x", json!({ "auth": {} }));
        merge_withheld_secrets(&mut without_meta, Some(&stored), false);
        assert_eq!(without_meta.official_account_key(), Some("stored-key"));

        // A new row cannot arrive pinned.
        let mut created = with_pin(Some("forged-key"));
        merge_withheld_secrets(&mut created, None, false);
        assert_eq!(created.official_account_key(), None);
    }

    #[test]
    fn provider_and_live_dto_json_never_contain_oauth_material() {
        let mut official = provider(
            "codex-official",
            json!({ "auth": oauth_auth(), "config": "" }),
        );
        official.category = Some("official".to_string());
        // Pollution shape a third-party row can pick up from a backfill.
        let polluted = provider(
            "relay",
            json!({
                "auth": oauth_auth(),
                "config": "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://relay.example/v1\"\n",
            }),
        );
        let mut rows = IndexMap::new();
        rows.insert(official.id.clone(), official.clone());
        rows.insert(polluted.id.clone(), polluted);

        let list_json = serde_json::to_string(&provider_dtos(rows)).unwrap();
        assert_no_fixture_secret(&list_json);
        let failover_json =
            serde_json::to_string(&vec![ProviderDto::from(official.clone())]).unwrap();
        assert_no_fixture_secret(&failover_json);

        let live = json!({ "auth": oauth_auth(), "config": "model = \"gpt-5\"\n" });
        let live_json =
            serde_json::to_string(&LiveSettingsDto::new(&AppType::Codex, live)).unwrap();
        assert_no_fixture_secret(&live_json);
        assert!(live_json.contains("\"auth_mode\":\"chatgpt\""));
        assert!(live_json.contains("gpt-5"));
    }

    #[test]
    fn api_key_rows_keep_their_key_and_live_view_masks_it() {
        let row = provider(
            "relay",
            json!({ "auth": { "OPENAI_API_KEY": "sk-relay-0123456789" }, "config": "" }),
        );
        let row_json = serde_json::to_value(ProviderDto::from(row)).unwrap();
        assert_eq!(
            row_json["settingsConfig"]["auth"]["OPENAI_API_KEY"],
            "sk-relay-0123456789"
        );

        let live = json!({
            "auth": { "auth_mode": "apikey", "OPENAI_API_KEY": "sk-live-0123456789" },
            "config": "",
        });
        let live_json = serde_json::to_value(LiveSettingsDto::new(&AppType::Codex, live)).unwrap();
        assert_eq!(live_json["auth"]["OPENAI_API_KEY"], "sk-l...6789");
        assert!(!live_json.to_string().contains("sk-live-0123456789"));
    }

    #[test]
    fn non_codex_live_settings_pass_through() {
        let live = json!({ "env": { "ANTHROPIC_AUTH_TOKEN": "x" } });
        let json =
            serde_json::to_value(LiveSettingsDto::new(&AppType::Claude, live.clone())).unwrap();
        assert_eq!(json, live);
    }

    #[test]
    fn missing_oauth_fields_and_exchanged_key_are_merged_back_from_the_stored_row() {
        let stored = provider(
            "codex-official",
            json!({ "auth": oauth_auth(), "config": "" }),
        );
        // What the renderer sends back after editing, e.g., only the notes.
        let dto = serde_json::to_value(ProviderDto::from(stored.clone())).unwrap();
        let mut incoming: Provider = serde_json::from_value(dto).unwrap();
        incoming.notes = Some("edited".to_string());

        merge_withheld_secrets(&mut incoming, Some(&stored), false);

        assert_eq!(incoming.settings_config["auth"], oauth_auth());
        assert_eq!(incoming.notes.as_deref(), Some("edited"));
    }

    #[test]
    fn masked_or_empty_api_key_means_unchanged_but_a_new_key_replaces_it() {
        let stored = provider(
            "relay",
            json!({ "auth": { "OPENAI_API_KEY": "sk-stored-0123456789" }, "config": "" }),
        );
        for echoed in [json!("sk-s...6789"), json!(""), json!("   "), Value::Null] {
            let mut incoming = provider(
                "relay",
                json!({ "auth": { "OPENAI_API_KEY": echoed }, "config": "" }),
            );
            merge_withheld_secrets(&mut incoming, Some(&stored), false);
            assert_eq!(
                incoming.settings_config["auth"]["OPENAI_API_KEY"],
                "sk-stored-0123456789"
            );
        }

        let mut missing = provider("relay", json!({ "auth": {}, "config": "" }));
        merge_withheld_secrets(&mut missing, Some(&stored), false);
        assert_eq!(
            missing.settings_config["auth"]["OPENAI_API_KEY"],
            "sk-stored-0123456789"
        );

        // The live view masks the live key, which may differ from the row's
        // stored key; its mask must never be saved as a key either.
        let live_mask = mask_secret("sk-live-key-that-differs");
        let mut echoed_live = provider(
            "relay",
            json!({ "auth": { "OPENAI_API_KEY": live_mask }, "config": "" }),
        );
        merge_withheld_secrets(&mut echoed_live, Some(&stored), false);
        assert_eq!(
            echoed_live.settings_config["auth"]["OPENAI_API_KEY"],
            "sk-stored-0123456789"
        );

        let mut replaced = provider(
            "relay",
            json!({ "auth": { "OPENAI_API_KEY": "sk-new-key" }, "config": "" }),
        );
        merge_withheld_secrets(&mut replaced, Some(&stored), false);
        assert_eq!(
            replaced.settings_config["auth"]["OPENAI_API_KEY"],
            "sk-new-key"
        );
    }

    #[test]
    fn clearing_the_api_key_wins_over_a_masked_or_empty_echo() {
        let stored = provider(
            "relay",
            json!({ "auth": { "OPENAI_API_KEY": "sk-stored-0123456789" }, "config": "" }),
        );
        for echoed in [json!("sk-s...6789"), json!(""), Value::Null] {
            let mut incoming = provider(
                "relay",
                json!({ "auth": { "OPENAI_API_KEY": echoed }, "config": "" }),
            );
            merge_withheld_secrets(&mut incoming, Some(&stored), true);
            assert_eq!(incoming.settings_config["auth"]["OPENAI_API_KEY"], "");
        }
    }

    #[test]
    fn clearing_the_api_key_is_explicit_and_keeps_oauth_material() {
        let stored = provider(
            "codex-official",
            json!({ "auth": oauth_auth(), "config": "" }),
        );
        let mut incoming = provider(
            "codex-official",
            json!({ "auth": { "auth_mode": "chatgpt", "OPENAI_API_KEY": "" }, "config": "" }),
        );
        merge_withheld_secrets(&mut incoming, Some(&stored), true);
        let auth = &incoming.settings_config["auth"];
        assert_eq!(auth["OPENAI_API_KEY"], "");
        assert_eq!(auth["tokens"]["refresh_token"], FIXTURE_REFRESH);
    }

    #[test]
    fn new_rows_are_left_alone() {
        let mut incoming = provider(
            "new",
            json!({ "auth": { "OPENAI_API_KEY": "" }, "config": "" }),
        );
        let before = incoming.settings_config.clone();
        merge_withheld_secrets(&mut incoming, None, false);
        assert_eq!(incoming.settings_config, before);
    }

    fn routed(id: &str, endpoint: &str, model: &str, key: &str) -> Provider {
        provider(
            id,
            json!({
                "auth": { "OPENAI_API_KEY": key },
                "config": format!(
                    "model = \"{model}\"\nmodel_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"{endpoint}\"\n"
                ),
            }),
        )
    }

    fn rows(providers: Vec<Provider>) -> IndexMap<String, Provider> {
        providers
            .into_iter()
            .enumerate()
            .map(|(index, mut provider)| {
                provider.sort_index = Some(index);
                (provider.id.clone(), provider)
            })
            .collect()
    }

    #[test]
    fn current_provider_matches_live_endpoint_model_and_key() {
        let providers = rows(vec![
            routed("first", "https://one.example/v1", "claude-a", "sk-one"),
            routed("second", "https://two.example/v1/", "claude-b", "sk-two"),
            routed(
                "same-endpoint",
                "https://two.example/v1",
                "claude-b",
                "sk-other",
            ),
        ]);
        let live = json!({
            "auth": { "OPENAI_API_KEY": "sk-two" },
            "config": "model = \"claude-b\"\nmodel_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://TWO.example/v1\"\n",
        });
        assert_eq!(
            resolve_current_provider(&providers, "first", Some(&live)),
            CurrentProviderResolution {
                id: Some("second".to_string()),
                source: "live"
            }
        );

        let other_key = json!({
            "auth": { "OPENAI_API_KEY": "sk-other" },
            "config": live["config"].clone(),
        });
        assert_eq!(
            resolve_current_provider(&providers, "first", Some(&other_key))
                .id
                .as_deref(),
            Some("same-endpoint")
        );
    }

    #[test]
    fn current_provider_reports_external_stored_and_none() {
        assert_eq!(
            resolve_current_provider(
                &rows(vec![routed("saved", "https://one.example/v1", "a", "k")]),
                "",
                None
            )
            .source,
            "none"
        );
        let providers = rows(vec![routed("first", "https://one.example/v1", "a", "k")]);
        let external = json!({
            "config": "model = \"x\"\nmodel_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://external.example/v1\"\n",
        });
        assert_eq!(
            resolve_current_provider(&providers, "first", Some(&external)),
            CurrentProviderResolution {
                id: None,
                source: "external"
            }
        );
        assert_eq!(
            resolve_current_provider(&providers, "first", None),
            CurrentProviderResolution {
                id: Some("first".to_string()),
                source: "stored"
            }
        );
        let takeover = json!({
            "config": "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"http://127.0.0.1:15721/v1\"\n",
        });
        assert_eq!(
            resolve_current_provider(&providers, "first", Some(&takeover)).source,
            "stored"
        );
        assert_eq!(
            resolve_current_provider(&IndexMap::new(), "first", Some(&takeover)),
            CurrentProviderResolution {
                id: None,
                source: "none"
            }
        );
    }

    #[test]
    fn official_line_resolves_from_an_endpointless_live_config() {
        // After a backfill the official row holds the same login as live; the
        // match runs on raw values inside the backend only.
        let mut official = provider(
            "codex-official",
            json!({ "auth": oauth_auth(), "config": "" }),
        );
        official.category = Some("official".to_string());
        let providers = rows(vec![
            routed("relay", "https://relay.example/v1", "gpt-5", "sk-relay"),
            official,
        ]);
        let live = json!({ "auth": oauth_auth(), "config": "model = \"gpt-5\"\n" });
        assert_eq!(
            resolve_current_provider(&providers, "codex-official", Some(&live)),
            CurrentProviderResolution {
                id: Some("codex-official".to_string()),
                source: "live"
            }
        );
    }

    // Scenarios carried over from the renderer's former `resolveCurrentProvider`
    // tests (tests/utils/chimeraUtils.test.ts, tests/integration/machine-state.test.ts).

    fn openai_style(id: &str, base_url: &str, model: &str) -> Provider {
        let base_url_line = if base_url.is_empty() {
            String::new()
        } else {
            format!("base_url = \"{base_url}\"\n")
        };
        provider(
            id,
            json!({
                "config": format!("model_provider = \"openai\"\n{base_url_line}model = \"{model}\"\n"),
            }),
        )
    }

    fn openai_style_live(base_url: &str) -> Value {
        openai_style("live", base_url, "gpt-4o").settings_config
    }

    #[test]
    fn current_provider_uses_the_config_bearer_token_when_lines_share_endpoint_and_model() {
        let config = |token: &str| {
            format!(
                "model = \"gpt-5.6\"\nmodel_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://relay.example/v1\"\nexperimental_bearer_token = \"{token}\"\n"
            )
        };
        let line = |id: &str| {
            provider(
                id,
                json!({
                    "auth": { "OPENAI_API_KEY": format!("sk-{id}") },
                    "config": config(format!("sk-{id}").as_str()),
                }),
            )
        };
        let providers = rows(vec![line("line-1"), line("line-2")]);
        for id in ["line-1", "line-2"] {
            let live = json!({ "config": config(format!("sk-{id}").as_str()) });
            assert_eq!(
                resolve_current_provider(&providers, "line-2", Some(&live)),
                CurrentProviderResolution {
                    id: Some(id.to_string()),
                    source: "live"
                }
            );
        }
    }

    #[test]
    fn current_provider_matches_openai_style_endpoints_and_the_endpointless_official_line() {
        let providers = rows(vec![
            openai_style("codex-official", "", "gpt-4o"),
            openai_style("relay-1", "https://relay.example.com/v1", "gpt-4o"),
        ]);
        for live in [
            "https://relay.example.com/v1",
            "https://relay.example.com/v1/",
        ] {
            assert_eq!(
                resolve_current_provider(
                    &providers,
                    "codex-official",
                    Some(&openai_style_live(live))
                ),
                CurrentProviderResolution {
                    id: Some("relay-1".to_string()),
                    source: "live"
                }
            );
        }
        assert_eq!(
            resolve_current_provider(&providers, "relay-1", Some(&openai_style_live(""))),
            CurrentProviderResolution {
                id: Some("codex-official".to_string()),
                source: "live"
            }
        );
    }

    #[test]
    fn only_loopback_endpoints_count_as_proxy_takeover() {
        let providers = rows(vec![
            openai_style("codex-official", "", "gpt-4o"),
            openai_style("relay-1", "https://relay.example.com/v1", "gpt-4o"),
            openai_style("custom", "http://127.0.0.2:8080", "gpt-4o"),
        ]);
        for takeover in [
            "http://127.0.0.1:15721",
            "http://localhost:9999/v1",
            "https://127.0.0.1:8443",
        ] {
            let live = openai_style_live(takeover);
            assert_eq!(
                resolve_current_provider(&providers, "relay-1", Some(&live)),
                CurrentProviderResolution {
                    id: Some("relay-1".to_string()),
                    source: "stored"
                }
            );
            assert_eq!(
                resolve_current_provider(&providers, "does-not-exist", Some(&live)),
                CurrentProviderResolution {
                    id: None,
                    source: "external"
                }
            );
        }
        let non_loopback = openai_style_live("http://127.0.0.2:8080");
        assert_eq!(
            resolve_current_provider(&providers, "relay-1", Some(&non_loopback))
                .id
                .as_deref(),
            Some("custom")
        );
    }

    #[test]
    fn unreadable_or_endpointless_live_falls_back_to_the_stored_line() {
        let providers = rows(vec![provider(
            "line-primary",
            json!({ "config": "model = \"gpt-5.6-sol\"\n" }),
        )]);
        assert_eq!(
            resolve_current_provider(&providers, "", None),
            CurrentProviderResolution {
                id: None,
                source: "none"
            }
        );
        // Neither side names an endpoint and the models differ: the stored
        // selection is the only honest answer.
        let live = json!({ "config": "model = \"gpt-6-astra\"\n" });
        assert_eq!(
            resolve_current_provider(&providers, "line-primary", Some(&live)),
            CurrentProviderResolution {
                id: Some("line-primary".to_string()),
                source: "stored"
            }
        );
    }

    #[test]
    fn raw_copilot_token_commands_are_not_registered() {
        let lib = include_str!("lib.rs");
        assert!(!lib.contains("commands::copilot_get_token"));
    }
}
