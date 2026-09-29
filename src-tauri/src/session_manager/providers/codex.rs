use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::Value;

use crate::codex_config::{get_codex_config_dir, read_codex_config_text};
use crate::codex_state_db::{
    backup_sqlite_online, codex_sqlite_homes, codex_state_db_paths, CodexRuntimeDb,
};
use crate::session_manager::{SessionDeleteResult, SessionMessage, SessionMeta};

use super::utils::{
    extract_text, parse_timestamp_to_ms, path_basename, truncate_summary, TITLE_MAX_CHARS,
};

use super::codex_io::{open_lines, read_head_tail_lines};

const PROVIDER_ID: &str = "codex";
const CODEX_SESSION_INDEX_FILENAME: &str = "session_index.jsonl";
const VSCODE_CONTEXT_PREFIX: &str = "# Context from my IDE setup:";
const CODEX_REQUEST_MARKER: &str = "my request for codex";

static UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        .unwrap()
});

#[derive(Deserialize)]
struct SessionIndexEntry {
    id: String,
    thread_name: String,
}

pub fn scan_sessions() -> Vec<SessionMeta> {
    let roots = session_roots();
    scan_sessions_in_roots(&roots)
}

pub fn session_roots() -> Vec<PathBuf> {
    let config_dir = get_codex_config_dir();
    vec![
        config_dir.join("sessions"),
        config_dir.join("archived_sessions"),
    ]
}

fn scan_sessions_in_roots(roots: &[PathBuf]) -> Vec<SessionMeta> {
    let thread_titles = load_thread_titles();
    scan_sessions_in_roots_with_titles(roots, &thread_titles)
}

fn scan_sessions_in_roots_with_titles(
    roots: &[PathBuf],
    thread_titles: &HashMap<String, String>,
) -> Vec<SessionMeta> {
    let mut files = Vec::new();
    for root in roots {
        collect_jsonl_files(root, &mut files);
    }

    let mut sessions = Vec::new();
    for path in files {
        if let Some(meta) = parse_session_with_titles(&path, thread_titles) {
            sessions.push(meta);
        }
    }

    sessions
}

fn load_thread_titles() -> HashMap<String, String> {
    let config_dir = get_codex_config_dir();
    let config_text = read_codex_config_text().unwrap_or_default();
    let db_paths = codex_state_db_paths(&config_dir, &config_text);
    load_thread_titles_from_paths(&config_dir.join(CODEX_SESSION_INDEX_FILENAME), &db_paths)
}

fn load_thread_titles_from_paths(
    session_index_path: &Path,
    db_paths: &[PathBuf],
) -> HashMap<String, String> {
    let mut titles = load_thread_titles_from_session_index(session_index_path);
    for db_path in db_paths {
        titles.extend(load_thread_titles_from_db(db_path));
    }
    titles
}

fn load_thread_titles_from_session_index(index_path: &Path) -> HashMap<String, String> {
    let Ok(content) = crate::security_limits::read_to_string_limited(
        index_path,
        crate::security_limits::MAX_CONFIG_FILE_BYTES,
    ) else {
        return HashMap::new();
    };

    let mut titles = HashMap::new();
    for line in content.lines() {
        let Ok(entry) = serde_json::from_str::<SessionIndexEntry>(line.trim()) else {
            continue;
        };
        let id = entry.id.trim();
        let title = entry.thread_name.trim();
        if !id.is_empty() && !title.is_empty() {
            titles.insert(id.to_string(), title.to_string());
        }
    }

    titles
}

fn load_thread_titles_from_db(db_path: &Path) -> HashMap<String, String> {
    if !db_path.exists() {
        return HashMap::new();
    }

    let conn = match Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => conn,
        Err(err) => {
            log::warn!(
                "Failed to open Codex state database {}: {err}",
                db_path.display()
            );
            return HashMap::new();
        }
    };
    // Codex keeps this DB open and write-locked while running; without a busy
    // timeout a read during a write fails immediately and titles silently drop.
    if let Err(err) = conn.busy_timeout(Duration::from_secs(2)) {
        log::warn!(
            "Failed to set Codex state database busy timeout for {}: {err}",
            db_path.display()
        );
        return HashMap::new();
    }

    // Mirror Codex's own `distinct_thread_metadata_title`: keep a title only
    // when it differs from the first user message. Push the comparison into SQL
    // (NULL-safe) so we never SELECT the unbounded `first_user_message` blob —
    // it can grow large enough to OOM (openai/codex#29007).
    let mut stmt = match conn.prepare(
        "SELECT id, title FROM threads \
         WHERE title <> '' \
         AND (first_user_message IS NULL OR TRIM(title) <> TRIM(first_user_message))",
    ) {
        Ok(stmt) => stmt,
        Err(err) => {
            log::warn!(
                "Failed to prepare Codex thread title query for {}: {err}",
                db_path.display()
            );
            return HashMap::new();
        }
    };

    let rows = match stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let title: String = row.get(1)?;
        Ok((id, title))
    }) {
        Ok(rows) => rows,
        Err(err) => {
            log::warn!(
                "Failed to query Codex thread titles from {}: {err}",
                db_path.display()
            );
            return HashMap::new();
        }
    };

    rows.flatten()
        .filter_map(|(id, title)| {
            let id = id.trim();
            let title = title.trim();
            if id.is_empty() || title.is_empty() {
                None
            } else {
                Some((id.to_string(), title.to_string()))
            }
        })
        .collect()
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    // IPC still materializes messages, so bound decoded bytes as well as
    // compressed input and each line. Never read a zstd frame as UTF-8.
    let mut lines = open_lines(path, crate::security_limits::MAX_SESSION_FILE_BYTES)
        .map_err(|error| format!("Failed to read session file {}: {error}", path.display()))?;
    let mut messages = Vec::new();

    while let Some(line) = lines
        .next_line()
        .map_err(|error| format!("Failed to read session file {}: {error}", path.display()))?
    {
        let value: Value = match serde_json::from_str(&line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };

        if value.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }

        let payload = match value.get("payload") {
            Some(payload) => payload,
            None => continue,
        };

        let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");

        // Codex uses separate payload types for tool interactions
        let (role, content) = match payload_type {
            "message" => {
                let role = payload
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let content = payload.get("content").map(extract_text).unwrap_or_default();
                (role, content)
            }
            "function_call" => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                ("assistant".to_string(), format!("[Tool: {name}]"))
            }
            "function_call_output" => {
                let output = payload
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                ("tool".to_string(), output)
            }
            _ => continue,
        };

        if content.trim().is_empty() {
            continue;
        }

        let ts = value.get("timestamp").and_then(parse_timestamp_to_ms);

        messages.push(SessionMessage { role, content, ts });
    }

    Ok(messages)
}

/// Finish as much cleanup as possible. The caller keeps the original request
/// when cleanup_pending is true and can retry even though the rollout is gone.
pub(crate) fn delete_session_records(
    root: &Path,
    session_id: &str,
) -> Result<SessionDeleteResult, String> {
    let cleanup = SessionCleanup::prepare(root, session_id)?;
    if let Err(error) = cleanup.backup() {
        // The rollout is already gone, so report a retryable partial delete
        // rather than touching any store without a backup.
        return Ok(cleanup.finish(vec![error]));
    }
    Ok(cleanup.run())
}

pub(crate) fn delete_session(
    root: &Path,
    path: &Path,
    session_id: &str,
) -> Result<SessionDeleteResult, String> {
    // Missing rollouts are valid retries, but only after the manager validates
    // containment and rejects linked ancestors (including missing-leaf paths).
    if !path
        .try_exists()
        .map_err(|error| format!("Failed to inspect session file: {error}"))?
    {
        return delete_session_records(root, session_id);
    }
    let meta = parse_session(path)
        .ok_or_else(|| format!("Failed to parse Codex session metadata: {}", path.display()))?;
    if meta.session_id != session_id {
        return Err(format!(
            "Codex session ID mismatch: expected {session_id}, found {}",
            meta.session_id
        ));
    }
    let cleanup = SessionCleanup::prepare(root, session_id)?;
    // Nothing has been removed yet: a failed backup leaves the session intact.
    cleanup.backup()?;
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to delete Codex session file {}: {error}",
                path.display()
            ))
        }
    }
    Ok(cleanup.run())
}

/// One Codex session delete: the session, every thread it spawned (sub-agent
/// sessions are hidden from the list but still own rollouts and rows), and
/// the SQLite homes that may hold them. Resolved before anything is removed.
struct SessionCleanup {
    config_dir: PathBuf,
    homes: Vec<PathBuf>,
    /// The session first, then its spawned descendants.
    thread_ids: Vec<String>,
    /// Homes whose spawn graph could not be read. Their state DB keeps its
    /// edges and thread rows so a retry can find the same subtree.
    unreadable_graph_homes: Vec<PathBuf>,
    errors: Vec<String>,
}

