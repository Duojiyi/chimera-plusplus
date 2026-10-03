//! Shared Gemini JSON/append-only JSONL reader for sessions and usage.
use crate::security_limits::{read_to_string_limited, MAX_SESSION_FILE_BYTES};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};

pub(crate) fn is_session_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|name| {
            name.starts_with("session-")
                && matches!(
                    path.extension().and_then(|s| s.to_str()),
                    Some("json" | "jsonl")
                )
        })
}

pub(crate) fn read_session(path: &Path) -> Result<Value, String> {
    let data = read_to_string_limited(path, MAX_SESSION_FILE_BYTES)
        .map_err(|e| format!("Failed to read Gemini session: {e}"))?;
    parse_session(&data)
}

fn parse_session(data: &str) -> Result<Value, String> {
    // Preserve legacy pretty-printed JSON, including files without a final newline.
    if let Ok(mut value) = serde_json::from_str::<Value>(data) {
        if value.is_object() && value.get("messages").is_some_and(Value::is_array) {
            if value
                .get("sessionId")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err("Gemini session has no sessionId".into());
            }
            let mut messages = Vec::new();
            let mut positions = HashMap::new();
            for message in value["messages"].as_array().unwrap() {
                upsert(&mut messages, &mut positions, message.clone());
            }
            value["messages"] = Value::Array(messages);
            return Ok(value);
        }
    }
    let mut session = json!({"messages": []});
    let mut messages: Vec<Value> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for (index, line) in data.split_inclusive('\n').enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let record: Value = match serde_json::from_str(line) {
            Ok(record) => record,
            // A writer may still be appending the final record. Completed malformed
            // records are errors, not a reason to silently drop the remaining history.
            Err(e) if !line.ends_with('\n') && e.is_eof() => break,
            Err(e) => return Err(format!("Invalid Gemini record {}: {e}", index + 1)),
        };
        let object = record
            .as_object()
            .ok_or_else(|| format!("Gemini record {} is not an object", index + 1))?;
        if let Some(patch) = object.get("$set") {
            let patch = patch.as_object().ok_or("Gemini $set is not an object")?;
            for (key, value) in patch {
                if key == "messages" {
                    let snapshot = value
                        .as_array()
                        .ok_or("Gemini $set.messages is not an array")?;
                    messages.clear();
                    positions.clear();
                    for message in snapshot {
                        upsert(&mut messages, &mut positions, message.clone());
                    }
                } else {
                    session[key] = value.clone();
                }
            }
        } else if object.contains_key("type") && object.contains_key("id") {
            if let Some(timestamp) = record.get("timestamp") {
                session["lastUpdated"] = timestamp.clone();
            }
            upsert(&mut messages, &mut positions, record);
        } else if object.contains_key("sessionId") {
            for (key, value) in object {
                if key != "messages" {
                    session[key] = value.clone();
                }
            }
            if let Some(snapshot) = object.get("messages") {
                let snapshot = snapshot
                    .as_array()
                    .ok_or("Gemini messages is not an array")?;
                messages.clear();
                positions.clear();
                for message in snapshot {
                    upsert(&mut messages, &mut positions, message.clone());
                }
            }
        } else {
            return Err(format!("Unknown Gemini record {}", index + 1));
        }
    }
    if session
        .get("sessionId")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err("Gemini session has no sessionId".into());
    }
    session["messages"] = Value::Array(messages);
    Ok(session)
}

fn upsert(messages: &mut Vec<Value>, positions: &mut HashMap<String, usize>, message: Value) {
    if let Some(id) = message.get("id").and_then(Value::as_str) {
        if let Some(&index) = positions.get(id) {
            messages[index] = message;
            return;
        }
        positions.insert(id.to_owned(), messages.len());
    }
    messages.push(message);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_and_jsonl_replay() {
        let legacy =
            json!({"sessionId":"s", "messages":[{"id":"a","type":"user","content":"hello"}]});
        assert_eq!(
            parse_session(&serde_json::to_string_pretty(&legacy).unwrap()).unwrap(),
            legacy
        );
        let lines = [
            json!({"sessionId":"s","startTime":"2026-01-01"}),
            json!({"id":"old","type":"user","content":"discard"}),
            json!({"$set":{"messages":legacy["messages"],"lastUpdated":"2026-01-02"}}),
            json!({"id":"b","type":"gemini","tokens":{"input":1}}),
            json!({"id":"b","type":"gemini","tokens":{"input":2},"toolCalls":[{"name":"read"}]}),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        let parsed = parse_session(&lines).unwrap();
        assert_eq!(parsed["messages"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["messages"][0]["id"], "a");
        assert_eq!(parsed["messages"][1]["tokens"]["input"], 2);
        assert_eq!(parsed["messages"][1]["toolCalls"][0]["name"], "read");
    }
    #[test]
    fn legacy_rewrites_are_normalized_and_missing_session_is_rejected() {
        let value = parse_session(r#"{"sessionId":"s","messages":[{"id":"a","content":"old"},{"id":"a","content":"new"}]}"#).unwrap();
        assert_eq!(value["messages"].as_array().unwrap().len(), 1);
        assert_eq!(value["messages"][0]["content"], "new");
        assert!(parse_session(r#"{"messages":[]}"#).is_err());
    }
    #[test]
    fn incomplete_tail_only_is_tolerated() {
        let header = "{\"sessionId\":\"s\"}\n";
        assert!(parse_session(&format!("{header}{{\"id\":")).is_ok());
        assert!(parse_session(&format!("{header}{{\"id\":\n")).is_err());
        assert!(parse_session(&format!("{header}not-json")).is_err());
        assert!(parse_session("{\"id\":").is_err());
    }
    #[test]
    fn empty_snapshot_replaces_history_and_extensions_are_checked() {
        let value = parse_session("{\"sessionId\":\"s\"}\n{\"id\":\"m\",\"type\":\"user\"}\n{\"$set\":{\"messages\":[]}}\n").unwrap();
        assert_eq!(value["messages"], json!([]));
        for name in ["session-a.json", "session-a.jsonl"] {
            assert!(is_session_file(Path::new(name)));
        }
        assert!(!is_session_file(Path::new("settings.json")));
    }
}
