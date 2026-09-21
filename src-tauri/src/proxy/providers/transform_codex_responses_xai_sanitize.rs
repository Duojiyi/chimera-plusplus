//! xAI (Grok) `Responses` request field sanitization for native Responses
//! upstreams.
//!
//! Codex 0.142+ sends `wire_api="responses"` requests carrying a handful of
//! OpenAI-backend-private fields and tool carriers that xAI's strict
//! `api.x.ai/v1/responses` serde parser rejects (HTTP 400/422). cc-switch's
//! Chat/Anthropic transforms already drop these on the way through, but the
//! *native* Responses passthrough forwards the body verbatim, so we scrub them
//! here.
//!
//! This is a faithful port of sub2api's `patchGrokResponsesBody`
//! (`backend/internal/service/openai_gateway_grok.go`), the production Go
//! gateway that routes Codex → Grok subscriptions. Every transform is a
//! deterministic field removal or structural lift — no semantic rewriting — so
//! the same input always yields the same output and the upstream prompt-cache
//! prefix stays stable across requests. Gated on the xAI OAuth path only (see
//! [`super::codex::provider_needs_responses_namespace_flatten`]), so no other
//! provider is ever touched.
//!
//! Run this *after* namespace flattening: by then Codex's `namespace` tools are
//! already lifted to top-level `function` tools, so the tool-type whitelist
//! below keeps them instead of dropping them.

use std::collections::{HashMap, HashSet};

use super::transform_codex_responses_namespace::{restore_sse_event_namespaces, NamespacedName};
use crate::proxy::sse::{append_utf8_safe, strip_sse_field, take_sse_block};
use bytes::Bytes;
use futures::stream::{Stream, StreamExt};
use serde_json::{json, Map, Number, Value};

/// Codex plugin-private fields removed recursively at any nesting depth.
const RECURSIVE_UNSUPPORTED_FIELDS: &[&str] = &["external_web_access"];

/// Top-level request fields xAI rejects regardless of model.
const TOP_LEVEL_UNSUPPORTED_FIELDS: &[&str] = &["prompt_cache_retention", "safety_identifier"];

/// Top-level sampling fields rejected specifically by grok-4.5.
const GROK_45_UNSUPPORTED_FIELDS: &[&str] = &[
    "presence_penalty",
    "presencePenalty",
    "frequency_penalty",
    "frequencyPenalty",
    "stop",
];

/// Tool `type` values xAI's Responses schema accepts. Sourced from xAI's own
/// serde error enumeration (which is more complete than sub2api's hand-copied
/// list — it includes `image_generation`). Any other `type` is a Codex/OpenAI
/// private carrier (`tool_search`, a stray `namespace`, `custom`, …) that the
/// strict parser would reject, so it is dropped.
const XAI_SUPPORTED_TOOL_TYPES: &[&str] = &[
    "function",
    "web_search",
    "x_search",
    "image_generation",
    "collections_search",
    "file_search",
    "code_execution",
    "code_interpreter",
    "mcp",
    "shell",
];

/// Strip xAI-unsupported fields and tools from a native Codex Responses request
/// body in place. Returns whether anything changed. Deterministic and
/// idempotent: running it twice on the same body changes nothing the second
/// time.
pub(crate) fn sanitize_xai_responses_request(body: &mut Value) -> bool {
    if !body.is_object() {
        return false;
    }

    let mut changed = false;

    // 1. Top-level fields xAI rejects for every model.
    for field in TOP_LEVEL_UNSUPPORTED_FIELDS {
        changed |= remove_top_level_field(body, field);
    }

    // 2. grok-4.5 additionally rejects these sampling knobs.
    if request_targets_grok_45(body) {
        for field in GROK_45_UNSUPPORTED_FIELDS {
            changed |= remove_top_level_field(body, field);
        }
    }

    // 3. Codex plugin-private flags buried at any depth (e.g. inside tools or
    //    tool parameter schemas).
    for field in RECURSIVE_UNSUPPORTED_FIELDS {
        changed |= remove_field_recursive(body, field);
    }

    // 4. Lift the `additional_tools` input carrier (Responses Lite private
    //    shape) up to top-level `tools` so the supported ones survive.
    changed |= promote_additional_tools(body);

    // 5. Drop `content: null` on reasoning input items — xAI's untagged enum
    //    deserializer refuses a present-but-null content field.
    changed |= strip_null_reasoning_content(body);

    // 6. Whitelist the tool types and clean a now-dangling `tool_choice`.
    changed |= filter_unsupported_tools(body);
    changed |= normalize_xai_function_tool_parameter_schemas(body);
    changed |= rewrite_xai_agent_message_input_items(body);

    changed
}

