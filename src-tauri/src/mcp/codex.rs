//! Codex MCP 同步和导入模块
//!
//! 包含 Codex 的 MCP 配置管理：
//! - 从 ~/.codex/config.toml 导入
//! - 同步到 ~/.codex/config.toml
//! - JSON 到 TOML 的转换逻辑

use serde_json::{json, Value};
use std::collections::HashMap;

use crate::app_config::{McpApps, McpConfig, McpServer, MultiAppConfig};
use crate::error::AppError;

use super::validation::{extract_server_spec, validate_server_spec};

fn should_sync_codex_mcp() -> bool {
    // Codex 未安装/未初始化时：~/.codex 目录不存在。
    // 按用户偏好：目录缺失时跳过写入/删除，不创建任何文件或目录。
    crate::codex_config::get_codex_config_dir().exists()
}

/// 返回已启用的 MCP 服务器（过滤 enabled==true）
fn collect_enabled_servers(cfg: &McpConfig) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    for (id, entry) in cfg.servers.iter() {
        let enabled = entry
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !enabled {
            continue;
        }
        match extract_server_spec(entry) {
            Ok(spec) => {
                out.insert(id.clone(), spec);
            }
            Err(err) => {
                log::warn!("跳过无效的 MCP 条目 '{id}': {err}");
            }
        }
    }
    out
}

