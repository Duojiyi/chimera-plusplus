//! 托管生图工具（`image_generation`）整流器。
//!
//! Codex App 每个 `/responses` 请求都带 `{"type":"image_generation"}`。Chat /
//! Anthropic 转换路径本来就不转发托管工具，但原生 Responses 中转里不支持生图的
//! 会整条请求拒绝。上游明确因为这个工具报错时，剥掉它对同一线路重试一次，并在
//! 进程内记住该线路（线路配置变化后失效），后续请求直接剥离，免得每轮都多一次往返。
//!
//! Adapted from BigPizzaV3/CodexPlusPlus ab233054（剥离逻辑；开关改为按报错自动触发）

use super::error::ProxyError;
use crate::provider::Provider;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

const IMAGE_GENERATION_TOOL_TYPE: &str = "image_generation";

/// 报错里除了点名 `image_generation`，还必须带上"不支持 / 未知 / 无效"一类措辞，
/// 避免把生图本身的业务错误（额度、内容审核等）误判为工具被拒。
const REJECTION_HINTS: &[&str] = &[
    "unsupported",
    "not supported",
    "does not support",
    "doesn't support",
    "unknown",
    "unrecognized",
    "invalid",
    "not allowed",
    "not permitted",
    "not enabled",
    "not available",
    "forbidden",
    "不支持",
    "未知",
    "无效",
    "不允许",
];

fn is_image_generation_tool(tool: &Value) -> bool {
    tool.get("type").and_then(Value::as_str) == Some(IMAGE_GENERATION_TOOL_TYPE)
}

/// 从 Responses 请求里移除托管生图工具：顶层 `tools`、输入项形式的
/// `additional_tools`，以及指向它的 `tool_choice`。工具删空时连 `tool_choice`
/// 一起去掉，免得 `required` 落在空工具表上。返回是否改动过请求。
pub(crate) fn strip_image_generation_tool(body: &mut Value) -> bool {
    let Some(object) = body.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if let Some(Value::Array(items)) = object.get_mut("input") {
        for item in items.iter_mut() {
            if item.get("type").and_then(Value::as_str) != Some("additional_tools") {
                continue;
            }
            if let Some(Value::Array(tools)) = item.get_mut("tools") {
                let before = tools.len();
                tools.retain(|tool| !is_image_generation_tool(tool));
                changed |= tools.len() != before;
            }
        }
    }
    let mut tools_emptied = false;
    if let Some(Value::Array(tools)) = object.get_mut("tools") {
        let before = tools.len();
        tools.retain(|tool| !is_image_generation_tool(tool));
        if tools.len() != before {
            changed = true;
            tools_emptied = tools.is_empty();
        }
    }
    if tools_emptied {
        object.remove("tools");
        object.remove("tool_choice");
        return true;
    }
    match object.get_mut("tool_choice") {
        // 指名要生图工具：工具已不在，退回默认的自动选择。
        Some(choice) if is_image_generation_tool(choice) => {
            object.remove("tool_choice");
            changed = true;
        }
        // allowed_tools 白名单里的生图工具也一并去掉。
        Some(choice) => {
            if let Some(Value::Array(allowed)) = choice.get_mut("tools") {
                let before = allowed.len();
                allowed.retain(|tool| !is_image_generation_tool(tool));
                changed |= allowed.len() != before;
            }
        }
        None => {}
    }
    changed
}

/// 上游是否明确因为 `image_generation` 工具拒绝了请求（4xx、报错点名该工具、
/// 且带"不支持/未知/无效"类措辞）。
pub(crate) fn is_image_generation_tool_rejection(error: &ProxyError) -> bool {
    let ProxyError::UpstreamError { status, body } = error else {
        return false;
    };
    if !matches!(*status, 400 | 403 | 404 | 422) {
        return false;
    }
    let Some(body) = body.as_deref() else {
        return false;
    };
    let body = body.to_ascii_lowercase();
    body.contains(IMAGE_GENERATION_TOOL_TYPE)
        && REJECTION_HINTS.iter().any(|hint| body.contains(hint))
}

fn remembered_lines() -> &'static Mutex<HashSet<String>> {
    static LINES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    LINES.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 线路 id + 配置摘要：用户改了线路地址或配置后，记忆自动失效，重新探测。
fn line_key(provider: &Provider) -> String {
    let settings = super::json_canonical::canonical_json_string(&provider.settings_config);
    format!(
        "{}:{}",
        provider.id,
        super::json_canonical::short_sha256_hex(settings.as_bytes())
    )
}

