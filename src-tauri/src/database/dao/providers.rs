use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::provider::{Provider, ProviderMeta};
use indexmap::IndexMap;
use rusqlite::{params, OptionalExtension};
use std::collections::{HashMap, HashSet};

type OmoProviderRow = (
    String,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<usize>,
    Option<String>,
    String,
);

/// Selection and takeover backup touched by a compensated provider update.
pub(crate) struct ProviderUpdateSelection {
    current_ids: Vec<String>,
    backup: Option<(String, String)>,
}

impl Database {
    pub(crate) fn snapshot_provider_update_selection(
        &self,
        app: &str,
    ) -> Result<ProviderUpdateSelection, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn.prepare(
            "SELECT id FROM providers WHERE app_type = ?1 AND is_current = 1 ORDER BY id",
        )?;
        let current_ids = stmt
            .query_map([app], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let backup = conn
            .query_row(
                "SELECT original_config, backed_up_at FROM proxy_live_backup WHERE app_type = ?1",
                [app],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(ProviderUpdateSelection {
            current_ids,
            backup,
        })
    }

    pub(crate) fn restore_provider_update_selection(
        &self,
        app: &str,
        before: &ProviderUpdateSelection,
    ) -> Result<(), AppError> {
        let now = self.snapshot_provider_update_selection(app)?;
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        if now.current_ids != before.current_ids {
            tx.execute(
                "UPDATE providers SET is_current = 0 WHERE app_type = ?1 AND is_current = 1",
                [app],
            )?;
            for id in &before.current_ids {
                tx.execute(
                    "UPDATE providers SET is_current = 1 WHERE app_type = ?1 AND id = ?2",
                    [app, id.as_str()],
                )?;
            }
        }
        if now.backup != before.backup {
            match &before.backup {
                Some((config, timestamp)) => {
                    tx.execute("INSERT OR REPLACE INTO proxy_live_backup (app_type, original_config, backed_up_at) VALUES (?1, ?2, ?3)", params![app, config, timestamp])?;
                }
                None => {
                    tx.execute("DELETE FROM proxy_live_backup WHERE app_type = ?1", [app])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_all_providers(
        &self,
        app_type: &str,
    ) -> Result<IndexMap<String, Provider>, AppError> {
        let conn = lock_conn!(self.conn);
        Self::get_all_providers_on_connection(&conn, app_type)
    }

    pub(crate) fn get_all_providers_on_connection(
        conn: &rusqlite::Connection,
        app_type: &str,
    ) -> Result<IndexMap<String, Provider>, AppError> {
        let mut stmt = conn.prepare(
            "SELECT id, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, in_failover_queue
             FROM providers WHERE app_type = ?1
             ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC"
        ).map_err(|e| AppError::Database(e.to_string()))?;

        let provider_iter = stmt
            .query_map(params![app_type], |row| {
                let id: String = row.get(0)?;
                let name: String = row.get(1)?;
                let settings_config_str: String = row.get(2)?;
                let website_url: Option<String> = row.get(3)?;
                let category: Option<String> = row.get(4)?;
                let created_at: Option<i64> = row.get(5)?;
                let sort_index: Option<usize> = row.get(6)?;
                let notes: Option<String> = row.get(7)?;
                let icon: Option<String> = row.get(8)?;
                let icon_color: Option<String> = row.get(9)?;
                let meta_str: String = row.get(10)?;
                let in_failover_queue: bool = row.get(11)?;

                let settings_config =
                    serde_json::from_str(&settings_config_str).unwrap_or(serde_json::Value::Null);
                let meta: ProviderMeta = serde_json::from_str(&meta_str).unwrap_or_default();

                Ok((
                    id,
                    Provider {
                        id: "".to_string(), // Placeholder, set below
                        name,
                        settings_config,
                        website_url,
                        category,
                        created_at,
                        sort_index,
                        notes,
                        meta: Some(meta),
                        icon,
                        icon_color,
                        in_failover_queue,
                    },
                ))
            })
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut providers = IndexMap::new();
        for provider_res in provider_iter {
            let (id, mut provider) = provider_res.map_err(|e| AppError::Database(e.to_string()))?;
            provider.id = id.clone();

            let mut stmt_endpoints = conn.prepare(
                "SELECT url, added_at FROM provider_endpoints WHERE provider_id = ?1 AND app_type = ?2 ORDER BY added_at ASC, url ASC"
            ).map_err(|e| AppError::Database(e.to_string()))?;

            let endpoints_iter = stmt_endpoints
                .query_map(params![id, app_type], |row| {
                    let url: String = row.get(0)?;
                    let added_at: Option<i64> = row.get(1)?;
                    Ok((
                        url,
                        crate::settings::CustomEndpoint {
                            url: "".to_string(),
                            added_at: added_at.unwrap_or(0),
                            last_used: None,
                        },
                    ))
                })
                .map_err(|e| AppError::Database(e.to_string()))?;

            let mut custom_endpoints = HashMap::new();
            for ep_res in endpoints_iter {
                let (url, mut ep) = ep_res.map_err(|e| AppError::Database(e.to_string()))?;
                ep.url = url.clone();
                custom_endpoints.insert(url, ep);
            }

            if let Some(meta) = &mut provider.meta {
                meta.custom_endpoints = custom_endpoints;
            }

            providers.insert(id, provider);
        }

        Ok(providers)
    }

    pub fn get_current_provider(&self, app_type: &str) -> Result<Option<String>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare("SELECT id FROM providers WHERE app_type = ?1 AND is_current = 1 LIMIT 1")
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut rows = stmt
            .query(params![app_type])
            .map_err(|e| AppError::Database(e.to_string()))?;

        if let Some(row) = rows.next().map_err(|e| AppError::Database(e.to_string()))? {
            Ok(Some(
                row.get(0).map_err(|e| AppError::Database(e.to_string()))?,
            ))
        } else {
            Ok(None)
        }
    }

    pub fn get_provider_by_id(
        &self,
        id: &str,
        app_type: &str,
    ) -> Result<Option<Provider>, AppError> {
        let conn = lock_conn!(self.conn);
        let result = conn.query_row(
            "SELECT name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, in_failover_queue
             FROM providers WHERE id = ?1 AND app_type = ?2",
            params![id, app_type],
            |row| {
                let name: String = row.get(0)?;
                let settings_config_str: String = row.get(1)?;
                let website_url: Option<String> = row.get(2)?;
                let category: Option<String> = row.get(3)?;
                let created_at: Option<i64> = row.get(4)?;
                let sort_index: Option<usize> = row.get(5)?;
                let notes: Option<String> = row.get(6)?;
                let icon: Option<String> = row.get(7)?;
                let icon_color: Option<String> = row.get(8)?;
                let meta_str: String = row.get(9)?;
                let in_failover_queue: bool = row.get(10)?;

                let settings_config = serde_json::from_str(&settings_config_str).unwrap_or(serde_json::Value::Null);
                let meta: ProviderMeta = serde_json::from_str(&meta_str).unwrap_or_default();

                Ok(Provider {
                    id: id.to_string(),
                    name,
                    settings_config,
                    website_url,
                    category,
                    created_at,
                    sort_index,
                    notes,
                    meta: Some(meta),
                    icon,
                    icon_color,
                    in_failover_queue,
                })
            },
        );

        match result {
            Ok(provider) => Ok(Some(provider)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(AppError::Database(e.to_string())),
        }
    }

    pub fn save_provider(&self, app_type: &str, provider: &Provider) -> Result<(), AppError> {
        self.save_provider_internal(app_type, provider, false)
    }

    /// Only account transactions may create/change a Codex account binding.
    /// Lock order: optional provider switch lock -> account mutation -> DB.
    /// Normal provider writes never acquire the account lock under the DB lock.
    pub(crate) fn save_provider_with_account_pin(
        &self,
        _transaction: &std::sync::MutexGuard<'_, ()>,
        provider: &Provider,
    ) -> Result<(), AppError> {
        self.save_provider_internal("codex", provider, true)
    }

    fn save_provider_internal(
        &self,
        app_type: &str,
        provider: &Provider,
        write_account_pin: bool,
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;

        Self::save_provider_on_connection_internal(&tx, app_type, provider, write_account_pin)?;
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// Reuse the normal provider encoding inside a caller-owned transaction.
    pub(crate) fn save_provider_on_connection(
        tx: &rusqlite::Connection,
        app_type: &str,
        provider: &Provider,
    ) -> Result<(), AppError> {
        Self::save_provider_on_connection_internal(tx, app_type, provider, false)
    }

    fn save_provider_on_connection_internal(
        tx: &rusqlite::Connection,
        app_type: &str,
        provider: &Provider,
        write_account_pin: bool,
    ) -> Result<(), AppError> {
        let mut meta_clone = provider.meta.clone().unwrap_or_default();
        let endpoints = std::mem::take(&mut meta_clone.custom_endpoints);

        let existing: Option<(bool, bool, Option<String>)> = tx
            .query_row(
                "SELECT is_current, in_failover_queue, meta FROM providers WHERE id = ?1 AND app_type = ?2",
                params![provider.id, app_type],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| AppError::Database(e.to_string()))?;

        let is_update = existing.is_some();
        let (is_current, in_failover_queue, stored_meta) =
            existing.unwrap_or((false, provider.in_failover_queue, None));

        if app_type == "codex" && !write_account_pin {
            // Read at commit time, not from a renderer/backfill/rollback snapshot.
            // Inserts cannot import a machine-local binding; changing category
            // away from official detaches it so account deletion cannot miss it.
            meta_clone.official_account = if provider.category.as_deref() == Some("official") {
                stored_meta
                    .as_deref()
                    .map(serde_json::from_str::<ProviderMeta>)
                    .transpose()
                    .map_err(|e| AppError::Database(format!("invalid provider meta: {e}")))?
                    .and_then(|meta| meta.official_account)
            } else {
                None
            };
        }

        if is_update {
            tx.execute(
                "UPDATE providers SET
                    name = ?1,
                    settings_config = ?2,
                    website_url = ?3,
                    category = ?4,
                    created_at = ?5,
                    sort_index = ?6,
                    notes = ?7,
                    icon = ?8,
                    icon_color = ?9,
                    meta = ?10,
                    is_current = ?11,
                    in_failover_queue = ?12
                WHERE id = ?13 AND app_type = ?14",
                params![
                    provider.name,
                    serde_json::to_string(&provider.settings_config).map_err(|e| {
                        AppError::Database(format!("Failed to serialize settings_config: {e}"))
                    })?,
                    provider.website_url,
                    provider.category,
                    provider.created_at,
                    provider.sort_index,
                    provider.notes,
                    provider.icon,
                    provider.icon_color,
                    serde_json::to_string(&meta_clone).map_err(|e| AppError::Database(format!(
                        "Failed to serialize meta: {e}"
                    )))?,
                    is_current,
                    in_failover_queue,
                    provider.id,
                    app_type,
                ],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        } else {
            tx.execute(
                "INSERT INTO providers (
                    id, app_type, name, settings_config, website_url, category,
                    created_at, sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    provider.id,
                    app_type,
                    provider.name,
                    serde_json::to_string(&provider.settings_config)
                        .map_err(|e| AppError::Database(format!("Failed to serialize settings_config: {e}")))?,
                    provider.website_url,
                    provider.category,
                    provider.created_at,
                    provider.sort_index,
                    provider.notes,
                    provider.icon,
                    provider.icon_color,
                    serde_json::to_string(&meta_clone)
                        .map_err(|e| AppError::Database(format!("Failed to serialize meta: {e}")))?,
                    is_current,
                    in_failover_queue,
                ],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

            for (url, endpoint) in endpoints {
                tx.execute(
                    "INSERT INTO provider_endpoints (provider_id, app_type, url, added_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![provider.id, app_type, url, endpoint.added_at],
                )
                .map_err(|e| AppError::Database(e.to_string()))?;
            }
        }

        Ok(())
    }

    /// Snapshot replacement must not import machine-local account bindings.
    /// The caller holds the main DB lock through reconciliation AND replacement;
    /// this needs no account lock and cannot invert provider/account lock order.
    pub(crate) fn preserve_local_account_pins_on_connection(
        local: &rusqlite::Connection,
        staged: &rusqlite::Connection,
    ) -> Result<(), AppError> {
        // A damaged local catalog must not prevent restoring a healthy backup.
        // In that case fail closed on pins: detach, never trust snapshot bindings.
        let local_lines = Self::get_all_providers_on_connection(local, "codex").unwrap_or_default();
        let staged_rows = {
            let mut statement = staged
                .prepare("SELECT id, category, meta FROM providers WHERE app_type = 'codex'")
                .map_err(|e| AppError::Database(e.to_string()))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| AppError::Database(e.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| AppError::Database(e.to_string()))?
        };
        for (id, category, raw_meta) in staged_rows {
            let pin = local_lines
                .get(&id)
                .filter(|line| line.category.as_deref() == Some("official"))
                .and_then(|line| line.meta.as_ref())
                .and_then(|meta| meta.official_account.as_ref());
            // Preserve unrelated and forward-compatible metadata verbatim as JSON.
            let mut meta: serde_json::Value = serde_json::from_str(&raw_meta)
                .map_err(|e| AppError::Database(format!("invalid staged provider meta: {e}")))?;
            let object = meta
                .as_object_mut()
                .ok_or_else(|| AppError::Database("invalid staged provider meta".into()))?;
            object.remove("officialAccount");
            if category.as_deref() == Some("official") {
                if let Some(pin) = pin {
                    object.insert(
                        "officialAccount".into(),
                        serde_json::to_value(pin).map_err(|e| AppError::Database(e.to_string()))?,
                    );
                }
            }
            let encoded =
                serde_json::to_string(&meta).map_err(|e| AppError::Database(e.to_string()))?;
            let changed = staged
                .execute(
                    "UPDATE OR ABORT providers SET meta = ?1 WHERE id = ?2 AND app_type = 'codex'",
                    params![encoded, id],
                )
                .map_err(|e| AppError::Database(e.to_string()))?;
            if changed != 1 {
                return Err(AppError::Database(
                    "Account binding reconciliation failed".into(),
                ));
            }
        }
        Ok(())
    }

    /// Raw removal for additive-mode records and lock-held compensation, which
    /// may intentionally remove a staged current row before restoring its snapshot.
    /// User-facing exclusive-mode deletion must use delete_non_current_provider.
    pub fn delete_provider(&self, app_type: &str, id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM providers WHERE id = ?1 AND app_type = ?2",
            params![id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// Check and remove under one connection lock. The service also holds the
    /// app lock to protect device-local current IDs and Live configuration.
    pub fn delete_non_current_provider(&self, app_type: &str, id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let is_current: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM providers WHERE id = ?1 AND app_type = ?2 AND is_current = 1)",
            params![id, app_type], |row| row.get(0),
        ).map_err(|e| AppError::Database(e.to_string()))?;
        if is_current {
            return Err(AppError::Message(
                "无法删除当前正在使用的供应商".to_string(),
            ));
        }
        let deleted = conn
            .execute(
                "DELETE FROM providers WHERE id = ?1 AND app_type = ?2 AND is_current = 0",
                params![id, app_type],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if deleted == 0 {
            return Err(AppError::Message("供应商不存在或已被删除".to_string()));
        }
        Ok(())
    }

    pub fn set_current_provider(&self, app_type: &str, id: &str) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;

        tx.execute(
            "UPDATE providers SET is_current = 0 WHERE app_type = ?1",
            params![app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        let updated = tx
            .execute(
                "UPDATE providers SET is_current = 1 WHERE id = ?1 AND app_type = ?2",
                params![id, app_type],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        if updated != 1 {
            // Dropping the transaction restores the previous current row.
            return Err(AppError::Message(format!("供应商 {id} 不存在")));
        }

        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// MH-19②: one-time (but safely re-runnable) cleanup for Codex rows that
    /// were already backfilled with OAuth login material before the forward
    /// fix (`scrub_oauth_material_from_non_official_codex_auth`, applied at
    /// backfill time) existed. Idempotent — a clean row is read, found
    /// unchanged, and never written back — so call sites can re-run it after
    /// every import/restore rather than tracking a "have we migrated yet"
    /// flag (R3A-N5).
    ///
    /// Returns the number of rows actually changed, for a log line only —
    /// never which rows or what was in them.
    pub fn scrub_oauth_material_from_non_official_codex_providers(
        &self,
    ) -> Result<usize, AppError> {
        let providers = self.get_all_providers("codex")?;
        let mut scrubbed = 0usize;
        for (id, provider) in providers {
            if provider.category.as_deref() == Some("official") {
                continue;
            }
            let mut settings_config = provider.settings_config;
            let Some(auth) = settings_config.get_mut("auth") else {
                continue;
            };
            if crate::codex_config::scrub_oauth_material_from_non_official_codex_auth(auth) {
                self.update_provider_settings_config("codex", &id, &settings_config)?;
                scrubbed += 1;
            }
        }
        Ok(scrubbed)
    }

    /// CPP-A1①: DB half of the idempotent fix for leftover non-official
    /// provider tables named `"OpenAI"` (the live half runs in
    /// `repair_rejected_codex_settings_at_startup`). Rows whose config does
    /// not parse are left alone; the live write path rejects them anyway.
    /// Returns the number of rows changed.
    pub fn rename_non_official_openai_named_codex_provider_tables(
        &self,
    ) -> Result<usize, AppError> {
        let mut renamed = 0usize;
        for (id, provider) in self.get_all_providers("codex")? {
            let mut settings_config = provider.settings_config;
            let Some(config) = settings_config.get("config").and_then(|v| v.as_str()) else {
                continue;
            };
            let fixed =
                match crate::codex_config::rename_non_official_openai_named_provider_tables(config)
                {
                    Ok(Some(fixed)) => fixed,
                    Ok(None) => continue,
                    Err(e) => {
                        log::warn!("Skipped CPP-A1 rename for unreadable Codex row '{id}': {e}");
                        continue;
                    }
                };
            settings_config["config"] = serde_json::Value::String(fixed);
            self.update_provider_settings_config("codex", &id, &settings_config)?;
            renamed += 1;
        }
        Ok(renamed)
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
                    review.common_config = Some(report);
                }
                Ok(_) => {}
                Err(e) => log::warn!("Skipped MH-13b sanitize for the Codex common config: {e}"),
            }
        }
        Ok(review)
    }

    /// MH-8c 1.7 startup/import repair: rewrite Codex rows whose stored
    /// config.toml still declares a non-`responses` `wire_api` (Codex 0.154+
    /// rejects the whole file), keeping the declared protocol in
    /// `meta.apiFormat`. Idempotent; returns the number of rows changed.
    pub fn normalize_codex_provider_wire_apis(&self) -> Result<usize, AppError> {
        let providers = self.get_all_providers("codex")?;
        let mut changed = 0usize;
        for (_, mut provider) in providers {
            if crate::proxy::providers::normalize_codex_provider_wire_api(&mut provider) {
                self.save_provider("codex", &provider)?;
                changed += 1;
            }
        }
        Ok(changed)
    }
    pub fn update_provider_settings_config(
        &self,
        app_type: &str,
        provider_id: &str,
        settings_config: &serde_json::Value,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE providers SET settings_config = ?1 WHERE id = ?2 AND app_type = ?3",
            params![
                serde_json::to_string(settings_config).map_err(|e| AppError::Database(format!(
                    "Failed to serialize settings_config: {e}"
                )))?,
                provider_id,
                app_type
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// Persist an auto-detected Codex wire protocol only when the provider has
    /// not changed since the request started.
    ///
    /// Detection runs off the request path. Without the compare-before-write, a
    /// late task could overwrite a user's newly selected explicit protocol (or a
    /// newly edited URL/key) for the same provider id. The connection mutex keeps
    /// the read/compare/write sequence atomic relative to all other database
    /// operations in this process.
    pub fn update_provider_meta_api_format_if_unchanged(
        &self,
        app_type: &str,
        expected_provider: &Provider,
        api_format: &str,
    ) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);

        let current: (String, Option<String>, String) = conn
            .query_row(
                "SELECT settings_config, category, meta FROM providers WHERE id = ?1 AND app_type = ?2",
                params![expected_provider.id, app_type],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        let current_settings: serde_json::Value = serde_json::from_str(&current.0)
            .map_err(|e| AppError::Database(format!("invalid provider settings_config: {e}")))?;
        let mut current_meta: ProviderMeta = serde_json::from_str(&current.2)
            .map_err(|e| AppError::Database(format!("invalid provider meta: {e}")))?;

        // An explicit value always wins, including one saved while detection was
        // in flight. Never reinterpret it as an auto-detected result.
        if current_meta.api_format.is_some() {
            return Ok(false);
        }

        let mut expected_meta = expected_provider.meta.clone().unwrap_or_default();
        expected_meta.api_format = None;
        expected_meta.api_format_auto_detected = None;
        expected_meta.custom_endpoints.clear();
        current_meta.api_format = None;
        current_meta.api_format_auto_detected = None;
        current_meta.custom_endpoints.clear();

        let expected_meta_value =
            serde_json::to_value(&expected_meta).map_err(|e| AppError::Database(e.to_string()))?;
        let current_meta_value =
            serde_json::to_value(&current_meta).map_err(|e| AppError::Database(e.to_string()))?;

        if current_settings != expected_provider.settings_config
            || current.1 != expected_provider.category
            || current_meta_value != expected_meta_value
        {
            return Ok(false);
        }

        current_meta.api_format = Some(api_format.to_string());
        current_meta.api_format_auto_detected = Some(true);
        let new_meta =
            serde_json::to_string(&current_meta).map_err(|e| AppError::Database(e.to_string()))?;

        conn.execute(
            "UPDATE providers SET meta = ?1 WHERE id = ?2 AND app_type = ?3",
            params![new_meta, expected_provider.id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(true)
    }

    /// Record the protocol the router detected for one model of an
    /// auto-detected line (`meta.codexModelApiFormats[model] = api_format`).
    ///
    /// Read-modify-write of the single row under the connection lock, so a
    /// concurrent save of unrelated fields is not clobbered. Returns `false`
    /// without writing when the line is no longer auto-detected, the user has
    /// meanwhile mapped the model explicitly, or the value is already there.
    pub fn merge_provider_codex_model_api_format(
        &self,
        app_type: &str,
        provider_id: &str,
        model: &str,
        api_format: &str,
    ) -> Result<bool, AppError> {
        let model = model.trim();
        if model.is_empty() {
            return Ok(false);
        }
        let conn = lock_conn!(self.conn);

        let current_meta_text: String = conn
            .query_row(
                "SELECT meta FROM providers WHERE id = ?1 AND app_type = ?2",
                params![provider_id, app_type],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut meta: ProviderMeta = serde_json::from_str(&current_meta_text)
            .map_err(|e| AppError::Database(format!("invalid provider meta: {e}")))?;

        if meta.api_format_auto_detected != Some(true) {
            return Ok(false);
        }
        if meta.codex_model_api_formats.contains_key(model) {
            return Ok(false);
        }
        meta.codex_model_api_formats
            .insert(model.to_string(), api_format.to_string());

        let new_meta =
            serde_json::to_string(&meta).map_err(|e| AppError::Database(e.to_string()))?;
        conn.execute(
            "UPDATE providers SET meta = ?1 WHERE id = ?2 AND app_type = ?3",
            params![new_meta, provider_id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(true)
    }

    pub fn add_custom_endpoint(
        &self,
        app_type: &str,
        provider_id: &str,
        url: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let added_at = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO provider_endpoints (provider_id, app_type, url, added_at) VALUES (?1, ?2, ?3, ?4)",
            params![provider_id, app_type, url, added_at],
        ).map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn remove_custom_endpoint(
        &self,
        app_type: &str,
        provider_id: &str,
        url: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM provider_endpoints WHERE provider_id = ?1 AND app_type = ?2 AND url = ?3",
            params![provider_id, app_type, url],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn set_omo_provider_current(
        &self,
        app_type: &str,
        provider_id: &str,
        category: &str,
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        tx.execute(
            "UPDATE providers SET is_current = 0 WHERE app_type = ?1 AND category = ?2",
            params![app_type, category],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        // OMO ↔ OMO Slim mutually exclusive: deactivate the opposite category
        let opposite = match category {
            "omo" => Some("omo-slim"),
            "omo-slim" => Some("omo"),
            _ => None,
        };
        if let Some(opp) = opposite {
            tx.execute(
                "UPDATE providers SET is_current = 0 WHERE app_type = ?1 AND category = ?2",
                params![app_type, opp],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        let updated = tx
            .execute(
                "UPDATE providers SET is_current = 1 WHERE id = ?1 AND app_type = ?2 AND category = ?3",
                params![provider_id, app_type, category],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if updated != 1 {
            return Err(AppError::Database(format!(
                "Failed to set {category} provider current: provider '{provider_id}' not found in app '{app_type}'"
            )));
        }
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn is_omo_provider_current(
        &self,
        app_type: &str,
        provider_id: &str,
        category: &str,
    ) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        match conn.query_row(
            "SELECT is_current FROM providers
             WHERE id = ?1 AND app_type = ?2 AND category = ?3",
            params![provider_id, app_type, category],
            |row| row.get(0),
        ) {
            Ok(is_current) => Ok(is_current),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(AppError::Database(e.to_string())),
        }
    }

    pub fn clear_omo_provider_current(
        &self,
        app_type: &str,
        provider_id: &str,
        category: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE providers SET is_current = 0
             WHERE id = ?1 AND app_type = ?2 AND category = ?3",
            params![provider_id, app_type, category],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn get_current_omo_provider(
        &self,
        app_type: &str,
        category: &str,
    ) -> Result<Option<Provider>, AppError> {
        let conn = lock_conn!(self.conn);
        let row_data: Result<OmoProviderRow, rusqlite::Error> = conn.query_row(
            "SELECT id, name, settings_config, category, created_at, sort_index, notes, meta
             FROM providers
             WHERE app_type = ?1 AND category = ?2 AND is_current = 1
             LIMIT 1",
            params![app_type, category],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        );

        let (id, name, settings_config_str, _row_category, created_at, sort_index, notes, meta_str) =
            match row_data {
                Ok(v) => v,
                Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
                Err(e) => return Err(AppError::Database(e.to_string())),
            };

        let settings_config = serde_json::from_str(&settings_config_str).map_err(|e| {
            AppError::Database(format!(
                "Failed to parse {category} provider settings_config (provider_id={id}): {e}"
            ))
        })?;
        let meta: crate::provider::ProviderMeta = if meta_str.trim().is_empty() {
            crate::provider::ProviderMeta::default()
        } else {
            serde_json::from_str(&meta_str).map_err(|e| {
                AppError::Database(format!(
                    "Failed to parse {category} provider meta (provider_id={id}): {e}"
                ))
            })?
        };

        Ok(Some(Provider {
            id,
            name,
            settings_config,
            website_url: None,
            category: Some(category.to_string()),
            created_at,
            sort_index,
            notes,
            meta: Some(meta),
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        }))
    }

    /// 判断 providers 表是否为空（全 app_type 一起算）。
    ///
    /// 用于区分"全新安装"和"升级用户"：在启动流程 import/seed 之前调用。
    /// 使用 `EXISTS` 短路查询，比 `COUNT(*)` 在将来表变大时更高效。
    pub fn is_providers_empty(&self) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let exists: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM providers)", [], |row| {
                row.get(0)
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(!exists)
    }

    /// 仅获取指定 app 下所有 provider 的 id 集合。
    ///
    /// 比 `get_all_providers` 轻量得多：只读 id 列、无 endpoint 子查询。
    /// 用于只需要做存在性检查的场景（如 additive 模式的 live 同步去重）。
    pub fn get_provider_ids(&self, app_type: &str) -> Result<HashSet<String>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare("SELECT id FROM providers WHERE app_type = ?1")
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![app_type], |row| row.get::<_, String>(0))
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut ids = HashSet::new();
        for row in rows {
            ids.insert(row.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(ids)
    }

    /// 判断指定 app 下是否已存在任意 provider。
    ///
    /// 启动阶段的 live import 需要使用这个更严格的判断：
    /// 只要该 app 已经有任何 provider（包括官方 seed），就不应再自动导入 `default`。
    pub fn has_any_provider_for_app(&self, app_type: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM providers WHERE app_type = ?1)",
                params![app_type],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(exists)
    }

    /// 判断指定 app 下是否存在非官方种子的供应商。
    ///
    /// 比 `get_all_providers` 轻量得多：只读 id 列、无 endpoint 子查询、首条命中即返回。
    /// 用于 `import_default_config` 决定是否跳过 live 导入。
    pub fn has_non_official_seed_provider(&self, app_type: &str) -> Result<bool, AppError> {
        use crate::database::dao::providers_seed::is_official_seed_id;
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare("SELECT id FROM providers WHERE app_type = ?1")
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut rows = stmt
            .query(params![app_type])
            .map_err(|e| AppError::Database(e.to_string()))?;
        while let Some(row) = rows.next().map_err(|e| AppError::Database(e.to_string()))? {
            let id: String = row.get(0).map_err(|e| AppError::Database(e.to_string()))?;
            if !is_official_seed_id(&id) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// 计算指定 app 下一个可用的 sort_index（追加到末尾）。
    fn next_sort_index_for_app(&self, app_type: &str) -> Result<usize, AppError> {
        let conn = lock_conn!(self.conn);
        let max: Option<i64> = conn
            .query_row(
                "SELECT MAX(sort_index) FROM providers WHERE app_type = ?1",
                params![app_type],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(max.map(|v| (v + 1) as usize).unwrap_or(0))
    }

    /// 启动时调用：补齐缺失的官方预设供应商（Claude / Codex / Gemini）。
    ///
    /// 使用 settings flag `official_providers_seeded` 保证每个数据库只执行一次：
    /// - 全新用户：seed 三条官方预设
    /// - 老用户升级：同样会触发一次（flag 不存在），追加到末尾，不影响已有排序
    /// - 用户删除 seed 后：不再重建（flag 已为 true），尊重用户意图
    ///
    /// 与 `Database::save_provider` 的 UPSERT 语义配合，即使被意外重复调用
    /// 也不会覆盖用户当前激活的供应商（is_current 字段会被保留）。
    pub fn init_default_official_providers(&self) -> Result<usize, AppError> {
        use crate::database::dao::providers_seed::OFFICIAL_SEEDS;

        if self
            .get_bool_flag("official_providers_seeded")
            .unwrap_or(false)
        {
            return Ok(0);
        }

        let mut inserted = 0_usize;
        let now_ms = chrono::Utc::now().timestamp_millis();

        for seed in OFFICIAL_SEEDS {
            let app_type_str = seed.app_type.as_str();

            // 若该 id 已存在（极端情况：用户曾手动用过同 id），跳过
            if self.get_provider_by_id(seed.id, app_type_str)?.is_some() {
                continue;
            }

            let next_sort_index = self.next_sort_index_for_app(app_type_str)?;

            let settings_config: serde_json::Value =
                serde_json::from_str(seed.settings_config_json).map_err(|e| {
                    AppError::Database(format!("Seed JSON parse failed for {}: {e}", seed.id))
                })?;

            let mut provider = Provider::with_id(
                seed.id.to_string(),
                seed.name.to_string(),
                settings_config,
                Some(seed.website_url.to_string()),
            );
            provider.category = Some("official".to_string());
            provider.icon = Some(seed.icon.to_string());
            provider.icon_color = Some(seed.icon_color.to_string());
            provider.sort_index = Some(next_sort_index);
            provider.created_at = Some(now_ms);

            self.save_provider(app_type_str, &provider)?;
            inserted += 1;
            log::info!(
                "✓ Seeded official provider: {} ({})",
                seed.name,
                app_type_str
            );
        }

        // 即使 inserted=0（例如用户手动创建过同 id）也设置 flag 防止反复检查
        self.set_setting("official_providers_seeded", "true")?;

        Ok(inserted)
    }

    /// 按 id 兜底插入单条 official seed（仅当目标表中该 id 不存在时插入）。
    ///
    /// 与 `init_default_official_providers` 不同：
    /// - 不触碰 `official_providers_seeded` 全局 flag，是 on-demand 修复
    /// - 只处理一条 seed，由调用方决定 id + app_type
    /// - 已存在则尊重用户自定义，不覆盖
    ///
    /// 返回 Ok(true) 表示插入了新行，Ok(false) 表示已存在被跳过。
    pub fn ensure_official_seed_by_id(
        &self,
        seed_id: &str,
        app_type: crate::app_config::AppType,
    ) -> Result<bool, AppError> {
        use crate::database::dao::providers_seed::OFFICIAL_SEEDS;

        let seed = OFFICIAL_SEEDS
            .iter()
            .find(|s| s.id == seed_id && s.app_type == app_type)
            .ok_or_else(|| {
                AppError::Database(format!(
                    "unknown official seed: id={seed_id}, app_type={}",
                    app_type.as_str()
                ))
            })?;

        let app_type_str = seed.app_type.as_str();

        if self.get_provider_by_id(seed_id, app_type_str)?.is_some() {
            return Ok(false);
        }

        let settings_config: serde_json::Value = serde_json::from_str(seed.settings_config_json)
            .map_err(|e| {
                AppError::Database(format!("Seed JSON parse failed for {}: {e}", seed.id))
            })?;

        let next_sort_index = self.next_sort_index_for_app(app_type_str)?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        let mut provider = Provider::with_id(
            seed.id.to_string(),
            seed.name.to_string(),
            settings_config,
            Some(seed.website_url.to_string()),
        );
        provider.category = Some("official".to_string());
        provider.icon = Some(seed.icon.to_string());
        provider.icon_color = Some(seed.icon_color.to_string());
        provider.sort_index = Some(next_sort_index);
        provider.created_at = Some(now_ms);

        self.save_provider(app_type_str, &provider)?;

        Ok(true)
    }
}

#[cfg(test)]
mod ensure_official_seed_tests {
    use crate::app_config::AppType;
    use crate::database::{
        Database, CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID, GROKBUILD_OFFICIAL_PROVIDER_ID,
    };
    use crate::provider::{Provider, ProviderMeta};
    use serde_json::json;

    #[test]
    fn guarded_delete_and_missing_switch_preserve_current() {
        let db = Database::memory().unwrap();
        for id in ["a", "b"] {
            db.save_provider(
                "codex",
                &Provider::with_id(id.into(), id.into(), json!({}), None),
            )
            .unwrap();
        }
        db.save_provider(
            "claude",
            &Provider::with_id("b".into(), "other-tool".into(), json!({}), None),
        )
        .unwrap();
        db.set_current_provider("codex", "a").unwrap();
        assert!(db.delete_non_current_provider("codex", "a").is_err());
        db.delete_non_current_provider("codex", "b").unwrap();
        assert!(db.set_current_provider("codex", "b").is_err());
        assert_eq!(
            db.get_current_provider("codex").unwrap().as_deref(),
            Some("a")
        );
        assert!(db.get_provider_by_id("a", "codex").unwrap().is_some());
        assert!(db.get_provider_by_id("b", "codex").unwrap().is_none());
        assert!(db.delete_non_current_provider("codex", "b").is_err());
        assert!(db.get_provider_by_id("b", "claude").unwrap().is_some());
        // Compensation deliberately retains raw current-row removal semantics.
        db.delete_provider("codex", "a").unwrap();
        assert!(db.get_provider_by_id("a", "codex").unwrap().is_none());
    }

    fn auto_detect_provider() -> Provider {
        Provider::with_id(
            "auto-detect".to_string(),
            "Auto detect".to_string(),
            json!({
                "auth": { "OPENAI_API_KEY": "sk-test" },
                "base_url": "https://one.example/v1"
            }),
            None,
        )
    }

    #[test]
    fn auto_detect_protocol_persists_when_provider_is_unchanged() {
        let db = Database::memory().expect("memory db");
        let provider = auto_detect_provider();
        db.save_provider(AppType::Codex.as_str(), &provider)
            .expect("save provider");

        assert!(db
            .update_provider_meta_api_format_if_unchanged(
                AppType::Codex.as_str(),
                &provider,
                "openai_chat",
            )
            .expect("persist detection"));

        let saved = db
            .get_provider_by_id(&provider.id, AppType::Codex.as_str())
            .expect("read provider")
            .expect("provider exists");
        let saved_meta = saved.meta.expect("saved meta");
        assert_eq!(saved_meta.api_format, Some("openai_chat".to_string()));
        assert_eq!(saved_meta.api_format_auto_detected, Some(true));
    }

    #[test]
    fn stale_detection_cannot_overwrite_edited_provider() {
        let db = Database::memory().expect("memory db");
        let original = auto_detect_provider();
        db.save_provider(AppType::Codex.as_str(), &original)
            .expect("save original");

        let mut edited = original.clone();
        edited.settings_config["base_url"] = json!("https://two.example/v1");
        db.save_provider(AppType::Codex.as_str(), &edited)
            .expect("save edit");

        assert!(!db
            .update_provider_meta_api_format_if_unchanged(
                AppType::Codex.as_str(),
                &original,
                "openai_chat",
            )
            .expect("reject stale detection"));

        let saved = db
            .get_provider_by_id(&original.id, AppType::Codex.as_str())
            .expect("read provider")
            .expect("provider exists");
        assert_eq!(
            saved.settings_config["base_url"],
            json!("https://two.example/v1")
        );
        assert!(saved.meta.and_then(|meta| meta.api_format).is_none());
    }

    #[test]
    fn stale_detection_cannot_override_explicit_protocol() {
        let db = Database::memory().expect("memory db");
        let original = auto_detect_provider();
        db.save_provider(AppType::Codex.as_str(), &original)
            .expect("save original");

        let mut edited = original.clone();
        edited.meta = Some(ProviderMeta {
            api_format: Some("openai_responses".to_string()),
            ..Default::default()
        });
        db.save_provider(AppType::Codex.as_str(), &edited)
            .expect("save explicit protocol");

        assert!(!db
            .update_provider_meta_api_format_if_unchanged(
                AppType::Codex.as_str(),
                &original,
                "openai_chat",
            )
            .expect("reject stale detection"));

        let saved = db
            .get_provider_by_id(&original.id, AppType::Codex.as_str())
            .expect("read provider")
            .expect("provider exists");
        assert_eq!(
            saved.meta.and_then(|meta| meta.api_format),
            Some("openai_responses".to_string())
        );
    }

    #[test]
    fn ensure_inserts_when_missing() {
        let db = Database::memory().expect("memory db");
        let inserted = db
            .ensure_official_seed_by_id(CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID, AppType::ClaudeDesktop)
            .expect("ensure ok");
        assert!(inserted, "should insert when missing");

        let provider = db
            .get_provider_by_id(
                CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID,
                AppType::ClaudeDesktop.as_str(),
            )
            .expect("query ok")
            .expect("provider exists after ensure");

        assert_eq!(provider.id, CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID);
        assert_eq!(provider.name, "Claude Desktop Official");
        assert_eq!(provider.category.as_deref(), Some("official"));
        assert_eq!(provider.icon.as_deref(), Some("anthropic"));
        assert_eq!(provider.icon_color.as_deref(), Some("#D4915D"));
    }

    #[test]
    fn ensure_skips_when_present_and_preserves_customization() {
        let db = Database::memory().expect("memory db");
        db.init_default_official_providers().expect("seed");

        let mut renamed = db
            .get_provider_by_id(
                CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID,
                AppType::ClaudeDesktop.as_str(),
            )
            .expect("query ok")
            .expect("seed present");
        renamed.name = "My Custom Backup".to_string();
        db.save_provider(AppType::ClaudeDesktop.as_str(), &renamed)
            .expect("save customization");

        let inserted = db
            .ensure_official_seed_by_id(CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID, AppType::ClaudeDesktop)
            .expect("ensure ok");
        assert!(!inserted, "should skip when present");

        let after = db
            .get_provider_by_id(
                CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID,
                AppType::ClaudeDesktop.as_str(),
            )
            .expect("query ok")
            .expect("still present");
        assert_eq!(
            after.name, "My Custom Backup",
            "customization must not be overwritten"
        );
    }

    #[test]
    fn ensure_recreates_grokbuild_official_seed_after_deletion() {
        let db = Database::memory().expect("memory db");
        db.init_default_official_providers().expect("seed");
        db.delete_provider(AppType::GrokBuild.as_str(), GROKBUILD_OFFICIAL_PROVIDER_ID)
            .expect("delete Grok Build official");

        let inserted = db
            .ensure_official_seed_by_id(GROKBUILD_OFFICIAL_PROVIDER_ID, AppType::GrokBuild)
            .expect("ensure Grok Build official");
        assert!(inserted);
        let provider = db
            .get_provider_by_id(GROKBUILD_OFFICIAL_PROVIDER_ID, AppType::GrokBuild.as_str())
            .expect("query")
            .expect("Grok Build official restored");
        assert_eq!(provider.category.as_deref(), Some("official"));
        // 空 config：切换时不注入自定义模型表，Grok CLI 回落到自带 OAuth 登录
        assert_eq!(provider.settings_config["config"], serde_json::json!(""));
    }

    #[test]
    fn ensure_rejects_unknown_seed() {
        let db = Database::memory().expect("memory db");
        let result = db.ensure_official_seed_by_id("nonexistent-id", AppType::ClaudeDesktop);
        assert!(result.is_err(), "unknown seed id should be Err");
    }

    #[test]
    fn ensure_rejects_seed_app_type_mismatch() {
        let db = Database::memory().expect("memory db");
        let result =
            db.ensure_official_seed_by_id(CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID, AppType::Claude);
        assert!(result.is_err(), "(id, app_type) mismatch should be Err");
    }
}