/// Whether the request's (possibly provider-prefixed) model resolves to
/// grok-4.5. Mirrors sub2api's suffix match: `foo/grok-4.5` counts.
fn xai_function_parameters_need_simplification(params: &Value) -> bool {
    match params {
        Value::Null => true,
        Value::Object(obj) if obj.is_empty() => true,
        Value::Object(obj) => {
            match obj.get("type") {
                None | Some(Value::Null) => return true,
                Some(Value::String(type_name)) if type_name != "object" => return true,
                _ => {}
            }

            for union_key in ["oneOf", "anyOf"] {
                let Some(branches) = obj.get(union_key).and_then(Value::as_array) else {
                    continue;
                };
                if branches.is_empty() {
                    continue;
                }
                if branches
                    .iter()
                    .any(|branch| branch.get("type").and_then(Value::as_str) != Some("object"))
                {
                    return true;
                }
            }

            false
        }
        _ => true,
    }
}

fn flatten_union_branches_to_object(branches: &[Value]) -> Value {
    let object_branches: Vec<&Value> = branches
        .iter()
        .filter(|branch| branch.get("type").and_then(Value::as_str) == Some("object"))
        .collect();

    if object_branches.len() == 1 {
        let mut result = object_branches[0].clone();
        if let Some(obj) = result.as_object_mut() {
            obj.insert("type".to_string(), json!("object"));
            obj.entry("properties".to_string())
                .or_insert_with(|| json!({}));
        }
        return result;
    }

    if !object_branches.is_empty() {
        let mut merged_properties = Map::new();
        let mut merged_required: Option<Vec<Value>> = None;
        for branch in object_branches {
            if let Some(properties) = branch.get("properties").and_then(Value::as_object) {
                for (key, value) in properties {
                    merged_properties
                        .entry(key.clone())
                        .or_insert_with(|| value.clone());
                }
            }
            let branch_required = branch
                .get("required")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            merged_required = Some(match merged_required {
                None => branch_required,
                Some(existing) => existing
                    .into_iter()
                    .filter(|item| branch_required.contains(item))
                    .collect(),
            });
        }

        let mut result = json!({
            "type": "object",
            "properties": Value::Object(merged_properties),
        });
        let merged_required = merged_required.unwrap_or_default();
        if !merged_required.is_empty() {
            result["required"] = Value::Array(merged_required);
        }
        return result;
    }

    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": true
    })
}

fn simplify_xai_function_parameters(params: Option<&Value>) -> Value {
    match params {
        None | Some(Value::Null) => {
            json!({"type": "object", "properties": {}, "additionalProperties": true})
        }
        Some(Value::Object(obj)) if obj.is_empty() => {
            json!({"type": "object", "properties": {}, "additionalProperties": true})
        }
        Some(Value::Object(obj)) => {
            for union_key in ["oneOf", "anyOf"] {
                if let Some(branches) = obj.get(union_key).and_then(Value::as_array) {
                    if branches
                        .iter()
                        .any(|branch| branch.get("type").and_then(Value::as_str) != Some("object"))
                    {
                        return flatten_union_branches_to_object(branches);
                    }
                }
            }

            let mut result = Value::Object(obj.clone());
            if let Some(obj) = result.as_object_mut() {
                match obj.get("type").and_then(Value::as_str) {
                    Some("object") => {}
                    _ => {
                        obj.insert("type".to_string(), json!("object"));
                        obj.entry("properties".to_string())
                            .or_insert_with(|| json!({}));
                    }
                }
            }
            result
        }
        _ => json!({"type": "object", "properties": {}, "additionalProperties": true}),
    }
}

fn function_tool_name(tool: &Value) -> &str {
    tool.get("name")
        .and_then(Value::as_str)
        .or_else(|| {
            tool.get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        })
        .unwrap_or("")
        .trim()
}

fn is_automation_update_tool(name: &str) -> bool {
    name == "codex_app__automation_update"
        || name == "mcp__codex_app__automation_update"
        || name.ends_with("__automation_update")
}

fn rewrite_function_tool_parameters(tool: &mut Value, params: Option<&Value>) -> bool {
    let simplified = simplify_xai_function_parameters(params);
    if params == Some(&simplified) {
        return false;
    }

    if let Some(obj) = tool.as_object_mut() {
        if obj.contains_key("parameters") || params.is_some() {
            obj.insert("parameters".to_string(), simplified);
            return true;
        }
        if let Some(function) = obj.get_mut("function").and_then(Value::as_object_mut) {
            function.insert("parameters".to_string(), simplified);
            return true;
        }
    }

    false
}

fn xai_safe_empty_object_schema() -> Value {
    json!({"type": "object", "properties": {}, "additionalProperties": true})
}

