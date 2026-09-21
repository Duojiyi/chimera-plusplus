//! Codex 会话日志使用追踪
//!
//! 从 ~/.codex/sessions/ 下的 JSONL 会话文件中提取精确 token 使用数据，
//! 替代原有的 state_5.sqlite 估算方案。
//!
//! ## 数据流
//! ```text
//! ~/.codex/sessions/YYYY/MM/DD/*.jsonl → 增量解析 → delta 计算 → 费用计算 → proxy_request_logs 表
//! ```
//!
//! ## 解析的事件类型
//! - `session_meta` → 提取唯一 thread_id（子代理的 session_id 指向父线程）
//! - `turn_context` → 提取当前 model
//! - `event_msg` (type=token_count) → 提取累计 token 用量，计算 delta

use crate::codex_config::get_codex_config_dir;
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::proxy::usage::calculator::{CostCalculator, ModelPricing};
use crate::proxy::usage::parser::TokenUsage;
use crate::security_limits::{
    collect_files_with_extensions, open_regular_file_no_symlink, MAX_SESSION_SCAN_DEPTH,
};
use crate::services::session_usage::{metadata_modified_nanos, SessionSyncResult};
use crate::services::usage_stats::{
    effective_usage_log_filter, find_model_pricing, has_suspected_codex_session_duplicate,
    should_skip_session_insert, DedupKey,
};
use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

const CODEX_THREAD_REQUEST_ID_PREFIX: &str = "codex_session:thread-v1";

/// Maximum buffered plaintext line. Compressed files additionally have a hard
/// total decoded-byte budget, including skipped/oversized lines.
pub(super) const MAX_SESSION_LINE_BYTES: usize = 16 * 1024 * 1024;

/// Read one line from a buffered reader, bounded to `max_len` bytes.
///
/// Returns `Ok(None)` once there is nothing left to read. Otherwise returns
/// `Ok(Some((bytes, truncated, terminated)))`: `bytes` holds the line's content (without
/// its terminator) when `truncated` is `false`; when `truncated` is `true`
/// the line exceeded `max_len` and everything up to (and including) the
/// next `\n` was drained without being buffered, so `bytes` is empty and
/// the reader is already positioned at the start of the next line.
/// `terminated` distinguishes a newline from a possibly still-being-written EOF tail.
pub(super) fn read_capped_line(
    reader: &mut impl BufRead,
    max_len: usize,
) -> io::Result<Option<(Vec<u8>, bool, bool)>> {
    let mut out = Vec::new();
    let mut truncated = false;
    let mut saw_any_bytes = false;

    loop {
        let buf = reader.fill_buf()?;
        if buf.is_empty() {
            break;
        }
        saw_any_bytes = true;

        if let Some(pos) = buf.iter().position(|&byte| byte == b'\n') {
            if !truncated && out.len().saturating_add(pos) <= max_len {
                out.extend_from_slice(&buf[..pos]);
            } else {
                // Once truncated, `bytes` must stay empty per this
                // function's contract (see doc comment above) — without
                // this `clear()`, bytes already accumulated from earlier
                // `fill_buf` chunks (this only overflows across chunks for
                // a real `BufReader`; a single-shot `Cursor`, as used by
                // this module's own tests, never exercises the gap)
                // survive into the truncated return, silently violating it.
                truncated = true;
                out.clear();
            }
            reader.consume(pos + 1);
            if !truncated && out.last() == Some(&b'\r') {
                out.pop();
            }
            return Ok(Some((out, truncated, true)));
        }

        if !truncated && out.len().saturating_add(buf.len()) <= max_len {
            out.extend_from_slice(buf);
        } else {
            truncated = true;
            out.clear();
        }
        let consumed = buf.len();
        reader.consume(consumed);
    }

    if !saw_any_bytes {
        return Ok(None);
    }
    Ok(Some((out, truncated, false)))
}

/// 累计 token 用量（跟踪 total_token_usage 字段）
#[derive(Debug, Clone, Default)]
struct CumulativeTokens {
    input: u64,
    cached_input: u64,
    output: u64,
}

/// 单次 API 调用的 token 增量
#[derive(Debug)]
struct DeltaTokens {
    input: u32,
    cached_input: u32,
    output: u32,
}

impl DeltaTokens {
    fn is_zero(&self) -> bool {
        self.input == 0 && self.cached_input == 0 && self.output == 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TokenCountersSignature {
    input: Option<u64>,
    cached_input: Option<u64>,
    output: Option<u64>,
    reasoning_output: Option<u64>,
    total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TokenUsageSignature {
    total: Option<TokenCountersSignature>,
    last: Option<TokenCountersSignature>,
}

#[derive(Debug)]
struct ParsedTokenEvent {
    line_offset: i64,
    signature: TokenUsageSignature,
    delta: DeltaTokens,
    event_index: Option<u32>,
    model: String,
    timestamp: Option<String>,
}

#[derive(Debug)]
enum ParentResolution {
    None,
    Parent(String),
    Deferred(String),
}

#[derive(Debug)]
struct ParsedCodexFile {
    root_thread_id: Option<String>,
    source_session_id: Option<String>,
    root_meta_seen: bool,
    root_timestamp: Option<DateTime<Utc>>,
    parent: ParentResolution,
    token_events: Vec<ParsedTokenEvent>,
    line_offset: i64,
    has_billable_tokens: bool,
    incomplete_tail: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PendingReason {
    MissingParent(String),
    Stable(String),
    Retryable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingEntry {
    modified: i64,
    size: u64,
    reason: PendingReason,
}

#[derive(Debug, Default)]
struct CodexReplayCaches {
    parent_signatures: HashMap<(PathBuf, i64), Vec<TokenUsageSignature>>,
    replay_prefixes: HashMap<(PathBuf, i64, u64), usize>,
    pending: HashMap<PathBuf, PendingEntry>,
}

static CODEX_REPLAY_CACHES: OnceLock<Mutex<CodexReplayCaches>> = OnceLock::new();

fn replay_caches() -> &'static Mutex<CodexReplayCaches> {
    CODEX_REPLAY_CACHES.get_or_init(|| Mutex::new(CodexReplayCaches::default()))
}

pub(crate) fn clear_codex_replay_caches() {
    if let Ok(mut caches) = replay_caches().lock() {
        *caches = CodexReplayCaches::default();
    }
}

fn is_rollout_filename(file_name: &str) -> bool {
    if !file_name.starts_with("rollout-") {
        return false;
    }
    // Codex may archive older rollouts as `.jsonl.zst`; both forms are the
    // same JSONL payload to usage aggregation.
    let stem = file_name.strip_suffix(".jsonl.zst").unwrap_or_else(|| {
        if file_name.ends_with(".jsonl") {
            file_name.trim_end_matches(".jsonl")
        } else {
            file_name
        }
    });
    if stem == file_name {
        return false;
    }
    stem.get(stem.len().saturating_sub(36)..)
        .is_some_and(|candidate| uuid::Uuid::parse_str(candidate).is_ok())
}

fn is_codex_cursor_path(file_path: &str, codex_dir: &Path) -> bool {
    let path = Path::new(file_path);
    let file_name = file_path.rsplit(['/', '\\']).next().unwrap_or_default();
    if !is_rollout_filename(file_name) {
        return false;
    }

    if path.starts_with(codex_dir.join("sessions"))
        || path.starts_with(codex_dir.join("archived_sessions"))
    {
        return true;
    }

    // 兼容用户改过 CODEX_HOME 后遗留、且源文件已不存在的 cursor。只接受
    // 明确目录段 + Codex rollout UUID 文件名，避免宽 codex_dir 误删其他 importer。
    file_path
        .replace('\\', "/")
        .split('/')
        .any(|segment| matches!(segment, "sessions" | "archived_sessions"))
}

fn sqlite_table_exists(conn: &rusqlite::Connection, table: &str) -> Result<bool, AppError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
    .map_err(|error| AppError::Database(format!("查询表 {table} 失败: {error}")))
}

fn sqlite_column_exists(
    conn: &rusqlite::Connection,
    table: &str,
    column: &str,
) -> Result<bool, AppError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        rusqlite::params![table, column],
        |row| row.get(0),
    )
    .map_err(|error| AppError::Database(format!("查询列 {table}.{column} 失败: {error}")))
}

pub(crate) fn reset_codex_usage_on_conn(
    conn: &rusqlite::Connection,
    codex_dir: &Path,
) -> Result<(), AppError> {
    if sqlite_table_exists(conn, "proxy_request_logs")?
        && sqlite_column_exists(conn, "proxy_request_logs", "data_source")?
    {
        conn.execute(
            "DELETE FROM proxy_request_logs WHERE data_source = 'codex_session'",
            [],
        )
        .map_err(|error| AppError::Database(format!("清理 Codex 会话明细失败: {error}")))?;
    }
    if sqlite_table_exists(conn, "usage_rollup_dedup")? {
        conn.execute(
            "DELETE FROM usage_rollup_dedup WHERE data_source = 'codex_session'",
            [],
        )
        .map_err(|error| AppError::Database(format!("清理 Codex 归档凭据失败: {error}")))?;
    }
    if sqlite_table_exists(conn, "usage_daily_rollups")?
        && sqlite_column_exists(conn, "usage_daily_rollups", "provider_id")?
    {
        conn.execute(
            "DELETE FROM usage_daily_rollups WHERE provider_id = '_codex_session'",
            [],
        )
        .map_err(|error| AppError::Database(format!("清理 Codex 用量汇总失败: {error}")))?;
    }
    if sqlite_table_exists(conn, "session_log_sync")?
        && sqlite_column_exists(conn, "session_log_sync", "file_path")?
    {
        let paths = {
            let mut statement = conn
                .prepare("SELECT file_path FROM session_log_sync")
                .map_err(|error| {
                    AppError::Database(format!("读取会话同步 cursor 失败: {error}"))
                })?;
            let paths = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| AppError::Database(format!("查询会话同步 cursor 失败: {error}")))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| {
                    AppError::Database(format!("解析会话同步 cursor 失败: {error}"))
                })?;
            paths
        };
        for file_path in paths
            .into_iter()
            .filter(|path| is_codex_cursor_path(path, codex_dir))
        {
            conn.execute(
                "DELETE FROM session_log_sync WHERE file_path = ?1",
                [file_path],
            )
            .map_err(|error| AppError::Database(format!("清理 Codex 同步 cursor 失败: {error}")))?;
        }
    }
    Ok(())
}

fn non_empty_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn thread_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let candidate = stem.get(stem.len().checked_sub(36)?..)?;
    uuid::Uuid::parse_str(candidate)
        .ok()
        .map(|value| value.hyphenated().to_string())
}

fn explicit_parent_from_meta(payload: &serde_json::Value) -> ParentResolution {
    let forked_from = non_empty_string(payload.get("forked_from_id"));
    let spawned_from = payload
        .get("source")
        .and_then(|source| source.get("subagent"))
        .and_then(|subagent| subagent.get("thread_spawn"))
        .and_then(|spawn| non_empty_string(spawn.get("parent_thread_id")));

    match (forked_from, spawned_from) {
        (None, None) => ParentResolution::None,
        (Some(parent), None) | (None, Some(parent)) => ParentResolution::Parent(parent),
        (Some(forked), Some(spawned)) if forked == spawned => ParentResolution::Parent(forked),
        (Some(forked), Some(spawned)) => ParentResolution::Deferred(format!(
            "forked_from_id ({forked}) 与 thread_spawn.parent_thread_id ({spawned}) 不一致"
        )),
    }
}