/// Convert one live `[mcp_servers.<id>]` table into the unified JSON spec.
///
/// Codex's own schema has no `type` key: it infers stdio from `command` and
/// streamable HTTP from `url` (`RawMcpServerConfig`, Codex 0.153.4). A table
/// written by Codex itself or by hand therefore never carries `type`, so the
/// transport must be inferred the same way here instead of defaulting to
/// stdio — which used to make every native HTTP server fail import with
/// "缺少有效的 command 字段". An explicit `type` (written by older Chimera++
/// builds) is still honoured. Returns `None` for tables Codex could not load
/// either (unknown transport).
fn codex_mcp_table_to_spec(id: &str, entry_tbl: &toml::value::Table) -> Option<Value> {
    let typ = match entry_tbl.get("type").and_then(|v| v.as_str()) {
        Some("streamable_http") => "http",
        Some(explicit) => explicit,
        None if entry_tbl.contains_key("command") => "stdio",
        None if entry_tbl.contains_key("url") => "http",
        None => "stdio",
    };

    // 构建 JSON 规范
    let mut spec = serde_json::Map::new();
    spec.insert("type".into(), json!(typ));

    // 核心字段（需要手动处理的字段）
    let core_fields = match typ {
        "stdio" => vec!["type", "command", "args", "env", "cwd"],
        // DB 中的统一规范使用 headers，Codex TOML 使用 http_headers。
        // 两者都必须视为核心字段，避免鉴权值落入通用日志路径。
        "http" | "sse" => vec!["type", "url", "headers", "http_headers"],
        _ => vec!["type"],
    };

    // 1. 处理核心字段（强类型）
    match typ {
        "stdio" => {
            if let Some(cmd) = entry_tbl.get("command").and_then(|v| v.as_str()) {
                spec.insert("command".into(), json!(cmd));
            }
            if let Some(args) = entry_tbl.get("args").and_then(|v| v.as_array()) {
                let arr = args
                    .iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| json!(s))
                    .collect::<Vec<_>>();
                if !arr.is_empty() {
                    spec.insert("args".into(), serde_json::Value::Array(arr));
                }
            }
            if let Some(cwd) = entry_tbl.get("cwd").and_then(|v| v.as_str()) {
                if !cwd.trim().is_empty() {
                    spec.insert("cwd".into(), json!(cwd));
                }
            }
            if let Some(env_tbl) = entry_tbl.get("env").and_then(|v| v.as_table()) {
                let mut env_json = serde_json::Map::new();
                for (k, v) in env_tbl.iter() {
                    if let Some(sv) = v.as_str() {
                        env_json.insert(k.clone(), json!(sv));
                    }
                }
                if !env_json.is_empty() {
                    spec.insert("env".into(), serde_json::Value::Object(env_json));
                }
            }
        }
        "http" | "sse" => {
            if let Some(url) = entry_tbl.get("url").and_then(|v| v.as_str()) {
                spec.insert("url".into(), json!(url));
            }
            // Read from http_headers (correct Codex format) or headers (legacy) with priority to http_headers
            let headers_tbl = entry_tbl
                .get("http_headers")
                .and_then(|v| v.as_table())
                .or_else(|| entry_tbl.get("headers").and_then(|v| v.as_table()));

            if let Some(headers_tbl) = headers_tbl {
                let mut headers_json = serde_json::Map::new();
                for (k, v) in headers_tbl.iter() {
                    if let Some(sv) = v.as_str() {
                        headers_json.insert(k.clone(), json!(sv));
                    }
                }
                if !headers_json.is_empty() {
                    spec.insert("headers".into(), serde_json::Value::Object(headers_json));
                }
            }
        }
        _ => {
            log::warn!("跳过未知类型 '{typ}' 的 Codex MCP 项 '{id}'");
            return None;
        }
    }

    // 2. 处理扩展字段和其他未知字段（通用 TOML → JSON 转换）
    for (key, toml_val) in entry_tbl.iter() {
        // 跳过已处理的核心字段
        if core_fields.contains(&key.as_str()) {
            continue;
        }

        // 通用 TOML 值到 JSON 值转换
        let json_val = match toml_val {
            toml::Value::String(s) => Some(json!(s)),
            toml::Value::Integer(i) => Some(json!(i)),
            toml::Value::Float(f) => Some(json!(f)),
            toml::Value::Boolean(b) => Some(json!(b)),
            toml::Value::Array(arr) => {
                // 只支持简单类型数组
                let json_arr: Vec<serde_json::Value> = arr
                    .iter()
                    .filter_map(|item| match item {
                        toml::Value::String(s) => Some(json!(s)),
                        toml::Value::Integer(i) => Some(json!(i)),
                        toml::Value::Float(f) => Some(json!(f)),
                        toml::Value::Boolean(b) => Some(json!(b)),
                        _ => None,
                    })
                    .collect();
                if !json_arr.is_empty() {
                    Some(serde_json::Value::Array(json_arr))
                } else {
                    log::debug!("跳过复杂数组字段 '{key}' (TOML → JSON)");
                    None
                }
            }
            toml::Value::Table(tbl) => {
                // 浅层表转为 JSON 对象（仅支持字符串值）
                let mut json_obj = serde_json::Map::new();
                for (k, v) in tbl.iter() {
                    if let Some(s) = v.as_str() {
                        json_obj.insert(k.clone(), json!(s));
                    }
                }
                if !json_obj.is_empty() {
                    Some(serde_json::Value::Object(json_obj))
                } else {
                    log::debug!("跳过复杂对象字段 '{key}' (TOML → JSON)");
                    None
                }
            }
            toml::Value::Datetime(_) => {
                log::debug!("跳过日期时间字段 '{key}' (TOML → JSON)");
                None
            }
        };

        if let Some(val) = json_val {
            spec.insert(key.clone(), val);
            log::debug!("导入扩展字段 '{key}'（值已省略）");
        }
    }

    Some(serde_json::Value::Object(spec))
}