pub(crate) fn remember_line_rejects_image_generation(provider: &Provider) {
    if let Ok(mut lines) = remembered_lines().lock() {
        lines.insert(line_key(provider));
    }
}

pub(crate) fn line_rejects_image_generation(provider: &Provider) -> bool {
    remembered_lines()
        .lock()
        .is_ok_and(|lines| lines.contains(&line_key(provider)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_tools_additional_tools_and_pointing_tool_choice() {
        let mut body = json!({
            "model": "gpt-5.5",
            "input": [
                {"type": "message", "role": "user", "content": "hi"},
                {"type": "additional_tools", "tools": [{"type": "image_generation"}, {"type": "function", "name": "mcp_x"}]}
            ],
            "tools": [
                {"type": "function", "name": "exec"},
                {"type": "image_generation", "output_format": "png"}
            ],
            "tool_choice": {"type": "image_generation"}
        });
        assert!(strip_image_generation_tool(&mut body));
        assert_eq!(body["tools"], json!([{"type": "function", "name": "exec"}]));
        assert_eq!(
            body["input"][1]["tools"],
            json!([{"type": "function", "name": "mcp_x"}])
        );
        assert!(body.get("tool_choice").is_none(), "{body}");

        // 只剩生图工具：tools 与 tool_choice 一起去掉。
        let mut only = json!({"tools": [{"type": "image_generation"}], "tool_choice": "required"});
        assert!(strip_image_generation_tool(&mut only));
        assert!(only.get("tools").is_none() && only.get("tool_choice").is_none());
    }

    #[test]
    fn strip_keeps_allowed_tools_choice_consistent_and_leaves_other_bodies_alone() {
        let mut body = json!({
            "tools": [{"type": "function", "name": "exec"}, {"type": "image_generation"}],
            "tool_choice": {"type": "allowed_tools", "mode": "auto", "tools": [{"type": "image_generation"}, {"type": "function", "name": "exec"}]}
        });
        assert!(strip_image_generation_tool(&mut body));
        assert_eq!(
            body["tool_choice"]["tools"],
            json!([{"type": "function", "name": "exec"}])
        );
        for original in [
            json!({"tools": [{"type": "function", "name": "exec"}], "tool_choice": "auto"}),
            json!(null),
            json!({"input": "hi"}),
        ] {
            let mut untouched = original.clone();
            assert!(!strip_image_generation_tool(&mut untouched));
            assert_eq!(untouched, original);
        }
    }

    #[test]
    fn rejection_requires_4xx_tool_name_and_rejection_wording() {
        let upstream = |status: u16, body: &str| ProxyError::UpstreamError {
            status,
            body: Some(body.to_string()),
        };
        for error in [
            upstream(
                400,
                r#"{"error":{"message":"Tool type 'image_generation' is not supported","type":"invalid_request_error"}}"#,
            ),
            upstream(
                403,
                r#"{"error":{"message":"Unknown tool: image_generation"}}"#,
            ),
            upstream(422, "image_generation 工具不支持"),
        ] {
            assert!(is_image_generation_tool_rejection(&error), "{error}");
        }
        for error in [
            // 未点名该工具。
            upstream(
                400,
                r#"{"error":{"message":"Unsupported parameter: tools"}}"#,
            ),
            // 点名了但不是"拒收"措辞（生图业务错误）。
            upstream(
                400,
                r#"{"error":{"message":"image_generation quota exceeded"}}"#,
            ),
            // 非 4xx / 认证类错误。
            upstream(500, "image_generation not supported"),
            upstream(401, "image_generation not supported"),
            ProxyError::UpstreamError {
                status: 400,
                body: None,
            },
            ProxyError::Timeout("image_generation not supported".to_string()),
        ] {
            assert!(!is_image_generation_tool_rejection(&error), "{error}");
        }
    }

    #[test]
    fn remembered_line_is_keyed_by_id_and_settings() {
        let mut provider = Provider::with_id(
            "imggen-rectifier-test-line".to_string(),
            "Relay".to_string(),
            json!({"base_url": "https://relay.example/v1"}),
            None,
        );
        assert!(!line_rejects_image_generation(&provider));
        remember_line_rejects_image_generation(&provider);
        assert!(line_rejects_image_generation(&provider));

        // 用户改了线路配置：重新探测，不沿用旧记忆。
        provider.settings_config = json!({"base_url": "https://other.example/v1"});
        assert!(!line_rejects_image_generation(&provider));
    }
}