fn parse_timestamp(value: Option<&serde_json::Value>) -> Option<DateTime<Utc>> {
    value
        .and_then(serde_json::Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn parse_signature_counters(value: Option<&serde_json::Value>) -> Option<TokenCountersSignature> {
    let value = value?.as_object()?;
    Some(TokenCountersSignature {
        input: value
            .get("input_tokens")
            .and_then(serde_json::Value::as_u64),
        cached_input: value
            .get("cached_input_tokens")
            .or_else(|| value.get("cache_read_input_tokens"))
            .and_then(serde_json::Value::as_u64),
        output: value
            .get("output_tokens")
            .and_then(serde_json::Value::as_u64),
        reasoning_output: value
            .get("reasoning_output_tokens")
            .and_then(serde_json::Value::as_u64),
        total: value
            .get("total_tokens")
            .and_then(serde_json::Value::as_u64),
    })
}

fn parse_token_signature(info: &serde_json::Value) -> Option<TokenUsageSignature> {
    let total = parse_signature_counters(info.get("total_token_usage"));
    let last = parse_signature_counters(info.get("last_token_usage"));
    (total.is_some() || last.is_some()).then_some(TokenUsageSignature { total, last })
}

fn get_codex_sync_state(
    db: &Database,
    file_path: &Path,
) -> Result<(i64, i64, Option<u64>), AppError> {
    let file_path_str = file_path.to_string_lossy().to_string();
    let state = lock_conn!(db.conn)
        .query_row(
            "SELECT last_modified, last_line_offset, last_file_size
             FROM session_log_sync WHERE file_path = ?1",
            [&file_path_str],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .unwrap_or((0, 0, None));
    if state != (0, 0, None)
        || file_path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("archived_sessions")
    {
        return Ok(state);
    }

    let Some(file_name) = file_path.file_name().and_then(|name| name.to_str()) else {
        return Ok(state);
    };
    let slash_suffix = format!("/{file_name}");
    let backslash_suffix = format!("\\{file_name}");
    let conn = lock_conn!(db.conn);
    let inherited = conn.query_row(
        "SELECT last_modified, last_line_offset, last_file_size
         FROM session_log_sync
         WHERE file_path <> ?1
           AND (substr(file_path, -length(?2)) = ?2
                OR substr(file_path, -length(?3)) = ?3)
         ORDER BY last_line_offset DESC, last_modified DESC
         LIMIT 1",
        rusqlite::params![file_path_str, slash_suffix, backslash_suffix],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<u64>>(2)?,
            ))
        },
    );
    drop(conn);

    match inherited {
        Ok(inherited) => {
            update_codex_sync_state(db, &file_path_str, inherited.0, inherited.1, inherited.2)?;
            Ok(inherited)
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(state),
        Err(error) => Err(AppError::Database(format!(
            "查询 Codex 归档文件同步状态失败: {error}"
        ))),
    }
}

fn update_codex_sync_state(
    db: &Database,
    file_path: &str,
    last_modified: i64,
    last_offset: i64,
    last_file_size: Option<u64>,
) -> Result<(), AppError> {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    lock_conn!(db.conn).execute(
        "INSERT OR REPLACE INTO session_log_sync
         (file_path, last_modified, last_line_offset, last_synced_at, last_file_size)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![file_path, last_modified, last_offset, now, last_file_size],
    )?;
    Ok(())
}

/// 归一化 Codex 模型名
///
/// 处理规则（按顺序）：
/// 1. 转小写：`GLM-4.6` → `glm-4.6`
/// 2. 剥离 provider 前缀：`openai/gpt-5.4` → `gpt-5.4`
/// 3. 剥离 ISO 日期后缀：`gpt-5.4-2026-03-05` → `gpt-5.4`
/// 4. 剥离紧凑日期后缀：`gpt-5.4-20260305` → `gpt-5.4`
fn normalize_codex_model(raw: &str) -> String {
    // Step 1: 小写
    let mut name = raw.to_lowercase();

    // Step 2: 剥离 "provider/" 前缀（如 openai/, azure/）
    if let Some(pos) = name.rfind('/') {
        name = name[pos + 1..].to_string();
    }

    // Step 3: 剥离 ISO 日期后缀 -YYYY-MM-DD（正好 11 字符）
    if name.len() > 11 && name.is_char_boundary(name.len() - 11) {
        let suffix = &name[name.len() - 11..];
        if suffix.is_ascii()
            && suffix.as_bytes()[0] == b'-'
            && suffix[1..5].chars().all(|c| c.is_ascii_digit())
            && suffix.as_bytes()[5] == b'-'
            && suffix[6..8].chars().all(|c| c.is_ascii_digit())
            && suffix.as_bytes()[8] == b'-'
            && suffix[9..11].chars().all(|c| c.is_ascii_digit())
        {
            name.truncate(name.len() - 11);
        }
    }

    // Step 4: 剥离紧凑日期后缀 -YYYYMMDD（正好 9 字符）
    if name.len() > 9 {
        let parts: Vec<&str> = name.rsplitn(2, '-').collect();
        if parts.len() == 2 {
            if let Some(suffix) = parts.first() {
                if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
                    name = parts[1].to_string();
                }
            }
        }
    }

    name
}

/// 计算两次累计值之间的 delta
fn compute_delta(prev: &Option<CumulativeTokens>, current: &CumulativeTokens) -> DeltaTokens {
    match prev {
        None => DeltaTokens {
            input: current.input as u32,
            cached_input: current.cached_input as u32,
            output: current.output as u32,
        },
        Some(p) => DeltaTokens {
            input: current.input.saturating_sub(p.input) as u32,
            cached_input: current.cached_input.saturating_sub(p.cached_input) as u32,
            output: current.output.saturating_sub(p.output) as u32,
        },
    }
}

/// 从 JSON Value 中提取累计 token 用量
fn parse_cumulative_tokens(total_usage: &serde_json::Value) -> Option<CumulativeTokens> {
    if total_usage.is_null() || !total_usage.is_object() {
        return None;
    }
    Some(CumulativeTokens {
        input: total_usage
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cached_input: total_usage
            .get("cached_input_tokens")
            .or_else(|| total_usage.get("cache_read_input_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        output: total_usage
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    })
}

type RolloutIndex = HashMap<String, Vec<PathBuf>>;

#[derive(Debug, Default)]
struct CodexFileSyncResult {
    imported: u32,
    skipped: u32,
    suspected_duplicates: u32,
    deferred: bool,
}

/// 同步 Codex 使用数据（从 JSONL 会话日志）
pub fn sync_codex_usage(db: &Database) -> Result<SessionSyncResult, AppError> {
    let codex_dir = get_codex_config_dir();
    let files = collect_codex_session_files(&codex_dir)?;
    sync_codex_files(db, &files, false)
}

fn sync_codex_files(
    db: &Database,
    files: &[PathBuf],
    strict: bool,
) -> Result<SessionSyncResult, AppError> {
    let rollout_index = build_rollout_index(files);

    let mut result = SessionSyncResult {
        imported: 0,
        skipped: 0,
        files_scanned: files.len() as u32,
        suspected_duplicates: 0,
        deferred_files: 0,
        errors: vec![],
    };

    for file_path in files {
        match sync_single_codex_file(db, file_path, &rollout_index, strict) {
            Ok(file_result) => {
                result.imported = result.imported.saturating_add(file_result.imported);
                result.skipped = result.skipped.saturating_add(file_result.skipped);
                result.suspected_duplicates = result
                    .suspected_duplicates
                    .saturating_add(file_result.suspected_duplicates);
                if file_result.deferred {
                    result.deferred_files = result.deferred_files.saturating_add(1);
                }
            }
            Err(e) => {
                let msg = format!("Codex 会话文件解析失败 {}: {e}", file_path.display());
                log::warn!("[CODEX-SYNC] {msg}");
                result.errors.push(msg);
            }
        }
    }

    if result.imported > 0 || result.deferred_files > 0 {
        log::info!(
            "[CODEX-SYNC] 同步完成: 导入 {} 条, 跳过 {} 条, deferred {} 个, 扫描 {} 个文件",
            result.imported,
            result.skipped,
            result.deferred_files,
            result.files_scanned
        );
    }

    Ok(result)
}

/// Prepare independently, then replace only Codex-owned rows in one transaction.
/// The caller holds session_sync_mutex; unrelated live proxy records are preserved.
pub(crate) fn rebuild_codex_usage(db: &Database) -> Result<SessionSyncResult, AppError> {
    rebuild_codex_usage_from_dir(db, &get_codex_config_dir())
}

fn rebuild_codex_usage_from_dir(
    db: &Database,
    codex_dir: &Path,
) -> Result<SessionSyncResult, AppError> {
    let files = collect_codex_session_files(codex_dir)?;
    if files.is_empty() {
        return Err(AppError::Config(
            "未找到可重建的 Codex 会话文件，原统计未修改".into(),
        ));
    }
    let source_state = || -> Result<Vec<(u64, i64)>, AppError> {
        files
            .iter()
            .map(|file| {
                let meta = fs::metadata(file)
                    .map_err(|e| AppError::Config(format!("读取会话来源失败: {e}")))?;
                Ok((meta.len(), metadata_modified_nanos(&meta)))
            })
            .collect()
    };
    let before = source_state()?;
    let mut staging =
        rusqlite::Connection::open_in_memory().map_err(|e| AppError::Database(e.to_string()))?;
    {
        let conn = lock_conn!(db.conn);
        let backup = rusqlite::backup::Backup::new(&conn, &mut staging)
            .map_err(|e| AppError::Database(e.to_string()))?;
        backup
            .run_to_completion(128, std::time::Duration::from_millis(1), None)
            .map_err(|e| AppError::Database(e.to_string()))?;
    }
    reset_codex_usage_on_conn(&staging, codex_dir)?;
    let staging = Database {
        conn: Mutex::new(staging),
    };
    clear_codex_replay_caches();
    let result = sync_codex_files(&staging, &files, true);
    clear_codex_replay_caches();
    let mut result = result?;
    if !result.errors.is_empty() || result.deferred_files > 0 {
        return Err(AppError::Message(format!(
            "会话导入不完整，原统计未修改：{} 个错误，{} 个待处理文件。{}",
            result.errors.len(),
            result.deferred_files,
            result.errors.join("; ")
        )));
    }
    if result.imported == 0 && result.skipped == 0 {
        return Err(AppError::Message("未导入可用会话记录，原统计未修改".into()));
    }
    if files != collect_codex_session_files(codex_dir)? || before != source_state()? {
        return Err(AppError::Message(
            "会话文件在重建期间发生变化，请稍后重试；原统计未修改".into(),
        ));
    }
    let source = lock_conn!(staging.conn);
    let mut conn = lock_conn!(db.conn);
    let tx = conn
        .transaction()
        .map_err(|e| AppError::Database(e.to_string()))?;
    reset_codex_usage_on_conn(&tx, codex_dir)?;
    for (table, filter) in [
        ("proxy_request_logs", "data_source = 'codex_session'"),
        ("session_log_sync", "1 = 1"),
    ] {
        let mut stmt = source
            .prepare(&format!("SELECT * FROM {table} WHERE {filter}"))
            .map_err(|e| AppError::Database(e.to_string()))?;
        let columns = stmt.column_count();
        let path_column = if table == "session_log_sync" {
            Some(
                stmt.column_index("file_path")
                    .map_err(|e| AppError::Database(e.to_string()))?,
            )
        } else {
            None
        };
        let rows = stmt
            .query_map([], |row| {
                (0..columns)
                    .map(|i| row.get::<_, rusqlite::types::Value>(i))
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        let placeholders = vec!["?"; columns].join(",");
        for row in rows {
            let values = row.map_err(|e| AppError::Database(e.to_string()))?;
            if let Some(index) = path_column {
                let rusqlite::types::Value::Text(path) = &values[index] else {
                    continue;
                };
                if !is_codex_cursor_path(path, codex_dir) {
                    continue;
                }
            }
            tx.execute(
                &format!("INSERT INTO {table} VALUES ({placeholders})"),
                rusqlite::params_from_iter(values),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
    }
    // Proxy traffic/archival can advance while the in-memory replay runs.
    // Recheck against live receipts inside the replacement transaction.
    let effective_filter = effective_usage_log_filter(&tx, "proxy_request_logs")?;
    let newly_skipped = tx.execute(
        &format!("DELETE FROM proxy_request_logs WHERE data_source = 'codex_session' AND NOT ({effective_filter})"),
        [],
    ).map_err(|e| AppError::Database(format!("校验重建用量去重失败: {e}")))?;
    let newly_skipped = u32::try_from(newly_skipped).unwrap_or(u32::MAX);
    result.imported = result.imported.saturating_sub(newly_skipped);
    result.skipped = result.skipped.saturating_add(newly_skipped);
    tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
    Ok(result)
}

/// 收集所有 Codex 会话 JSONL 文件
fn collect_codex_session_files(codex_dir: &Path) -> Result<Vec<PathBuf>, AppError> {
    let mut files = Vec::new();
    for name in ["sessions", "archived_sessions"] {
        let dir = codex_dir.join(name);
        match fs::symlink_metadata(&dir) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(AppError::Config(format!(
                    "无法读取 {}: {error}",
                    dir.display()
                )))
            }
            Ok(_) => {}
        }
        files.extend(
            collect_files_with_extensions(&dir, &["jsonl", "zst"], MAX_SESSION_SCAN_DEPTH)
                .map_err(|error| {
                    AppError::Config(format!("无法扫描 {}: {error}", dir.display()))
                })?,
        );
    }
    files.sort();
    Ok(files)
}

fn build_rollout_index(files: &[PathBuf]) -> RolloutIndex {
    let mut index = RolloutIndex::new();
    for path in files {
        if let Some(thread_id) = thread_id_from_filename(path) {
            index.entry(thread_id).or_default().push(path.clone());
        }
    }
    for paths in index.values_mut() {
        paths.sort();
    }
    index
}

const MAX_CODEX_COMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CODEX_DECOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;

/// Unlike Read::take, exhausting a budget is an error, not a successful EOF.
/// Probe at most one extra byte so an exact-size stream can still finish.
struct RolloutByteLimit<R> {
    inner: R,
    remaining: u64,
}

impl<R: Read> Read for RolloutByteLimit<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let len = (buf.len() as u64).min(self.remaining.saturating_add(1)) as usize;
        let count = self.inner.read(&mut buf[..len])?;
        if count as u64 > self.remaining {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Codex 压缩输入或解压输出超过大小限制",
            ));
        }
        self.remaining -= count as u64;
        Ok(count)
    }
}

