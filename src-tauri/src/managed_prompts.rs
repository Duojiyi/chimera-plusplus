//! AGENTS.md managed-block projection (M4). No filesystem or database side effects.
//! Bounds validation adapted from Codex-X (MIT), prompts/managed_agents.rs at
//! 8f018fddd3ee1a68464e4df8765eb370ede0c76f. Unlike upstream, preserve every byte
//! outside our block and do not adopt foreign blocks or trim user content.
use std::ops::Range;

use crate::config::cas::{Changeset, ContentHash, FileSnapshot};
use crate::error::AppError;
use crate::security_limits::MAX_CONFIG_FILE_BYTES;

pub(crate) const BEGIN: &str = "<!-- CHIMERA:INSTRUCTIONS:BEGIN -->";
pub(crate) const END: &str = "<!-- CHIMERA:INSTRUCTIONS:END -->";
const FOREIGN_BEGIN: &str = "<!-- CODEX-X:INSTRUCTIONS:BEGIN -->";
const FOREIGN_END: &str = "<!-- CODEX-X:INSTRUCTIONS:END -->";

fn invalid(message: &str) -> AppError {
    AppError::InvalidInput(message.to_string())
}

fn bounds(text: &str, begin: &str, end: &str) -> Result<Option<Range<usize>>, AppError> {
    let mut begins = text.match_indices(begin).map(|(index, _)| index);
    let mut ends = text.match_indices(end).map(|(index, _)| index);
    let (start, finish) = match (begins.next(), ends.next()) {
        (None, None) => return Ok(None),
        (Some(start), Some(finish)) if start < finish => (start, finish + end.len()),
        _ => {
            return Err(invalid(
                "AGENTS.md 受管标记不完整或顺序不正确，请先修复标记。",
            ))
        }
    };
    if begins.next().is_some() || ends.next().is_some() {
        return Err(invalid("AGENTS.md 含重复受管区块，请先解决所有权冲突。"));
    }
    // Markers must occupy whole lines; refuse prose/code containing inline markers.
    let starts_line = |offset: usize| {
        offset == 0 || &text[..offset] == "\u{feff}" || text.as_bytes()[offset - 1] == b'\n'
    };
    let ends_line = |offset: usize| {
        offset == text.len()
            || text[offset..].starts_with('\n')
            || text[offset..].starts_with("\r\n")
    };
    if !starts_line(start)
        || !ends_line(start + begin.len())
        || !starts_line(finish - end.len())
        || !ends_line(finish)
    {
        return Err(invalid("AGENTS.md 受管标记必须各占一行。"));
    }
    Ok(Some(start..finish))
}

/// Project the active prompt into the sole Chimera-owned block. `None` disables
/// it, leaving all user/foreign bytes intact. `legacy_hash` must come from the
/// previously enabled legacy DB row, never from renderer-supplied file contents.
/// A legacy hash mismatch requires explicit user resolution, not an overwrite.
pub(crate) fn project(
    existing: &str,
    body: Option<&str>,
    legacy_hash: Option<ContentHash>,
) -> Result<String, AppError> {
    if existing.len() as u64 > MAX_CONFIG_FILE_BYTES
        || body.is_some_and(|value| value.len() as u64 > MAX_CONFIG_FILE_BYTES)
    {
        return Err(invalid("提示词文件超过大小上限。"));
    }
    let owned = bounds(existing, BEGIN, END)?;
    let foreign = bounds(existing, FOREIGN_BEGIN, FOREIGN_END)?;
    if let (Some(owned), Some(foreign)) = (&owned, &foreign) {
        if owned.start < foreign.end && foreign.start < owned.end {
            return Err(invalid("Chimera 与外来受管区块发生嵌套，已拒绝修改。"));
        }
    }
    let newline = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let replacement = match body {
        Some(body) => {
            if body.trim().is_empty() {
                return Err(invalid("启用的提示词不能为空。"));
            }
            if body.contains("<!-- CHIMERA:") || body.contains("<!-- CODEX-X:") {
                return Err(invalid("提示词正文不能包含受管区块保留标记。"));
            }
            let separator = if body.ends_with('\n') { "" } else { newline };
            format!("{BEGIN}{newline}{body}{separator}{END}")
        }
        None => String::new(),
    };
    let next = if let Some(range) = owned {
        // Replacing in place avoids moving a block through user-authored rules.
        format!(
            "{}{}{}",
            &existing[..range.start],
            replacement,
            &existing[range.end..]
        )
    } else if let Some(expected) = legacy_hash {
        if foreign.is_some() || existing.contains("<!-- CODEX-X:") {
            return Err(invalid(
                "外来受管区块只读，不能通过旧版提示词迁移自动接管。",
            ));
        }
        if ContentHash::of(existing.as_bytes()) != expected {
            return Err(invalid("旧版提示词与当前文件不一致，请先确认外部修改。"));
        }
        // An exact whole-file hash match is the only automatic adoption path.
        replacement
    } else if replacement.is_empty() {
        existing.to_string()
    } else {
        let separator = if existing.is_empty() || existing.ends_with('\n') {
            ""
        } else {
            newline
        };
        format!("{existing}{separator}{replacement}")
    };
    if next.len() as u64 > MAX_CONFIG_FILE_BYTES {
        return Err(invalid("合并后的提示词文件超过大小上限。"));
    }
    Ok(next)
}

