use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tungstenite::{client::client, Message, WebSocket};
use url::Url;

// 9229 was the original CDP port, but a stale kernel-held socket from an older
// crash could pin it after the owning process exited, making a fresh Codex
// launch unable to bind it. 9330 is the current default; the constant is the
// single source of truth for both the launch argument and the injection client.
pub const CODEX_RENDERER_DEBUG_PORT: u16 = 9330;

const TARGET_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const TARGET_POLL_INTERVAL: Duration = Duration::from_millis(250);
const MODEL_UNLOCK_VERIFY_TIMEOUT: Duration = Duration::from_secs(10);
const MODEL_UNLOCK_VERIFY_POLL_INTERVAL: Duration = Duration::from_millis(200);
const IO_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_HTTP_RESPONSE_BYTES: usize = 512 * 1024;
const MODEL_UNLOCK_SCRIPT: &str = include_str!("resources/codex_model_unlock.js");
const MODEL_UNLOCK_CONFIG_TOKEN: &str = "__CHIMERA_CODEX_MODEL_UNLOCK_CONFIG__";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelUnlockStatus {
    pub attempted: bool,
    pub injected: bool,
    pub model_count: usize,
    pub error: Option<String>,
}

impl CodexModelUnlockStatus {
    pub fn not_configured() -> Self {
        Self {
            attempted: false,
            injected: false,
            model_count: 0,
            error: None,
        }
    }

    fn failed(model_count: usize, error: impl Into<String>) -> Self {
        Self {
            attempted: true,
            injected: false,
            model_count,
            error: Some(error.into()),
        }
    }

