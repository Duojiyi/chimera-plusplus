pub mod delete_backup;
pub mod providers;
pub mod terminal;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use providers::{claude, codex, gemini, grokbuild, opencode};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub provider_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_active_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_command: Option<String>,
    /// Codex only: the rollout lives in `archived_sessions` or its thread is
    /// marked archived. Omitted when false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<i64>,
    /// The reader shortened this entry, or it stands in for content too large
    /// to load. Omitted when false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionRequest {
    pub provider_id: String,
    pub session_id: String,
    pub source_path: String,
    #[serde(default)]
    pub cleanup_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionOutcome {
    pub provider_id: String,
    pub session_id: String,
    pub source_path: String,
    pub success: bool,
    /// The rollout/content is gone even when index cleanup needs a retry.
    pub source_deleted: bool,
    pub cleanup_pending: bool,
    /// A restore superseded this cleanup request.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cleanup_cancelled: bool,
    /// The retry is only recoverable in the current UI because the first
    /// persistent cleanup record could not be written.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cleanup_unjournaled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Records the delete left behind on purpose because no retry can clean
    /// them (a newer Codex store, an oversized history). The delete still
    /// counts as finished; this only tells the user what stayed and why.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleanup_note: Option<String>,
}

/// Internal result separates irreversible content deletion from retryable cleanup.
#[derive(Debug)]
pub(super) struct SessionDeleteResult {
    pub source_deleted: bool,
    pub cleanup_pending: bool,
    pub cleanup_cancelled: bool,
    pub cleanup_unjournaled: bool,
    pub error: Option<String>,
    /// See [`DeleteSessionOutcome::cleanup_note`]. Never makes a delete pending.
    pub cleanup_note: Option<String>,
}

impl SessionDeleteResult {
    fn complete(deleted: bool) -> Self {
        Self {
            source_deleted: deleted,
            cleanup_pending: false,
            cleanup_cancelled: false,
            cleanup_unjournaled: false,
            error: None,
            cleanup_note: None,
        }
    }

    fn cleanup_cancelled() -> Self {
        Self {
            cleanup_cancelled: true,
            error: Some("此会话的清理已因恢复操作取消，请从会话列表中重新确认删除".into()),
            ..Self::complete(false)
        }
    }

    fn into_legacy_result(self) -> Result<bool, String> {
        if let Some(error) = self.error {
            return Err(error);
        }
        Ok(self.source_deleted && !self.cleanup_pending)
    }
}

pub fn scan_sessions() -> Vec<SessionMeta> {
    let (r1, r2, r3, r5, r7) = std::thread::scope(|s| {
        let h1 = s.spawn(codex::scan_sessions);
        let h2 = s.spawn(claude::scan_sessions);
        let h3 = s.spawn(opencode::scan_sessions);
        let h5 = s.spawn(gemini::scan_sessions);
        let h7 = s.spawn(grokbuild::scan_sessions);
        (
            h1.join().unwrap_or_default(),
            h2.join().unwrap_or_default(),
            h3.join().unwrap_or_default(),
            h5.join().unwrap_or_default(),
            h7.join().unwrap_or_default(),
        )
    });

    let mut sessions = Vec::new();
    sessions.extend(r1);
    sessions.extend(r2);
    sessions.extend(r3);
    sessions.extend(r5);
    sessions.extend(r7);

    sessions.sort_by(|a, b| {
        let a_ts = a.last_active_at.or(a.created_at).unwrap_or(0);
        let b_ts = b.last_active_at.or(b.created_at).unwrap_or(0);
        b_ts.cmp(&a_ts)
    });

    sessions
}

/// The session file to read, once it is known to sit inside one of the
/// provider's session roots. Reads follow the same containment rule as
/// deletion, so a caller cannot point the parsers at an arbitrary file.
fn resolve_session_source_within_roots(
    source_path: &Path,
    roots: &[PathBuf],
) -> Result<PathBuf, String> {
    roots
        .iter()
        .filter(|root| root.exists())
        .find_map(|root| crate::security_limits::canonicalize_within_root(source_path, root).ok())
        .ok_or_else(|| "Session source is outside the provider's session directories".to_string())
}

