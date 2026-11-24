//! MCP 服务器配置验证模块

use serde_json::Value;
use url::Url;

use crate::error::AppError;

/// Deep link / MCP import resource budgets.
pub const MAX_MCP_SERVERS: usize = 128;
const MAX_MCP_ID_BYTES: usize = 128;
const MAX_MCP_COMMAND_BYTES: usize = 4096;
const MAX_MCP_CWD_BYTES: usize = 4096;
const MAX_MCP_URL_BYTES: usize = 4096;
const MAX_MCP_ARGS: usize = 256;
const MAX_MCP_ARG_BYTES: usize = 4096;
const MAX_MCP_ENV: usize = 128;
const MAX_MCP_ENV_KEY_BYTES: usize = 256;
const MAX_MCP_ENV_VALUE_BYTES: usize = 16 * 1024;
const MAX_MCP_HEADERS: usize = 128;
const MAX_MCP_HEADER_KEY_BYTES: usize = 4096;
const MAX_MCP_HEADER_VALUE_BYTES: usize = 4096;

/// Validate an imported MCP server id before it reaches the database or a
/// client-specific config file.
pub fn validate_server_id(id: &str) -> Result<(), AppError> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(AppError::McpValidation("MCP 服务器 id 不能为空".into()));
    }
    if trimmed.len() > MAX_MCP_ID_BYTES {
        return Err(AppError::McpValidation(format!(
            "MCP 服务器 id 过长（最多 {MAX_MCP_ID_BYTES} 字节）"
        )));
    }
    if trimmed != id || id.contains('/') || id.contains('\\') || id.chars().any(|c| c.is_control())
    {
        return Err(AppError::McpValidation(
            "MCP 服务器 id 含有不允许的字符".into(),
        ));
    }
    Ok(())
}

/// 基础校验：允许 stdio/http/sse；或省略 type（视为 stdio）。对应必填字段存在。
///
/// 除了形状校验外，这里还限制递归资源预算，避免 deep link 或外部配置
/// 通过超大 args/env/headers 将内存、SQLite 和多个 live 配置文件拖垮。
/// 推断 MCP server spec 的传输类型（未显式声明但有 `url` 无 `command` 时按 `http`）。
pub(crate) fn spec_transport_type(spec: &Value) -> &str {
    let has = |key: &str| {
        spec.get(key)
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty())
    };
    let explicit = spec.get("type").and_then(|v| v.as_str());
    if matches!(explicit, None | Some("stdio")) && !has("command") && has("url") {
        return "http";
    }
    explicit.unwrap_or("stdio")
}

pub fn validate_server_spec(spec: &Value) -> Result<(), AppError> {
    let object = spec
        .as_object()
        .ok_or_else(|| AppError::McpValidation("MCP 服务器连接定义必须为 JSON 对象".into()))?;

    let t_opt = match object.get("type") {
        None => None,
        Some(value) => Some(
            value
                .as_str()
                .ok_or_else(|| AppError::McpValidation("MCP 服务器 type 必须是字符串".into()))?,
        ),
    };

    // 支持三种：stdio/http/sse；若缺省 type 则按 stdio 处理。
    let transport = t_opt.unwrap_or("stdio");
    if !matches!(transport, "stdio" | "http" | "sse") {
        return Err(AppError::McpValidation(
            "MCP 服务器 type 必须是 'stdio'、'http' 或 'sse'（或省略表示 stdio）".into(),
        ));
    }

    match transport {
        "stdio" => {
            let command = required_string(object, "command")?;
            validate_string(command, "command", MAX_MCP_COMMAND_BYTES, true)?;
            validate_optional_string(object, "cwd", MAX_MCP_CWD_BYTES)?;
            validate_string_array(object, "args", MAX_MCP_ARGS, MAX_MCP_ARG_BYTES)?;
            validate_string_map(
                object,
                "env",
                MAX_MCP_ENV,
                MAX_MCP_ENV_KEY_BYTES,
                MAX_MCP_ENV_VALUE_BYTES,
            )?;
        }
        "http" | "sse" => {
            let url = required_string(object, "url")?;
            validate_transport_url(url)?;
            validate_string_map(
                object,
                "headers",
                MAX_MCP_HEADERS,
                MAX_MCP_HEADER_KEY_BYTES,
                MAX_MCP_HEADER_VALUE_BYTES,
            )?;
            // Codex accepts the historical alias as well.
            validate_string_map(
                object,
                "http_headers",
                MAX_MCP_HEADERS,
                MAX_MCP_HEADER_KEY_BYTES,
                MAX_MCP_HEADER_VALUE_BYTES,
            )?;
        }
        _ => unreachable!(),
    }

    Ok(())
}