    fn injected(model_count: usize) -> Self {
        Self {
            attempted: true,
            injected: true,
            model_count,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRendererUnlockProbe {
    /// Whether the running Codex instance exposes a CDP debug port we can
    /// attach to. A manual launch (or an MSIX/custom-home launch) leaves it
    /// false, which means the model-picker unlock can only take effect after
    /// Chimera++ restarts the instance with the debug port attached.
    pub attachable: bool,
    /// Whether the renderer already reports the Chimera++ model unlock patch
    /// installed. Only meaningful when `attachable` is true.
    pub injected: bool,
    pub model_count: usize,
    pub error: Option<String>,
}

impl CodexRendererUnlockProbe {
    fn not_attachable(error: impl Into<String>) -> Self {
        Self {
            attachable: false,
            injected: false,
            model_count: 0,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CodexRendererModel {
    model: String,
    display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CodexRendererModelUnlockConfig {
    default_model: String,
    models: Vec<CodexRendererModel>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct CdpTarget {
    #[serde(default)]
    id: String,
    #[serde(rename = "type")]
    target_type: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default, rename = "webSocketDebuggerUrl")]
    web_socket_debugger_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CodexRendererUnlockRuntimeStatus {
    installed: bool,
    #[serde(default)]
    document_id: String,
    #[serde(default)]
    model_count: usize,
    #[serde(default)]
    patched: usize,
    #[serde(default)]
    requests_seen: usize,
    #[serde(default)]
    responses_seen: usize,
    #[serde(default)]
    responses_patched: usize,
    #[serde(default)]
    catalog_verified: bool,
}

/// Inject the renderer-only model visibility patch into a newly launched
/// portable Codex instance. Failures are returned as diagnostics so a picker
/// compatibility patch never turns a successful Codex launch into a failure.
pub fn inject_codex_model_unlock(debug_port: u16) -> CodexModelUnlockStatus {
    let payload = match load_model_unlock_config() {
        Ok(Some(payload)) => payload,
        Ok(None) => return CodexModelUnlockStatus::not_configured(),
        Err(error) => return CodexModelUnlockStatus::failed(0, error),
    };
    let model_count = payload.models.len();
    let script = match build_model_unlock_script(&payload) {
        Ok(script) => script,
        Err(error) => return CodexModelUnlockStatus::failed(model_count, error),
    };

    let deadline = Instant::now() + TARGET_WAIT_TIMEOUT;
    let mut last_error = "Codex renderer 的 CDP 页面尚未出现".to_string();
    while Instant::now() < deadline {
        match list_targets(debug_port)
            .and_then(|targets| pick_codex_page_target(&targets))
            .and_then(|target| {
                let websocket_url = target
                    .web_socket_debugger_url
                    .as_deref()
                    .ok_or_else(|| "Codex renderer target 缺少 WebSocket 地址".to_string())?;
                validate_cdp_websocket_url(websocket_url, debug_port)?;
                inject_script(websocket_url, debug_port, &script)
            }) {
            Ok(()) => return CodexModelUnlockStatus::injected(model_count),
            Err(error) => last_error = error,
        }
        std::thread::sleep(TARGET_POLL_INTERVAL);
    }

    CodexModelUnlockStatus::failed(
        model_count,
        format!("Codex 已启动，但第三方模型注入未完成：{last_error}"),
    )
}

/// Produce a diagnostic for launch modes where Chimera++ cannot attach a local
/// renderer debugger. If there is no custom catalog, no warning is emitted.
pub fn unavailable_model_unlock(reason: impl Into<String>) -> CodexModelUnlockStatus {
    match load_model_unlock_config() {
        Ok(Some(payload)) => CodexModelUnlockStatus::failed(payload.models.len(), reason),
        Ok(None) => CodexModelUnlockStatus::not_configured(),
        Err(error) => CodexModelUnlockStatus::failed(0, error),
    }
}

/// Probe an already-running Codex instance for whether the Chimera++ renderer
/// unlock patch can be (or has been) attached.
///
/// This is the read-side counterpart of `inject_codex_model_unlock`: it answers
/// "does this instance expose a CDP debug port, and has the model unlock patch
/// already been installed?" without mutating the renderer. A negative result
/// means the instance was launched outside Chimera++ (or from an MSIX/custom
/// CODEX_HOME), so the user must restart Codex through Chimera++ to unlock the
/// model picker. Errors are intentionally non-fatal and returned as diagnostics.
pub fn probe_codex_renderer_unlock(debug_port: u16) -> CodexRendererUnlockProbe {
    let targets = match list_targets(debug_port) {
        Ok(targets) => targets,
        Err(error) => {
            return CodexRendererUnlockProbe::not_attachable(format!(
                "无法连接 Codex 调试端口 {debug_port}（可能是手动启动或 MSIX/自定义 CODEX_HOME 启动，未附加调试端口）：{error}"
            ));
        }
    };
    let Ok(target) = pick_codex_page_target(&targets) else {
        return CodexRendererUnlockProbe::not_attachable(
            "已连接调试端口，但未找到可注入的 Codex 主页面 target".to_string(),
        );
    };
    let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
        return CodexRendererUnlockProbe::not_attachable(
            "Codex renderer target 缺少 WebSocket 地址".to_string(),
        );
    };
    let Ok(parsed) = validate_cdp_websocket_url(websocket_url, debug_port) else {
        return CodexRendererUnlockProbe::not_attachable(
            "Codex renderer WebSocket 地址校验失败".to_string(),
        );
    };

    let host = parsed.host_str().unwrap_or("127.0.0.1").to_string();
    let port = parsed.port().unwrap_or(debug_port);
    let stream = match TcpStream::connect_timeout(
        &SocketAddr::new(
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .parse()
                .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            port,
        ),
        IO_TIMEOUT,
    ) {
        Ok(stream) => stream,
        Err(error) => {
            return CodexRendererUnlockProbe::not_attachable(format!(
                "连接 Codex renderer WebSocket 失败：{error}"
            ));
        }
    };
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .ok()
        .and_then(|_| stream.set_write_timeout(Some(IO_TIMEOUT)).ok());
    let (mut socket, _) = match client(websocket_url, stream) {
        Ok(socket) => socket,
        Err(error) => {
            return CodexRendererUnlockProbe::not_attachable(format!(
                "Codex renderer WebSocket 握手失败：{error}"
            ));
        }
    };
    let result = send_cdp_command(
        &mut socket,
        1,
        "Runtime.evaluate",
        json!({
            "expression": "globalThis.__CHIMERA_CODEX_MODEL_UNLOCK_STATUS__ ?? null",
            "returnByValue": true,
        }),
    )
    .map(|evaluated| parse_model_unlock_status(&evaluated));
    let _ = socket.close(None);
    match result {
        Ok(Ok(Some(status))) => CodexRendererUnlockProbe {
            attachable: true,
            injected: status.installed,
            model_count: status.model_count,
            error: None,
        },
        Ok(Ok(None)) => CodexRendererUnlockProbe {
            attachable: true,
            injected: false,
            model_count: 0,
            error: None,
        },
        Ok(Err(error)) => CodexRendererUnlockProbe {
            attachable: true,
            injected: false,
            model_count: 0,
            error: Some(format!("读取 renderer 注入状态失败：{error}")),
        },
        Err(error) => {
            CodexRendererUnlockProbe::not_attachable(format!("读取 renderer 注入状态失败：{error}"))
        }
    }
}

fn load_model_unlock_config() -> Result<Option<CodexRendererModelUnlockConfig>, String> {
    let Some(catalog) = crate::codex_config::read_codex_model_catalog_simplified_from_live()
        .map_err(|error| format!("无法读取 Chimera 模型目录：{error}"))?
    else {
        return Ok(None);
    };
    build_model_unlock_config(
        &catalog,
        &crate::codex_config::read_codex_config_text().ok(),
    )
}

fn build_model_unlock_config(
    catalog: &Value,
    config_text: &Option<String>,
) -> Result<Option<CodexRendererModelUnlockConfig>, String> {
    let Some(entries) = catalog.get("models").and_then(Value::as_array) else {
        return Ok(None);
    };

    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for entry in entries {
        let Some(model) = entry
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|model| !model.is_empty())
        else {
            continue;
        };
        if !seen.insert(model.to_string()) {
            continue;
        }
        let display_name = entry
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(model)
            .to_string();
        let description = entry
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let default_reasoning_effort = entry
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        models.push(CodexRendererModel {
            model: model.to_string(),
            display_name,
            description,
            default_reasoning_effort,
        });
    }

    if models.is_empty() {
        return Ok(None);
    }

    let configured_default = config_text
        .as_deref()
        .and_then(|text| text.parse::<toml_edit::DocumentMut>().ok())
        .and_then(|document| {
            document
                .get("model")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(ToOwned::to_owned)
        });
    let default_model = configured_default
        .filter(|candidate| models.iter().any(|entry| entry.model == *candidate))
        .unwrap_or_else(|| models[0].model.clone());

    Ok(Some(CodexRendererModelUnlockConfig {
        default_model,
        models,
    }))
}

fn build_model_unlock_script(payload: &CodexRendererModelUnlockConfig) -> Result<String, String> {
    let config_json = serde_json::to_string(payload)
        .map_err(|error| format!("无法序列化 renderer 模型目录：{error}"))?;
    if !MODEL_UNLOCK_SCRIPT.contains(MODEL_UNLOCK_CONFIG_TOKEN) {
        return Err("内置 Codex 模型注入脚本缺少配置占位符".to_string());
    }
    Ok(MODEL_UNLOCK_SCRIPT.replacen(MODEL_UNLOCK_CONFIG_TOKEN, &config_json, 1))
}

fn list_targets(debug_port: u16) -> Result<Vec<CdpTarget>, String> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), debug_port);
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(350))
        .map_err(|error| format!("无法连接 Codex CDP 端口 {debug_port}：{error}"))?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("无法设置 CDP 读取超时：{error}"))?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("无法设置 CDP 写入超时：{error}"))?;

    let request = format!(
        "GET /json HTTP/1.1\r\nHost: 127.0.0.1:{debug_port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("查询 Codex CDP target 失败：{error}"))?;

    let mut response = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&chunk[..read]);
                if response.len() > MAX_HTTP_RESPONSE_BYTES {
                    return Err("Codex CDP target 响应过大".to_string());
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                break;
            }
            Err(error) => return Err(format!("读取 Codex CDP target 失败：{error}")),
        }
    }
    parse_targets_http_response(&response)
}