pub fn load_messages(provider_id: &str, source_path: &str) -> Result<Vec<SessionMessage>, String> {
    // SQLite sessions use a "sqlite:" prefixed source_path
    if provider_id == "opencode" && source_path.starts_with("sqlite:") {
        opencode::ensure_sqlite_source_is_opencode_db(source_path)?;
        return opencode::load_messages_sqlite(source_path);
    }
    let roots = provider_roots(provider_id)?;
    let validated = resolve_session_source_within_roots(Path::new(source_path), &roots)?;
    let path = validated.as_path();
    match provider_id {
        "codex" => codex::load_messages(path),
        "claude" => claude::load_messages(path),
        "opencode" => opencode::load_messages(path),

        "gemini" => gemini::load_messages(path),
        "grokbuild" => grokbuild::load_messages(path),

        _ => Err(format!("Unsupported provider: {provider_id}")),
    }
}

pub fn delete_session(
    provider_id: &str,
    session_id: &str,
    source_path: &str,
) -> Result<bool, String> {
    delete_session_result(provider_id, session_id, source_path, false)?.into_legacy_result()
}

fn delete_session_result(
    provider_id: &str,
    session_id: &str,
    source_path: &str,
    cleanup_only: bool,
) -> Result<SessionDeleteResult, String> {
    if cleanup_only && provider_id != "codex" {
        return Err("只有 Codex 会话支持重试索引清理".into());
    }
    // SQLite sessions bypass the file-based deletion path
    if provider_id == "opencode" && source_path.starts_with("sqlite:") {
        return opencode::delete_session_sqlite(session_id, source_path)
            .map(SessionDeleteResult::complete);
    }
    let roots = provider_roots(provider_id)?;
    delete_session_with_roots(
        provider_id,
        session_id,
        Path::new(source_path),
        &roots,
        cleanup_only,
    )
}

pub fn delete_sessions(requests: &[DeleteSessionRequest]) -> Vec<DeleteSessionOutcome> {
    collect_delete_session_outcomes(requests, |request| {
        delete_session_result(
            &request.provider_id,
            &request.session_id,
            &request.source_path,
            request.cleanup_only,
        )
    })
}

fn delete_session_with_roots(
    provider_id: &str,
    session_id: &str,
    source_path: &Path,
    roots: &[PathBuf],
    cleanup_only: bool,
) -> Result<SessionDeleteResult, String> {
    let mut saw_existing_root = false;
    for root in roots {
        if !root.exists() {
            continue;
        }

        saw_existing_root = true;
        let validated_root = root
            .canonicalize()
            .map_err(|e| format!("Failed to resolve session root {}: {e}", root.display()))?;
        match crate::security_limits::canonicalize_within_root(source_path, root) {
            Ok(validated_source) => {
                if cleanup_only {
                    return Ok(SessionDeleteResult::cleanup_cancelled());
                }
                return match provider_id {
                    "codex" => {
                        codex::delete_session(&validated_root, &validated_source, session_id)
                    }
                    "claude" => {
                        claude::delete_session(&validated_root, &validated_source, session_id)
                            .map(SessionDeleteResult::complete)
                    }
                    "opencode" => {
                        opencode::delete_session(&validated_root, &validated_source, session_id)
                            .map(SessionDeleteResult::complete)
                    }

                    "gemini" => {
                        gemini::delete_session(&validated_root, &validated_source, session_id)
                            .map(SessionDeleteResult::complete)
                    }
                    "grokbuild" => {
                        grokbuild::delete_session(&validated_root, &validated_source, session_id)
                            .map(SessionDeleteResult::complete)
                    }

                    _ => Err(format!("Unsupported provider: {provider_id}")),
                };
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // A missing path has no canonical target. Validate its lexical
                // containment too: canonicalize_within_root can return NotFound
                // for an unrelated missing path before checking the root.
                let Ok(relative) = source_path.strip_prefix(root) else {
                    continue;
                };
                if relative.components().any(|component| {
                    !matches!(
                        component,
                        std::path::Component::Normal(_) | std::path::Component::CurDir
                    )
                }) {
                    continue;
                }
                if provider_id == "codex" {
                    let validated_source = validated_root.join(relative);
                    return if cleanup_only {
                        codex::cleanup_deleted_session(
                            &validated_root,
                            &validated_source,
                            session_id,
                        )
                    } else {
                        codex::delete_session(&validated_root, &validated_source, session_id)
                    };
                }
                return Err(format!(
                    "session source not found: {}",
                    source_path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to validate session source {}: {error}",
                    source_path.display()
                ));
            }
        }
    }

    if !saw_existing_root {
        return Err(format!(
            "Session root not found for provider {provider_id}: {}",
            roots
                .first()
                .map(|root| root.display().to_string())
                .unwrap_or_else(|| "<none>".to_string())
        ));
    }

    Err(format!(
        "Session source path is outside provider roots: {}",
        source_path.display()
    ))
}

