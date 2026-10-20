use crate::proxy::error::ProxyError;
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

/// The non-empty `extra_content` object of a Chat tool call or a Responses
/// call item. Gemini's OpenAI-compatible endpoint puts the call's thought
/// signature there (`extra_content.google.thought_signature`) and rejects the
/// next turn with "Function call is missing a thought_signature" unless it is
/// sent back unchanged.
// Adapted from farion1231/cc-switch f2906db6
pub(crate) fn tool_call_extra_content(source: &Value) -> Option<&Value> {
    source
        .get("extra_content")
        .filter(|value| value.as_object().is_some_and(|object| !object.is_empty()))
}

/// Copy a non-empty `extra_content` from `source` to `target` (pass-through
/// only; the content is never interpreted).
pub(crate) fn copy_tool_call_extra_content(target: &mut Value, source: &Value) -> bool {
    let Some(extra) = tool_call_extra_content(source) else {
        return false;
    };
    let Some(object) = target.as_object_mut() else {
        return false;
    };
    object.insert("extra_content".to_string(), extra.clone());
    true
}

/// Placeholder Gemini documents for skipping thought-signature validation.
/// It can degrade the model's reasoning, so it is only a last resort.
const GEMINI_SKIP_THOUGHT_SIGNATURE: &str = "skip_thought_signature_validator";

/// Fill the Gemini skip placeholder where a real thought signature is gone.
///
/// Signatures come back through `CodexChatHistoryStore`, which lives in
/// memory: after a restart in the middle of a tool loop they are lost. Gemini
/// 3+ validates only the current turn (after the last user message), and only
/// the first tool call of each assistant step there, so only those calls get
/// the placeholder; parallel calls after it and real signatures stay as they
/// are. Other models are left byte-identical. Returns the number filled.
// Adapted from farion1231/cc-switch 5089eb69
pub(crate) fn fill_gemini_thought_signature_fallback(chat_body: &mut Value) -> usize {
    if !chat_body
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(requires_gemini_thought_signature)
    {
        return 0;
    }
    let Some(messages) = chat_body.get_mut("messages").and_then(Value::as_array_mut) else {
        return 0;
    };
    let turn_start = messages
        .iter()
        .rposition(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .map_or(0, |index| index + 1);
    let mut filled = 0;
    for message in &mut messages[turn_start..] {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(first_call) = message
            .get_mut("tool_calls")
            .and_then(Value::as_array_mut)
            .and_then(|calls| calls.first_mut())
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        let has_signature = first_call
            .get("extra_content")
            .and_then(|extra| extra.pointer("/google/thought_signature"))
            .and_then(Value::as_str)
            .is_some_and(|signature| !signature.is_empty());
        if has_signature {
            continue;
        }
        let extra = first_call
            .entry("extra_content")
            .or_insert_with(|| json!({}));
        if !extra.is_object() {
            *extra = json!({});
        }
        let Some(extra) = extra.as_object_mut() else {
            continue;
        };
        let google = extra.entry("google").or_insert_with(|| json!({}));
        if !google.is_object() {
            *google = json!({});
        }
        google["thought_signature"] = json!(GEMINI_SKIP_THOUGHT_SIGNATURE);
        filled += 1;
    }
    filled
}

/// Gemini 3 and later (a relay prefix such as `google/` is allowed) enforce
/// tool-call thought signatures.
fn requires_gemini_thought_signature(model: &str) -> bool {
    let name = model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .to_ascii_lowercase();
    let Some(version) = name.strip_prefix("gemini-") else {
        return false;
    };
    version
        .split(|c: char| !c.is_ascii_digit())
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 3)
}

/// Leads the text of a tool result that has no matching tool call once it is
/// sent as ordinary user content (Chat bridge, Anthropic bridge, xAI native
/// Responses). Such results are typically the Codex desktop app's delegation
/// receipt (`call_id: null`) or an extra parallel result; strict upstreams
/// reject them as tool results, and dropping them loses the delegated text.
pub(crate) const ORPHAN_TOOL_OUTPUT_MARKER: &str = "[tool_result without a matching tool_call]";