/// 从 ~/.codex/config.toml 导入 MCP 到统一结构（v3.7.0+）
///
/// 格式支持：
/// - 正确格式：[mcp_servers.*]（Codex 官方标准）
/// - 错误格式：[mcp.servers.*]（容错读取，用于迁移错误写入的配置）
///
/// 已存在的服务器将启用 Codex 应用，不覆盖其他字段和应用状态
pub fn import_from_codex(config: &mut MultiAppConfig) -> Result<usize, AppError> {
    let text = crate::codex_config::read_and_validate_codex_config_text()?;
    if text.trim().is_empty() {
        return Ok(0);
    }

    let root: toml::Table = toml::from_str(&text)
        .map_err(|e| AppError::McpValidation(format!("解析 ~/.codex/config.toml 失败: {e}")))?;

    // 确保新结构存在
    let servers = config.mcp.servers.get_or_insert_with(HashMap::new);

    let mut changed_total = 0usize;

    // helper：处理一组 servers 表
    let mut import_servers_tbl = |servers_tbl: &toml::value::Table| {
        let mut changed = 0usize;
        for (id, entry_val) in servers_tbl.iter() {
            let Some(entry_tbl) = entry_val.as_table() else {
                continue;
            };

            let Some(spec_v) = codex_mcp_table_to_spec(id, entry_tbl) else {
                continue;
            };

            // 校验：单项失败继续处理
            if let Err(e) = validate_server_spec(&spec_v) {
                log::warn!("跳过无效 Codex MCP 项 '{id}': {e}");
                continue;
            }

            if let Some(existing) = servers.get_mut(id) {
                // 已存在：仅启用 Codex 应用
                if !existing.apps.codex {
                    existing.apps.codex = true;
                    changed += 1;
                    log::info!("MCP 服务器 '{id}' 已启用 Codex 应用");
                }
            } else {
                // 新建服务器：默认仅启用 Codex
                servers.insert(
                    id.clone(),
                    McpServer {
                        id: id.clone(),
                        name: id.clone(),
                        server: spec_v,
                        apps: McpApps {
                            claude: false,
                            codex: true,
                            gemini: false,
                            grokbuild: false,
                            opencode: false,
                            hermes: false,
                        },
                        description: None,
                        homepage: None,
                        docs: None,
                        tags: Vec::new(),
                    },
                );
                changed += 1;
                log::info!("导入新 MCP 服务器 '{id}'");
            }
        }
        changed
    };

    // 1) 处理 mcp.servers
    if let Some(mcp_val) = root.get("mcp") {
        if let Some(mcp_tbl) = mcp_val.as_table() {
            if let Some(servers_val) = mcp_tbl.get("servers") {
                if let Some(servers_tbl) = servers_val.as_table() {
                    changed_total += import_servers_tbl(servers_tbl);
                }
            }
        }
    }

    // 2) 处理 mcp_servers
    if let Some(servers_val) = root.get("mcp_servers") {
        if let Some(servers_tbl) = servers_val.as_table() {
            changed_total += import_servers_tbl(servers_tbl);
        }
    }

    Ok(changed_total)
}

/// 将 config.json 中 Codex 的 enabled==true 项以 TOML 形式写入 ~/.codex/config.toml
///
/// 格式策略：
/// - 唯一正确格式：[mcp_servers] 顶层表（Codex 官方标准）
/// - 自动清理错误格式：[mcp.servers]（如果存在）
/// - 读取现有 config.toml；若语法无效则报错，不尝试覆盖
/// - 仅更新 `mcp_servers` 表，保留其它键
/// - 仅写入启用项；无启用项时清理 mcp_servers 表
pub fn sync_enabled_to_codex(config: &MultiAppConfig) -> Result<(), AppError> {
    if !should_sync_codex_mcp() {
        return Ok(());
    }
    use toml_edit::{Item, Table};

    // 1) 收集启用项（Codex 维度）
    let enabled = collect_enabled_servers(&config.mcp.codex);

    // 2) 读取现有 config.toml 文本；保持无效 TOML 的错误返回（不覆盖文件）
    let base_text = crate::codex_config::read_and_validate_codex_config_text()?;

    // 3) 使用 toml_edit 解析（允许空文件）
    let mut doc = if base_text.trim().is_empty() {
        toml_edit::DocumentMut::default()
    } else {
        base_text
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| AppError::McpValidation(format!("解析 config.toml 失败: {e}")))?
    };

    // 4) 清理可能存在的错误格式 [mcp.servers]
    if let Some(mcp_item) = doc.get_mut("mcp") {
        if let Some(tbl) = mcp_item.as_table_like_mut() {
            if tbl.contains_key("servers") {
                log::warn!("检测到错误的 MCP 格式 [mcp.servers]，正在清理并迁移到 [mcp_servers]");
                tbl.remove("servers");
            }
        }
    }

    // 5) 构造目标 servers 表（稳定的键顺序）
    if enabled.is_empty() {
        // 无启用项：移除 mcp_servers 表
        doc.as_table_mut().remove("mcp_servers");
    } else {
        // 构建 servers 表
        let mut servers_tbl = Table::new();
        let mut ids: Vec<_> = enabled.keys().cloned().collect();
        ids.sort();
        for id in ids {
            let spec = enabled.get(&id).expect("spec must exist");
            // 复用通用转换函数（已包含扩展字段支持）
            match json_server_to_toml_table(spec) {
                Ok(table) => {
                    servers_tbl[&id[..]] = Item::Table(table);
                }
                Err(err) => {
                    log::error!("跳过无效的 MCP 服务器 '{id}': {err}");
                }
            }
        }
        // 使用唯一正确的格式：[mcp_servers]
        doc["mcp_servers"] = Item::Table(servers_tbl);
    }

    // 6) 写回（仅改 TOML，不触碰 auth.json）；toml_edit 会尽量保留未改区域的注释/空白/顺序
    let new_text = doc.to_string();
    let path = crate::codex_config::get_codex_config_path();
    crate::config::write_text_file(&path, &new_text)?;
    Ok(())
}

