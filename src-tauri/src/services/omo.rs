use crate::config::{atomic_write, write_json_file};
use crate::error::AppError;
use crate::opencode_config::get_opencode_dir;
use crate::provider::Provider;
use crate::store::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmoLocalFileData {
    pub agents: Option<Value>,
    pub categories: Option<Value>,
    pub other_fields: Option<Value>,
    pub file_path: String,
    pub last_modified: Option<String>,
}

type OmoProfileData = (Option<Value>, Option<Value>, Option<Value>);

/// 上游 OMO v3.19.2 起的统一配置：`~/.omo/omo.jsonc` / `omo.json`，
/// oh-my-openagent 配置存放在字面量键 `"[opencode]"` 分区内。
const UNIFIED_CONFIG_FILENAMES: [&str; 2] = ["omo.jsonc", "omo.json"];
const OPENCODE_SECTION_KEY: &str = "[opencode]";

/// OMO 配置的实际位置：统一配置优先于 legacy 插件式文件（与上游一致）。
#[derive(Debug, PartialEq)]
enum OmoConfigLocation {
    /// `~/.omo/omo.jsonc|omo.json`，读取其 `"[opencode]"` 分区
    Unified(PathBuf),
    /// opencode 目录下的插件式配置文件
    Legacy(PathBuf),
}

impl OmoConfigLocation {
    fn path(&self) -> &Path {
        match self {
            Self::Unified(path) | Self::Legacy(path) => path,
        }
    }
}

// ── Variant descriptor ─────────────────────────────────────────

pub struct OmoVariant {
    pub preferred_filename: &'static str,
    pub config_candidates: &'static [&'static str],
    pub category: &'static str,
    pub provider_prefix: &'static str,
    pub plugin_name: &'static str,
    pub plugin_prefixes: &'static [&'static str],
    pub has_categories: bool,
    pub label: &'static str,
    pub import_label: &'static str,
}

pub const STANDARD: OmoVariant = OmoVariant {
    preferred_filename: "oh-my-openagent.jsonc",
    config_candidates: &[
        "oh-my-openagent.jsonc",
        "oh-my-openagent.json",
        "oh-my-opencode.jsonc",
        "oh-my-opencode.json",
    ],
    category: "omo",
    provider_prefix: "omo-",
    plugin_name: "oh-my-openagent@latest",
    plugin_prefixes: &["oh-my-openagent", "oh-my-opencode"],
    has_categories: true,
    label: "OMO",
    import_label: "Imported",
};

pub const SLIM: OmoVariant = OmoVariant {
    preferred_filename: "oh-my-opencode-slim.jsonc",
    config_candidates: &["oh-my-opencode-slim.jsonc", "oh-my-opencode-slim.json"],
    category: "omo-slim",
    provider_prefix: "omo-slim-",
    plugin_name: "oh-my-opencode-slim@latest",
    plugin_prefixes: &["oh-my-opencode-slim"],
    has_categories: false,
    label: "OMO Slim",
    import_label: "Imported Slim",
};

// ── Service ────────────────────────────────────────────────────

pub struct OmoService;

impl OmoService {
    // ── Path helpers ────────────────────────────────────────

    fn config_candidates(v: &OmoVariant, base_dir: &Path) -> Vec<PathBuf> {
        v.config_candidates
            .iter()
            .map(|name| base_dir.join(name))
            .collect()
    }

    fn find_existing_config_path(v: &OmoVariant, base_dir: &Path) -> Option<PathBuf> {
        Self::config_candidates(v, base_dir)
            .into_iter()
            .find(|path| path.exists())
    }

    fn config_path(v: &OmoVariant) -> PathBuf {
        let base_dir = get_opencode_dir();
        Self::find_existing_config_path(v, &base_dir)
            .unwrap_or_else(|| base_dir.join(v.preferred_filename))
    }

    /// 统一配置只对 STANDARD 变体生效（与上游一致；SLIM 只有插件式文件）。
    fn find_unified_config_path(v: &OmoVariant, home_dir: &Path) -> Option<PathBuf> {
        if v.category != STANDARD.category {
            return None;
        }
        let config_dir = home_dir.join(".omo");
        UNIFIED_CONFIG_FILENAMES
            .iter()
            .map(|name| config_dir.join(name))
            .find(|path| path.exists())
    }

