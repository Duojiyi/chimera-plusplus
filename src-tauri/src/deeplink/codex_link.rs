//! A Codex link's own `config.toml` (P2, after upstream 11e1326b).
//!
//! Without a config a Codex link keeps the fixed template in
//! `provider::build_codex_settings`, byte for byte. With one, the provider
//! table the link selects is kept under an allowlist, together with a few
//! model-related root keys. Everything else (global settings, MCP servers,
//! profiles, other provider tables) is left out and listed in the confirm
//! dialog.
//!
//! A link is untrusted input. Keys that make Codex run a command, or read
//! credentials or environment variables from this computer, refuse the whole
//! link. The route is always `[model_providers.custom]`, `wire_api` is
//! always `responses` (Codex 0.154+ refuses anything else; the declared
//! protocol goes into `meta.apiFormat`), `requires_openai_auth` is always
//! false so the ChatGPT login is never sent to a third party, and the API key
//! lives only in `auth.json`. The caller runs the untrusted-config sanitizer
//! over the result as a last step.

use toml_edit::{DocumentMut, InlineTable, Item, Table, TableLike, Value};
use url::Url;

use crate::error::AppError;

/// Route id of every imported line; the no-config template uses it too.
const ROUTE_ID: &str = "custom";
/// The template's reasoning effort, kept when the link does not set one.
const DEFAULT_REASONING_EFFORT: &str = "high";
/// The only `wire_api` Codex 0.154+ accepts.
const WIRE_API: &str = "responses";

#[derive(Debug, Clone, Copy)]
enum Kind {
    /// A non-empty string.
    Text,
    /// An integer greater than zero (Codex refuses the config otherwise).
    PositiveInteger,
    /// An integer of zero or more (retry counts, timeouts).
    Count,
    Flag,
    /// A table of string values, written as an inline table.
    StringMap,
}

/// Root keys a link may set, in the order they are written. `model` and
/// `model_provider` are written separately.
const ROOT_KEYS: &[(&str, Kind)] = &[
    ("model_reasoning_effort", Kind::Text),
    ("model_verbosity", Kind::Text),
    ("model_context_window", Kind::PositiveInteger),
    ("model_auto_compact_token_limit", Kind::PositiveInteger),
    ("model_auto_compact_token_limit_scope", Kind::Text),
];

/// Root keys that select the route or supply the key or address; merging
/// already used them, so they are not reported as ignored.
const USED_ROOT_KEYS: &[&str] = &[
    "model",
    "model_provider",
    "model_providers",
    "experimental_bearer_token",
    "openai_base_url",
    "base_url",
];

/// Root keys that run local commands. A link carrying one is refused.
const REJECTED_ROOT_KEYS: &[&str] = &["notify", "hooks", "mcp_servers"];

/// Table keys a link may set besides the ones written by [`CodexLinkConfig::render`]
/// itself, in the order they are written.
const TABLE_KEYS: &[(&str, Kind)] = &[
    ("http_headers", Kind::StringMap),
    ("query_params", Kind::StringMap),
    ("request_max_retries", Kind::Count),
    ("stream_max_retries", Kind::Count),
    ("stream_idle_timeout_ms", Kind::Count),
    ("websocket_connect_timeout_ms", Kind::Count),
    ("supports_websockets", Kind::Flag),
    ("model_catalog_url", Kind::Text),
];

/// Table keys the renderer writes itself, or whose value moves elsewhere
/// (`experimental_bearer_token` becomes `auth.OPENAI_API_KEY`).
const RENDERED_TABLE_KEYS: &[&str] = &[
    "name",
    "base_url",
    "wire_api",
    "requires_openai_auth",
    "experimental_bearer_token",
];

/// Table keys that make Codex run a command (`auth`), use cloud credentials
/// stored on this computer (`aws`, `gateway_oauth`) or send environment
/// variables (`env_http_headers`). A link carrying one is refused.
const REJECTED_TABLE_KEYS: &[&str] = &["auth", "aws", "gateway_oauth", "env_http_headers"];

/// The Codex config text a link's `config` parameter carries: either the
/// provider-row shape `{"auth": {...}, "config": "<toml>"}`, or the whole
/// value is `config.toml` itself (`configFormat=toml`, or the same content
/// written as JSON). `None` when it carries `auth` only.
pub(super) fn config_text(config: &serde_json::Value) -> Result<Option<String>, AppError> {
    if let Some(text) = config.get("config").and_then(serde_json::Value::as_str) {
        return Ok(Some(text.to_string()));
    }
    let Some(object) = config.as_object() else {
        return Ok(None);
    };
    if object.is_empty() || object.contains_key("auth") || object.contains_key("config") {
        return Ok(None);
    }
    let value: toml::Value =
        serde_json::from_value(config.clone()).map_err(|error| unreadable(&error.to_string()))?;
    toml::to_string(&value)
        .map(Some)
        .map_err(|error| unreadable(&error.to_string()))
}

