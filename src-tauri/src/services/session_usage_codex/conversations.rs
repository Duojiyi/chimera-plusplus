//! 按对话汇总：把有效的 Codex 用量归到发起它的根对话。
//!
//! 词元与成本只来自与总览相同的去重明细；rollout 开头只提供归属（spawn / fork
//! 父线程）和标题。读不到的 rollout 不会改变任何总量，只会让那条线程单独成为
//! 一个对话。

// Adapted from yynxxxxx/Codex-X apps/desktop/src-tauri/src/usage.rs and
// sessions/storage.rs (MIT): a thread belongs to the conversation reached by
// following its parents, and an internal thread without a known parent stays
// in the totals without being listed as a conversation.

use crate::codex_config::get_codex_config_dir;
use crate::codex_state_db::codex_state_db_paths;
use crate::database::Database;
use crate::error::AppError;
use crate::security_limits::{
    open_regular_file_no_symlink, read_to_string_limited, MAX_CONFIG_FILE_BYTES,
};
use crate::services::session_usage::metadata_modified_nanos;
use crate::services::usage_stats::{derive_real_total_and_hit_rate, CodexThreadUsageRow};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Rows returned to the page, newest activity first.
const MAX_CONVERSATIONS: usize = 200;
/// Sub-agent rows listed under one conversation; `subagent_count` stays exact.
const MAX_LISTED_SUBAGENTS: usize = 20;
const TITLE_MAX_CHARS: usize = 60;
/// The identity line and the first user message sit at the top of a rollout.
/// These bounds keep a pasted file or a tool output from turning a title
/// lookup into a full scan.
const HEAD_MAX_LINES: usize = 64;
const HEAD_MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
const HEAD_MAX_BYTES: u64 = 8 * 1024 * 1024;
const IDE_REQUEST_HEADING: &str = "## My request for Codex:";
const INTERNAL_THREAD_KINDS: [&str; 4] = [
    "subagent",
    "internal",
    "guardian_review",
    "memory_consolidation",
];
const SESSION_INDEX_FILENAME: &str = "session_index.jsonl";
/// Codex keeps its state DB open while running. A short wait keeps the page
/// responsive; a DB that stays busy only costs renamed titles.
const STATE_DB_BUSY_TIMEOUT: Duration = Duration::from_millis(250);
/// Stays well below SQLite's bound-parameter limit.
const STATE_DB_ID_CHUNK: usize = 400;

/// One provider line's share of a conversation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationProviderUsage {
    pub provider_id: String,
    pub provider_name: String,
    pub request_count: u64,
    pub total_tokens: u64,
}

/// A sub-agent or fork thread whose usage is counted in its conversation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationThreadUsage {
    pub id: String,
    pub title: Option<String>,
    pub is_fork: bool,
    pub request_count: u64,
    pub total_tokens: u64,
    pub last_activity_at: i64,
}

/// One root conversation. Tokens are cache-inclusive like the overview:
/// fresh input + output + cache creation + cache read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationUsage {
    pub id: String,
    /// Renamed thread title, else the first user message; `None` when neither exists.
    pub title: Option<String>,
    pub first_activity_at: i64,
    pub last_activity_at: i64,
    pub request_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub total_tokens: u64,
    pub cache_hit_rate: f64,
    /// Sum of the stored per-request estimates.
    pub total_cost: String,
    /// Successful requests with tokens but no price, so `total_cost` is partial.
    pub unpriced_request_count: u64,
    pub subagent_count: u64,
    pub providers: Vec<ConversationProviderUsage>,
    pub subagents: Vec<ConversationThreadUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationUsageReport {
    pub conversations: Vec<ConversationUsage>,
    /// Root conversations in range, before the title filter and the row cap.
    pub total_conversations: u64,
    /// Conversations matching the title filter, before the row cap.
    pub matched_conversations: u64,
    /// Usage without a conversation: proxy traffic that carries no Codex
    /// thread id, internal threads without a parent, and archived rollups.
    pub unattributed_requests: u64,
    pub unattributed_tokens: u64,
}

/// Groups effective Codex usage in `[start_date, end_date]` by root conversation.
pub(crate) fn get_usage_by_conversation(
    db: &Database,
    start_date: Option<i64>,
    end_date: Option<i64>,
    query: Option<&str>,
) -> Result<ConversationUsageReport, AppError> {
    conversation_usage_in(db, &get_codex_config_dir(), start_date, end_date, query)
}

