// Adapted from farion1231/cc-switch src-tauri/src/mcode_config.rs (MIT)
//! MiniMax Code (`mcode`): its TUI and desktop app share `config.yaml` and
//! MiniMax Code owns model selection. Chimera++ manages only
//! `custom_provider.<key>` entries of `kind: custom` (D4):
//!
//! - every write holds MiniMax Code's own `config.yaml.lock`;
//! - `defaultModel` / `defaultLightModel` are never written, and the entry
//!   or model they select is never removed or disabled;
//! - only the `custom_provider` section is rewritten, so comments elsewhere
//!   survive; when a comment would still be lost the file is backed up first
//!   and the backup path is returned.

use crate::config::{atomic_write_private, get_home_dir};
use crate::error::AppError;
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const PROVIDERS_KEY: &str = "custom_provider";
const SELECTION_FIELDS: [&str; 2] = ["defaultModel", "defaultLightModel"];
/// MiniMax Code's lock library (proper-lockfile) treats a lock whose mtime
/// is older than 10 s as abandoned; its holder refreshes the mtime while alive.
const LOCK_STALE_AFTER: Duration = Duration::from_secs(10);

pub(crate) fn data_dir() -> PathBuf {
    explicit_data_dir(
        std::env::var("MINIMAX_DATA_DIR").ok().as_deref(),
        std::env::var("MAVIS_DATA_DIR").ok().as_deref(),
    )
    .unwrap_or_else(|| get_home_dir().join(".minimax"))
}

fn explicit_data_dir(minimax: Option<&str>, mavis: Option<&str>) -> Option<PathBuf> {
    [minimax, mavis]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|path| !path.is_empty())
        .map(|path| {
            let resolved = crate::settings::resolve_override_path(path);
            if resolved.is_absolute() {
                resolved
            } else {
                get_home_dir().join(resolved)
            }
        })
}

pub(crate) fn config_path() -> PathBuf {
    data_dir().join("config.yaml")
}

fn read_text(path: &Path) -> Result<String, AppError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(AppError::io(path, error)),
    }
}

fn parse(text: &str) -> Result<serde_yaml::Value, AppError> {
    let value: serde_yaml::Value = serde_yaml::from_str(text)
        .map_err(|_| AppError::Config("Invalid MiniMax Code YAML configuration".into()))?;
    if value.is_null() {
        return Ok(serde_yaml::Value::Mapping(Default::default()));
    }
    if !value.is_mapping() {
        return Err(AppError::Config(
            "MiniMax Code configuration must be a mapping".into(),
        ));
    }
    Ok(value)
}

/// Managed (`kind: custom` or kind-less) entries, read-only.
pub(crate) fn get_providers() -> Result<IndexMap<String, Value>, AppError> {
    let document = parse(&read_text(&config_path())?)?;
    match document.get(PROVIDERS_KEY) {
        None | Some(serde_yaml::Value::Null) => Ok(IndexMap::new()),
        Some(value) => {
            let mut providers: IndexMap<String, Value> = serde_yaml::from_value(value.clone())
                .map_err(|_| {
                    AppError::Config("Invalid MiniMax Code custom_provider configuration".into())
                })?;
            providers.retain(|_, provider| {
                provider
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_none_or(|kind| kind == "custom")
            });
            Ok(providers)
        }
    }
}

/// Any `custom_provider` node under this key, including MiniMax Code's own
/// account providers.
pub(crate) fn provider_key_exists(id: &str) -> Result<bool, AppError> {
    let document = parse(&read_text(&config_path())?)?;
    Ok(document
        .get(PROVIDERS_KEY)
        .and_then(serde_yaml::Value::as_mapping)
        .is_some_and(|providers| providers.contains_key(serde_yaml::Value::from(id))))
}

pub(crate) fn validate_provider(id: &str, config: &Value) -> Result<(), AppError> {
    if id.is_empty()
        || id
            .chars()
            .any(|c| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '_'))
    {
        return Err(AppError::InvalidInput(
            "MiniMax Code provider key must contain letters, digits, '-' or '_'".into(),
        ));
    }
    if !matches!(
        config
            .get("api")
            .map_or(Some("anthropic-messages"), Value::as_str),
        Some("anthropic-messages" | "openai-completions" | "openai-responses")
    ) {
        return Err(AppError::InvalidInput(
            "Select a supported MiniMax Code API format".into(),
        ));
    }
    let base_url = config
        .pointer("/options/baseURL")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !url::Url::parse(base_url)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
    {
        return Err(AppError::InvalidInput(
            "Enter a valid MiniMax Code endpoint URL".into(),
        ));
    }
    if config
        .pointer("/options/apiKey")
        .and_then(Value::as_str)
        .is_none_or(|key| key.trim().is_empty())
    {
        return Err(AppError::InvalidInput("Enter an API key".into()));
    }
    if config
        .get("models")
        .and_then(Value::as_object)
        .is_none_or(|models| models.is_empty() || models.keys().any(|id| id.trim().is_empty()))
    {
        return Err(AppError::InvalidInput(
            "Add at least one MiniMax Code model".into(),
        ));
    }
    Ok(())
}