fn normalize_xai_function_tool_parameters(tool: &mut Value) -> bool {
    if tool.get("type").and_then(Value::as_str) != Some("function") {
        return false;
    }

    if is_automation_update_tool(function_tool_name(tool)) {
        let safe = xai_safe_empty_object_schema();
        let needs_rewrite = {
            let current = tool.get("parameters").or_else(|| {
                tool.get("function")
                    .and_then(|function| function.get("parameters"))
            });
            current != Some(&safe)
        };
        let mut changed = needs_rewrite;
        if let Some(obj) = tool.as_object_mut() {
            if needs_rewrite {
                if obj.contains_key("parameters") || obj.get("function").is_none() {
                    obj.insert("parameters".to_string(), safe);
                } else if let Some(function) =
                    obj.get_mut("function").and_then(Value::as_object_mut)
                {
                    function.insert("parameters".to_string(), safe);
                }
            }
            if obj.get("strict") == Some(&json!(true)) {
                obj.insert("strict".to_string(), json!(false));
                changed = true;
            }
            if let Some(function) = obj.get_mut("function").and_then(Value::as_object_mut) {
                if function.get("strict") == Some(&json!(true)) {
                    function.insert("strict".to_string(), json!(false));
                    changed = true;
                }
            }
        }
        return changed;
    }

    let params = tool
        .get("parameters")
        .or_else(|| {
            tool.get("function")
                .and_then(|function| function.get("parameters"))
        })
        .cloned();

    let changed = match params.as_ref() {
        Some(params) if xai_function_parameters_need_simplification(params) => {
            rewrite_function_tool_parameters(tool, Some(params))
        }
        None => rewrite_function_tool_parameters(tool, None),
        _ => false,
    };

    if changed && is_automation_update_tool(function_tool_name(tool)) {
        if let Some(obj) = tool.as_object_mut() {
            if obj.get("strict") == Some(&json!(true)) {
                obj.insert("strict".to_string(), json!(false));
            }
            if let Some(function) = obj.get_mut("function").and_then(Value::as_object_mut) {
                if function.get("strict") == Some(&json!(true)) {
                    function.insert("strict".to_string(), json!(false));
                }
            }
        }
    }

    changed
}

fn normalize_xai_function_tool_parameter_schemas(body: &mut Value) -> bool {
    let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) else {
        return false;
    };

    let mut changed = false;
    for tool in tools.iter_mut() {
        changed |= normalize_xai_function_tool_parameters(tool);
    }
    changed
}

pub(crate) fn rewrite_xai_agent_message_input_items(body: &mut Value) -> bool {
    rewrite_agent_message_value(body)
}

fn rewrite_agent_message_value(value: &mut Value) -> bool {
    if rewrite_agent_message_item(value) {
        return true;
    }
    match value {
        Value::Array(items) => {
            let mut changed = false;
            for item in items {
                changed |= rewrite_agent_message_value(item);
            }
            changed
        }
        Value::Object(obj) => {
            let mut changed = false;
            for child in obj.values_mut() {
                changed |= rewrite_agent_message_value(child);
            }
            changed
        }
        _ => false,
    }
}

fn json_type(value: &Value) -> Option<&str> {
    value.get("type").and_then(Value::as_str).map(str::trim)
}

fn rewrite_agent_message_item(item: &mut Value) -> bool {
    if json_type(item) != Some("agent_message") {
        return false;
    }

    let id = item.get("id").cloned();
    let content = flatten_agent_message_content(item.get("content"));
    let mut message = json!({
        "type": "message",
        "role": "user",
        "content": content,
    });
    if let Some(id) = id {
        message["id"] = id;
    }
    *item = message;
    true
}

fn flatten_agent_message_content(content: Option<&Value>) -> Vec<Value> {
    match content {
        Some(Value::Array(parts)) => parts.iter().filter_map(part_to_input_text).collect(),
        Some(Value::String(text)) if !text.is_empty() => vec![input_text_part(text)],
        _ => Vec::new(),
    }
}

fn part_to_input_text(part: &Value) -> Option<Value> {
    let text = if json_type(part) == Some("encrypted_content") {
        part.get("encrypted_content")
            .or_else(|| part.get("text"))
            .and_then(Value::as_str)
    } else {
        part.get("text").and_then(Value::as_str)
    }?;
    if text.is_empty() {
        None
    } else {
        Some(input_text_part(text))
    }
}

fn input_text_part(text: &str) -> Value {
    json!({ "type": "input_text", "text": text })
}

pub(crate) fn rewrite_xai_unknown_request_model(
    body: &mut Value,
    upstream_model: &str,
    allowed_models: &HashSet<String>,
) -> Option<(String, String)> {
    let upstream = upstream_model.trim();
    if upstream.is_empty() {
        return None;
    }

    let obj = body.as_object_mut()?;
    let request = obj
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();

    if !request.is_empty() && request_model_is_allowed(&request, upstream, allowed_models) {
        return None;
    }

    obj.insert("model".to_string(), Value::String(upstream.to_string()));
    Some((request, upstream.to_string()))
}