fn conversation_usage_in(
    db: &Database,
    codex_dir: &Path,
    start_date: Option<i64>,
    end_date: Option<i64>,
    query: Option<&str>,
) -> Result<ConversationUsageReport, AppError> {
    let mut usage = db.get_codex_thread_usage(start_date, end_date)?;
    for row in &mut usage.rows {
        row.thread_id = row.thread_id.as_deref().map(normalize_thread_id);
        row.rollout_id = row.rollout_id.as_deref().map(normalize_thread_id);
    }
    // An unreadable session directory only costs titles and parents; every
    // total still comes from the database.
    let files = match super::collect_codex_session_files(codex_dir) {
        Ok(files) => files,
        Err(error) => {
            log::warn!("[USAGE] 读取 Codex 会话目录失败，对话标题与归属将不完整: {error}");
            Vec::new()
        }
    };
    let rollout_index = super::build_rollout_index(&files);
    let seeds = usage
        .rows
        .iter()
        .filter_map(|row| Some((row.thread_id.clone()?, row.rollout_id.clone())))
        .collect();
    let heads = resolve_thread_heads(seeds, &rollout_index);
    let folded = fold_usage(&usage.rows, &heads);
    let mut ids: HashSet<String> = HashSet::new();
    for (root, conversation) in &folded.conversations {
        ids.insert(root.clone());
        ids.extend(conversation.threads.keys().cloned());
    }
    let titles = load_thread_titles(codex_dir, &ids);
    let rollup = (usage.rollup_requests, usage.rollup_tokens);
    Ok(build_report(folded, rollup, &heads, &titles, query))
}

/// What a rollout's first lines say about its thread.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ThreadHead {
    /// Spawn or fork parent, by the importer's own parent rules.
    parent_id: Option<String>,
    /// Forked by the user rather than spawned as a sub-agent.
    forked: bool,
    /// A Codex-internal thread (sub-agent, review or memory task).
    internal: bool,
    first_user_message: Option<String>,
}

type HeadStamp = (i64, u64);
type HeadCache = HashMap<PathBuf, (HeadStamp, Option<ThreadHead>)>;

/// A young rollout may not have its first user message yet, so the size and
/// mtime stamp re-reads a file that grew.
static THREAD_HEADS: OnceLock<Mutex<HeadCache>> = OnceLock::new();

/// Reads the heads of every thread with usage and of their ancestors, so a
/// sub-agent whose parent was idle in the range still finds its conversation.
fn resolve_thread_heads(
    seeds: Vec<(String, Option<String>)>,
    rollout_index: &super::RolloutIndex,
) -> HashMap<String, ThreadHead> {
    let mut heads: HashMap<String, ThreadHead> = HashMap::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut pending = seeds;
    while let Some((id, rollout_id)) = pending.pop() {
        if !visited.insert(id.clone()) {
            continue;
        }
        // A resumed rollout keeps the original thread id under a new file
        // name, so the file a session row came from is the fallback.
        let paths = rollout_index
            .get(&id)
            .or_else(|| rollout_id.and_then(|rollout| rollout_index.get(&rollout)));
        let Some(path) = paths.and_then(|paths| paths.first()) else {
            continue;
        };
        let Some(head) = cached_thread_head(path) else {
            continue;
        };
        if let Some(parent) = &head.parent_id {
            pending.push((parent.clone(), None));
        }
        heads.insert(id, head);
    }
    heads
}

fn cached_thread_head(path: &Path) -> Option<ThreadHead> {
    let metadata = std::fs::metadata(path).ok()?;
    let stamp = (metadata_modified_nanos(&metadata), metadata.len());
    let cache = THREAD_HEADS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(entries) = cache.lock() {
        if let Some((cached, head)) = entries.get(path) {
            if *cached == stamp {
                return head.clone();
            }
        }
    }
    let head = read_thread_head(path);
    if let Ok(mut entries) = cache.lock() {
        entries.insert(path.to_path_buf(), (stamp, head.clone()));
    }
    head
}

fn read_thread_head(path: &Path) -> Option<ThreadHead> {
    let file = open_regular_file_no_symlink(path).ok()?;
    let reader: Box<dyn BufRead> = if path.to_string_lossy().ends_with(".jsonl.zst") {
        let compressed = super::MAX_CODEX_COMPRESSED_BYTES;
        let decoded = super::bounded_zstd_reader(file, compressed, HEAD_MAX_BYTES);
        Box::new(decoded.ok()?)
    } else {
        Box::new(BufReader::new(file.take(HEAD_MAX_BYTES)))
    };
    parse_thread_head(reader)
}