pub(crate) const CODEX_REMOTE_COMPACTION_TRIGGER_UNSUPPORTED: &str = "当前线路经 Chat/Anthropic 协议转换，无法执行远程上下文压缩（只有官方线路或原生 Responses 线路支持），本次请求未发送。请切回原线路后重试，或新建会话。";
pub(crate) const CODEX_REMOTE_COMPACTION_CHECKPOINT_UNSUPPORTED: &str = "此会话包含远程压缩检查点（由官方线路或原生 Responses 线路生成），当前线路经 Chat/Anthropic 协议转换后无法读取，继续会丢失压缩前的全部上下文，因此本次请求未发送。请切回原线路继续此会话，或新建会话。";

/// Refuse a Responses request that carries Codex remote-compaction items before
/// it is converted for a Chat Completions or Anthropic Messages upstream.
///
/// Remote compaction leaves a thread with its user messages plus one encrypted
/// checkpoint (`compaction`, legacy alias `compaction_summary`, or a
/// `context_compaction` with `encrypted_content`). Only the Responses backend
/// that wrote it can read it, and the bridges used to drop it without a word,
/// so the model silently lost all earlier work. A `compaction_trigger` asks for
/// exactly one `compaction` output item, which no bridge can produce. Codex's
/// local compaction, used on converted lines, writes its summary back as an
/// ordinary user message, so those threads never carry these items.
///
/// `InvalidRequest` (HTTP 400, non-retryable) keeps the refusal out of the
/// line's health and circuit breaker: the request is at fault, not the line,
/// and Codex replays the same history on every turn.
pub(crate) fn reject_codex_remote_compaction_items(body: &Value) -> Result<(), ProxyError> {
    let items = match body.get("input") {
        Some(Value::Array(items)) => items.as_slice(),
        Some(item) if item.is_object() => std::slice::from_ref(item),
        _ => return Ok(()),
    };

    let mut has_trigger = false;
    let mut has_checkpoint = false;
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("compaction_trigger") => has_trigger = true,
            Some("compaction" | "compaction_summary") => has_checkpoint = true,
            // Without ciphertext the item is only a marker; dropping it loses nothing.
            Some("context_compaction") => {
                has_checkpoint |= item
                    .get("encrypted_content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| !content.trim().is_empty());
            }
            _ => {}
        }
    }

    // A trigger is reported first: the failing request is itself a compaction.
    if has_trigger {
        return Err(ProxyError::InvalidRequest(
            CODEX_REMOTE_COMPACTION_TRIGGER_UNSUPPORTED.to_string(),
        ));
    }
    if has_checkpoint {
        return Err(ProxyError::InvalidRequest(
            CODEX_REMOTE_COMPACTION_CHECKPOINT_UNSUPPORTED.to_string(),
        ));
    }
    Ok(())
}

pub(crate) const CODEX_AGENT_MESSAGE_ENCRYPTED_UNSUPPORTED: &str = "此会话包含加密的多代理消息内容，当前线路经 Chat/Anthropic 协议转换后无法读取，继续会让对方代理收不到消息正文，因此本次请求未发送。请切回官方线路或原生 Responses 线路继续此会话，或新建会话。";