pub(crate) fn collect_xai_catalog_model_ids(settings: &Value) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Some(models) = settings
        .get("modelCatalog")
        .and_then(|catalog| catalog.get("models"))
        .and_then(Value::as_array)
    else {
        return ids;
    };
    for entry in models {
        for key in ["model", "slug", "id"] {
            if let Some(id) = entry
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
            {
                ids.insert(id.to_string());
            }
        }
    }
    ids
}

fn request_model_is_allowed(
    request: &str,
    upstream: &str,
    allowed_models: &HashSet<String>,
) -> bool {
    request.eq_ignore_ascii_case(upstream)
        || request_is_grok_model(request)
        || allowed_models
            .iter()
            .any(|id| id.eq_ignore_ascii_case(request))
}

fn request_is_grok_model(request: &str) -> bool {
    let mut bare = request.trim();
    if let Some(idx) = bare.rfind('/') {
        bare = bare[idx + 1..].trim();
    }
    bare.as_bytes()
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"grok"))
}

fn request_targets_grok_45(body: &Value) -> bool {
    let Some(model) = body.get("model").and_then(Value::as_str) else {
        return false;
    };
    let mut model = model.trim();
    if let Some(idx) = model.rfind('/') {
        model = model[idx + 1..].trim();
    }
    model.eq_ignore_ascii_case("grok-4.5")
}

fn remove_top_level_field(body: &mut Value, field: &str) -> bool {
    body.as_object_mut()
        .and_then(|obj| obj.remove(field))
        .is_some()
}

/// Delete every occurrence of `field` in the tree, at any depth.
fn remove_field_recursive(value: &mut Value, field: &str) -> bool {
    match value {
        Value::Object(map) => {
            let mut changed = map.remove(field).is_some();
            for child in map.values_mut() {
                changed |= remove_field_recursive(child, field);
            }
            changed
        }
        Value::Array(items) => {
            let mut changed = false;
            for child in items.iter_mut() {
                changed |= remove_field_recursive(child, field);
            }
            changed
        }
        _ => false,
    }
}

fn is_additional_tools_item(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str).map(str::trim) == Some("additional_tools")
}

/// Promote any `additional_tools` carrier items from `input` into top-level
/// `tools`, preserving top-level order and appending carrier tools in order,
/// de-duplicated. The carrier items themselves are removed from `input`.
fn promote_additional_tools(body: &mut Value) -> bool {
    // Clone `input` up front so the later mutable write-back to `body` doesn't
    // collide with the read borrow. Only pays the clone on the rare carrier path.
    let input_items: Vec<Value> = match body.get("input").and_then(Value::as_array) {
        Some(arr) if arr.iter().any(is_additional_tools_item) => arr.clone(),
        _ => return false,
    };

    // Seed merged tools + dedup keys from the existing top-level tools.
    let mut merged: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        for tool in tools {
            seen.insert(tool_dedup_key(tool));
            merged.push(tool.clone());
        }
    }

    let mut filtered_input: Vec<Value> = Vec::with_capacity(input_items.len());
    let mut promoted = false;
    for item in input_items {
        if is_additional_tools_item(&item) {
            if let Some(carrier_tools) = item.get("tools").and_then(Value::as_array) {
                for tool in carrier_tools {
                    if seen.insert(tool_dedup_key(tool)) {
                        merged.push(tool.clone());
                        promoted = true;
                    }
                }
            }
            continue; // carrier item dropped regardless of dedup outcome
        }
        filtered_input.push(item);
    }

    if let Some(obj) = body.as_object_mut() {
        obj.insert("input".to_string(), Value::Array(filtered_input));
        if promoted {
            obj.insert("tools".to_string(), Value::Array(merged));
        }
    }
    // We reached here only because a carrier existed, so `input` changed.
    true
}

/// Stable dedup key for a tool: `(type, name)`, `(mcp, server_label)`, or the
/// serialized tool as a last resort. Mirrors sub2api's `grokResponsesToolDedupKey`.
fn tool_dedup_key(tool: &Value) -> String {
    let tool_type = tool
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !tool_type.is_empty() {
        if let Some(name) = tool.get("name").and_then(Value::as_str) {
            let name = name.trim();
            if !name.is_empty() {
                return format!("type:{tool_type}\u{0}name:{name}");
            }
        }
        if tool_type == "mcp" {
            if let Some(label) = tool.get("server_label").and_then(Value::as_str) {
                let label = label.trim();
                if !label.is_empty() {
                    return format!("type:mcp\u{0}server_label:{label}");
                }
            }
        }
    }
    format!("json:{tool}")
}

fn strip_null_reasoning_content(body: &mut Value) -> bool {
    let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for item in input.iter_mut() {
        if item.get("type").and_then(Value::as_str).map(str::trim) != Some("reasoning") {
            continue;
        }
        if let Some(obj) = item.as_object_mut() {
            if matches!(obj.get("content"), Some(Value::Null)) {
                obj.remove("content");
                changed = true;
            }
        }
    }
    changed
}

