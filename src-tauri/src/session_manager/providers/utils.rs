use std::fs::File;
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;

use chrono::{DateTime, FixedOffset};
use serde_json::Value;

/// Maximum number of characters for session titles (shared across providers).
pub const TITLE_MAX_CHARS: usize = 80;

/// Read the first `head_n` lines and last `tail_n` lines from a file.
/// For small files (< 16 KB), reads all lines once to avoid unnecessary seeking.
///
/// There is deliberately no whole-file size gate here: this function only
/// ever reads a bounded number of lines (`head_n` + `tail_n`, or the last
/// ~16 KB for the tail seek), regardless of how large the file on disk is,
/// so total file size is not a memory-safety concern. A prior version
/// rejected any file above a fixed byte threshold, which made large-but
/// -otherwise-healthy session files (Claude/Codex/Hermes/OpenClaw rollouts
/// can legitimately grow past that) silently disappear from the session
/// list instead of just being indexed normally.
pub fn read_head_tail_lines(
    path: &Path,
    head_n: usize,
    tail_n: usize,
) -> io::Result<(Vec<String>, Vec<String>)> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "session symlink is not allowed",
        ));
    }
    let file_len = metadata.len();
    let file = File::open(path)?;

    // For small files, read all lines once and split
    if file_len < 16_384 {
        let reader = BufReader::new(file);
        let all: Vec<String> = reader.lines().map_while(Result::ok).collect();
        let head = all.iter().take(head_n).cloned().collect();
        let skip = all.len().saturating_sub(tail_n);
        let tail = all.into_iter().skip(skip).collect();
        return Ok((head, tail));
    }

    // Read head lines from the beginning
    let reader = BufReader::new(file);
    let head: Vec<String> = reader.lines().take(head_n).map_while(Result::ok).collect();

    // Seek to last ~16 KB for tail lines
    let seek_pos = file_len.saturating_sub(16_384);
    let mut file2 = File::open(path)?;
    file2.seek(SeekFrom::Start(seek_pos))?;
    let tail_reader = BufReader::new(file2);
    let all_tail: Vec<String> = tail_reader.lines().map_while(Result::ok).collect();

    // Skip first partial line if we seeked into the middle of a line
    let skip_first = if seek_pos > 0 { 1 } else { 0 };
    let usable: Vec<String> = all_tail.into_iter().skip(skip_first).collect();
    let skip = usable.len().saturating_sub(tail_n);
    let tail = usable.into_iter().skip(skip).collect();

    Ok((head, tail))
}

pub fn parse_timestamp_to_ms(value: &Value) -> Option<i64> {
    // Integer: milliseconds (>1e12) or seconds
    if let Some(n) = value.as_i64() {
        return Some(if n > 1_000_000_000_000 { n } else { n * 1000 });
    }
    if let Some(n) = value.as_f64() {
        let n = n as i64;
        return Some(if n > 1_000_000_000_000 { n } else { n * 1000 });
    }
    // RFC3339 string
    let raw = value.as_str()?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt: DateTime<FixedOffset>| dt.timestamp_millis())
}

pub fn extract_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(extract_text_from_item)
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => map
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}

fn extract_text_from_item(item: &Value) -> Option<String> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");

    // tool_use: show tool name
    if item_type == "tool_use" {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Some(format!("[Tool: {name}]"));
    }

    // tool_result: extract nested content
    if item_type == "tool_result" {
        if let Some(content) = item.get("content") {
            let text = extract_text(content);
            if !text.is_empty() {
                return Some(text);
            }
        }
        return None;
    }

    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }

    if let Some(text) = item.get("input_text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }

    if let Some(text) = item.get("output_text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }

    if let Some(content) = item.get("content") {
        let text = extract_text(content);
        if !text.is_empty() {
            return Some(text);
        }
    }

    None
}

pub fn truncate_summary(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let mut result = trimmed.chars().take(max_chars).collect::<String>();
    result.push_str("...");
    result
}

pub fn path_basename(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.trim_end_matches(['/', '\\']);
    let last = normalized
        .split(['/', '\\'])
        .next_back()
        .filter(|segment| !segment.is_empty())?;
    Some(last.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_timestamp_to_ms_supports_integers_and_rfc3339() {
        assert_eq!(
            parse_timestamp_to_ms(&json!(1_771_061_953_033_i64)),
            Some(1_771_061_953_033)
        );
        assert_eq!(
            parse_timestamp_to_ms(&json!(1_771_061_953_i64)),
            Some(1_771_061_953_000)
        );
        assert_eq!(
            parse_timestamp_to_ms(&json!("1970-01-01T00:00:01Z")),
            Some(1_000)
        );
    }
}

/// Only inert, non-option identifiers are accepted across cmd, PowerShell and POSIX shells.
pub(super) fn resume_command(prefix: &str, id: &str) -> Option<String> {
    if !id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return None;
    }
    Some(format!("{prefix} \"{id}\""))
}

pub(super) fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

/// Portable single component: reject Windows devices, ADS, prefixes and separators on all hosts.
pub(super) fn validate_id(id: &str) -> Result<(), String> {
    let stem = id
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if id.is_empty()
        || id == "."
        || id == ".."
        || id.ends_with(['.', ' '])
        || device
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
    {
        return Err(format!("Unsafe session/message ID: {id:?}"));
    }
    Ok(())
}

/// Check every existing component, including a missing target's ancestors.
/// Reparse points (including junctions) are forbidden on Windows.
pub(super) fn deletion_path(root: &Path, path: &Path) -> Result<bool, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Deletion path escapes root")?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Deletion target must be a strict descendant".into());
    }
    let mut current = root.to_path_buf();
    let components = std::iter::once(None).chain(relative.components().map(Some));
    for component in components {
        if let Some(component) = component {
            current.push(component.as_os_str());
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let reparse = false;
                if metadata.file_type().is_symlink() || reparse {
                    return Err(format!(
                        "Linked deletion path is forbidden: {}",
                        current.display()
                    ));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(format!("Cannot inspect {}: {e}", current.display())),
        }
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if canonical == canonical_root || !canonical.starts_with(&canonical_root) {
        return Err("Deletion path escapes root".into());
    }
    Ok(true)
}

/// Unlike discovery scans, deletion must not silently skip links, I/O errors or depth limits.
pub(super) fn deletion_files(root: &Path, dir: &Path) -> Result<Vec<std::path::PathBuf>, String> {
    let mut files = Vec::new();
    let mut pending = vec![(dir.to_path_buf(), 0)];
    while let Some((path, depth)) = pending.pop() {
        if !deletion_path(root, &path)? {
            continue;
        }
        if !path.is_dir() {
            files.push(path);
            continue;
        }
        if depth > crate::security_limits::MAX_SESSION_SCAN_DEPTH {
            return Err("Deletion scan depth exceeded".into());
        }
        for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
            pending.push((entry.map_err(|e| e.to_string())?.path(), depth + 1));
        }
    }
    Ok(files)
}

