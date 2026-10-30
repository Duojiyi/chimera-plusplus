//! Codex→Chat：Gemini 系上游的工具 schema 枚举规整。
//!
//! Gemini（含 OpenAI 兼容端点与中转暴露的 `google/gemini-*`）的 function
//! declaration 只允许 STRING 类型带 `enum`，`enum: [true, false]` 或数字枚举会让
//! 整轮请求 400（`enum only allowed for STRING type`）。
//!
//! Adapted from BigPizzaV3/CodexPlusPlus 57205ba2, c0514a22

use serde_json::{Map, Value};

/// 这些关键字的值是数据而不是子 schema，不往里递归。
const NON_SCHEMA_KEYWORDS: &[&str] = &["enum", "const", "default", "examples"];

/// 按出站模型名判断上游是否 Gemini 系。
pub(crate) fn upstream_requires_string_enums(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    model.contains("gemini") || model.starts_with("google/")
}

/// 规整 Chat 请求体 `tools[].function.parameters` 里的枚举。返回改写过的工具数。
pub(crate) fn coerce_chat_tool_enums_for_gemini(chat_body: &mut Value) -> usize {
    let Some(tools) = chat_body.get_mut("tools").and_then(Value::as_array_mut) else {
        return 0;
    };
    let mut changed = 0;
    for tool in tools.iter_mut() {
        let Some(parameters) = tool
            .get_mut("function")
            .and_then(|function| function.get_mut("parameters"))
        else {
            continue;
        };
        if coerce_enums(parameters) {
            changed += 1;
        }
    }
    changed
}

/// - 声明了非字符串 `type` 的节点：去掉 `enum`、保留原类型，可选值写进
///   `description`（改成 string 会让模型回传 `"1"`，工具端按 integer 校验失败）；
/// - `type` 为 string 或未声明：`enum` 里的布尔/数字/null 转成字符串。
fn coerce_enums(schema: &mut Value) -> bool {
    match schema {
        Value::Object(map) => {
            let mut changed = coerce_enum_node(map);
            for (key, child) in map.iter_mut() {
                if !NON_SCHEMA_KEYWORDS.contains(&key.as_str()) {
                    changed |= coerce_enums(child);
                }
            }
            changed
        }
        Value::Array(items) => {
            // Every item must be visited, so no short-circuiting `any`.
            let mut changed = false;
            for item in items.iter_mut() {
                changed |= coerce_enums(item);
            }
            changed
        }
        _ => false,
    }
}

fn coerce_enum_node(map: &mut Map<String, Value>) -> bool {
    if !map.get("enum").is_some_and(Value::is_array) {
        return false;
    }
    let non_string_type = match map.get("type") {
        Some(Value::String(kind)) => kind != "string",
        Some(Value::Array(kinds)) => !kinds.iter().any(|kind| kind == "string"),
        _ => false,
    };
    if non_string_type {
        let Some(Value::Array(entries)) = map.remove("enum") else {
            return false;
        };
        let allowed = entries
            .iter()
            .map(|entry| match entry {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join(", ");
        let hint = format!("Allowed values: {allowed}");
        let description = match map.get("description").and_then(Value::as_str) {
            Some(existing) if !existing.trim().is_empty() => format!("{existing} ({hint})"),
            _ => hint,
        };
        map.insert("description".to_string(), Value::String(description));
        return true;
    }
    let Some(Value::Array(entries)) = map.get_mut("enum") else {
        return false;
    };
    let mut changed = false;
    for entry in entries.iter_mut() {
        let coerced = match entry {
            Value::Bool(flag) => flag.to_string(),
            Value::Number(number) => number.to_string(),
            Value::Null => "null".to_string(),
            _ => continue,
        };
        *entry = Value::String(coerced);
        changed = true;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn gate_matches_gemini_models_only() {
        for model in [
            "gemini-2.5-pro",
            "Gemini-3-Flash",
            "google/gemini-3-pro-preview",
            "models/gemini-2.0-flash",
            "google/gemma-3",
        ] {
            assert!(upstream_requires_string_enums(model), "{model}");
        }
        for model in ["gpt-5.1", "deepseek-chat", "kimi-k2", ""] {
            assert!(!upstream_requires_string_enums(model), "{model}");
        }
    }

    #[test]
    fn non_string_enums_move_into_description_and_string_enums_are_stringified() {
        let mut body = json!({
            "tools": [{
                "type": "function",
                "function": {
                    "name": "f",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "enabled": {"type": "boolean", "enum": [true, false]},
                            "level": {"type": "integer", "enum": [1, 2], "description": "Level"},
                            "mode": {"type": "string", "enum": ["fast", 1]},
                            "untyped": {"enum": [true, 2, null]},
                            "nullable": {"type": ["string", "null"], "enum": ["a", null]},
                            "list": {
                                "type": "array",
                                "items": {"anyOf": [{"type": "number", "enum": [0.5]}]}
                            },
                            "keep": {"type": "string", "enum": ["a", "b"], "default": {"enum": [1]}}
                        }
                    }
                }
            }, {"type": "function", "function": {"name": "g", "parameters": {"type": "object"}}}]
        });
        assert_eq!(coerce_chat_tool_enums_for_gemini(&mut body), 1);
        let p = &body["tools"][0]["function"]["parameters"]["properties"];
        assert!(p["enabled"].get("enum").is_none(), "{p}");
        assert_eq!(p["enabled"]["type"], "boolean");
        assert_eq!(p["enabled"]["description"], "Allowed values: true, false");
        assert!(p["level"].get("enum").is_none());
        assert_eq!(p["level"]["type"], "integer");
        assert_eq!(p["level"]["description"], "Level (Allowed values: 1, 2)");
        assert_eq!(p["mode"]["enum"], json!(["fast", "1"]));
        assert_eq!(p["untyped"]["enum"], json!(["true", "2", "null"]));
        assert_eq!(p["nullable"]["enum"], json!(["a", "null"]));
        let nested = &p["list"]["items"]["anyOf"][0];
        assert!(nested.get("enum").is_none());
        assert_eq!(nested["description"], "Allowed values: 0.5");
        // 数据关键字（default 等）里的内容原样保留。
        assert_eq!(p["keep"]["enum"], json!(["a", "b"]));
        assert_eq!(p["keep"]["default"], json!({"enum": [1]}));
    }

    #[test]
    fn malformed_tools_are_left_alone() {
        for original in [
            json!(null),
            json!({"tools": null}),
            json!({"tools": [null, {"function": null}, {"function": {"parameters": null}}]}),
            json!({"tools": [{"function": {"parameters": {"type": "string", "enum": "x"}}}]}),
        ] {
            let mut body = original.clone();
            assert_eq!(coerce_chat_tool_enums_for_gemini(&mut body), 0);
            assert_eq!(body, original);
        }
    }
}