/// The atomic directory lock MiniMax Code itself takes (`<config>.lock`).
struct ConfigLock(PathBuf);

impl ConfigLock {
    fn acquire(config: &Path) -> Result<Self, AppError> {
        let mut lock_path = config.as_os_str().to_owned();
        lock_path.push(".lock");
        let lock_path = PathBuf::from(lock_path);
        if let Err(error) = fs::create_dir(&lock_path) {
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(AppError::io(&lock_path, error));
            }
            let stale = fs::metadata(&lock_path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|mtime| mtime.elapsed().ok())
                .is_some_and(|age| age > LOCK_STALE_AFTER);
            if !stale {
                return Err(AppError::Conflict(
                    "MiniMax Code configuration is busy; retry after MiniMax Code finishes saving"
                        .into(),
                ));
            }
            if let Err(e) = fs::remove_dir(&lock_path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(AppError::io(&lock_path, e));
                }
            }
            if let Err(e) = fs::create_dir(&lock_path) {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    return Err(AppError::Conflict(
                        "MiniMax Code configuration lock was re-acquired by another process; please retry".into(),
                    ));
                }
                return Err(AppError::io(&lock_path, e));
            }
        }
        Ok(Self(lock_path))
    }
}

impl Drop for ConfigLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

/// Reject a change that would remove or disable the entry/model MiniMax Code
/// has selected as `defaultModel` / `defaultLightModel`.
fn ensure_selection_survives(
    document: &serde_yaml::Value,
    id: &str,
    provider: Option<&Value>,
) -> Result<(), AppError> {
    let prefix = format!("{PROVIDERS_KEY}:{id}/");
    let breaks_selection = SELECTION_FIELDS.iter().any(|field| {
        document
            .get(*field)
            .and_then(serde_yaml::Value::as_str)
            .and_then(|model| model.strip_prefix(&prefix))
            .is_some_and(|model| {
                !provider.is_some_and(|provider| {
                    provider.get("enabled") != Some(&Value::Bool(false))
                        && provider
                            .get("models")
                            .and_then(|models| models.get(model))
                            .is_some_and(|model| {
                                model.is_object()
                                    && model.get("enabled") != Some(&Value::Bool(false))
                            })
                })
            })
    });
    if breaks_selection {
        return Err(AppError::InvalidInput(
            "Select another default model in MiniMax Code before removing this model or provider"
                .into(),
        ));
    }
    Ok(())
}

// ponytail: line-based comment detection (a `#` starting a line or following
// whitespace). A `#` inside a quoted value only triggers an unneeded backup.
// Upgrade path: a comment-preserving YAML editor.
fn loses_comments(before: &str, after: &str) -> bool {
    let kept: HashSet<&str> = after.lines().map(str::trim).collect();
    before
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('#') || line.contains(" #") || line.contains("\t#"))
        .any(|line| !kept.contains(line))
}

