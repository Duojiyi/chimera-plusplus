use serde_json::{json, Map, Value};

// 穷举上游可能的 reasoning 回传字段，优先级：reasoning_content > reasoning(字符串/对象) > reasoning_details。
// 不依赖 provider meta 的 outputFormat 声明，因此对各家 Chat 兼容接口都能兜底提取。
pub(crate) fn extract_reasoning_field_text(value: &Value) -> Option<String> {
    for key in ["reasoning_content", "reasoning"] {
        if let Some(text) = value.get(key).and_then(|v| v.as_str()) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }

    if let Some(reasoning) = value.get("reasoning") {
        for key in ["content", "text", "summary"] {
            if let Some(text) = reasoning.get(key).and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }

    if let Some(details) = value.get("reasoning_details") {
        if let Some(text) = extract_reasoning_details_text(details) {
            return Some(text);
        }
    }

    None
}

fn extract_reasoning_details_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => (!text.is_empty()).then(|| text.to_string()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(extract_reasoning_detail_part_text)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            (!text.is_empty()).then_some(text)
        }
        Value::Object(_) => extract_reasoning_detail_part_text(value),
        _ => None,
    }
}

fn extract_reasoning_detail_part_text(value: &Value) -> Option<String> {
    for key in ["text", "content", "summary"] {
        if let Some(text) = value.get(key).and_then(|v| v.as_str()) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }

    if let Some(parts) = value.get("parts").and_then(|v| v.as_array()) {
        let text = parts
            .iter()
            .filter_map(extract_reasoning_detail_part_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        return (!text.is_empty()).then_some(text);
    }

    None
}

pub(crate) fn extract_reasoning_summary_text(value: &Value) -> Option<String> {
    for key in ["reasoning_content", "content", "text"] {
        if let Some(text) = value.get(key).and_then(|v| v.as_str()) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }

    let summary = value.get("summary")?;
    if let Some(text) = summary.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }

    let parts = summary.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| {
            part.get("text")
                .and_then(|v| v.as_str())
                .or_else(|| part.get("content").and_then(|v| v.as_str()))
                .or_else(|| part.as_str())
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    (!text.is_empty()).then_some(text)
}

pub(crate) fn append_reasoning_content(message: &mut Map<String, Value>, reasoning: &str) -> bool {
    let reasoning = reasoning.trim();
    if reasoning.is_empty() {
        return false;
    }

    match message.get_mut("reasoning_content") {
        Some(Value::String(existing)) if !existing.is_empty() => {
            existing.push_str("\n\n");
            existing.push_str(reasoning);
        }
        _ => {
            message.insert(
                "reasoning_content".to_string(),
                Value::String(reasoning.to_string()),
            );
        }
    }
    true
}

pub(crate) fn attach_reasoning_content_field(item: &mut Value, reasoning: &str) -> bool {
    let reasoning = reasoning.trim();
    if reasoning.is_empty() {
        return false;
    }

    if let Some(obj) = item.as_object_mut() {
        obj.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning.to_string()),
        );
        return true;
    }

    false
}

pub(crate) fn attach_optional_reasoning_content_field(
    item: &mut Value,
    reasoning: Option<&str>,
) -> bool {
    let Some(reasoning) = reasoning else {
        return false;
    };
    attach_reasoning_content_field(item, reasoning)
}

pub(crate) fn response_function_call_item(
    item_id: &str,
    status: &str,
    call_id: &str,
    name: &str,
    arguments: &str,
    reasoning: Option<&str>,
) -> Value {
    let mut item = json!({
        "id": item_id,
        "type": "function_call",
        "status": status,
        "call_id": call_id,
        "name": name,
        "arguments": arguments
    });
    attach_optional_reasoning_content_field(&mut item, reasoning);
    item
}

pub(crate) fn response_function_call_item_with_namespace(
    item_id: &str,
    status: &str,
    call_id: &str,
    name: &str,
    namespace: Option<&str>,
    arguments: &str,
    reasoning: Option<&str>,
) -> Value {
    let mut item =
        response_function_call_item(item_id, status, call_id, name, arguments, reasoning);
    if let Some(namespace) = namespace.filter(|value| !value.is_empty()) {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("namespace".to_string(), json!(namespace));
        }
    }
    item
}