fn bounded_zstd_reader<R: Read>(
    reader: R,
    compressed_limit: u64,
    decompressed_limit: u64,
) -> io::Result<impl BufRead> {
    let mut decoder = zstd::stream::read::Decoder::new(RolloutByteLimit {
        inner: reader,
        remaining: compressed_limit,
    })?;
    // Bound the decoder's internal history too, before it reads frame headers.
    decoder.window_log_max(26)?; // 64 MiB, independent of the output buffer.
    Ok(BufReader::new(RolloutByteLimit {
        inner: decoder,
        remaining: decompressed_limit,
    }))
}

fn parse_codex_file(
    file_path: &Path,
    root_thread_id: Option<String>,
    strict: bool,
) -> Result<ParsedCodexFile, AppError> {
    let file = open_regular_file_no_symlink(file_path)
        .map_err(|e| AppError::Config(format!("无法打开文件: {e}")))?;
    // Stream plaintext directly into the existing capped line parser. Both
    // budgets fail closed; no partial file is imported or acknowledged.
    let mut reader: Box<dyn BufRead> = if file_path.to_string_lossy().ends_with(".jsonl.zst") {
        if file
            .metadata()
            .map_err(|e| AppError::Config(e.to_string()))?
            .len()
            > MAX_CODEX_COMPRESSED_BYTES
        {
            return Err(AppError::Config("压缩 Codex 会话超过输入大小限制".into()));
        }
        Box::new(
            bounded_zstd_reader(
                file,
                MAX_CODEX_COMPRESSED_BYTES,
                MAX_CODEX_DECOMPRESSED_BYTES,
            )
            .map_err(|e| AppError::Config(format!("无法解压 Codex 会话文件: {e}")))?,
        )
    } else {
        Box::new(BufReader::new(file))
    };
    let mut source_session_id = root_thread_id.clone();
    let mut root_meta_seen = false;
    let mut root_timestamp = None;
    let mut parent = ParentResolution::None;
    let mut current_model = "unknown".to_string();
    let mut prev_total: Option<CumulativeTokens> = None;
    let mut event_index = 0u32;
    let mut token_events = Vec::new();
    let mut line_offset = 0i64;
    let mut has_billable_tokens = false;
    let mut incomplete_tail = false;

    while let Some((raw_line, truncated, terminated)) =
        read_capped_line(&mut reader, MAX_SESSION_LINE_BYTES)
            .map_err(|e| AppError::Config(format!("读取文件失败: {e}")))?
    {
        // A writer may still be appending this JSONL tail. Never acknowledge
        // an incomplete line; a complete JSON value without a newline is valid.
        if !terminated
            && (truncated || serde_json::from_slice::<serde_json::Value>(&raw_line).is_err())
        {
            incomplete_tail = true;
            break;
        }
        line_offset += 1;
        if truncated {
            if strict {
                return Err(AppError::Config(format!(
                    "第 {line_offset} 行超过大小限制，重建已取消"
                )));
            }
            log::warn!(
                "[CODEX-SYNC] 跳过超长行（>{MAX_SESSION_LINE_BYTES} 字节，可能是畸形数据）: {} 第 {line_offset} 行",
                file_path.display()
            );
            continue;
        }
        let Ok(line) = String::from_utf8(raw_line) else {
            if strict {
                return Err(AppError::Config(format!(
                    "第 {line_offset} 行不是有效 UTF-8"
                )));
            }
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }

        let validated: Option<serde_json::Value> = if strict {
            Some(
                serde_json::from_str(&line)
                    .map_err(|e| AppError::Config(format!("第 {line_offset} 行 JSON 无效: {e}")))?,
            )
        } else {
            None
        };
        let is_event_msg = line.contains("\"event_msg\"");
        let is_turn_context = line.contains("\"turn_context\"");
        let is_session_meta = line.contains("\"session_meta\"");
        if !is_event_msg && !is_turn_context && !is_session_meta {
            continue;
        }
        if is_event_msg && !line.contains("\"token_count\"") {
            continue;
        }

        let value: serde_json::Value = if let Some(value) = validated {
            value
        } else {
            match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            }
        };
        let Some(event_type) = value.get("type").and_then(serde_json::Value::as_str) else {
            continue;
        };

        match event_type {
            "session_meta" if !root_meta_seen => {
                root_meta_seen = true;
                root_timestamp = parse_timestamp(value.get("timestamp"));
                let payload = value.get("payload").unwrap_or(&serde_json::Value::Null);
                parent = explicit_parent_from_meta(payload);

                let meta_thread_id = non_empty_string(
                    payload
                        .get("id")
                        .or_else(|| payload.get("thread_id"))
                        .or_else(|| payload.get("threadId")),
                );
                if let Some(meta_id) = meta_thread_id.as_ref() {
                    source_session_id = Some(meta_id.clone());
                }
                // Codex's revert/resume writes a fresh rollout whose file name
                // carries a new UUID while `session_meta.id` keeps the thread's
                // original id. Those files were deferred as "inconsistent" and,
                // since neither id ever changes, deferred forever — every token
                // the resumed thread spent from then on went unrecorded. The
                // file's own UUID stays the accounting key (its events are new,
                // so nothing is double counted against the original rollout).
                // The metadata ID, not the file UUID, is the shared proxy/session
                // identity used for cross-source matching on resumed rollouts.
                if let (Some(filename_id), Some(meta_id)) = (&root_thread_id, meta_thread_id) {
                    if filename_id != &meta_id {
                        log::debug!(
                            "[CODEX-SYNC] rollout {} continues thread {meta_id} under file id {filename_id} (revert/resume)",
                            file_path.display()
                        );
                    }
                }

                if let ParentResolution::Parent(parent_id) = &mut parent {
                    match uuid::Uuid::parse_str(parent_id) {
                        Ok(value) => *parent_id = value.hyphenated().to_string(),
                        Err(_) => {
                            parent = ParentResolution::Deferred(format!(
                                "显式 parent_thread_id 不是有效 UUID: {parent_id}"
                            ));
                        }
                    }
                }
                if matches!((&root_thread_id, &parent), (Some(root), ParentResolution::Parent(parent_id)) if root == parent_id)
                {
                    parent = ParentResolution::Deferred(
                        "parent_thread_id 与 root_thread_id 相同".to_string(),
                    );
                }
            }
            "turn_context" => {
                if let Some(payload) = value.get("payload") {
                    if let Some(model) = payload
                        .get("model")
                        .or_else(|| payload.get("info").and_then(|info| info.get("model")))
                        .and_then(serde_json::Value::as_str)
                    {
                        current_model = normalize_codex_model(model);
                    }
                }
            }
            "event_msg" => {
                let Some(payload) = value.get("payload") else {
                    continue;
                };
                if payload.get("type").and_then(serde_json::Value::as_str) != Some("token_count") {
                    continue;
                }
                let Some(info) = payload.get("info").filter(|info| !info.is_null()) else {
                    continue;
                };
                let Some(signature) = parse_token_signature(info) else {
                    continue;
                };

                if let Some(model) = info
                    .get("model")
                    .or_else(|| info.get("model_name"))
                    .or_else(|| payload.get("model"))
                    .and_then(serde_json::Value::as_str)
                {
                    current_model = normalize_codex_model(model);
                }

                let (cumulative, is_total) = if let Some(total) = info.get("total_token_usage") {
                    (parse_cumulative_tokens(total), true)
                } else if let Some(last) = info.get("last_token_usage") {
                    (parse_cumulative_tokens(last), false)
                } else {
                    continue;
                };
                let Some(cumulative) = cumulative else {
                    continue;
                };
                let delta = if is_total {
                    let delta = compute_delta(&prev_total, &cumulative);
                    prev_total = Some(cumulative);
                    delta
                } else {
                    DeltaTokens {
                        input: cumulative.input as u32,
                        cached_input: cumulative.cached_input as u32,
                        output: cumulative.output as u32,
                    }
                };
                let delta = DeltaTokens {
                    cached_input: delta.cached_input.min(delta.input),
                    ..delta
                };
                let nonzero_index = if delta.is_zero() {
                    None
                } else {
                    has_billable_tokens = true;
                    event_index = event_index.saturating_add(1);
                    Some(event_index)
                };

                token_events.push(ParsedTokenEvent {
                    line_offset,
                    signature,
                    delta,
                    event_index: nonzero_index,
                    model: current_model.clone(),
                    timestamp: value
                        .get("timestamp")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                });
            }
            _ => {}
        }
    }

    Ok(ParsedCodexFile {
        root_thread_id,
        source_session_id,
        root_meta_seen,
        root_timestamp,
        parent,
        token_events,
        line_offset,
        has_billable_tokens,
        incomplete_tail,
    })
}

