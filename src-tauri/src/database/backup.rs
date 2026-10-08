//! 数据库备份和恢复
//!
//! 提供 SQL 导出/导入和二进制快照备份功能。

use super::{lock_conn, Database};
use crate::config::get_app_config_dir;
use crate::error::AppError;
use chrono::{Local, Utc};
use rusqlite::backup::Backup;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tempfile::NamedTempFile;

const CC_SWITCH_SQL_EXPORT_HEADER: &str = "-- CC Switch SQLite 导出";

/// File-name prefix of the snapshots `backup_database_file` generates.
const DB_BACKUP_PREFIX: &str = "db_backup_";

/// Accept one literal backup filename, never a path or a Windows stream name.
/// Do not require generated prefixes or restrict historical names to ASCII.
fn validate_backup_filename(filename: &str) -> Result<(), AppError> {
    let mut components = Path::new(filename).components();
    let single_name =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if !single_name || !filename.ends_with(".db") || filename.contains(['/', '\\', ':', '\0']) {
        return Err(AppError::InvalidInput(
            "Invalid backup filename".to_string(),
        ));
    }

    // Windows resolves device names even with an extension. Keep Unix-only
    // historical filenames usable on Unix, where these names are ordinary files.
    if cfg!(windows) {
        let stem = filename.split('.').next().unwrap_or_default();
        let stem = stem.trim_end_matches(' ').to_ascii_uppercase();
        let device = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(*prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
        if device
            || filename
                .chars()
                .any(|c| c < ' ' || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
        {
            return Err(AppError::InvalidInput(
                "Invalid backup filename".to_string(),
            ));
        }
    }
    Ok(())
}

/// File-name prefix of the one-time backup taken before the v17 migration.
/// It is the 2.8.0 → 2.7.x downgrade path, so it never takes part in
/// rotation (`is_rotated_db_backup` only matches [`DB_BACKUP_PREFIX`]).
pub(crate) const PRE_V17_BACKUP_PREFIX: &str = "pre_v17_";

/// Device-local tables whose rows never leave the device in a SQL export
/// (plan M3.5 data classification): the takeover Live backup (full Codex
/// `auth.json`, MH-17) and the prompt template cache.
const EXPORT_SKIP_TABLES: &[&str] = &["proxy_live_backup", "prompt_template_cache"];

/// `settings` rows that describe this device's live files (projection
/// ledgers) and are dropped from every export.
const EXPORT_SKIP_SETTINGS: &[&str] = &[crate::mcp::CODEX_MCP_PROJECTION_LEDGER_KEY];

/// MCP spec objects whose values are credentials in practice; every value is
/// blanked on export (key names stay, so the user knows what to refill).
const MCP_SECRET_MAPS: &[&str] = &["env", "headers", "http_headers"];

/// MH-17: the database and its `.db` snapshots hold provider credentials,
/// yet files created by older releases (or under the default umask) are
/// typically 0644 inside 0755 directories. Tighten the database file, its
/// directory, `backups/` and every regular `*.db` file in it to owner-only.
/// Runs at startup and after each backup. Best effort: a failure is logged
/// and never blocks startup or a backup. Symlinks are skipped, because
/// `set_permissions` would change the link target instead.
#[cfg(unix)]
pub(crate) fn restrict_db_storage_permissions(db_path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    fn restrict(path: &Path, mode: u32, expect_dir: bool) {
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return;
        };
        let kind_matches = if expect_dir {
            metadata.is_dir()
        } else {
            metadata.is_file()
        };
        if !kind_matches || metadata.permissions().mode() & 0o777 == mode {
            return;
        }
        if let Err(e) = fs::set_permissions(path, fs::Permissions::from_mode(mode)) {
            log::warn!("收紧权限失败 {}: {e}", path.display());
        }
    }

    restrict(db_path, 0o600, false);
    let Some(dir) = db_path.parent() else {
        return;
    };
    restrict(dir, 0o700, true);
    let backup_dir = dir.join("backups");
    restrict(&backup_dir, 0o700, true);
    if let Ok(entries) = fs::read_dir(&backup_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "db") {
                restrict(&path, 0o600, false);
            }
        }
    }
}

/// `dump_sql` 会写出的 PRAGMA。其余 PRAGMA 一律拒绝——`temp_store_directory`
/// 能把临时文件重定向到任意目录，`writable_schema` 能绕过 schema 完整性检查。
const IMPORT_ALLOWED_PRAGMAS: &[&str] = &["foreign_keys", "user_version"];

/// External SQL must stay inside the staging database and must not install
/// temporary or executable schema objects. Temporary tables can shadow main
/// tables during validation; triggers and views would survive SQLite Backup
/// and run later during local-data restoration or OAuth redaction, after this
/// authorizer has been removed. The application schema needs neither.
/// SQLite's parsed actions also cover ATTACH/VACUUM and virtual-table modules;
/// string matching SQL keywords is not a security boundary.
fn import_authorizer(context: rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization {
    use rusqlite::hooks::{AuthAction, Authorization};

    let unsafe_action = match context.action {
        AuthAction::Attach { .. } | AuthAction::Detach { .. } => true,
        AuthAction::CreateVtable { .. } | AuthAction::DropVtable { .. } => true,
        AuthAction::CreateTempTable { .. }
        | AuthAction::CreateTempIndex { .. }
        | AuthAction::CreateTrigger { .. }
        | AuthAction::CreateTempTrigger { .. }
        | AuthAction::CreateView { .. }
        | AuthAction::CreateTempView { .. } => true,
        AuthAction::Unknown { .. } => true,
        AuthAction::Pragma { pragma_name, .. } => !IMPORT_ALLOWED_PRAGMAS
            .iter()
            .any(|allowed| pragma_name.eq_ignore_ascii_case(allowed)),
        _ => false,
    };

    if unsafe_action {
        // SQLite 只会回一句 "not authorized"，不记日志就无从知道是哪条语句被拦。
        log::warn!("SQL 导入拒绝了越界语句: {:?}", context.action);
        Authorization::Deny
    } else {
        Authorization::Allow
    }
}

/// Quote a SQLite identifier (table or column name) for safe interpolation
/// into SQL text, doubling any embedded `"` per the SQL standard so the
/// identifier cannot terminate the quoted form early and splice arbitrary
/// SQL into the surrounding statement.
///
/// Every table/column name reaching this today comes from our own schema
/// (`sqlite_master`, `PRAGMA table_info`) or fixed constants, never
/// directly from external input — but `dump_sql`'s output is meant to be a
/// faithful, always-valid round trip of whatever schema is on disk, so an
/// identifier that happens to contain `"` must still produce syntactically
/// correct SQL instead of a corrupt export.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Blank the values of an MCP spec's credential maps (`env`, headers).
/// Returns how many values were blanked.
pub(crate) fn redact_mcp_spec_secrets(spec: &mut serde_json::Value) -> usize {
    let mut blanked = 0;
    for key in MCP_SECRET_MAPS {
        let Some(map) = spec
            .get_mut(*key)
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        for value in map.values_mut() {
            if value.as_str() != Some("") {
                *value = serde_json::Value::String(String::new());
                blanked += 1;
            }
        }
    }
    blanked
}

/// Tables whose data rows are skipped when exporting for WebDAV sync.
const SYNC_SKIP_TABLES: &[&str] = &[
    "proxy_request_logs",
    "stream_check_logs",
    "provider_health",
    "proxy_live_backup",
    "prompt_template_cache",
    "usage_daily_rollups",
    "usage_rollup_dedup",
    "session_log_sync",
];

/// Tables whose local data is preserved (restored from local snapshot) during WebDAV import.
/// Excludes ephemeral tables like provider_health that can safely rebuild at runtime.
const SYNC_PRESERVE_TABLES: &[&str] = &[
    "proxy_request_logs",
    "stream_check_logs",
    "proxy_live_backup",
    "usage_daily_rollups",
    "usage_rollup_dedup",
    "session_log_sync",
];

/// A database backup entry for the UI
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub filename: String,
    pub size_bytes: u64,
    pub created_at: String, // ISO 8601
}

impl Database {
    /// 导出为 SQLite 兼容的 SQL 文本（内存字符串，完整导出）
    ///
    /// MH-17: redacted by default — same as the sync export below — because
    /// this text format is explicitly the "take this elsewhere" one (shared,
    /// uploaded, or simply outliving a live session on disk longer than the
    /// state.db file itself). A `.db` file-copy backup is the separate,
    /// same-device, same-account mechanism for an exact local restore, and
    /// keeps provider rows full-fidelity, protected by file permissions
    /// instead (see `Self::backup_database_file`); only the device-local
    /// takeover Live backup is dropped from both.
    pub fn export_sql_string(&self) -> Result<String, AppError> {
        let snapshot = self.snapshot_to_memory()?;
        Self::apply_export_classification(&snapshot)?;
        // The takeover Live backup (full Codex auth.json) never leaves the
        // device, and an import would refuse it anyway (MH-17).
        Self::dump_sql(&snapshot, EXPORT_SKIP_TABLES)
    }

    /// Export SQL for sync (WebDAV), skipping local-only tables' data
    pub fn export_sql_string_for_sync(&self) -> Result<String, AppError> {
        let snapshot = self.snapshot_to_memory()?;
        Self::apply_export_classification(&snapshot)?;
        Self::dump_sql(&snapshot, SYNC_SKIP_TABLES)
    }

    /// Plan M3.5 data classification for everything that leaves the device:
    /// OAuth material stripped by content (MH-17), MCP secrets blanked,
    /// projection ledgers dropped. Table-level skips are the caller's
    /// `dump_sql` list.
    fn apply_export_classification(conn: &Connection) -> Result<(), AppError> {
        Self::redact_codex_provider_auth(conn)?;
        Self::redact_mcp_server_secrets(conn)?;
        for key in EXPORT_SKIP_SETTINGS {
            conn.execute("DELETE FROM main.settings WHERE key = ?1", [*key])?;
        }
        Ok(())
    }

