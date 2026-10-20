//! Database-backed Codex ownership migrations and import sanitization.

use crate::database::Database;
use crate::error::AppError;
use rusqlite::{params, OptionalExtension};

use super::live::{remove_common_config_from_settings, settings_contain_common_config};

impl Database {
    /// Upgrade pre-ownership Codex snippets atomically, even when the older
    /// common-config migration flag is already set. Getters remain read-only.
    /// Keep the first original text for recovery; a valid snippet is a no-op.
    pub(crate) fn migrate_legacy_codex_common_config(&self) -> Result<bool, AppError> {
        use crate::codex_key_ownership::{
            inherit_legacy_codex_line_preferences, sanitize_codex_common_snippet_with_report,
            validate_codex_common_snippet,
        };
        use serde_json::Value;

        let (migrated, stripped) = self.with_connection(|conn| {
            let tx = conn.transaction()?;
        let old: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE key = 'common_config_codex'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(old) = old else {
            return Ok((false, Vec::new()));
        };
        if validate_codex_common_snippet(&old).is_ok() {
            return Ok((false, Vec::new()));
        }
        let (clean, report) = sanitize_codex_common_snippet_with_report(&old)?;
        validate_codex_common_snippet(&clean)?;
        let rows = {
            let mut stmt = tx.prepare(
                "SELECT id, settings_config, meta FROM providers WHERE app_type = 'codex' ORDER BY id",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (id, raw_settings, raw_meta) in rows {
            // Do not use the general row reader here: its fallback defaults
            // would silently overwrite malformed JSON or unknown metadata.
            let mut meta: Value = serde_json::from_str(&raw_meta).map_err(|_| {
                AppError::Config("Codex 线路元数据格式无效，旧版通用配置迁移已取消".to_string())
            })?;
            if meta.is_null() {
                meta = serde_json::json!({});
            }
            let meta = meta.as_object_mut().ok_or_else(|| {
                AppError::Config("Codex 线路元数据必须为对象，旧版通用配置迁移已取消".to_string())
            })?;
            let explicit = match meta.get("commonConfigEnabled") {
                None | Some(Value::Null) => None,
                Some(Value::Bool(enabled)) => Some(*enabled),
                Some(_) => {
                    return Err(AppError::Config(
                        "Codex 通用配置开关格式无效，迁移已取消".to_string(),
                    ))
                }
            };
            if explicit == Some(false) {
                continue;
            }
            let settings: Value = serde_json::from_str(&raw_settings).map_err(|_| {
                AppError::Config("Codex 线路设置格式无效，旧版通用配置迁移已取消".to_string())
            })?;
            // Infer from the complete ORIGINAL snippet, not a smaller cleaned
            // subset that could unexpectedly enable additional providers.
            let enabled = explicit.unwrap_or_else(|| {
                settings_contain_common_config(&crate::app_config::AppType::Codex, &settings, &old)
            });
            let mut updated = settings.clone();
            if enabled {
                let object = updated.as_object_mut().ok_or_else(|| {
                    AppError::Config("Codex 线路设置必须为对象，旧版通用配置迁移已取消".to_string())
                })?;
                let config = match object.get("config") {
                    None => "",
                    Some(Value::String(text)) => text.as_str(),
                    Some(_) => {
                        return Err(AppError::Config(
                            "Codex 线路 TOML 必须为文本，迁移已取消".to_string(),
                        ))
                    }
                };
                let config = inherit_legacy_codex_line_preferences(config, &old)?;
                object.insert("config".to_string(), Value::String(config));
                updated = remove_common_config_from_settings(
                    &crate::app_config::AppType::Codex,
                    &updated,
                    &clean,
                )?;
            }
            let meta_changed = explicit.is_none();
            if meta_changed {
                meta.insert("commonConfigEnabled".to_string(), Value::Bool(enabled));
            }
            if updated != settings || meta_changed {
                let settings = if updated == settings {
                    raw_settings
                } else {
                    serde_json::to_string(&updated)
                        .map_err(|source| AppError::JsonSerialize { source })?
                };
                let metadata = if meta_changed {
                    serde_json::to_string(&meta)
                        .map_err(|source| AppError::JsonSerialize { source })?
                } else {
                    raw_meta
                };
                tx.execute(
                    "UPDATE providers SET settings_config = ?1, meta = ?2 WHERE app_type = 'codex' AND id = ?3",
                    params![settings, metadata, id],
                )?;
            }
        }
        tx.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('common_config_codex_legacy_backup_v1', ?1)",
            params![old],
        )?;
        tx.execute(
            "UPDATE settings SET value = ?1 WHERE key = 'common_config_codex'",
            params![clean],
        )?;
            tx.commit()?;
            Ok((true, report.stripped))
        })?;
        if !migrated {
            return Ok(false);
        }
        log::warn!(
            "Migrated legacy Codex common-config key ownership: {}",
            stripped.join(", ")
        );
        Ok(true)
    }
    /// L3 one-time report (settings key `codex_key_ownership_report_v1`):
    /// the Codex lines whose stored config carries keys the key-ownership
    /// rules no longer apply from a line, by line name and key name only.
    /// Generated once, before any switch reduces the stored lines; returns
    /// the number of lines listed when it was generated by this call.
    pub fn record_codex_key_ownership_report_once(&self) -> Result<Option<usize>, AppError> {
        const KEY: &str = "codex_key_ownership_report_v1";
        if self.get_setting(KEY)?.is_some() {
            return Ok(None);
        }
        let mut lines = Vec::new();
        for (id, provider) in self.get_all_providers("codex")? {
            let Some(config) = provider
                .settings_config
                .get("config")
                .and_then(|v| v.as_str())
            else {
                continue;
            };
            let keys = crate::codex_key_ownership::codex_line_keys_without_effect(config);
            if !keys.is_empty() {
                lines.push(serde_json::json!({ "id": id, "name": provider.name, "keys": keys }));
            }
        }
        let count = lines.len();
        let report = serde_json::json!({ "lines": lines });
        self.set_setting(KEY, &report.to_string())?;
        Ok(Some(count))
    }

    /// MH-13b: treat every Codex row and the stored Codex common-config
    /// snippet as untrusted TOML (called after SQL import, `.db` restore and
    /// cloud-sync download). Stripped keys are removed from the stored text;
    /// the returned review lists, by name only, what was removed and which
    /// unknown environment variables still need the user's confirmation.
    pub fn sanitize_untrusted_codex_configs(
        &self,
    ) -> Result<crate::codex_key_ownership::CodexImportReview, AppError> {
        use crate::codex_key_ownership::{
            sanitize_untrusted_codex_config, CodexImportReview, CodexImportReviewLine,
        };

        // Preserve prior opt-in/model intent before the untrusted pass removes
        // permissions or other fields used by legacy subset inference.
        let mut common_report = match self.get_config_snippet("codex")? {
            Some(text) => {
                crate::codex_key_ownership::sanitize_codex_common_snippet_with_report(&text)?.1
            }
            None => Default::default(),
        };
        self.migrate_legacy_codex_common_config()?;

        let mut review = CodexImportReview::default();
        for (id, provider) in self.get_all_providers("codex")? {
            let official = provider.category.as_deref() == Some("official");
            let mut settings_config = provider.settings_config;
            let Some(config) = settings_config.get("config").and_then(|v| v.as_str()) else {
                continue;
            };
            let (clean, report) = match sanitize_untrusted_codex_config(config, official) {
                Ok(result) => result,
                Err(e) => {
                    log::warn!("Skipped MH-13b sanitize for unreadable Codex row '{id}': {e}");
                    continue;
                }
            };
            if report.is_empty() {
                continue;
            }
            if !report.stripped.is_empty() {
                settings_config["config"] = serde_json::Value::String(clean);
                self.update_provider_settings_config("codex", &id, &settings_config)?;
            }
            review.providers.push(CodexImportReviewLine {
                id,
                name: provider.name,
                report,
            });
        }

        if let Some(snippet) = self.get_config_snippet("codex")? {
            match sanitize_untrusted_codex_config(&snippet, false) {
                Ok((clean, report)) if !report.is_empty() => {
                    if !report.stripped.is_empty() {
                        self.set_config_snippet("codex", Some(clean))?;
                    }
                    common_report.stripped.extend(report.stripped);
                    common_report
                        .needs_confirmation
                        .extend(report.needs_confirmation);
                }
                Ok(_) => {}
                Err(_) => log::warn!("Skipped MH-13b sanitize for unreadable Codex common config"),
            }
        }
        common_report.stripped.sort();
        common_report.stripped.dedup();
        if !common_report.is_empty() {
            review.common_config = Some(common_report);
        }
        Ok(review)
    }
}