fn parent_signatures_before(
    parent_path: &Path,
    cutoff: DateTime<Utc>,
) -> Result<Vec<TokenUsageSignature>, String> {
    let cache_key = (parent_path.to_path_buf(), cutoff.timestamp_micros());
    if let Ok(caches) = replay_caches().lock() {
        if let Some(signatures) = caches.parent_signatures.get(&cache_key) {
            return Ok(signatures.clone());
        }
    }

    let file = open_regular_file_no_symlink(parent_path)
        .map_err(|error| format!("无法打开父 rollout {}: {error}", parent_path.display()))?;
    let mut signatures = Vec::new();
    let mut max_timestamp: Option<DateTime<Utc>> = None;
    let mut reader = BufReader::new(file);

    // 必须扫描完整父文件并逐行应用 cutoff，不能在首个未来时间戳处 break：
    // rollout 写入顺序不承诺时间戳严格单调。
    while let Some((raw_line, truncated, terminated)) =
        read_capped_line(&mut reader, MAX_SESSION_LINE_BYTES)
            .map_err(|error| format!("读取父 rollout {} 失败: {error}", parent_path.display()))?
    {
        if !terminated
            && (truncated || serde_json::from_slice::<serde_json::Value>(&raw_line).is_err())
        {
            return Err(format!(
                "父 rollout {} 的尾行尚未写完",
                parent_path.display()
            ));
        }
        if truncated {
            log::warn!(
                "[CODEX-SYNC] 跳过父 rollout 超长行（>{MAX_SESSION_LINE_BYTES} 字节）: {}",
                parent_path.display()
            );
            continue;
        }
        let Ok(line) = String::from_utf8(raw_line) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let timestamp = parse_timestamp(value.get("timestamp"));
        if let Some(timestamp) = timestamp {
            max_timestamp = Some(max_timestamp.map_or(timestamp, |current| current.max(timestamp)));
        }
        if value.get("type").and_then(serde_json::Value::as_str) != Some("event_msg")
            || value
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(serde_json::Value::as_str)
                != Some("token_count")
        {
            continue;
        }
        let Some(info) = value
            .get("payload")
            .and_then(|payload| payload.get("info"))
            .filter(|info| !info.is_null())
        else {
            continue;
        };
        let Some(signature) = parse_token_signature(info) else {
            continue;
        };
        let Some(timestamp) = timestamp else {
            return Err(format!(
                "父 rollout {} 的 token_count 缺少有效 timestamp",
                parent_path.display()
            ));
        };
        if timestamp <= cutoff {
            signatures.push(signature);
        }
    }

    if max_timestamp.is_none_or(|timestamp| timestamp < cutoff) {
        return Err(format!(
            "父 rollout {} 尚未写到 child fork 时刻",
            parent_path.display()
        ));
    }

    if let Ok(mut caches) = replay_caches().lock() {
        caches
            .parent_signatures
            .insert(cache_key, signatures.clone());
    }
    Ok(signatures)
}

fn resolve_parent_signatures(
    parent_id: &str,
    cutoff: DateTime<Utc>,
    rollout_index: &RolloutIndex,
) -> Result<Vec<TokenUsageSignature>, String> {
    let Some(candidates) = rollout_index.get(parent_id) else {
        return Err(format!("找不到父 rollout: {parent_id}"));
    };

    let mut snapshots = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        snapshots.push(parent_signatures_before(candidate, cutoff)?);
    }
    let Some(first) = snapshots.first() else {
        return Err(format!("找不到父 rollout: {parent_id}"));
    };
    if snapshots.iter().skip(1).any(|snapshot| snapshot != first) {
        return Err(format!(
            "父 rollout UUID {parent_id} 对应多个内容不一致的文件"
        ));
    }
    Ok(first.clone())
}

fn matching_replay_prefix(child: &[ParsedTokenEvent], parent: &[TokenUsageSignature]) -> usize {
    let mut parent_offset = 0usize;
    let mut matched = 0usize;
    for event in child {
        let Some(relative_match) = parent[parent_offset..]
            .iter()
            .position(|signature| signature == &event.signature)
        else {
            break;
        };
        parent_offset += relative_match + 1;
        matched += 1;
    }
    matched
}

fn mark_deferred(
    file_path: &Path,
    modified: i64,
    size: u64,
    reason: PendingReason,
) -> CodexFileSyncResult {
    let entry = PendingEntry {
        modified,
        size,
        reason,
    };
    let should_warn = replay_caches()
        .lock()
        .ok()
        .and_then(|mut caches| {
            caches
                .pending
                .insert(file_path.to_path_buf(), entry.clone())
        })
        .as_ref()
        != Some(&entry);
    if should_warn {
        let reason = match &entry.reason {
            PendingReason::MissingParent(parent) => format!("找不到父 rollout {parent}"),
            PendingReason::Stable(reason) | PendingReason::Retryable(reason) => reason.clone(),
        };
        log::warn!("[CODEX-SYNC] deferred {}: {reason}", file_path.display());
    }
    CodexFileSyncResult {
        deferred: true,
        ..CodexFileSyncResult::default()
    }
}

/// 同步单个 Codex JSONL 文件。
fn sync_single_codex_file(
    db: &Database,
    file_path: &Path,
    rollout_index: &RolloutIndex,
    strict: bool,
) -> Result<CodexFileSyncResult, AppError> {
    let file_path_str = file_path.to_string_lossy().to_string();

    // 获取文件元数据
    let metadata = fs::metadata(file_path)
        .map_err(|e| AppError::Config(format!("无法读取文件元数据: {e}")))?;
    let file_modified = metadata_modified_nanos(&metadata);
    let file_size = metadata.len();

    // 检查同步状态
    let (last_modified, last_offset, last_file_size) = get_codex_sync_state(db, file_path)?;

    // 文件未变化则跳过
    if file_modified == last_modified && last_file_size == Some(file_size) {
        return Ok(CodexFileSyncResult::default());
    }

    if let Ok(mut caches) = replay_caches().lock() {
        if let Some(pending) = caches.pending.get(file_path).cloned() {
            if pending.modified == file_modified && pending.size == file_size {
                match &pending.reason {
                    PendingReason::MissingParent(parent) if !rollout_index.contains_key(parent) => {
                        return Ok(CodexFileSyncResult {
                            deferred: true,
                            ..CodexFileSyncResult::default()
                        });
                    }
                    PendingReason::Stable(_) => {
                        return Ok(CodexFileSyncResult {
                            deferred: true,
                            ..CodexFileSyncResult::default()
                        });
                    }
                    PendingReason::Retryable(_) => {
                        caches.pending.remove(file_path);
                    }
                    _ => {
                        caches.pending.remove(file_path);
                    }
                }
            }
        }
    }

    let parsed = parse_codex_file(file_path, thread_id_from_filename(file_path), strict)?;
    // Retry unfinished tails even if the writer's timestamp has coarse resolution.
    let acknowledged_modified = if parsed.incomplete_tail {
        0
    } else {
        file_modified
    };
    let acknowledged_size = (!parsed.incomplete_tail).then_some(file_size);
    if !parsed.has_billable_tokens {
        update_codex_sync_state(
            db,
            &file_path_str,
            acknowledged_modified,
            parsed.line_offset,
            acknowledged_size,
        )?;
        return Ok(CodexFileSyncResult {
            deferred: parsed.incomplete_tail,
            ..Default::default()
        });
    }
    let Some(root_thread_id) = parsed.root_thread_id.as_deref() else {
        return Ok(mark_deferred(
            file_path,
            file_modified,
            file_size,
            PendingReason::Stable("文件名缺少有效的尾部 UUID".to_string()),
        ));
    };
    if !parsed.root_meta_seen {
        return Ok(mark_deferred(
            file_path,
            file_modified,
            file_size,
            PendingReason::Stable("含计费 token 但尚无 session_meta".to_string()),
        ));
    }

    let replay_prefix = match &parsed.parent {
        ParentResolution::None => 0,
        ParentResolution::Deferred(reason) => {
            return Ok(mark_deferred(
                file_path,
                file_modified,
                file_size,
                PendingReason::Stable(reason.clone()),
            ));
        }
        ParentResolution::Parent(parent_id) => {
            let Some(cutoff) = parsed.root_timestamp else {
                return Ok(mark_deferred(
                    file_path,
                    file_modified,
                    file_size,
                    PendingReason::Stable(
                        "parented rollout 的 root meta 缺少有效 timestamp".to_string(),
                    ),
                ));
            };
            let cache_key = (file_path.to_path_buf(), file_modified, file_size);
            if let Ok(caches) = replay_caches().lock() {
                if let Some(prefix) = caches.replay_prefixes.get(&cache_key) {
                    *prefix
                } else {
                    drop(caches);
                    let parent_signatures =
                        match resolve_parent_signatures(parent_id, cutoff, rollout_index) {
                            Ok(signatures) => signatures,
                            Err(reason) => {
                                let pending_reason = if rollout_index.contains_key(parent_id) {
                                    PendingReason::Retryable(reason)
                                } else {
                                    PendingReason::MissingParent(parent_id.clone())
                                };
                                return Ok(mark_deferred(
                                    file_path,
                                    file_modified,
                                    file_size,
                                    pending_reason,
                                ));
                            }
                        };
                    let prefix = matching_replay_prefix(&parsed.token_events, &parent_signatures);
                    if let Ok(mut caches) = replay_caches().lock() {
                        caches.replay_prefixes.insert(cache_key, prefix);
                    }
                    prefix
                }
            } else {
                let parent_signatures = resolve_parent_signatures(parent_id, cutoff, rollout_index)
                    .map_err(AppError::Config)?;
                matching_replay_prefix(&parsed.token_events, &parent_signatures)
            }
        }
    };

    if let Ok(mut caches) = replay_caches().lock() {
        caches.pending.remove(file_path);
    }

    let mut result = CodexFileSyncResult {
        deferred: parsed.incomplete_tail,
        ..Default::default()
    };
    // 整个文件共用一次锁 + 单事务批量提交（v2.5.0 G7）：旧实现每个 token
    // 事件独立取 Mutex 并隐式提交，大历史库导入时明显拖慢并阻塞 UI 查询。
    let conn = lock_conn!(db.conn);
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::Database(format!("开启导入事务失败: {e}")))?;
    for (token_offset, event) in parsed.token_events.iter().enumerate() {
        let Some(event_index) = event.event_index else {
            continue;
        };
        if token_offset < replay_prefix {
            if event.line_offset > last_offset {
                result.skipped = result.skipped.saturating_add(1);
            }
            continue;
        }
        if event.line_offset <= last_offset {
            continue;
        }

        let request_id = format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{root_thread_id}:{event_index}");
        match insert_codex_session_entry(
            &tx,
            &request_id,
            &event.delta,
            &event.model,
            parsed.source_session_id.as_deref(),
            event.timestamp.as_deref(),
            &mut result.suspected_duplicates,
        ) {
            Ok(true) => result.imported = result.imported.saturating_add(1),
            Ok(false) => result.skipped = result.skipped.saturating_add(1),
            Err(e) => return Err(e),
        }
    }
    tx.commit()
        .map_err(|e| AppError::Database(format!("提交导入事务失败: {e}")))?;
    drop(conn);

    update_codex_sync_state(
        db,
        &file_path_str,
        acknowledged_modified,
        parsed.line_offset,
        acknowledged_size,
    )?;
    Ok(result)
}