/// 将单个 MCP 服务器同步到 Codex live 配置
/// 始终使用 Codex 官方格式 [mcp_servers]，并清理可能存在的错误格式 [mcp.servers]
pub fn sync_single_server_to_codex(
    _config: &MultiAppConfig,
    id: &str,
    server_spec: &Value,
) -> Result<(), AppError> {
    if !should_sync_codex_mcp() {
        return Ok(());
    }
    use toml_edit::Item;

    // 读取现有的 config.toml
    let config_path = crate::codex_config::get_codex_config_path();

    let mut doc = if config_path.exists() {
        let content =
            std::fs::read_to_string(&config_path).map_err(|e| AppError::io(&config_path, e))?;
        // 解析失败必须报错而不是用空文档顶替：写回空文档会把用户
        // config.toml 里的其它段落（model/model_providers/注释等）整体清空
        content
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| AppError::McpValidation(format!("解析 config.toml 失败: {e}")))?
    } else {
        toml_edit::DocumentMut::new()
    };

    // 清理可能存在的错误格式 [mcp.servers]
    if let Some(mcp_item) = doc.get_mut("mcp") {
        if let Some(tbl) = mcp_item.as_table_like_mut() {
            if tbl.contains_key("servers") {
                log::warn!("检测到错误的 MCP 格式 [mcp.servers]，正在清理并迁移到 [mcp_servers]");
                tbl.remove("servers");
            }
        }
    }

    // 确保 [mcp_servers] 表存在
    if !doc.contains_key("mcp_servers") {
        doc["mcp_servers"] = toml_edit::table();
    }

    // 将 JSON 服务器规范转换为 TOML 表
    let toml_table = json_server_to_toml_table(server_spec)?;

    // 使用唯一正确的格式：[mcp_servers]
    doc["mcp_servers"][id] = Item::Table(toml_table);

    // 写回文件
    let new_text = doc.to_string();
    crate::config::write_text_file(&config_path, &new_text)?;

    Ok(())
}

/// 从 Codex live 配置中移除单个 MCP 服务器
/// 从正确的 [mcp_servers] 表中删除，同时清理可能存在于错误位置 [mcp.servers] 的数据
pub fn remove_server_from_codex(id: &str) -> Result<(), AppError> {
    if !should_sync_codex_mcp() {
        return Ok(());
    }
    let config_path = crate::codex_config::get_codex_config_path();

    if !config_path.exists() {
        return Ok(()); // 文件不存在，无需删除
    }

    let content =
        std::fs::read_to_string(&config_path).map_err(|e| AppError::io(&config_path, e))?;

    // Invalid live config must fail so the service can restore its database record.
    let mut doc = content
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| AppError::McpValidation(format!("解析 Codex config.toml 失败: {e}")))?;

    // 从正确的位置删除：[mcp_servers]
    if let Some(mcp_servers) = doc.get_mut("mcp_servers").and_then(|s| s.as_table_mut()) {
        mcp_servers.remove(id);
    }

    // 同时清理可能存在于错误位置的数据：[mcp.servers]（如果存在）
    if let Some(mcp_table) = doc.get_mut("mcp").and_then(|t| t.as_table_mut()) {
        if let Some(servers) = mcp_table.get_mut("servers").and_then(|s| s.as_table_mut()) {
            if servers.remove(id).is_some() {
                log::warn!("从错误的 MCP 格式 [mcp.servers] 中清理了服务器 '{id}'");
            }
        }
    }

    // 写回文件
    let new_text = doc.to_string();
    crate::config::write_text_file(&config_path, &new_text)?;

    Ok(())
}

// ============================================================================
// TOML 转换辅助函数
// ============================================================================