fn provider_roots(provider_id: &str) -> Result<Vec<PathBuf>, String> {
    let roots = match provider_id {
        "codex" => codex::session_roots(),
        "claude" => vec![crate::config::get_claude_config_dir().join("projects")],
        "opencode" => vec![opencode::get_opencode_data_dir()],

        "gemini" => vec![crate::gemini_config::get_gemini_dir().join("tmp")],
        "grokbuild" => grokbuild::session_roots(),

        _ => return Err(format!("Unsupported provider: {provider_id}")),
    };

    Ok(roots)
}

fn collect_delete_session_outcomes<F>(
    requests: &[DeleteSessionRequest],
    mut deleter: F,
) -> Vec<DeleteSessionOutcome>
where
    F: FnMut(&DeleteSessionRequest) -> Result<SessionDeleteResult, String>,
{
    requests
        .iter()
        .map(|request| {
            let result = match deleter(request) {
                Ok(result) => result,
                Err(error) => SessionDeleteResult {
                    source_deleted: false,
                    cleanup_pending: false,
                    cleanup_cancelled: false,
                    cleanup_unjournaled: false,
                    error: Some(error),
                    cleanup_note: None,
                },
            };
            let success =
                result.source_deleted && !result.cleanup_pending && result.error.is_none();
            DeleteSessionOutcome {
                provider_id: request.provider_id.clone(),
                session_id: request.session_id.clone(),
                source_path: request.source_path.clone(),
                success,
                source_deleted: result.source_deleted,
                cleanup_pending: result.cleanup_pending,
                cleanup_cancelled: result.cleanup_cancelled,
                cleanup_unjournaled: result.cleanup_unjournaled,
                error: result
                    .error
                    .or_else(|| (!success).then(|| "Session was not deleted".to_string())),
                cleanup_note: result.cleanup_note,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn session_reads_are_confined_to_provider_roots() {
        let temp = tempdir().expect("temp dir");
        let root = temp.path().join("sessions");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(root.join("2026")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let inside_file = root.join("2026").join("a.jsonl");
        let outside_file = outside.join("secret.jsonl");
        std::fs::write(
            &inside_file,
            "{}
",
        )
        .unwrap();
        std::fs::write(
            &outside_file,
            "{}
",
        )
        .unwrap();
        let roots = vec![temp.path().join("missing"), root.clone()];

        let resolved = resolve_session_source_within_roots(&inside_file, &roots).unwrap();
        assert_eq!(resolved, inside_file.canonicalize().unwrap());
        assert!(resolve_session_source_within_roots(&outside_file, &roots).is_err());
        // Traversal out of the root is refused as well.
        let sneaky = root.join("..").join("outside").join("secret.jsonl");
        assert!(resolve_session_source_within_roots(&sneaky, &roots).is_err());
    }

    fn write_codex_session(path: &Path, session_id: &str) {
        std::fs::write(
            path,
            format!(
                "{{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"cwd\":\"/tmp/project\"}}}}\n\
                 {{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":\"hello\"}}}}\n",
            ),
        )
        .expect("write source");
    }

    #[test]
    fn accepts_source_path_under_any_allowed_provider_root() {
        let temp = tempdir().expect("config root");
        let active_root = temp.path().join("sessions");
        let archived_root = temp.path().join("archived_sessions");
        std::fs::create_dir(&active_root).unwrap();
        std::fs::create_dir(&archived_root).unwrap();
        std::fs::write(
            temp.path().join("config.toml"),
            format!("sqlite_home = '{}'\n", temp.path().display()),
        )
        .unwrap();
        let source = archived_root.join("session.jsonl");
        write_codex_session(&source, "archived-session");

        let deleted = delete_session_with_roots(
            "codex",
            "archived-session",
            &source,
            &[active_root, archived_root],
            false,
        )
        .expect("delete archived session");

        assert!(deleted.source_deleted && !deleted.cleanup_pending);
        assert!(!source.exists());
    }

    #[test]
    fn rejects_source_path_outside_provider_root() {
        let root = tempdir().expect("tempdir");
        let outside = tempdir().expect("tempdir");
        let source = outside.path().join("session.jsonl");
        std::fs::write(&source, "{}").expect("write source");

        let err = delete_session_with_roots(
            "codex",
            "session-1",
            &source,
            &[root.path().to_path_buf()],
            false,
        )
        .expect_err("expected outside-root path to be rejected");

        assert!(err.contains("outside provider roots"));
    }

    #[test]
    fn codex_missing_source_cleans_records() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            temp.path().join("config.toml"),
            format!("sqlite_home = '{}'\n", temp.path().display()),
        )
        .unwrap();
        let missing = root.join("missing.jsonl");

        let deleted = delete_session_with_roots("codex", "session-1", &missing, &[root], false)
            .expect("validated missing rollout is a deletable zombie session");

        assert!(deleted.source_deleted && !deleted.cleanup_pending);
    }

    #[test]
    fn batch_delete_collects_successes_and_failures_in_order() {
        let requests = vec![
            DeleteSessionRequest {
                provider_id: "codex".to_string(),
                session_id: "s1".to_string(),
                source_path: "/tmp/s1".to_string(),
                cleanup_only: false,
            },
            DeleteSessionRequest {
                provider_id: "claude".to_string(),
                session_id: "s2".to_string(),
                source_path: "/tmp/s2".to_string(),
                cleanup_only: false,
            },
            DeleteSessionRequest {
                provider_id: "gemini".to_string(),
                session_id: "s3".to_string(),
                source_path: "/tmp/s3".to_string(),
                cleanup_only: false,
            },
        ];

        let outcomes = collect_delete_session_outcomes(&requests, |request| {
            match request.session_id.as_str() {
                "s1" => Ok(SessionDeleteResult::complete(true)),
                "s2" => Err("boom".to_string()),
                _ => Ok(SessionDeleteResult::complete(false)),
            }
        });

        assert_eq!(outcomes.len(), 3);
        assert!(outcomes[0].success);
        assert_eq!(outcomes[0].error, None);
        assert!(!outcomes[1].success);
        assert_eq!(outcomes[1].error.as_deref(), Some("boom"));
        assert!(!outcomes[2].success);
        assert_eq!(
            outcomes[2].error.as_deref(),
            Some("Session was not deleted")
        );
    }

    #[test]
    fn partial_cleanup_keeps_identity_and_distinguishes_deleted_content_on_the_wire() {
        let requests = [DeleteSessionRequest {
            provider_id: "codex".into(),
            session_id: "s1".into(),
            source_path: "/sessions/missing.jsonl".into(),
            cleanup_only: false,
        }];
        let outcomes = collect_delete_session_outcomes(&requests, |_| {
            Ok(SessionDeleteResult {
                source_deleted: true,
                cleanup_pending: true,
                cleanup_cancelled: false,
                cleanup_unjournaled: false,
                error: Some("Content deleted; retry index cleanup".into()),
                cleanup_note: None,
            })
        });
        let outcome = &outcomes[0];
        assert!(!outcome.success);
        assert!(outcome.source_deleted && outcome.cleanup_pending);
        assert_eq!(outcome.source_path, requests[0].source_path);
        let json = serde_json::to_value(outcome).unwrap();
        assert_eq!(json["sourceDeleted"], true);
        assert_eq!(json["cleanupPending"], true);
        assert!(SessionDeleteResult {
            source_deleted: true,
            cleanup_pending: true,
            cleanup_cancelled: false,
            cleanup_unjournaled: false,
            error: Some("retry cleanup".into()),
            cleanup_note: None,
        }
        .into_legacy_result()
        .is_err());
    }

    #[test]
    fn restore_cancellation_is_distinct_from_a_transient_error_on_the_wire() {
        let request = DeleteSessionRequest {
            provider_id: "codex".into(),
            session_id: "s1".into(),
            source_path: "/sessions/missing.jsonl".into(),
            cleanup_only: true,
        };
        let outcomes = collect_delete_session_outcomes(std::slice::from_ref(&request), |_| {
            Ok(SessionDeleteResult::cleanup_cancelled())
        });
        assert!(
            !outcomes[0].success && !outcomes[0].source_deleted && !outcomes[0].cleanup_pending
        );
        assert_eq!(
            serde_json::to_value(&outcomes[0]).unwrap()["cleanupCancelled"],
            true
        );
        let outcomes =
            collect_delete_session_outcomes(&[request], |_| Err("sessions root offline".into()));
        assert!(serde_json::to_value(&outcomes[0])
            .unwrap()
            .get("cleanupCancelled")
            .is_none());
    }

    #[test]
    fn a_cleanup_note_finishes_the_delete_without_offering_a_retry() {
        let requests = [DeleteSessionRequest {
            provider_id: "codex".into(),
            session_id: "s1".into(),
            source_path: "/sessions/s1.jsonl".into(),
            cleanup_only: false,
        }];
        let outcomes = collect_delete_session_outcomes(&requests, |_| {
            Ok(SessionDeleteResult {
                source_deleted: true,
                cleanup_pending: false,
                cleanup_cancelled: false,
                cleanup_unjournaled: false,
                error: None,
                cleanup_note: Some("newer store left alone".into()),
            })
        });
        let outcome = &outcomes[0];
        assert!(outcome.success && !outcome.cleanup_pending);
        assert_eq!(outcome.error, None);
        let json = serde_json::to_value(outcome).unwrap();
        assert_eq!(json["cleanupNote"], "newer store left alone");
        assert!(json.get("error").is_none());

        let plain =
            collect_delete_session_outcomes(&requests, |_| Ok(SessionDeleteResult::complete(true)));
        assert!(serde_json::to_value(&plain[0])
            .unwrap()
            .get("cleanupNote")
            .is_none());
    }

    #[test]
    fn missing_source_outside_root_or_with_parent_traversal_cannot_clean_records() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        let index = temp.path().join("session_index.jsonl");
        let content = "{\"id\":\"s1\"}\n";
        std::fs::write(&index, content).unwrap();
        for path in [
            temp.path().join("missing.jsonl"),
            root.join("../missing.jsonl"),
        ] {
            assert!(delete_session_with_roots(
                "codex",
                "s1",
                &path,
                std::slice::from_ref(&root),
                false
            )
            .is_err());
            assert_eq!(std::fs::read_to_string(&index).unwrap(), content);
        }
    }

    #[test]
    fn pending_single_session_is_discoverable_and_a_restored_rollout_is_not_deleted() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        let roots = std::slice::from_ref(&root);
        let path = root.join("session.jsonl");
        write_codex_session(&path, "pending-session");
        let blocked_index = temp.path().join("session_index.jsonl");
        std::fs::create_dir(&blocked_index).unwrap();
        let result =
            delete_session_with_roots("codex", "pending-session", &path, roots, false).unwrap();
        assert!(result.source_deleted && result.cleanup_pending);
        let listed = codex::list_pending_deletes(roots).sessions;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].source_path.as_deref(), path.to_str());
        assert!(!path.exists(), "listing must not write or rerun the delete");

        write_codex_session(&path, "pending-session");
        assert!(codex::list_pending_deletes(roots).sessions.is_empty());
        let cancelled = delete_session_with_roots("codex", "pending-session", &path, roots, true)
            .expect("a restored source cancels the retry");
        assert!(cancelled.cleanup_cancelled && !cancelled.source_deleted);
        assert!(path.is_file());

        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&blocked_index).unwrap();
        let result =
            delete_session_with_roots("codex", "pending-session", &path, roots, true).unwrap();
        assert!(
            result.source_deleted && !result.cleanup_pending,
            "{result:?}"
        );
        assert!(codex::list_pending_deletes(roots).sessions.is_empty());
    }

    #[test]
    fn missing_source_retry_selects_its_own_root_before_cleaning_records() {
        let temp = tempdir().unwrap();
        let roots: Vec<_> = ["first", "second"]
            .iter()
            .map(|name| temp.path().join(name).join("sessions"))
            .collect();
        for root in &roots {
            std::fs::create_dir_all(root).unwrap();
            let config_dir = root.parent().unwrap();
            std::fs::write(
                config_dir.join("config.toml"),
                format!("sqlite_home = '{}'\n", config_dir.display()),
            )
            .unwrap();
            std::fs::write(config_dir.join("session_index.jsonl"), "{\"id\":\"s1\"}\n").unwrap();
        }
        let missing = roots[1].join("2026/missing.jsonl");
        let result = delete_session_with_roots("codex", "s1", &missing, &roots, false).unwrap();
        assert!(result.source_deleted && !result.cleanup_pending);
        assert!(
            std::fs::read_to_string(roots[0].parent().unwrap().join("session_index.jsonl"))
                .unwrap()
                .contains("s1")
        );
        assert!(
            std::fs::read_to_string(roots[1].parent().unwrap().join("session_index.jsonl"))
                .unwrap()
                .is_empty()
        );
    }
}
