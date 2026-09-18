use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::security_limits::{
    canonicalize_within_root, collect_files_with_extensions, read_to_string_limited,
    MAX_SESSION_FILE_BYTES, MAX_SESSION_SCAN_DEPTH,
};
use crate::session_manager::{SessionMessage, SessionMeta};

use super::utils::{extract_text, parse_timestamp_to_ms, truncate_summary, TITLE_MAX_CHARS};

#[derive(Debug, Deserialize)]
struct GrokSessionInfo {
    id: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GrokSessionSummary {
    info: GrokSessionInfo,
    #[serde(default)]
    session_summary: Option<String>,
    #[serde(default)]
    generated_title: Option<String>,
    #[serde(default)]
    created_at: Option<Value>,
    #[serde(default)]
    updated_at: Option<Value>,
    #[serde(default)]
    last_active_at: Option<Value>,
}

pub fn session_roots() -> Vec<PathBuf> {
    let config_dir = crate::grok_config::get_grok_config_dir();
    vec![
        config_dir.join("sessions"),
        config_dir.join("archived_sessions"),
    ]
}

pub fn scan_sessions() -> Vec<SessionMeta> {
    let mut summaries = Vec::new();
    for root in session_roots() {
        collect_summary_files(&root, &mut summaries);
    }
    summaries
        .into_iter()
        .filter_map(|path| parse_summary(&path))
        .collect()
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let session_dir = path
        .parent()
        .ok_or_else(|| format!("Invalid Grok Build session path: {}", path.display()))?;
    let chat_path = session_dir.join("chat_history.jsonl");
    let content = read_to_string_limited(&chat_path, MAX_SESSION_FILE_BYTES)
        .map_err(|e| format!("Failed to open Grok Build chat history: {e}"))?;
    let mut messages = Vec::new();

    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let role = match kind {
            "system" | "user" | "assistant" | "tool" => kind,
            // Reasoning records can contain encrypted/internal state and are not
            // conversation messages shown by Grok's own history view.
            _ => continue,
        };
        let content = value.get("content").map(extract_text).unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        let ts = value
            .get("timestamp")
            .or_else(|| value.get("ts"))
            .and_then(parse_timestamp_to_ms);
        messages.push(SessionMessage {
            role: role.to_string(),
            content,
            ts,
        });
    }

    Ok(messages)
}

pub fn delete_session(root: &Path, path: &Path, session_id: &str) -> Result<bool, String> {
    let path = canonicalize_within_root(path, root).map_err(|_| {
        format!(
            "Grok Build session source is outside the session root: {}",
            path.display()
        )
    })?;
    let root = root
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize Grok Build root: {e}"))?;
    if path.file_name().and_then(|name| name.to_str()) != Some("summary.json") {
        return Err(format!(
            "Unexpected Grok Build session source: {}",
            path.display()
        ));
    }
    let summary = read_summary(&path)?;
    if summary.info.id != session_id {
        return Err(format!(
            "Grok Build session ID mismatch: expected {session_id}, found {}",
            summary.info.id
        ));
    }
    let session_dir = path
        .parent()
        .ok_or_else(|| format!("Invalid Grok Build session path: {}", path.display()))?;
    if session_dir == root || !session_dir.starts_with(root) {
        return Err(format!(
            "Refusing to delete Grok Build session directory outside its root: {}",
            session_dir.display()
        ));
    }
    if session_dir.file_name().and_then(|name| name.to_str()) != Some(session_id) {
        return Err(format!(
            "Grok Build session directory does not match session ID: {}",
            session_dir.display()
        ));
    }
    std::fs::remove_dir_all(session_dir).map_err(|e| {
        format!(
            "Failed to delete Grok Build session directory {}: {e}",
            session_dir.display()
        )
    })?;
    Ok(true)
}

fn collect_summary_files(root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(found) = collect_files_with_extensions(root, &["json"], MAX_SESSION_SCAN_DEPTH) else {
        return;
    };
    files.extend(
        found
            .into_iter()
            .filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("summary.json")),
    );
}

fn read_summary(path: &Path) -> Result<GrokSessionSummary, String> {
    let text = read_to_string_limited(path, MAX_SESSION_FILE_BYTES)
        .map_err(|e| format!("Failed to read Grok Build session summary: {e}"))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse Grok Build session summary: {e}"))
}