/// 通用 JSON 值到 TOML 值转换器（支持简单类型和浅层嵌套）
///
/// 支持的类型转换：
/// - String → TOML String
/// - Number (i64) → TOML Integer
/// - Number (f64) → TOML Float
/// - Boolean → TOML Boolean
/// - Array[简单类型] → TOML Array
/// - Object → TOML Inline Table (仅字符串值)
///
/// 不支持的类型（返回 None）：
/// - null
/// - 深度嵌套对象
/// - 混合类型数组
fn json_value_to_toml_item(value: &Value, field_name: &str) -> Option<toml_edit::Item> {
    use toml_edit::{Array, InlineTable, Item};

    match value {
        Value::String(s) => Some(toml_edit::value(s.as_str())),

        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(toml_edit::value(i))
            } else if let Some(f) = n.as_f64() {
                Some(toml_edit::value(f))
            } else {
                log::warn!("跳过字段 '{field_name}': 无法转换的数字类型 {n}");
                None
            }
        }

        Value::Bool(b) => Some(toml_edit::value(*b)),

        Value::Array(arr) => {
            // 只支持简单类型的数组（字符串、数字、布尔）
            let mut toml_arr = Array::default();
            let mut all_same_type = true;

            for item in arr {
                match item {
                    Value::String(s) => toml_arr.push(s.as_str()),
                    Value::Number(n) if n.is_i64() => {
                        if let Some(i) = n.as_i64() {
                            toml_arr.push(i);
                        } else {
                            all_same_type = false;
                            break;
                        }
                    }
                    Value::Number(n) if n.is_f64() => {
                        if let Some(f) = n.as_f64() {
                            toml_arr.push(f);
                        } else {
                            all_same_type = false;
                            break;
                        }
                    }
                    Value::Bool(b) => toml_arr.push(*b),
                    _ => {
                        all_same_type = false;
                        break;
                    }
                }
            }

            if all_same_type && !toml_arr.is_empty() {
                Some(Item::Value(toml_edit::Value::Array(toml_arr)))
            } else {
                log::warn!("跳过字段 '{field_name}': 不支持的数组类型（混合类型或嵌套结构）");
                None
            }
        }

        Value::Object(obj) => {
            // 只支持浅层对象（所有值都是字符串）→ TOML Inline Table
            let mut inline_table = InlineTable::new();
            let mut all_strings = true;

            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    // InlineTable 需要 Value 类型，toml_edit::value() 返回 Item，需要提取内部的 Value
                    inline_table.insert(k, s.into());
                } else {
                    all_strings = false;
                    break;
                }
            }

            if all_strings && !inline_table.is_empty() {
                Some(Item::Value(toml_edit::Value::InlineTable(inline_table)))
            } else {
                log::warn!("跳过字段 '{field_name}': 对象值包含非字符串类型，建议使用子表语法");
                None
            }
        }

        Value::Null => {
            log::debug!("跳过字段 '{field_name}': TOML 不支持 null 值");
            None
        }
    }
}