/// Set (`Some`) or remove (`None`) one entry. `create_only` rejects a key
/// that already exists, checked while holding MiniMax Code's lock. Returns
/// the backup path when the edit could not keep every comment.
fn write_entry(
    path: &Path,
    id: &str,
    provider: Option<&Value>,
    create_only: bool,
) -> Result<Option<PathBuf>, AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Config("Invalid MiniMax Code configuration path".into()))?;
    fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    // The lock sits next to the real file, as MiniMax Code resolves symlinks.
    let path = if path.exists() {
        fs::canonicalize(path).map_err(|e| AppError::io(path, e))?
    } else {
        path.to_path_buf()
    };
    let _lock = ConfigLock::acquire(&path)?;

    let raw = read_text(&path)?;
    let mut document = parse(&raw)?;
    let replacement = provider
        .map(serde_yaml::to_value)
        .transpose()
        .map_err(|_| AppError::Config("Invalid MiniMax Code provider".into()))?;
    let current = document
        .get(PROVIDERS_KEY)
        .and_then(|providers| providers.get(id))
        .cloned();

    if create_only && current.is_some() {
        return Err(AppError::InvalidInput(format!(
            "MiniMax Code provider key '{id}' already exists"
        )));
    }
    if current
        .as_ref()
        .and_then(|node| node.get("kind"))
        .and_then(serde_yaml::Value::as_str)
        .is_some_and(|kind| kind != "custom")
    {
        return Err(AppError::InvalidInput(
            "MiniMax Code owns this account provider".into(),
        ));
    }
    if current == replacement {
        return Ok(None);
    }
    ensure_selection_survives(&document, id, provider)?;

    let root = document
        .as_mapping_mut()
        .ok_or_else(|| AppError::Config("MiniMax Code configuration must be a mapping".into()))?;
    let section = root
        .entry(PROVIDERS_KEY.into())
        .or_insert_with(|| serde_yaml::Value::Mapping(Default::default()));
    if section.is_null() {
        *section = serde_yaml::Value::Mapping(Default::default());
    }
    let providers = section.as_mapping_mut().ok_or_else(|| {
        AppError::Config("Invalid MiniMax Code custom_provider configuration".into())
    })?;
    let key = serde_yaml::Value::from(id);
    match replacement {
        Some(node) => {
            providers.insert(key, node);
        }
        None => {
            providers.shift_remove(key);
        }
    }
    let section = section.clone();

    // Rewrite only the custom_provider section; fall back to a full rewrite
    // when the text layout defeats section replacement (flow-style root,
    // anchors shared across sections).
    let edited = crate::hermes_config::replace_yaml_section(&raw, PROVIDERS_KEY, &section)
        .ok()
        .filter(|text| parse(text).is_ok_and(|parsed| parsed == document));
    let text = match edited {
        Some(text) => text,
        None => serde_yaml::to_string(&document)
            .map_err(|_| AppError::Config("Cannot serialize MiniMax Code configuration".into()))?,
    };

    let backup = if loses_comments(&raw, &text) {
        Some(crate::hermes_config::create_yaml_backup("mcode", &raw)?)
    } else {
        None
    };
    atomic_write_private(&path, text.as_bytes())?;
    Ok(backup)
}

pub(crate) fn set_provider(id: &str, config: &Value) -> Result<Option<PathBuf>, AppError> {
    validate_provider(id, config)?;
    write_entry(&config_path(), id, Some(config), false)
}

/// Like [`set_provider`], but never replaces an existing node.
pub(crate) fn add_provider(id: &str, config: &Value) -> Result<Option<PathBuf>, AppError> {
    validate_provider(id, config)?;
    write_entry(&config_path(), id, Some(config), true)
}

pub(crate) fn remove_provider(id: &str) -> Result<Option<PathBuf>, AppError> {
    if !config_path().exists() {
        return Ok(None);
    }
    write_entry(&config_path(), id, None, false)
}

#[cfg(test)]
pub(crate) mod test_support {
    /// Points `MINIMAX_DATA_DIR` (and the app config home) at a temporary
    /// directory until dropped. Callers must be `#[serial]`.
    pub(crate) struct TestDataDir {
        pub(crate) dir: tempfile::TempDir,
        previous: Vec<(&'static str, Option<String>)>,
    }

    impl TestDataDir {
        pub(crate) fn new() -> Self {
            let dir = tempfile::tempdir().expect("create MiniMax Code test home");
            let keys = ["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "CC_SWITCH_TEST_HOME"];
            let previous = keys
                .iter()
                .map(|key| (*key, std::env::var(key).ok()))
                .collect();
            std::env::set_var("MINIMAX_DATA_DIR", dir.path().join(".minimax"));
            std::env::remove_var("MAVIS_DATA_DIR");
            std::env::set_var("CC_SWITCH_TEST_HOME", dir.path());
            Self { dir, previous }
        }
    }

    impl Drop for TestDataDir {
        fn drop(&mut self) {
            for (key, value) in &self.previous {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lock_dir(path: &Path) -> PathBuf {
        path.with_extension("yaml.lock")
    }

    #[test]
    fn native_data_directory_precedence_and_blank_values() {
        assert_eq!(
            explicit_data_dir(Some(" /primary "), Some("/legacy")),
            Some("/primary".into())
        );
        assert_eq!(
            explicit_data_dir(Some(" \t"), Some(" /legacy ")),
            Some("/legacy".into())
        );
        assert_eq!(explicit_data_dir(None, Some("")), None);
        assert_eq!(explicit_data_dir(None, None), None);
    }

    #[test]
    #[cfg(unix)]
    fn reclaims_a_stale_native_lock_but_preserves_an_active_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let lock = lock_dir(&path);
        fs::create_dir(&lock).unwrap();
        assert!(matches!(
            write_entry(&path, "test", Some(&json!({})), false),
            Err(AppError::Conflict(_))
        ));
        assert!(lock.exists());
        fs::File::open(&lock)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - Duration::from_secs(11))
            .unwrap();
        write_entry(&path, "test", Some(&json!({"name":"Recovered"})), false).unwrap();
        assert!(!lock.exists());
        assert_eq!(
            parse(&fs::read_to_string(&path).unwrap()).unwrap()["custom_provider"]["test"]["name"],
            "Recovered"
        );
    }