/// Keep only whitelisted tool types and drop a `tool_choice` that now points at
/// a removed or unsupported tool.
fn filter_unsupported_tools(body: &mut Value) -> bool {
    let Some(tools) = body.get("tools").and_then(Value::as_array) else {
        return false;
    };
    let original_len = tools.len();
    let filtered: Vec<Value> = tools
        .iter()
        .filter(|tool| {
            let t = tool
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            XAI_SUPPORTED_TOOL_TYPES.contains(&t)
        })
        .cloned()
        .collect();

    let mut changed = false;
    if filtered.len() != original_len {
        if let Some(obj) = body.as_object_mut() {
            if filtered.is_empty() {
                obj.remove("tools");
            } else {
                obj.insert("tools".to_string(), Value::Array(filtered.clone()));
            }
        }
        changed = true;
    }

    if body.get("tool_choice").is_some() && should_drop_tool_choice(body, &filtered) {
        if let Some(obj) = body.as_object_mut() {
            obj.remove("tool_choice");
        }
        changed = true;
    }

    changed
}

/// Whether `tool_choice` should be dropped given the surviving `tools`. String
/// choices (`"auto"`, `"none"`, `"required"`) are always kept; object choices
/// are dropped when they reference an unsupported type or a function name that
/// no longer exists.
fn should_drop_tool_choice(body: &Value, tools: &[Value]) -> bool {
    let Some(tool_choice) = body.get("tool_choice") else {
        return false;
    };
    if tools.is_empty() {
        return true;
    }
    let Some(choice) = tool_choice.as_object() else {
        return false; // "auto"/"none"/"required" string choices stay
    };
    let choice_type = choice
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if choice_type.is_empty() {
        return false;
    }
    if !XAI_SUPPORTED_TOOL_TYPES.contains(&choice_type) {
        return true;
    }
    if choice_type == "function" {
        let choice_name = choice
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                choice
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
            })
            .unwrap_or("")
            .trim();
        if choice_name.is_empty() {
            return false;
        }
        let exists = tools.iter().any(|tool| {
            let t = tool
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| {
                    tool.get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("")
                .trim();
            t == "function" && name == choice_name
        });
        return !exists;
    }
    false
}

pub(crate) fn is_xai_native_responses_url(upstream: &str) -> bool {
    url::Url::parse(upstream).ok().is_some_and(|url| {
        url.host_str() == Some("api.x.ai")
            && matches!(
                url.path().trim_end_matches('/'),
                "/v1/responses" | "/responses" | "/v1/responses/compact" | "/responses/compact"
            )
    })
}

pub(crate) fn normalize_xai_function_call_integer_arguments(value: &mut Value) -> bool {
    normalize_xai_function_call_integer_arguments_value(value)
}

fn normalize_xai_function_call_integer_arguments_value(value: &mut Value) -> bool {
    match value {
        Value::Array(items) => {
            let mut changed = false;
            for item in items {
                changed |= normalize_xai_function_call_integer_arguments_value(item);
            }
            changed
        }
        Value::Object(obj) => {
            let event_type = obj
                .get("type")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            if event_type.as_deref() == Some("response.function_call_arguments.delta") {
                return false;
            }

            let mut changed = false;
            if event_type.as_deref() == Some("response.function_call_arguments.done")
                || event_type.as_deref() == Some("function_call")
            {
                changed |= normalize_function_call_arguments_field(obj);
            }
            for child in obj.values_mut() {
                changed |= normalize_xai_function_call_integer_arguments_value(child);
            }
            changed
        }
        _ => false,
    }
}

fn normalize_function_call_arguments_field(obj: &mut Map<String, Value>) -> bool {
    match obj.get_mut("arguments") {
        Some(Value::String(arguments)) => match rewrite_whole_float_arguments_json(arguments) {
            Ok(Some(rewritten)) => {
                *arguments = rewritten;
                true
            }
            Ok(None) => false,
            Err(error) => {
                log::debug!(
                    "[Codex] xAI function_call arguments were not rewritten; passing through unchanged: {error}"
                );
                false
            }
        },
        Some(other) => rewrite_whole_number_floats(other),
        None => false,
    }
}

fn rewrite_whole_float_arguments_json(
    arguments: &str,
) -> Result<Option<String>, serde_json::Error> {
    let mut value: Value = serde_json::from_str(arguments)?;
    if !rewrite_whole_number_floats(&mut value) {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string(&value)?))
}