/// Keeps only the identity line and the first user message. Malformed lines
/// are skipped; a file without `session_meta` has no head.
fn parse_thread_head(mut reader: impl BufRead) -> Option<ThreadHead> {
    let mut head: Option<ThreadHead> = None;
    let mut typed_message: Option<String> = None;
    let mut item_message: Option<String> = None;
    for _ in 0..HEAD_MAX_LINES {
        let next = super::read_capped_line(&mut reader, HEAD_MAX_LINE_BYTES);
        let Ok(Some((bytes, truncated, _))) = next else {
            break;
        };
        if truncated {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let payload = value.get("payload").unwrap_or(&Value::Null);
        match value.get("type").and_then(Value::as_str) {
            Some("session_meta") if head.is_none() => {
                head = Some(head_from_meta(payload));
            }
            // What the user typed, without the context Codex injects.
            Some("event_msg")
                if typed_message.is_none()
                    && payload.get("type").and_then(Value::as_str) == Some("user_message") =>
            {
                typed_message = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .and_then(title_candidate);
            }
            // Older rollouts only record the request as a response item.
            Some("response_item") if item_message.is_none() && is_user_message(payload) => {
                item_message = title_candidate(&message_text(payload.get("content")));
            }
            _ => {}
        }
        if head.is_some() && typed_message.is_some() {
            break;
        }
    }
    let mut head = head?;
    head.first_user_message = typed_message.or(item_message);
    Some(head)
}

fn head_from_meta(payload: &Value) -> ThreadHead {
    let parent_id = match super::explicit_parent_from_meta(payload) {
        super::ParentResolution::Parent(parent) => Some(normalize_thread_id(&parent)),
        _ => None,
    };
    let spawned = payload
        .pointer("/source/subagent/thread_spawn/parent_thread_id")
        .and_then(Value::as_str)
        .is_some_and(|parent| !parent.is_empty());
    ThreadHead {
        forked: parent_id.is_some() && !spawned,
        internal: is_internal_thread(payload),
        parent_id,
        first_user_message: None,
    }
}

/// Codex marks spawned, review and memory threads in `source` or
/// `thread_source`; such a thread is never a user conversation on its own.
fn is_internal_thread(payload: &Value) -> bool {
    let source_internal = match payload.get("source") {
        Some(Value::String(kind)) => is_internal_kind(kind),
        Some(Value::Object(source)) => {
            source.contains_key("subagent") || source.contains_key("internal")
        }
        _ => false,
    };
    let thread_source = payload.get("thread_source").and_then(Value::as_str);
    source_internal || thread_source.is_some_and(is_internal_kind)
}

fn is_internal_kind(kind: &str) -> bool {
    let kind = kind.trim().to_ascii_lowercase();
    INTERNAL_THREAD_KINDS.contains(&kind.as_str())
        || kind.starts_with("subagent_")
        || kind.starts_with("internal_")
}

fn is_user_message(payload: &Value) -> bool {
    payload.get("type").and_then(Value::as_str) == Some("message")
        && payload.get("role").and_then(Value::as_str) == Some("user")
}

fn message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => {
            let parts: Vec<&str> = items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect();
            parts.join(" ")
        }
        _ => String::new(),
    }
}

/// Codex also stores injected context as user messages: skip those, and keep
/// only the request part of an IDE context block.
fn title_candidate(text: &str) -> Option<String> {
    let mut text = text.trim();
    if let Some(index) = text.rfind(IDE_REQUEST_HEADING) {
        text = text[index + IDE_REQUEST_HEADING.len()..].trim();
    }
    if text.is_empty() || text.starts_with('<') || text.starts_with("# AGENTS.md") {
        return None;
    }
    Some(truncate_title(text))
}

/// Collapses whitespace and keeps the first `TITLE_MAX_CHARS` characters.
fn truncate_title(text: &str) -> String {
    let mut title = String::new();
    let chars = text
        .split_whitespace()
        .flat_map(|word| std::iter::once(' ').chain(word.chars()))
        .skip(1);
    for (count, ch) in chars.enumerate() {
        if count == TITLE_MAX_CHARS {
            title.push('…');
            break;
        }
        title.push(ch);
    }
    title
}

/// Rollout file names and proxy headers spell the same UUID differently.
fn normalize_thread_id(raw: &str) -> String {
    let raw = raw.trim();
    match uuid::Uuid::parse_str(raw) {
        Ok(id) => id.hyphenated().to_string(),
        Err(_) => raw.to_owned(),
    }
}

/// Follows spawn and fork parents to the conversation that started a thread.
/// `None` is an internal thread without a known parent; a parent cycle keeps
/// the thread as its own conversation.
fn conversation_root(thread_id: &str, heads: &HashMap<String, ThreadHead>) -> Option<String> {
    let mut current = thread_id;
    let mut seen: HashSet<&str> = HashSet::new();
    loop {
        if !seen.insert(current) {
            return Some(thread_id.to_owned());
        }
        let head = heads.get(current);
        match head.and_then(|known| known.parent_id.as_deref()) {
            Some(parent) => current = parent,
            None if head.is_some_and(|known| known.internal) => return None,
            None => return Some(current.to_owned()),
        }
    }
}