impl SessionCleanup {
    fn prepare(root: &Path, session_id: &str) -> Result<Self, String> {
        let config_dir = root
            .parent()
            .ok_or("Codex session root has no config directory")?
            .to_path_buf();
        let mut errors = Vec::new();
        let config_path = config_dir.join("config.toml");
        let config_text = match crate::security_limits::read_to_string_limited(
            &config_path,
            crate::security_limits::MAX_CONFIG_FILE_BYTES,
        ) {
            Ok(text) => match text.parse::<toml_edit::DocumentMut>() {
                Ok(_) => Some(text),
                Err(error) => {
                    errors.push(format!("{}: {error}", config_path.display()));
                    None
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(String::new()),
            Err(error) => {
                errors.push(format!("{}: {error}", config_path.display()));
                None
            }
        };
        let homes = match config_text {
            Some(text) => codex_sqlite_homes(&config_dir, &text),
            // With an unreadable config the external SQLite override is unknown.
            // Clean the known local stores; report the unresolved location for retry.
            None => vec![config_dir.clone()],
        };

        let mut thread_ids = vec![session_id.to_string()];
        let mut unreadable_graph_homes = Vec::new();
        for home in &homes {
            let db_path = home.join(CodexRuntimeDb::State.filename());
            match read_spawned_descendants(&db_path, session_id) {
                Ok(descendants) => {
                    for id in descendants {
                        if !thread_ids.contains(&id) {
                            thread_ids.push(id);
                        }
                    }
                }
                Err(error) => {
                    errors.push(format!("{}: {error}", db_path.display()));
                    unreadable_graph_homes.push(home.clone());
                }
            }
        }

        Ok(Self {
            config_dir,
            homes,
            thread_ids,
            unreadable_graph_homes,
            errors,
        })
    }

    /// Back up every runtime DB that holds rows for these threads, with the
    /// online backup API (Codex keeps them open in WAL mode). DBs without
    /// matching rows are left out so an unrelated large log DB is not copied.
    fn backup(&self) -> Result<(), String> {
        let backup_dir = session_delete_backup_root(&self.config_dir).join(format!(
            "{}_{}",
            chrono::Local::now().format("%Y%m%d_%H%M%S"),
            uuid::Uuid::new_v4()
        ));
        for (index, home) in self.homes.iter().enumerate() {
            for db in CodexRuntimeDb::DELETE_ORDER {
                let db_path = home.join(db.filename());
                let failed = |error: String| {
                    format!(
                        "Failed to back up {} before deleting the session: {error}",
                        db_path.display()
                    )
                };
                if !db_path
                    .try_exists()
                    .map_err(|error| failed(error.to_string()))?
                {
                    continue;
                }
                let conn = open_runtime_db(&db_path).map_err(|error| failed(error.to_string()))?;
                if tables_with_thread_rows(db, &conn, &self.thread_ids)
                    .map_err(|error| failed(error.to_string()))?
                    .is_empty()
                {
                    continue;
                }
                let target_dir = backup_dir.join(index.to_string());
                std::fs::create_dir_all(&target_dir).map_err(|error| failed(error.to_string()))?;
                backup_sqlite_online(&conn, &target_dir.join(db.filename()))
                    .map_err(|error| failed(error.to_string()))?;
            }
        }
        Ok(())
    }

    fn run(self) -> SessionDeleteResult {
        let mut errors = Vec::new();

        // The subtree's rollouts, plus any second copy of the session's own
        // (an archived duplicate) that the requested path did not cover.
        let mut rollouts_removed = true;
        for path in rollout_files_for(&self.config_dir, &self.thread_ids) {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    rollouts_removed = false;
                    errors.push(format!("{}: {error}", path.display()));
                }
            }
        }
        if let Err(error) = remove_sessions_from_session_index(
            &self.config_dir.join(CODEX_SESSION_INDEX_FILENAME),
            &self.thread_ids,
        ) {
            errors.push(format!("{CODEX_SESSION_INDEX_FILENAME}: {error}"));
        }

        // Do not short-circuit on one store's error: the other stores and
        // homes may be writable. Within a home, the state DB goes last and is
        // kept while anything that depends on its spawn graph is pending.
        for home in &self.homes {
            let mut keep_graph = !rollouts_removed || self.unreadable_graph_homes.contains(home);
            for db in CodexRuntimeDb::DELETE_ORDER {
                let db_path = home.join(db.filename());
                match db_path.try_exists() {
                    Ok(true) => {}
                    Ok(false) => continue,
                    Err(error) => {
                        errors.push(format!("{}: {error}", db_path.display()));
                        keep_graph = true;
                        continue;
                    }
                }
                if db == CodexRuntimeDb::State && keep_graph {
                    continue;
                }
                if let Err(error) = delete_thread_rows(db, &db_path, &self.thread_ids) {
                    errors.push(format!("{}: {error}", db_path.display()));
                    keep_graph = true;
                }
            }
        }

        self.verify(&mut errors);
        self.finish(errors)
    }

    /// Re-read every store after the delete: a row or rollout still present
    /// keeps the request pending for a retry.
    fn verify(&self, errors: &mut Vec<String>) {
        for home in &self.homes {
            for db in CodexRuntimeDb::DELETE_ORDER {
                let db_path = home.join(db.filename());
                if !db_path.try_exists().unwrap_or(false) {
                    continue;
                }
                let remaining = open_runtime_db(&db_path)
                    .and_then(|conn| tables_with_thread_rows(db, &conn, &self.thread_ids));
                match remaining {
                    Ok(tables) if tables.is_empty() => {}
                    Ok(tables) => errors.push(format!(
                        "{}: rows remain in {}",
                        db_path.display(),
                        tables.join(", ")
                    )),
                    Err(error) => errors.push(format!("{}: {error}", db_path.display())),
                }
            }
        }
        for path in rollout_files_for(&self.config_dir, &self.thread_ids) {
            errors.push(format!("{}: rollout still present", path.display()));
        }
    }

    /// Report the result, with the problems found while preparing first.
    fn finish(&self, errors: Vec<String>) -> SessionDeleteResult {
        let errors: Vec<String> = self.errors.iter().cloned().chain(errors).collect();
        let error = (!errors.is_empty()).then(|| format!(
            "Session content has been deleted, but Codex index cleanup is incomplete. Retry this deletion to finish cleanup: {}",
            errors.join("; ")
        ));
        if let Some(error) = &error {
            log::warn!("{error}");
        }
        SessionDeleteResult {
            source_deleted: true,
            cleanup_pending: error.is_some(),
            error,
        }
    }
}

#[cfg(not(test))]
fn session_delete_backup_root(_config_dir: &Path) -> PathBuf {
    crate::config::get_app_config_dir()
        .join("backups")
        .join("codex-session-delete")
}

/// Tests keep their backups inside the temporary Codex home.
#[cfg(test)]
fn session_delete_backup_root(config_dir: &Path) -> PathBuf {
    config_dir.join("session-delete-backups")
}

/// Rollout files (active or archived) whose name carries one of `thread_ids`,
/// the way Codex names them (`rollout-<timestamp>-<thread id>.jsonl[.zst]`).
fn rollout_files_for(config_dir: &Path, thread_ids: &[String]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for root in [
        config_dir.join("sessions"),
        config_dir.join("archived_sessions"),
    ] {
        collect_jsonl_files(&root, &mut files);
    }
    files.retain(|path| {
        infer_session_id_from_filename(path).is_some_and(|id| thread_ids.contains(&id))
    });
    files
}

fn open_runtime_db(db_path: &Path) -> rusqlite::Result<Connection> {
    // Never create a store while cleaning a missing one. Codex keeps these
    // open (often write-locked) while running, so tolerate a brief wait.
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(Duration::from_secs(2))?;
    Ok(conn)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        [table, column],
        |row| row.get(0),
    )
}

fn read_spawned_descendants(db_path: &Path, thread_id: &str) -> Result<Vec<String>, String> {
    if !db_path.try_exists().map_err(|error| error.to_string())? {
        return Ok(Vec::new());
    }
    let conn = open_runtime_db(db_path).map_err(|error| error.to_string())?;
    spawned_descendants(&conn, thread_id).map_err(|error| error.to_string())
}

// Adapted from openai/codex codex-rs/state/src/runtime/threads.rs
// (`ThreadRelationFilter::DescendantsOf`) (MIT)
/// Every thread spawned from `thread_id`, transitively, per `thread_spawn_edges`.
fn spawned_descendants(conn: &Connection, thread_id: &str) -> rusqlite::Result<Vec<String>> {
    if !has_column(conn, "thread_spawn_edges", "parent_thread_id")?
        || !has_column(conn, "thread_spawn_edges", "child_thread_id")?
    {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "WITH RECURSIVE subtree(id) AS (
             SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?1
             UNION
             SELECT edge.child_thread_id FROM thread_spawn_edges AS edge
             JOIN subtree ON edge.parent_thread_id = subtree.id
         )
         SELECT id FROM subtree",
    )?;
    let rows = stmt.query_map([thread_id], |row| row.get::<_, String>(0))?;
    let mut ids = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    // A cycle back to the root must not list the root as its own descendant.
    ids.retain(|id| id != thread_id);
    Ok(ids)
}