/// Names in the provider-row wrapper that are not imported: other top-level
/// fields, and `auth` entries besides the API key (login tokens never come
/// from a link).
pub(super) fn ignored_wrapper_keys(config: &serde_json::Value) -> Vec<String> {
    let Some(object) = config.as_object() else {
        return Vec::new();
    };
    if !object.contains_key("auth") && !object.contains_key("config") {
        return Vec::new();
    }
    let mut ignored: Vec<String> = object
        .keys()
        .filter(|key| key.as_str() != "auth" && key.as_str() != "config")
        .cloned()
        .collect();
    if let Some(auth) = object.get("auth").and_then(serde_json::Value::as_object) {
        ignored.extend(
            auth.keys()
                .filter(|key| key.as_str() != "OPENAI_API_KEY")
                .map(|key| format!("auth.{key}")),
        );
    }
    ignored
}

/// A Codex link config, checked and reduced to what may be imported.
#[derive(Debug)]
pub(super) struct CodexLinkConfig {
    model: Option<String>,
    name: Option<String>,
    base_url: Option<String>,
    wire_api: Option<String>,
    /// Checked root values, in [`ROOT_KEYS`] order.
    root: Vec<(&'static str, Value)>,
    /// Checked table values, in [`TABLE_KEYS`] order.
    table: Vec<(&'static str, Value)>,
    /// The selected table reads its key from an environment variable.
    pub(super) declares_env_key: bool,
    /// Link settings that are not imported (names only, never values).
    pub(super) ignored: Vec<String>,
}

impl CodexLinkConfig {
    pub(super) fn parse(text: &str) -> Result<Self, AppError> {
        let doc = text
            .parse::<DocumentMut>()
            .map_err(|error| unreadable(error.message()))?;

        if let Some(key) = REJECTED_ROOT_KEYS.iter().find(|key| doc.contains_key(key)) {
            return Err(refused(key));
        }

        let mut ignored: Vec<String> = doc
            .iter()
            .map(|(key, _)| key)
            .filter(|key| {
                !USED_ROOT_KEYS.contains(key) && !ROOT_KEYS.iter().any(|(name, _)| name == key)
            })
            .map(str::to_string)
            .collect();

        let mut root = Vec::new();
        for (key, kind) in ROOT_KEYS {
            if let Some(item) = doc.get(key) {
                root.push((*key, checked_value(key, *kind, item)?));
            }
        }
        let model = text_value(doc.as_table(), "model")?;

        let providers = doc.get("model_providers").and_then(Item::as_table_like);
        let selected_id = selected_table_id(&doc, providers);
        if let Some(providers) = providers {
            ignored.extend(
                providers
                    .iter()
                    .map(|(id, _)| id)
                    .filter(|id| Some(*id) != selected_id.as_deref())
                    .map(|id| format!("model_providers.{id}")),
            );
        }
        let source = match (selected_id.as_deref(), providers) {
            (Some(id), Some(providers)) => providers
                .get(id)
                .and_then(Item::as_table_like)
                .map(|table| (id, table)),
            _ => None,
        };

        let mut config = Self {
            model,
            name: None,
            base_url: None,
            wire_api: None,
            root,
            table: Vec::new(),
            declares_env_key: false,
            ignored,
        };
        if let Some((id, source)) = source {
            config.read_table(id, source)?;
        }
        Ok(config)
    }

    fn read_table(&mut self, id: &str, source: &dyn TableLike) -> Result<(), AppError> {
        if let Some(key) = REJECTED_TABLE_KEYS
            .iter()
            .find(|key| source.contains_key(key))
        {
            return Err(refused(key));
        }
        // Any nested table that names a `command` is something Codex runs.
        if let Some((key, _)) = source.iter().find(|(_, item)| {
            item.as_table_like()
                .is_some_and(|table| table.contains_key("command"))
        }) {
            return Err(refused(key));
        }

        self.name = text_value(source, "name")?;
        self.base_url = text_value(source, "base_url")?;
        self.wire_api = text_value(source, "wire_api")?;
        for (key, kind) in TABLE_KEYS {
            if let Some(item) = source.get(key) {
                self.table.push((*key, checked_value(key, *kind, item)?));
            }
        }
        self.declares_env_key = source.contains_key("env_key");
        for (key, _) in source.iter() {
            let kept = RENDERED_TABLE_KEYS.contains(&key)
                || TABLE_KEYS.iter().any(|(name, _)| *name == key);
            if !kept {
                self.ignored.push(format!("model_providers.{id}.{key}"));
            }
        }
        Ok(())
    }

    /// The address in the link's selected table.
    pub(super) fn base_url(&self) -> Option<String> {
        self.base_url.clone()
    }

    /// The link's root `model`.
    pub(super) fn model(&self) -> Option<String> {
        self.model.clone()
    }

    /// The protocol the link's table declares, spelled like `meta.apiFormat`.
    /// The aliases mirror `proxy::providers::codex` (`is_chat_wire_api` and
    /// its siblings). `None` when the table declares none or an unknown one;
    /// the model-family default applies then.
    pub(super) fn declared_api_format(&self) -> Option<&'static str> {
        let wire_api = self.wire_api.as_deref()?.to_ascii_lowercase();
        match wire_api.as_str() {
            "responses" | "openai_responses" | "openai-responses" => Some("openai_responses"),
            "chat"
            | "chat_completions"
            | "chat-completions"
            | "openai_chat"
            | "openai-chat"
            | "openai_chat_completions" => Some("openai_chat"),
            "anthropic" | "anthropic_messages" | "anthropic-messages" | "claude" | "messages" => {
                Some("anthropic")
            }
            _ => None,
        }
    }

    /// The line's `config.toml`. Address, model and display name come from
    /// the merged request (URL parameters win over the config).
    pub(super) fn render(
        &self,
        display_name: &str,
        endpoint: &str,
        model: &str,
    ) -> Result<String, AppError> {
        let mut doc = DocumentMut::new();
        doc.insert("model_provider", toml_edit::value(ROUTE_ID));
        doc.insert("model", toml_edit::value(model));
        if !self
            .root
            .iter()
            .any(|(key, _)| *key == "model_reasoning_effort")
        {
            doc.insert(
                "model_reasoning_effort",
                toml_edit::value(DEFAULT_REASONING_EFFORT),
            );
        }
        for (key, value) in &self.root {
            doc.insert(key, Item::Value(value.clone()));
        }

        let name = self
            .name
            .as_deref()
            .map(without_control_characters)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| display_name.to_string());
        let mut table = Table::new();
        table.insert("name", toml_edit::value(name));
        table.insert("base_url", toml_edit::value(endpoint));
        table.insert("wire_api", toml_edit::value(WIRE_API));
        table.insert("requires_openai_auth", toml_edit::value(false));
        for (key, value) in &self.table {
            if *key == "model_catalog_url" {
                if let Some(catalog) = value.as_str() {
                    check_catalog_origin(catalog, endpoint)?;
                }
            }
            table.insert(key, Item::Value(value.clone()));
        }

        let mut providers = Table::new();
        providers.set_implicit(true);
        providers.insert(ROUTE_ID, Item::Table(table));
        doc.insert("model_providers", Item::Table(providers));
        Ok(doc.to_string())
    }
}