pub(crate) fn response_item_call_id(item: &Value) -> Option<String> {
    item.get("call_id")
        .or_else(|| item.get("id"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn is_empty_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(value) => value.trim().is_empty(),
        Value::Array(value) => value.is_empty(),
        Value::Object(value) => value.is_empty(),
        _ => false,
    }
}

/// Exact, unescaped tags outside backtick code are protocol delimiters. Bare
/// literal tags are inherently ambiguous; callers cannot infer author intent.
#[derive(Debug, Default)]
pub(crate) struct InlineThinkParser {
    buffer: String,
    close_tag: Option<&'static str>,
    code_ticks: usize,
    escaped: bool,
    trim_start: bool,
    seen_text: bool,
    leading_space: String,
    reasoning_space: String,
}

/// (is_reasoning, text), in arrival order.
pub(crate) type InlineThinkPart = (bool, String);

impl InlineThinkParser {
    pub(crate) fn push(&mut self, text: &str) -> Vec<InlineThinkPart> {
        self.buffer.push_str(text);
        self.drain(false)
    }

    pub(crate) fn finish(&mut self) -> Vec<InlineThinkPart> {
        let mut parts = self.drain(true);
        if !self.leading_space.is_empty() {
            parts.push((false, std::mem::take(&mut self.leading_space)));
        }
        // A boundary ends even an unclosed block; never reclassify it as text.
        *self = Self::default();
        parts
    }

    pub(crate) fn has_pending(&self) -> bool {
        !self.buffer.is_empty()
            || !self.reasoning_space.is_empty()
            || !self.leading_space.is_empty()
    }

    fn drain(&mut self, finish: bool) -> Vec<InlineThinkPart> {
        let mut parts: Vec<InlineThinkPart> = Vec::new();
        let mut offset = 0;
        while offset < self.buffer.len() {
            let rest = &self.buffer[offset..];
            let reasoning = self.close_tag.is_some();
            if !self.escaped && self.code_ticks == 0 {
                let tags: &[(&'static str, &'static str)] = if let Some(close) = self.close_tag {
                    &[(close, "")]
                } else {
                    &[("<think>", "</think>"), ("<thinking>", "</thinking>")]
                };
                if let Some((tag, close)) = tags.iter().find(|(tag, _)| rest.starts_with(*tag)) {
                    offset += tag.len();
                    self.close_tag = if reasoning { None } else { Some(*close) };
                    self.reasoning_space.clear();
                    if !self.seen_text {
                        self.leading_space.clear();
                    }
                    self.trim_start = !reasoning || !self.seen_text;
                    continue;
                }
                if !finish && tags.iter().any(|(tag, _)| tag.starts_with(rest)) {
                    break;
                }
            }
            let ch = rest.chars().next().unwrap();
            let mut len = ch.len_utf8();
            // Consume entire backtick runs so both inline code and fenced code
            // remain literal, including when a run straddles chunks.
            if !reasoning && !self.escaped && ch == '`' {
                len = rest.bytes().take_while(|b| *b == b'`').count();
                if !finish && len == rest.len() {
                    break;
                }
                if self.code_ticks == 0 {
                    self.code_ticks = len;
                } else if self.code_ticks == len {
                    self.code_ticks = 0;
                }
            }
            self.escaped = !self.escaped && ch == '\\';
            let text = &rest[..len];
            offset += len;
            if self.trim_start && ch.is_whitespace() {
                continue;
            }
            self.trim_start = false;
            if !reasoning && !self.seen_text && ch.is_whitespace() {
                self.leading_space.push_str(text);
                continue;
            }
            if !reasoning {
                self.seen_text = true;
            }
            if reasoning && ch.is_whitespace() {
                self.reasoning_space.push_str(text);
                continue;
            }
            if parts.last().map(|p| p.0) != Some(reasoning) {
                parts.push((reasoning, String::new()));
            }
            let output = &mut parts.last_mut().unwrap().1;
            if reasoning {
                output.push_str(&self.reasoning_space);
                self.reasoning_space.clear();
            }
            if !reasoning {
                output.push_str(&self.leading_space);
                self.leading_space.clear();
            }
            output.push_str(text);
        }
        self.buffer.drain(..offset);
        parts
    }
}

pub(crate) fn split_inline_think(text: &str) -> Vec<InlineThinkPart> {
    let mut parser = InlineThinkParser::default();
    let mut parts = parser.push(text);
    parts.extend(parser.finish());
    parts
}

/// Normalize only assistant response content, never requests, refusals or tools.
/// Adjacent array text parts form one logical stream.
pub(crate) fn normalize_inline_think(message: &Value) -> Value {
    let mut message = message.clone();
    let Some(content) = message.get("content") else {
        return message;
    };
    let mut parser = InlineThinkParser::default();
    let mut output = Vec::new();
    let mut reasoning = String::new();
    fn append(parts: Vec<InlineThinkPart>, output: &mut Vec<Value>, reasoning: &mut String) {
        for (is_reasoning, text) in parts {
            if is_reasoning {
                reasoning.push_str(&text);
            } else if let Some(Value::String(existing)) = output
                .last_mut()
                .filter(|part| part["type"] == "text")
                .and_then(|part| part.get_mut("text"))
            {
                existing.push_str(&text);
            } else {
                output.push(json!({"type": "text", "text": text}));
            }
        }
    }
    if let Some(text) = content.as_str() {
        append(split_inline_think(text), &mut output, &mut reasoning);
    } else if let Some(parts) = content.as_array() {
        for part in parts {
            if matches!(
                part.get("type").and_then(Value::as_str),
                Some("text" | "output_text")
            ) {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    append(parser.push(text), &mut output, &mut reasoning);
                }
            } else {
                append(parser.finish(), &mut output, &mut reasoning);
                output.push(part.clone());
            }
        }
        append(parser.finish(), &mut output, &mut reasoning);
    } else {
        return message;
    }
    let explicit = extract_reasoning_field_text(&message);
    let obj = message.as_object_mut().unwrap();
    obj.insert("content".into(), Value::Array(output));
    if let Some(explicit) = explicit {
        obj.insert("reasoning_content".into(), Value::String(explicit));
    }
    append_reasoning_content(obj, &reasoning);
    message
}