fn parse_targets_http_response(response: &[u8]) -> Result<Vec<CdpTarget>, String> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Codex CDP 返回了不完整的 HTTP 响应".to_string())?;
    let headers = String::from_utf8_lossy(&response[..header_end]);
    let status_ok = headers
        .lines()
        .next()
        .is_some_and(|line| line.starts_with("HTTP/") && line.contains(" 200 "));
    if !status_ok {
        return Err(format!(
            "Codex CDP target 查询失败：{}",
            headers.lines().next().unwrap_or("unknown HTTP status")
        ));
    }
    serde_json::from_slice(&response[header_end + 4..])
        .map_err(|error| format!("无法解析 Codex CDP target：{error}"))
}

fn pick_codex_page_target(targets: &[CdpTarget]) -> Result<CdpTarget, String> {
    targets
        .iter()
        .find(|target| is_primary_codex_page_target(target))
        .cloned()
        .ok_or_else(|| "未找到可注入的 Codex 主页面 target".to_string())
}

fn is_primary_codex_page_target(target: &CdpTarget) -> bool {
    if target.target_type != "page"
        || target
            .web_socket_debugger_url
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return false;
    }
    let haystack = format!("{} {}", target.title, target.url).to_ascii_lowercase();
    let is_codex = haystack.contains("codex")
        || (target.title.trim().eq_ignore_ascii_case("chatgpt")
            && (target.url.starts_with("https://chatgpt.com")
                || target.url.starts_with("https://chat.openai.com")));
    is_codex && !is_auxiliary_codex_page(target)
}