/// Optional `[mcp_servers.*]` keys Codex 0.153.4 accepts for every transport
/// (`RawMcpServerConfig`, codex-rs/config/src/mcp_types.rs). Codex has no
/// `type` key: the transport is inferred from `command` (stdio) vs `url`
/// (streamable HTTP). A key from the other transport is a hard error
/// ("url is not supported for stdio"), a table with neither is "invalid
/// transport", and under `--strict-config` any key Codex does not know is an
/// "unknown configuration field" — each of these rejects the WHOLE
/// config.toml, not just that server. Only these keys are projected.
const CODEX_MCP_SHARED_FIELDS: &[&str] = &[
    "enabled",
    "required",
    "environment_id",
    "startup_timeout_sec",
    "startup_timeout_ms",
    "tool_timeout_sec",
    "supports_parallel_tool_calls",
    "omit_tools_from",
    "default_tools_approval_mode",
    "enabled_tools",
    "disabled_tools",
    "scopes",
    "name",
    "tools",
];
const CODEX_MCP_STDIO_FIELDS: &[&str] = &["command", "args", "env", "env_vars", "cwd"];
const CODEX_MCP_HTTP_FIELDS: &[&str] = &[
    "url",
    "bearer_token_env_var",
    "http_headers",
    "env_http_headers",
    "http_headers_helper",
    "oauth",
    "oauth_resource",
    "auth",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexMcpTransport {
    Stdio,
    StreamableHttp,
}

/// Resolve the transport Codex will load for a unified server spec. An explicit
/// `type` wins when Codex can serve it (`sse` is kept as an alias of streamable
/// HTTP because the unified spec still carries it); without `type` the
/// transport is inferred from `command`/`url` exactly like Codex itself does.
fn codex_mcp_transport(
    spec: &serde_json::Map<String, Value>,
) -> Result<CodexMcpTransport, AppError> {
    let has_command = spec
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let has_url = spec
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());

    let transport = match spec.get("type").and_then(Value::as_str).map(str::trim) {
        Some("stdio") => CodexMcpTransport::Stdio,
        Some("http" | "sse" | "streamable_http") => CodexMcpTransport::StreamableHttp,
        None | Some("") if has_command => CodexMcpTransport::Stdio,
        None | Some("") if has_url => CodexMcpTransport::StreamableHttp,
        None | Some("") => {
            return Err(AppError::McpValidation(
                "MCP 服务器缺少 command（stdio）或 url（HTTP），Codex 会以 invalid transport 拒绝整个 config.toml"
                    .into(),
            ));
        }
        Some(other) => {
            return Err(AppError::McpValidation(format!(
                "MCP 服务器 type '{other}' 不是 Codex 支持的传输（stdio/http/sse），已拒绝写入"
            )));
        }
    };

    match transport {
        CodexMcpTransport::Stdio if !has_command => Err(AppError::McpValidation(
            "stdio 类型的 MCP 服务器缺少 command，Codex 会拒绝加载整个 config.toml".into(),
        )),
        CodexMcpTransport::StreamableHttp if !has_url => Err(AppError::McpValidation(
            "HTTP/SSE 类型的 MCP 服务器缺少 url，Codex 会拒绝加载整个 config.toml".into(),
        )),
        transport => Ok(transport),
    }
}