#[cfg(test)]
mod inline_think_tests {
    use super::*;

    fn joined(parts: Vec<InlineThinkPart>) -> (String, String) {
        let (mut reasoning, mut text) = (String::new(), String::new());
        for (is_reasoning, value) in parts {
            if is_reasoning {
                reasoning.push_str(&value);
            } else {
                text.push_str(&value);
            }
        }
        (reasoning, text)
    }

    #[test]
    fn inline_think_chunk_boundaries_match_whole_input() {
        for (input, reasoning, text) in [
            (" \n<thinking>reason</thinking>\nanswer", "reason", "answer"),
            (" \nnormal text", "", " \nnormal text"),
            (" \n", "", " \n"),
            ("<think>\nreason\n</think>\n\nanswer", "reason", "answer"),
            (
                "before <thinking>秘密</thinking> after<think>more</think>!",
                "秘密more",
                "before  after!",
            ),
            ("<thinking>未闭合 </thi", "未闭合 </thi", ""),
            ("before<think>open   ", "open", "before"),
            ("a<thinking>x</think>y</thinking>b", "x</think>y", "ab"),
            ("plain <thi", "", "plain <thi"),
            ("<think></think>ok", "", "ok"),
            ("普通文本 café", "", "普通文本 café"),
        ] {
            let expected = (reasoning.to_string(), text.to_string());
            assert_eq!(joined(split_inline_think(input)), expected, "{input}");
            for (at, _) in input
                .char_indices()
                .chain(std::iter::once((input.len(), '\0')))
            {
                let mut parser = InlineThinkParser::default();
                let mut parts = parser.push(&input[..at]);
                parts.extend(parser.push(&input[at..]));
                parts.extend(parser.finish());
                assert_eq!(joined(parts), expected, "{input}, split {at}");
            }
            let mut parser = InlineThinkParser::default();
            let mut parts = Vec::new();
            for ch in input.chars() {
                parts.extend(parser.push(&ch.to_string()));
            }
            parts.extend(parser.finish());
            assert_eq!(joined(parts), expected, "one character per chunk: {input}");
        }
    }

    #[test]
    fn inline_think_literal_tags_remain_text() {
        for input in [
            "Use `<think>example</think>` and `<thinking>`.",
            "```xml\n<thinking>example</thinking>\n```",
            "``a ` <think>example</think>``",
            r"Escaped \<think>example</think>",
            "<thinker>ordinary</thinker> <think attr=\"x\"> <THINK> &lt;think&gt; </think>",
        ] {
            let mut parser = InlineThinkParser::default();
            let mut parts = Vec::new();
            for ch in input.chars() {
                parts.extend(parser.push(&ch.to_string()));
            }
            parts.extend(parser.finish());
            assert_eq!(joined(parts), (String::new(), input.to_string()));
        }
    }

    #[test]
    fn inline_think_streams_before_close_and_flushes_partial_opener() {
        let mut parser = InlineThinkParser::default();
        assert_eq!(
            joined(parser.push("<thinking>long running reasoning")),
            ("long running reasoning".into(), "".into())
        );
        assert_eq!(joined(parser.finish()), ("".into(), "".into()));
        assert!(parser.push("<thi").is_empty());
        assert_eq!(joined(parser.finish()), ("".into(), "<thi".into()));
    }

    #[test]
    fn inline_think_array_parts_explicit_reasoning_and_refusal() {
        let result = normalize_inline_think(&json!({
            "reasoning_content": "explicit",
            "content": [
                {"type": "text", "text": "before<thin"},
                {"type": "output_text", "text": "king>hidden</thinking>after"},
                {"type": "refusal", "refusal": "<think>literal refusal"}
            ],
            "tool_calls": [{"function": {"arguments": "<think>literal tool"}}]
        }));
        assert_eq!(result["reasoning_content"], "explicit\n\nhidden");
        assert_eq!(result["content"][0]["text"], "beforeafter");
        assert_eq!(result["content"][1]["refusal"], "<think>literal refusal");
        assert_eq!(
            result["tool_calls"][0]["function"]["arguments"],
            "<think>literal tool"
        );
    }
}
