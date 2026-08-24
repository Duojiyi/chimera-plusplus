//! Responses API item-ID prefix normalization.
//!
//! OpenAI's Responses API enforces a strict contract between an item's `type`
//! and the prefix of its `id`:
//!
//! | type                      | required prefix |
//! |---------------------------|-----------------|
//! | `message`                 | `msg_`          |
//! | `reasoning`               | `rs_`           |
//! | `function_call`           | `fc_`           |
//! | `function_call_output`    | `fco_`          |
//! | `custom_tool_call`        | `ctc_`          |
//! | `custom_tool_call_output` | `ctco_`         |
//!
//! When a Codex session is replayed through a protocol-converting proxy, the
//! item `type` and `id` can drift apart (for example a `custom_tool_call` that
//! was stamped with an `fc_` id by a Chat→Responses round-trip where the tool
//! context was unavailable). Upstream then rejects the request with:
//!
//! ```text
//! Invalid 'input[N].id': 'fc_…'. Expected an ID that begins with 'ctc'.
//! ```
//!
//! Because Codex persists history items verbatim, a single bad item poisons the
//! whole session and every later turn. This module provides a conservative
//! inbound normalizer that rewrites the `id` of every item in `input[]` whose
//! prefix does not match its type. It only touches items that are already
//! broken (and would otherwise 400), never adds an `id` to an item that lacks
//! one, and never rewrites `call_id` (which is the matching key used by history
//! caches and Chat upstreams).

use serde_json::Value;

/// Required `id` prefix for each Responses item type that enforces one.
fn expected_prefix(item_type: &str) -> Option<&'static str> {
    match item_type {
        "message" => Some("msg_"),
        "reasoning" => Some("rs_"),
        "function_call" => Some("fc_"),
        "function_call_output" => Some("fco_"),
        "custom_tool_call" => Some("ctc_"),
        "custom_tool_call_output" => Some("ctco_"),
        _ => None,
    }
}

/// Every prefix we know how to strip before re-applying the correct one.
/// These are mutually non-overlapping: each ends in `_`, so none is a proper
/// prefix of another (`fc_` and `fco_` differ at the third character).
const ALL_PREFIXES: &[&str] = &["msg_", "rs_", "fc_", "fco_", "ctc_", "ctco_"];

/// Rewrites the `id` of a single item so its prefix matches `item_type`.
/// Returns `true` when the item was mutated.
fn normalize_item_id(item: &mut Value) -> bool {
    let Some(item_type) = item.get("type").and_then(Value::as_str) else {
        return false;
    };
    let Some(prefix) = expected_prefix(item_type) else {
        return false;
    };
    let Some(id) = item.get("id").and_then(Value::as_str) else {
        return false;
    };
    if id.is_empty() || id.starts_with(prefix) {
        return false;
    }

    // Strip a known wrong prefix (longest match wins) and keep the remainder as
    // the suffix, so `fco_123` becomes `fc_123` rather than `fc_o_123`.
    let suffix = ALL_PREFIXES
        .iter()
        .filter_map(|known| id.strip_prefix(known))
        .max_by_key(|suffix| id.len() - suffix.len())
        .unwrap_or(id);

    item["id"] = Value::String(format!("{prefix}{suffix}"));
    true
}