/// 插入单条 Codex 会话记录到 proxy_request_logs
///
/// 调用方负责持锁并（可选地）套事务：批量导入路径传入同一个
/// `Transaction`（Deref 到 `Connection`），单元测试可直接传裸连接。
fn insert_codex_session_entry(
    conn: &rusqlite::Connection,
    request_id: &str,
    delta: &DeltaTokens,
    model: &str,
    session_id: Option<&str>,
    timestamp: Option<&str>,
    suspected_duplicates: &mut u32,
) -> Result<bool, AppError> {
    let created_at = timestamp
        .and_then(|ts| {
            chrono::DateTime::parse_from_rfc3339(ts)
                .ok()
                .map(|dt| dt.timestamp())
        })
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        });

    let dedup_key = DedupKey {
        session_id,
        app_type: "codex",
        model,
        input_tokens: delta.input,
        output_tokens: delta.output,
        cache_read_tokens: delta.cached_input,
        cache_creation_tokens: 0,
        created_at,
    };
    if should_skip_session_insert(conn, request_id, &dedup_key)? {
        return Ok(false);
    }
    if has_suspected_codex_session_duplicate(conn, request_id, &dedup_key)? {
        *suspected_duplicates = suspected_duplicates.saturating_add(1);
        log::warn!(
            "[CODEX-SYNC] 疑似重复会话用量: request_id={request_id}, model={model}, input={}, output={}, cache_read={}",
            delta.input,
            delta.output,
            delta.cached_input
        );
    }

    // 计算费用
    let usage = TokenUsage {
        input_tokens: delta.input,
        output_tokens: delta.output,
        cache_read_tokens: delta.cached_input,
        cache_creation_tokens: 0,
        model: Some(model.to_string()),
        message_id: None,
    };

    let pricing = find_codex_pricing(conn, model);
    let multiplier = Decimal::from(1);
    let (input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost) = match pricing
    {
        Some(p) => {
            let cost = CostCalculator::calculate_for_app("codex", &usage, &p, multiplier);
            (
                cost.input_cost.to_string(),
                cost.output_cost.to_string(),
                cost.cache_read_cost.to_string(),
                cost.cache_creation_cost.to_string(),
                cost.total_cost.to_string(),
            )
        }
        None => (
            "0".to_string(),
            "0".to_string(),
            "0".to_string(),
            "0".to_string(),
            "0".to_string(),
        ),
    };

    let inserted_rows = conn
        .execute(
            "INSERT OR IGNORE INTO proxy_request_logs (
            request_id, provider_id, app_type, model, request_model,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
            latency_ms, first_token_ms, status_code, error_message, session_id,
            provider_type, is_streaming, cost_multiplier, created_at, data_source
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
            rusqlite::params![
                request_id,
                "_codex_session",    // provider_id
                "codex",             // app_type
                model,
                model,               // request_model = model
                delta.input,
                delta.output,
                delta.cached_input,
                0i64,                // cache_creation_tokens: Codex 日志无此数据
                input_cost,
                output_cost,
                cache_read_cost,
                cache_creation_cost,
                total_cost,
                0i64,                // latency_ms
                Option::<i64>::None, // first_token_ms
                200i64,              // status_code
                Option::<String>::None, // error_message
                session_id.map(|s| s.to_string()),
                Some("codex_session"), // provider_type
                1i64,                // is_streaming
                "1.0",               // cost_multiplier
                created_at,
                "codex_session",     // data_source
            ],
        )
        .map_err(|e| AppError::Database(format!("插入 Codex 会话日志失败: {e}")))?;

    Ok(inserted_rows > 0)
}