/// Renamed titles, read like the session list reads them: the session index
/// first, then each state DB, keeping a title only when it differs from the
/// first user message (Codex's own rule for a distinct title).
fn load_thread_titles(codex_dir: &Path, ids: &HashSet<String>) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    if ids.is_empty() {
        return titles;
    }
    let index_path = codex_dir.join(SESSION_INDEX_FILENAME);
    if let Ok(content) = read_to_string_limited(&index_path, MAX_CONFIG_FILE_BYTES) {
        for line in content.lines() {
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let id = entry
                .get("id")
                .and_then(Value::as_str)
                .map(normalize_thread_id);
            let name = entry
                .get("thread_name")
                .and_then(Value::as_str)
                .map(str::trim);
            if let (Some(id), Some(name)) = (id, name) {
                if ids.contains(&id) && !name.is_empty() {
                    titles.insert(id, name.to_owned());
                }
            }
        }
    }
    let config_path = codex_dir.join("config.toml");
    let config_text = read_to_string_limited(&config_path, MAX_CONFIG_FILE_BYTES);
    for db_path in codex_state_db_paths(codex_dir, &config_text.unwrap_or_default()) {
        titles.extend(state_db_titles(&db_path, ids));
    }
    titles
}

fn state_db_titles(db_path: &Path, ids: &HashSet<String>) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    if !db_path.exists() {
        return titles;
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = match Connection::open_with_flags(db_path, flags) {
        Ok(conn) => conn,
        Err(_) => return titles,
    };
    if conn.busy_timeout(STATE_DB_BUSY_TIMEOUT).is_err() {
        return titles;
    }
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    for chunk in ids.chunks(STATE_DB_ID_CHUNK) {
        let Ok(rows) = query_state_db_titles(&conn, chunk) else {
            break;
        };
        for (id, title) in rows {
            let title = title.trim();
            if !title.is_empty() {
                titles.insert(id, title.to_owned());
            }
        }
    }
    titles
}