/// Normalizes every item `id` in a Responses request body's `input` field.
///
/// Returns the number of rewritten ids. Only the array form of `input` is
/// processed (the only form the Responses API accepts for item lists).
pub(crate) fn normalize_responses_input_ids(body: &mut Value) -> usize {
    let Some(items) = body.get_mut("input").and_then(Value::as_array_mut) else {
        return 0;
    };

    let mut count = 0;
    for item in items.iter_mut() {
        if normalize_item_id(item) {
            count += 1;
        }
    }

    if count > 0 {
        log::debug!("[Codex] Normalized {count} response item id prefix(es)");
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fixes_custom_tool_call_with_fc_prefix() {
        let mut body = json!({
            "model": "gpt-5",
            "input": [
                {
                    "id": "fc_09b8cd15b7849297016a8b951b926c87d1bd08702174e0d1c8",
                    "type": "custom_tool_call",
                    "call_id": "call_abc",
                    "name": "apply_patch",
                    "input": "some patch",
                    "status": "completed"
                }
            ]
        });

        let count = normalize_responses_input_ids(&mut body);
        assert_eq!(count, 1);
        assert_eq!(
            body["input"][0]["id"],
            "ctc_09b8cd15b7849297016a8b951b926c87d1bd08702174e0d1c8"
        );
        // call_id must never be rewritten — it is the history/association key.
        assert_eq!(body["input"][0]["call_id"], "call_abc");
    }

    #[test]
    fn leaves_correct_ids_untouched() {
        let mut body = json!({
            "model": "gpt-5",
            "input": [
                {"id": "fc_abc", "type": "function_call", "call_id": "c1", "name": "exec", "arguments": "{}"},
                {"id": "ctc_def", "type": "custom_tool_call", "call_id": "c2", "name": "patch", "input": "x"},
                {"id": "msg_ghi", "type": "message", "role": "user", "content": []}
            ]
        });

        assert_eq!(normalize_responses_input_ids(&mut body), 0);
    }

    #[test]
    fn fixes_function_call_with_ctc_prefix() {
        let mut body = json!({
            "model": "gpt-5",
            "input": [
                {"id": "ctc_wrong", "type": "function_call", "call_id": "c1", "name": "exec", "arguments": "{}"}
            ]
        });

        assert_eq!(normalize_responses_input_ids(&mut body), 1);
        assert_eq!(body["input"][0]["id"], "fc_wrong");
    }

    #[test]
    fn fixes_output_items() {
        let mut body = json!({
            "model": "gpt-5",
            "input": [
                {"id": "fc_out1", "type": "custom_tool_call_output", "call_id": "c1", "output": "ok"},
                {"id": "ctc_out2", "type": "function_call_output", "call_id": "c2", "output": "ok"}
            ]
        });

        assert_eq!(normalize_responses_input_ids(&mut body), 2);
        assert_eq!(body["input"][0]["id"], "ctco_out1");
        assert_eq!(body["input"][1]["id"], "fco_out2");
    }

    #[test]
    fn strips_output_prefix_whole() {
        // `fco_` must be stripped as a unit (→ "fc_call"), never mis-parsed as
        // `fc_` + leftover "o_" (→ "fc_o_call").
        let mut body = json!({
            "model": "gpt-5",
            "input": [
                {"id": "fco_call", "type": "function_call", "call_id": "c1", "name": "exec", "arguments": "{}"}
            ]
        });

        assert_eq!(normalize_responses_input_ids(&mut body), 1);
        assert_eq!(body["input"][0]["id"], "fc_call");
    }

    #[test]
    fn skips_items_without_id() {
        let mut body = json!({
            "model": "gpt-5",
            "input": [
                {"type": "custom_tool_call", "call_id": "c1", "name": "patch", "input": "x"}
            ]
        });

        assert_eq!(normalize_responses_input_ids(&mut body), 0);
    }

    #[test]
    fn skips_unknown_types() {
        let mut body = json!({
            "model": "gpt-5",
            "input": [
                {"id": "whatever_123", "type": "item_reference", "ref": "x"}
            ]
        });

        assert_eq!(normalize_responses_input_ids(&mut body), 0);
        assert_eq!(body["input"][0]["id"], "whatever_123");
    }

    #[test]
    fn handles_string_input() {
        let mut body = json!({"model": "gpt-5", "input": "plain string prompt"});
        assert_eq!(normalize_responses_input_ids(&mut body), 0);
    }

    #[test]
    fn handles_missing_input() {
        let mut body = json!({"model": "gpt-5"});
        assert_eq!(normalize_responses_input_ids(&mut body), 0);
    }
}