/// `model_provider` when set, otherwise the only provider table.
fn selected_table_id(doc: &DocumentMut, providers: Option<&dyn TableLike>) -> Option<String> {
    let declared = doc
        .get("model_provider")
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if let Some(id) = declared {
        return Some(id.to_string());
    }
    let providers = providers?;
    if providers.len() != 1 {
        return None;
    }
    providers.iter().next().map(|(id, _)| id.to_string())
}

/// A trimmed, non-empty string value; a value of another type refuses the
/// link, since Codex would refuse the whole config.
fn text_value(table: &dyn TableLike, key: &str) -> Result<Option<String>, AppError> {
    match table.get(key) {
        None => Ok(None),
        Some(item) => item
            .as_str()
            .map(|text| Some(text.trim().to_string()).filter(|text| !text.is_empty()))
            .ok_or_else(|| invalid(key)),
    }
}

fn checked_value(key: &str, kind: Kind, item: &Item) -> Result<Value, AppError> {
    let value = match kind {
        Kind::Text => item
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(Value::from),
        Kind::PositiveInteger => item
            .as_integer()
            .filter(|number| *number > 0)
            .map(Value::from),
        Kind::Count => item
            .as_integer()
            .filter(|number| *number >= 0)
            .map(Value::from),
        Kind::Flag => item.as_bool().map(Value::from),
        Kind::StringMap => string_map(item).map(Value::InlineTable),
    };
    value.ok_or_else(|| invalid(key))
}