fn rewrite_whole_number_floats(value: &mut Value) -> bool {
    match value {
        Value::Number(number) => {
            if let Some(integer) = whole_float_to_json_int(number) {
                *number = integer;
                true
            } else {
                false
            }
        }
        Value::Array(items) => {
            let mut changed = false;
            for item in items {
                changed |= rewrite_whole_number_floats(item);
            }
            changed
        }
        Value::Object(map) => {
            let mut changed = false;
            for child in map.values_mut() {
                changed |= rewrite_whole_number_floats(child);
            }
            changed
        }
        _ => false,
    }
}

fn whole_float_to_json_int(number: &Number) -> Option<Number> {
    if number.is_i64() || number.is_u64() {
        return None;
    }
    let float = number.as_f64()?;
    if !float.is_finite() || float.fract() != 0.0 {
        return None;
    }
    if float >= 0.0 {
        if float >= u64::MAX as f64 {
            return None;
        }
        let integer = float as u64;
        if integer as f64 != float {
            return None;
        }
        Some(Number::from(integer))
    } else {
        if float < i64::MIN as f64 {
            return None;
        }
        let integer = float as i64;
        if integer as f64 != float {
            return None;
        }
        Some(Number::from(integer))
    }
}

pub(crate) fn create_xai_native_responses_sse_stream<E>(
    stream: impl Stream<Item = Result<Bytes, E>> + Send + 'static,
    restore_map: HashMap<String, NamespacedName>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send
where
    E: std::error::Error + Send + 'static,
{
    async_stream::stream! {
        let mut buffer = String::new();
        let mut utf8_remainder: Vec<u8> = Vec::new();

        tokio::pin!(stream);

        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    append_utf8_safe(&mut buffer, &mut utf8_remainder, &bytes);
                    while let Some(block) = take_sse_block(&mut buffer) {
                        if block.trim().is_empty() {
                            continue;
                        }
                        yield Ok(rewrite_xai_native_sse_block(&block, &restore_map));
                    }
                }
                Err(e) => {
                    yield Err(std::io::Error::other(e.to_string()));
                    return;
                }
            }
        }

        if !utf8_remainder.is_empty() {
            buffer.push_str(&String::from_utf8_lossy(&utf8_remainder));
        }
        let tail = std::mem::take(&mut buffer);
        if !tail.trim().is_empty() {
            yield Ok(rewrite_xai_native_sse_block(&tail, &restore_map));
        }
    }
}