    #[test]
    fn native_provider_can_omit_api_format() {
        let mut provider = json!({"options":{"baseURL":"https://example.com","apiKey":"test-key"},"models":{"model":{}}});
        validate_provider("native", &provider).unwrap();
        for api in [json!(null), json!(true), json!("unsupported")] {
            provider["api"] = api;
            assert!(validate_provider("native", &provider).is_err());
        }
        assert!(validate_provider("bad key", &json!({})).is_err());
    }

    #[test]
    fn active_lock_blocks_and_selected_model_is_protected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let text = "defaultModel: custom_provider:chosen/model\ncustom_provider:\n  chosen: {}\n";
        fs::write(&path, text).unwrap();
        fs::create_dir(lock_dir(&path)).unwrap();
        assert!(write_entry(&path, "other", Some(&json!({})), false).is_err());
        fs::remove_dir(lock_dir(&path)).unwrap();
        assert!(write_entry(&path, "chosen", None, false).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        assert!(!lock_dir(&path).exists(), "the lock is released on error");
    }

    #[test]
    fn default_and_light_model_selection_is_never_broken() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        for field in SELECTION_FIELDS {
            let text = format!("{field}: custom_provider:chosen/model\ncustom_provider:\n  chosen:\n    models:\n      model: {{}}\n");
            fs::write(&path, &text).unwrap();
            for replacement in [
                None,
                Some(json!({"models":{"other":{}}})),
                Some(json!({"enabled":false,"models":{"model":{}}})),
                Some(json!({"models":{"model":{"enabled":false}}})),
            ] {
                assert!(write_entry(&path, "chosen", replacement.as_ref(), false).is_err());
                assert_eq!(fs::read_to_string(&path).unwrap(), text);
            }
            write_entry(
                &path,
                "chosen",
                Some(&json!({"name":"Kept","models":{"model":{}}})),
                false,
            )
            .unwrap();
            let after = fs::read_to_string(&path).unwrap();
            assert!(
                after.starts_with(&format!("{field}: custom_provider:chosen/model\n")),
                "the selection line is never rewritten: {after}"
            );
        }
    }

    #[test]
    fn account_providers_and_existing_keys_are_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let text = "custom_provider:\n  account:\n    kind: minimax\n  raced:\n    name: Theirs\n";
        fs::write(&path, text).unwrap();
        assert!(write_entry(&path, "account", Some(&json!({"name":"Ours"})), false).is_err());
        assert!(write_entry(&path, "account", None, false).is_err());
        assert!(write_entry(&path, "raced", Some(&json!({"name":"Ours"})), true).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        write_entry(&path, "fresh", Some(&json!({"name":"Ours"})), true).unwrap();
        assert_eq!(
            parse(&fs::read_to_string(&path).unwrap()).unwrap()["custom_provider"]["fresh"]["name"],
            "Ours"
        );
    }

    #[test]
    fn unchanged_or_absent_entries_do_not_rewrite_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let text = "# hand written\ncustom_provider:\n  keep:\n    name: Keep # inline\n";
        fs::write(&path, text).unwrap();
        assert_eq!(write_entry(&path, "missing", None, false).unwrap(), None);
        assert_eq!(
            write_entry(&path, "keep", Some(&json!({"name":"Keep"})), false).unwrap(),
            None
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn comment_loss_is_detected_only_for_dropped_comment_lines() {
        let before = "# top\nmodel: a\ncustom_provider:\n  x: 1 # inline\n";
        assert!(!loses_comments(
            before,
            "# top\nmodel: a\ncustom_provider:\n  x: 1 # inline\n"
        ));
        assert!(loses_comments(
            before,
            "# top\nmodel: a\ncustom_provider:\n  x: 1\n"
        ));
        assert!(!loses_comments(
            "url: https://a/#frag\n",
            "url: https://a/#frag2\n"
        ));
    }
}