/// Read only our validated block. Foreign and user-authored text is never adopted.
/// Keep the body's final newline so re-projecting it preserves the stored block.
pub(crate) fn owned_body(existing: &str) -> Result<Option<&str>, AppError> {
    project(existing, None, None)?;
    let Some(range) = bounds(existing, BEGIN, END)? else {
        return Ok(None);
    };
    let body = &existing[range.start + BEGIN.len()..range.end - END.len()];
    let body = body
        .strip_prefix("\r\n")
        .or_else(|| body.strip_prefix('\n'))
        .ok_or_else(|| invalid("受管正文缺少换行边界。"))?;
    if project(existing, Some(body), None)? != existing {
        return Err(invalid("受管区块无法无损恢复，请先检查备份。"));
    }
    Ok(Some(body))
}

/// Explicit takeover only. Replace the foreign markers in place, preserving
/// every body and surrounding byte; coexistence needs manual conflict resolution.
pub(crate) fn adopt_foreign(existing: &str) -> Result<(String, String), AppError> {
    project(existing, None, None)?;
    if bounds(existing, BEGIN, END)?.is_some() {
        return Err(invalid("已有 Chimera 受管区块，请先禁用其提示词后再接管。"));
    }
    let range = bounds(existing, FOREIGN_BEGIN, FOREIGN_END)?
        .ok_or_else(|| invalid("未找到可接管的 Codex-X 区块。"))?;
    let next = format!(
        "{}{}{}{}{}",
        &existing[..range.start],
        BEGIN,
        &existing[range.start + FOREIGN_BEGIN.len()..range.end - FOREIGN_END.len()],
        END,
        &existing[range.end..]
    );
    let body = owned_body(&next)?
        .ok_or_else(|| invalid("未找到接管后的正文。"))?
        .to_string();
    Ok((next, body))
}