fn rewrite_xai_native_sse_block(
    block: &str,
    restore_map: &HashMap<String, NamespacedName>,
) -> Bytes {
    let mut event_name: Option<&str> = None;
    let mut data_parts: Vec<&str> = Vec::new();
    for line in block.lines() {
        if let Some(event) = strip_sse_field(line, "event") {
            event_name = Some(event.trim());
        }
        if let Some(data) = strip_sse_field(line, "data") {
            data_parts.push(data);
        }
    }

    if data_parts.is_empty() {
        return Bytes::from(format!("{block}\n\n"));
    }

    let data = data_parts.join("\n");
    if data.trim() == "[DONE]" {
        return Bytes::from(format!("{block}\n\n"));
    }

    let mut event: Value = match serde_json::from_str(&data) {
        Ok(value) => value,
        Err(_) => return Bytes::from(format!("{block}\n\n")),
    };

    let mut changed = restore_sse_event_namespaces(&mut event, restore_map);
    changed |= normalize_xai_function_call_integer_arguments(&mut event);
    if !changed {
        return Bytes::from(format!("{block}\n\n"));
    }

    let restored = serde_json::to_string(&event).unwrap_or(data);
    let mut out = String::new();
    if let Some(name) = event_name {
        out.push_str("event: ");
        out.push_str(name);
        out.push('\n');
    }
    out.push_str("data: ");
    out.push_str(&restored);
    out.push_str("\n\n");
    Bytes::from(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn actual_route_controls_native_xai_compatibility() {
        for url in [
            "https://api.x.ai/v1/responses",
            "https://api.x.ai/v1/responses/compact?x=1",
        ] {
            assert!(is_xai_native_responses_url(url));
        }
        for url in [
            "https://other.example/v1/responses",
            "https://api.x.ai/v1/chat/completions",
            "https://api.x.ai/v1/images/edits",
            "https://api.x.ai.evil.example/v1/responses",
            "bad",
        ] {
            assert!(!is_xai_native_responses_url(url));
        }
    }

    #[test]
    fn whole_float_arguments_cover_bounds_and_preserve_invalid_json() {
        let mut value = json!({"output":[{"type":"function_call","arguments":"{\"positive\":92116.0,\"negative\":-4.0,\"fraction\":1.5,\"nested\":[2.0]}"}]});
        assert!(normalize_xai_function_call_integer_arguments(&mut value));
        let arguments: Value =
            serde_json::from_str(value["output"][0]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(arguments["positive"].as_u64(), Some(92116));
        assert_eq!(arguments["negative"].as_i64(), Some(-4));
        assert_eq!(arguments["fraction"].as_f64(), Some(1.5));
        assert_eq!(arguments["nested"][0].as_u64(), Some(2));
        assert!(!normalize_xai_function_call_integer_arguments(&mut value));
        for text in ["18446744073709551616.0", "-18446744073709551616.0", "1.5"] {
            let number: Number = serde_json::from_str(text).unwrap();
            assert!(whole_float_to_json_int(&number).is_none(), "{text}");
        }
        for original in [
            json!({"type":"function_call","arguments":"broken"}),
            json!({"type":"response.function_call_arguments.delta","delta":"1.0"}),
            json!({"type":"function_call","arguments":null}),
        ] {
            let mut value = original.clone();
            assert!(!normalize_xai_function_call_integer_arguments(&mut value));
            assert_eq!(value, original);
        }
    }

    #[tokio::test]
    async fn xai_sse_rewrites_completed_arguments_across_byte_boundaries() {
        let event = json!({"type":"response.function_call_arguments.done","arguments":"{\"count\":3.0,\"label\":\"图\"}"});
        let wire = format!(
            "event: response.function_call_arguments.done\r\ndata: {event}\r\n\r\ndata: [DONE]\n\n"
        );
        let chunks: Vec<_> = wire
            .as_bytes()
            .iter()
            .map(|byte| Ok::<_, std::io::Error>(Bytes::copy_from_slice(&[*byte])))
            .collect();
        let stream =
            create_xai_native_responses_sse_stream(futures::stream::iter(chunks), HashMap::new());
        tokio::pin!(stream);
        let mut result = Vec::new();
        while let Some(chunk) = stream.next().await {
            result.extend_from_slice(&chunk.unwrap());
        }
        let result = String::from_utf8(result).unwrap();
        let data = result
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        let event: Value = serde_json::from_str(data).unwrap();
        let arguments: Value = serde_json::from_str(event["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(arguments["count"].as_u64(), Some(3));
        assert_eq!(arguments["label"], "图");
        assert!(result.contains("data: [DONE]"));
    }

    #[test]
    fn native_xai_rewrites_agent_items_and_union_schemas_idempotently() {
        let mut body = json!({"model":"grok-4.6","input":[{"type":"agent_message","id":"msg_a","content":[{"type":"encrypted_content","encrypted_content":"Task"}]}],
            "tools":[{"type":"function","name":"read","parameters":{"oneOf":[{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]},{"type":"null"}]}}]});
        assert!(sanitize_xai_responses_request(&mut body));
        assert_eq!(
            body["input"][0],
            json!({"type":"message","id":"msg_a","role":"user","content":[{"type":"input_text","text":"Task"}]})
        );
        assert_eq!(body["tools"][0]["parameters"]["type"], "object");
        assert_eq!(body["tools"][0]["parameters"]["required"], json!(["path"]));
        assert!(!sanitize_xai_responses_request(&mut body));
    }

    #[test]
    fn xai_model_rewrite_preserves_grok_and_catalog_models() {
        let allowed = collect_xai_catalog_model_ids(
            &json!({"modelCatalog":{"models":[{"slug":"custom-model"}]}}),
        );
        for model in ["grok-4.6", "xai/grok-new", "custom-model"] {
            let mut body = json!({"model":model});
            assert!(rewrite_xai_unknown_request_model(&mut body, "grok-4.5", &allowed).is_none());
        }
        let mut body = json!({"model":"gpt-5.6-sol"});
        assert!(rewrite_xai_unknown_request_model(&mut body, "grok-4.5", &allowed).is_some());
        assert_eq!(body["model"], "grok-4.5");
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn strips_external_web_access_recursively() {
        let mut body = json!({
            "model": "grok-4.5",
            "external_web_access": true,
            "tools": [
                {"type": "function", "name": "f", "external_web_access": true,
                 "parameters": {"type": "object", "q": {"external_web_access": true}}}
            ],
            "metadata": {"external_web_access": false}
        });
        assert!(sanitize_xai_responses_request(&mut body));
        let s = body.to_string();
        assert!(!s.contains("external_web_access"), "left over: {s}");
    }

    #[test]
    fn strips_top_level_unsupported_fields() {
        let mut body = json!({
            "model": "grok-4.5",
            "prompt_cache_retention": "24h",
            "safety_identifier": "abc"
        });
        assert!(sanitize_xai_responses_request(&mut body));
        assert!(body.get("prompt_cache_retention").is_none());
        assert!(body.get("safety_identifier").is_none());
    }

    #[test]
    fn strips_grok_45_only_sampling_fields() {
        let mut body = json!({
            "model": "grok-4.5",
            "presence_penalty": 0.1,
            "frequency_penalty": 0.2,
            "stop": ["x"]
        });
        assert!(sanitize_xai_responses_request(&mut body));
        assert!(body.get("presence_penalty").is_none());
        assert!(body.get("frequency_penalty").is_none());
        assert!(body.get("stop").is_none());
    }

    #[test]
    fn keeps_sampling_fields_for_non_grok_45() {
        let mut body = json!({
            "model": "grok-4-fast",
            "presence_penalty": 0.1,
            "stop": ["x"]
        });
        // No unsupported fields present, so no change and knobs preserved.
        assert!(!sanitize_xai_responses_request(&mut body));
        assert_eq!(body.get("presence_penalty"), Some(&json!(0.1)));
        assert_eq!(body.get("stop"), Some(&json!(["x"])));
    }

    #[test]
    fn matches_grok_45_with_provider_prefix() {
        let mut body = json!({"model": "xai/grok-4.5", "stop": ["x"]});
        assert!(sanitize_xai_responses_request(&mut body));
        assert!(body.get("stop").is_none());
    }

    #[test]
    fn promotes_additional_tools_dedup() {
        let mut body = json!({
            "model": "grok-4.5",
            "tools": [{"type": "function", "name": "kept"}],
            "input": [
                {"type": "message", "role": "user", "content": "hi"},
                {"type": "additional_tools", "tools": [
                    {"type": "function", "name": "kept"},
                    {"type": "function", "name": "extra"}
                ]}
            ]
        });
        assert!(sanitize_xai_responses_request(&mut body));
        // carrier removed from input
        let input = body.get("input").unwrap().as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert!(input.iter().all(|i| !is_additional_tools_item(i)));
        // extra promoted, kept not duplicated
        let tools = body.get("tools").unwrap().as_array().unwrap();
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t.get("name").and_then(Value::as_str).unwrap())
            .collect();
        assert_eq!(names, vec!["kept", "extra"]);
    }

    #[test]
    fn strips_null_reasoning_content() {
        let mut body = json!({
            "model": "grok-4.5",
            "input": [
                {"type": "reasoning", "content": null, "id": "r1"},
                {"type": "reasoning", "content": [{"text": "keep"}], "id": "r2"}
            ]
        });
        assert!(sanitize_xai_responses_request(&mut body));
        let input = body.get("input").unwrap().as_array().unwrap();
        assert!(input[0].get("content").is_none());
        assert!(input[1].get("content").is_some());
    }

    #[test]
    fn filters_unsupported_tool_types() {
        let mut body = json!({
            "model": "grok-4.5",
            "tools": [
                {"type": "function", "name": "f"},
                {"type": "tool_search"},
                {"type": "custom", "name": "c"},
                {"type": "mcp", "server_label": "s"}
            ]
        });
        assert!(sanitize_xai_responses_request(&mut body));
        let types: Vec<&str> = body
            .get("tools")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.get("type").and_then(Value::as_str).unwrap())
            .collect();
        assert_eq!(types, vec!["function", "mcp"]);
    }

    #[test]
    fn drops_dangling_function_tool_choice() {
        let mut body = json!({
            "model": "grok-4.5",
            "tools": [{"type": "tool_search"}],
            "tool_choice": {"type": "function", "name": "gone"}
        });
        assert!(sanitize_xai_responses_request(&mut body));
        // tool_search filtered → no tools → tool_choice dropped
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn keeps_valid_function_tool_choice() {
        let mut body = json!({
            "model": "grok-4.5",
            "tools": [{"type": "function", "name": "run", "parameters": {"type":"object","properties":{}}}],
            "tool_choice": {"type": "function", "name": "run"}
        });
        assert!(!sanitize_xai_responses_request(&mut body));
        assert_eq!(
            body.get("tool_choice").unwrap(),
            &json!({"type": "function", "name": "run"})
        );
    }

    #[test]
    fn keeps_string_tool_choice() {
        let mut body = json!({
            "model": "grok-4.5",
            "tools": [{"type": "function", "name": "run", "parameters": {"type":"object","properties":{}}}],
            "tool_choice": "auto"
        });
        assert!(!sanitize_xai_responses_request(&mut body));
        assert_eq!(body.get("tool_choice").unwrap(), &json!("auto"));
    }

    #[test]
    fn noop_on_clean_request() {
        let mut body = json!({
            "model": "grok-4.5",
            "input": [{"type": "message", "role": "user", "content": "hi"}],
            "tools": [{"type": "function", "name": "f", "parameters": {"type":"object","properties":{}}}]
        });
        assert!(!sanitize_xai_responses_request(&mut body));
    }

    #[test]
    fn idempotent_second_pass() {
        let mut body = json!({
            "model": "grok-4.5",
            "external_web_access": true,
            "prompt_cache_retention": "24h",
            "tools": [{"type": "function", "name": "f"}, {"type": "tool_search"}]
        });
        assert!(sanitize_xai_responses_request(&mut body));
        // second pass finds nothing left to change
        assert!(!sanitize_xai_responses_request(&mut body));
    }
}