fn query_state_db_titles(
    conn: &Connection,
    ids: &[&str],
) -> rusqlite::Result<Vec<(String, String)>> {
    let placeholders = vec!["?"; ids.len()].join(", ");
    // The comparison stays in SQL so the unbounded first message is never loaded.
    let sql = format!(
        "SELECT id, title FROM threads
         WHERE id IN ({placeholders}) AND title <> ''
           AND (first_user_message IS NULL OR TRIM(title) <> TRIM(first_user_message))"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(ids.iter()), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect()
}

#[derive(Debug, Default)]
struct Totals {
    requests: u64,
    unpriced: u64,
    fresh_input: u64,
    output: u64,
    cache_creation: u64,
    cache_read: u64,
    cost: f64,
    first_at: Option<i64>,
    last_at: Option<i64>,
}

impl Totals {
    fn add(&mut self, row: &CodexThreadUsageRow) {
        self.requests += row.request_count;
        self.unpriced += row.unpriced_request_count;
        self.fresh_input += row.fresh_input_tokens;
        self.output += row.output_tokens;
        self.cache_creation += row.cache_creation_tokens;
        self.cache_read += row.cache_read_tokens;
        self.cost += row.total_cost;
        let first = self.first_at.unwrap_or(row.first_at);
        self.first_at = Some(first.min(row.first_at));
        let last = self.last_at.unwrap_or(row.last_at);
        self.last_at = Some(last.max(row.last_at));
    }

    fn tokens(&self) -> u64 {
        self.fresh_input + self.output + self.cache_creation + self.cache_read
    }
}

#[derive(Debug, Default)]
struct ConversationFold {
    totals: Totals,
    /// Provider id -> (display name, usage).
    providers: HashMap<String, (String, Totals)>,
    /// Sub-agent and fork threads; the root itself is not listed.
    threads: HashMap<String, Totals>,
}

#[derive(Debug)]
struct FoldedUsage {
    conversations: HashMap<String, ConversationFold>,
    unattributed: Totals,
}

fn fold_usage(rows: &[CodexThreadUsageRow], heads: &HashMap<String, ThreadHead>) -> FoldedUsage {
    let mut folded = FoldedUsage {
        conversations: HashMap::new(),
        unattributed: Totals::default(),
    };
    for row in rows {
        let root = row
            .thread_id
            .as_deref()
            .and_then(|thread| conversation_root(thread, heads));
        let Some(root) = root else {
            folded.unattributed.add(row);
            continue;
        };
        let conversation = folded.conversations.entry(root.clone()).or_default();
        conversation.totals.add(row);
        let provider = conversation
            .providers
            .entry(row.provider_id.clone())
            .or_insert_with(|| (row.provider_name.clone(), Totals::default()));
        provider.1.add(row);
        if let Some(thread) = row.thread_id.as_deref().filter(|thread| *thread != root) {
            conversation
                .threads
                .entry(thread.to_owned())
                .or_default()
                .add(row);
        }
    }
    folded
}

fn build_report(
    folded: FoldedUsage,
    rollup: (u64, u64),
    heads: &HashMap<String, ThreadHead>,
    titles: &HashMap<String, String>,
    query: Option<&str>,
) -> ConversationUsageReport {
    let total_conversations = folded.conversations.len() as u64;
    let needle = query
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(str::to_lowercase);
    let mut conversations: Vec<ConversationUsage> = folded
        .conversations
        .into_iter()
        .map(|(id, fold)| conversation_usage(id, fold, heads, titles))
        .filter(|conversation| title_matches(conversation, needle.as_deref()))
        .collect();
    let matched_conversations = conversations.len() as u64;
    conversations.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    conversations.truncate(MAX_CONVERSATIONS);
    ConversationUsageReport {
        conversations,
        total_conversations,
        matched_conversations,
        unattributed_requests: folded.unattributed.requests + rollup.0,
        unattributed_tokens: folded.unattributed.tokens() + rollup.1,
    }
}

fn title_matches(conversation: &ConversationUsage, needle: Option<&str>) -> bool {
    let Some(needle) = needle else {
        return true;
    };
    let title = conversation.title.as_deref().unwrap_or_default();
    title.to_lowercase().contains(needle)
}

fn conversation_usage(
    id: String,
    fold: ConversationFold,
    heads: &HashMap<String, ThreadHead>,
    titles: &HashMap<String, String>,
) -> ConversationUsage {
    let totals = &fold.totals;
    let (_, cache_hit_rate) = derive_real_total_and_hit_rate(
        totals.fresh_input,
        totals.output,
        totals.cache_creation,
        totals.cache_read,
    );
    let mut providers: Vec<ConversationProviderUsage> = fold
        .providers
        .into_iter()
        .map(
            |(provider_id, (provider_name, usage))| ConversationProviderUsage {
                provider_id,
                provider_name,
                request_count: usage.requests,
                total_tokens: usage.tokens(),
            },
        )
        .collect();
    providers.sort_by(|a, b| {
        b.total_tokens
            .cmp(&a.total_tokens)
            .then_with(|| a.provider_id.cmp(&b.provider_id))
    });
    let subagent_count = fold.threads.len() as u64;
    let mut subagents: Vec<ConversationThreadUsage> = fold
        .threads
        .into_iter()
        .map(|(thread_id, usage)| ConversationThreadUsage {
            title: thread_title(&thread_id, heads, titles),
            is_fork: heads.get(&thread_id).is_some_and(|head| head.forked),
            request_count: usage.requests,
            total_tokens: usage.tokens(),
            last_activity_at: usage.last_at.unwrap_or_default(),
            id: thread_id,
        })
        .collect();
    subagents.sort_by(|a, b| {
        b.total_tokens
            .cmp(&a.total_tokens)
            .then_with(|| a.id.cmp(&b.id))
    });
    subagents.truncate(MAX_LISTED_SUBAGENTS);
    ConversationUsage {
        title: thread_title(&id, heads, titles),
        first_activity_at: totals.first_at.unwrap_or_default(),
        last_activity_at: totals.last_at.unwrap_or_default(),
        request_count: totals.requests,
        input_tokens: totals.fresh_input,
        output_tokens: totals.output,
        cache_creation_tokens: totals.cache_creation,
        cache_read_tokens: totals.cache_read,
        total_tokens: totals.tokens(),
        cache_hit_rate,
        total_cost: format!("{:.6}", totals.cost),
        unpriced_request_count: totals.unpriced,
        subagent_count,
        providers,
        subagents,
        id,
    }
}

fn thread_title(
    id: &str,
    heads: &HashMap<String, ThreadHead>,
    titles: &HashMap<String, String>,
) -> Option<String> {
    if let Some(title) = titles.get(id) {
        return Some(truncate_title(title));
    }
    let head = heads.get(id)?;
    head.first_user_message.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    const BASE: i64 = 1_790_000_000;

    fn thread(n: u32) -> String {
        format!("00000000-0000-4000-8000-{n:012}")
    }

    fn meta(id: &str, spawned_from: Option<&str>, forked_from: Option<&str>) -> Value {
        let mut meta = json!({ "id": id, "forked_from_id": forked_from, "source": "cli" });
        if let Some(parent) = spawned_from {
            let spawn = json!({ "parent_thread_id": parent });
            meta["source"] = json!({ "subagent": { "thread_spawn": spawn } });
        }
        meta
    }

    /// Writes a rollout named after the meta id, with an optional typed request.
    fn write_rollout(codex_dir: &Path, meta: Value, message: Option<&str>) {
        let id = meta["id"].as_str().unwrap().to_owned();
        let dir = codex_dir.join("sessions");
        fs::create_dir_all(&dir).unwrap();
        let mut lines = vec![json!({ "type": "session_meta", "payload": meta })];
        if let Some(message) = message {
            let typed = json!({ "type": "user_message", "message": message });
            lines.push(json!({ "type": "event_msg", "payload": typed }));
        }
        let contents: String = lines.iter().map(|line| format!("{line}\n")).collect();
        let file_name = format!("rollout-2026-10-01T00-00-00-{id}.jsonl");
        fs::write(dir.join(file_name), contents).unwrap();
    }

    /// One imported Codex request; `input` includes `cached`, as Codex reports it.
    fn insert_session_row(db: &Database, thread_id: &str, index: u32, at: i64, usage: [i64; 3]) {
        let request_id = format!("codex_session:thread-v1:{thread_id}:{index}");
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO proxy_request_logs (
                request_id, provider_id, app_type, model, request_model, input_tokens,
                cache_read_tokens, output_tokens, total_cost_usd, latency_ms, status_code,
                created_at, session_id, data_source
            ) VALUES (?1, '_codex_session', 'codex', 'gpt-5.5', 'gpt-5.5', ?2, ?3, ?4,
                      '0.01', 0, 200, ?5, ?6, 'codex_session')",
            rusqlite::params![request_id, usage[0], usage[1], usage[2], at, thread_id],
        )
        .unwrap();
    }

    /// One live proxy request on line `p-line`, logged without a price.
    fn insert_proxy_row(db: &Database, session: Option<&str>, at: i64, usage: [i64; 3]) {
        let request_id = format!("proxy-{at}");
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO proxy_request_logs (
                request_id, provider_id, app_type, model, request_model, input_tokens,
                cache_read_tokens, output_tokens, latency_ms, status_code, created_at,
                session_id, session_id_trusted
            ) VALUES (?1, 'p-line', 'codex', 'gpt-5.5', 'gpt-5.5', ?2, ?3, ?4,
                      10, 200, ?5, ?6, 1)",
            rusqlite::params![request_id, usage[0], usage[1], usage[2], at, session],
        )
        .unwrap();
    }

    fn report(db: &Database, dir: &Path, query: Option<&str>) -> ConversationUsageReport {
        conversation_usage_in(db, dir, Some(BASE - 10), Some(BASE + 1_000), query).unwrap()
    }

    fn find<'a>(report: &'a ConversationUsageReport, id: &str) -> &'a ConversationUsage {
        report
            .conversations
            .iter()
            .find(|conversation| conversation.id == id)
            .expect("conversation is listed")
    }

    #[test]
    fn subagents_fold_into_the_conversation_that_spawned_them() -> Result<(), AppError> {
        let db = Database::memory()?;
        let codex = tempdir().unwrap();
        let dir = codex.path();
        let (root, first, second) = (thread(1), thread(2), thread(3));
        write_rollout(dir, meta(&root, None, None), Some("修复配置迁移"));
        write_rollout(dir, meta(&first, Some(&root), None), Some("读取迁移流程"));
        write_rollout(dir, meta(&second, Some(&root), None), Some("补回归测试"));
        insert_session_row(&db, &root, 1, BASE, [1_000, 600, 100]);
        insert_session_row(&db, &root, 2, BASE + 60, [2_000, 1_500, 200]);
        insert_session_row(&db, &first, 1, BASE + 120, [500, 100, 50]);
        insert_session_row(&db, &second, 1, BASE + 180, [300, 0, 30]);

        let report = report(&db, dir, None);

        assert_eq!(report.total_conversations, 1);
        assert_eq!(report.unattributed_requests, 0);
        let conversation = find(&report, &root);
        assert_eq!(conversation.title.as_deref(), Some("修复配置迁移"));
        assert_eq!(conversation.request_count, 4);
        // Codex input includes cache reads; the overview counts fresh input,
        // output and cache reads once each.
        assert_eq!(conversation.input_tokens, 400 + 500 + 400 + 300);
        assert_eq!(conversation.cache_read_tokens, 600 + 1_500 + 100);
        assert_eq!(conversation.output_tokens, 100 + 200 + 50 + 30);
        assert_eq!(conversation.total_tokens, 3_800 + 380);
        assert!((conversation.cache_hit_rate - 2_200.0 / 3_800.0).abs() < 1e-9);
        assert_eq!(conversation.total_cost, "0.040000");
        assert_eq!(conversation.unpriced_request_count, 0);
        assert_eq!(
            (
                conversation.first_activity_at,
                conversation.last_activity_at
            ),
            (BASE, BASE + 180)
        );
        assert_eq!(conversation.subagent_count, 2);
        let listed: Vec<(&str, Option<&str>, u64)> = conversation
            .subagents
            .iter()
            .map(|child| {
                (
                    child.id.as_str(),
                    child.title.as_deref(),
                    child.total_tokens,
                )
            })
            .collect();
        assert_eq!(
            listed,
            vec![
                (first.as_str(), Some("读取迁移流程"), 550),
                (second.as_str(), Some("补回归测试"), 330),
            ]
        );
        assert_eq!(conversation.providers.len(), 1);
        assert_eq!(conversation.providers[0].provider_id, "_codex_session");
        assert_eq!(conversation.providers[0].request_count, 4);
        Ok(())
    }

    #[test]
    fn forks_and_their_subagents_attribute_to_an_idle_root() -> Result<(), AppError> {
        let db = Database::memory()?;
        let codex = tempdir().unwrap();
        let dir = codex.path();
        let (root, fork, helper) = (thread(1), thread(2), thread(3));
        write_rollout(dir, meta(&root, None, None), Some("主对话"));
        write_rollout(dir, meta(&fork, None, Some(&root)), Some("换个思路"));
        write_rollout(dir, meta(&helper, Some(&fork), None), None);
        // The root's own request is outside the range; only its descendants ran.
        insert_session_row(&db, &root, 1, BASE - 5_000, [900, 0, 90]);
        insert_session_row(&db, &fork, 1, BASE + 10, [100, 0, 10]);
        insert_session_row(&db, &helper, 1, BASE + 20, [200, 0, 20]);

        let report = report(&db, dir, None);

        assert_eq!(report.conversations.len(), 1);
        let conversation = find(&report, &root);
        assert_eq!(conversation.title.as_deref(), Some("主对话"));
        assert_eq!(conversation.request_count, 2);
        assert_eq!(conversation.total_tokens, 330);
        assert_eq!(conversation.first_activity_at, BASE + 10);
        assert_eq!(conversation.subagent_count, 2);
        let kinds: Vec<(String, bool)> = conversation
            .subagents
            .iter()
            .map(|child| (child.id.clone(), child.is_fork))
            .collect();
        assert_eq!(kinds, vec![(helper, false), (fork, true)]);
        Ok(())
    }

    #[test]
    fn titles_prefer_renames_then_the_first_message_then_nothing() -> Result<(), AppError> {
        let db = Database::memory()?;
        let codex = tempdir().unwrap();
        let dir = codex.path();
        let (renamed, asked, silent, indexed) = (thread(1), thread(2), thread(3), thread(4));
        let long = "把用量页改成真实数据，".repeat(10);
        write_rollout(dir, meta(&renamed, None, None), Some("原始提问"));
        write_rollout(dir, meta(&asked, None, None), Some(&long));
        write_rollout(dir, meta(&silent, None, None), None);
        let index = format!(
            "{}\n{}\n",
            json!({ "id": renamed, "thread_name": "旧标题" }),
            json!({ "id": renamed, "thread_name": "改名后的标题" })
        );
        fs::write(dir.join(SESSION_INDEX_FILENAME), index).unwrap();
        let state = Connection::open(dir.join("state_5.sqlite"))?;
        state.execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT);",
        )?;
        state.execute(
            "INSERT INTO threads VALUES (?1, '数据库里的标题', '另一句话')",
            [&indexed],
        )?;
        // Codex copies the first message into `title` until a rename.
        state.execute(
            "INSERT INTO threads VALUES (?1, '同一句话，未改名', '同一句话，未改名')",
            [&silent],
        )?;
        drop(state);
        let ids = [&renamed, &asked, &silent, &indexed];
        for (index, id) in ids.into_iter().enumerate() {
            insert_session_row(&db, id, 1, BASE + index as i64, [10, 0, 1]);
        }

        let report = report(&db, dir, None);

        assert_eq!(report.total_conversations, 4);
        let titled = |id: &str| find(&report, id).title.clone();
        assert_eq!(titled(&renamed).as_deref(), Some("改名后的标题"));
        let truncated: String = long.chars().take(TITLE_MAX_CHARS).chain(['…']).collect();
        assert_eq!(titled(&asked), Some(truncated));
        assert_eq!(titled(&silent), None);
        assert_eq!(titled(&indexed).as_deref(), Some("数据库里的标题"));

        let filtered = conversation_usage_in(&db, dir, None, None, Some("  改名后  "))?;
        assert_eq!(filtered.total_conversations, 4);
        assert_eq!(filtered.matched_conversations, 1);
        assert_eq!(filtered.conversations[0].id, renamed);
        Ok(())
    }

    #[test]
    fn conversations_sort_by_last_activity_and_cap_at_the_row_limit() -> Result<(), AppError> {
        let db = Database::memory()?;
        let codex = tempdir().unwrap();
        for index in 0..205u32 {
            let at = BASE + i64::from(index);
            insert_session_row(&db, &thread(index), 1, at, [10, 0, 1]);
        }

        let report = report(&db, codex.path(), None);

        assert_eq!(report.total_conversations, 205);
        assert_eq!(report.matched_conversations, 205);
        assert_eq!(report.conversations.len(), MAX_CONVERSATIONS);
        assert_eq!(report.conversations[0].id, thread(204));
        assert_eq!(report.conversations[1].id, thread(203));
        assert_eq!(report.conversations[MAX_CONVERSATIONS - 1].id, thread(5));
        Ok(())
    }

    #[test]
    fn an_empty_range_has_no_conversations() -> Result<(), AppError> {
        let db = Database::memory()?;
        let codex = tempdir().unwrap();
        let dir = codex.path();
        let id = thread(1);
        write_rollout(dir, meta(&id, None, None), Some("昨天的对话"));
        insert_session_row(&db, &id, 1, BASE, [10, 0, 1]);

        let later = Some(BASE + 5_000);
        let report = conversation_usage_in(&db, dir, later, later, None)?;

        assert!(report.conversations.is_empty());
        assert_eq!(report.total_conversations, 0);
        assert_eq!(report.unattributed_requests, 0);
        assert_eq!(report.unattributed_tokens, 0);
        Ok(())
    }

    #[test]
    fn proxy_rows_join_their_thread_without_double_counting() -> Result<(), AppError> {
        let db = Database::memory()?;
        let codex = tempdir().unwrap();
        let dir = codex.path();
        let (root, child) = (thread(1), thread(2));
        write_rollout(dir, meta(&root, None, None), Some("经代理的对话"));
        write_rollout(dir, meta(&child, Some(&root), None), None);
        // The proxy logged the same request the session file recorded.
        insert_session_row(&db, &root, 1, BASE, [1_000, 600, 100]);
        let root_session = format!("codex_{root}");
        insert_proxy_row(&db, Some(&root_session), BASE + 5, [1_000, 600, 100]);
        let child_session = format!("codex_{child}");
        insert_proxy_row(&db, Some(&child_session), BASE + 60, [400, 100, 40]);
        insert_proxy_row(&db, None, BASE + 120, [50, 0, 5]);

        let report = report(&db, dir, None);

        let conversation = find(&report, &root);
        assert_eq!(conversation.request_count, 2);
        assert_eq!(conversation.total_tokens, 1_100 + 440);
        assert_eq!(conversation.unpriced_request_count, 2);
        assert_eq!(conversation.total_cost, "0.000000");
        assert_eq!(conversation.subagent_count, 1);
        assert_eq!(conversation.providers.len(), 1);
        assert_eq!(conversation.providers[0].provider_id, "p-line");
        assert_eq!(conversation.providers[0].request_count, 2);
        assert_eq!(report.unattributed_requests, 1);
        assert_eq!(report.unattributed_tokens, 55);
        Ok(())
    }

    #[test]
    fn internal_threads_without_a_parent_are_not_listed() -> Result<(), AppError> {
        let db = Database::memory()?;
        let codex = tempdir().unwrap();
        let dir = codex.path();
        let (root, memory) = (thread(1), thread(2));
        write_rollout(dir, meta(&root, None, None), Some("用户的对话"));
        let mut internal = meta(&memory, None, None);
        internal["thread_source"] = json!("memory_consolidation");
        write_rollout(dir, internal, Some("整理记忆"));
        insert_session_row(&db, &root, 1, BASE, [10, 0, 1]);
        insert_session_row(&db, &memory, 1, BASE + 1, [20, 0, 2]);

        let report = report(&db, dir, None);

        assert_eq!(report.conversations.len(), 1);
        assert_eq!(report.conversations[0].id, root);
        assert_eq!(report.unattributed_requests, 1);
        assert_eq!(report.unattributed_tokens, 22);
        Ok(())
    }

    #[test]
    fn title_candidates_skip_injected_context_and_collapse_whitespace() {
        assert_eq!(title_candidate("<environment_context/>"), None);
        assert_eq!(title_candidate("# AGENTS.md for repo"), None);
        let spaced = title_candidate(" 修复\n 按对话  汇总 ");
        assert_eq!(spaced.as_deref(), Some("修复 按对话 汇总"));
        let ide = "# Context from my IDE setup:\n## My request for Codex:\n加上搜索框";
        assert_eq!(title_candidate(ide).as_deref(), Some("加上搜索框"));
    }
}