    fn find_config_location(
        v: &OmoVariant,
        home_dir: &Path,
        legacy_dir: &Path,
    ) -> Option<OmoConfigLocation> {
        if let Some(path) = Self::find_unified_config_path(v, home_dir) {
            return Some(OmoConfigLocation::Unified(path));
        }
        Self::find_existing_config_path(v, legacy_dir).map(OmoConfigLocation::Legacy)
    }

    fn resolve_local_config_location(v: &OmoVariant) -> Result<OmoConfigLocation, AppError> {
        Self::find_config_location(v, &crate::config::get_home_dir(), &get_opencode_dir())
            .ok_or(AppError::OmoConfigNotFound)
    }

    /// 读取配置对象；统一配置取其 `[opencode]` 分区，插件式文件取根对象。
    fn read_config_object(location: &OmoConfigLocation) -> Result<Map<String, Value>, AppError> {
        let mut root = Self::read_jsonc_object(location.path())?;
        match location {
            OmoConfigLocation::Unified(path) => match root.remove(OPENCODE_SECTION_KEY) {
                None => Err(AppError::OmoConfigNotFound),
                Some(Value::Object(section)) => Ok(section),
                Some(_) => Err(AppError::Config(format!(
                    "OMO [opencode] section must be an object: {}",
                    path.display()
                ))),
            },
            OmoConfigLocation::Legacy(_) => Ok(root),
        }
    }

    fn read_jsonc_object(path: &Path) -> Result<Map<String, Value>, AppError> {
        let content = std::fs::read_to_string(path).map_err(|e| AppError::io(path, e))?;
        let cleaned = Self::strip_jsonc_comments(&content);
        let parsed: Value = serde_json::from_str(&cleaned)
            .map_err(|e| AppError::Config(format!("Failed to parse oh-my-opencode config: {e}")))?;
        parsed
            .as_object()
            .cloned()
            .ok_or_else(|| AppError::Config("Expected JSON object".to_string()))
    }

    // ── Field extraction ───────────────────────────────────

    fn extract_other_fields_with_keys(
        obj: &Map<String, Value>,
        known: &[&str],
    ) -> Map<String, Value> {
        let mut other = Map::new();
        for (k, v) in obj {
            if !known.contains(&k.as_str()) {
                other.insert(k.clone(), v.clone());
            }
        }
        other
    }

    // ── Merge helpers ──────────────────────────────────────

    fn insert_opt_value(result: &mut Map<String, Value>, key: &str, value: &Option<Value>) {
        if let Some(v) = value {
            result.insert(key.to_string(), v.clone());
        }
    }

    fn insert_object_entries(result: &mut Map<String, Value>, value: Option<&Value>) {
        if let Some(Value::Object(map)) = value {
            for (k, v) in map {
                result.insert(k.clone(), v.clone());
            }
        }
    }

    fn profile_data_from_provider(provider: &Provider, v: &OmoVariant) -> OmoProfileData {
        let agents = provider.settings_config.get("agents").cloned();
        let categories = if v.has_categories {
            provider.settings_config.get("categories").cloned()
        } else {
            None
        };
        let other_fields = provider.settings_config.get("otherFields").cloned();
        (agents, categories, other_fields)
    }

    fn snapshot_config_file(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
        if !path.exists() {
            return Ok(None);
        }

        std::fs::read(path)
            .map(Some)
            .map_err(|e| AppError::io(path, e))
    }

    fn restore_config_file(path: &Path, snapshot: Option<&[u8]>) -> Result<(), AppError> {
        match snapshot {
            Some(bytes) => atomic_write(path, bytes),
            None => {
                if path.exists() {
                    std::fs::remove_file(path).map_err(|e| AppError::io(path, e))?;
                }
                Ok(())
            }
        }
    }