pub(super) fn delete_paths(root: &Path, paths: &[std::path::PathBuf]) -> Result<bool, String> {
    // Complete preflight before the first mutation, then recheck immediately before each removal.
    // These path-based checks do not provide atomic protection against concurrent ancestor renames.
    for path in paths {
        deletion_files(root, path)?;
    }
    let mut deleted = false;
    for path in paths {
        if !deletion_path(root, path)? {
            continue;
        }
        let result = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        result.map_err(|e| format!("Session deletion incomplete at {}: {e}", path.display()))?;
        deleted = true;
    }
    Ok(deleted)
}

#[cfg(test)]
mod safety_tests {
    use super::*;

    #[test]
    fn resume_arguments_are_inert_in_all_supported_shells() {
        for prefix in [
            "codex resume",
            "claude --resume",
            "gemini --resume",
            "grok --resume",
            "opencode -s",
        ] {
            assert_eq!(
                resume_command(prefix, "ses_123-Ab"),
                Some(format!("{prefix} \"ses_123-Ab\""))
            );
            for id in [
                "", "--help", "a b", "a;id", "$(id)", "a`id`", "a\"b", "a'b", "%PATH%", "!PATH!",
                "a&b", "a|b", "a\nb", "a\rb", "a\\b", "a/b",
            ] {
                assert!(resume_command(prefix, id).is_none(), "{prefix}: {id:?}");
            }
        }
        assert!(is_uuid("019cc369-bd7c-7891-b371-7b20b4fe0b18"));
        assert!(!is_uuid("019cc369-bd7c-7891-b371-7b20b4fe0b1z"));
        assert!(!is_uuid("019cc369_bd7c-7891-b371-7b20b4fe0b18"));
    }

    #[test]
    fn ids_reject_traversal_and_windows_aliases_on_every_platform() {
        for id in [
            "",
            ".",
            "..",
            "../outside",
            "..\\outside",
            "/tmp",
            "C:\\tmp",
            "C:tmp",
            "\\\\server\\share",
            "msg:stream",
            "CON",
            "nul.json",
            "LPT1",
            "COM9.txt",
            "msg.",
            "msg ",
            "a\0b",
        ] {
            assert!(validate_id(id).is_err(), "{id:?}");
        }
        assert!(validate_id("msg_123-abc").is_ok());
    }

    #[test]
    fn all_targets_are_preflighted_before_removal() {
        let temp = tempfile::tempdir().unwrap();
        let keep = temp.path().join("keep");
        std::fs::write(&keep, "keep").unwrap();
        assert!(delete_paths(temp.path(), &[keep.clone(), temp.path().to_path_buf()]).is_err());
        assert!(keep.exists());
        assert!(deletion_path(temp.path(), &temp.path().join("missing/../outside")).is_err());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn linked_ancestors_and_nested_links_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = temp.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        #[cfg(windows)]
        if let Err(e) = std::os::windows::fs::symlink_dir(outside.path(), &link) {
            if e.raw_os_error() == Some(1314) {
                return;
            } // Requires Developer Mode or privilege.
            panic!("{e}");
        }
        assert!(deletion_path(temp.path(), &link.join("missing")).is_err());
        assert!(deletion_files(temp.path(), &link).is_err());
        let keep = temp.path().join("keep");
        std::fs::write(&keep, "keep").unwrap();
        let directory = temp.path().join("directory");
        std::fs::create_dir(&directory).unwrap();
        std::fs::rename(&link, directory.join("nested-link")).unwrap();
        assert!(delete_paths(temp.path(), &[keep.clone(), directory]).is_err());
        assert!(keep.exists());
        assert!(outside.path().exists());
    }
}