fn is_auxiliary_codex_page(target: &CdpTarget) -> bool {
    let Ok(url) = Url::parse(target.url.trim()) else {
        return false;
    };
    let Some((_, route)) = url
        .query_pairs()
        .find(|(key, _)| key.eq_ignore_ascii_case("initialRoute"))
    else {
        return false;
    };
    let route = route.to_ascii_lowercase();
    route == "/avatar-overlay"
        || route == "/chatgpt/quick-chat"
        || route == "/chatgpt/quick-chat-prewarm"
        || route.starts_with("/chatgpt/quick-chat/")
}

fn validate_cdp_websocket_url(websocket_url: &str, expected_port: u16) -> Result<Url, String> {
    let parsed = Url::parse(websocket_url)
        .map_err(|error| format!("Codex CDP WebSocket 地址无效：{error}"))?;
    if parsed.scheme() != "ws" {
        return Err("Codex CDP WebSocket 必须使用本机 ws 协议".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Codex CDP WebSocket 缺少主机".to_string())?;
    let address = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .map_err(|_| "Codex CDP WebSocket 主机必须是 loopback IP".to_string())?;
    if !address.is_loopback() {
        return Err("拒绝连接非 loopback 的 Codex CDP WebSocket".to_string());
    }
    if parsed.port() != Some(expected_port) {
        return Err(format!(
            "Codex CDP WebSocket 端口与预期端口 {expected_port} 不一致"
        ));
    }
    if !parsed.path().starts_with("/devtools/page/") {
        return Err("Codex CDP WebSocket 不是 renderer page target".to_string());
    }
    Ok(parsed)
}

fn inject_script(websocket_url: &str, debug_port: u16, script: &str) -> Result<(), String> {
    let parsed = validate_cdp_websocket_url(websocket_url, debug_port)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Codex CDP WebSocket 缺少主机".to_string())?;
    let address = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .map_err(|_| "Codex CDP WebSocket 主机必须是 loopback IP".to_string())?;
    let port = parsed
        .port()
        .ok_or_else(|| "Codex CDP WebSocket 缺少端口".to_string())?;
    let stream = TcpStream::connect_timeout(&SocketAddr::new(address, port), IO_TIMEOUT)
        .map_err(|error| format!("连接 Codex renderer WebSocket 失败：{error}"))?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("无法设置 renderer 读取超时：{error}"))?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("无法设置 renderer 写入超时：{error}"))?;
    let (mut socket, _) = client(websocket_url, stream)
        .map_err(|error| format!("Codex renderer WebSocket 握手失败：{error}"))?;

    send_cdp_command(&mut socket, 1, "Page.enable", json!({}))?;
    send_cdp_command(&mut socket, 2, "Runtime.enable", json!({}))?;
    send_cdp_command(
        &mut socket,
        3,
        "Page.addScriptToEvaluateOnNewDocument",
        json!({ "source": script }),
    )?;
    let evaluated = send_cdp_command(
        &mut socket,
        4,
        "Runtime.evaluate",
        json!({
            "expression": script,
            "awaitPromise": true,
            "returnByValue": true,
        }),
    )?;
    let initial_status = parse_model_unlock_status(&evaluated)?
        .ok_or_else(|| "Codex renderer 未确认模型注入脚本已安装".to_string())?;
    if !initial_status.installed {
        return Err("Codex renderer 未确认模型注入脚本已安装".to_string());
    }
    if initial_status.document_id.is_empty() {
        return Err("Codex renderer 模型注入脚本缺少文档标识".to_string());
    }

    // The renderer may have already cached its first model/list response by the
    // time CDP becomes available. Reload after registering the new-document
    // script so the patch runs before React Query sends and caches that request.
    send_cdp_command(
        &mut socket,
        5,
        "Page.reload",
        json!({ "ignoreCache": true }),
    )?;

    let deadline = Instant::now() + MODEL_UNLOCK_VERIFY_TIMEOUT;
    let mut command_id = 6;
    let mut last_status = None;
    let mut last_error = None;
    while Instant::now() < deadline {
        std::thread::sleep(MODEL_UNLOCK_VERIFY_POLL_INTERVAL);
        match evaluate_model_unlock_status(&mut socket, command_id) {
            Ok(Some(status)) => {
                let is_reloaded_document = status.installed
                    && !status.document_id.is_empty()
                    && status.document_id != initial_status.document_id;
                if model_catalog_ready_after_reload(&initial_status.document_id, &status) {
                    let _ = socket.close(None);
                    return Ok(());
                }
                if is_reloaded_document {
                    last_status = Some(status);
                }
                last_error = None;
            }
            Ok(None) => {
                last_error = Some("重载后的 renderer 尚未初始化模型注入脚本".to_string());
            }
            Err(error) => {
                // Navigation briefly destroys the old execution context. Keep
                // polling until the new document and preload bridge are ready.
                last_error = Some(error);
            }
        }
        command_id += 1;
    }

    let _ = socket.close(None);
    if let Some(status) = last_status {
        return Err(format!(
            "Codex renderer 已重载，但模型列表未通过校验（请求 {}，响应 {}，成功改写 {}，目录校验 {}，通用补丁 {}，模型 {}）",
            status.requests_seen,
            status.responses_seen,
            status.responses_patched,
            status.catalog_verified,
            status.patched,
            status.model_count,
        ));
    }
    Err(format!(
        "Codex renderer 重载后未能确认模型注入脚本：{}",
        last_error.unwrap_or_else(|| "等待新文档超时".to_string())
    ))
}