/// The message item with its multi-agent payload turned into text, for the
/// Chat and Anthropic bridges.
///
/// Codex multi-agent v2 sends an `agent_message` whose content is an
/// `input_text` header ending in `Payload:` followed by an
/// `encrypted_content` part. With a third-party model the payload is in fact
/// the plain task text; the bridges dropped the unknown part, so the other
/// agent got only the header and no task. Within that confirmed shape a
/// plaintext payload becomes an `input_text` part in place. An
/// `agent_message` that cannot be read that way (ciphertext, no header,
/// object-shaped content) is refused before sending: `InvalidRequest`
/// (HTTP 400, outside line health), as for remote compaction items, and the
/// payload is never echoed. A `reasoning` item's `encrypted_content` field is
/// not a content part and is not affected.
///
/// Adapted from BigPizzaV3/CodexPlusPlus dbd6b30
pub(crate) fn codex_item_with_agent_payload_text(
    item: &Value,
) -> Result<std::borrow::Cow<'_, Value>, ProxyError> {
    fn is_encrypted_part(part: &Value) -> bool {
        part.get("type").and_then(Value::as_str) == Some("encrypted_content")
    }
    let unsupported =
        || ProxyError::InvalidRequest(CODEX_AGENT_MESSAGE_ENCRYPTED_UNSUPPORTED.to_string());

    // Only multi-agent messages carry a payload worth reading; other items
    // keep their previous handling so replayed history is not newly refused.
    if item.get("type").and_then(Value::as_str) != Some("agent_message") {
        return Ok(std::borrow::Cow::Borrowed(item));
    }
    let parts = match item.get("content") {
        Some(Value::Array(parts)) if parts.iter().any(is_encrypted_part) => parts,
        Some(content @ Value::Object(_)) if is_encrypted_part(content) => {
            return Err(unsupported());
        }
        _ => return Ok(std::borrow::Cow::Borrowed(item)),
    };
    let has_payload_header = parts.iter().any(|part| {
        part.get("type").and_then(Value::as_str) == Some("input_text")
            && part
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.trim_end().ends_with("Payload:"))
    });
    if !has_payload_header {
        return Err(unsupported());
    }

    let mut resolved = Vec::with_capacity(parts.len());
    for part in parts {
        if !is_encrypted_part(part) {
            resolved.push(part.clone());
            continue;
        }
        let payload = part
            .get("encrypted_content")
            .or_else(|| part.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if payload.trim().is_empty() || encrypted_content_value_is_opaque(payload) {
            return Err(unsupported());
        }
        resolved.push(json!({"type": "input_text", "text": payload}));
    }
    let mut item = item.clone();
    item["content"] = Value::Array(resolved);
    Ok(std::borrow::Cow::Owned(item))
}