// Adapted from openai/codex codex-rs/state/src/runtime/threads.rs
// (`delete_threads_strict`) and codex-rs/thread-store/src/local/thread_history.rs
// (`delete_thread`) (MIT)
/// Rows keyed by thread id in each runtime DB, children before parents.
/// `thread_spawn_edges` is listed for both ends, and `threads` comes last.
/// `local_thread_catalog` is deliberately absent.
fn thread_rows(db: CodexRuntimeDb) -> &'static [(&'static str, &'static str)] {
    match db {
        CodexRuntimeDb::Logs => &[("logs", "thread_id")],
        CodexRuntimeDb::Queue => &[
            ("queued_items", "thread_id"),
            // The queued_items delete trigger re-creates this row; clear it after.
            ("queued_thread_revisions", "thread_id"),
        ],
        CodexRuntimeDb::Memories | CodexRuntimeDb::MemoriesV2 => &[("stage1_outputs", "thread_id")],
        CodexRuntimeDb::Goals => &[
            ("thread_goal_continuation_deferrals", "thread_id"),
            ("thread_goals", "thread_id"),
        ],
        CodexRuntimeDb::ThreadHistory => &[
            ("thread_items", "thread_id"),
            ("thread_realtime_items", "thread_id"),
            ("thread_turns", "thread_id"),
            ("thread_history_projection_state", "thread_id"),
        ],
        CodexRuntimeDb::State => &[
            // Tables a state DB from before the 0.157 split still carries.
            ("logs", "thread_id"),
            ("stage1_outputs", "thread_id"),
            ("thread_goals", "thread_id"),
            ("thread_dynamic_tools", "thread_id"),
            ("thread_attachments", "thread_id"),
            ("thread_artifacts", "thread_id"),
            ("thread_spawn_edges", "parent_thread_id"),
            ("thread_spawn_edges", "child_thread_id"),
            ("threads", "id"),
        ],
    }
}

/// Tables of one runtime DB that still hold rows for `thread_ids`.
fn tables_with_thread_rows(
    db: CodexRuntimeDb,
    conn: &Connection,
    thread_ids: &[String],
) -> rusqlite::Result<Vec<&'static str>> {
    let mut tables: Vec<&'static str> = Vec::new();
    for (table, column) in thread_rows(db) {
        if tables.contains(table) || !has_column(conn, table, column)? {
            continue;
        }
        let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column} = ?1)");
        for thread_id in thread_ids {
            if conn.query_row(&sql, [thread_id], |row| row.get::<_, bool>(0))? {
                tables.push(*table);
                break;
            }
        }
    }
    if matches!(db, CodexRuntimeDb::Memories | CodexRuntimeDb::MemoriesV2)
        && has_column(conn, "jobs", "job_key")?
    {
        for thread_id in thread_ids {
            let pending = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM jobs WHERE kind = ?1 AND job_key = ?2)",
                [MEMORY_STAGE1_JOB_KIND, thread_id.as_str()],
                |row| row.get::<_, bool>(0),
            )?;
            if pending {
                tables.push("jobs");
                break;
            }
        }
    }
    Ok(tables)
}

/// Delete every row of `thread_ids` from one runtime DB in one transaction.
/// Foreign keys are on so cascades (thread attachments, goal deferrals)
/// follow their parent; `secure_delete` zeroes the freed pages.
fn delete_thread_rows(
    db: CodexRuntimeDb,
    db_path: &Path,
    thread_ids: &[String],
) -> Result<(), String> {
    let mut conn = open_runtime_db(db_path).map_err(|error| error.to_string())?;
    conn.execute("PRAGMA foreign_keys = ON", [])
        .map_err(|error| error.to_string())?;
    // Setting secure_delete echoes the new value as a row.
    conn.query_row("PRAGMA secure_delete = ON", [], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    for thread_id in thread_ids {
        if matches!(db, CodexRuntimeDb::Memories | CodexRuntimeDb::MemoriesV2) {
            delete_thread_memory(&tx, thread_id).map_err(|error| error.to_string())?;
        }
        for (table, column) in thread_rows(db) {
            if has_column(&tx, table, column).map_err(|error| error.to_string())? {
                tx.execute(
                    &format!("DELETE FROM {table} WHERE {column} = ?1"),
                    [thread_id],
                )
                .map_err(|error| error.to_string())?;
            }
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    // Move the zeroed pages out of the WAL too. Best effort: the rows are
    // already gone and Codex checkpoints on its own.
    let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    Ok(())
}

// Adapted from openai/codex codex-rs/state/src/runtime/memories.rs
// (`delete_thread_memory`, `enqueue_global_consolidation_with_executor`) (MIT)
const MEMORY_STAGE1_JOB_KIND: &str = "memory_stage1";
const MEMORY_CONSOLIDATE_JOB_KIND: &str = "memory_consolidate_global";
const MEMORY_CONSOLIDATE_JOB_KEY: &str = "global";
const MEMORY_JOB_RETRY_REMAINING: i64 = 3;

/// Drop a thread's stage-1 memory and its job. When that memory fed the
/// global phase-2 summary, queue a re-consolidation so the summary stops
/// reflecting the deleted thread, as Codex does.
fn delete_thread_memory(conn: &Connection, thread_id: &str) -> rusqlite::Result<()> {
    if !has_column(conn, "stage1_outputs", "selected_for_phase2")?
        || !has_column(conn, "jobs", "job_key")?
    {
        return Ok(());
    }
    let was_selected = conn
        .query_row(
            "SELECT selected_for_phase2 FROM stage1_outputs WHERE thread_id = ?1",
            [thread_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some_and(|selected| selected != 0);
    let deleted = conn.execute(
        "DELETE FROM stage1_outputs WHERE thread_id = ?1",
        [thread_id],
    )?;
    conn.execute(
        "DELETE FROM jobs WHERE kind = ?1 AND job_key = ?2",
        [MEMORY_STAGE1_JOB_KIND, thread_id],
    )?;
    if deleted > 0 && was_selected {
        conn.execute(
            "INSERT INTO jobs (
                 kind, job_key, status, worker_id, ownership_token, started_at, finished_at,
                 lease_until, retry_at, retry_remaining, last_error, input_watermark,
                 last_success_watermark
             ) VALUES (?1, ?2, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, ?3, NULL, ?4, 0)
             ON CONFLICT(kind, job_key) DO UPDATE SET
                 status = CASE WHEN jobs.status = 'running' THEN 'running' ELSE 'pending' END,
                 retry_at = CASE WHEN jobs.status = 'running' THEN jobs.retry_at ELSE NULL END,
                 retry_remaining = max(jobs.retry_remaining, excluded.retry_remaining),
                 input_watermark = CASE
                     WHEN excluded.input_watermark > COALESCE(jobs.input_watermark, 0)
                         THEN excluded.input_watermark
                     ELSE COALESCE(jobs.input_watermark, 0) + 1
                 END",
            params![
                MEMORY_CONSOLIDATE_JOB_KIND,
                MEMORY_CONSOLIDATE_JOB_KEY,
                MEMORY_JOB_RETRY_REMAINING,
                chrono::Utc::now().timestamp()
            ],
        )?;
    }
    Ok(())
}

/// Rewrites `session_index.jsonl` without the lines whose `id` is one of
/// `session_ids`. Every other line is kept byte-for-byte — parsed only far
/// enough to read `id`, never re-serialized — so no unrelated line's
/// formatting is ever disturbed. A no-op when the file doesn't exist or has
/// no matching line: deleting a session Codex never indexed is not an error.
fn remove_sessions_from_session_index(
    index_path: &Path,
    session_ids: &[String],
) -> Result<(), String> {
    let content = match crate::security_limits::read_to_string_limited(
        index_path,
        crate::security_limits::MAX_CONFIG_FILE_BYTES,
    ) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };

    let mut changed = false;
    let mut kept_lines: Vec<&str> = Vec::new();
    for line in content.lines() {
        let is_match = serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_string))
            .is_some_and(|id| session_ids.contains(&id));
        if is_match {
            changed = true;
        } else {
            kept_lines.push(line);
        }
    }
    if !changed {
        return Ok(());
    }

    let mut rewritten = kept_lines.join("\n");
    if !rewritten.is_empty() {
        rewritten.push('\n');
    }
    crate::config::atomic_write(index_path, rewritten.as_bytes()).map_err(|error| error.to_string())
}

fn parse_session(path: &Path) -> Option<SessionMeta> {
    parse_session_with_titles(path, &HashMap::new())
}

fn parse_session_with_titles(
    path: &Path,
    thread_titles: &HashMap<String, String>,
) -> Option<SessionMeta> {
    let (head, tail) = match read_head_tail_lines(path, 10, 30) {
        Ok(lines) => lines,
        Err(error) => {
            log::warn!(
                "Failed to read Codex session metadata {}: {error}",
                path.display()
            );
            return None;
        }
    };

    let mut session_id: Option<String> = None;
    let mut project_dir: Option<String> = None;
    let mut created_at: Option<i64> = None;
    let mut first_user_message: Option<String> = None;

    // Extract metadata and first user message from head lines
    for line in &head {
        let value: Value = match serde_json::from_str(line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if created_at.is_none() {
            created_at = value.get("timestamp").and_then(parse_timestamp_to_ms);
        }
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            if let Some(payload) = value.get("payload") {
                if is_subagent_source(payload.get("source")) {
                    return None;
                }
                if session_id.is_none() {
                    session_id = payload
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string());
                }
                if project_dir.is_none() {
                    project_dir = payload
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string());
                }
                if let Some(ts) = payload.get("timestamp").and_then(parse_timestamp_to_ms) {
                    created_at.get_or_insert(ts);
                }
            }
        }
        // Extract first user message as title candidate
        if first_user_message.is_none()
            && value.get("type").and_then(Value::as_str) == Some("response_item")
        {
            if let Some(payload) = value.get("payload") {
                if payload.get("type").and_then(Value::as_str) == Some("message")
                    && payload.get("role").and_then(Value::as_str) == Some("user")
                {
                    let text = payload.get("content").map(extract_text).unwrap_or_default();
                    if let Some(title) = title_candidate_from_user_message(&text) {
                        first_user_message = Some(title);
                    }
                }
            }
        }
        if session_id.is_some()
            && project_dir.is_some()
            && created_at.is_some()
            && first_user_message.is_some()
        {
            break;
        }
    }

    // Extract last_active_at and summary from tail lines (reverse order)
    let mut last_active_at: Option<i64> = None;
    let mut summary: Option<String> = None;

    for line in tail.iter().rev() {
        let value: Value = match serde_json::from_str(line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if last_active_at.is_none() {
            last_active_at = value.get("timestamp").and_then(parse_timestamp_to_ms);
        }
        if summary.is_none() && value.get("type").and_then(Value::as_str) == Some("response_item") {
            if let Some(payload) = value.get("payload") {
                if payload.get("type").and_then(Value::as_str) == Some("message") {
                    let text = payload.get("content").map(extract_text).unwrap_or_default();
                    if !text.trim().is_empty() {
                        summary = Some(text);
                    }
                }
            }
        }
        if last_active_at.is_some() && summary.is_some() {
            break;
        }
    }

    let session_id = session_id.or_else(|| infer_session_id_from_filename(path));
    let session_id = session_id?;

    let title = thread_titles
        .get(&session_id)
        .map(|t| truncate_summary(t, TITLE_MAX_CHARS))
        .or_else(|| first_user_message.map(|t| truncate_summary(&t, TITLE_MAX_CHARS)))
        .or_else(|| {
            project_dir
                .as_deref()
                .and_then(path_basename)
                .map(|v| v.to_string())
        });

    let summary = summary.map(|text| truncate_summary(&text, 160));

    Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id: session_id.clone(),
        title,
        summary,
        project_dir,
        created_at,
        last_active_at,
        source_path: Some(path.to_string_lossy().to_string()),
        resume_command: super::utils::is_uuid(&session_id)
            .then(|| super::utils::resume_command("codex resume", &session_id))
            .flatten(),
    })
}

