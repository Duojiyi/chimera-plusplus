use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use crate::security_limits::{
    collect_files_with_extensions, read_to_string_limited, MAX_CONFIG_FILE_BYTES,
    MAX_SESSION_FILE_BYTES, MAX_SESSION_SCAN_DEPTH,
};
use crate::session_manager::{SessionMessage, SessionMeta};

use super::utils::{parse_timestamp_to_ms, path_basename, truncate_summary};

const PROVIDER_ID: &str = "opencode";

/// Return the OpenCode base directory (`$XDG_DATA_HOME/opencode`).
///
/// Respects `XDG_DATA_HOME` on all platforms; falls back to
/// `~/.local/share/opencode/`.
pub(crate) fn get_opencode_base_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("opencode");
        }
    }
    dirs::home_dir()
        .map(|h| h.join(".local/share/opencode"))
        .unwrap_or_else(|| PathBuf::from(".local/share/opencode"))
}

/// Return the OpenCode JSON storage directory (legacy flat-file layout).
pub(crate) fn get_opencode_data_dir() -> PathBuf {
    get_opencode_base_dir().join("storage")
}

fn get_opencode_db_path() -> PathBuf {
    get_opencode_base_dir().join("opencode.db")
}

/// Scan sessions from both the legacy JSON files and the newer SQLite database,
/// merging results with SQLite taking precedence on ID conflicts.
pub fn scan_sessions() -> Vec<SessionMeta> {
    let json_sessions = scan_sessions_json();
    let sqlite_sessions = scan_sessions_sqlite();

    if sqlite_sessions.is_empty() {
        return json_sessions;
    }
    if json_sessions.is_empty() {
        return sqlite_sessions;
    }

    // Deduplicate: keep SQLite version when the same session_id exists in both
    let sqlite_ids: std::collections::HashSet<String> = sqlite_sessions
        .iter()
        .map(|s| s.session_id.clone())
        .collect();

    let mut merged = sqlite_sessions;
    for s in json_sessions {
        if !sqlite_ids.contains(&s.session_id) {
            merged.push(s);
        }
    }
    merged
}

fn scan_sessions_json() -> Vec<SessionMeta> {
    let storage = get_opencode_data_dir();
    let session_dir = storage.join("session");
    if !session_dir.exists() {
        return Vec::new();
    }

    let mut json_files = Vec::new();
    collect_json_files(&session_dir, &mut json_files);

    let mut sessions = Vec::new();
    for path in json_files {
        if let Some(meta) = parse_session(&storage, &path) {
            sessions.push(meta);
        }
    }
    sessions
}

/// Parse a SQLite source reference in the format `sqlite:<db_path>:<session_id>`.
///
/// Uses `rfind(":ses_")` to split the path from the session ID because the
/// db path itself may contain colons (e.g. `C:\Users\...` on Windows).
/// This relies on the OpenCode convention that session IDs start with `ses_`.
fn parse_sqlite_source(source: &str) -> Option<(PathBuf, String)> {
    let rest = source.strip_prefix("sqlite:")?;
    let sep = rest.rfind(":ses_")?;
    let db_path = PathBuf::from(&rest[..sep]);
    let session_id = rest[sep + 1..].to_string();
    Some((db_path, session_id))
}