/// Helper: 将 JSON MCP 服务器规范转换为 toml_edit::Table
///
/// 策略：
/// 1. 传输由 `codex_mcp_transport` 决定；缺 command/url 或未知 type 直接报错，
///    绝不写出 Codex 会整份拒载的表
/// 2. 核心字段（command, args, env, cwd / url, headers→http_headers）强类型处理
/// 3. 其余字段仅写出 Codex 0.153.4 识别的键（按传输过滤），未知键记录字段名后跳过
pub(super) fn json_server_to_toml_table(spec: &Value) -> Result<toml_edit::Table, AppError> {
    use toml_edit::{Array, Item, Table};

    let obj = spec
        .as_object()
        .ok_or_else(|| AppError::McpValidation("MCP 服务器连接定义必须为 JSON 对象".into()))?;
    let transport = codex_mcp_transport(obj)?;

    let mut t = Table::new();
    // Keys handled by the strongly-typed block below; `type` is our own marker
    // and never reaches Codex.
    let core_fields: &[&str] = match transport {
        CodexMcpTransport::Stdio => &["type", "command", "args", "env", "cwd"],
        CodexMcpTransport::StreamableHttp => &["type", "url", "headers", "http_headers"],
    };
    let transport_fields: &[&str] = match transport {
        CodexMcpTransport::Stdio => CODEX_MCP_STDIO_FIELDS,
        CodexMcpTransport::StreamableHttp => CODEX_MCP_HTTP_FIELDS,
    };

    match transport {
        CodexMcpTransport::Stdio => {
            let cmd = obj
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            t["command"] = toml_edit::value(cmd);

            if let Some(args) = obj.get("args").and_then(|v| v.as_array()) {
                let mut arr_v = Array::default();
                for a in args.iter().filter_map(|x| x.as_str()) {
                    arr_v.push(a);
                }
                if !arr_v.is_empty() {
                    t["args"] = Item::Value(toml_edit::Value::Array(arr_v));
                }
            }

            if let Some(cwd) = obj.get("cwd").and_then(|v| v.as_str()) {
                if !cwd.trim().is_empty() {
                    t["cwd"] = toml_edit::value(cwd);
                }
            }

            if let Some(env) = obj.get("env").and_then(|v| v.as_object()) {
                let mut env_tbl = Table::new();
                for (k, v) in env.iter() {
                    if let Some(s) = v.as_str() {
                        env_tbl[&k[..]] = toml_edit::value(s);
                    }
                }
                if !env_tbl.is_empty() {
                    t["env"] = Item::Table(env_tbl);
                }
            }
        }
        CodexMcpTransport::StreamableHttp => {
            let url = obj
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            t["url"] = toml_edit::value(url);

            // The unified spec stores `headers`; Codex reads `http_headers`.
            // Accept either spelling so a spec imported with Codex's own key
            // does not silently lose its authentication headers.
            let headers = obj
                .get("headers")
                .and_then(|v| v.as_object())
                .or_else(|| obj.get("http_headers").and_then(|v| v.as_object()));
            if let Some(headers) = headers {
                let mut h_tbl = Table::new();
                for (k, v) in headers.iter() {
                    if let Some(s) = v.as_str() {
                        h_tbl[&k[..]] = toml_edit::value(s);
                    }
                }
                if !h_tbl.is_empty() {
                    t["http_headers"] = Item::Table(h_tbl);
                }
            }
        }
    }

    for (key, value) in obj {
        if core_fields.contains(&key.as_str()) {
            continue;
        }
        // 只记录字段名：未知字段同样可能携带 token / secret。
        if !CODEX_MCP_SHARED_FIELDS.contains(&key.as_str())
            && !transport_fields.contains(&key.as_str())
        {
            log::warn!(
                "跳过 Codex 不识别的 MCP 字段 '{key}'（值已省略，strict-config 会拒绝未知键）"
            );
            continue;
        }
        if let Some(toml_item) = json_value_to_toml_item(value, key) {
            t[&key[..]] = toml_item;
            log::debug!("已转换扩展字段 '{key}'（值已省略）");
        }
    }

    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_headers_are_only_written_to_codex_http_headers() {
        let table = json_server_to_toml_table(&json!({
            "type": "http",
            "url": "https://mcp.example.com",
            "headers": {
                "Authorization": "Bearer top-secret",
                "X-Api-Key": "also-secret"
            },
            "startup_timeout_sec": 30
        }))
        .unwrap();

        let headers = table
            .get("http_headers")
            .and_then(|item| item.as_table())
            .expect("Codex http_headers table should be written");
        assert_eq!(
            headers.get("Authorization").and_then(|item| item.as_str()),
            Some("Bearer top-secret")
        );
        assert!(
            table.get("headers").is_none(),
            "legacy headers must not be emitted a second time"
        );
        assert_eq!(
            table
                .get("startup_timeout_sec")
                .and_then(|item| item.as_integer()),
            Some(30)
        );
        assert!(
            table.get("type").is_none(),
            "Codex has no `type` key; strict-config rejects it as unknown"
        );
    }

    #[test]
    fn http_spec_with_codex_native_http_headers_key_keeps_headers() {
        let table = json_server_to_toml_table(&json!({
            "type": "http",
            "url": "https://mcp.example.com",
            "http_headers": { "Authorization": "Bearer top-secret" }
        }))
        .unwrap();
        let headers = table
            .get("http_headers")
            .and_then(|item| item.as_table())
            .expect("http_headers spelled Codex-style must survive");
        assert_eq!(
            headers.get("Authorization").and_then(|item| item.as_str()),
            Some("Bearer top-secret")
        );
    }

    #[test]
    fn transport_without_command_or_url_is_rejected_before_write() {
        // Each of these would make Codex reject the WHOLE config.toml
        // ("invalid transport" / "missing field"), so the writer must fail
        // instead of producing the table.
        for spec in [
            json!({ "type": "stdio" }),
            json!({ "type": "stdio", "command": "   " }),
            json!({ "type": "http" }),
            json!({ "type": "sse", "url": "" }),
            json!({ "args": ["--flag"] }),
            json!({}),
        ] {
            assert!(
                json_server_to_toml_table(&spec).is_err(),
                "spec must be rejected: {spec}"
            );
        }
    }

    #[test]
    fn unknown_transport_type_is_rejected_before_write() {
        let err = json_server_to_toml_table(&json!({
            "type": "websocket",
            "url": "wss://mcp.example.com"
        }))
        .expect_err("unknown transport must not be written");
        assert!(err.to_string().contains("websocket"), "got: {err}");
    }

    #[test]
    fn transport_is_inferred_from_command_or_url_when_type_is_absent() {
        let stdio = json_server_to_toml_table(&json!({ "command": "npx", "args": ["-y", "x"] }))
            .expect("command implies stdio");
        assert_eq!(
            stdio.get("command").and_then(|item| item.as_str()),
            Some("npx")
        );
        assert!(stdio.get("url").is_none());

        let http = json_server_to_toml_table(&json!({ "url": "https://mcp.example.com/mcp" }))
            .expect("url implies streamable http");
        assert_eq!(
            http.get("url").and_then(|item| item.as_str()),
            Some("https://mcp.example.com/mcp")
        );
        assert!(http.get("command").is_none());
    }

    #[test]
    fn cross_transport_and_codex_unknown_keys_are_not_written() {
        // `url`/`http_headers` on a stdio table are hard Codex errors
        // ("url is not supported for stdio"); `timeout`/`verify_ssl` are
        // unknown to Codex and fail --strict-config. Codex-known optional
        // keys must still be projected.
        let table = json_server_to_toml_table(&json!({
            "type": "stdio",
            "command": "uvx",
            "url": "https://leak.example",
            "http_headers": { "Authorization": "Bearer nope" },
            "timeout": 30,
            "verify_ssl": false,
            "startup_timeout_sec": 20,
            "enabled_tools": ["read_file"],
            "cwd": "/srv"
        }))
        .unwrap();

        for forbidden in ["type", "url", "http_headers", "timeout", "verify_ssl"] {
            assert!(
                table.get(forbidden).is_none(),
                "`{forbidden}` must not reach Codex config"
            );
        }
        assert_eq!(
            table
                .get("startup_timeout_sec")
                .and_then(|item| item.as_integer()),
            Some(20)
        );
        assert!(table.get("enabled_tools").is_some());
        assert_eq!(
            table.get("cwd").and_then(|item| item.as_str()),
            Some("/srv")
        );

        let http = json_server_to_toml_table(&json!({
            "type": "http",
            "url": "https://mcp.example.com",
            "args": ["--should-not-leak"],
            "env": { "TOKEN": "x" },
            "bearer_token_env_var": "MCP_TOKEN"
        }))
        .unwrap();
        assert!(http.get("args").is_none(), "args is a stdio-only key");
        assert!(http.get("env").is_none(), "env is a stdio-only key");
        assert_eq!(
            http.get("bearer_token_env_var")
                .and_then(|item| item.as_str()),
            Some("MCP_TOKEN")
        );
    }

    #[test]
    fn import_infers_transport_for_codex_native_tables() {
        // Codex itself never writes `type`; a native `url = ...` table used to
        // be read as stdio and dropped for lacking `command`.
        let root: toml::Table = toml::from_str(
            r#"
[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "MCP_TOKEN"

[mcp_servers.remote.http_headers]
X-Team = "core"

[mcp_servers.local]
command = "npx"
args = ["-y", "server"]

[mcp_servers.legacy_sse]
type = "sse"
url = "https://sse.example.com"

[mcp_servers.newer]
type = "streamable_http"
url = "https://new.example.com/mcp"
"#,
        )
        .unwrap();
        let servers = root["mcp_servers"].as_table().unwrap();

        let remote = codex_mcp_table_to_spec("remote", servers["remote"].as_table().unwrap())
            .expect("url table imports");
        assert_eq!(remote["type"], "http");
        assert_eq!(remote["url"], "https://mcp.example.com/mcp");
        assert_eq!(remote["headers"]["X-Team"], "core");
        assert_eq!(remote["bearer_token_env_var"], "MCP_TOKEN");
        validate_server_spec(&remote).expect("imported http spec validates");

        let local = codex_mcp_table_to_spec("local", servers["local"].as_table().unwrap())
            .expect("command table imports");
        assert_eq!(local["type"], "stdio");
        assert_eq!(local["command"], "npx");

        let legacy =
            codex_mcp_table_to_spec("legacy_sse", servers["legacy_sse"].as_table().unwrap())
                .expect("explicit sse type is honoured");
        assert_eq!(legacy["type"], "sse");

        let newer = codex_mcp_table_to_spec("newer", servers["newer"].as_table().unwrap())
            .expect("streamable_http maps to http");
        assert_eq!(newer["type"], "http");
    }
}