/// 查找 Codex 模型定价（带归一化）
fn find_codex_pricing(conn: &rusqlite::Connection, model_id: &str) -> Option<ModelPricing> {
    find_model_pricing(conn, &normalize_codex_model(model_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::session_usage::{get_sync_state, update_sync_state};
    use std::io::Write;
    use tempfile::tempdir;

    const PARENT_ID: &str = "00000000-0000-4000-8000-000000000001";
    const CHILD_A_ID: &str = "00000000-0000-4000-8000-000000000002";
    const CHILD_B_ID: &str = "00000000-0000-4000-8000-000000000003";

    fn write_jsonl(path: &Path, values: &[serde_json::Value]) {
        let contents = values
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(path, contents).unwrap();
    }

    fn rollout_path(dir: &Path, thread_id: &str) -> PathBuf {
        dir.join(format!("rollout-2026-07-10T03-00-00-{thread_id}.jsonl"))
    }

    fn session_meta_at(
        thread_id: &str,
        forked_from_id: Option<&str>,
        spawned_from_id: Option<&str>,
        timestamp: &str,
    ) -> serde_json::Value {
        let source = spawned_from_id.map_or_else(
            || serde_json::Value::String("cli".to_string()),
            |parent| {
                serde_json::json!({
                    "subagent": {
                        "thread_spawn": { "parent_thread_id": parent }
                    }
                })
            },
        );
        serde_json::json!({
            "timestamp": timestamp,
            "type": "session_meta",
            "payload": {
                "id": thread_id,
                "forked_from_id": forked_from_id,
                "source": source
            }
        })
    }

    fn session_meta(thread_id: &str) -> serde_json::Value {
        session_meta_at(thread_id, None, None, "2026-07-10T03:00:00Z")
    }

    fn turn_context_at(timestamp: &str) -> serde_json::Value {
        serde_json::json!({
            "timestamp": timestamp,
            "type": "turn_context",
            "payload": { "model": "gpt-5.6-sol" }
        })
    }

    fn turn_context() -> serde_json::Value {
        turn_context_at("2026-07-10T03:00:01Z")
    }

    fn token_count_at(input: u64, cached: u64, output: u64, timestamp: &str) -> serde_json::Value {
        serde_json::json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": { "total_token_usage": {
                    "input_tokens": input,
                    "cached_input_tokens": cached,
                    "output_tokens": output,
                    "reasoning_output_tokens": 0,
                    "total_tokens": input + output
                }}
            }
        })
    }

    fn token_count(input: u64, cached: u64, output: u64) -> serde_json::Value {
        token_count_at(input, cached, output, "2026-07-10T03:00:02Z")
    }

    fn sync_test_file(
        db: &Database,
        file: &Path,
        all_files: &[&Path],
    ) -> Result<CodexFileSyncResult, AppError> {
        let files = all_files
            .iter()
            .map(|path| path.to_path_buf())
            .collect::<Vec<_>>();
        sync_single_codex_file(db, file, &build_rollout_index(&files), false)
    }

    #[test]
    fn same_mtime_append_imports_only_new_usage() -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let file = rollout_path(temp.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count(100, 50, 10),
            ],
        );
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
        let before = get_codex_sync_state(&db, &file)?;
        let mut writer = fs::OpenOptions::new().append(true).open(&file).unwrap();
        writeln!(writer, "{}", token_count(200, 100, 20)).unwrap();
        writer.set_modified(modified).unwrap();
        assert_eq!(
            metadata_modified_nanos(&fs::metadata(&file).unwrap()),
            before.0
        );
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 0);
        let after = get_codex_sync_state(&db, &file)?;
        assert_eq!(after.1, 4);
        assert_eq!(after.2, Some(fs::metadata(&file).unwrap().len()));
        assert!(after.2 > before.2);
        let totals: (i64, i64, i64, i64) = lock_conn!(db.conn).query_row(
            "SELECT COUNT(*), SUM(input_tokens), SUM(cache_read_tokens), SUM(output_tokens)
             FROM proxy_request_logs WHERE data_source = 'codex_session'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(totals, (2, 200, 100, 20));
        Ok(())
    }

    #[test]
    fn archived_rollout_preserves_size_and_detects_same_mtime_growth() -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        let archived = temp.path().join("archived_sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&archived).unwrap();
        let source = rollout_path(&sessions, PARENT_ID);
        let target = rollout_path(&archived, PARENT_ID);
        write_jsonl(
            &source,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count(100, 50, 10),
            ],
        );
        assert_eq!(sync_test_file(&db, &source, &[&source])?.imported, 1);
        let state = get_codex_sync_state(&db, &source)?;
        let modified = fs::metadata(&source).unwrap().modified().unwrap();
        fs::rename(&source, &target).unwrap();
        assert_eq!(get_codex_sync_state(&db, &target)?, state);
        assert_eq!(sync_test_file(&db, &target, &[&target])?.imported, 0);
        let mut writer = fs::OpenOptions::new().append(true).open(&target).unwrap();
        writeln!(writer, "{}", token_count(200, 100, 20)).unwrap();
        writer.set_modified(modified).unwrap();
        assert_eq!(sync_test_file(&db, &target, &[&target])?.imported, 1);
        assert_eq!(sync_test_file(&db, &target, &[&target])?.imported, 0);
        assert_eq!(get_codex_sync_state(&db, &target)?.1, 4);
        Ok(())
    }

    #[test]
    fn legacy_null_size_rescans_once_preserving_cursor() -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let file = rollout_path(temp.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count(100, 50, 10),
                token_count(200, 100, 20),
            ],
        );
        let modified = metadata_modified_nanos(&fs::metadata(&file).unwrap());
        update_sync_state(&db, &file.to_string_lossy(), modified, 3)?;
        assert_eq!(get_codex_sync_state(&db, &file)?.2, None);
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
        assert_eq!(
            get_codex_sync_state(&db, &file)?,
            (modified, 4, Some(fs::metadata(&file).unwrap().len()))
        );
        lock_conn!(db.conn).execute(
            "UPDATE session_log_sync SET last_synced_at = -1 WHERE file_path = ?1",
            [file.to_string_lossy().as_ref()],
        )?;
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 0);
        let synced: i64 = lock_conn!(db.conn).query_row(
            "SELECT last_synced_at FROM session_log_sync WHERE file_path = ?1",
            [file.to_string_lossy().as_ref()],
            |row| row.get(0),
        )?;
        assert_eq!(synced, -1);
        Ok(())
    }

    #[test]
    fn incomplete_tail_is_retried_when_completed() -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let file = rollout_path(temp.path(), PARENT_ID);
        let header = format!("{}\n{}\n", session_meta(PARENT_ID), turn_context());
        let event = token_count(1000, 300, 50).to_string();
        fs::write(&file, format!("{header}{}", &event[..event.len() / 2])).unwrap();
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 0);
        assert_eq!(get_codex_sync_state(&db, &file)?.1, 2);
        assert_eq!(get_codex_sync_state(&db, &file)?.2, None);
        assert!(sync_test_file(&db, &file, &[&file])?.deferred);
        let mut writer = fs::OpenOptions::new().append(true).open(&file).unwrap();
        writeln!(writer, "{}", &event[event.len() / 2..]).unwrap();
        writer.set_modified(modified).unwrap();
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
        assert_eq!(
            get_codex_sync_state(&db, &file)?.2,
            Some(fs::metadata(&file).unwrap().len())
        );
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 0);
        Ok(())
    }

    #[test]
    fn rebuild_failure_preserves_existing_usage() -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let old = rollout_path(temp.path(), PARENT_ID);
        write_jsonl(
            &old,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count(1000, 300, 50),
            ],
        );
        assert_eq!(sync_test_file(&db, &old, &[&old])?.imported, 1);
        assert!(rebuild_codex_usage_from_dir(&db, temp.path()).is_err());
        // A non-directory sessions path must propagate the discovery error.
        fs::write(temp.path().join("sessions"), "not a directory").unwrap();
        assert!(rebuild_codex_usage_from_dir(&db, temp.path()).is_err());
        let count: i64 = lock_conn!(db.conn)
            .query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'codex_session'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        assert_eq!(count, 1);
        Ok(())
    }

    #[test]
    fn rebuild_import_error_does_not_replace_rows() -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        fs::create_dir(&sessions).unwrap();
        let file = rollout_path(&sessions, PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count(1000, 300, 50),
            ],
        );
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
        fs::write(sessions.join("broken.jsonl.zst"), "invalid zstd").unwrap();
        assert!(rebuild_codex_usage_from_dir(&db, temp.path()).is_err());
        let count: i64 = lock_conn!(db.conn)
            .query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'codex_session'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        assert_eq!(count, 1);
        fs::remove_file(sessions.join("broken.jsonl.zst")).unwrap();
        let valid = fs::read_to_string(&file).unwrap();
        fs::write(&file, format!("{valid}not JSON\n")).unwrap();
        assert!(rebuild_codex_usage_from_dir(&db, temp.path()).is_err());
        fs::write(&file, format!("{valid}{{\"type\":")).unwrap();
        assert!(rebuild_codex_usage_from_dir(&db, temp.path()).is_err());
        let conn = lock_conn!(db.conn);
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
            row.get(0)
        })?;
        assert_eq!(count, 1);
        conn.execute_batch("INSERT INTO proxy_request_logs (
            request_id, provider_id, app_type, model, input_tokens, output_tokens,
            cache_read_tokens, latency_ms, status_code, created_at, data_source
        ) VALUES ('unrelated', '_gemini_session', 'gemini', 'gemini', 1, 1, 0, 0, 200, 1, 'gemini_session');")?;
        drop(conn);
        fs::write(&file, valid).unwrap();
        assert_eq!(rebuild_codex_usage_from_dir(&db, temp.path())?.imported, 1);
        let unrelated: i64 = lock_conn!(db.conn).query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE request_id = 'unrelated'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(unrelated, 1);
        Ok(())
    }

    #[test]
    fn compressed_reader_enforces_input_output_and_line_budgets() {
        let plain = b"{}\n".repeat(4096);
        let compressed = zstd::stream::encode_all(plain.as_slice(), 3).unwrap();
        assert!(compressed.len() < 1024);
        let mut reader = bounded_zstd_reader(compressed.as_slice(), 1024, 1024).unwrap();
        let mut accepted = 0;
        loop {
            match read_capped_line(&mut reader, 16) {
                Ok(Some((line, false, true))) => accepted += line.len() + 1,
                Err(error) => {
                    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
                    break;
                }
                other => panic!("expected a hard decoded-byte error, got {other:?}"),
            }
        }
        assert!(
            accepted <= 1024,
            "do not drain the rest of an expansion bomb"
        );

        let mut exact = bounded_zstd_reader(
            compressed.as_slice(),
            compressed.len() as u64,
            plain.len() as u64,
        )
        .unwrap();
        let mut output = Vec::new();
        exact.read_to_end(&mut output).unwrap();
        assert_eq!(output, plain);
        let mut short = bounded_zstd_reader(
            compressed.as_slice(),
            compressed.len() as u64 - 1,
            plain.len() as u64,
        )
        .unwrap();
        assert!(short.read_to_end(&mut Vec::new()).is_err());

        // A huge single line must also obey the total budget while it is being
        // drained by read_capped_line, not only after a newline is found.
        let long_line = zstd::stream::encode_all(&vec![b'x'; 4096][..], 3).unwrap();
        let mut reader = bounded_zstd_reader(long_line.as_slice(), 1024, 1024).unwrap();
        assert!(read_capped_line(&mut reader, 16).is_err());
        let mut reader = bounded_zstd_reader(long_line.as_slice(), 1024, 4096).unwrap();
        assert_eq!(
            read_capped_line(&mut reader, 16).unwrap(),
            Some((Vec::new(), true, false))
        );

        // Concatenated zstd frames share the same output budget.
        let doubled = [compressed.as_slice(), compressed.as_slice()].concat();
        let mut reader = bounded_zstd_reader(doubled.as_slice(), 2048, plain.len() as u64).unwrap();
        assert!(reader.read_to_end(&mut Vec::new()).is_err());
    }

    #[test]
    fn rebuild_rejects_legacy_proxy_identity_without_replacing_usage_or_cursor(
    ) -> Result<(), AppError> {
        for archived in [false, true] {
            let db = Database::memory()?;
            let timestamp = "2020-01-01T12:00:00Z";
            let ts = DateTime::parse_from_rfc3339(timestamp).unwrap().timestamp();
            {
                let conn = lock_conn!(db.conn);
                // Actual pre-provenance table shape, then startup's additive upgrade.
                conn.execute_batch(
                    "ALTER TABLE proxy_request_logs DROP COLUMN session_id_trusted;
                     ALTER TABLE usage_rollup_dedup DROP COLUMN session_id_trusted;",
                )?;
                conn.execute(
                    "INSERT INTO proxy_request_logs (request_id, provider_id, app_type, model,
                     input_tokens, output_tokens, cache_read_tokens, latency_ms, status_code, created_at, session_id)
                     VALUES ('legacy-proxy', 'provider', 'codex', 'gpt-5.6-sol', 1000, 50, 300, 1, 200, ?1, 'codex_generated-uuid')",
                    [ts],
                )?;
                Database::create_tables_on_conn(&conn)?;
            }
            if archived {
                assert_eq!(db.rollup_and_prune(30)?, 1);
            }
            let temp = tempdir().unwrap();
            let sessions = temp.path().join("sessions");
            fs::create_dir(&sessions).unwrap();
            let file = rollout_path(&sessions, PARENT_ID);
            let write_usage = |input| {
                write_jsonl(
                    &file,
                    &[
                        session_meta_at(PARENT_ID, None, None, timestamp),
                        turn_context_at(timestamp),
                        token_count_at(input, 300, 50, timestamp),
                    ],
                )
            };
            write_usage(2000);
            assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
            let cursor = get_codex_sync_state(&db, &file)?;
            let before = db.get_usage_summary(None, None, Some("codex"), None, None)?;
            write_usage(1000);
            for _ in 0..2 {
                let error = rebuild_codex_usage_from_dir(&db, temp.path()).unwrap_err();
                assert!(error.to_string().contains("session_id 来源不明"));
                assert_eq!(get_codex_sync_state(&db, &file)?, cursor);
                let after = db.get_usage_summary(None, None, Some("codex"), None, None)?;
                assert_eq!(after.total_requests, before.total_requests);
                assert_eq!(after.real_total_tokens, before.real_total_tokens);
            }
            let conn = lock_conn!(db.conn);
            assert_eq!(conn.query_row(
                "SELECT input_tokens FROM proxy_request_logs WHERE data_source = 'codex_session'",
                [], |row| row.get::<_, i64>(0),
            )?, 2000);
            let table = if archived {
                "usage_rollup_dedup"
            } else {
                "proxy_request_logs"
            };
            let provenance: (String, i64) = conn.query_row(
                &format!("SELECT session_id, session_id_trusted FROM {table} WHERE request_id = 'legacy-proxy'"),
                [], |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(provenance, ("codex_generated-uuid".to_string(), 0));
        }
        Ok(())
    }

    #[test]
    fn rebuild_after_proxy_pruning_is_idempotent_and_keeps_direct_sessions() -> Result<(), AppError>
    {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        fs::create_dir(&sessions).unwrap();
        let timestamp = "2020-01-01T12:00:00Z";
        let ts = DateTime::parse_from_rfc3339(timestamp).unwrap().timestamp();
        for thread in [PARENT_ID, CHILD_A_ID] {
            let mut usage = token_count(1000, 300, 50);
            usage["timestamp"] = timestamp.into();
            write_jsonl(
                &rollout_path(&sessions, thread),
                &[
                    session_meta_at(thread, None, None, timestamp),
                    turn_context_at(timestamp),
                    usage,
                ],
            );
        }
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (request_id, provider_id, app_type, model,
                 input_tokens, output_tokens, cache_read_tokens, latency_ms, status_code, created_at, session_id, session_id_trusted)
                 VALUES ('archived-proxy', 'provider', 'codex', 'gpt-5.6-sol', 1000, 50, 300, 1, 200, ?1, ?2, 1)",
                rusqlite::params![ts, format!("codex_{PARENT_ID}")],
            )?;
        }
        assert_eq!(db.rollup_and_prune(30)?, 1);
        // An all-proxy replay is a successful no-op, even with no imported rows.
        let direct_file = rollout_path(&sessions, CHILD_A_ID);
        let direct_content = fs::read(&direct_file).unwrap();
        fs::remove_file(&direct_file).unwrap();
        let all_proxy = rebuild_codex_usage_from_dir(&db, temp.path())?;
        assert_eq!((all_proxy.imported, all_proxy.skipped), (0, 1));
        fs::write(&direct_file, direct_content).unwrap();
        for _ in 0..3 {
            let result = rebuild_codex_usage_from_dir(&db, temp.path())?;
            assert_eq!(
                result.imported, 1,
                "only the independent direct session is new"
            );
            assert_eq!(result.skipped, 1);
            let summary = db.get_usage_summary(None, None, Some("codex"), None, None)?;
            assert_eq!(summary.total_requests, 2);
            assert_eq!(summary.real_total_tokens, 2100);
            assert_eq!(summary.total_cache_read_tokens, 600);
            assert_eq!(db.rollup_and_prune(30)?, 1);
            assert_eq!(
                db.get_usage_summary(None, None, Some("codex"), None, None)?
                    .total_requests,
                2
            );
        }
        // Old releases have aggregates but no identity receipts. Never guess
        // which direct session belongs to them or destroy that history.
        lock_conn!(db.conn).execute(
            "DELETE FROM usage_rollup_dedup WHERE data_source = 'proxy'",
            [],
        )?;
        assert!(rebuild_codex_usage_from_dir(&db, temp.path()).is_err());
        assert_eq!(
            db.get_usage_summary(None, None, Some("codex"), None, None)?
                .total_requests,
            2
        );
        Ok(())
    }

    #[test]
    fn test_delta_first_event() {
        let prev = None;
        let current = CumulativeTokens {
            input: 17934,
            cached_input: 9600,
            output: 454,
        };
        let delta = compute_delta(&prev, &current);
        assert_eq!(delta.input, 17934);
        assert_eq!(delta.cached_input, 9600);
        assert_eq!(delta.output, 454);
        assert!(!delta.is_zero());
    }

    #[test]
    fn test_delta_subsequent_event() {
        let prev = Some(CumulativeTokens {
            input: 17934,
            cached_input: 9600,
            output: 454,
        });
        let current = CumulativeTokens {
            input: 36722,
            cached_input: 27904,
            output: 804,
        };
        let delta = compute_delta(&prev, &current);
        assert_eq!(delta.input, 36722 - 17934);
        assert_eq!(delta.cached_input, 27904 - 9600);
        assert_eq!(delta.output, 804 - 454);
    }

    #[test]
    fn test_delta_zero_at_task_boundary() {
        let prev = Some(CumulativeTokens {
            input: 58346,
            cached_input: 46976,
            output: 1045,
        });
        // task 边界：相同的累计值
        let current = CumulativeTokens {
            input: 58346,
            cached_input: 46976,
            output: 1045,
        };
        let delta = compute_delta(&prev, &current);
        assert!(delta.is_zero());
    }

    #[test]
    fn test_delta_saturating_sub() {
        // 异常情况：当前值小于前值（不应发生，但需防护）
        let prev = Some(CumulativeTokens {
            input: 100,
            cached_input: 50,
            output: 30,
        });
        let current = CumulativeTokens {
            input: 80,
            cached_input: 40,
            output: 20,
        };
        let delta = compute_delta(&prev, &current);
        assert_eq!(delta.input, 0);
        assert_eq!(delta.cached_input, 0);
        assert_eq!(delta.output, 0);
        assert!(delta.is_zero());
    }

    #[test]
    fn test_parse_cumulative_tokens_valid() {
        let json: serde_json::Value = serde_json::json!({
            "input_tokens": 17934,
            "cached_input_tokens": 9600,
            "output_tokens": 454,
            "reasoning_output_tokens": 233,
            "total_tokens": 18388
        });
        let tokens = parse_cumulative_tokens(&json).unwrap();
        assert_eq!(tokens.input, 17934);
        assert_eq!(tokens.cached_input, 9600);
        assert_eq!(tokens.output, 454);
    }

    #[test]
    fn test_parse_cumulative_tokens_null() {
        let json = serde_json::Value::Null;
        assert!(parse_cumulative_tokens(&json).is_none());
    }

    #[test]
    fn test_parse_cumulative_tokens_alt_field_names() {
        // 某些版本可能使用 cache_read_input_tokens 而非 cached_input_tokens
        let json: serde_json::Value = serde_json::json!({
            "input_tokens": 1000,
            "cache_read_input_tokens": 500,
            "output_tokens": 200
        });
        let tokens = parse_cumulative_tokens(&json).unwrap();
        assert_eq!(tokens.cached_input, 500);
    }

    #[test]
    fn test_collect_codex_session_files_nonexistent() {
        let files = collect_codex_session_files(Path::new("/nonexistent/path")).unwrap();
        assert!(files.is_empty());
    }

    #[test]
    fn test_thread_spawn_parent_strips_replay_and_keeps_live_usage() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(1_000, 900, 100, "2026-07-10T03:00:01Z"),
                turn_context_at("2026-07-10T03:00:10Z"),
            ],
        );
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, None, Some(PARENT_ID), "2026-07-10T03:00:05Z"),
                turn_context(),
                token_count_at(1_000, 900, 100, "2026-07-10T03:00:06Z"),
                token_count_at(1_300, 1_050, 150, "2026-07-10T03:00:07Z"),
            ],
        );

        let result = sync_test_file(&db, &child, &[&parent, &child])?;
        assert_eq!(
            (result.imported, result.skipped, result.deferred),
            (1, 1, false)
        );

        let conn = lock_conn!(db.conn);
        let usage: (i64, i64, i64) = conn.query_row(
            "SELECT input_tokens, cache_read_tokens, output_tokens
             FROM proxy_request_logs WHERE request_id = ?1",
            [format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{CHILD_A_ID}:2")],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(usage, (300, 150, 50));
        Ok(())
    }

    #[test]
    fn test_filtered_parent_events_use_subsequence_prefix_alignment() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:02Z"),
                token_count_at(300, 150, 30, "2026-07-10T03:00:03Z"),
                turn_context_at("2026-07-10T03:00:10Z"),
            ],
        );
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, Some(PARENT_ID), None, "2026-07-10T03:00:05Z"),
                token_count_at(100, 50, 10, "2026-07-10T03:00:06Z"),
                token_count_at(300, 150, 30, "2026-07-10T03:00:07Z"),
                token_count_at(450, 220, 45, "2026-07-10T03:00:08Z"),
            ],
        );

        let result = sync_test_file(&db, &child, &[&parent, &child])?;
        assert_eq!((result.imported, result.skipped), (1, 2));
        Ok(())
    }

    #[test]
    fn test_empty_fork_imports_no_parent_usage() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:02Z"),
                turn_context_at("2026-07-10T03:00:10Z"),
            ],
        );
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, Some(PARENT_ID), None, "2026-07-10T03:00:05Z"),
                token_count_at(100, 50, 10, "2026-07-10T03:00:06Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:07Z"),
                serde_json::json!({
                    "timestamp": "2026-07-10T03:00:08Z",
                    "type": "event_msg",
                    "payload": { "type": "thread_settings_applied" }
                }),
            ],
        );

        let result = sync_test_file(&db, &child, &[&parent, &child])?;
        assert_eq!(
            (result.imported, result.skipped, result.deferred),
            (0, 2, false)
        );
        let conn = lock_conn!(db.conn);
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(count, 0);
        Ok(())
    }

    #[test]
    fn test_resumed_rollout_with_new_file_uuid_is_imported_not_deferred() -> Result<(), AppError> {
        // Revert/resume: the file name carries a new UUID, session_meta keeps
        // the original thread id. This used to be a permanent deferral and the
        // resumed thread's usage silently stopped being recorded.
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let original = rollout_path(temp.path(), PARENT_ID);
        write_jsonl(
            &original,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
            ],
        );
        let resumed = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &resumed,
            &[
                // Meta id is the ORIGINAL thread, file id is new, no explicit parent.
                session_meta_at(PARENT_ID, None, None, "2026-07-10T03:05:00Z"),
                token_count_at(300, 120, 30, "2026-07-10T03:05:01Z"),
            ],
        );

        let first = sync_test_file(&db, &original, &[&original, &resumed])?;
        assert_eq!((first.imported, first.deferred), (1, false));
        let second = sync_test_file(&db, &resumed, &[&original, &resumed])?;
        assert_eq!(
            (second.imported, second.deferred),
            (1, false),
            "the resumed rollout's tokens must be recorded"
        );
        let conn = lock_conn!(db.conn);
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(count, 2, "one row per rollout, no double counting");
        let resumed_session: String = conn.query_row(
            "SELECT session_id FROM proxy_request_logs WHERE request_id = ?1",
            [format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{CHILD_A_ID}:1")],
            |row| row.get(0),
        )?;
        assert_eq!(
            resumed_session, PARENT_ID,
            "proxy matching uses metadata, not the file UUID"
        );
        Ok(())
    }

    #[test]
    fn test_conflicting_explicit_parents_are_deferred() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &child,
            &[
                session_meta_at(
                    CHILD_A_ID,
                    Some(PARENT_ID),
                    Some(CHILD_B_ID),
                    "2026-07-10T03:00:05Z",
                ),
                token_count_at(100, 50, 10, "2026-07-10T03:00:06Z"),
            ],
        );

        let result = sync_test_file(&db, &child, &[&child])?;
        assert!(result.deferred);
        assert_eq!(get_sync_state(&db, &child.to_string_lossy())?, (0, 0));
        Ok(())
    }

    #[test]
    fn test_parent_future_signature_cannot_extend_replay_prefix() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:06Z"),
            ],
        );
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, Some(PARENT_ID), None, "2026-07-10T03:00:05Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:07Z"),
            ],
        );

        let result = sync_test_file(&db, &child, &[&parent, &child])?;
        assert_eq!(
            (result.imported, result.skipped, result.deferred),
            (1, 0, false)
        );
        Ok(())
    }

    #[test]
    fn test_missing_parent_is_deferred_and_recovered_without_child_change() -> Result<(), AppError>
    {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, None, Some(PARENT_ID), "2026-07-10T03:00:05Z"),
                token_count_at(900, 400, 90, "2026-07-10T03:00:06Z"),
            ],
        );

        let deferred = sync_test_file(&db, &child, &[&child])?;
        assert!(deferred.deferred);
        assert_eq!(get_sync_state(&db, &child.to_string_lossy())?, (0, 0));

        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                turn_context_at("2026-07-10T03:00:10Z"),
            ],
        );
        let recovered = sync_test_file(&db, &child, &[&parent, &child])?;
        assert_eq!((recovered.imported, recovered.deferred), (1, false));
        Ok(())
    }

    #[test]
    fn test_billable_file_without_meta_is_deferred_without_cursor() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(&child, &[turn_context(), token_count(100, 50, 10)]);

        let result = sync_test_file(&db, &child, &[&child])?;
        assert!(result.deferred);
        assert_eq!(get_sync_state(&db, &child.to_string_lossy())?, (0, 0));

        std::thread::sleep(std::time::Duration::from_millis(2));
        write_jsonl(
            &child,
            &[
                turn_context(),
                token_count(100, 50, 10),
                session_meta_at(CHILD_A_ID, None, None, "2026-07-10T03:00:03Z"),
            ],
        );
        let recovered = sync_test_file(&db, &child, &[&child])?;
        assert_eq!((recovered.imported, recovered.deferred), (1, false));
        Ok(())
    }

    #[test]
    fn test_non_billable_file_without_meta_advances_cursor() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &child,
            &[
                turn_context(),
                token_count_at(0, 0, 0, "2026-07-10T03:00:02Z"),
            ],
        );

        let result = sync_test_file(&db, &child, &[&child])?;
        assert!(!result.deferred);
        assert_eq!(get_sync_state(&db, &child.to_string_lossy())?.1, 2);
        Ok(())
    }

    #[test]
    fn test_subagents_use_filename_thread_ids() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let child_a = rollout_path(temp.path(), CHILD_A_ID);
        let child_b = rollout_path(temp.path(), CHILD_B_ID);
        write_jsonl(
            &child_a,
            &[
                session_meta(CHILD_A_ID),
                turn_context(),
                token_count(100, 50, 10),
            ],
        );
        write_jsonl(
            &child_b,
            &[
                session_meta(CHILD_B_ID),
                turn_context(),
                token_count(200, 100, 20),
            ],
        );

        assert_eq!(
            sync_test_file(&db, &child_a, &[&child_a, &child_b])?.imported,
            1
        );
        assert_eq!(
            sync_test_file(&db, &child_b, &[&child_a, &child_b])?.imported,
            1
        );

        let conn = lock_conn!(db.conn);
        let request_ids = conn
            .prepare(
                "SELECT request_id FROM proxy_request_logs
                 WHERE data_source = 'codex_session' ORDER BY request_id",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(
            request_ids,
            vec![
                format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{CHILD_A_ID}:1"),
                format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{CHILD_B_ID}:1")
            ]
        );
        Ok(())
    }

    #[test]
    fn test_archived_log_inherits_cursor_and_only_imports_appended_usage() -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        let archived = temp.path().join("archived_sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&archived).unwrap();
        let source = rollout_path(&sessions, PARENT_ID);
        let archived_file = rollout_path(&archived, PARENT_ID);
        write_jsonl(
            &archived_file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count(100, 50, 10),
                token_count(200, 100, 20),
            ],
        );

        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, request_model,
                    input_tokens, output_tokens, cache_read_tokens,
                    total_cost_usd, latency_ms, status_code, session_id,
                    created_at, data_source
                ) VALUES ('codex_session:parent:2', '_codex_session', 'codex',
                          'gpt-5.6-sol', 'gpt-5.6-sol', 999, 99, 0, '0', 0,
                          200, 'parent', 1, 'codex_session')",
                [],
            )?;
        }
        let source_path = source.to_string_lossy().to_string();
        update_sync_state(&db, &source_path, 1, 3)?;

        assert_eq!(
            sync_test_file(&db, &archived_file, &[&archived_file])?.imported,
            1
        );
        assert_eq!(
            sync_test_file(&db, &archived_file, &[&archived_file])?.imported,
            0
        );

        let conn = lock_conn!(db.conn);
        let old_row_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs
             WHERE request_id = 'codex_session:parent:2'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(old_row_count, 1);
        let usage: (i64, i64, i64) = conn.query_row(
            "SELECT input_tokens, cache_read_tokens, output_tokens
             FROM proxy_request_logs
             WHERE request_id = ?1",
            [format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{PARENT_ID}:2")],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(usage, (100, 50, 10));
        drop(conn);
        assert_eq!(get_sync_state(&db, &archived_file.to_string_lossy())?.1, 4);

        Ok(())
    }

    #[test]
    fn test_insert_codex_session_skips_matching_proxy_log() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, request_model,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    total_cost_usd, latency_ms, status_code, created_at, data_source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    "codex-proxy",
                    "openai",
                    "codex",
                    "gpt-5.4",
                    "gpt-5.4",
                    10,
                    2,
                    1,
                    7,
                    "0.01",
                    100,
                    200,
                    1000,
                    "proxy"
                ],
            )?;
        }

        let delta = DeltaTokens {
            input: 10,
            cached_input: 1,
            output: 2,
        };
        let mut suspected_duplicates = 0;
        let inserted = {
            let conn = lock_conn!(db.conn);
            insert_codex_session_entry(
                &conn,
                "codex-session-dup",
                &delta,
                "gpt-5.4",
                Some("session-1"),
                Some("1970-01-01T00:16:45Z"),
                &mut suspected_duplicates,
            )?
        };
        assert!(!inserted);

        let conn = lock_conn!(db.conn);
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
            row.get(0)
        })?;
        assert_eq!(count, 1);

        Ok(())
    }

    #[test]
    fn test_codex_session_duplicate_is_observed_but_still_inserted() -> Result<(), AppError> {
        let db = Database::memory()?;
        let delta = DeltaTokens {
            input: 10,
            cached_input: 1,
            output: 2,
        };
        let mut suspected_duplicates = 0;
        {
            let conn = lock_conn!(db.conn);
            assert!(insert_codex_session_entry(
                &conn,
                "codex-session-a",
                &delta,
                "gpt-5.4",
                Some("session-a"),
                Some("1970-01-01T00:16:40Z"),
                &mut suspected_duplicates,
            )?);
            assert!(insert_codex_session_entry(
                &conn,
                "codex-session-b",
                &delta,
                "gpt-5.4",
                Some("session-b"),
                Some("1970-01-01T00:16:45Z"),
                &mut suspected_duplicates,
            )?);
        }
        assert_eq!(suspected_duplicates, 1);

        let conn = lock_conn!(db.conn);
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(count, 2);
        Ok(())
    }

    #[test]
    fn reset_codex_usage_only_removes_codex_rows_and_structural_cursors() -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let wide_dir = temp.path();
        let current_codex = rollout_path(&wide_dir.join("sessions"), CHILD_A_ID);
        let legacy_codex =
            format!("C:\\old-codex\\archived_sessions\\rollout-old-{CHILD_B_ID}.jsonl");
        let gemini_cursor = wide_dir.join("gemini/sessions/session-123.json");
        let claude_cursor = wide_dir.join(format!("projects/rollout-{PARENT_ID}.jsonl"));

        {
            let conn = lock_conn!(db.conn);
            conn.execute_batch(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, input_tokens,
                    output_tokens, cache_read_tokens, latency_ms, status_code,
                    created_at, data_source
                 ) VALUES
                    ('codex-row', '_codex_session', 'codex', 'gpt', 1, 1, 0, 0, 200, 1, 'codex_session'),
                    ('gemini-row', '_gemini_session', 'gemini', 'gemini', 1, 1, 0, 0, 200, 1, 'gemini_session');
                 INSERT INTO usage_daily_rollups (date, app_type, provider_id, model)
                 VALUES
                    ('2026-07-10', 'codex', '_codex_session', 'gpt'),
                    ('2026-07-10', 'gemini', '_gemini_session', 'gemini');",
            )?;
            for path in [
                current_codex.to_string_lossy().to_string(),
                legacy_codex,
                gemini_cursor.to_string_lossy().to_string(),
                claude_cursor.to_string_lossy().to_string(),
            ] {
                conn.execute(
                    "INSERT INTO session_log_sync
                     (file_path, last_modified, last_line_offset, last_synced_at)
                     VALUES (?1, 1, 1, 1)",
                    [path],
                )?;
            }

            reset_codex_usage_on_conn(&conn, wide_dir)?;
            let codex_rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'codex_session'",
                [],
                |row| row.get(0),
            )?;
            let gemini_rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'gemini_session'",
                [],
                |row| row.get(0),
            )?;
            let codex_rollups: i64 = conn.query_row(
                "SELECT COUNT(*) FROM usage_daily_rollups WHERE provider_id = '_codex_session'",
                [],
                |row| row.get(0),
            )?;
            let remaining_cursors: i64 =
                conn.query_row("SELECT COUNT(*) FROM session_log_sync", [], |row| {
                    row.get(0)
                })?;
            assert_eq!((codex_rows, gemini_rows, codex_rollups), (0, 1, 0));
            assert_eq!(remaining_cursors, 2);
        }
        Ok(())
    }

    // ── 模型名归一化测试 ──

    #[test]
    fn test_normalize_codex_model_lowercase() {
        assert_eq!(normalize_codex_model("GLM-4.6"), "glm-4.6");
        assert_eq!(normalize_codex_model("DeepSeek-Chat"), "deepseek-chat");
        assert_eq!(normalize_codex_model("GPT-5.4"), "gpt-5.4");
    }

    #[test]
    fn test_normalize_codex_model_strip_prefix() {
        assert_eq!(normalize_codex_model("openai/gpt-5.4"), "gpt-5.4");
        assert_eq!(
            normalize_codex_model("azure/gpt-5.2-codex"),
            "gpt-5.2-codex"
        );
        assert_eq!(normalize_codex_model("OPENAI/GPT-5.4"), "gpt-5.4");
    }

    #[test]
    fn test_normalize_codex_model_strip_iso_date() {
        assert_eq!(normalize_codex_model("gpt-5.4-2026-03-05"), "gpt-5.4");
        assert_eq!(
            normalize_codex_model("gpt-5.4-pro-2026-03-05"),
            "gpt-5.4-pro"
        );
    }

    #[test]
    fn test_normalize_codex_model_strip_compact_date() {
        assert_eq!(normalize_codex_model("gpt-5.4-20260305"), "gpt-5.4");
        assert_eq!(
            normalize_codex_model("claude-opus-4-6-20260206"),
            "claude-opus-4-6"
        );
    }

    #[test]
    fn test_normalize_codex_model_no_change() {
        assert_eq!(normalize_codex_model("gpt-5.4"), "gpt-5.4");
        assert_eq!(normalize_codex_model("gpt-5.2-codex"), "gpt-5.2-codex");
        assert_eq!(normalize_codex_model("o3"), "o3");
        assert_eq!(normalize_codex_model("deepseek-chat"), "deepseek-chat");
    }

    #[test]
    fn test_normalize_codex_model_combined() {
        // prefix + uppercase + ISO date
        assert_eq!(
            normalize_codex_model("openai/GPT-5.4-2026-03-05"),
            "gpt-5.4"
        );
        // prefix + compact date
        assert_eq!(normalize_codex_model("openai/gpt-5.4-20260305"), "gpt-5.4");
    }

    #[test]
    fn test_cached_clamped_to_input() {
        // cached > input 的异常场景应被 min() 钳制
        let prev = Some(CumulativeTokens {
            input: 100,
            cached_input: 0,
            output: 50,
        });
        let current = CumulativeTokens {
            input: 110,       // delta = 10
            cached_input: 80, // delta = 80（异常：大于 input delta）
            output: 60,
        };
        let delta = compute_delta(&prev, &current);
        // 钳制前：cached_input = 80, input = 10
        assert_eq!(delta.cached_input, 80);
        assert_eq!(delta.input, 10);
        // 实际钳制在调用侧：delta.cached_input.min(delta.input)
        let clamped = delta.cached_input.min(delta.input);
        assert_eq!(clamped, 10);
    }

    // ── 单行长度上限（超过原 32MB 整文件门槛的会话文件应仍可解析） ──

    #[test]
    fn read_capped_line_skips_oversized_lines_and_keeps_reading() {
        let data = b"short\nthis-line-is-too-long-for-the-cap\nok\n";
        let mut cursor = std::io::Cursor::new(&data[..]);

        let (line1, truncated1, _) = read_capped_line(&mut cursor, 5).unwrap().unwrap();
        assert_eq!(String::from_utf8(line1).unwrap(), "short");
        assert!(!truncated1);

        let (line2, truncated2, _) = read_capped_line(&mut cursor, 5).unwrap().unwrap();
        assert!(
            truncated2,
            "a line longer than the cap must be reported as truncated"
        );
        assert!(
            line2.is_empty(),
            "truncated line content must be discarded, not buffered"
        );

        let (line3, truncated3, _) = read_capped_line(&mut cursor, 5).unwrap().unwrap();
        assert_eq!(String::from_utf8(line3).unwrap(), "ok");
        assert!(
            !truncated3,
            "a normal line following a truncated one must still parse correctly"
        );

        assert!(read_capped_line(&mut cursor, 5).unwrap().is_none());
    }

    #[test]
    fn read_capped_line_clears_bytes_when_truncation_spans_multiple_chunks() {
        // A plain `Cursor` hands back its entire remaining slice from a
        // single `fill_buf()` call, so it can never exercise the case where
        // an oversized line is detected only after several chunks have
        // already been buffered — wrap it in a tiny-capacity `BufReader` to
        // force the same multi-chunk behavior a real file's `BufReader`
        // (8 KiB chunks against a 16 MiB cap) hits in practice.
        let data = b"ok\nthis-line-is-too-long-for-the-cap\nfine\n";
        let mut reader = BufReader::with_capacity(4, std::io::Cursor::new(&data[..]));

        let (line1, truncated1, _) = read_capped_line(&mut reader, 5).unwrap().unwrap();
        assert_eq!(String::from_utf8(line1).unwrap(), "ok");
        assert!(!truncated1);

        let (line2, truncated2, _) = read_capped_line(&mut reader, 5).unwrap().unwrap();
        assert!(
            truncated2,
            "a line longer than the cap must be reported as truncated even when detected several chunks in"
        );
        assert!(
            line2.is_empty(),
            "bytes buffered from chunks before truncation was detected must not leak into the truncated result"
        );

        let (line3, truncated3, _) = read_capped_line(&mut reader, 5).unwrap().unwrap();
        assert_eq!(String::from_utf8(line3).unwrap(), "fine");
        assert!(!truncated3);

        assert!(read_capped_line(&mut reader, 5).unwrap().is_none());
    }

    #[test]
    fn read_capped_line_handles_missing_trailing_newline_at_eof() {
        let data = b"first\nsecond-no-newline";
        let mut cursor = std::io::Cursor::new(&data[..]);

        let (line1, truncated1, _) = read_capped_line(&mut cursor, 64).unwrap().unwrap();
        assert_eq!(String::from_utf8(line1).unwrap(), "first");
        assert!(!truncated1);

        let (line2, truncated2, _) = read_capped_line(&mut cursor, 64).unwrap().unwrap();
        assert_eq!(String::from_utf8(line2).unwrap(), "second-no-newline");
        assert!(!truncated2);

        assert!(read_capped_line(&mut cursor, 64).unwrap().is_none());
    }

    #[test]
    fn parse_ignores_whole_file_size_and_skips_only_the_oversized_line() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let child = rollout_path(temp.path(), CHILD_A_ID);

        // A single line larger than the *old* MAX_SESSION_FILE_BYTES (32
        // MiB) whole-file gate this test exists to prove is gone from
        // `parse_codex_file`. It also exceeds MAX_SESSION_LINE_BYTES on its
        // own, so it must be skipped (not fatal) while the rest of the
        // file — including the billable token_count event below it — is
        // still imported normally.
        let padding = serde_json::json!({
            "type": "response_item",
            "payload": {
                "padding": "a".repeat(crate::security_limits::MAX_SESSION_FILE_BYTES as usize + 1024)
            }
        });
        write_jsonl(
            &child,
            &[
                session_meta(CHILD_A_ID),
                padding,
                turn_context(),
                token_count(100, 50, 10),
            ],
        );

        let file_len = fs::metadata(&child).unwrap().len();
        assert!(
            file_len > crate::security_limits::MAX_SESSION_FILE_BYTES,
            "fixture must exceed the old whole-file limit to actually exercise this fix, got {file_len} bytes"
        );

        let result = sync_test_file(&db, &child, &[&child])?;
        assert_eq!((result.imported, result.deferred), (1, false));

        let conn = lock_conn!(db.conn);
        let usage: (i64, i64, i64) = conn.query_row(
            "SELECT input_tokens, cache_read_tokens, output_tokens
             FROM proxy_request_logs WHERE request_id = ?1",
            [format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{CHILD_A_ID}:1")],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(usage, (100, 50, 10));
        Ok(())
    }
}