/// Bind projection to the caller's observed snapshot. The caller must hold the
/// Codex switch lock, take a recoverable backup, and rollback on DB failure.
/// This does not enable a second file writer or bypass the old service entrypoints.
pub(crate) fn plan(
    snapshot: FileSnapshot,
    body: Option<&str>,
    legacy_hash: Option<ContentHash>,
) -> Result<Changeset, AppError> {
    let existing = std::str::from_utf8(snapshot.contents().unwrap_or_default())
        .map_err(|_| invalid("AGENTS.md 必须使用 UTF-8 编码。"))?;
    let next = project(existing, body, legacy_hash)?;
    let mut changes = Changeset::new();
    if next != existing {
        changes.write(snapshot, next.into_bytes())?;
    }
    Ok(changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn explicit_foreign_takeover_preserves_body_and_surrounding_bytes() {
        let source =
            format!("\u{feff}User  \r\n{FOREIGN_BEGIN}\r\nForeign  \r\n{FOREIGN_END}\r\nTail");
        let (next, body) = adopt_foreign(&source).unwrap();
        assert_eq!(body, "Foreign  \r\n");
        assert_eq!(
            next,
            source
                .replace(FOREIGN_BEGIN, BEGIN)
                .replace(FOREIGN_END, END)
        );
        assert_eq!(project(&next, Some(&body), None).unwrap(), next);
        assert_eq!(project(&source, None, None).unwrap(), source);
    }

    #[test]
    fn takeover_rejects_missing_malformed_empty_reserved_or_competing_blocks() {
        for source in [
            "User".to_string(),
            format!("{FOREIGN_BEGIN}\nMissing end"),
            format!("{FOREIGN_BEGIN}\n{FOREIGN_END}"),
            format!("{FOREIGN_BEGIN}\n<!-- CHIMERA:reserved -->\n{FOREIGN_END}"),
            format!("{BEGIN}\nOurs\n{END}\n{FOREIGN_BEGIN}\nForeign\n{FOREIGN_END}"),
            format!("{FOREIGN_BEGIN}\nOne\n{FOREIGN_END}\n{FOREIGN_BEGIN}\nTwo\n{FOREIGN_END}"),
        ] {
            assert!(adopt_foreign(&source).is_err());
        }
    }

    #[test]
    fn extraction_preserves_managed_bytes_and_never_adopts_foreign_text() {
        let file = format!("User\r\n{BEGIN}\r\n  Managed  \r\n{END}\r\nTail");
        assert_eq!(owned_body(&file).unwrap(), Some("  Managed  \r\n"));
        assert_eq!(owned_body("User text").unwrap(), None);
        let foreign = format!("{FOREIGN_BEGIN}\nForeign\n{FOREIGN_END}");
        assert_eq!(owned_body(&foreign).unwrap(), None);
        assert!(owned_body(&format!("{BEGIN}\nIncomplete")).is_err());
        assert!(owned_body(&format!("{BEGIN}\n{END}")).is_err());
        assert!(owned_body(&format!("{BEGIN}\n<!-- CHIMERA:reserved -->\n{END}")).is_err());
    }

    #[test]
    fn update_and_disable_preserve_surrounding_bytes_and_crlf() {
        let prefix = "\u{feff}用户规则  \r\n\r\n";
        let suffix = "\r\n\r\n末尾空格  ";
        let existing = format!("{prefix}{BEGIN}\r\n旧内容\r\n{END}{suffix}");
        let next = project(&existing, Some("新内容"), None).unwrap();
        assert_eq!(next, format!("{prefix}{BEGIN}\r\n新内容\r\n{END}{suffix}"));
        assert_eq!(project(&next, Some("新内容"), None).unwrap(), next);
        assert_eq!(
            project(&next, None, None).unwrap(),
            format!("{prefix}{suffix}")
        );
    }

    #[test]
    fn append_preserves_foreign_block_and_disable_does_not_remove_it() {
        let foreign = format!("{FOREIGN_BEGIN}\nForeign rules\n{FOREIGN_END}\n");
        let installed = project(&foreign, Some("Our rules"), None).unwrap();
        assert!(installed.starts_with(&foreign));
        assert_eq!(project(&installed, None, None).unwrap(), foreign);
        assert!(project(
            &foreign,
            Some("New"),
            Some(ContentHash::of(foreign.as_bytes()))
        )
        .is_err());
    }

    #[test]
    fn rejects_malformed_duplicate_inline_and_nested_markers() {
        for text in [
            BEGIN.to_string(),
            END.to_string(),
            format!("{END}\n{BEGIN}"),
            format!("{BEGIN}\nx\n{END}\n{BEGIN}\ny\n{END}"),
            format!("Inline {BEGIN}\nx\n{END}"),
            format!("{BEGIN} trailing\nx\n{END}"),
            format!("{FOREIGN_BEGIN}\n{BEGIN}\nx\n{END}\n{FOREIGN_END}"),
            format!("{BEGIN}\n{FOREIGN_BEGIN}\nx\n{FOREIGN_END}\n{END}"),
        ] {
            assert!(
                project(&text, Some("new"), None).is_err(),
                "must reject malformed ownership"
            );
            assert!(project(&text, None, None).is_err());
        }
    }

    #[test]
    fn exact_legacy_hash_is_required_and_migration_is_idempotent() {
        let legacy = "Legacy prompt\n";
        let hash = ContentHash::of(legacy.as_bytes());
        let adopted = project(legacy, Some("New prompt"), Some(hash)).unwrap();
        assert!(!adopted.contains("Legacy prompt"));
        assert_eq!(
            project(&adopted, Some("New prompt"), Some(hash)).unwrap(),
            adopted
        );
        assert!(project("Legacy prompt\r\n", Some("New prompt"), Some(hash)).is_err());
        assert!(project("externally changed", None, Some(hash)).is_err());
        assert_eq!(project(legacy, None, Some(hash)).unwrap(), "");
        assert_eq!(project("User rules", None, None).unwrap(), "User rules");
    }

    #[test]
    fn rejects_empty_injected_and_oversized_content() {
        for body in [
            "",
            " \n",
            "<!-- CHIMERA:INSTRUCTIONS:END -->",
            FOREIGN_BEGIN,
        ] {
            assert!(project("", Some(body), None).is_err());
        }
        let huge = "x".repeat(MAX_CONFIG_FILE_BYTES as usize);
        assert!(project("", Some(&huge), None).is_err());
        let error = project("secret-value", Some(BEGIN), None)
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret-value"));
    }

    #[test]
    fn plans_without_writing_and_cas_rejects_external_edits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("AGENTS.md");
        fs::write(&path, "User rules").unwrap();
        let changes = plan(FileSnapshot::read(&path).unwrap(), Some("Managed"), None).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "User rules");
        fs::write(&path, "External edit").unwrap();
        assert!(changes.commit().is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "External edit");
    }

    #[test]
    fn rollback_restores_original_and_disabling_missing_file_does_not_create_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("AGENTS.md");
        plan(FileSnapshot::read(&path).unwrap(), None, None)
            .unwrap()
            .commit()
            .unwrap();
        assert!(!path.exists());
        fs::write(&path, "User rules").unwrap();
        let changes = plan(FileSnapshot::read(&path).unwrap(), Some("Managed"), None).unwrap();
        changes.commit().unwrap().rollback().unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "User rules");
    }
}
