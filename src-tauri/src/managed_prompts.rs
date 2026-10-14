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

// Ownership conflicts carry stable keys; the prompts page maps them to guidance
// (see `commands::prompt`), so the localized text is only a fallback.
pub(crate) fn encoding_error() -> AppError {
    AppError::localized(
        "prompt.file.encoding",
        "AGENTS.md 必须使用 UTF-8 编码。",
        "AGENTS.md must be UTF-8 encoded.",
    )
}

fn too_large_error() -> AppError {
    AppError::localized(
        "prompt.file.too_large",
        "提示词文件超过 8 MiB 上限。",
        "The prompt file exceeds the 8 MiB limit.",
    )
}

fn malformed_error() -> AppError {
    AppError::localized(
        "prompt.managed.malformed",
        "AGENTS.md 中的 Chimera 区块无法无损读取，请先检查该区块。",
        "The Chimera block in AGENTS.md cannot be read back losslessly; check it first.",
    )
}

fn bounds(text: &str, begin: &str, end: &str) -> Result<Option<Range<usize>>, AppError> {
    let mut begins = text.match_indices(begin).map(|(index, _)| index);
    let mut ends = text.match_indices(end).map(|(index, _)| index);
    let (start, finish) = match (begins.next(), ends.next()) {
        (None, None) => return Ok(None),
        (Some(start), Some(finish)) if start < finish => (start, finish + end.len()),
        _ => {
            return Err(AppError::localized(
                "prompt.managed.unbalanced",
                "AGENTS.md 中的受管区块标记不完整或顺序颠倒，请先修复标记。",
                "A managed block in AGENTS.md is missing a marker or has them out of order.",
            ))
        }
    };
    if begins.next().is_some() || ends.next().is_some() {
        return Err(AppError::localized(
            "prompt.managed.duplicate",
            "AGENTS.md 含重复的受管区块或多余的标记，请只保留一份。",
            "AGENTS.md contains a duplicated managed block or an extra marker.",
        ));
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
        return Err(AppError::localized(
            "prompt.managed.marker_inline",
            "AGENTS.md 的受管区块标记必须各占一行。",
            "Managed block markers in AGENTS.md must each be on their own line.",
        ));
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
        return Err(too_large_error());
    }
    let owned = bounds(existing, BEGIN, END)?;
    let foreign = bounds(existing, FOREIGN_BEGIN, FOREIGN_END)?;
    if let (Some(owned), Some(foreign)) = (&owned, &foreign) {
        if owned.start < foreign.end && foreign.start < owned.end {
            return Err(AppError::localized(
                "prompt.managed.nested",
                "AGENTS.md 中 Chimera 区块与其他工具的区块互相嵌套，已拒绝修改。",
                "The Chimera block and another tool's block in AGENTS.md overlap.",
            ));
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
                return Err(AppError::InvalidInput("启用的提示词不能为空。".into()));
            }
            if body.contains("<!-- CHIMERA:") || body.contains("<!-- CODEX-X:") {
                return Err(AppError::localized(
                    "prompt.body.reserved_marker",
                    "提示词正文不能包含受管区块保留标记。",
                    "A prompt body cannot contain reserved managed-block markers.",
                ));
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
            return Err(AppError::localized(
                "prompt.managed.foreign_legacy",
                "AGENTS.md 中有其他工具的区块，旧版提示词不能自动迁移。",
                "AGENTS.md holds another tool's block, so the legacy prompt cannot be migrated.",
            ));
        }
        if ContentHash::of(existing.as_bytes()) != expected {
            return Err(AppError::localized(
                "prompt.managed.legacy_mismatch",
                "AGENTS.md 已在外部修改，与旧版提示词记录不一致，请先确认外部修改。",
                "AGENTS.md was changed outside Chimera++ since the legacy prompt was written.",
            ));
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
        return Err(too_large_error());
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
        .ok_or_else(malformed_error)?;
    if project(existing, Some(body), None)? != existing {
        return Err(malformed_error());
    }
    Ok(Some(body))
}

/// How the file relates to what the library expects Chimera to have written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BlockState {
    /// The file holds exactly the projection of the enabled entries.
    InSync,
    /// Entries are enabled but the file has no Chimera block.
    Missing,
    /// Our block differs from the library, or exists while nothing is enabled.
    Edited,
    /// Markers that every write would refuse.
    Malformed,
    /// Nothing is enabled and only another tool's block is present.
    Foreign,
}

// Editors may rewrite line endings on save; that alone is not a hand edit.
fn same_text(left: &str, right: &str) -> bool {
    left == right || left.replace("\r\n", "\n") == right.replace("\r\n", "\n")
}

/// Classify `existing` against `expected`, the merged body of the enabled
/// entries. `legacy_hash` identifies a whole file written by an older version;
/// once edited outside it no longer holds the entries, so it counts as missing.
pub(crate) fn inspect(
    existing: &str,
    expected: Option<&str>,
    legacy_hash: Option<ContentHash>,
) -> BlockState {
    // `project` validates both marker pairs exactly as a write would.
    if project(existing, None, None).is_err() {
        return BlockState::Malformed;
    }
    if matches!(bounds(existing, BEGIN, END), Ok(Some(_))) {
        return match project(existing, expected, None) {
            Ok(next) if same_text(&next, existing) => BlockState::InSync,
            _ => BlockState::Edited,
        };
    }
    match (expected, legacy_hash) {
        (None, _) if existing.contains(FOREIGN_BEGIN) => BlockState::Foreign,
        (None, _) => BlockState::InSync,
        (Some(_), Some(hash)) if ContentHash::of(existing.as_bytes()) == hash => BlockState::InSync,
        (Some(_), _) => BlockState::Missing,
    }
}

/// True when our block exists but a write of `expected` (the content Chimera
/// last projected) would not reproduce it, i.e. writing would discard hand edits.
pub(crate) fn block_edited(existing: &str, expected: Option<&str>) -> Result<bool, AppError> {
    if bounds(existing, BEGIN, END)?.is_none() {
        return Ok(false);
    }
    Ok(!same_text(&project(existing, expected, None)?, existing))
}

/// Explicit takeover only. Replace the foreign markers in place, preserving
/// every body and surrounding byte; coexistence needs manual conflict resolution.
pub(crate) fn adopt_foreign(existing: &str) -> Result<(String, String), AppError> {
    project(existing, None, None)?;
    if bounds(existing, BEGIN, END)?.is_some() {
        return Err(AppError::localized(
            "prompt.managed.takeover_conflict",
            "已有 Chimera 受管区块，请先停用全部提示词后再接管。",
            "A Chimera block already exists; disable every prompt before taking over.",
        ));
    }
    let range = bounds(existing, FOREIGN_BEGIN, FOREIGN_END)?.ok_or_else(|| {
        AppError::localized(
            "prompt.managed.foreign_missing",
            "未找到可接管的其他工具区块，请刷新后查看。",
            "No other tool's block was found to take over; refresh and check again.",
        )
    })?;
    let next = format!(
        "{}{}{}{}{}",
        &existing[..range.start],
        BEGIN,
        &existing[range.start + FOREIGN_BEGIN.len()..range.end - FOREIGN_END.len()],
        END,
        &existing[range.end..]
    );
    let body = owned_body(&next)?.ok_or_else(malformed_error)?.to_string();
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
        .map_err(|_| encoding_error())?;
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

    fn code(error: AppError) -> &'static str {
        match error {
            AppError::Localized { key, .. } => key,
            other => panic!("expected a coded error, got {other}"),
        }
    }

    #[test]
    fn ownership_conflicts_carry_stable_codes() {
        let cases = [
            (BEGIN.to_string(), "prompt.managed.unbalanced"),
            (format!("{END}\n{BEGIN}"), "prompt.managed.unbalanced"),
            (
                format!("{BEGIN}\nx\n{END}\n{BEGIN}\ny\n{END}"),
                "prompt.managed.duplicate",
            ),
            (
                format!("Inline {BEGIN}\nx\n{END}"),
                "prompt.managed.marker_inline",
            ),
            (
                format!("{FOREIGN_BEGIN}\n{BEGIN}\nx\n{END}\n{FOREIGN_END}"),
                "prompt.managed.nested",
            ),
        ];
        for (text, expected) in cases {
            assert_eq!(
                code(project(&text, Some("new"), None).unwrap_err()),
                expected
            );
            assert_eq!(code(project(&text, None, None).unwrap_err()), expected);
        }
        assert_eq!(
            code(project("", Some(BEGIN), None).unwrap_err()),
            "prompt.body.reserved_marker"
        );
        assert_eq!(
            code(project("Legacy", Some("x"), Some(ContentHash::of(b"Other"))).unwrap_err()),
            "prompt.managed.legacy_mismatch"
        );
        let foreign = format!("{FOREIGN_BEGIN}\nForeign\n{FOREIGN_END}");
        assert_eq!(
            code(adopt_foreign(&format!("{BEGIN}\nOurs\n{END}\n{foreign}")).unwrap_err()),
            "prompt.managed.takeover_conflict"
        );
        assert_eq!(
            code(adopt_foreign("User").unwrap_err()),
            "prompt.managed.foreign_missing"
        );
    }

    #[test]
    fn inspection_tells_sync_missing_edits_markers_and_foreign_blocks_apart() {
        let synced = project("User\n", Some("A\nB"), None).unwrap();
        assert_eq!(inspect(&synced, Some("A\nB"), None), BlockState::InSync);
        // An editor converting every line ending is not a hand edit.
        let converted = synced.replace('\n', "\r\n");
        assert_eq!(inspect(&converted, Some("A\nB"), None), BlockState::InSync);
        assert_eq!(inspect("User\n", Some("A\nB"), None), BlockState::Missing);
        assert_eq!(inspect("", Some("A\nB"), None), BlockState::Missing);
        let edited = synced.replace("A\nB", "A\nHand edit");
        assert_eq!(inspect(&edited, Some("A\nB"), None), BlockState::Edited);
        assert_eq!(inspect(&synced, None, None), BlockState::Edited);
        assert_eq!(inspect(BEGIN, Some("A\nB"), None), BlockState::Malformed);
        let foreign = format!("{FOREIGN_BEGIN}\nForeign\n{FOREIGN_END}\n");
        assert_eq!(inspect(&foreign, None, None), BlockState::Foreign);
        assert_eq!(inspect(&foreign, Some("A\nB"), None), BlockState::Missing);
        assert_eq!(inspect("User\n", None, None), BlockState::InSync);
        let legacy = ContentHash::of(b"Legacy");
        assert_eq!(
            inspect("Legacy", Some("Legacy"), Some(legacy)),
            BlockState::InSync
        );
        assert_eq!(
            inspect("Changed", Some("Legacy"), Some(legacy)),
            BlockState::Missing
        );
    }

    #[test]
    fn writes_detect_hand_edits_inside_the_block_only() {
        let synced = project("User\n", Some("Rules"), None).unwrap();
        assert!(!block_edited(&synced, Some("Rules")).unwrap());
        assert!(!block_edited(&synced.replace("User", "Changed user"), Some("Rules")).unwrap());
        assert!(!block_edited("User edits only\n", Some("Rules")).unwrap());
        assert!(block_edited(&synced.replace("Rules", "Hand edit"), Some("Rules")).unwrap());
        assert!(block_edited(&synced, None).unwrap());
        assert!(block_edited(&format!("{BEGIN}\n{END}"), Some("Rules")).unwrap());
        assert!(block_edited(BEGIN, Some("Rules")).is_err());
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