fn parse_summary(path: &Path) -> Option<SessionMeta> {
    let summary = read_summary(path).ok()?;
    let session_id = summary.info.id;
    let title = summary
        .generated_title
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            summary
                .session_summary
                .as_deref()
                .filter(|value| !value.trim().is_empty())
        })
        .map(|value| truncate_summary(value, TITLE_MAX_CHARS));
    let session_summary = summary
        .session_summary
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| truncate_summary(value, 160));
    let created_at = summary.created_at.as_ref().and_then(parse_timestamp_to_ms);
    let last_active_at = summary
        .last_active_at
        .as_ref()
        .or(summary.updated_at.as_ref())
        .and_then(parse_timestamp_to_ms);

    Some(SessionMeta {
        provider_id: "grokbuild".to_string(),
        session_id: session_id.clone(),
        title,
        summary: session_summary,
        project_dir: summary.info.cwd,
        created_at,
        last_active_at,
        source_path: Some(path.to_string_lossy().to_string()),
        resume_command: super::utils::resume_command("grok --resume", &session_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn scans_native_grokbuild_session_layout() {
        let temp = tempdir().expect("tempdir");
        let sessions_dir = temp.path().join("sessions");
        let session_id = "019f6af2-18b0-7673-958e-d25be650e172";
        let session_dir = sessions_dir.join("encoded-project").join(session_id);
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        std::fs::write(
            session_dir.join("summary.json"),
            format!(
                r#"{{"info":{{"id":"{session_id}","cwd":"C:/work"}},"session_summary":"hello grok","generated_title":"Grok session","created_at":"2026-07-16T12:00:00Z","last_active_at":"2026-07-16T12:00:01Z"}}"#
            ),
        )
        .expect("write summary");
        let mut files = Vec::new();
        collect_summary_files(&sessions_dir, &mut files);
        let sessions = files
            .iter()
            .filter_map(|path| parse_summary(path))
            .collect::<Vec<_>>();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].provider_id, "grokbuild");
        assert_eq!(sessions[0].session_id, session_id);
        assert_eq!(sessions[0].title.as_deref(), Some("Grok session"));
        let expected_resume = format!("grok --resume \"{session_id}\"");
        assert_eq!(
            sessions[0].resume_command.as_deref(),
            Some(expected_resume.as_str())
        );
    }

    #[test]
    fn loads_native_grokbuild_chat_history() {
        let temp = tempdir().expect("tempdir");
        let summary_path = temp.path().join("summary.json");
        std::fs::write(&summary_path, "{}").expect("write summary placeholder");
        std::fs::write(
            temp.path().join("chat_history.jsonl"),
            concat!(
                "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}\n",
                "{\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"private\"}]}\n",
                "{\"type\":\"assistant\",\"content\":\"Hi there\"}\n"
            ),
        )
        .expect("write chat history");

        let messages = load_messages(&summary_path).expect("load messages");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "hello");
        assert_eq!(messages[1].content, "Hi there");
    }

    #[test]
    fn delete_session_removes_only_the_matching_session_directory() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("sessions");
        let session_id = "session-to-delete";
        let session_dir = root.join("project").join(session_id);
        let sibling_dir = root.join("project").join("session-to-keep");
        std::fs::create_dir_all(&session_dir).expect("create session directory");
        std::fs::create_dir_all(&sibling_dir).expect("create sibling directory");
        let summary_path = session_dir.join("summary.json");
        std::fs::write(
            &summary_path,
            format!(r#"{{"info":{{"id":"{session_id}"}}}}"#),
        )
        .expect("write summary");
        std::fs::write(sibling_dir.join("keep.txt"), "keep").expect("write sibling file");

        let deleted = delete_session(&root, &summary_path, session_id).expect("delete session");

        assert!(deleted);
        assert!(!session_dir.exists());
        assert!(sibling_dir.exists());
    }

    #[test]
    fn delete_session_rejects_remove_dir_all_target_outside_root() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("sessions");
        let outside_dir = temp.path().join("outside").join("session-outside");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::create_dir_all(&outside_dir).expect("create outside directory");
        let summary_path = outside_dir.join("summary.json");
        std::fs::write(&summary_path, r#"{"info":{"id":"session-outside"}}"#)
            .expect("write summary");

        let error = delete_session(&root, &summary_path, "session-outside")
            .expect_err("outside path must be rejected");

        assert!(error.contains("outside the session root"));
        assert!(outside_dir.exists());
    }
}