fn model_catalog_ready_after_reload(
    initial_document_id: &str,
    status: &CodexRendererUnlockRuntimeStatus,
) -> bool {
    status.installed
        && !status.document_id.is_empty()
        && status.document_id != initial_document_id
        && status.catalog_verified
}

fn evaluate_model_unlock_status(
    socket: &mut WebSocket<TcpStream>,
    id: u64,
) -> Result<Option<CodexRendererUnlockRuntimeStatus>, String> {
    let evaluated = send_cdp_command(
        socket,
        id,
        "Runtime.evaluate",
        json!({
            "expression": "globalThis.__CHIMERA_CODEX_MODEL_UNLOCK_STATUS__ ?? null",
            "returnByValue": true,
        }),
    )?;
    parse_model_unlock_status(&evaluated)
}

fn parse_model_unlock_status(
    evaluated: &Value,
) -> Result<Option<CodexRendererUnlockRuntimeStatus>, String> {
    if let Some(exception) = evaluated.get("exceptionDetails") {
        return Err(format!(
            "Codex renderer 执行模型注入状态检查失败：{exception}"
        ));
    }
    let Some(value) = evaluated.pointer("/result/value") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    serde_json::from_value(value.clone())
        .map(Some)
        .map_err(|error| format!("无法解析 Codex renderer 模型注入状态：{error}"))
}