/// Whether an `encrypted_content` payload looks like real ciphertext rather
/// than plain text: it carries control characters other than tab/newline, or
/// it is one unbroken base64/base64url token of 32+ characters that decodes
/// to bytes of which under 60% are printable ASCII (ciphertext decodes to
/// near-uniform bytes, about 37% printable; base64 of text stays text).
fn encrypted_content_value_is_opaque(value: &str) -> bool {
    use base64::Engine as _;

    if value
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))
    {
        return true;
    }
    let body = value.trim_end_matches('=');
    if body.len() < 32
        || !body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'-' | b'_'))
    {
        return false;
    }
    // Map the base64url alphabet one character at a time; a `str::replace`
    // with a two-character replacement would change the length.
    let mut canonical: String = body
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    while canonical.len() % 4 != 0 {
        canonical.push('=');
    }
    let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(&canonical) else {
        return false;
    };
    if decoded.is_empty() {
        return false;
    }
    let printable = decoded
        .iter()
        .filter(|b| matches!(**b, 0x20..=0x7e | b'\t' | b'\n' | b'\r'))
        .count();
    printable * 5 < decoded.len() * 3
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

    #[test]
    fn tool_call_extra_content_copies_only_non_empty_objects() {
        let signature = json!({"google": {"thought_signature": "sig-abc"}});
        let mut target = json!({"id": "call_1"});
        assert!(copy_tool_call_extra_content(
            &mut target,
            &json!({"extra_content": signature})
        ));
        assert_eq!(target["extra_content"], signature);

        for source in [
            json!({}),
            json!({"extra_content": {}}),
            json!({"extra_content": null}),
            json!({"extra_content": "sig"}),
        ] {
            let mut target = json!({"id": "call_1"});
            assert!(!copy_tool_call_extra_content(&mut target, &source));
            assert!(target.get("extra_content").is_none(), "{source}");
        }
    }

    #[test]
    fn encrypted_content_opacity_heuristic() {
        // base64url ciphertext with `_`: must be decoded with a per-character
        // alphabet map, or it would pass as plaintext.
        assert!(encrypted_content_value_is_opaque(
            "BU6X4ClyuwRNlt8ocboDTJXeJ3C5AkuU3SZvuAFKk9wlbrcASZLbJG22_0iR2iNs"
        ));
        assert!(encrypted_content_value_is_opaque("task\u{0}payload"));
        for plaintext in [
            "请审查 a.rs 并给出结论",
            "Review a.rs and report back.\n\nThanks",
            // base64 of ASCII text decodes back to printable text.
            "cGxlYXNlX3Jldmlld19hLnJzX2FuZF9yZXBvcnRfYmFja19ub3c=",
            "short_token",
        ] {
            assert!(!encrypted_content_value_is_opaque(plaintext), "{plaintext}");
        }
    }

    fn assistant_call(id: &str, extra: Option<Value>) -> Value {
        let mut call = json!({
            "id": id,
            "type": "function",
            "function": {"name": "exec_command", "arguments": "{}"}
        });
        if let Some(extra) = extra {
            call["extra_content"] = extra;
        }
        call
    }

    #[test]
    fn gemini_fallback_fills_first_call_of_each_current_turn_step() {
        let signed = json!({"google": {"thought_signature": "sig-real"}});
        let mut body = json!({
            "model": "gemini-3-pro-preview",
            "messages": [
                {"role": "user", "content": "old turn"},
                {"role": "assistant", "tool_calls": [assistant_call("call_old", None)]},
                {"role": "tool", "tool_call_id": "call_old", "content": "x"},
                {"role": "user", "content": "current turn"},
                {"role": "assistant", "tool_calls": [
                    assistant_call("call_1", None),
                    assistant_call("call_2", None)
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "a"},
                {"role": "tool", "tool_call_id": "call_2", "content": "b"},
                {"role": "assistant", "tool_calls": [assistant_call("call_3", Some(signed.clone()))]},
                {"role": "tool", "tool_call_id": "call_3", "content": "c"},
                {"role": "assistant", "tool_calls": [
                    assistant_call("call_4", Some(json!({"other": true})))
                ]},
                {"role": "tool", "tool_call_id": "call_4", "content": "d"}
            ]
        });

        assert_eq!(fill_gemini_thought_signature_fallback(&mut body), 2);
        let messages = body["messages"].as_array().unwrap();
        // The previous turn is not validated and stays as it was.
        assert!(messages[1]["tool_calls"][0].get("extra_content").is_none());
        assert_eq!(
            messages[4]["tool_calls"][0]["extra_content"]["google"]["thought_signature"],
            GEMINI_SKIP_THOUGHT_SIGNATURE
        );
        // Parallel calls after the first one are left alone.
        assert!(messages[4]["tool_calls"][1].get("extra_content").is_none());
        // A real signature is never overwritten.
        assert_eq!(messages[7]["tool_calls"][0]["extra_content"], signed);
        // Other extra_content keys are kept next to the placeholder.
        assert_eq!(messages[9]["tool_calls"][0]["extra_content"]["other"], true);
        assert_eq!(
            messages[9]["tool_calls"][0]["extra_content"]["google"]["thought_signature"],
            GEMINI_SKIP_THOUGHT_SIGNATURE
        );
    }

    #[test]
    fn gemini_fallback_leaves_other_models_unchanged() {
        for model in [
            "gemini-2.5-pro",
            "gpt-5.5",
            "glm-5.3",
            "gemma-4-27b",
            "gemini-pro",
        ] {
            let mut body = json!({
                "model": model,
                "messages": [
                    {"role": "user", "content": "hi"},
                    {"role": "assistant", "tool_calls": [assistant_call("call_1", None)]}
                ]
            });
            let before = body.clone();
            assert_eq!(
                fill_gemini_thought_signature_fallback(&mut body),
                0,
                "{model}"
            );
            assert_eq!(body, before, "{model}");
        }
        assert!(requires_gemini_thought_signature(
            "google/gemini-3-pro-preview"
        ));
        assert!(requires_gemini_thought_signature("Gemini-4-Argon"));
        assert!(requires_gemini_thought_signature("gemini-10-flash"));
        assert!(!requires_gemini_thought_signature("gemini-2.5-flash"));
    }
}