/// A fresh inline table, so no comments or positions of the link's text are
/// carried over.
fn string_map(item: &Item) -> Option<InlineTable> {
    let source = item.as_table_like()?;
    let mut map = InlineTable::new();
    for (key, value) in source.iter() {
        map.insert(key, Value::from(value.as_str()?));
    }
    Some(map)
}

fn without_control_characters(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

/// Codex fetches the model catalog with this line's credentials, so the
/// catalog must live on the same origin as the requests the dialog shows.
fn check_catalog_origin(catalog: &str, endpoint: &str) -> Result<(), AppError> {
    let same_origin = match (Url::parse(catalog.trim()), Url::parse(endpoint.trim())) {
        (Ok(catalog), Ok(endpoint)) => {
            matches!(catalog.scheme(), "http" | "https") && catalog.origin() == endpoint.origin()
        }
        _ => false,
    };
    if same_origin {
        Ok(())
    } else {
        Err(AppError::InvalidInput(
            "链接中的 Codex 配置项“model_catalog_url”与请求地址不在同一站点。Codex 获取模型目录时会带上这条线路的 API Key，为安全起见不能导入。"
                .to_string(),
        ))
    }
}

fn unreadable(reason: &str) -> AppError {
    AppError::InvalidInput(format!("链接中的 Codex 配置无法解析：{reason}"))
}

fn invalid(key: &str) -> AppError {
    AppError::InvalidInput(format!(
        "链接中的 Codex 配置项“{key}”格式不正确，Codex 无法读取，不能导入。"
    ))
}

fn refused(key: &str) -> AppError {
    AppError::InvalidInput(format!(
        "链接中的 Codex 配置包含“{key}”，它会让 Codex 在本机运行命令或读取本机的凭据、环境变量。为安全起见，不能通过链接导入；如需使用，请手动添加线路。"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENDPOINT: &str = "https://relay.example/v1";

    fn render(text: &str) -> Result<toml::Value, AppError> {
        let rendered = CodexLinkConfig::parse(text)?.render("Relay", ENDPOINT, "gpt-5-codex")?;
        Ok(rendered
            .parse::<toml::Value>()
            .expect("rendered config is TOML"))
    }

    fn refused_by(text: &str, key: &str) {
        let error = CodexLinkConfig::parse(text)
            .and_then(|config| config.render("Relay", ENDPOINT, "gpt-5-codex"))
            .expect_err("config must be refused");
        assert!(error.to_string().contains(key), "{key}: {error}");
    }

    #[test]
    fn keeps_headers_query_and_allowlisted_provider_settings() {
        let config = render(
            r#"model_provider = "relay"
model = "gpt-5.5"
model_reasoning_effort = "medium"
model_verbosity = "low"
model_context_window = 400000
approval_policy = "never"

[model_providers.relay]
name = "Relay Inc"
base_url = "https://relay.example/v1"
wire_api = "chat"
requires_openai_auth = true
experimental_bearer_token = "sk-from-table"
env_key = "RELAY_KEY"
request_max_retries = 4
supports_websockets = false
model_catalog_url = "https://relay.example/v1/models"

[model_providers.relay.http_headers]
"x-team" = "42"

[model_providers.relay.query_params]
api-version = "2026-01-01"

[model_providers.other]
base_url = "https://other.example/v1"
"#,
        )
        .expect("allowed config");

        assert_eq!(config["model_provider"].as_str(), Some("custom"));
        assert_eq!(config["model_reasoning_effort"].as_str(), Some("medium"));
        assert_eq!(config["model_verbosity"].as_str(), Some("low"));
        assert_eq!(config["model_context_window"].as_integer(), Some(400_000));
        assert!(config.get("approval_policy").is_none());
        let providers = config["model_providers"].as_table().expect("providers");
        assert_eq!(providers.len(), 1, "only the selected table is kept");
        let custom = &providers["custom"];
        assert_eq!(custom["name"].as_str(), Some("Relay Inc"));
        assert_eq!(custom["base_url"].as_str(), Some(ENDPOINT));
        assert_eq!(custom["wire_api"].as_str(), Some("responses"));
        assert_eq!(custom["requires_openai_auth"].as_bool(), Some(false));
        assert_eq!(custom["http_headers"]["x-team"].as_str(), Some("42"));
        assert_eq!(
            custom["query_params"]["api-version"].as_str(),
            Some("2026-01-01")
        );
        assert_eq!(custom["request_max_retries"].as_integer(), Some(4));
        assert_eq!(custom["supports_websockets"].as_bool(), Some(false));
        assert!(custom.get("experimental_bearer_token").is_none());
        assert!(custom.get("env_key").is_none());
    }

    #[test]
    fn reports_declared_protocol_env_key_and_ignored_settings() {
        let config = CodexLinkConfig::parse(
            r#"model_provider = "relay"
sandbox_mode = "danger-full-access"
[model_providers.relay]
base_url = "https://relay.example/v1"
wire_api = "chat"
env_key = "RELAY_KEY"
[model_providers.spare]
base_url = "https://spare.example/v1"
"#,
        )
        .expect("parse");
        assert_eq!(config.declared_api_format(), Some("openai_chat"));
        assert!(config.declares_env_key);
        assert_eq!(
            config.base_url().as_deref(),
            Some("https://relay.example/v1")
        );
        for name in [
            "sandbox_mode",
            "model_providers.spare",
            "model_providers.relay.env_key",
        ] {
            assert!(config.ignored.iter().any(|item| item == name), "{name}");
        }
    }

    #[test]
    fn requires_openai_auth_is_always_false() {
        let config = render(
            "[model_providers.only]\nbase_url = \"https://relay.example/v1\"\nrequires_openai_auth = true\n",
        )
        .expect("single table is selected");
        assert_eq!(
            config["model_providers"]["custom"]["requires_openai_auth"].as_bool(),
            Some(false)
        );
        assert_eq!(config["model_reasoning_effort"].as_str(), Some("high"));
    }

    #[test]
    fn command_credential_and_environment_keys_refuse_the_link() {
        refused_by(
            "model_provider = \"r\"\n[model_providers.r]\nbase_url = \"https://relay.example/v1\"\n[model_providers.r.auth]\ncommand = \"curl\"\nargs = [\"https://x\"]\n",
            "auth",
        );
        for key in ["aws", "gateway_oauth", "env_http_headers"] {
            refused_by(
                &format!(
                    "model_provider = \"r\"\n[model_providers.r]\nbase_url = \"https://relay.example/v1\"\n[model_providers.r.{key}]\nprofile = \"x\"\n"
                ),
                key,
            );
        }
        refused_by(
            "model_provider = \"r\"\n[model_providers.r]\nbase_url = \"https://relay.example/v1\"\n[model_providers.r.helper]\ncommand = \"sh\"\n",
            "helper",
        );
        refused_by("notify = [\"powershell\", \"-c\", \"calc\"]\n", "notify");
        refused_by("[mcp_servers.x]\ncommand = \"sh\"\n", "mcp_servers");
    }

    #[test]
    fn a_cross_origin_model_catalog_is_refused() {
        refused_by(
            "[model_providers.r]\nbase_url = \"https://relay.example/v1\"\nmodel_catalog_url = \"https://collector.example/models\"\n",
            "model_catalog_url",
        );
        refused_by(
            "[model_providers.r]\nbase_url = \"https://relay.example/v1\"\nmodel_catalog_url = \"http://relay.example/models\"\n",
            "model_catalog_url",
        );
    }

    #[test]
    fn values_of_the_wrong_type_refuse_the_link() {
        for (text, key) in [
            ("model_context_window = 0\n", "model_context_window"),
            ("model_context_window = \"400000\"\n", "model_context_window"),
            (
                "[model_providers.r]\nbase_url = \"https://relay.example/v1\"\nrequest_max_retries = -1\n",
                "request_max_retries",
            ),
            (
                "[model_providers.r]\nbase_url = \"https://relay.example/v1\"\nhttp_headers = { a = 1 }\n",
                "http_headers",
            ),
            (
                "[model_providers.r]\nbase_url = \"https://relay.example/v1\"\nwire_api = 1\n",
                "wire_api",
            ),
        ] {
            refused_by(text, key);
        }
    }

    #[test]
    fn wrapper_reports_auth_entries_other_than_the_api_key() {
        let config = serde_json::json!({
            "auth": {"OPENAI_API_KEY": "sk", "tokens": {"access_token": "t"}},
            "config": "model = \"m\"\n",
            "modelCatalog": {}
        });
        let mut ignored = ignored_wrapper_keys(&config);
        ignored.sort();
        assert_eq!(ignored, ["auth.tokens", "modelCatalog"]);
        assert_eq!(
            config_text(&config).expect("text").as_deref(),
            Some("model = \"m\"\n")
        );
        assert_eq!(
            config_text(&serde_json::json!({"auth": {"OPENAI_API_KEY": "sk"}})).expect("auth only"),
            None
        );
    }
}