fn required_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<&'a str, AppError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::McpValidation(format!("MCP 服务器缺少有效的 {field} 字段")))
}

fn validate_optional_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
    max_bytes: usize,
) -> Result<(), AppError> {
    if let Some(value) = object.get(field) {
        let text = value.as_str().ok_or_else(|| {
            AppError::McpValidation(format!("MCP 服务器 {field} 字段必须是字符串"))
        })?;
        validate_string(text, field, max_bytes, false)?;
    }
    Ok(())
}

fn validate_string(
    text: &str,
    field: &str,
    max_bytes: usize,
    non_empty: bool,
) -> Result<(), AppError> {
    if non_empty && text.trim().is_empty() {
        return Err(AppError::McpValidation(format!(
            "MCP 服务器 {field} 字段不能为空"
        )));
    }
    if text.len() > max_bytes {
        return Err(AppError::McpValidation(format!(
            "MCP 服务器 {field} 字段过长（最多 {max_bytes} 字节）"
        )));
    }
    if text.chars().any(|c| c == '\0') {
        return Err(AppError::McpValidation(format!(
            "MCP 服务器 {field} 字段不能包含 NUL 字符"
        )));
    }
    Ok(())
}

fn validate_string_array(
    object: &serde_json::Map<String, Value>,
    field: &str,
    max_items: usize,
    max_item_bytes: usize,
) -> Result<(), AppError> {
    let Some(value) = object.get(field) else {
        return Ok(());
    };
    let items = value.as_array().ok_or_else(|| {
        AppError::McpValidation(format!("MCP 服务器 {field} 字段必须是字符串数组"))
    })?;
    if items.len() > max_items {
        return Err(AppError::McpValidation(format!(
            "MCP 服务器 {field} 项目过多（最多 {max_items} 项）"
        )));
    }
    for item in items {
        let text = item.as_str().ok_or_else(|| {
            AppError::McpValidation(format!("MCP 服务器 {field} 必须只包含字符串"))
        })?;
        validate_string(text, field, max_item_bytes, false)?;
    }
    Ok(())
}

fn validate_string_map(
    object: &serde_json::Map<String, Value>,
    field: &str,
    max_items: usize,
    max_key_bytes: usize,
    max_value_bytes: usize,
) -> Result<(), AppError> {
    let Some(value) = object.get(field) else {
        return Ok(());
    };
    let map = value.as_object().ok_or_else(|| {
        AppError::McpValidation(format!("MCP 服务器 {field} 字段必须是字符串对象"))
    })?;
    if map.len() > max_items {
        return Err(AppError::McpValidation(format!(
            "MCP 服务器 {field} 项目过多（最多 {max_items} 项）"
        )));
    }

    for (key, value) in map {
        validate_string(key, &format!("{field} key"), max_key_bytes, true)?;
        let value = value.as_str().ok_or_else(|| {
            AppError::McpValidation(format!("MCP 服务器 {field} 的值必须是字符串"))
        })?;
        validate_string(value, &format!("{field} value"), max_value_bytes, false)?;
    }
    Ok(())
}

fn validate_transport_url(url: &str) -> Result<(), AppError> {
    validate_string(url, "url", MAX_MCP_URL_BYTES, true)?;
    let parsed = Url::parse(url)
        .map_err(|_| AppError::McpValidation("MCP HTTP/SSE url 不是有效 URL".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::McpValidation(
            "MCP HTTP/SSE url 必须使用 http 或 https".into(),
        ));
    }
    if parsed.host_str().is_none() {
        return Err(AppError::McpValidation(
            "MCP HTTP/SSE url 必须包含 host".into(),
        ));
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err(AppError::McpValidation(
            "MCP HTTP/SSE url 不得包含 userinfo".into(),
        ));
    }
    if parsed.fragment().is_some() {
        return Err(AppError::McpValidation(
            "MCP HTTP/SSE url 不得包含 fragment".into(),
        ));
    }
    Ok(())
}

/// 从 MCP 条目中提取服务器规范
pub fn extract_server_spec(entry: &Value) -> Result<Value, AppError> {
    let obj = entry
        .as_object()
        .ok_or_else(|| AppError::McpValidation("MCP 服务器条目必须为 JSON 对象".into()))?;
    let server = obj
        .get("server")
        .ok_or_else(|| AppError::McpValidation("MCP 服务器条目缺少 server 字段".into()))?;

    if !server.is_object() {
        return Err(AppError::McpValidation(
            "MCP 服务器 server 字段必须为 JSON 对象".into(),
        ));
    }

    Ok(server.clone())
}