    /// Blank every value of the MCP credential maps in each server spec.
    /// Same boundary rules as [`Self::redact_codex_provider_auth`]: parse and
    /// reserialize every row, abort on anything that cannot be rewritten.
    fn redact_mcp_server_secrets(conn: &Connection) -> Result<(), AppError> {
        Self::validate_backup_schema(conn)?;
        let rows = {
            let mut stmt = conn.prepare("SELECT id, server_config FROM main.mcp_servers")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (id, raw) in rows {
            let mut spec: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
                AppError::InvalidInput("MCP 服务器配置不是有效 JSON，无法安全脱敏".into())
            })?;
            redact_mcp_spec_secrets(&mut spec);
            let sanitized = serde_json::to_string(&spec)
                .map_err(|source| AppError::JsonSerialize { source })?;
            let affected = conn.execute(
                "UPDATE OR ABORT main.mcp_servers SET server_config = ?1 WHERE id = ?2",
                rusqlite::params![sanitized, id],
            )?;
            if affected != 1 {
                return Err(AppError::InvalidInput(
                    "MCP 服务器记录不唯一，无法安全脱敏".into(),
                ));
            }
        }
        Ok(())
    }

    /// 导出为 SQLite 兼容的 SQL 文本
    pub fn export_sql(&self, target_path: &Path) -> Result<(), AppError> {
        let dump = self.export_sql_string()?;

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
        }

        crate::config::atomic_write(target_path, dump.as_bytes())
    }

    /// 从 SQL 文件导入，返回生成的备份 ID（若无备份则为空字符串）
    pub fn import_sql(&self, source_path: &Path) -> Result<String, AppError> {
        if !source_path.exists() {
            return Err(AppError::InvalidInput(format!(
                "SQL 文件不存在: {}",
                source_path.display()
            )));
        }

        let sql_raw = fs::read_to_string(source_path).map_err(|e| AppError::io(source_path, e))?;
        let sql_content = sql_raw.trim_start_matches('\u{feff}');
        self.import_sql_string(sql_content)
    }

    /// 从 SQL 字符串导入，返回生成的备份 ID（若无备份则为空字符串）
    pub fn import_sql_string(&self, sql_raw: &str) -> Result<String, AppError> {
        self.import_sql_string_inner(sql_raw, &[])
    }

    /// Import SQL generated for sync, then restore local-only tables from the
    /// current device snapshot before replacing the main database.
    pub(crate) fn import_sql_string_for_sync(&self, sql_raw: &str) -> Result<String, AppError> {
        self.import_sql_string_inner(sql_raw, SYNC_PRESERVE_TABLES)
    }

    fn import_sql_string_inner(
        &self,
        sql_raw: &str,
        preserve_tables: &[&str],
    ) -> Result<String, AppError> {
        let sql_content = sql_raw.trim_start_matches('\u{feff}');
        Self::validate_cc_switch_sql_export(sql_content)?;

        let local_snapshot = if preserve_tables.is_empty() {
            None
        } else {
            Some(self.snapshot_to_memory()?)
        };

        // 在临时数据库执行导入，确保失败不会污染主库
        let temp_file = NamedTempFile::new().map_err(|e| AppError::IoContext {
            context: "创建临时数据库文件失败".to_string(),
            source: e,
        })?;
        let temp_path = temp_file.path().to_path_buf();
        let temp_conn =
            Connection::open(&temp_path).map_err(|e| AppError::Database(e.to_string()))?;

        // authorizer 只覆盖外部 SQL，执行完立刻摘掉：紧随其后的
        // `create_tables_on_conn` / `apply_schema_migrations_on_conn` 是本程序自己的
        // schema 维护语句，不属于需要设防的输入，没必要让它们也过一遍守卫。
        temp_conn.authorizer(Some(import_authorizer));
        let batch_result = temp_conn.execute_batch(sql_content);
        temp_conn.authorizer(
            None::<fn(rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization>,
        );
        batch_result.map_err(|e| AppError::Database(format!("执行 SQL 导入失败: {e}")))?;

        // Reject executable schema before any trusted migration or local-data write.
        Self::validate_backup_schema(&temp_conn)?;
        // 补齐缺失表/索引并进行基础校验
        Self::create_tables_on_conn(&temp_conn)?;
        Self::apply_schema_migrations_on_conn(&temp_conn)?;
        if !preserve_tables.is_empty() {
            Self::redact_codex_provider_auth(&temp_conn)?;
        }
        Self::validate_basic_state(&temp_conn)?;
        if let Some(local_snapshot) = local_snapshot.as_ref() {
            Self::restore_tables(local_snapshot, &temp_conn, preserve_tables)?;
            Self::merge_local_mcp_secrets(local_snapshot, &temp_conn)?;
        }
        // Validate the final staged state for both local and cloud imports.
        // Remote Live backups may have been replaced by local-only tables,
        // but any remaining proxy_config runtime flags must block the commit.
        Self::validate_stopped_proxy_state_on_conn(&temp_conn)?;

        // 只有暂存库通过全部校验之后，才对现有主库做安全备份并提交导入——
        // 与 restore_from_backup 的顺序一致。备份挪到这里（而不是函数开头）
        // 是因为它会占用 cleanup_db_backups 的保留配额：早前在校验之前就
        // 备份，会让多次失败的导入尝试把真正有价值的旧备份顶掉。
        let backup_path = self.backup_database_file()?;

        // 使用 Backup 将临时库原子写回主库
        {
            let mut main_conn = lock_conn!(self.conn);
            Self::preserve_local_account_pins_on_connection(&main_conn, &temp_conn)?;
            let backup = Backup::new(&temp_conn, &mut main_conn)
                .map_err(|e| AppError::Database(e.to_string()))?;
            backup
                .step(-1)
                .map_err(|e| AppError::Database(e.to_string()))?;
        }

        let backup_id = backup_path
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_default();

        Ok(backup_id)
    }

    /// 创建内存快照以避免长时间持有数据库锁
    pub(crate) fn snapshot_to_memory(&self) -> Result<Connection, AppError> {
        let conn = lock_conn!(self.conn);
        Self::snapshot_connection_to_memory(&conn)
    }

    pub(crate) fn snapshot_connection_to_memory(conn: &Connection) -> Result<Connection, AppError> {
        let mut snapshot =
            Connection::open_in_memory().map_err(|e| AppError::Database(e.to_string()))?;

        {
            let backup =
                Backup::new(conn, &mut snapshot).map_err(|e| AppError::Database(e.to_string()))?;
            let result = backup
                .step(-1)
                .map_err(|e| AppError::Database(e.to_string()))?;
            if !matches!(result, rusqlite::backup::StepResult::Done) {
                return Err(AppError::Database(
                    "Database backup did not complete".into(),
                ));
            }
        }

        Ok(snapshot)
    }

    fn validate_cc_switch_sql_export(sql: &str) -> Result<(), AppError> {
        let trimmed = sql.trim_start();
        if trimmed.starts_with(CC_SWITCH_SQL_EXPORT_HEADER) {
            return Ok(());
        }

        Err(AppError::localized(
            "backup.sql.invalid_format",
            "仅支持导入由 CC Switch 导出的 SQL 备份文件。",
            "Only SQL backups exported by CC Switch are supported.",
        ))
    }

    fn restore_tables(
        source_conn: &Connection,
        target_conn: &Connection,
        tables: &[&str],
    ) -> Result<(), AppError> {
        Self::validate_backup_schema(source_conn)?;
        for table in tables {
            if !Self::table_exists(source_conn, table)? {
                return Err(AppError::Database(format!("缺少本机保留表: {table}")));
            }

            // Keep the local schema as well as its rows. Remote UNIQUE conflict
            // policies or foreign-key actions must not silently discard/change
            // local-only data while it is restored.
            let mut schema = source_conn.prepare(
                "SELECT sql FROM sqlite_schema WHERE tbl_name = ?1
                 AND type IN ('table', 'index') AND sql IS NOT NULL
                 ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
            )?;
            let definitions = schema.query_map([table], |row| row.get::<_, String>(0))?;
            target_conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", quote_ident(table)))?;
            for definition in definitions {
                target_conn.execute_batch(&definition?)?;
            }

            let columns = Self::get_table_columns(source_conn, table)?;
            if columns.is_empty() {
                continue;
            }

            let placeholders = (1..=columns.len())
                .map(|idx| format!("?{idx}"))
                .collect::<Vec<_>>()
                .join(", ");
            let cols = columns
                .iter()
                .map(|column| quote_ident(column))
                .collect::<Vec<_>>()
                .join(", ");
            let insert_sql = format!(
                "INSERT INTO {} ({cols}) VALUES ({placeholders})",
                quote_ident(table)
            );

            let mut stmt = source_conn
                .prepare(&format!("SELECT * FROM {}", quote_ident(table)))
                .map_err(|e| AppError::Database(format!("读取表 {table} 失败: {e}")))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| AppError::Database(format!("查询表 {table} 数据失败: {e}")))?;

            while let Some(row) = rows.next().map_err(|e| AppError::Database(e.to_string()))? {
                let mut values = Vec::with_capacity(columns.len());
                for idx in 0..columns.len() {
                    values.push(
                        row.get::<_, rusqlite::types::Value>(idx)
                            .map_err(|e| AppError::Database(e.to_string()))?,
                    );
                }

                target_conn
                    .execute(&insert_sql, rusqlite::params_from_iter(values.iter()))
                    .map_err(|e| AppError::Database(format!("恢复表 {table} 数据失败: {e}")))?;
            }
        }

        Ok(())
    }

    /// When importing from a sync target (where MCP secrets were blanked by
    /// data classification), restore local MCP secrets from the local database
    /// snapshot so existing credentials on this machine are not wiped out.
    fn merge_local_mcp_secrets(
        local_conn: &Connection,
        target_conn: &Connection,
    ) -> Result<(), AppError> {
        if !Self::table_exists(local_conn, "mcp_servers")?
            || !Self::table_exists(target_conn, "mcp_servers")?
        {
            return Ok(());
        }
        let local_secrets = {
            let mut stmt = local_conn.prepare("SELECT id, server_config FROM main.mcp_servers")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<HashMap<String, String>, _>>()?
        };

        let target_rows = {
            let mut stmt = target_conn.prepare("SELECT id, server_config FROM main.mcp_servers")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<(String, String)>, _>>()?
        };

        for (id, target_raw) in target_rows {
            let Some(local_raw) = local_secrets.get(&id) else {
                continue;
            };
            let Ok(mut target_spec) = serde_json::from_str::<serde_json::Value>(&target_raw) else {
                continue;
            };
            let Ok(local_spec) = serde_json::from_str::<serde_json::Value>(local_raw) else {
                continue;
            };

            let mut modified = false;
            for key in MCP_SECRET_MAPS {
                if let (Some(target_map), Some(local_map)) = (
                    target_spec
                        .get_mut(*key)
                        .and_then(serde_json::Value::as_object_mut),
                    local_spec.get(*key).and_then(serde_json::Value::as_object),
                ) {
                    for (k, v) in target_map.iter_mut() {
                        if v.as_str() == Some("") {
                            if let Some(local_val) =
                                local_map.get(k).and_then(serde_json::Value::as_str)
                            {
                                if !local_val.is_empty() {
                                    *v = serde_json::Value::String(local_val.to_string());
                                    modified = true;
                                }
                            }
                        }
                    }
                }
            }

            if modified {
                let updated_raw = serde_json::to_string(&target_spec)
                    .map_err(|source| AppError::JsonSerialize { source })?;
                target_conn.execute(
                    "UPDATE main.mcp_servers SET server_config = ?1 WHERE id = ?2",
                    rusqlite::params![updated_raw, id],
                )?;
            }
        }
        Ok(())
    }

    /// Periodic backup: create a new backup if the latest one is older than the configured interval
    pub(crate) fn periodic_backup_if_needed(&self) -> Result<(), AppError> {
        let interval_hours = crate::settings::effective_backup_interval_hours();
        if interval_hours > 0 {
            let backup_dir = get_app_config_dir().join("backups");
            if !backup_dir.exists() {
                self.backup_database_file()?;
            } else {
                let latest = fs::read_dir(&backup_dir).ok().and_then(|entries| {
                    entries
                        .filter_map(|e| e.ok())
                        .filter(|e| Self::is_rotated_db_backup(&e.path()))
                        .filter_map(|e| e.metadata().ok().and_then(|m| m.modified().ok()))
                        .max()
                });

                let interval_secs = u64::from(interval_hours) * 3600;
                let needs_backup = match latest {
                    None => true,
                    Some(last_modified) => {
                        last_modified.elapsed().unwrap_or_default()
                            > std::time::Duration::from_secs(interval_secs)
                    }
                };

                if needs_backup {
                    log::info!(
                        "Periodic backup: latest backup is older than {interval_hours} hours, creating new backup"
                    );
                    self.backup_database_file()?;
                }
            }
        }

        // Periodic maintenance is always enabled, regardless of auto-backup settings.
        let mut reclaimed_rows = 0u64;
        match self.cleanup_old_stream_check_logs(7) {
            Ok(deleted) => {
                reclaimed_rows += deleted;
            }
            Err(e) => {
                log::warn!("Periodic stream_check_logs cleanup failed: {e}");
            }
        }
        match self.rollup_and_prune(30) {
            Ok(deleted) => {
                reclaimed_rows += deleted;
            }
            Err(e) => {
                log::warn!("Periodic rollup_and_prune failed: {e}");
            }
        }
        if reclaimed_rows > 0 {
            let conn = lock_conn!(self.conn);
            if let Err(e) = conn.execute_batch("PRAGMA incremental_vacuum;") {
                log::warn!("Periodic incremental vacuum failed: {e}");
            }
        }

        Ok(())
    }

    /// 生成一致性快照备份，返回备份文件路径（不存在主库时返回 None）
    pub(crate) fn backup_database_file(&self) -> Result<Option<PathBuf>, AppError> {
        let db_path = get_app_config_dir().join(crate::product_policy::PRODUCT_DATABASE_FILE);
        if !db_path.exists() {
            return Ok(None);
        }
        let snapshot = self.snapshot_to_memory()?;
        Self::backup_database_snapshot(&snapshot)
    }

    /// Persist a caller-owned snapshot without reacquiring the live DB mutex.
    pub(crate) fn backup_database_snapshot(
        snapshot: &Connection,
    ) -> Result<Option<PathBuf>, AppError> {
        let db_path = get_app_config_dir().join(crate::product_policy::PRODUCT_DATABASE_FILE);
        if !db_path.exists() {
            return Ok(None);
        }

        let backup_dir = db_path
            .parent()
            .ok_or_else(|| AppError::Config("无效的数据库路径".to_string()))?
            .join("backups");

        fs::create_dir_all(&backup_dir).map_err(|e| AppError::io(&backup_dir, e))?;

        let backup_path = Self::unique_backup_path(&backup_dir, DB_BACKUP_PREFIX);

        {
            // Stage through an in-memory snapshot so the takeover Live backup
            // (MH-17) is dropped before any page reaches the backup file.
            Self::strip_proxy_live_backup(snapshot)?;
            let mut dest_conn =
                Connection::open(&backup_path).map_err(|e| AppError::Database(e.to_string()))?;
            let backup = Backup::new(snapshot, &mut dest_conn)
                .map_err(|e| AppError::Database(e.to_string()))?;
            let result = backup
                .step(-1)
                .map_err(|e| AppError::Database(e.to_string()))?;
            if !matches!(result, rusqlite::backup::StepResult::Done) {
                return Err(AppError::Database(
                    "Database backup did not complete".into(),
                ));
            }
        }

        #[cfg(unix)]
        restrict_db_storage_permissions(&db_path);
        Self::cleanup_db_backups(&backup_dir)?;
        Ok(Some(backup_path))
    }

    /// `<prefix><timestamp>[_n].db` that does not exist yet in `dir`.
    fn unique_backup_path(dir: &Path, prefix: &str) -> PathBuf {
        let base_id = format!("{prefix}{}", Local::now().format("%Y%m%d_%H%M%S"));
        let mut backup_path = dir.join(format!("{base_id}.db"));
        let mut counter = 1;
        while backup_path.exists() {
            backup_path = dir.join(format!("{base_id}_{counter}.db"));
            counter += 1;
        }
        backup_path
    }

    /// Plan M3.5: the backup taken right before the v17 migration, i.e. a
    /// v16 database 2.7.x can open. Restoring it is the downgrade path. It is
    /// excluded from standard rotation and redacts OAuth material and the
    /// takeover Live backup (copy → redact → VACUUM → atomic rename, so no
    /// page of the finished file ever held them).
    /// Provider API keys and MCP env stay, as in every `.db` backup (a
    /// same-device, full-fidelity restore point).
    pub(crate) fn backup_pre_v17_database_file(&self) -> Result<Option<PathBuf>, AppError> {
        let db_path = get_app_config_dir().join(crate::product_policy::PRODUCT_DATABASE_FILE);
        if !db_path.exists() {
            return Ok(None);
        }
        let backup_dir = db_path
            .parent()
            .ok_or_else(|| AppError::Config("无效的数据库路径".to_string()))?
            .join("backups");
        fs::create_dir_all(&backup_dir).map_err(|e| AppError::io(&backup_dir, e))?;
        let backup_path = Self::unique_backup_path(&backup_dir, PRE_V17_BACKUP_PREFIX);
        self.write_pre_v17_downgrade_backup(&backup_path)?;
        Self::cleanup_pre_v17_backups(&backup_dir, 2);
        #[cfg(unix)]
        restrict_db_storage_permissions(&db_path);
        Ok(Some(backup_path))
    }

    fn cleanup_pre_v17_backups(dir: &Path, retain: usize) {
        let entries = match fs::read_dir(dir) {
            Ok(iter) => iter
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry.file_name().to_str().is_some_and(|name| {
                        name.starts_with(PRE_V17_BACKUP_PREFIX) && name.ends_with(".db")
                    })
                })
                .collect::<Vec<_>>(),
            Err(_) => return,
        };
        if entries.len() <= retain {
            return;
        }
        let remove_count = entries.len().saturating_sub(retain);
        let mut sorted = entries;
        sorted.sort_by_key(|entry| entry.metadata().and_then(|m| m.modified()).ok());
        for entry in sorted.into_iter().take(remove_count) {
            let _ = fs::remove_file(entry.path());
        }
    }

    fn write_pre_v17_downgrade_backup(&self, target: &Path) -> Result<(), AppError> {
        // 1. Copy (in memory, so the live file is only read).
        let snapshot = self.snapshot_to_memory()?;
        // 2. Redact.
        Self::strip_proxy_live_backup(&snapshot)?;
        Self::redact_codex_provider_auth(&snapshot)?;
        // 3. VACUUM into a partial file next to the target (same volume), so
        //    the result has no free pages left from the redaction.
        let mut partial_name = target.as_os_str().to_owned();
        partial_name.push(".partial");
        let partial = PathBuf::from(partial_name);
        match fs::remove_file(&partial) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(AppError::io(&partial, error)),
        }
        let result = (|| -> Result<(), AppError> {
            let partial_str = partial
                .to_str()
                .ok_or_else(|| AppError::Config("备份路径不是有效的 UTF-8".to_string()))?;
            snapshot
                .execute("VACUUM main INTO ?1", [partial_str])
                .map_err(|e| AppError::Database(format!("写入迁移前备份失败: {e}")))?;
            // 4. Atomic rename into place.
            fs::rename(&partial, target).map_err(|e| AppError::io(target, e))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&partial);
        }
        result
    }

    /// `proxy_live_backup` holds the whole pre-takeover Live state — for
    /// Codex that is the full `auth.json`, OAuth tokens included (MH-17,
    /// R3A-N7). It is device-local runtime state: every restore/import
    /// already refuses a snapshot that still carries it
    /// (`validate_stopped_proxy_state_on_conn`), so neither a local export
    /// nor a `.db` backup gains anything by keeping it. `secure_delete`
    /// zeroes the freed pages, so a page-level copy of this connection (the
    /// SQLite Backup API) cannot carry the deleted content along.
    fn strip_proxy_live_backup(conn: &Connection) -> Result<(), AppError> {
        // Never run an unexpected trigger while rewriting the snapshot.
        Self::validate_backup_schema(conn)?;
        conn.execute_batch("PRAGMA secure_delete = ON; DELETE FROM main.proxy_live_backup;")
            .map_err(|e| AppError::Database(format!("清理 Live 备份失败: {e}")))
    }

    /// Only files `backup_database_file` itself generated take part in
    /// rotation. A backup the user renamed, or any other `.db` placed in
    /// `backups/`, is never auto-deleted (MH-8e).
    fn is_rotated_db_backup(path: &Path) -> bool {
        path.extension().is_some_and(|ext| ext == "db")
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(DB_BACKUP_PREFIX))
    }

    /// 清理旧的数据库备份，保留最新的 N 个
    fn cleanup_db_backups(dir: &Path) -> Result<(), AppError> {
        let retain = crate::settings::effective_backup_retain_count();
        let entries = match fs::read_dir(dir) {
            Ok(iter) => iter
                .filter_map(|entry| entry.ok())
                .filter(|entry| Self::is_rotated_db_backup(&entry.path()))
                .collect::<Vec<_>>(),
            Err(_) => return Ok(()),
        };

        if entries.len() <= retain {
            return Ok(());
        }

        let remove_count = entries.len().saturating_sub(retain);
        let mut sorted = entries;
        sorted.sort_by_key(|entry| entry.metadata().and_then(|m| m.modified()).ok());

        for entry in sorted.into_iter().take(remove_count) {
            if let Err(err) = fs::remove_file(entry.path()) {
                log::warn!("删除旧数据库备份失败 {}: {}", entry.path().display(), err);
            }
        }
        Ok(())
    }

    /// 基础状态校验
    fn validate_basic_state(conn: &Connection) -> Result<(), AppError> {
        let provider_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM providers", [], |row| row.get(0))
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mcp_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM mcp_servers", [], |row| row.get(0))
            .map_err(|e| AppError::Database(e.to_string()))?;

        if provider_count == 0 && mcp_count == 0 {
            return Err(AppError::Config(
                "导入的 SQL 未包含有效的供应商或 MCP 数据".to_string(),
            ));
        }
        Ok(())
    }

    /// 导出数据库为 SQL 文本
    fn dump_sql(conn: &Connection, skip_tables: &[&str]) -> Result<String, AppError> {
        let mut output = String::new();
        let timestamp = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let user_version: i64 = conn
            .query_row("PRAGMA user_version;", [], |row| row.get(0))
            .unwrap_or(0);

        output.push_str(&format!(
            "-- CC Switch SQLite 导出\n-- 生成时间: {timestamp}\n-- user_version: {user_version}\n"
        ));
        output.push_str("PRAGMA foreign_keys=OFF;\n");
        output.push_str(&format!("PRAGMA user_version={user_version};\n"));
        output.push_str("BEGIN TRANSACTION;\n");

        // 导出 schema
        let mut stmt = conn
            .prepare(
                "SELECT type, name, tbl_name, sql
                 FROM sqlite_master
                 WHERE sql NOT NULL AND type IN ('table','index','trigger','view')
                 ORDER BY type='table' DESC, name",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut tables = Vec::new();
        let mut rows = stmt
            .query([])
            .map_err(|e| AppError::Database(e.to_string()))?;
        while let Some(row) = rows.next().map_err(|e| AppError::Database(e.to_string()))? {
            let obj_type: String = row.get(0).map_err(|e| AppError::Database(e.to_string()))?;
            let name: String = row.get(1).map_err(|e| AppError::Database(e.to_string()))?;
            let sql: String = row.get(3).map_err(|e| AppError::Database(e.to_string()))?;

            // 跳过 SQLite 内部对象（如 sqlite_sequence）
            if name.starts_with("sqlite_") {
                continue;
            }

            output.push_str(&sql);
            output.push_str(";\n");

            if obj_type == "table" && !name.starts_with("sqlite_") {
                tables.push(name);
            }
        }

        // 导出数据
        for table in tables {
            if skip_tables.iter().any(|t| *t == table) {
                continue;
            }
            let columns = Self::get_table_columns(conn, &table)?;
            if columns.is_empty() {
                continue;
            }

            let mut stmt = conn
                .prepare(&format!("SELECT * FROM {}", quote_ident(&table)))
                .map_err(|e| AppError::Database(e.to_string()))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| AppError::Database(e.to_string()))?;

            while let Some(row) = rows.next().map_err(|e| AppError::Database(e.to_string()))? {
                let mut values = Vec::with_capacity(columns.len());
                for idx in 0..columns.len() {
                    let value = row
                        .get_ref(idx)
                        .map_err(|e| AppError::Database(e.to_string()))?;
                    values.push(Self::format_sql_value(value)?);
                }

                let cols = columns
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ");
                output.push_str(&format!(
                    "INSERT INTO {} ({cols}) VALUES ({});\n",
                    quote_ident(&table),
                    values.join(", ")
                ));
            }
        }

        output.push_str("COMMIT;\nPRAGMA foreign_keys=ON;\n");
        Ok(output)
    }

    /// Application backups contain main tables and indexes only. Check binary backups
    /// and existing local databases as well as newly parsed SQL, before executing
    /// any write that could invoke an imported schema object.
    fn validate_backup_schema(conn: &Connection) -> Result<(), AppError> {
        let has_unsupported_schema: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM main.sqlite_schema WHERE type IN ('trigger', 'view'))
             OR EXISTS(SELECT 1 FROM temp.sqlite_schema)
             OR EXISTS(SELECT 1 FROM pragma_table_list() WHERE type IN ('virtual', 'shadow'))",
            [],
            |row| row.get(0),
        )?;
        if has_unsupported_schema {
            return Err(AppError::InvalidInput(
                "数据库包含不受支持的临时对象、触发器、视图或虚拟表，无法安全导入或同步".into(),
            ));
        }
        Ok(())
    }

    /// Remove OAuth login material from every Codex provider row in a
    /// snapshot — content-based (MH-17), not category-based: the official
    /// row's *entire* `auth` is reset (it exists only to track a live OAuth
    /// session; nothing in it should ever leave the device), while a
    /// non-official row is scrubbed with the same
    /// [`crate::codex_config::scrub_oauth_material_from_non_official_codex_auth`]
    /// used at backfill time (MH-19) — never wiped wholesale, since its own
    /// `OPENAI_API_KEY`/env credential is exactly what a provider export or
    /// sync exists to carry across devices. Non-Codex rows (whose `auth`/
    /// `env` shapes are unrelated to this) are left alone.
    ///
    /// Provider backfill intentionally keeps live runtime state, so this
    /// boundary — every export and sync snapshot — is where OAuth material
    /// must stop, regardless of which category or app_type row it drifted
    /// into.
    fn redact_codex_provider_auth(conn: &Connection) -> Result<(), AppError> {
        // Also protect devices that imported an unsafe snapshot with an older release.
        Self::validate_backup_schema(conn)?;
        let providers = {
            let mut stmt = conn.prepare(
                "SELECT id, app_type, category, settings_config FROM main.providers WHERE app_type = 'codex'",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut changed = 0;
        for (id, app_type, category, raw) in providers {
            // Parse and reserialize even unchanged objects: SQLite json_set only
            // replaces the first duplicate auth key and could export later tokens.
            let mut settings: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
                AppError::InvalidInput("Codex 供应商配置不是有效 JSON，无法安全脱敏".into())
            })?;
            let object = settings.as_object_mut().ok_or_else(|| {
                AppError::InvalidInput("Codex 供应商配置不是 JSON 对象，无法安全脱敏".into())
            })?;
            let is_official = category.as_deref() == Some("official");
            if is_official {
                object.insert("auth".into(), serde_json::json!({}));
            } else if let Some(auth) = object.get_mut("auth") {
                crate::codex_config::scrub_oauth_material_from_non_official_codex_auth(auth);
            }
            // Always reserialize and write back every selected row, even one
            // where nothing above changed — matching the prior behavior this
            // replaces exactly: the JSON round-trip through serde_json is
            // itself a canonicalization (collapses duplicate keys a crafted
            // import could use to hide a secret past a narrower check).
            let sanitized = serde_json::to_string(&settings)
                .map_err(|source| AppError::JsonSerialize { source })?;
            // Override imported IGNORE/REPLACE policies: a conflict must abort
            // export, never leave a token behind or discard another provider.
            let affected = conn.execute(
                "UPDATE OR ABORT main.providers SET settings_config = ?1 WHERE id = ?2 AND app_type = ?3",
                rusqlite::params![sanitized, id, app_type],
            )?;
            if affected != 1 {
                return Err(AppError::InvalidInput(
                    "Codex 供应商记录不唯一，无法安全脱敏".into(),
                ));
            }
            changed += affected;
        }
        if changed > 0 {
            log::debug!("Redacted OAuth material from {changed} Codex provider row(s)");
        }

        Ok(())
    }

    /// 获取表的列名列表
    fn get_table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, AppError> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({})", quote_ident(table)))
            .map_err(|e| AppError::Database(e.to_string()))?;
        let iter = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut columns = Vec::new();
        for col in iter {
            columns.push(col.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(columns)
    }

    /// 格式化 SQL 值
    fn format_sql_value(value: ValueRef<'_>) -> Result<String, AppError> {
        match value {
            ValueRef::Null => Ok("NULL".to_string()),
            ValueRef::Integer(i) => Ok(i.to_string()),
            // `inf`/`-inf`/`NaN` are valid f64 bit patterns SQLite happily
            // stores, but `f.to_string()` renders them as the literal words
            // "inf"/"NaN", which are not valid SQL numeric literals and
            // would make the exported dump fail to re-import. SQLite itself
            // has no non-finite REAL representation, so NULL is the closest
            // faithful downgrade.
            ValueRef::Real(f) => Ok(if f.is_finite() {
                f.to_string()
            } else {
                "NULL".to_string()
            }),
            ValueRef::Text(t) => {
                let text = std::str::from_utf8(t)
                    .map_err(|e| AppError::Database(format!("文本字段不是有效的 UTF-8: {e}")))?;
                let escaped = text.replace('\'', "''");
                Ok(format!("'{escaped}'"))
            }
            ValueRef::Blob(bytes) => {
                let mut s = String::from("X'");
                for b in bytes {
                    use std::fmt::Write;
                    let _ = write!(&mut s, "{b:02X}");
                }
                s.push('\'');
                Ok(s)
            }
        }
    }

    /// List all database backup files, sorted by creation time (newest first)
    pub fn list_backups() -> Result<Vec<BackupEntry>, AppError> {
        let backup_dir = get_app_config_dir().join("backups");
        if !backup_dir.exists() {
            return Ok(vec![]);
        }

        let mut entries: Vec<BackupEntry> = fs::read_dir(&backup_dir)
            .map_err(|e| AppError::io(&backup_dir, e))?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|ext| ext == "db").unwrap_or(false))
            .filter_map(|e| {
                let metadata = e.metadata().ok()?;
                let filename = e.file_name().to_string_lossy().to_string();
                let size_bytes = metadata.len();
                let created_at = metadata
                    .modified()
                    .ok()
                    .map(|t| {
                        let dt: chrono::DateTime<Utc> = t.into();
                        dt.to_rfc3339()
                    })
                    .unwrap_or_default();
                Some(BackupEntry {
                    filename,
                    size_bytes,
                    created_at,
                })
            })
            .collect();

        // Sort by created_at descending (newest first)
        entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(entries)
    }

    /// Whole-DB replacement cannot safely replay another proxy runtime's
    /// takeover metadata. Fail closed instead of only updating its Live backup.
    pub(crate) fn validate_stopped_proxy_state(&self) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        Self::validate_stopped_proxy_state_on_conn(&conn)
    }

    fn validate_stopped_proxy_state_on_conn(conn: &Connection) -> Result<(), AppError> {
        let has_runtime_state: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM main.proxy_config WHERE enabled != 0 OR proxy_enabled != 0)
                 OR EXISTS(SELECT 1 FROM main.proxy_live_backup)",
                [],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if has_runtime_state {
            return Err(AppError::Config(
                "数据库包含代理运行/接管状态或 Live 备份，无法安全恢复或同步。请关闭接管并停止代理后创建新备份，再恢复该备份。".into(),
            ));
        }
        Ok(())
    }

    /// Restore database from a backup file. Returns the safety backup ID.
    pub fn restore_from_backup(&self, filename: &str) -> Result<String, AppError> {
        validate_backup_filename(filename)?;

        let backup_dir = get_app_config_dir().join("backups");
        let backup_path = backup_dir.join(filename);
        let metadata = fs::symlink_metadata(&backup_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::InvalidInput(format!("Backup file not found: {filename}"))
            } else {
                AppError::io(&backup_path, error)
            }
        })?;
        if !metadata.file_type().is_file() {
            return Err(AppError::InvalidInput(
                "Backup path is not a regular file".to_string(),
            ));
        }

        // Stage the restore in a separate SQLite file. The source backup is
        // never copied directly into the live connection: migrations, seed
        // writes and validation must all succeed before the main database is
        // touched.
        let staging_file = NamedTempFile::new_in(&backup_dir).map_err(|e| AppError::IoContext {
            context: "创建数据库恢复临时文件失败".to_string(),
            source: e,
        })?;
        // Close the temporary file handle before SQLite opens the path. This is
        // required on Windows, where an open NamedTempFile can otherwise keep
        // the path locked. TempPath still removes the file when it is dropped.
        let staging_path = staging_file.into_temp_path();
        {
            let source_conn =
                Connection::open(&backup_path).map_err(|e| AppError::Database(e.to_string()))?;
            let staging_conn =
                Connection::open(&staging_path).map_err(|e| AppError::Database(e.to_string()))?;
            let mut staging_conn = staging_conn;

            let backup = Backup::new(&source_conn, &mut staging_conn)
                .map_err(|e| AppError::Database(format!("读取数据库备份失败: {e}")))?;
            backup
                .step(-1)
                .map_err(|e| AppError::Database(format!("复制数据库备份失败: {e}")))?;
            drop(backup);

            Self::validate_backup_schema(&staging_conn)?;
            Self::create_tables_on_conn(&staging_conn)?;
            Self::apply_schema_migrations_on_conn(&staging_conn)?;
            Self::ensure_model_pricing_seeded_on_conn(&staging_conn)?;
            Self::validate_basic_state(&staging_conn)?;
            Self::validate_stopped_proxy_state_on_conn(&staging_conn)?;
        }

        // Create a safety snapshot only after the staged database has passed
        // all checks. This avoids consuming a backup slot for malformed input.
        let safety_backup = self.backup_database_file()?;
        let safety_id = safety_backup
            .as_ref()
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_default();

        // Commit the already validated staged database into the live connection.
        // rusqlite's backup API can still fail during the final copy (for
        // example, disk/connection errors), so immediately restore the safety
        // snapshot on that path.
        let commit_result = (|| -> Result<(), AppError> {
            let staged_conn =
                Connection::open(&staging_path).map_err(|e| AppError::Database(e.to_string()))?;
            let mut main_conn = lock_conn!(self.conn);
            Self::preserve_local_account_pins_on_connection(&main_conn, &staged_conn)?;
            let backup = Backup::new(&staged_conn, &mut main_conn)
                .map_err(|e| AppError::Database(format!("提交数据库恢复失败: {e}")))?;
            backup
                .step(-1)
                .map_err(|e| AppError::Database(format!("提交数据库恢复失败: {e}")))?;
            Ok(())
        })();

        if let Err(commit_error) = commit_result {
            if let Some(safety_path) = safety_backup.as_ref() {
                let rollback_result = (|| -> Result<(), AppError> {
                    let safety_conn = Connection::open(safety_path)
                        .map_err(|e| AppError::Database(e.to_string()))?;
                    // Reconcile a private copy, never modify the safety backup.
                    let safety_snapshot = Self::snapshot_connection_to_memory(&safety_conn)?;
                    let mut main_conn = lock_conn!(self.conn);
                    Self::preserve_local_account_pins_on_connection(&main_conn, &safety_snapshot)?;
                    let backup = Backup::new(&safety_snapshot, &mut main_conn)
                        .map_err(|e| AppError::Database(format!("恢复安全备份失败: {e}")))?;
                    backup
                        .step(-1)
                        .map_err(|e| AppError::Database(format!("恢复安全备份失败: {e}")))?;
                    Ok(())
                })();
                if let Err(rollback_error) = rollback_result {
                    return Err(AppError::Database(format!(
                        "数据库恢复失败，且自动回滚失败: {commit_error}; {rollback_error}"
                    )));
                }
            }
            return Err(commit_error);
        }

        log::info!("Database restored from backup: {filename}, safety backup: {safety_id}");
        Ok(safety_id)
    }

    /// Rename a backup file. Returns the new filename.
    pub fn rename_backup(old_filename: &str, new_name: &str) -> Result<String, AppError> {
        validate_backup_filename(old_filename)?;

        // Clean new name
        let trimmed = new_name.trim();
        if trimmed.is_empty() {
            return Err(AppError::InvalidInput(
                "New name cannot be empty".to_string(),
            ));
        }

        // Length limit (without .db suffix)
        let name_part = trimmed.strip_suffix(".db").unwrap_or(trimmed);
        if name_part.len() > 100 {
            return Err(AppError::InvalidInput(
                "Name too long (max 100 characters)".to_string(),
            ));
        }

        let new_filename = format!("{name_part}.db");
        validate_backup_filename(&new_filename)?;

        let backup_dir = get_app_config_dir().join("backups");
        let old_path = backup_dir.join(old_filename);
        let new_path = backup_dir.join(&new_filename);

        if !old_path.exists() {
            return Err(AppError::InvalidInput(format!(
                "Backup file not found: {old_filename}"
            )));
        }

        if new_path.exists() {
            return Err(AppError::InvalidInput(format!(
                "A backup named '{new_filename}' already exists"
            )));
        }

        fs::rename(&old_path, &new_path).map_err(|e| AppError::io(&old_path, e))?;
        log::info!("Renamed backup: {old_filename} -> {new_filename}");
        Ok(new_filename)
    }

    /// Delete a backup file permanently.
    pub fn delete_backup(filename: &str) -> Result<(), AppError> {
        validate_backup_filename(filename)?;

        let backup_path = get_app_config_dir().join("backups").join(filename);
        if !backup_path.exists() {
            return Err(AppError::InvalidInput(format!(
                "Backup file not found: {filename}"
            )));
        }

        fs::remove_file(&backup_path).map_err(|e| AppError::io(&backup_path, e))?;
        log::info!("Deleted backup: {filename}");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_backup_filename, Database};
    use crate::error::AppError;
    use crate::settings::{update_settings, AppSettings};
    use serial_test::serial;

    #[test]
    fn backup_filename_validation_preserves_historical_names() {
        for filename in [
            "db_backup_20260101_000000.db",
            "pre_v17_20260101_000000.db",
            "before-upgrade.db",
            "升级前 备份（手动）.db",
            "backup.v1..v2.db",
            ".hidden.db",
            " leading space.db",
        ] {
            assert!(validate_backup_filename(filename).is_ok(), "{filename:?}");
        }
        // Existing names are not subject to the new-name UI's 100-byte limit.
        assert!(validate_backup_filename(&format!("{}.db", "a".repeat(120))).is_ok());
    }

    #[test]
    fn backup_filename_validation_rejects_paths_and_stream_names() {
        // Pure validation only: no filesystem access or destructive operations.
        for filename in [
            "",
            ".",
            "..",
            "backup.txt",
            "backup.db ",
            "backup.db.",
            "folder/backup.db",
            "folder\\backup.db",
            "/backup.db",
            "C:backup.db",
            "backup:stream.db",
            "backup\0.db",
        ] {
            assert!(validate_backup_filename(filename).is_err(), "{filename:?}");
        }
    }

    #[test]
    fn backup_filename_validation_handles_windows_device_names() {
        for filename in [
            "CON.db",
            "nul.db",
            "AUX.notes.db",
            "COM1.db",
            "LPT9.db",
            "COM¹.db",
            "CON .db",
            "CONIN$.db",
        ] {
            assert_eq!(
                validate_backup_filename(filename).is_err(),
                cfg!(windows),
                "{filename:?}"
            );
        }
        for filename in ["backup?.db", "backup*.db", "backup|copy.db", "backup\n.db"] {
            assert_eq!(
                validate_backup_filename(filename).is_err(),
                cfg!(windows),
                "{filename:?}"
            );
        }
        for filename in ["console.db", "COM10.db", "LPT-backup.db"] {
            assert!(validate_backup_filename(filename).is_ok(), "{filename:?}");
        }
    }

    fn seed_archived_usage(db: &Database, request_id: &str) -> Result<(), AppError> {
        let conn = crate::database::lock_conn!(db.conn);
        conn.execute(
            "INSERT INTO usage_daily_rollups (
                date, app_type, provider_id, model, request_count, success_count,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                total_cost_usd, avg_latency_ms
            ) VALUES ('2026-03-01', 'claude', ?1, 'claude-3', 1, 1, 100, 50, 0, 0, '0.01', 120)",
            [request_id],
        )?;
        conn.execute(
            "INSERT INTO usage_rollup_dedup (
                request_id, date, app_type, provider_id, model, request_model, pricing_model,
                session_id, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, status_code, created_at, data_source
            ) VALUES (?1, '2026-03-01', 'claude', ?1, 'claude-3', '', '', ?1,
                100, 50, 0, 0, 200, 1000, 'proxy')",
            [request_id],
        )?;
        Ok(())
    }

    fn seed_session_cursor(db: &Database, offset: i64) -> Result<(), AppError> {
        let conn = crate::database::lock_conn!(db.conn);
        conn.execute(
            "INSERT INTO session_log_sync (file_path, last_modified, last_line_offset, last_synced_at)
             VALUES ('/shared/session.jsonl', 1000, ?1, 1001)",
            [offset],
        )?;
        Ok(())
    }

    #[test]
    fn sync_export_omits_archived_usage_but_full_backup_keeps_it() -> Result<(), AppError> {
        let db = Database::memory()?;
        seed_archived_usage(&db, "private-archive-session")?;
        seed_session_cursor(&db, 99)?;
        for (sql, expected) in [
            (db.export_sql_string_for_sync()?, 0_i64),
            (db.export_sql_string()?, 1_i64),
        ] {
            let snapshot = rusqlite::Connection::open_in_memory()?;
            snapshot.execute_batch(&sql)?;
            for table in [
                "usage_daily_rollups",
                "usage_rollup_dedup",
                "session_log_sync",
            ] {
                let count: i64 =
                    snapshot.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })?;
                assert_eq!(count, expected, "{table}");
            }
            assert_eq!(sql.contains("private-archive-session"), expected == 1);
        }
        Ok(())
    }

    #[test]
    fn local_sql_import_rejects_runtime_flags_without_changing_main_db() -> Result<(), AppError> {
        let source = Database::memory()?;
        let target = Database::memory()?;
        {
            let conn = crate::database::lock_conn!(source.conn);
            conn.execute_batch(
                "INSERT INTO providers (id, app_type, name, settings_config, meta)
                 VALUES ('source-provider', 'codex', 'Source', '{}', '{}');
                 UPDATE proxy_config SET enabled = 1 WHERE app_type = 'codex'",
            )?;
        }
        let before = target
            .export_sql_string()?
            .lines()
            .filter(|line| !line.starts_with("-- 生成时间:"))
            .collect::<Vec<_>>()
            .join("\n");
        let sql = source.export_sql_string()?;
        let error = target.import_sql_string(&sql).unwrap_err();
        assert!(
            error.to_string().contains("数据库包含代理运行/接管状态"),
            "{error}"
        );
        let after = target
            .export_sql_string()?
            .lines()
            .filter(|line| !line.starts_with("-- 生成时间:"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(after, before);
        target.validate_stopped_proxy_state()?;
        Ok(())
    }

    #[test]
    fn sync_import_rejects_remote_runtime_flags_without_changing_main_db() -> Result<(), AppError> {
        for flag in ["enabled", "proxy_enabled"] {
            let remote = Database::memory()?;
            let local = Database::memory()?;
            {
                let conn = crate::database::lock_conn!(remote.conn);
                conn.execute_batch(&format!(
                    "INSERT INTO providers (id, app_type, name, settings_config, meta)
                     VALUES ('remote-provider', 'codex', 'Remote', '{{}}', '{{}}');
                     UPDATE proxy_config SET {flag} = 1 WHERE app_type = 'codex'"
                ))?;
            }
            {
                let conn = crate::database::lock_conn!(local.conn);
                conn.execute_batch(
                    "INSERT INTO providers (id, app_type, name, settings_config, meta)
                     VALUES ('local-provider', 'codex', 'Keep Local', '{}', '{}')",
                )?;
            }
            let before = local
                .export_sql_string()?
                .lines()
                .filter(|line| !line.starts_with("-- 生成时间:"))
                .collect::<Vec<_>>()
                .join("\n");
            let sql = remote.export_sql_string_for_sync()?;
            let error = local.import_sql_string_for_sync(&sql).unwrap_err();
            assert!(
                error.to_string().contains("数据库包含代理运行/接管状态"),
                "{flag}: {error}"
            );
            let after = local
                .export_sql_string()?
                .lines()
                .filter(|line| !line.starts_with("-- 生成时间:"))
                .collect::<Vec<_>>()
                .join("\n");
            assert_eq!(after, before, "{flag}");
            local.validate_stopped_proxy_state()?;
        }
        Ok(())
    }

    #[test]
    fn restore_rejects_proxy_runtime_metadata_before_commit() -> Result<(), AppError> {
        let db = Database::memory()?;
        db.validate_stopped_proxy_state()?;
        for sql in [
            "UPDATE proxy_config SET enabled = 1 WHERE app_type = 'codex'",
            "UPDATE proxy_config SET proxy_enabled = 1 WHERE app_type = 'codex'",
            "INSERT INTO proxy_live_backup (app_type, original_config, backed_up_at) VALUES ('codex', '{}', 'now')",
        ] {
            {
                let conn = crate::database::lock_conn!(db.conn);
                conn.execute_batch(sql).unwrap();
            }
            assert!(db.validate_stopped_proxy_state().is_err(), "{sql}");
            {
                let conn = crate::database::lock_conn!(db.conn);
                conn.execute_batch("UPDATE proxy_config SET enabled = 0, proxy_enabled = 0; DELETE FROM proxy_live_backup;").unwrap();
            }
            db.validate_stopped_proxy_state()?;
        }
        Ok(())
    }

    #[test]
    fn import_rejects_cross_file_statements_and_leaves_no_file_behind() -> Result<(), AppError> {
        // `VACUUM INTO` 是关键字扫描方案最容易漏的一条：它不含 "ATTACH" 字样，
        // 却和 ATTACH 一样落到 `AuthAction::Attach`（实测），因此同一条规则挡住两者。
        let cases: [(&str, &str); 2] = [
            ("attach", "ATTACH DATABASE '{path}' AS evil;"),
            ("vacuum-into", "VACUUM INTO '{path}';"),
        ];

        for (label, template) in cases {
            let target = std::env::temp_dir().join(format!("cc-switch-authorizer-{label}.sqlite"));
            let _ = std::fs::remove_file(&target);

            // 合法的导出头 + 越界语句。头部校验只比前缀，这份输入过得了它，
            // 真正拦下来的必须是 authorizer。
            let malicious = format!(
                "{}\n{}\n",
                super::CC_SWITCH_SQL_EXPORT_HEADER,
                template.replace("{path}", &target.display().to_string())
            );

            let db = Database::memory()?;
            let result = db.import_sql_string(&malicious);

            assert!(result.is_err(), "{label} 必须被拒绝");
            // 光报错不够：文件创建发生在 prepare 之后、`validate_basic_state` 之前，
            // 守卫若失效，即便导入整体失败，文件也已经躺在磁盘上了。
            assert!(
                !target.exists(),
                "被拒绝的 {label} 不得在磁盘上留下文件: {}",
                target.display()
            );

            let _ = std::fs::remove_file(&target);
        }
        Ok(())
    }

    #[test]
    fn local_table_restore_does_not_trust_remote_conflict_policies() -> Result<(), AppError> {
        let source = Database::memory()?;
        let target = Database::memory()?;
        let source_conn = crate::database::lock_conn!(source.conn);
        let target_conn = crate::database::lock_conn!(target.conn);
        source_conn.execute_batch(
            "INSERT INTO session_log_sync (file_path, last_modified, last_line_offset, last_synced_at)
             VALUES ('/a.jsonl', 1000, 7, 1001);
             INSERT INTO session_log_sync (file_path, last_modified, last_line_offset, last_synced_at)
             VALUES ('/b.jsonl', 1000, 7, 1001);
             CREATE INDEX local_cursor_mtime ON session_log_sync(last_modified);",
        )?;
        target_conn.execute_batch(
            "DROP TABLE session_log_sync;
             CREATE TABLE session_log_sync (
                file_path TEXT PRIMARY KEY, last_modified INTEGER NOT NULL,
                last_file_size INTEGER,
                last_line_offset INTEGER UNIQUE ON CONFLICT IGNORE,
                last_synced_at INTEGER NOT NULL
             );",
        )?;
        Database::restore_tables(&source_conn, &target_conn, &["session_log_sync"])?;
        let count: i64 = target_conn.query_row(
            "SELECT COUNT(*) FROM session_log_sync WHERE last_line_offset = 7",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(
            count, 2,
            "remote constraints must not silently skip a local row"
        );
        let index_exists: bool = target_conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'local_cursor_mtime')",
            [], |row| row.get(0),
        )?;
        assert!(index_exists, "preserve local indexes too");
        Ok(())
    }

    #[test]
    #[serial]
    fn binary_restore_rejects_triggers_before_migration_or_commit() -> Result<(), AppError> {
        let home = tempfile::tempdir().unwrap();
        let old_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        std::env::set_var("CC_SWITCH_TEST_HOME", home.path());
        let result = (|| -> Result<(), AppError> {
            let dir = crate::config::get_app_config_dir().join("backups");
            std::fs::create_dir_all(&dir).unwrap();
            let source = rusqlite::Connection::open(dir.join("unsafe.db"))?;
            Database::create_tables_on_conn(&source)?;
            source.execute_batch(
                "CREATE TRIGGER lose_local_usage AFTER INSERT ON usage_rollup_dedup
                 BEGIN DELETE FROM usage_rollup_dedup; END;",
            )?;
            drop(source);
            let db = Database::memory()?;
            seed_archived_usage(&db, "local-sentinel")?;
            let error = db.restore_from_backup("unsafe.db").unwrap_err();
            assert!(error.to_string().contains("触发器"));
            let conn = crate::database::lock_conn!(db.conn);
            let receipts: i64 = conn.query_row(
                "SELECT COUNT(*) FROM usage_rollup_dedup WHERE request_id = 'local-sentinel'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(receipts, 1);
            assert_eq!(
                Database::list_backups()?.len(),
                1,
                "failure must not consume a backup slot"
            );
            Ok(())
        })();
        match old_home {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        result
    }

    #[test]
    fn imports_reject_unsupported_schema_without_changing_local_data() -> Result<(), AppError> {
        let remote = Database::memory()?;
        {
            let conn = crate::database::lock_conn!(remote.conn);
            conn.execute_batch(
                "INSERT INTO providers (id, app_type, name, settings_config, meta)
                 VALUES ('remote', 'codex', 'Remote', '{}', '{}');",
            )?;
        }
        let sql = remote.export_sql_string()?;
        let objects = [
            "CREATE TABLE leaked_auth (value TEXT);
             CREATE TRIGGER steal_auth BEFORE UPDATE OF settings_config ON providers
             BEGIN INSERT INTO leaked_auth VALUES (OLD.settings_config); END;",
            "CREATE TRIGGER lose_local_usage AFTER INSERT ON usage_rollup_dedup
             BEGIN DELETE FROM usage_rollup_dedup; END;",
            "CREATE TEMP TRIGGER lose_local_usage AFTER INSERT ON main.usage_rollup_dedup
             BEGIN DELETE FROM usage_rollup_dedup; END;",
            "CREATE VIEW credential_view AS SELECT settings_config FROM providers;",
            "CREATE TEMP VIEW credential_view AS SELECT settings_config FROM providers;",
            "UPDATE main.proxy_config SET enabled=1 WHERE app_type='codex';
             CREATE TEMP TABLE proxy_config AS SELECT * FROM main.proxy_config;
             UPDATE temp.proxy_config SET enabled=0, proxy_enabled=0;",
        ];
        for object in objects {
            for preserve_local in [false, true] {
                let db = Database::memory()?;
                seed_archived_usage(&db, "local-sentinel")?;
                let malicious = format!("{sql}\n{object}");
                let result = if preserve_local {
                    db.import_sql_string_for_sync(&malicious)
                } else {
                    db.import_sql_string(&malicious)
                };
                assert!(result.unwrap_err().to_string().contains("not authorized"));
                let conn = crate::database::lock_conn!(db.conn);
                let receipts: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM usage_rollup_dedup WHERE request_id = 'local-sentinel'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(receipts, 1);
                let imported: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM providers WHERE id = 'remote'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(imported, 0);
            }
        }
        Ok(())
    }

    #[test]
    fn temporary_tables_cannot_shadow_backup_validation() -> Result<(), AppError> {
        let db = Database::memory()?;
        let conn = crate::database::lock_conn!(db.conn);
        conn.execute_batch(
            "UPDATE main.proxy_config SET enabled=1 WHERE app_type='codex';
             CREATE TEMP TABLE proxy_config AS SELECT * FROM main.proxy_config;
             UPDATE temp.proxy_config SET enabled=0, proxy_enabled=0;",
        )?;
        assert!(Database::validate_backup_schema(&conn).is_err());
        assert!(Database::validate_stopped_proxy_state_on_conn(&conn).is_err());
        Ok(())
    }

    #[test]
    fn sync_redaction_rejects_silent_conflicts_without_exporting_tokens() -> Result<(), AppError> {
        for policy in ["IGNORE", "REPLACE"] {
            let db = Database::memory()?;
            {
                let conn = crate::database::lock_conn!(db.conn);
                let schema: String = conn.query_row(
                    "SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='providers'",
                    [],
                    |row| row.get(0),
                )?;
                conn.execute_batch("DROP TABLE providers")?;
                conn.execute_batch(&schema.replace(
                    "settings_config TEXT NOT NULL",
                    &format!("settings_config TEXT NOT NULL UNIQUE ON CONFLICT {policy}"),
                ))?;
                for (id, secret) in [("a", "secret-a"), ("b", "secret-b")] {
                    conn.execute(
                        "INSERT INTO providers (id, app_type, name, settings_config, category)
                         VALUES (?1, 'codex', ?1, ?2, 'official')",
                        rusqlite::params![id, format!(r#"{{"auth":{{"token":"{secret}"}}}}"#)],
                    )?;
                }
            }
            assert!(db.export_sql_string_for_sync().is_err());
            let snapshot = db.snapshot_to_memory()?;
            assert!(Database::redact_codex_provider_auth(&snapshot).is_err());
            let preserved: i64 = {
                let conn = crate::database::lock_conn!(db.conn);
                conn.query_row(
                    "SELECT COUNT(*) FROM providers WHERE settings_config LIKE '%secret-%'",
                    [],
                    |row| row.get(0),
                )?
            };
            assert_eq!(preserved, 2, "a failed export must not change local auth");
        }
        Ok(())
    }

    #[test]
    fn sync_redaction_canonicalizes_duplicate_auth_and_rejects_invalid_json() -> Result<(), AppError>
    {
        for raw in [
            r#"{"auth":{},"auth":{"token":"secret-middle"},"auth":{}}"#,
            r#"{"auth":{},"auth":{"token":"secret-last"}}"#,
            r#"{"auth":{"token":"secret-first"},"auth":{}}"#,
        ] {
            let db = Database::memory()?;
            {
                let conn = crate::database::lock_conn!(db.conn);
                conn.execute(
                    "INSERT INTO providers (id, app_type, name, settings_config, category)
                     VALUES ('official', 'codex', 'Official', ?1, 'official')",
                    [raw],
                )?;
            }
            let exported = db.export_sql_string_for_sync()?;
            assert!(!exported.contains("secret-"));
        }
        for raw in [r#"{"auth":{"token":"secret-invalid"}"#, "null", "[]"] {
            let db = Database::memory()?;
            {
                let conn = crate::database::lock_conn!(db.conn);
                conn.execute(
                    "INSERT INTO providers (id, app_type, name, settings_config, category)
                     VALUES ('official', 'codex', 'Official', ?1, 'official')",
                    [raw],
                )?;
            }
            assert!(db.export_sql_string_for_sync().is_err());
        }
        Ok(())
    }

    #[test]
    fn sync_export_rejects_preexisting_triggers_before_oauth_redaction() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute_batch(
                r#"INSERT INTO providers (id, app_type, name, settings_config, category, meta)
                   VALUES ('official', 'codex', 'Official',
                           '{"auth":{"tokens":{"access_token":"audit-secret"}}}', 'official', '{}');
                   CREATE TABLE leaked_auth (value TEXT);
                   CREATE TRIGGER steal_auth BEFORE UPDATE OF settings_config ON providers
                   BEGIN INSERT INTO leaked_auth VALUES (OLD.settings_config); END;"#,
            )?;
        }
        assert!(db.export_sql_string_for_sync().is_err());
        let snapshot = db.snapshot_to_memory()?;
        assert!(Database::redact_codex_provider_auth(&snapshot).is_err());
        let leaked: i64 =
            snapshot.query_row("SELECT COUNT(*) FROM leaked_auth", [], |row| row.get(0))?;
        assert_eq!(leaked, 0, "redaction must not execute the imported trigger");
        Ok(())
    }

    #[test]
    #[serial]
    fn sync_snapshots_redact_official_provider_auth() -> Result<(), AppError> {
        let old_test_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        let test_home = std::env::temp_dir().join("cc-switch-sync-official-auth-redaction-test");
        let _ = std::fs::remove_dir_all(&test_home);
        std::fs::create_dir_all(&test_home).expect("create sync redaction test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", &test_home);

        let db = Database::memory()?;
        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, category, meta)
                 VALUES ('official', 'codex', 'Official',
                         '{\"auth\":{\"tokens\":{\"access_token\":\"official-live-token\"}},\"config\":\"\"}',
                         'official', '{}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, meta)
                 VALUES ('custom', 'claude', 'Custom',
                         '{\"env\":{\"ANTHROPIC_API_KEY\":\"custom-key\"}}', '{}')",
                [],
            )?;
        }

        let sync_export = db.export_sql_string_for_sync()?;
        assert!(
            !sync_export.contains("official-live-token"),
            "sync export must not carry official live OAuth tokens"
        );
        assert!(
            sync_export.contains("custom-key"),
            "non-official providers still sync their settings"
        );

        let token_count = {
            let conn = crate::database::lock_conn!(db.conn);
            conn.query_row(
                "SELECT COUNT(*) FROM providers
                 WHERE id = 'official' AND json_extract(settings_config, '$.auth.tokens.access_token') = 'official-live-token'",
                [],
                |row| row.get::<_, i64>(0),
            )?
        };
        assert_eq!(
            token_count, 1,
            "redaction must only apply to the sync snapshot"
        );

        let imported = Database::memory()?;
        imported.import_sql_string_for_sync(&sync_export)?;

        // Older remote snapshots (or, before MH-17, a local .sql export —
        // export_sql_string() is redacted the same way now, so this reaches
        // straight past both export paths for an unredacted dump) may still
        // contain the previous leak. The sync import boundary must clean it
        // instead of restoring tokens.
        let full_export = {
            let snapshot = db.snapshot_to_memory()?;
            Database::dump_sql(&snapshot, &[])?
        };
        assert!(full_export.contains("official-live-token"));
        let legacy_import = Database::memory()?;
        legacy_import.import_sql_string_for_sync(&full_export)?;

        let leaked_rows: i64 = {
            let conn = crate::database::lock_conn!(legacy_import.conn);
            conn.query_row(
                "SELECT COUNT(*) FROM providers
                 WHERE category = 'official'
                   AND json_extract(settings_config, '$.auth.tokens.access_token') IS NOT NULL",
                [],
                |row| row.get::<_, i64>(0),
            )?
        };
        assert_eq!(leaked_rows, 0, "sync import must redact official auth");

        match old_test_home {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        let _ = std::fs::remove_dir_all(&test_home);

        Ok(())
    }

    // MH-17 regressions: redaction is content-based (any Codex row, not
    // just category='official') and now also applies to the plain local
    // export, not just the sync export — but a non-official row's own
    // legitimate credential must survive, only genuine OAuth pollution
    // scrubbed, mirroring the MH-19 backfill-time fix exactly.

    #[test]
    fn local_export_redacts_official_but_keeps_non_official_codex_credential(
    ) -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, category, meta)
                 VALUES ('official', 'codex', 'Official',
                         '{\"auth\":{\"tokens\":{\"access_token\":\"local-live-token\"}},\"config\":\"\"}',
                         'official', '{}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, meta)
                 VALUES ('relay', 'codex', 'Relay',
                         '{\"auth\":{\"OPENAI_API_KEY\":\"sk-relay-own-key\"}}', '{}')",
                [],
            )?;
        }

        let exported = db.export_sql_string()?;
        assert!(
            !exported.contains("local-live-token"),
            "plain local export must redact the official row too, not just sync export"
        );
        assert!(
            exported.contains("sk-relay-own-key"),
            "a non-official row's own credential must survive a local export"
        );
        Ok(())
    }

    #[test]
    fn export_scrubs_oauth_pollution_from_non_official_row() -> Result<(), AppError> {
        // Simulates a row already polluted by the MH-19 defect: real ChatGPT
        // OAuth material sitting next to an OPENAI_API_KEY. Per MH-19's
        // pollution-signature rule, a key found alongside real chatgpt
        // tokens is part of the pollution (Codex's browser login persists an
        // exchanged key next to its tokens), so it goes too. A row whose own
        // key has no OAuth material beside it is covered by
        // local_export_redacts_official_but_keeps_non_official_codex_credential
        // and must survive.
        let db = Database::memory()?;
        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, meta)
                 VALUES ('polluted', 'codex', 'Polluted',
                         '{\"auth\":{\"OPENAI_API_KEY\":\"sk-exchanged-key\",\"auth_mode\":\"chatgpt\",\
                           \"tokens\":{\"access_token\":\"polluted-oauth-token\"}}}', '{}')",
                [],
            )?;
        }

        for exported in [db.export_sql_string()?, db.export_sql_string_for_sync()?] {
            assert!(!exported.contains("polluted-oauth-token"));
            assert!(!exported.contains("\"auth_mode\":\"chatgpt\""));
            assert!(
                !exported.contains("sk-exchanged-key"),
                "a key sitting next to real chatgpt tokens is part of the pollution signature"
            );
            assert!(
                exported.contains("'polluted'"),
                "the row itself survives: only its auth material is scrubbed, it is not dropped"
            );
        }
        Ok(())
    }

    #[test]
    fn export_leaves_non_codex_rows_untouched() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, meta)
                 VALUES ('claude-custom', 'claude', 'Custom',
                         '{\"env\":{\"ANTHROPIC_API_KEY\":\"anthropic-key\"}}', '{}')",
                [],
            )?;
        }

        let exported = db.export_sql_string()?;
        assert!(
            exported.contains("anthropic-key"),
            "redaction is scoped to app_type='codex'; other app types are untouched"
        );
        Ok(())
    }

    #[test]
    #[serial]
    // A successful import reaches `backup_database_file`, which resolves its
    // destination through the same process-global app-config-dir path
    // `CC_SWITCH_TEST_HOME`-based tests redirect. Without `#[serial]` this
    // ran concurrently with e.g. `failed_import_does_not_consume_a_backup_slot`
    // and could write a real backup file into that other test's temp
    // directory mid-run, purely from both tests racing the same global env
    // var — not a bug in either test's own logic, just an unguarded shared
    // resource. Confirmed by reproducing the interleaving with
    // `--test-threads=1` (never fails) vs the default parallel runner
    // (flaky) before adding this.
    fn import_still_accepts_a_genuine_export() -> Result<(), AppError> {
        // `#[serial]` alone only rules out *other* `#[serial]` tests running
        // concurrently — it does nothing if this test never redirects
        // `CC_SWITCH_TEST_HOME` itself, since `backup_database_file` still
        // resolves the app-config-dir from whatever is ambient in the
        // process at that moment. On a developer machine with a real
        // Chimera++ install and no test harness setting this var globally,
        // that would write a genuine backup snapshot into the real user's
        // app-data directory. Redirect it the same way the other
        // `#[serial]` tests in this file do.
        let old_test_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        let test_home = std::env::temp_dir().join("cc-switch-import-genuine-export-test");
        let _ = std::fs::remove_dir_all(&test_home);
        std::fs::create_dir_all(&test_home).expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", &test_home);

        // 白名单收得紧，必须有一条回归防线证明它没误伤自家导出格式——
        // 这条测试红了就说明 dump_sql 写出了白名单没覆盖的语句。
        let source = Database::memory()?;
        {
            let conn = crate::database::lock_conn!(source.conn);
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, meta)
                 VALUES ('p1', 'claude', 'Provider One', '{}', '{}')",
                [],
            )?;
        }
        let exported = source.export_sql_string()?;

        let target = Database::memory()?;
        target.import_sql_string(&exported)?;

        let conn = crate::database::lock_conn!(target.conn);
        let name: String = conn.query_row(
            "SELECT name FROM providers WHERE id = 'p1' AND app_type = 'claude'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(name, "Provider One");

        match old_test_home {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        Ok(())
    }

    #[test]
    #[serial]
    // Same reason as `import_still_accepts_a_genuine_export` above: a
    // successful sync import also reaches `backup_database_file`, so this
    // must redirect `CC_SWITCH_TEST_HOME` itself rather than relying on
    // `#[serial]` alone to make that safe.
    fn sync_import_preserves_local_only_tables() -> Result<(), AppError> {
        let old_test_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        let test_home = std::env::temp_dir().join("cc-switch-sync-import-local-tables-test");
        let _ = std::fs::remove_dir_all(&test_home);
        std::fs::create_dir_all(&test_home).expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", &test_home);

        let remote_db = Database::memory()?;
        seed_archived_usage(&remote_db, "remote-archive")?;
        seed_session_cursor(&remote_db, 99)?;
        {
            let conn = crate::database::lock_conn!(remote_db.conn);
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, meta)
                 VALUES ('remote-provider', 'claude', 'Remote Provider', '{}', '{}')",
                [],
            )?;
        }
        {
            let conn = crate::database::lock_conn!(remote_db.conn);
            conn.execute_batch(
                "INSERT INTO proxy_live_backup (app_type, original_config, backed_up_at)
                 VALUES ('codex', '{}', 'now')",
            )?;
        }
        // A legacy full snapshot may contain remote Live backups (current
        // exports drop them, so build one directly). They are replaced by
        // local-only tables before the final runtime validation.
        let remote_sql = {
            let snapshot = remote_db.snapshot_to_memory()?;
            Database::dump_sql(&snapshot, &[])?
        };
        assert!(remote_sql.contains("INSERT INTO \"proxy_live_backup\""));

        let local_db = Database::memory()?;
        {
            let conn = crate::database::lock_conn!(local_db.conn);
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, meta)
                 VALUES ('local-provider', 'claude', 'Local Provider', '{}', '{}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                ) VALUES ('req-1', 'local-provider', 'claude', 'claude-3', 100, 50, '0.01', 120, 200, 1000)",
                [],
            )?;
            conn.execute(
                "INSERT INTO stream_check_logs (
                    provider_id, provider_name, app_type, status, success, message,
                    response_time_ms, http_status, model_used, retry_count, tested_at
                ) VALUES ('local-provider', 'Local Provider', 'claude', 'operational', 1, 'ok', 42, 200, 'claude-3', 0, 1000)",
                [],
            )?;
        }

        seed_archived_usage(&local_db, "local-archive")?;
        seed_session_cursor(&local_db, 7)?;
        // Both legacy full snapshots and sync snapshots must leave local receipts
        // paired with their aggregates, even when imported repeatedly.
        let sync_sql = remote_db.export_sql_string_for_sync()?;
        {
            let conn = crate::database::lock_conn!(remote_db.conn);
            conn.execute_batch("DROP TABLE usage_rollup_dedup")?;
        }
        let legacy_sql = remote_db.export_sql_string()?;
        for sql in [&remote_sql, &remote_sql, &sync_sql, &legacy_sql] {
            local_db.import_sql_string_for_sync(sql)?;
            local_db.validate_stopped_proxy_state()?;
            let conn = crate::database::lock_conn!(local_db.conn);
            let (request_id, session_id): (String, String) = conn.query_row(
                "SELECT request_id, session_id FROM usage_rollup_dedup",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(request_id, "local-archive");
            assert_eq!(session_id, "local-archive");
            let offset: i64 = conn.query_row(
                "SELECT last_line_offset FROM session_log_sync WHERE file_path = '/shared/session.jsonl'",
                [], |row| row.get(0),
            )?;
            assert_eq!(
                offset, 7,
                "a remote cursor must not replace the same local file cursor"
            );
            let aggregate: (String, i64, i64) = conn.query_row(
                "SELECT provider_id, request_count, input_tokens FROM usage_daily_rollups",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(aggregate, ("local-archive".to_string(), 1, 100));
            let receipts: i64 =
                conn.query_row("SELECT COUNT(*) FROM usage_rollup_dedup", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(
                receipts, 1,
                "remote receipts must not replace local receipts"
            );
        }

        let remote_provider_exists: i64 = {
            let conn = crate::database::lock_conn!(local_db.conn);
            conn.query_row(
                "SELECT COUNT(*) FROM providers WHERE id = 'remote-provider' AND app_type = 'claude'",
                [],
                |row| row.get(0),
            )?
        };
        assert_eq!(
            remote_provider_exists, 1,
            "remote config should be imported"
        );

        let (request_logs, rollups, stream_logs): (i64, i64, i64) = {
            let conn = crate::database::lock_conn!(local_db.conn);
            let request_logs =
                conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
                    row.get(0)
                })?;
            let rollups =
                conn.query_row("SELECT COUNT(*) FROM usage_daily_rollups", [], |row| {
                    row.get(0)
                })?;
            let stream_logs =
                conn.query_row("SELECT COUNT(*) FROM stream_check_logs", [], |row| {
                    row.get(0)
                })?;
            (request_logs, rollups, stream_logs)
        };
        assert_eq!(request_logs, 1, "local request logs should be preserved");
        assert_eq!(rollups, 1, "local rollups should be preserved");
        assert_eq!(
            stream_logs, 1,
            "local stream check logs should be preserved"
        );

        // An empty device must not acquire another device's dedup identities
        // from an older full-snapshot sync payload either.
        let empty_db = Database::memory()?;
        empty_db.import_sql_string_for_sync(&remote_sql)?;
        {
            let conn = crate::database::lock_conn!(empty_db.conn);
            for table in [
                "usage_daily_rollups",
                "usage_rollup_dedup",
                "session_log_sync",
            ] {
                let count: i64 =
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })?;
                assert_eq!(count, 0, "remote {table} must not populate an empty device");
            }
        }

        match old_test_home {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        Ok(())
    }

    #[test]
    #[serial]
    fn periodic_maintenance_runs_even_when_auto_backup_disabled() -> Result<(), AppError> {
        let old_test_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        let test_home =
            std::env::temp_dir().join("cc-switch-periodic-maintenance-backup-disabled-test");
        let _ = std::fs::remove_dir_all(&test_home);
        std::fs::create_dir_all(&test_home).expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", &test_home);

        let settings = AppSettings {
            backup_interval_hours: Some(0),
            ..AppSettings::default()
        };
        update_settings(settings).expect("disable auto backup");

        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();
        let old_ts = now - 40 * 86400;
        let old_stream_ts = now - 8 * 86400;

        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                ) VALUES ('old-req', 'p1', 'claude', 'claude-3', 100, 50, '0.01', 100, 200, ?1)",
                [old_ts],
            )?;
            conn.execute(
                "INSERT INTO stream_check_logs (
                    provider_id, provider_name, app_type, status, success, message,
                    response_time_ms, http_status, model_used, retry_count, tested_at
                ) VALUES ('p1', 'Provider 1', 'claude', 'operational', 1, 'ok', 42, 200, 'claude-3', 0, ?1)",
                [old_stream_ts],
            )?;
        }

        db.periodic_backup_if_needed()?;

        let (remaining_request_logs, stream_logs, rollups): (i64, i64, i64) = {
            let conn = crate::database::lock_conn!(db.conn);
            let remaining_request_logs =
                conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
                    row.get(0)
                })?;
            let stream_logs =
                conn.query_row("SELECT COUNT(*) FROM stream_check_logs", [], |row| {
                    row.get(0)
                })?;
            let rollups =
                conn.query_row("SELECT COUNT(*) FROM usage_daily_rollups", [], |row| {
                    row.get(0)
                })?;
            (remaining_request_logs, stream_logs, rollups)
        };

        assert_eq!(
            remaining_request_logs, 0,
            "old request logs should still be pruned when auto backup is disabled"
        );
        assert_eq!(
            stream_logs, 0,
            "old stream check logs should still be pruned when auto backup is disabled"
        );
        assert_eq!(rollups, 1, "old request logs should be rolled up");

        match old_test_home {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }

        Ok(())
    }

    #[test]
    fn quote_ident_escapes_embedded_double_quotes() {
        assert_eq!(super::quote_ident("providers"), "\"providers\"");
        assert_eq!(super::quote_ident("weird\"table"), "\"weird\"\"table\"");
        assert_eq!(super::quote_ident("a\"\"b"), "\"a\"\"\"\"b\"");
    }

    #[test]
    fn format_sql_value_downgrades_non_finite_reals_to_null() -> Result<(), AppError> {
        use rusqlite::types::ValueRef;

        assert_eq!(
            Database::format_sql_value(ValueRef::Real(f64::INFINITY))?,
            "NULL",
            "+inf must not be emitted as the bare word `inf`, which is not valid SQL"
        );
        assert_eq!(
            Database::format_sql_value(ValueRef::Real(f64::NEG_INFINITY))?,
            "NULL"
        );
        assert_eq!(
            Database::format_sql_value(ValueRef::Real(f64::NAN))?,
            "NULL",
            "NaN must not be emitted as the bare word `NaN`, which is not valid SQL"
        );
        assert_eq!(Database::format_sql_value(ValueRef::Real(1.5))?, "1.5");
        assert_eq!(Database::format_sql_value(ValueRef::Real(0.0))?, "0");
        Ok(())
    }

    #[test]
    #[serial]
    fn failed_import_does_not_consume_a_backup_slot() -> Result<(), AppError> {
        let old_test_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        let test_home = std::env::temp_dir().join("cc-switch-import-failure-backup-slot-test");
        let _ = std::fs::remove_dir_all(&test_home);
        std::fs::create_dir_all(&test_home).expect("create test home");
        std::env::set_var("CC_SWITCH_TEST_HOME", &test_home);

        let app_dir = crate::config::get_app_config_dir();
        std::fs::create_dir_all(&app_dir).expect("create app config dir");
        // `backup_database_file` only gates on this path existing before it
        // decides whether there is anything worth backing up; the actual
        // snapshot it copies always comes from `self.conn`, so a
        // placeholder is enough to make that gate pass.
        std::fs::write(
            app_dir.join(crate::product_policy::PRODUCT_DATABASE_FILE),
            b"placeholder",
        )
        .expect("seed placeholder db file");

        let db = Database::memory()?;

        // `CC_SWITCH_TEST_HOME` (and the app-config-dir override it feeds)
        // is process-global state that other `#[serial]`-guarded tests in
        // this same file also redirect to their own directories — `#[serial]`
        // only rules out them running *concurrently* with this one, not
        // stray filesystem state a differently-scoped test left behind
        // sharing part of the same resolved path. Compare against a
        // baseline captured right here rather than asserting an absolute
        // count, so this test only ever fails on what *it* actually caused.
        let backups_before = Database::list_backups()?.len();

        // Correct header, but no provider/MCP rows: passes the authorizer
        // and the batch execute, then fails `validate_basic_state` — a
        // *late* failure. Before this fix, the safety backup ran before any
        // validation, so even this kind of doomed-from-the-start import
        // still burned a slot in `cleanup_db_backups`'s retention window.
        let malformed = format!(
            "{}\nBEGIN TRANSACTION;\nCOMMIT;\n",
            super::CC_SWITCH_SQL_EXPORT_HEADER
        );
        let result = db.import_sql_string(&malformed);
        assert!(result.is_err(), "an empty import must fail validation");

        let backups_after_failure = Database::list_backups()?;
        assert_eq!(
            backups_after_failure.len(),
            backups_before,
            "a failed import must not create a safety backup: {backups_after_failure:?}"
        );

        // A genuine import afterwards must still create exactly one more
        // backup than before, proving the relocation didn't just quietly
        // disable backups.
        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, meta)
                 VALUES ('p1', 'claude', 'Provider One', '{}', '{}')",
                [],
            )?;
        }
        let exported = db.export_sql_string()?;
        db.import_sql_string(&exported)?;
        let backups_after_success = Database::list_backups()?;
        assert_eq!(
            backups_after_success.len(),
            backups_before + 1,
            "a successful import must create exactly one additional safety backup"
        );

        match old_test_home {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        let _ = std::fs::remove_dir_all(&test_home);

        Ok(())
    }

    #[test]
    #[serial]
    fn backup_rotation_only_deletes_generated_db_backups() -> Result<(), AppError> {
        let old_test_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        let test_home = tempfile::tempdir().unwrap();
        std::env::set_var("CC_SWITCH_TEST_HOME", test_home.path());

        let previous_retain = crate::settings::get_settings().backup_retain_count;
        let result = (|| -> Result<(), AppError> {
            crate::settings::mutate_settings(|s| s.backup_retain_count = Some(1))?;
            let dir = test_home.path().join("rotation-backups");
            std::fs::create_dir_all(&dir).unwrap();
            for name in [
                "db_backup_20260101_000000.db",
                "db_backup_20260102_000000.db",
                "pre_v17_20251231_000000.db",
                "db_backup_20260103_000000.db",
                "before-upgrade.db",
                "other-tool.db",
                "db_backup_notes.txt",
            ] {
                std::fs::write(dir.join(name), b"x").unwrap();
                // Distinct mtimes so "newest" is deterministic.
                std::thread::sleep(std::time::Duration::from_millis(20));
            }

            Database::cleanup_db_backups(&dir)?;

            let mut remaining = std::fs::read_dir(&dir)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>();
            remaining.sort();
            assert_eq!(
                remaining,
                [
                    "before-upgrade.db",
                    "db_backup_20260103_000000.db",
                    "db_backup_notes.txt",
                    "other-tool.db",
                    "pre_v17_20251231_000000.db",
                ],
                "rotation must only prune its own db_backup_*.db snapshots"
            );
            Ok(())
        })();

        crate::settings::mutate_settings(|s| s.backup_retain_count = previous_retain)
            .expect("restore backup retain count");
        match old_test_home {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        result
    }

    #[test]
    #[serial]
    fn local_export_and_db_backup_drop_takeover_live_backup() -> Result<(), AppError> {
        let old_test_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        let test_home = tempfile::tempdir().unwrap();
        std::env::set_var("CC_SWITCH_TEST_HOME", test_home.path());

        let result = (|| -> Result<(), AppError> {
            let app_dir = crate::config::get_app_config_dir();
            std::fs::create_dir_all(&app_dir).unwrap();
            // `backup_database_file` only checks that the main DB path exists;
            // the snapshot itself comes from `self.conn`.
            std::fs::write(
                app_dir.join(crate::product_policy::PRODUCT_DATABASE_FILE),
                b"placeholder",
            )
            .unwrap();

            let db = Database::memory()?;
            {
                let conn = crate::database::lock_conn!(db.conn);
                conn.execute_batch(
                    r#"INSERT INTO providers (id, app_type, name, settings_config, meta)
                       VALUES ('relay', 'codex', 'Relay',
                               '{"auth":{"OPENAI_API_KEY":"sk-relay-kept"}}', '{}');
                       INSERT INTO proxy_live_backup (app_type, original_config, backed_up_at)
                       VALUES ('codex',
                               '{"auth":{"tokens":{"access_token":"takeover-live-oauth"}},"config":""}',
                               'now');"#,
                )?;
            }

            let exported = db.export_sql_string()?;
            assert!(!exported.contains("takeover-live-oauth"));
            assert!(exported.contains("sk-relay-kept"));

            let backup_path = db.backup_database_file()?.expect("backup created");
            let raw = std::fs::read(&backup_path).unwrap();
            assert!(
                !raw.windows(b"takeover-live-oauth".len())
                    .any(|window| window == b"takeover-live-oauth"),
                "the deleted Live backup must not survive in free pages either"
            );
            let backup = rusqlite::Connection::open(&backup_path)?;
            let live_rows: i64 =
                backup.query_row("SELECT COUNT(*) FROM proxy_live_backup", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(live_rows, 0);
            let kept: String = backup.query_row(
                "SELECT settings_config FROM providers WHERE id = 'relay'",
                [],
                |row| row.get(0),
            )?;
            assert!(
                kept.contains("sk-relay-kept"),
                "provider rows stay full-fidelity"
            );

            let conn = crate::database::lock_conn!(db.conn);
            let local_rows: i64 =
                conn.query_row("SELECT COUNT(*) FROM proxy_live_backup", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(local_rows, 1, "the live database keeps its own Live backup");
            Ok(())
        })();

        match old_test_home {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        result
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle.as_bytes())
    }

    /// Seeds a database that looks like a v16 install mid-takeover: an
    /// official line with OAuth tokens, a relay line with an API key, a
    /// takeover Live backup and an MCP server with a token in `env`.
    fn seed_tokens(db: &Database) -> Result<(), AppError> {
        let conn = crate::database::lock_conn!(db.conn);
        conn.execute_batch(
            r#"INSERT INTO providers (id, app_type, name, settings_config, category, meta)
               VALUES ('official', 'codex', 'OpenAI',
                       '{"auth":{"tokens":{"access_token":"oauth-access-secret"}}}', 'official', '{}'),
                      ('relay', 'codex', 'Relay',
                       '{"auth":{"OPENAI_API_KEY":"sk-relay-kept"}}', 'custom', '{}');
               INSERT INTO proxy_live_backup (app_type, original_config, backed_up_at)
               VALUES ('codex', '{"auth":{"tokens":{"access_token":"takeover-live-oauth"}},"config":""}', 'now');
               INSERT INTO mcp_servers (id, name, server_config, enabled_codex)
               VALUES ('github', 'github',
                       '{"type":"stdio","command":"npx","env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"ghp-mcp-secret"}}', 1);
               INSERT INTO settings (key, value) VALUES ('codex_mcp_projection_ledger', '{"servers":{"github":"abc"}}');
               INSERT INTO prompt_template_cache (template_id, content, content_sha256)
               VALUES ('code-review', 'cached-template-body', 'hash');"#,
        )?;
        Ok(())
    }

    #[test]
    #[serial]
    fn pre_v17_backup_is_token_free_unrotated_and_restores_as_the_downgrade_path(
    ) -> Result<(), AppError> {
        let old_test_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        let test_home = tempfile::tempdir().unwrap();
        std::env::set_var("CC_SWITCH_TEST_HOME", test_home.path());

        let result = (|| -> Result<(), AppError> {
            let app_dir = crate::config::get_app_config_dir();
            std::fs::create_dir_all(&app_dir).unwrap();
            std::fs::write(
                app_dir.join(crate::product_policy::PRODUCT_DATABASE_FILE),
                b"placeholder",
            )
            .unwrap();

            let db = Database::memory()?;
            seed_tokens(&db)?;
            {
                // Pre-migration state as 2.7.x left it.
                let conn = crate::database::lock_conn!(db.conn);
                Database::set_user_version(&conn, 16)?;
            }

            let path = db.backup_pre_v17_database_file()?.expect("backup created");
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            assert!(name.starts_with(super::PRE_V17_BACKUP_PREFIX), "{name}");
            assert!(!Database::is_rotated_db_backup(&path));
            let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
                .filter(|name| name.ends_with(".partial"))
                .collect();
            assert!(leftovers.is_empty(), "{leftovers:?}");

            let raw = std::fs::read(&path).unwrap();
            for secret in ["oauth-access-secret", "takeover-live-oauth"] {
                assert!(
                    !contains(&raw, secret),
                    "{secret} must not survive in any page"
                );
            }
            assert!(
                contains(&raw, "sk-relay-kept"),
                "API keys stay for a local restore"
            );
            assert!(
                contains(&raw, "ghp-mcp-secret"),
                "MCP env stays for a local restore"
            );

            // 2.7.x (schema 16) can open it as-is.
            let backup = rusqlite::Connection::open(&path)?;
            assert_eq!(Database::get_user_version(&backup)?, 16);
            drop(backup);

            // Restoring it brings the rows back and migrates them again.
            {
                let conn = crate::database::lock_conn!(db.conn);
                conn.execute("DELETE FROM providers WHERE id = 'relay'", [])?;
                conn.execute("DELETE FROM proxy_live_backup", [])?;
            }
            db.restore_from_backup(&name)?;
            let conn = crate::database::lock_conn!(db.conn);
            let relay: i64 = conn.query_row(
                "SELECT COUNT(*) FROM providers WHERE id = 'relay'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(relay, 1);
            assert_eq!(
                Database::get_user_version(&conn)?,
                crate::database::SCHEMA_VERSION
            );
            Ok(())
        })();

        match old_test_home {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        result
    }

    #[test]
    fn exports_apply_the_v17_data_classification() -> Result<(), AppError> {
        let db = Database::memory()?;
        seed_tokens(&db)?;

        for exported in [db.export_sql_string()?, db.export_sql_string_for_sync()?] {
            assert!(!exported.contains("ghp-mcp-secret"), "MCP env is blanked");
            assert!(
                exported.contains("GITHUB_PERSONAL_ACCESS_TOKEN"),
                "the env key name stays so the user knows what to refill"
            );
            assert!(!exported.contains("oauth-access-secret"));
            assert!(!exported.contains("takeover-live-oauth"));
            assert!(
                !exported.contains("codex_mcp_projection_ledger"),
                "projection ledgers describe this device's live files"
            );
            assert!(
                !exported.contains("cached-template-body"),
                "cache is skipped"
            );
            assert!(
                exported.contains("prompt_template_cache ("),
                "the schema itself still round-trips"
            );
        }

        let conn = crate::database::lock_conn!(db.conn);
        let live: String = conn.query_row(
            "SELECT server_config FROM mcp_servers WHERE id = 'github'",
            [],
            |row| row.get(0),
        )?;
        assert!(
            live.contains("ghp-mcp-secret"),
            "only the export is redacted"
        );
        Ok(())
    }

    #[test]
    fn mcp_secret_maps_are_blanked_by_value() {
        let mut spec = serde_json::json!({
            "type": "http",
            "url": "https://mcp.example.com",
            "headers": {"Authorization": "Bearer abc", "X-Empty": ""},
            "env": {"TOKEN": "t"},
            "args": ["--token", "stays-an-arg"]
        });
        assert_eq!(super::redact_mcp_spec_secrets(&mut spec), 2);
        assert_eq!(spec["headers"]["Authorization"], "");
        assert_eq!(spec["env"]["TOKEN"], "");
        assert_eq!(spec["url"], "https://mcp.example.com");
        assert_eq!(super::redact_mcp_spec_secrets(&mut spec), 0);
    }

    #[cfg(unix)]
    #[test]
    fn storage_permissions_are_tightened_to_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        fn mode(path: &std::path::Path) -> u32 {
            std::fs::symlink_metadata(path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        }
        fn set(path: &std::path::Path, mode: u32) {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap()
        }

        let root = tempfile::tempdir().unwrap();

        let app_dir = root.path().join("app");
        let backups = app_dir.join("backups");
        std::fs::create_dir_all(&backups).unwrap();
        let db_path = app_dir.join("chimera.db");
        let snapshot = backups.join("db_backup_20260101_000000.db");
        let renamed = backups.join("before-upgrade.db");
        let notes = backups.join("notes.txt");
        let outside = root.path().join("outside.db");
        for file in [&db_path, &snapshot, &renamed, &notes, &outside] {
            std::fs::write(file, b"x").unwrap();
            set(file, 0o644);
        }
        let link = backups.join("link.db");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        set(&app_dir, 0o755);
        set(&backups, 0o755);

        super::restrict_db_storage_permissions(&db_path);

        assert_eq!(mode(&db_path), 0o600);
        assert_eq!(mode(&app_dir), 0o700);
        assert_eq!(mode(&backups), 0o700);
        assert_eq!(mode(&snapshot), 0o600);
        assert_eq!(mode(&renamed), 0o600);
        assert_eq!(mode(&notes), 0o644, "only .db files are touched");
        assert_eq!(mode(&outside), 0o644, "symlinks are not followed");
    }
}