fn is_subagent_source(source: Option<&Value>) -> bool {
    source
        .and_then(|value| value.as_object())
        .map(|source| source.contains_key("subagent"))
        .unwrap_or(false)
}

fn title_candidate_from_user_message(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("# AGENTS.md")
        || trimmed.starts_with("<environment_context>")
    {
        return None;
    }

    if trimmed.starts_with(VSCODE_CONTEXT_PREFIX) {
        return extract_codex_prompt_from_ide_context(trimmed);
    }

    Some(trimmed.to_string())
}

fn extract_codex_prompt_from_ide_context(text: &str) -> Option<String> {
    let normalized = text.replace("\r\n", "\n");
    let lines = normalized.lines().collect::<Vec<_>>();

    // VS Code injects the real prompt as the LAST "## My request for Codex:"
    // section, so keep the final matching heading. Earlier matches can be
    // headings that live inside the active selection / open file content.
    // Trade-off: if the request body itself repeats the heading, the title
    // truncates to its trailing part (rare; covered by tests below).
    let mut prompt: Option<String> = None;
    for (index, line) in lines.iter().enumerate() {
        let Some(inline_prompt) = codex_request_heading_payload(line) else {
            continue;
        };

        if !inline_prompt.is_empty() {
            prompt = Some(inline_prompt.to_string());
            continue;
        }

        let following_prompt = lines[index + 1..].join("\n").trim().to_string();
        prompt = (!following_prompt.is_empty()).then_some(following_prompt);
    }

    prompt
}

fn codex_request_heading_payload(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if !trimmed.starts_with('#') {
        return None;
    }

    let heading = trimmed.trim_start_matches('#').trim_start();
    let lowered = heading.to_ascii_lowercase();
    if !lowered.starts_with(CODEX_REQUEST_MARKER) {
        return None;
    }

    let suffix = heading[CODEX_REQUEST_MARKER.len()..].trim_start();
    if suffix.is_empty() {
        return Some("");
    }

    let Some(separator) = suffix.chars().next() else {
        return Some("");
    };
    if !matches!(separator, ':' | '：' | '-' | '—') {
        return None;
    }

    Some(
        suffix
            .trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ':' | '：' | '-' | '—'))
            .trim(),
    )
}

fn infer_session_id_from_filename(path: &Path) -> Option<String> {
    let file_name = path.file_name()?.to_string_lossy();
    UUID_RE.find(&file_name).map(|mat| mat.as_str().to_string())
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<PathBuf>) {
    collect_jsonl_files_at_depth(root, files, 0);
}