    fn write_profile_config(
        v: &OmoVariant,
        profile_data: Option<&OmoProfileData>,
    ) -> Result<(), AppError> {
        // v2.5.0：检测到上游统一配置（~/.omo/omo.jsonc|omo.json）时拒绝写入
        // 插件式文件——上游优先读取统一配置，写 legacy 文件会被静默忽略。
        // 统一配置的往返写入依赖上游的 round-trip JSON5 编辑器（保留注释与
        // 格式），移植计划记录在 docs/upstream/sync-matrix-2026-08.md；当前
        // 版本支持从统一配置导入（read/import），写入路径显式失败优于假成功。
        if let Some(unified) = Self::find_unified_config_path(v, &crate::config::get_home_dir()) {
            return Err(AppError::Config(format!(
                "检测到 OMO 统一配置 {}；当前版本支持从该文件导入，但暂不支持写入其 [opencode] 分区。请直接编辑该文件，或移除它以回到 {} 写入模式。",
                unified.display(),
                v.preferred_filename
            )));
        }

        let merged = Self::build_config(v, profile_data);
        let config_path = Self::config_path(v);

        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
        }

        let previous_contents = Self::snapshot_config_file(&config_path)?;
        write_json_file(&config_path, &merged)?;
        if let Err(err) = crate::opencode_config::add_plugin(v.plugin_name) {
            if let Err(rollback_err) =
                Self::restore_config_file(&config_path, previous_contents.as_deref())
            {
                log::warn!(
                    "Failed to roll back {} config after plugin sync error: {}",
                    v.label,
                    rollback_err
                );
            }
            return Err(err);
        }
        log::info!("{} config written to {config_path:?}", v.label);
        Ok(())
    }

    // ── Public API (variant-parameterized) ─────────────────

    pub fn delete_config_file(v: &OmoVariant) -> Result<(), AppError> {
        let base_dir = get_opencode_dir();
        let mut deleted_paths = Vec::new();
        for config_path in Self::config_candidates(v, &base_dir) {
            if config_path.exists() {
                std::fs::remove_file(&config_path).map_err(|e| AppError::io(&config_path, e))?;
                deleted_paths.push(config_path);
            }
        }
        if !deleted_paths.is_empty() {
            log::info!("{} config files deleted: {deleted_paths:?}", v.label);
        }
        crate::opencode_config::remove_plugins_by_prefixes(v.plugin_prefixes)?;
        Ok(())
    }

    pub fn write_config_to_file(state: &AppState, v: &OmoVariant) -> Result<(), AppError> {
        let current_omo = state.db.get_current_omo_provider("opencode", v.category)?;
        let profile_data = current_omo
            .as_ref()
            .map(|provider| Self::profile_data_from_provider(provider, v));
        Self::write_profile_config(v, profile_data.as_ref())
    }

    pub fn write_provider_config_to_file(
        provider: &Provider,
        v: &OmoVariant,
    ) -> Result<(), AppError> {
        let profile_data = Self::profile_data_from_provider(provider, v);
        Self::write_profile_config(v, Some(&profile_data))
    }

    fn build_config(v: &OmoVariant, profile_data: Option<&OmoProfileData>) -> Value {
        let mut result = Map::new();
        if let Some((agents, categories, other_fields)) = profile_data {
            Self::insert_object_entries(&mut result, other_fields.as_ref());
            Self::insert_opt_value(&mut result, "agents", agents);
            if v.has_categories {
                Self::insert_opt_value(&mut result, "categories", categories);
            }
        }
        Value::Object(result)
    }

    pub fn import_from_local(
        state: &AppState,
        v: &OmoVariant,
    ) -> Result<crate::provider::Provider, AppError> {
        let location = Self::resolve_local_config_location(v)?;
        let obj = Self::read_config_object(&location)?;

        let mut settings = Map::new();
        if let Some(agents) = obj.get("agents") {
            settings.insert("agents".to_string(), agents.clone());
        }
        if v.has_categories {
            if let Some(categories) = obj.get("categories") {
                settings.insert("categories".to_string(), categories.clone());
            }
        }

        let other = Self::extract_other_fields_with_keys(&obj, &["agents", "categories"]);
        if !other.is_empty() {
            settings.insert("otherFields".to_string(), Value::Object(other));
        }

        let provider_id = format!("{}{}", v.provider_prefix, uuid::Uuid::new_v4());
        let name = format!(
            "{} {}",
            v.import_label,
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        );
        let settings_config =
            serde_json::to_value(&settings).unwrap_or_else(|_| serde_json::json!({}));

        let provider = crate::provider::Provider {
            id: provider_id,
            name,
            settings_config,
            website_url: None,
            category: Some(v.category.to_string()),
            created_at: Some(chrono::Utc::now().timestamp_millis()),
            sort_index: None,
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        };

        state.db.save_provider("opencode", &provider)?;
        state
            .db
            .set_omo_provider_current("opencode", &provider.id, v.category)?;
        Self::write_config_to_file(state, v)?;
        Ok(provider)
    }

    pub fn read_local_file(v: &OmoVariant) -> Result<OmoLocalFileData, AppError> {
        let location = Self::resolve_local_config_location(v)?;
        let actual_path = location.path();
        let metadata = std::fs::metadata(actual_path).ok();
        let last_modified = metadata
            .and_then(|m| m.modified().ok())
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());

        let obj = Self::read_config_object(&location)?;

        Ok(Self::build_local_file_data(
            v,
            &obj,
            actual_path.to_string_lossy().to_string(),
            last_modified,
        ))
    }

    fn build_local_file_data(
        v: &OmoVariant,
        obj: &Map<String, Value>,
        file_path: String,
        last_modified: Option<String>,
    ) -> OmoLocalFileData {
        let agents = obj.get("agents").cloned();
        let categories = if v.has_categories {
            obj.get("categories").cloned()
        } else {
            None
        };

        let other = Self::extract_other_fields_with_keys(obj, &["agents", "categories"]);
        let other_fields = if other.is_empty() {
            None
        } else {
            Some(Value::Object(other))
        };

        OmoLocalFileData {
            agents,
            categories,
            other_fields,
            file_path,
            last_modified,
        }
    }

    fn strip_jsonc_comments(input: &str) -> String {
        let mut result = String::with_capacity(input.len());
        let mut chars = input.chars().peekable();
        let mut in_string = false;
        let mut escape = false;

        while let Some(&c) = chars.peek() {
            if in_string {
                result.push(c);
                chars.next();
                if escape {
                    escape = false;
                } else if c == '\\' {
                    escape = true;
                } else if c == '"' {
                    in_string = false;
                }
            } else if c == '"' {
                in_string = true;
                result.push(c);
                chars.next();
            } else if c == '/' {
                chars.next();
                match chars.peek() {
                    Some('/') => {
                        chars.next();
                        while let Some(&nc) = chars.peek() {
                            if nc == '\n' {
                                break;
                            }
                            chars.next();
                        }
                    }
                    Some('*') => {
                        chars.next();
                        while let Some(nc) = chars.next() {
                            if nc == '*' {
                                if let Some(&'/') = chars.peek() {
                                    chars.next();
                                    break;
                                }
                            }
                        }
                    }
                    _ => {
                        result.push('/');
                    }
                }
            } else {
                result.push(c);
                chars.next();
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_jsonc_comments() {
        let input = r#"{
  // This is a comment
  "key": "value", // inline comment
  /* multi
     line */
  "key2": "val//ue"
}"#;
        let result = OmoService::strip_jsonc_comments(input);
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["key"], "value");
        assert_eq!(parsed["key2"], "val//ue");
    }

    #[test]
    fn test_build_config_empty() {
        let merged = OmoService::build_config(&STANDARD, None);
        assert!(merged.is_object());
        assert!(merged.as_object().unwrap().is_empty());
    }

    #[test]
    fn test_build_config_with_profile() {
        let agents = Some(serde_json::json!({
            "sisyphus": { "model": "claude-opus-4-5" }
        }));
        let categories = None;
        let other_fields = Some(serde_json::json!({
            "$schema": "https://example.com/schema.json",
            "disabled_agents": ["explore"]
        }));
        let profile_data = (agents, categories, other_fields);
        let merged = OmoService::build_config(&STANDARD, Some(&profile_data));
        let obj = merged.as_object().unwrap();

        assert_eq!(obj["$schema"], "https://example.com/schema.json");
        assert_eq!(obj["disabled_agents"], serde_json::json!(["explore"]));
        assert!(obj.contains_key("agents"));
        assert_eq!(obj["agents"]["sisyphus"]["model"], "claude-opus-4-5");
    }

    #[test]
    fn test_build_local_file_data_keeps_all_non_agent_category_fields_in_other() {
        let obj = serde_json::json!({
            "$schema": "https://example.com/schema.json",
            "disabled_agents": ["oracle"],
            "agents": {
                "sisyphus": { "model": "claude-opus-4-6" }
            },
            "categories": {
                "code": { "model": "gpt-5.3" }
            },
            "custom_top_level": {
                "enabled": true
            }
        });
        let obj_map = obj.as_object().unwrap().clone();

        let data = OmoService::build_local_file_data(
            &STANDARD,
            &obj_map,
            "/tmp/oh-my-opencode.jsonc".to_string(),
            None,
        );

        // All non-agents/categories fields should be in other_fields
        let other = data.other_fields.unwrap();
        let other_obj = other.as_object().unwrap();
        assert_eq!(
            other_obj.get("$schema").unwrap(),
            "https://example.com/schema.json"
        );
        assert_eq!(
            other_obj.get("disabled_agents").unwrap(),
            &serde_json::json!(["oracle"])
        );
        assert_eq!(
            other_obj.get("custom_top_level").unwrap(),
            &serde_json::json!({"enabled": true})
        );
        // agents and categories should NOT be in other_fields
        assert!(!other_obj.contains_key("agents"));
        assert!(!other_obj.contains_key("categories"));
    }

    #[test]
    fn test_build_config_ignores_non_object_other_fields() {
        let agents = None;
        let categories = None;
        let other_fields = Some(serde_json::json!("profile_non_object"));
        let profile_data = (agents, categories, other_fields);

        let merged = OmoService::build_config(&STANDARD, Some(&profile_data));
        let obj = merged.as_object().unwrap();

        assert!(!obj.contains_key("profile_non_object"));
    }

    #[test]
    fn test_build_config_slim_excludes_categories() {
        let agents = Some(serde_json::json!({"orchestrator": {"model": "k2"}}));
        let categories = Some(serde_json::json!({"code": {"model": "gpt"}}));
        let other_fields = Some(serde_json::json!({
            "$schema": "https://slim.schema",
            "disabled_agents": ["oracle"]
        }));
        let profile_data = (agents, categories, other_fields);

        let merged = OmoService::build_config(&SLIM, Some(&profile_data));
        let obj = merged.as_object().unwrap();

        // Slim should NOT include categories
        assert!(!obj.contains_key("categories"));

        // Slim SHOULD include these
        assert_eq!(obj["$schema"], "https://slim.schema");
        assert!(obj.contains_key("agents"));
        assert!(obj.contains_key("disabled_agents"));
    }

    #[test]
    fn test_find_existing_config_prefers_new_name_over_old() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("oh-my-opencode.jsonc");
        let new_path = dir.path().join("oh-my-openagent.jsonc");

        // Create both old and new files
        std::fs::write(&old_path, r#"{"agents":{}}"#).unwrap();
        std::fs::write(&new_path, r#"{"agents":{}}"#).unwrap();

        let found = OmoService::find_existing_config_path(&STANDARD, dir.path());
        assert_eq!(
            found.unwrap(),
            new_path,
            "When both old and new config files exist, the new name (oh-my-openagent) must be preferred"
        );
    }

    #[test]
    fn test_find_existing_config_falls_back_to_old_name() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("oh-my-opencode.jsonc");

        // Only old file exists
        std::fs::write(&old_path, r#"{"agents":{}}"#).unwrap();

        let found = OmoService::find_existing_config_path(&STANDARD, dir.path());
        assert_eq!(
            found.unwrap(),
            old_path,
            "When only the old config file exists, it should still be found"
        );
    }

    #[test]
    fn test_unified_config_takes_priority_over_legacy() {
        let home = tempfile::tempdir().unwrap();
        let legacy = tempfile::tempdir().unwrap();
        let omo_dir = home.path().join(".omo");
        std::fs::create_dir_all(&omo_dir).unwrap();
        let unified_path = omo_dir.join("omo.jsonc");
        std::fs::write(&unified_path, r#"{"[opencode]":{"agents":{}}}"#).unwrap();
        std::fs::write(
            legacy.path().join("oh-my-openagent.jsonc"),
            r#"{"agents":{}}"#,
        )
        .unwrap();

        let location =
            OmoService::find_config_location(&STANDARD, home.path(), legacy.path()).unwrap();
        assert_eq!(location, OmoConfigLocation::Unified(unified_path));
    }

    #[test]
    fn test_unified_config_prefers_jsonc_then_json() {
        let home = tempfile::tempdir().unwrap();
        let omo_dir = home.path().join(".omo");
        std::fs::create_dir_all(&omo_dir).unwrap();
        std::fs::write(omo_dir.join("omo.json"), r#"{"[opencode]":{}}"#).unwrap();

        let found = OmoService::find_unified_config_path(&STANDARD, home.path());
        assert_eq!(found.unwrap(), omo_dir.join("omo.json"));

        std::fs::write(omo_dir.join("omo.jsonc"), r#"{"[opencode]":{}}"#).unwrap();
        let found = OmoService::find_unified_config_path(&STANDARD, home.path());
        assert_eq!(found.unwrap(), omo_dir.join("omo.jsonc"));
    }

    #[test]
    fn test_unified_config_is_ignored_for_slim_variant() {
        let home = tempfile::tempdir().unwrap();
        let omo_dir = home.path().join(".omo");
        std::fs::create_dir_all(&omo_dir).unwrap();
        std::fs::write(omo_dir.join("omo.jsonc"), r#"{"[opencode]":{}}"#).unwrap();

        assert!(OmoService::find_unified_config_path(&SLIM, home.path()).is_none());
    }

    #[test]
    fn test_read_config_object_extracts_opencode_section() {
        let home = tempfile::tempdir().unwrap();
        let omo_dir = home.path().join(".omo");
        std::fs::create_dir_all(&omo_dir).unwrap();
        let path = omo_dir.join("omo.jsonc");
        std::fs::write(
            &path,
            r#"{
  // 顶层是 OMO 自己的配置，[opencode] 分区才属于 oh-my-openagent
  "model": "top-level",
  "[opencode]": { "agents": { "dev": {} }, "categories": { "x": {} }, "extra": 1 }
}"#,
        )
        .unwrap();

        let obj =
            OmoService::read_config_object(&OmoConfigLocation::Unified(path.clone())).unwrap();
        assert!(obj.contains_key("agents"));
        assert!(obj.contains_key("categories"));
        assert_eq!(obj["extra"], 1);
        assert!(
            !obj.contains_key("model"),
            "top-level OMO fields must not leak into the [opencode] section"
        );
    }

    #[test]
    fn test_read_config_object_reports_missing_opencode_section() {
        let home = tempfile::tempdir().unwrap();
        let omo_dir = home.path().join(".omo");
        std::fs::create_dir_all(&omo_dir).unwrap();
        let path = omo_dir.join("omo.jsonc");
        std::fs::write(&path, r#"{"model":"top-level"}"#).unwrap();

        let result = OmoService::read_config_object(&OmoConfigLocation::Unified(path));
        assert!(matches!(result, Err(AppError::OmoConfigNotFound)));
    }

    #[test]
    fn test_read_config_object_rejects_non_object_opencode_section() {
        let home = tempfile::tempdir().unwrap();
        let omo_dir = home.path().join(".omo");
        std::fs::create_dir_all(&omo_dir).unwrap();
        let path = omo_dir.join("omo.jsonc");
        std::fs::write(&path, r#"{"[opencode]": 42}"#).unwrap();

        let result = OmoService::read_config_object(&OmoConfigLocation::Unified(path));
        assert!(matches!(result, Err(AppError::Config(_))));
    }
}