fn scan_sessions_sqlite() -> Vec<SessionMeta> {
    let db_path = get_opencode_db_path();
    if !db_path.exists() {
        return Vec::new();
    }

    let conn = match Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut stmt = match conn.prepare(
        "SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let db_display = db_path.display().to_string();

    let iter = match stmt.query_map([], |row| {
        let session_id: String = row.get(0)?;
        let title: String = row.get(1)?;
        let directory: String = row.get(2)?;
        let created: i64 = row.get(3)?;
        let updated: i64 = row.get(4)?;
        Ok((session_id, title, directory, created, updated))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };

    let mut sessions = Vec::new();
    for row in iter.flatten() {
        let (session_id, title, directory, created, updated) = row;
        let display_title = if title.is_empty() {
            path_basename(&directory)
        } else {
            Some(title)
        };
        sessions.push(SessionMeta {
            provider_id: PROVIDER_ID.to_string(),
            session_id: session_id.clone(),
            title: display_title.clone(),
            summary: display_title,
            project_dir: if directory.is_empty() {
                None
            } else {
                Some(directory)
            },
            created_at: Some(created),
            last_active_at: Some(updated),
            source_path: Some(format!("sqlite:{db_display}:{session_id}")),
            resume_command: super::utils::resume_command("opencode -s", &session_id),
        });
    }
    sessions
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    // `path` is the message directory: storage/message/{sessionID}/
    if !path.is_dir() {
        return Err(format!("Message directory not found: {}", path.display()));
    }

    let storage = path
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| "Cannot determine storage root from message path".to_string())?;

    let mut msg_files = Vec::new();
    collect_json_files(path, &mut msg_files);

    // Parse all messages and collect (created_ts, message_id, role, parts_text)
    let mut entries: Vec<(i64, String, String, String)> = Vec::new();

    for msg_path in &msg_files {
        let data = match read_to_string_limited(msg_path, MAX_SESSION_FILE_BYTES) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_id = match value.get("id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => continue,
        };

        let role = value
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();

        let created_ts = value
            .get("time")
            .and_then(|t| t.get("created"))
            .and_then(parse_timestamp_to_ms)
            .unwrap_or(0);

        // Collect text parts from storage/part/{messageID}/
        let part_dir = storage.join("part").join(&msg_id);
        let text = collect_parts_text(&part_dir);
        if text.trim().is_empty() {
            continue;
        }

        entries.push((created_ts, msg_id, role, text));
    }

    // Sort by created timestamp
    entries.sort_by_key(|(ts, _, _, _)| *ts);

    let messages = entries
        .into_iter()
        .map(|(ts, _, role, content)| SessionMessage {
            role,
            content,
            ts: if ts > 0 { Some(ts) } else { None },
        })
        .collect();

    Ok(messages)
}

/// Load messages from the OpenCode SQLite database for a given source reference.
/// Joins the `message` and `part` tables in memory to reconstruct full messages.
pub fn load_messages_sqlite(source: &str) -> Result<Vec<SessionMessage>, String> {
    let (db_path, session_id) = parse_sqlite_source(source)
        .ok_or_else(|| format!("Invalid SQLite source reference: {source}"))?;

    let conn = Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open OpenCode database: {e}"))?;

    let mut msg_stmt = conn
        .prepare(
            "SELECT id, time_created, data FROM message WHERE session_id = ?1 ORDER BY time_created ASC",
        )
        .map_err(|e| format!("Failed to prepare message query: {e}"))?;

    let msg_rows = msg_stmt
        .query_map([session_id.as_str()], |row| {
            let id: String = row.get(0)?;
            let ts: i64 = row.get(1)?;
            let data: String = row.get(2)?;
            Ok((id, ts, data))
        })
        .map_err(|e| format!("Failed to query messages: {e}"))?;

    let mut part_stmt = conn
        .prepare(
            "SELECT message_id, data FROM part WHERE session_id = ?1 ORDER BY time_created ASC",
        )
        .map_err(|e| format!("Failed to prepare part query: {e}"))?;

    let part_rows = part_stmt
        .query_map([session_id.as_str()], |row| {
            let message_id: String = row.get(0)?;
            let data: String = row.get(1)?;
            Ok((message_id, data))
        })
        .map_err(|e| format!("Failed to query parts: {e}"))?;

    let mut parts_map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for part in part_rows.flatten() {
        let (message_id, data) = part;
        parts_map.entry(message_id).or_default().push(data);
    }

    let mut messages = Vec::new();
    for row in msg_rows.flatten() {
        let (msg_id, ts, data) = row;
        let msg_value: Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let role = msg_value
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();

        let mut texts = Vec::new();
        if let Some(parts) = parts_map.get(&msg_id) {
            for part_data in parts {
                let part_value: Value = match serde_json::from_str(part_data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(text) = extract_part_text(&part_value) {
                    texts.push(text);
                }
            }
        }

        let content = texts.join("\n");
        if content.trim().is_empty() {
            continue;
        }

        messages.push(SessionMessage {
            role,
            content,
            ts: Some(ts),
        });
    }

    Ok(messages)
}

pub fn delete_session(storage: &Path, path: &Path, session_id: &str) -> Result<bool, String> {
    super::utils::validate_id(session_id)?;
    let expected = storage.join("message").join(session_id);
    if path != expected {
        return Err("OpenCode session path does not match session ID".into());
    }
    super::utils::deletion_path(storage, path)?;
    let db = storage
        .parent()
        .ok_or("Missing OpenCode storage parent")?
        .join("opencode.db");
    if db.try_exists().map_err(|e| e.to_string())? {
        return delete_session_copies(&db, storage, session_id);
    }
    let paths = legacy_deletion_paths(storage, session_id)?;
    super::utils::delete_paths(storage, &paths)
}

fn legacy_deletion_paths(storage: &Path, session_id: &str) -> Result<Vec<PathBuf>, String> {
    super::utils::validate_id(session_id)?;
    let messages = storage.join("message").join(session_id);
    let mut paths = Vec::new();
    for path in super::utils::deletion_files(storage, &messages)? {
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let data =
            read_to_string_limited(&path, MAX_SESSION_FILE_BYTES).map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Missing OpenCode message ID")?;
        super::utils::validate_id(id)?;
        if path.parent() != Some(messages.as_path())
            || path.file_stem().and_then(|v| v.to_str()) != Some(id)
            || value.get("sessionID").and_then(Value::as_str) != Some(session_id)
        {
            return Err(format!(
                "OpenCode message ownership mismatch: {}",
                path.display()
            ));
        }
        let parts = storage.join("part").join(id);
        for part_path in super::utils::deletion_files(storage, &parts)? {
            let data = read_to_string_limited(&part_path, MAX_SESSION_FILE_BYTES).map_err(|e| {
                format!("Cannot validate OpenCode part {}: {e}", part_path.display())
            })?;
            let part: Value = serde_json::from_str(&data).map_err(|e| {
                format!("Cannot validate OpenCode part {}: {e}", part_path.display())
            })?;
            let part_id = part
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Missing OpenCode part ID")?;
            super::utils::validate_id(part_id)?;
            if part_path.parent() != Some(parts.as_path())
                || part_path.extension().and_then(|v| v.to_str()) != Some("json")
                || part_path.file_stem().and_then(|v| v.to_str()) != Some(part_id)
                || part.get("messageID").and_then(Value::as_str) != Some(id)
                || part.get("sessionID").and_then(Value::as_str) != Some(session_id)
            {
                return Err(format!(
                    "OpenCode part ownership mismatch: {}",
                    part_path.display()
                ));
            }
        }
        paths.push(parts);
    }
    paths.push(
        storage
            .join("session_diff")
            .join(format!("{session_id}.json")),
    );
    paths.push(messages);
    for path in super::utils::deletion_files(storage, &storage.join("session"))? {
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let named_target = path.file_stem().and_then(|v| v.to_str()) == Some(session_id);
        let parsed = read_to_string_limited(&path, MAX_CONFIG_FILE_BYTES)
            .map_err(|e| e.to_string())
            .and_then(|data| serde_json::from_str::<Value>(&data).map_err(|e| e.to_string()));
        let value = match parsed {
            Ok(value) => value,
            // Discovery also ignores unparseable, unrelated session metadata.
            Err(_) if !named_target => continue,
            Err(e) => {
                return Err(format!(
                    "Cannot validate OpenCode session copy {}: {e}",
                    path.display()
                ))
            }
        };
        let metadata_target = value.get("id").and_then(Value::as_str) == Some(session_id);
        if named_target || metadata_target {
            if !named_target || !metadata_target {
                return Err(format!(
                    "OpenCode session ownership mismatch: {}",
                    path.display()
                ));
            }
            paths.push(path);
        }
    }
    for path in &paths {
        super::utils::deletion_files(storage, path)?;
    }
    Ok(paths)
}

/// Delete a session from the OpenCode SQLite database.
pub fn delete_session_sqlite(session_id: &str, source: &str) -> Result<bool, String> {
    let (db_path, ref_session_id) = parse_sqlite_source(source)
        .ok_or_else(|| format!("Invalid SQLite source reference: {source}"))?;
    super::utils::deletion_path(db_path.parent().ok_or("Missing database parent")?, &db_path)?;
    let db_path = db_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize SQLite database path: {e}"))?;
    let expected_db_path = get_opencode_db_path()
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize expected OpenCode database path: {e}"))?;

    if ref_session_id != session_id {
        return Err(format!(
            "OpenCode SQLite session ID mismatch: expected {session_id}, found {ref_session_id}"
        ));
    }
    if db_path != expected_db_path {
        return Err("SQLite path does not match expected OpenCode database".to_string());
    }

    delete_session_copies(&db_path, &get_opencode_data_dir(), session_id)
}

fn delete_session_copies(db_path: &Path, storage: &Path, session_id: &str) -> Result<bool, String> {
    super::utils::deletion_path(db_path.parent().ok_or("Missing database parent")?, db_path)?;
    let paths = legacy_deletion_paths(storage, session_id)?;
    let conn = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("Failed to open OpenCode database: {e}"))?;

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin transaction: {e}"))?;

    tx.execute("DELETE FROM part WHERE session_id = ?1", [session_id])
        .map_err(|e| format!("Failed to delete OpenCode parts: {e}"))?;
    tx.execute("DELETE FROM message WHERE session_id = ?1", [session_id])
        .map_err(|e| format!("Failed to delete OpenCode messages: {e}"))?;

    let deleted = tx
        .execute("DELETE FROM session WHERE id = ?1", [session_id])
        .map_err(|e| format!("Failed to delete OpenCode session: {e}"))?;

    let files_deleted = super::utils::delete_paths(storage, &paths)?;

    tx.commit()
        .map_err(|e| format!("Session deletion incomplete: database commit failed (file copies may already be removed): {e}"))?;

    Ok(deleted > 0 || files_deleted)
}

fn parse_session(storage: &Path, path: &Path) -> Option<SessionMeta> {
    let data = read_to_string_limited(path, MAX_CONFIG_FILE_BYTES).ok()?;
    let value: Value = serde_json::from_str(&data).ok()?;

    let session_id = value.get("id").and_then(Value::as_str)?.to_string();
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let directory = value
        .get("directory")
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let created_at = value
        .get("time")
        .and_then(|t| t.get("created"))
        .and_then(parse_timestamp_to_ms);
    let updated_at = value
        .get("time")
        .and_then(|t| t.get("updated"))
        .and_then(parse_timestamp_to_ms);

    // Derive title from directory basename if no explicit title
    let has_title = title.is_some();
    let display_title = title.or_else(|| {
        directory
            .as_deref()
            .and_then(path_basename)
            .map(|s| s.to_string())
    });

    // Build source_path = message directory for this session
    let msg_dir = storage.join("message").join(&session_id);
    let source_path = msg_dir.to_string_lossy().to_string();

    // Skip expensive I/O if title already available from session JSON
    let summary = if has_title {
        display_title.clone()
    } else {
        get_first_user_summary(storage, &session_id)
    };

    Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id: session_id.clone(),
        title: display_title,
        summary,
        project_dir: directory,
        created_at,
        last_active_at: updated_at.or(created_at),
        source_path: Some(source_path),
        resume_command: super::utils::resume_command("opencode -s", &session_id),
    })
}