fn send_cdp_command(
    socket: &mut WebSocket<TcpStream>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let payload = serde_json::to_string(&json!({
        "id": id,
        "method": method,
        "params": params,
    }))
    .map_err(|error| format!("无法序列化 CDP 命令 {method}：{error}"))?;
    socket
        .send(Message::Text(payload.into()))
        .map_err(|error| format!("发送 CDP 命令 {method} 失败：{error}"))?;

    loop {
        let message = socket
            .read()
            .map_err(|error| format!("等待 CDP 命令 {method} 响应失败：{error}"))?;
        match message {
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_ref())
                    .map_err(|error| format!("无法解析 CDP 响应：{error}"))?;
                if value.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    return Err(format!("CDP 命令 {method} 返回错误：{error}"));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
            Message::Binary(bytes) => {
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("无法解析二进制 CDP 响应：{error}"))?;
                if value.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    return Err(format!("CDP 命令 {method} 返回错误：{error}"));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
            Message::Ping(bytes) => socket
                .send(Message::Pong(bytes))
                .map_err(|error| format!("回复 Codex renderer 心跳失败：{error}"))?,
            Message::Close(frame) => {
                return Err(format!("Codex renderer 提前关闭 WebSocket：{frame:?}"));
            }
            Message::Pong(_) | Message::Frame(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_model_unlock_config, build_model_unlock_script, model_catalog_ready_after_reload,
        parse_model_unlock_status, parse_targets_http_response, pick_codex_page_target,
        validate_cdp_websocket_url, CodexRendererModelUnlockConfig, CodexRendererUnlockProbe,
        CodexRendererUnlockRuntimeStatus, CODEX_RENDERER_DEBUG_PORT,
    };
    use serde_json::json;

    #[test]
    fn payload_deduplicates_models_and_keeps_configured_default() {
        let catalog = json!({
            "models": [
                { "model": "claude-sonnet-5", "displayName": "Claude Sonnet 5" },
                { "model": "claude-opus-5", "displayName": "Claude Opus 5" },
                { "model": "claude-sonnet-5", "displayName": "Duplicate" }
            ]
        });
        let config = Some("model = \"claude-opus-5\"\n".to_string());
        let payload = build_model_unlock_config(&catalog, &config)
            .expect("payload builds")
            .expect("payload exists");
        assert_eq!(payload.default_model, "claude-opus-5");
        assert_eq!(payload.models.len(), 2);
        assert_eq!(payload.models[0].display_name, "Claude Sonnet 5");
    }

    #[test]
    fn target_picker_ignores_non_codex_and_quick_chat_pages() {
        let body = format!(
            r#"[
              {{"id":"chrome","type":"page","title":"New Tab","url":"chrome://newtab","webSocketDebuggerUrl":"ws://127.0.0.1:{0}/devtools/page/1"}},
              {{"id":"quick","type":"page","title":"Codex","url":"app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm","webSocketDebuggerUrl":"ws://127.0.0.1:{0}/devtools/page/2"}},
              {{"id":"codex","type":"page","title":"Codex","url":"app://-/index.html","webSocketDebuggerUrl":"ws://127.0.0.1:{0}/devtools/page/3"}}
            ]"#,
            CODEX_RENDERER_DEBUG_PORT
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let targets = parse_targets_http_response(response.as_bytes()).expect("targets parse");
        let selected = pick_codex_page_target(&targets).expect("Codex target selected");
        assert_eq!(selected.id, "codex");
    }

    #[test]
    fn websocket_validation_requires_loopback_expected_port_and_page_path() {
        assert!(validate_cdp_websocket_url(
            &format!("ws://127.0.0.1:{CODEX_RENDERER_DEBUG_PORT}/devtools/page/renderer"),
            CODEX_RENDERER_DEBUG_PORT
        )
        .is_ok());
        assert!(validate_cdp_websocket_url(
            &format!("ws://192.168.1.2:{CODEX_RENDERER_DEBUG_PORT}/devtools/page/renderer"),
            CODEX_RENDERER_DEBUG_PORT
        )
        .is_err());
        assert!(validate_cdp_websocket_url(
            "ws://127.0.0.1:9230/devtools/page/renderer",
            CODEX_RENDERER_DEBUG_PORT
        )
        .is_err());
    }

    #[test]
    fn injected_script_covers_model_paths_without_auth_mutation() {
        let payload = CodexRendererModelUnlockConfig {
            default_model: "claude-sonnet-5".to_string(),
            models: vec![super::CodexRendererModel {
                model: "claude-sonnet-5".to_string(),
                display_name: "Claude Sonnet 5".to_string(),
                description: None,
                default_reasoning_effort: None,
            }],
        };
        let script = build_model_unlock_script(&payload).expect("script builds");
        for expected in [
            "Response.prototype.json",
            "available_models",
            "includeHidden",
            "model/list",
            "requestsSeen",
            "responsesPatched",
            "catalogVerified",
            "documentId",
            "modelPayloadLooksPatchable",
            "String(args[0]) === \"107580212\"",
            "claude-sonnet-5",
        ] {
            assert!(script.contains(expected), "missing {expected}");
        }
        assert!(!script.contains("auth.json"));
        assert!(!script.contains("OPENAI_API_KEY"));
        assert!(!script.contains("access_token"));
    }
    #[test]
    fn runtime_status_requires_a_new_verified_document() {
        let mut status = CodexRendererUnlockRuntimeStatus {
            installed: true,
            document_id: "before".to_string(),
            model_count: 2,
            patched: 1,
            requests_seen: 1,
            responses_seen: 1,
            responses_patched: 1,
            catalog_verified: true,
        };
        assert!(!model_catalog_ready_after_reload("before", &status));
        status.document_id = "after".to_string();
        assert!(model_catalog_ready_after_reload("before", &status));
        status.catalog_verified = false;
        assert!(!model_catalog_ready_after_reload("before", &status));
    }

    #[test]
    fn runtime_status_parser_reads_renderer_diagnostics() {
        let evaluated = json!({
            "result": {
                "type": "object",
                "value": {
                    "installed": true,
                    "documentId": "document-2",
                    "modelCount": 4,
                    "patched": 2,
                    "requestsSeen": 1,
                    "responsesSeen": 1,
                    "responsesPatched": 1,
                    "catalogVerified": true
                }
            }
        });
        let status = parse_model_unlock_status(&evaluated)
            .expect("status parses")
            .expect("status exists");
        assert_eq!(status.document_id, "document-2");
        assert_eq!(status.model_count, 4);
        assert_eq!(status.responses_patched, 1);
        assert!(status.catalog_verified);
        assert!(
            parse_model_unlock_status(&json!({"result": {"value": null}}))
                .expect("null status is valid")
                .is_none()
        );
    }

    #[test]
    fn probe_serializes_attachable_injected_and_diagnostic_states() {
        let attached = CodexRendererUnlockProbe {
            attachable: true,
            injected: true,
            model_count: 16,
            error: None,
        };
        let value = serde_json::to_value(&attached).expect("serializes");
        assert_eq!(value["attachable"], true);
        assert_eq!(value["injected"], true);
        assert_eq!(value["modelCount"], 16);
        assert!(value["error"].is_null());

        let unattached = CodexRendererUnlockProbe {
            attachable: false,
            injected: false,
            model_count: 0,
            error: Some("no debug port".to_string()),
        };
        let value = serde_json::to_value(&unattached).expect("serializes");
        assert_eq!(value["attachable"], false);
        assert_eq!(value["error"], "no debug port");
    }

    #[test]
    fn probe_not_attachable_keeps_diagnostic() {
        let probe = CodexRendererUnlockProbe::not_attachable("手动启动未附加调试端口");
        assert!(!probe.attachable);
        assert!(!probe.injected);
        assert_eq!(probe.model_count, 0);
        assert!(probe.error.is_some());
    }
}