fn collect_jsonl_files_at_depth(root: &Path, files: &mut Vec<PathBuf>, depth: usize) {
    if depth > crate::security_limits::MAX_SESSION_SCAN_DEPTH {
        log::warn!(
            "Skipping Codex session directory beyond scan depth: {}",
            root.display()
        );
        return;
    }
    let metadata = match std::fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(_) => return,
    };
    if metadata.file_type().is_symlink() {
        return;
    }

    let entries = match crate::security_limits::read_dir_without_links(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_jsonl_files_at_depth(&path, files, depth + 1);
        } else if metadata.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
        {
            // No whole-file size gate here: `parse_session_with_titles` only
            // ever reads a bounded head/tail slice of the file (see
            // `read_head_tail_lines`), so a large rollout costs nothing
            // extra to look at. Filtering it out here used to make it
            // vanish from the session list entirely instead of just being
            // slower to index.
            files.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_state_db::CODEX_STATE_DB_FILENAME;
    use tempfile::tempdir;

    fn write_codex_session(path: &Path, session_id: &str, message: &str) {
        std::fs::write(
            path,
            format!(
                "{{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"cwd\":\"/tmp/project\"}}}}\n\
                 {{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":\"{message}\"}}}}\n",
            ),
        )
        .expect("write session");
    }

    #[test]
    fn scan_sessions_in_roots_includes_active_and_archived_files() {
        let temp = tempdir().expect("tempdir");
        let active = temp.path().join("sessions");
        let archived = temp.path().join("archived_sessions");
        std::fs::create_dir_all(&active).expect("active dir");
        std::fs::create_dir_all(&archived).expect("archived dir");

        write_codex_session(&active.join("active.jsonl"), "active-id", "Active session");
        write_codex_session(
            &archived.join("archived.jsonl"),
            "archived-id",
            "Archived session",
        );

        let sessions = scan_sessions_in_roots(&[active, archived]);
        let ids = sessions
            .into_iter()
            .map(|session| session.session_id)
            .collect::<Vec<_>>();

        assert!(ids.contains(&"active-id".to_string()));
        assert!(ids.contains(&"archived-id".to_string()));
    }

    #[test]
    fn delete_session_removes_jsonl_file() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            temp.path().join("config.toml"),
            format!("sqlite_home = '{}'\n", temp.path().display()),
        )
        .unwrap();
        let path =
            root.join("rollout-2026-03-06T21-50-12-019cc369-bd7c-7891-b371-7b20b4fe0b18.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"019cc369-bd7c-7891-b371-7b20b4fe0b18\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"hello\"}}\n"
            ),
        )
        .expect("write session");

        delete_session(&root, &path, "019cc369-bd7c-7891-b371-7b20b4fe0b18")
            .expect("delete session");

        assert!(!path.exists());
    }

    #[test]
    fn delete_session_also_cleans_session_index_and_state_db() {
        let temp = tempdir().expect("tempdir");
        let config_dir = temp.path();
        let sessions_root = config_dir.join("sessions");
        std::fs::create_dir_all(&sessions_root).expect("create sessions dir");
        std::fs::write(
            config_dir.join("config.toml"),
            format!("sqlite_home = '{}'\n", config_dir.display()),
        )
        .unwrap();

        let session_id = "019cc369-bd7c-7891-b371-7b20b4fe0b18";
        let other_id = "029cc369-bd7c-7891-b371-7b20b4fe0b19";
        let path = sessions_root.join(format!("rollout-2026-03-06T21-50-12-{session_id}.jsonl"));
        std::fs::write(
            &path,
            format!(
                "{{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"cwd\":\"/tmp/project\"}}}}\n"
            ),
        )
        .expect("write session");

        // session_index.jsonl: one matching line to be removed, one other
        // thread's line that must survive byte-for-byte.
        let other_line = format!(r#"{{"id":"{other_id}","thread_name":"Keep me"}}"#);
        std::fs::write(
            config_dir.join(CODEX_SESSION_INDEX_FILENAME),
            format!("{{\"id\":\"{session_id}\",\"thread_name\":\"Delete me\"}}\n{other_line}\n"),
        )
        .expect("write session_index.jsonl");

        // state_5.sqlite: one matching row to be removed, one other row that
        // must survive.
        let db_path = config_dir.join(crate::codex_state_db::CODEX_STATE_DB_FILENAME);
        let conn = Connection::open(&db_path).expect("open state db");
        conn.execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT);",
        )
        .expect("create threads table");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, 'Delete me', NULL)",
            [session_id],
        )
        .expect("insert target row");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, 'Keep me', NULL)",
            [other_id],
        )
        .expect("insert other row");
        drop(conn);

        delete_session(&sessions_root, &path, session_id).expect("delete session");

        assert!(!path.exists());

        let index_content =
            std::fs::read_to_string(config_dir.join(CODEX_SESSION_INDEX_FILENAME)).unwrap();
        assert!(!index_content.contains(session_id));
        assert!(index_content.contains(&other_line));

        let conn = Connection::open(&db_path).expect("reopen state db");
        let remaining: Vec<String> = conn
            .prepare("SELECT id FROM threads")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(remaining, vec![other_id.to_string()]);
    }

    #[test]
    fn parse_session_uses_first_user_message_as_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"How do I deploy?\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:14Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"Here is how...\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("How do I deploy?"));
    }

    #[test]
    fn parse_session_prefers_thread_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"How do I deploy?\"}}\n"
            ),
        )
        .expect("write");

        let mut thread_titles = HashMap::new();
        thread_titles.insert(
            "test-id".to_string(),
            "Renamed deployment thread".to_string(),
        );

        let meta = parse_session_with_titles(&path, &thread_titles).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Renamed deployment thread"));
    }

    #[test]
    fn load_thread_titles_from_state_db_trims_and_filters_titles() {
        let temp = tempdir().expect("tempdir");
        let db_path = temp.path().join(CODEX_STATE_DB_FILENAME);
        let conn = Connection::open(&db_path).expect("open sqlite db");
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, first_user_message TEXT NOT NULL)",
            [],
        )
        .expect("create threads table");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-1", "  Renamed Codex thread  ", "First prompt"),
        )
        .expect("insert renamed thread");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-2", "   ", "First prompt"),
        )
        .expect("insert blank thread");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-3", "  First prompt  ", "First prompt"),
        )
        .expect("insert first-message title");
        drop(conn);

        let titles = load_thread_titles_from_db(&db_path);

        assert_eq!(
            titles.get("thread-1").map(String::as_str),
            Some("Renamed Codex thread")
        );
        assert!(!titles.contains_key("thread-2"));
        assert!(!titles.contains_key("thread-3"));
    }

    #[test]
    fn load_thread_titles_from_state_db_keeps_title_when_first_user_message_null() {
        let temp = tempdir().expect("tempdir");
        let db_path = temp.path().join(CODEX_STATE_DB_FILENAME);
        let conn = Connection::open(&db_path).expect("open sqlite db");
        // Codex stores first_user_message as a nullable column (Option<String>);
        // a renamed thread can have a title before any first message is synced.
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, first_user_message TEXT)",
            [],
        )
        .expect("create threads table");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, NULL)",
            ("thread-1", "Renamed thread"),
        )
        .expect("insert renamed thread without first message");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-2", "First prompt", "First prompt"),
        )
        .expect("insert first-message title");
        drop(conn);

        let titles = load_thread_titles_from_db(&db_path);

        // Kept: title present and no first message to compare against.
        assert_eq!(
            titles.get("thread-1").map(String::as_str),
            Some("Renamed thread")
        );
        // Filtered: title equals the first user message.
        assert!(!titles.contains_key("thread-2"));
    }

    #[test]
    fn load_thread_titles_from_session_index_uses_latest_name() {
        let temp = tempdir().expect("tempdir");
        let index_path = temp.path().join(CODEX_SESSION_INDEX_FILENAME);
        std::fs::write(
            &index_path,
            concat!(
                "{\"id\":\"thread-1\",\"thread_name\":\"Old name\",\"updated_at\":\"2026-07-01T00:00:00Z\"}\n",
                "{\"id\":\"thread-2\",\"thread_name\":\"   \",\"updated_at\":\"2026-07-01T00:00:00Z\"}\n",
                "not json\n",
                "{\"id\":\"thread-1\",\"thread_name\":\"  New name  \",\"updated_at\":\"2026-07-02T00:00:00Z\"}\n"
            ),
        )
        .expect("write session index");

        let titles = load_thread_titles_from_session_index(&index_path);

        assert_eq!(titles.get("thread-1").map(String::as_str), Some("New name"));
        assert!(!titles.contains_key("thread-2"));
    }

    #[test]
    fn load_thread_titles_prefers_state_db_explicit_title_over_session_index() {
        let temp = tempdir().expect("tempdir");
        let index_path = temp.path().join(CODEX_SESSION_INDEX_FILENAME);
        std::fs::write(
            &index_path,
            concat!(
                "{\"id\":\"thread-1\",\"thread_name\":\"Legacy name\",\"updated_at\":\"2026-07-01T00:00:00Z\"}\n",
                "{\"id\":\"thread-2\",\"thread_name\":\"Legacy fallback\",\"updated_at\":\"2026-07-01T00:00:00Z\"}\n"
            ),
        )
        .expect("write session index");

        let db_path = temp.path().join(CODEX_STATE_DB_FILENAME);
        let conn = Connection::open(&db_path).expect("open sqlite db");
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, first_user_message TEXT NOT NULL)",
            [],
        )
        .expect("create threads table");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-1", "SQLite name", "First prompt"),
        )
        .expect("insert sqlite title");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-2", "First prompt", "First prompt"),
        )
        .expect("insert first-message sqlite title");
        drop(conn);

        let titles = load_thread_titles_from_paths(&index_path, &[db_path]);

        assert_eq!(
            titles.get("thread-1").map(String::as_str),
            Some("SQLite name")
        );
        assert_eq!(
            titles.get("thread-2").map(String::as_str),
            Some("Legacy fallback")
        );
    }

    #[test]
    fn parse_session_skips_agents_md_injection() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"developer\",\"content\":\"<permissions>\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# AGENTS.md instructions for /tmp/project\\n<INSTRUCTIONS>Do stuff</INSTRUCTIONS>\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:14Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"Fix the login bug\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        // Should skip AGENTS.md injection and use the real user message
        assert_eq!(meta.title.as_deref(), Some("Fix the login bug"));
    }

    #[test]
    fn parse_session_skips_subagent_sessions() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-04-28T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"subagent-id\",\"cwd\":\"/tmp/project\",\"originator\":\"codex-tui\",\"source\":{\"subagent\":{\"thread_spawn\":{\"parent_thread_id\":\"parent-id\",\"depth\":1,\"agent_role\":\"explorer\"}}}}}\n",
                "{\"timestamp\":\"2026-04-28T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"Inspect the project\"}}\n"
            ),
        )
        .expect("write");

        assert!(parse_session(&path).is_none());
    }

    #[test]
    fn parse_session_skips_environment_context_injection() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"<environment_context>\\n  <cwd>/tmp/project</cwd>\\n</environment_context>\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:14Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"Fix the login bug\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        // Should skip environment_context injection and use the real user message
        assert_eq!(meta.title.as_deref(), Some("Fix the login bug"));
    }

    #[test]
    fn parse_session_extracts_vscode_ide_request_as_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## Active file: src/main.ts\\n\\n## My request for Codex:\\nFix the session title preview\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Fix the session title preview"));
    }

    #[test]
    fn parse_session_extracts_inline_vscode_ide_request_as_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## My request for Codex: Fix the TOC preview\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Fix the TOC preview"));
    }

    #[test]
    fn parse_session_ignores_marker_mentions_before_request_heading() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## Active selection:\\nMy request for Codex: not the prompt\\n\\n## My request for Codex:\\nUse the real request heading\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Use the real request heading"));
    }

    #[test]
    fn parse_session_uses_last_request_heading_when_selection_has_one() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## Active selection: docs/codex-format.md\\n## My request for Codex:\\nselected document content, not the real request\\n\\n## My request for Codex:\\nUse the last request heading\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Use the last request heading"));
    }

    // Known limitation: the IDE marker is matched purely by text, so a
    // "## My request for Codex:" line inside the real request body is treated as
    // a new boundary and only the trailing part is kept. This pins the
    // best-effort behavior; fully fixing it needs structured IDE section data
    // that the Codex VS Code context does not provide.
    #[test]
    fn parse_session_keeps_trailing_part_when_request_body_repeats_heading() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## Active file: foo.ts\\n\\n## My request for Codex:\\nDocument the format, for example:\\n## My request for Codex:\\nand the rest follows.\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("and the rest follows."));
    }

    #[test]
    fn parse_session_skips_vscode_ide_context_without_request() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## Active file: src/main.ts\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:14Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"Fix the login bug\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Fix the login bug"));
    }

    #[test]
    fn parse_session_falls_back_to_dir_basename() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/my-project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"Hello\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        // No user message → falls back to dir basename
        assert_eq!(meta.title.as_deref(), Some("my-project"));
    }

    #[test]
    fn parse_session_truncates_long_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        let long_msg = "a".repeat(200);
        std::fs::write(
            &path,
            format!(
                "{{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"test-id\",\"cwd\":\"/tmp/p\"}}}}\n\
                 {{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":\"{long_msg}\"}}}}\n",
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        let title = meta.title.unwrap();
        assert!(title.len() <= TITLE_MAX_CHARS + 3); // +3 for "..."
        assert!(title.ends_with("..."));
    }

    #[test]
    fn load_messages_includes_function_call_and_output() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"list files\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:14Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"cmd\\\":[\\\"ls\\\"]}\",\"call_id\":\"call_1\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:15Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_1\",\"output\":\"file1.txt\\nfile2.txt\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:16Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Done.\"}]}}\n",
            ),
        )
        .expect("write");

        let msgs = load_messages(&path).expect("load");
        assert_eq!(msgs.len(), 4);

        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "list files");

        assert_eq!(msgs[1].role, "assistant");
        assert!(msgs[1].content.contains("[Tool: shell]"));

        assert_eq!(msgs[2].role, "tool");
        assert!(msgs[2].content.contains("file1.txt"));

        assert_eq!(msgs[3].role, "assistant");
        assert_eq!(msgs[3].content, "Done.");
    }

    #[test]
    fn unsafe_metadata_id_stays_readable_and_deletable_without_resume() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        let path = root.join("rollout.jsonl");
        std::fs::write(
            temp.path().join("config.toml"),
            format!("sqlite_home = '{}'\n", temp.path().display()),
        )
        .unwrap();
        let id = "bad;echo injected";
        write_codex_session(&path, id, "Still readable");
        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.session_id, id);
        assert!(meta.resume_command.is_none());
        assert!(!load_messages(&path).unwrap().is_empty());
        assert!(delete_session(&root, &path, id).unwrap().source_deleted);
        assert!(!path.exists());
    }

    #[test]
    fn compressed_sessions_load_metadata_messages_and_filename_uuid() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        let id = "019cc369-bd7c-7891-b371-7b20b4fe0b18";
        let plain = root.join("fixture.jsonl");
        write_codex_session(&plain, id, "压缩会话");
        let content = std::fs::read(&plain).unwrap();
        std::fs::remove_file(&plain).unwrap();
        let path = root.join(format!("rollout-{id}.jsonl.zst"));
        std::fs::write(&path, zstd::stream::encode_all(&content[..], 1).unwrap()).unwrap();
        let sessions = scan_sessions_in_roots_with_titles(&[root], &HashMap::new());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, id);
        assert_eq!(sessions[0].title.as_deref(), Some("压缩会话"));
        assert_eq!(load_messages(&path).unwrap()[0].content, "压缩会话");

        // Older rollouts may have no session_meta; filename UUID is still valid
        // only after the compressed stream was successfully read and validated.
        let message_only = content.split(|byte| *byte == b'\n').nth(1).unwrap();
        std::fs::write(&path, zstd::stream::encode_all(message_only, 1).unwrap()).unwrap();
        assert_eq!(parse_session(&path).unwrap().session_id, id);
        assert_eq!(load_messages(&path).unwrap().len(), 1);
        std::fs::write(&path, b"invalid zstd").unwrap();
        assert!(parse_session(&path).is_none());
        assert!(load_messages(&path)
            .unwrap_err()
            .contains("Failed to read session file"));
    }

    #[test]
    fn delete_reports_locked_database_as_partial_and_missing_rollout_retry_finishes() {
        let temp = tempdir().unwrap();
        let config_dir = temp.path();
        let root = config_dir.join("sessions");
        std::fs::create_dir(&root).unwrap();
        let sqlite_home = config_dir.join("sqlite-home");
        std::fs::create_dir(&sqlite_home).unwrap();
        std::fs::write(
            config_dir.join("config.toml"),
            format!("sqlite_home = '{}'\n", sqlite_home.display()),
        )
        .unwrap();
        let other_db = Connection::open(sqlite_home.join(CODEX_STATE_DB_FILENAME)).unwrap();
        other_db.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads VALUES ('locked-session');").unwrap();
        let id = "locked-session";
        let path = root.join("rollout.jsonl");
        write_codex_session(&path, id, "hello");
        let index = config_dir.join(CODEX_SESSION_INDEX_FILENAME);
        std::fs::write(
            &index,
            format!("{{\"id\":\"{id}\",\"thread_name\":\"delete\"}}\n"),
        )
        .unwrap();
        let conn = Connection::open(config_dir.join(CODEX_STATE_DB_FILENAME)).unwrap();
        conn.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads VALUES ('locked-session'); BEGIN IMMEDIATE;").unwrap();
        let partial = delete_session(&root, &path, id).unwrap();
        assert!(partial.source_deleted);
        assert!(partial.cleanup_pending);
        assert!(partial
            .error
            .as_deref()
            .unwrap()
            .contains("content has been deleted"));
        assert!(!path.exists());
        assert!(!std::fs::read_to_string(&index).unwrap().contains(id));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM threads", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            other_db
                .query_row("SELECT COUNT(*) FROM threads", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0,
            "one locked DB must not prevent cleaning another"
        );
        conn.execute_batch("ROLLBACK").unwrap();
        let retried = delete_session(&root, &path, id).unwrap();
        assert!(retried.source_deleted && !retried.cleanup_pending);
        assert!(retried.error.is_none());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM threads", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn delete_attempts_database_cleanup_even_when_index_is_unreadable() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            temp.path().join("config.toml"),
            format!("sqlite_home = '{}'\n", temp.path().display()),
        )
        .unwrap();
        let index = temp.path().join(CODEX_SESSION_INDEX_FILENAME);
        std::fs::create_dir(&index).unwrap();
        let conn = Connection::open(temp.path().join(CODEX_STATE_DB_FILENAME)).unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads VALUES ('s1');",
        )
        .unwrap();
        let missing = root.join("missing.jsonl");
        let partial = delete_session(&root, &missing, "s1").unwrap();
        assert!(partial.source_deleted && partial.cleanup_pending);
        assert!(partial
            .error
            .unwrap()
            .contains(CODEX_SESSION_INDEX_FILENAME));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM threads", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        std::fs::remove_dir(&index).unwrap();
        assert!(
            !delete_session(&root, &missing, "s1")
                .unwrap()
                .cleanup_pending
        );
    }

    #[test]
    fn invalid_config_still_cleans_default_stores_but_reports_unknown_sqlite_location() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(temp.path().join("config.toml"), "sqlite_home = [").unwrap();
        let index = temp.path().join(CODEX_SESSION_INDEX_FILENAME);
        std::fs::write(&index, "{\"id\":\"s1\"}\n").unwrap();
        let result = delete_session_records(&root, "s1").unwrap();
        assert!(result.source_deleted && result.cleanup_pending);
        assert!(result.error.unwrap().contains("config.toml"));
        assert!(std::fs::read_to_string(index).unwrap().is_empty());
    }

    // Codex 0.157 DDL from codex-rs/state/*migrations; `threads` is trimmed to
    // the columns a delete touches, everything else is verbatim.
    const STATE_SCHEMA: &str = "
        CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, title TEXT NOT NULL);
        CREATE TABLE thread_dynamic_tools (
            thread_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            input_schema TEXT NOT NULL,
            PRIMARY KEY(thread_id, position),
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );
        CREATE TABLE thread_spawn_edges (
            parent_thread_id TEXT NOT NULL,
            child_thread_id TEXT NOT NULL PRIMARY KEY,
            status TEXT NOT NULL
        );
        CREATE TABLE thread_attachments (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            attachment_type TEXT NOT NULL,
            identity_key TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE (thread_id, attachment_type, identity_key)
        );
        CREATE TABLE local_thread_catalog (thread_id TEXT PRIMARY KEY);
    ";
    const LOGS_SCHEMA: &str = "
        CREATE TABLE logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            ts_nanos INTEGER NOT NULL,
            level TEXT NOT NULL,
            target TEXT NOT NULL,
            feedback_log_body TEXT,
            module_path TEXT,
            file TEXT,
            line INTEGER,
            thread_id TEXT,
            process_uuid TEXT,
            estimated_bytes INTEGER NOT NULL DEFAULT 0
        );
    ";
    const QUEUE_SCHEMA: &str = "
        CREATE TABLE queued_items (
            id TEXT PRIMARY KEY NOT NULL,
            thread_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            queue_order INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE queued_thread_revisions (
            revision INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT NOT NULL UNIQUE
        );
        CREATE TRIGGER queued_items_revision_after_insert
        AFTER INSERT ON queued_items
        BEGIN
            INSERT INTO queued_thread_revisions (thread_id)
            VALUES (NEW.thread_id)
            ON CONFLICT(thread_id) DO UPDATE
            SET revision = (SELECT COALESCE(MAX(revision), 0) + 1 FROM queued_thread_revisions);
        END;
        CREATE TRIGGER queued_items_revision_after_delete
        AFTER DELETE ON queued_items
        BEGIN
            INSERT INTO queued_thread_revisions (thread_id)
            VALUES (OLD.thread_id)
            ON CONFLICT(thread_id) DO UPDATE
            SET revision = (SELECT COALESCE(MAX(revision), 0) + 1 FROM queued_thread_revisions);
        END;
    ";
    const MEMORIES_SCHEMA: &str = "
        CREATE TABLE stage1_outputs (
            thread_id TEXT PRIMARY KEY,
            source_updated_at INTEGER NOT NULL,
            raw_memory TEXT NOT NULL,
            rollout_summary TEXT NOT NULL,
            rollout_slug TEXT,
            generated_at INTEGER NOT NULL,
            usage_count INTEGER,
            last_usage INTEGER,
            selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
            selected_for_phase2_source_updated_at INTEGER
        );
        CREATE TABLE jobs (
            kind TEXT NOT NULL,
            job_key TEXT NOT NULL,
            status TEXT NOT NULL,
            worker_id TEXT,
            ownership_token TEXT,
            started_at INTEGER,
            finished_at INTEGER,
            lease_until INTEGER,
            retry_at INTEGER,
            retry_remaining INTEGER NOT NULL,
            last_error TEXT,
            input_watermark INTEGER,
            last_success_watermark INTEGER,
            PRIMARY KEY (kind, job_key)
        );
    ";
    const GOALS_SCHEMA: &str = "
        CREATE TABLE thread_goals (
            thread_id TEXT PRIMARY KEY NOT NULL,
            goal_id TEXT NOT NULL,
            objective TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN (
                'active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'
            )),
            token_budget INTEGER,
            tokens_used INTEGER NOT NULL DEFAULT 0,
            time_used_seconds INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE thread_goal_continuation_deferrals (
            thread_id TEXT PRIMARY KEY NOT NULL REFERENCES thread_goals(thread_id) ON DELETE CASCADE
        );
    ";
    const THREAD_HISTORY_SCHEMA: &str = "
        CREATE TABLE thread_turns (
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            rollout_ordinal INTEGER NOT NULL,
            status TEXT NOT NULL,
            error_json TEXT,
            started_at INTEGER,
            completed_at INTEGER,
            duration_ms INTEGER,
            first_user_item_id TEXT,
            final_agent_item_id TEXT,
            PRIMARY KEY (thread_id, turn_id)
        );
        CREATE TABLE thread_items (
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            rollout_ordinal INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            item_json TEXT NOT NULL,
            PRIMARY KEY (thread_id, turn_id, item_id)
        );
        CREATE TABLE thread_history_projection_state (
            thread_id TEXT PRIMARY KEY,
            next_rollout_byte_offset INTEGER NOT NULL,
            next_rollout_ordinal INTEGER NOT NULL
        );
        CREATE TABLE thread_realtime_items (
            thread_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            rollout_ordinal INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            item_type TEXT NOT NULL,
            item_json TEXT NOT NULL,
            PRIMARY KEY (thread_id, item_id)
        );
        CREATE TRIGGER thread_realtime_items_projection_cleanup
            AFTER DELETE ON thread_history_projection_state
        BEGIN
            DELETE FROM thread_realtime_items WHERE thread_id = OLD.thread_id;
        END;
    ";

    /// Every per-thread table the delete must clear, per runtime DB.
    const THREAD_TABLES: &[(CodexRuntimeDb, &str, &str)] = &[
        (CodexRuntimeDb::Logs, "logs", "thread_id"),
        (CodexRuntimeDb::Queue, "queued_items", "thread_id"),
        (
            CodexRuntimeDb::Queue,
            "queued_thread_revisions",
            "thread_id",
        ),
        (CodexRuntimeDb::Memories, "stage1_outputs", "thread_id"),
        (CodexRuntimeDb::Memories, "jobs", "job_key"),
        (CodexRuntimeDb::Goals, "thread_goals", "thread_id"),
        (
            CodexRuntimeDb::Goals,
            "thread_goal_continuation_deferrals",
            "thread_id",
        ),
        (CodexRuntimeDb::ThreadHistory, "thread_turns", "thread_id"),
        (CodexRuntimeDb::ThreadHistory, "thread_items", "thread_id"),
        (
            CodexRuntimeDb::ThreadHistory,
            "thread_realtime_items",
            "thread_id",
        ),
        (
            CodexRuntimeDb::ThreadHistory,
            "thread_history_projection_state",
            "thread_id",
        ),
        (CodexRuntimeDb::State, "threads", "id"),
        (CodexRuntimeDb::State, "thread_dynamic_tools", "thread_id"),
        (CodexRuntimeDb::State, "thread_attachments", "thread_id"),
        (
            CodexRuntimeDb::State,
            "thread_spawn_edges",
            "child_thread_id",
        ),
    ];

    fn create_runtime_dbs(home: &Path, dbs: &[CodexRuntimeDb]) {
        for db in dbs {
            let schema = match db {
                CodexRuntimeDb::Logs => LOGS_SCHEMA,
                CodexRuntimeDb::Queue => QUEUE_SCHEMA,
                CodexRuntimeDb::Memories | CodexRuntimeDb::MemoriesV2 => MEMORIES_SCHEMA,
                CodexRuntimeDb::Goals => GOALS_SCHEMA,
                CodexRuntimeDb::ThreadHistory => THREAD_HISTORY_SCHEMA,
                CodexRuntimeDb::State => STATE_SCHEMA,
            };
            let conn = Connection::open(home.join(db.filename())).unwrap();
            // Codex runs its stores in WAL mode.
            let _: String = conn
                .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
                .unwrap();
            conn.execute_batch(schema).unwrap();
        }
    }

    /// One row per per-thread table for `id`, like a thread Codex has used.
    fn seed_thread(home: &Path, id: &str, parent: Option<&str>) {
        let open = |db: CodexRuntimeDb| Connection::open(home.join(db.filename())).unwrap();
        let state = open(CodexRuntimeDb::State);
        state
            .execute(
                "INSERT INTO threads VALUES (?1, 'rollout.jsonl', 'title')",
                [id],
            )
            .unwrap();
        state
            .execute(
                "INSERT INTO thread_dynamic_tools VALUES (?1, 0, 'tool', 'd', '{}')",
                [id],
            )
            .unwrap();
        state
            .execute(
                "INSERT INTO thread_attachments VALUES (?1 || '-a', ?1, 'image', 'k', '{}', 0)",
                [id],
            )
            .unwrap();
        state
            .execute("INSERT INTO local_thread_catalog VALUES (?1)", [id])
            .unwrap();
        if let Some(parent) = parent {
            state
                .execute(
                    "INSERT INTO thread_spawn_edges VALUES (?1, ?2, 'running')",
                    [parent, id],
                )
                .unwrap();
        }
        open(CodexRuntimeDb::Logs)
            .execute(
                "INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES (0, 0, 'INFO', 't', ?1)",
                [id],
            )
            .unwrap();
        open(CodexRuntimeDb::Queue)
            .execute(
                "INSERT INTO queued_items VALUES (?1 || '-q', ?1, '{}', 0, 0, 0)",
                [id],
            )
            .unwrap();
        let memories = open(CodexRuntimeDb::Memories);
        memories
            .execute(
                "INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, generated_at, selected_for_phase2) VALUES (?1, 0, 'm', 's', 0, 1)",
                [id],
            )
            .unwrap();
        memories
            .execute(
                "INSERT INTO jobs (kind, job_key, status, retry_remaining) VALUES ('memory_stage1', ?1, 'done', 0)",
                [id],
            )
            .unwrap();
        let goals = open(CodexRuntimeDb::Goals);
        goals
            .execute(
                "INSERT INTO thread_goals (thread_id, goal_id, objective, status, created_at_ms, updated_at_ms) VALUES (?1, 'g', 'o', 'active', 0, 0)",
                [id],
            )
            .unwrap();
        goals
            .execute(
                "INSERT INTO thread_goal_continuation_deferrals VALUES (?1)",
                [id],
            )
            .unwrap();
        let history = open(CodexRuntimeDb::ThreadHistory);
        history
            .execute_batch(&format!(
                "INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES ('{id}', 't', 0, 'done');
                 INSERT INTO thread_items VALUES ('{id}', 't', 'i', 0, 0, '{{}}');
                 INSERT INTO thread_realtime_items VALUES ('{id}', 'r', 0, 0, 'x', '{{}}');
                 INSERT INTO thread_history_projection_state VALUES ('{id}', 0, 0);"
            ))
            .unwrap();
    }

    fn count_rows(home: &Path, db: CodexRuntimeDb, table: &str, column: &str, id: &str) -> i64 {
        let conn = Connection::open(home.join(db.filename())).unwrap();
        conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?1"),
            [id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn codex_home_with_sessions(temp: &Path) -> (PathBuf, PathBuf) {
        let sessions = temp.join("sessions");
        let archived = temp.join("archived_sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::create_dir_all(&archived).unwrap();
        std::fs::write(
            temp.join("config.toml"),
            format!("sqlite_home = '{}'\n", temp.display()),
        )
        .unwrap();
        (sessions, archived)
    }

    const ROOT_ID: &str = "019cc369-bd7c-7891-b371-7b20b4fe0b18";
    const CHILD_ID: &str = "029cc369-bd7c-7891-b371-7b20b4fe0b19";
    const GRANDCHILD_ID: &str = "039cc369-bd7c-7891-b371-7b20b4fe0b1a";
    const OTHER_ID: &str = "049cc369-bd7c-7891-b371-7b20b4fe0b1b";
    const OTHER_CHILD_ID: &str = "059cc369-bd7c-7891-b371-7b20b4fe0b1c";

    fn rollout_name(id: &str, extension: &str) -> String {
        format!("rollout-2026-03-06T21-50-12-{id}.{extension}")
    }

    #[test]
    fn delete_clears_the_spawned_subtree_from_every_runtime_db_after_backing_them_up() {
        let temp = tempdir().unwrap();
        let home = temp.path();
        let (sessions, archived) = codex_home_with_sessions(home);
        let all_dbs = [
            CodexRuntimeDb::Logs,
            CodexRuntimeDb::Queue,
            CodexRuntimeDb::Memories,
            CodexRuntimeDb::Goals,
            CodexRuntimeDb::ThreadHistory,
            CodexRuntimeDb::State,
        ];
        create_runtime_dbs(home, &all_dbs);
        // Like a running-then-closed Codex, keep a writer open so the seeded
        // rows are still in the -wal file when the backup is taken.
        let wal_writer = Connection::open(home.join(CODEX_STATE_DB_FILENAME)).unwrap();
        seed_thread(home, ROOT_ID, None);
        seed_thread(home, CHILD_ID, Some(ROOT_ID));
        seed_thread(home, GRANDCHILD_ID, Some(CHILD_ID));
        seed_thread(home, OTHER_ID, None);
        seed_thread(home, OTHER_CHILD_ID, Some(OTHER_ID));

        let main = sessions.join(rollout_name(ROOT_ID, "jsonl"));
        write_codex_session(&main, ROOT_ID, "root");
        let child = sessions.join(rollout_name(CHILD_ID, "jsonl"));
        write_codex_session(&child, CHILD_ID, "child");
        let grandchild = archived.join(rollout_name(GRANDCHILD_ID, "jsonl.zst"));
        std::fs::write(&grandchild, b"compressed").unwrap();
        let other = sessions.join(rollout_name(OTHER_ID, "jsonl"));
        write_codex_session(&other, OTHER_ID, "other");
        let other_line = format!(r#"{{"id":"{OTHER_ID}","thread_name":"Keep"}}"#);
        std::fs::write(
            home.join(CODEX_SESSION_INDEX_FILENAME),
            format!(
                "{{\"id\":\"{ROOT_ID}\",\"thread_name\":\"Root\"}}\n{{\"id\":\"{CHILD_ID}\",\"thread_name\":\"Child\"}}\n{other_line}\n"
            ),
        )
        .unwrap();

        let result = delete_session(&sessions, &main, ROOT_ID).unwrap();
        assert!(
            result.source_deleted && !result.cleanup_pending,
            "{:?}",
            result.error
        );

        for (db, table, column) in THREAD_TABLES {
            for id in [ROOT_ID, CHILD_ID, GRANDCHILD_ID] {
                assert_eq!(
                    count_rows(home, *db, table, column, id),
                    0,
                    "{table} still holds {id}"
                );
            }
            for id in [OTHER_ID, OTHER_CHILD_ID] {
                assert_eq!(
                    count_rows(home, *db, table, column, id),
                    if *table == "thread_spawn_edges" && id == OTHER_ID {
                        0
                    } else {
                        1
                    },
                    "{table} lost unrelated {id}"
                );
            }
        }
        // Left alone until it has been verified on a real machine.
        assert_eq!(
            count_rows(
                home,
                CodexRuntimeDb::State,
                "local_thread_catalog",
                "thread_id",
                ROOT_ID
            ),
            1
        );
        // The deleted memories fed phase 2, so a re-consolidation is queued.
        assert_eq!(
            count_rows(
                home,
                CodexRuntimeDb::Memories,
                "jobs",
                "kind",
                "memory_consolidate_global"
            ),
            1
        );

        assert!(!main.exists() && !child.exists() && !grandchild.exists());
        assert!(other.exists());
        let index = std::fs::read_to_string(home.join(CODEX_SESSION_INDEX_FILENAME)).unwrap();
        assert_eq!(index, format!("{other_line}\n"));

        let generations: Vec<_> = std::fs::read_dir(home.join("session-delete-backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(generations.len(), 1);
        for db in all_dbs {
            assert!(
                generations[0].join("0").join(db.filename()).is_file(),
                "{} was not backed up",
                db.filename()
            );
        }
        let backup =
            Connection::open(generations[0].join("0").join(CODEX_STATE_DB_FILENAME)).unwrap();
        let backed_up: i64 = backup
            .query_row("SELECT COUNT(*) FROM threads", [], |row| row.get(0))
            .unwrap();
        assert_eq!(backed_up, 5);
        drop(backup);
        drop(wal_writer);
    }

    #[test]
    fn a_failed_store_keeps_the_spawn_graph_until_a_retry_finishes() {
        let temp = tempdir().unwrap();
        let home = temp.path();
        let (sessions, _) = codex_home_with_sessions(home);
        create_runtime_dbs(
            home,
            &[
                CodexRuntimeDb::Logs,
                CodexRuntimeDb::Queue,
                CodexRuntimeDb::Memories,
                CodexRuntimeDb::Goals,
                CodexRuntimeDb::ThreadHistory,
                CodexRuntimeDb::State,
            ],
        );
        seed_thread(home, ROOT_ID, None);
        seed_thread(home, CHILD_ID, Some(ROOT_ID));
        let main = sessions.join(rollout_name(ROOT_ID, "jsonl"));
        write_codex_session(&main, ROOT_ID, "root");
        let child = sessions.join(rollout_name(CHILD_ID, "jsonl"));
        write_codex_session(&child, CHILD_ID, "child");

        let locker = Connection::open(home.join(CodexRuntimeDb::Logs.filename())).unwrap();
        locker.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let partial = delete_session(&sessions, &main, ROOT_ID).unwrap();
        assert!(partial.source_deleted && partial.cleanup_pending);
        assert!(partial.error.unwrap().contains("logs_2.sqlite"));
        assert!(!main.exists() && !child.exists());
        // Threads and edges stay so the retry can rediscover the child.
        assert_eq!(
            count_rows(home, CodexRuntimeDb::State, "threads", "id", CHILD_ID),
            1
        );
        assert_eq!(
            count_rows(
                home,
                CodexRuntimeDb::State,
                "thread_spawn_edges",
                "child_thread_id",
                CHILD_ID
            ),
            1
        );

        locker.execute_batch("ROLLBACK;").unwrap();
        let retried = delete_session(&sessions, &main, ROOT_ID).unwrap();
        assert!(
            retried.source_deleted && !retried.cleanup_pending,
            "{:?}",
            retried.error
        );
        for (db, table, column) in THREAD_TABLES {
            for id in [ROOT_ID, CHILD_ID] {
                assert_eq!(
                    count_rows(home, *db, table, column, id),
                    0,
                    "{table} still holds {id}"
                );
            }
        }
    }

    #[test]
    fn a_failed_backup_deletes_nothing() {
        let temp = tempdir().unwrap();
        let home = temp.path();
        let (sessions, _) = codex_home_with_sessions(home);
        create_runtime_dbs(home, &[CodexRuntimeDb::State]);
        Connection::open(home.join(CODEX_STATE_DB_FILENAME))
            .unwrap()
            .execute(
                "INSERT INTO threads VALUES (?1, 'rollout.jsonl', 'title')",
                [ROOT_ID],
            )
            .unwrap();
        let main = sessions.join(rollout_name(ROOT_ID, "jsonl"));
        write_codex_session(&main, ROOT_ID, "root");
        // A file where the backup directory has to go.
        std::fs::write(home.join("session-delete-backups"), b"").unwrap();

        let error = delete_session(&sessions, &main, ROOT_ID).unwrap_err();
        assert!(error.contains("Failed to back up"), "{error}");
        assert!(main.exists());
        assert_eq!(
            count_rows(home, CodexRuntimeDb::State, "threads", "id", ROOT_ID),
            1
        );
    }
}