/// Read the first user message's first text part to use as summary.
fn get_first_user_summary(storage: &Path, session_id: &str) -> Option<String> {
    let msg_dir = storage.join("message").join(session_id);
    if !msg_dir.is_dir() {
        return None;
    }

    let mut msg_files = Vec::new();
    collect_json_files(&msg_dir, &mut msg_files);

    // Collect user messages with timestamps for ordering
    let mut user_msgs: Vec<(i64, String)> = Vec::new();
    for msg_path in &msg_files {
        let data = match read_to_string_limited(msg_path, MAX_SESSION_FILE_BYTES) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if value.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }

        let msg_id = match value.get("id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => continue,
        };

        let ts = value
            .get("time")
            .and_then(|t| t.get("created"))
            .and_then(parse_timestamp_to_ms)
            .unwrap_or(0);

        user_msgs.push((ts, msg_id));
    }

    user_msgs.sort_by_key(|(ts, _)| *ts);

    // Take first user message and get its parts
    let (_, first_id) = user_msgs.first()?;
    let part_dir = storage.join("part").join(first_id);
    let text = collect_parts_text(&part_dir);
    if text.trim().is_empty() {
        return None;
    }
    Some(truncate_summary(&text, 160))
}

/// Collect text content from all parts in a part directory.
fn extract_part_text(part_value: &Value) -> Option<String> {
    match part_value.get("type").and_then(Value::as_str) {
        Some("text") => part_value
            .get("text")
            .and_then(Value::as_str)
            .filter(|t| !t.trim().is_empty())
            .map(|t| t.to_string()),
        Some("tool") => {
            let tool = part_value
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            Some(format!("[Tool: {tool}]"))
        }
        _ => None,
    }
}

fn collect_parts_text(part_dir: &Path) -> String {
    if !part_dir.is_dir() {
        return String::new();
    }

    let mut parts = Vec::new();
    collect_json_files(part_dir, &mut parts);

    let mut texts = Vec::new();
    for part_path in &parts {
        let data = match read_to_string_limited(part_path, MAX_SESSION_FILE_BYTES) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(text) = extract_part_text(&value) {
            texts.push(text);
        }
    }

    texts.join("\n")
}

fn collect_json_files(root: &Path, files: &mut Vec<PathBuf>) {
    if let Ok(found) = collect_files_with_extensions(root, &["json"], MAX_SESSION_SCAN_DEPTH) {
        files.extend(found);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::{Mutex, OnceLock};
    use tempfile::tempdir;

    fn opencode_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn create_sqlite_schema(conn: &Connection) {
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                directory TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE,
                FOREIGN KEY(message_id) REFERENCES message(id) ON DELETE CASCADE
            );
            ",
        )
        .expect("create sqlite schema");
    }

    #[test]
    fn delete_session_removes_session_diff_messages_and_parts() {
        let temp = tempdir().expect("tempdir");
        let storage = temp.path();
        let project_id = "project-123";
        let session_id = "ses_123";
        let session_dir = storage.join("session").join(project_id);
        let message_dir = storage.join("message").join(session_id);
        let session_diff = storage
            .join("session_diff")
            .join(format!("{session_id}.json"));
        let part_dir = storage.join("part").join("msg_1");
        let session_file = session_dir.join(format!("{session_id}.json"));

        std::fs::create_dir_all(&session_dir).expect("create session dir");
        std::fs::create_dir_all(&message_dir).expect("create message dir");
        std::fs::create_dir_all(&part_dir).expect("create part dir");
        std::fs::create_dir_all(storage.join("project")).expect("create project dir");
        std::fs::create_dir_all(storage.join("session_diff")).expect("create session diff dir");

        std::fs::write(
            &session_file,
            format!(
                r#"{{
                  "id": "{session_id}",
                  "projectID": "{project_id}",
                  "directory": "/tmp/project",
                  "time": {{ "created": 1, "updated": 2 }}
                }}"#
            ),
        )
        .expect("write session file");
        std::fs::write(
            message_dir.join("msg_1.json"),
            format!(r#"{{"id":"msg_1","sessionID":"{session_id}","role":"user"}}"#),
        )
        .expect("write message file");
        std::fs::write(
            part_dir.join("prt_1.json"),
            r#"{"id":"prt_1","messageID":"msg_1","sessionID":"ses_123"}"#,
        )
        .expect("write part file");
        std::fs::write(&session_diff, "[]").expect("write session diff");
        std::fs::write(
            storage.join("project").join(format!("{project_id}.json")),
            r#"{"id":"project-123"}"#,
        )
        .expect("write project file");

        delete_session(storage, &message_dir, session_id).expect("delete session");

        assert!(!session_file.exists());
        assert!(!message_dir.exists());
        assert!(!session_diff.exists());
        assert!(!part_dir.exists());
        assert!(storage
            .join("project")
            .join(format!("{project_id}.json"))
            .exists());
    }

    #[test]
    fn load_messages_includes_tool_parts() {
        let temp = tempdir().expect("tempdir");
        let storage = temp.path();
        let session_id = "ses_test";
        let msg_id = "msg_1";

        let msg_dir = storage.join("message").join(session_id);
        let part_dir = storage.join("part").join(msg_id);
        std::fs::create_dir_all(&msg_dir).expect("create msg dir");
        std::fs::create_dir_all(&part_dir).expect("create part dir");

        std::fs::write(
            msg_dir.join(format!("{msg_id}.json")),
            r#"{"id":"msg_1","role":"assistant","time":{"created":"2026-03-06T10:00:00Z"}}"#,
        )
        .expect("write msg");

        std::fs::write(
            part_dir.join("prt_1.json"),
            r#"{"id":"prt_1","type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"file.txt"}}"#,
        )
        .expect("write tool part");

        std::fs::write(
            part_dir.join("prt_2.json"),
            r#"{"id":"prt_2","type":"text","text":"Here are the files."}"#,
        )
        .expect("write text part");

        let msgs = load_messages(&msg_dir).expect("load");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, "assistant");
        assert!(msgs[0].content.contains("[Tool: bash]"));
        assert!(msgs[0].content.contains("Here are the files."));
    }

    #[test]
    fn parse_sqlite_source_accepts_valid_references() {
        let parsed = parse_sqlite_source("sqlite:/tmp/opencode.db:ses_123").expect("valid source");

        assert_eq!(parsed.0, PathBuf::from("/tmp/opencode.db"));
        assert_eq!(parsed.1, "ses_123");
    }

    #[test]
    fn parse_sqlite_source_rejects_invalid_references() {
        assert!(parse_sqlite_source("/tmp/opencode.db:ses_123").is_none());
        assert!(parse_sqlite_source("sqlite:/tmp/opencode.db:msg_123").is_none());
        assert!(parse_sqlite_source("sqlite:/tmp/opencode.db").is_none());
    }

    #[test]
    #[allow(deprecated)] // set_var/remove_var deprecated since Rust 1.81; safe here under mutex
    fn scan_sessions_sqlite_reads_temp_database() {
        let _guard = opencode_env_lock().lock().expect("lock");
        let temp = tempdir().expect("tempdir");
        let original_xdg = std::env::var_os("XDG_DATA_HOME");
        std::env::set_var("XDG_DATA_HOME", temp.path());

        let base_dir = temp.path().join("opencode");
        std::fs::create_dir_all(&base_dir).expect("create base dir");
        let db_path = base_dir.join("opencode.db");
        let conn = Connection::open(&db_path).expect("open sqlite db");
        create_sqlite_schema(&conn);

        conn.execute(
            "INSERT INTO session (id, title, directory, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5)",
            ("ses_1", "", "/tmp/project-a", 1_771_061_953_033_i64, 1_771_061_954_033_i64),
        )
        .expect("insert session 1");
        conn.execute(
            "INSERT INTO session (id, title, directory, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5)",
            ("ses_2", "Named Session", "/tmp/project-b", 1_771_061_950_000_i64, 1_771_061_955_000_i64),
        )
        .expect("insert session 2");
        drop(conn);

        let sessions = scan_sessions_sqlite();

        #[allow(deprecated)]
        if let Some(value) = original_xdg {
            std::env::set_var("XDG_DATA_HOME", value);
        } else {
            std::env::remove_var("XDG_DATA_HOME");
        }

        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].session_id, "ses_2");
        assert_eq!(sessions[0].title.as_deref(), Some("Named Session"));
        assert_eq!(sessions[1].session_id, "ses_1");
        assert_eq!(sessions[1].title.as_deref(), Some("project-a"));
        assert_eq!(sessions[1].project_dir.as_deref(), Some("/tmp/project-a"));
        let expected_source = format!("sqlite:{}:ses_1", db_path.display());
        assert_eq!(
            sessions[1].source_path.as_deref(),
            Some(expected_source.as_str())
        );
        assert_eq!(
            sessions[1].resume_command.as_deref(),
            Some("opencode -s \"ses_1\"")
        );
    }

    #[test]
    fn load_messages_sqlite_reads_messages_and_parts() {
        let temp = tempdir().expect("tempdir");
        let db_path = temp.path().join("opencode.db");
        let conn = Connection::open(&db_path).expect("open sqlite db");
        create_sqlite_schema(&conn);

        conn.execute(
            "INSERT INTO session (id, title, directory, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5)",
            ("ses_1", "Session", "/tmp/project-a", 1000_i64, 3000_i64),
        )
        .expect("insert session");
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
            ("msg_1", "ses_1", 1000_i64, r#"{"role":"user"}"#),
        )
        .expect("insert message 1");
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
            ("msg_2", "ses_1", 2000_i64, r#"{"role":"assistant"}"#),
        )
        .expect("insert message 2");
        conn.execute(
            "INSERT INTO part (id, session_id, message_id, time_created, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            ("prt_1", "ses_1", "msg_1", 1000_i64, r#"{"type":"text","text":"Hello"}"#),
        )
        .expect("insert part 1");
        conn.execute(
            "INSERT INTO part (id, session_id, message_id, time_created, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            (
                "prt_2",
                "ses_1",
                "msg_2",
                2000_i64,
                r#"{"type":"tool","tool":"bash"}"#,
            ),
        )
        .expect("insert part 2");
        conn.execute(
            "INSERT INTO part (id, session_id, message_id, time_created, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            (
                "prt_3",
                "ses_1",
                "msg_2",
                2001_i64,
                r#"{"type":"text","text":"Done"}"#,
            ),
        )
        .expect("insert part 3");
        drop(conn);

        let source = format!("sqlite:{}:ses_1", db_path.display());
        let messages = load_messages_sqlite(&source).expect("load sqlite messages");

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "Hello");
        assert_eq!(messages[0].ts, Some(1000));
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "[Tool: bash]\nDone");
        assert_eq!(messages[1].ts, Some(2000));
    }

    #[test]
    fn delete_session_sqlite_removes_session() {
        let _guard = opencode_env_lock().lock().expect("lock");
        let temp = tempdir().expect("tempdir");
        let original_xdg = std::env::var_os("XDG_DATA_HOME");
        #[allow(deprecated)]
        std::env::set_var("XDG_DATA_HOME", temp.path());

        let base_dir = temp.path().join("opencode");
        std::fs::create_dir_all(&base_dir).expect("create base dir");
        let db_path = base_dir.join("opencode.db");
        let conn = Connection::open(&db_path).expect("open sqlite db");
        create_sqlite_schema(&conn);

        conn.execute(
            "INSERT INTO session (id, title, directory, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5)",
            ("ses_1", "Session", "/tmp/project-a", 1000_i64, 3000_i64),
        )
        .expect("insert session");
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
            ("msg_1", "ses_1", 1000_i64, r#"{"role":"user"}"#),
        )
        .expect("insert message");
        conn.execute(
            "INSERT INTO part (id, session_id, message_id, time_created, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            ("prt_1", "ses_1", "msg_1", 1000_i64, r#"{"type":"text","text":"Hello"}"#),
        )
        .expect("insert part");
        drop(conn);

        let source = format!("sqlite:{}:ses_1", db_path.display());
        let deleted = delete_session_sqlite("ses_1", &source).expect("delete sqlite session");
        assert!(deleted);

        let conn = Connection::open(&db_path).expect("re-open sqlite db");
        let remaining_sessions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session WHERE id = 'ses_1'",
                [],
                |row| row.get(0),
            )
            .expect("count sessions");
        let remaining_messages: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM message WHERE session_id = 'ses_1'",
                [],
                |row| row.get(0),
            )
            .expect("count messages");
        let remaining_parts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM part WHERE session_id = 'ses_1'",
                [],
                |row| row.get(0),
            )
            .expect("count parts");

        assert_eq!(remaining_sessions, 0);
        assert_eq!(remaining_messages, 0);
        assert_eq!(remaining_parts, 0);

        #[allow(deprecated)]
        if let Some(value) = original_xdg {
            std::env::set_var("XDG_DATA_HOME", value);
        } else {
            std::env::remove_var("XDG_DATA_HOME");
        }
    }

    #[test]
    fn delete_session_sqlite_rejects_foreign_db_path() {
        let _guard = opencode_env_lock().lock().expect("lock");
        let temp = tempdir().expect("tempdir");
        let original_xdg = std::env::var_os("XDG_DATA_HOME");
        #[allow(deprecated)]
        std::env::set_var("XDG_DATA_HOME", temp.path());

        let expected_base_dir = temp.path().join("opencode");
        std::fs::create_dir_all(&expected_base_dir).expect("create expected base dir");
        let expected_db_path = expected_base_dir.join("opencode.db");
        Connection::open(&expected_db_path).expect("create expected sqlite db");

        let db_path = temp.path().join("foreign.db");
        let conn = Connection::open(&db_path).expect("open sqlite db");
        create_sqlite_schema(&conn);
        conn.execute(
            "INSERT INTO session (id, title, directory, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5)",
            ("ses_1", "Session", "/tmp/project", 1000_i64, 3000_i64),
        )
        .expect("insert session");
        drop(conn);

        let source = format!("sqlite:{}:ses_1", db_path.display());
        let err = delete_session_sqlite("ses_1", &source).expect_err("should reject foreign db");
        assert!(err.contains("expected OpenCode database"));

        #[allow(deprecated)]
        if let Some(value) = original_xdg {
            std::env::set_var("XDG_DATA_HOME", value);
        } else {
            std::env::remove_var("XDG_DATA_HOME");
        }
    }

    fn dual_source_fixture(base: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let db = base.join("opencode.db");
        let conn = Connection::open(&db).unwrap();
        create_sqlite_schema(&conn);
        conn.execute(
            "INSERT INTO session VALUES ('ses_1', 'Session', '/tmp', 1, 2)",
            [],
        )
        .unwrap();
        let storage = base.join("storage");
        let messages = storage.join("message/ses_1");
        std::fs::create_dir_all(&messages).unwrap();
        std::fs::write(
            messages.join("msg_1.json"),
            r#"{"id":"msg_1","sessionID":"ses_1"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(storage.join("part/msg_1")).unwrap();
        std::fs::write(
            storage.join("part/msg_1/prt_1.json"),
            r#"{"id":"prt_1","messageID":"msg_1","sessionID":"ses_1"}"#,
        )
        .unwrap();
        for project in ["project_a", "project_b"] {
            let dir = storage.join("session").join(project);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("ses_1.json"), r#"{"id":"ses_1"}"#).unwrap();
        }
        (db, storage, messages)
    }

    #[test]
    fn both_entry_paths_delete_database_and_all_legacy_copies() {
        for from_file in [false, true] {
            let temp = tempdir().unwrap();
            let (db, storage, messages) = dual_source_fixture(temp.path());
            let result = if from_file {
                delete_session(&storage, &messages, "ses_1")
            } else {
                delete_session_copies(&db, &storage, "ses_1")
            };
            assert!(result.unwrap());
            assert!(!messages.exists());
            assert!(!storage.join("part/msg_1").exists());
            assert!(legacy_deletion_paths(&storage, "ses_1")
                .unwrap()
                .iter()
                .all(|p| !p.exists()));
            let conn = Connection::open(db).unwrap();
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM session", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn malicious_message_ids_abort_before_any_deletion() {
        for id in [
            "../outside",
            "..\\outside",
            "/tmp/outside",
            "C:\\outside",
            "msg:stream",
            "CON",
        ] {
            let temp = tempdir().unwrap();
            let (db, storage, messages) = dual_source_fixture(temp.path());
            std::fs::write(
                messages.join("bad.json"),
                serde_json::json!({"id": id}).to_string(),
            )
            .unwrap();
            assert!(delete_session_copies(&db, &storage, "ses_1").is_err());
            assert!(messages.join("msg_1.json").exists());
            assert!(storage.join("part/msg_1").exists());
            let conn = Connection::open(db).unwrap();
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM session", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
    }

    #[test]
    fn database_failure_preserves_legacy_copy() {
        let temp = tempdir().unwrap();
        let (db, storage, messages) = dual_source_fixture(temp.path());
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TRIGGER deny_delete BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT, 'denied'); END;").unwrap();
        assert!(delete_session_copies(&db, &storage, "ses_1").is_err());
        assert!(messages.exists());
        assert!(storage.join("session/project_a/ses_1.json").exists());
    }

    #[test]
    fn foreign_message_references_abort_before_deleting_either_session() {
        // Even a forged matching filename/sessionID must not grant ownership of B's parts.
        for (filename, session) in [
            ("msg_A.json", "ses_1"),
            ("msg_B.json", "ses_B"),
            ("msg_B.json", "ses_1"),
        ] {
            let temp = tempdir().unwrap();
            let (db, storage, messages) = dual_source_fixture(temp.path());
            let foreign = storage.join("part/msg_B/prt_B.json");
            std::fs::create_dir_all(foreign.parent().unwrap()).unwrap();
            std::fs::write(
                &foreign,
                r#"{"id":"prt_B","messageID":"msg_B","sessionID":"ses_B"}"#,
            )
            .unwrap();
            let foreign_messages = storage.join("message/ses_B");
            std::fs::create_dir_all(&foreign_messages).unwrap();
            std::fs::write(
                foreign_messages.join("msg_B.json"),
                r#"{"id":"msg_B","sessionID":"ses_B"}"#,
            )
            .unwrap();
            std::fs::write(
                messages.join(filename),
                serde_json::json!({"id":"msg_B","sessionID":session}).to_string(),
            )
            .unwrap();
            let error = delete_session_copies(&db, &storage, "ses_1").unwrap_err();
            assert!(error.contains("ownership mismatch"), "{error}");
            assert!(foreign.exists());
            assert!(foreign_messages.join("msg_B.json").exists());
            assert!(messages.join("msg_1.json").exists());
            assert!(storage.join("part/msg_1/prt_1.json").exists());
            let conn = Connection::open(db).unwrap();
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM session", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
    }

    #[test]
    fn inconsistent_or_missing_part_ownership_is_rejected() {
        for part in [
            serde_json::json!({"id":"wrong_filename","messageID":"msg_1","sessionID":"ses_1"}),
            serde_json::json!({"id":"prt_1","messageID":"msg_B","sessionID":"ses_1"}),
            serde_json::json!({"id":"prt_1","messageID":"msg_1","sessionID":"ses_B"}),
            serde_json::json!({"id":"prt_1","messageID":"msg_1"}),
        ] {
            let temp = tempdir().unwrap();
            let (db, storage, messages) = dual_source_fixture(temp.path());
            let path = storage.join("part/msg_1/prt_1.json");
            std::fs::write(&path, part.to_string()).unwrap();
            assert!(delete_session_copies(&db, &storage, "ses_1").is_err());
            assert!(path.exists());
            assert!(messages.exists());
        }
    }

    #[test]
    fn unrelated_corrupt_metadata_does_not_block_legacy_or_sqlite_deletion() {
        for pure_sqlite in [false, true] {
            let temp = tempdir().unwrap();
            let (db, storage, _) = dual_source_fixture(temp.path());
            let corrupt = storage.join("session/project_a/unrelated.json");
            std::fs::write(&corrupt, "{\"id\":").unwrap();
            let invalid_utf8 = storage.join("session/project_a/unreadable.json");
            std::fs::write(&invalid_utf8, [0xff]).unwrap();
            let conn = Connection::open(&db).unwrap();
            conn.execute(
                "INSERT INTO session VALUES ('ses_sqlite', 'Only DB', '/tmp', 1, 2)",
                [],
            )
            .unwrap();
            let id = if pure_sqlite { "ses_sqlite" } else { "ses_1" };
            assert!(delete_session_copies(&db, &storage, id).unwrap());
            assert!(corrupt.exists());
            assert!(invalid_utf8.exists());
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM session WHERE id = ?1", [id], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn corrupt_or_conflicting_target_metadata_aborts_all_deletion() {
        for data in ["{\"id\":", r#"{"id":"ses_B"}"#, "{}"] {
            let temp = tempdir().unwrap();
            let (db, storage, messages) = dual_source_fixture(temp.path());
            let target = storage.join("session/project_b/ses_1.json");
            std::fs::write(&target, data).unwrap();
            assert!(delete_session_copies(&db, &storage, "ses_1").is_err());
            assert!(target.exists());
            assert!(messages.exists());
            assert!(storage.join("part/msg_1/prt_1.json").exists());
            let conn = Connection::open(db).unwrap();
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM session", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
    }
}
