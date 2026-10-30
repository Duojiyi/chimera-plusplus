//! 官方订阅额度查询服务
//!
//! 读取 CLI 工具的已有 OAuth 凭据，查询官方订阅额度。
//! 第一层：仅读取凭据，不实现登录/刷新。

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use std::collections::HashMap;

use crate::config;

/// Cap for a successful quota/usage response body. The real payload is a
/// small JSON object; this leaves generous headroom while still bounding
/// worst-case memory use (MH-16).
const MAX_QUOTA_RESPONSE_BYTES: usize = 256 * 1024;
/// Cap for an error response body we only read for diagnostics (never
/// surfaced verbatim to the caller — see `read_response_text_limited`).
const MAX_QUOTA_ERROR_BODY_BYTES: usize = 64 * 1024;

/// Read a response body with a hard byte cap instead of buffering an
/// unbounded amount of untrusted network input (MH-16: this endpoint is not
/// under our control and could return an oversized or slow-trickling body).
async fn read_response_bytes_limited(
    response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!("{label} exceeds the {max_bytes}-byte limit"));
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Failed to read {label}: {error}"))?;
        if body.len() + chunk.len() > max_bytes {
            return Err(format!("{label} exceeds the {max_bytes}-byte limit"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Same as [`read_response_bytes_limited`], decoded lossily for a
/// diagnostics-only string (never a public API/JSON parse target).
async fn read_response_text_limited(
    response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<String, String> {
    let body = read_response_bytes_limited(response, max_bytes, label).await?;
    Ok(String::from_utf8_lossy(&body).into_owned())
}

// ── 数据类型 ──────────────────────────────────────────────

/// 凭据状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialStatus {
    Valid,
    Expired,
    NotFound,
    ParseError,
}

/// 单个限速窗口（如 5小时会话、7天周期）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaTier {
    /// 窗口标识：five_hour, seven_day, seven_day_opus, seven_day_sonnet 等
    pub name: String,
    /// 使用百分比 0–100
    pub utilization: f64,
    /// ISO 8601 重置时间
    pub resets_at: Option<String>,
    /// ZenMux: 已用额度（USD）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_value_usd: Option<f64>,
    /// ZenMux: 窗口上限（USD）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_value_usd: Option<f64>,
}

/// 超额使用信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraUsage {
    pub is_enabled: bool,
    pub monthly_limit: Option<f64>,
    pub used_credits: Option<f64>,
    pub utilization: Option<f64>,
    pub currency: Option<String>,
    /// ISO 8601 重置时间（月度超额周期）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

/// 订阅额度查询结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuota {
    pub tool: String,
    pub credential_status: CredentialStatus,
    pub credential_message: Option<String>,
    pub success: bool,
    pub tiers: Vec<QuotaTier>,
    pub extra_usage: Option<ExtraUsage>,
    pub error: Option<String>,
    pub queried_at: Option<i64>,
}

impl SubscriptionQuota {
    pub(crate) fn not_found(tool: &str) -> Self {
        Self {
            tool: tool.to_string(),
            credential_status: CredentialStatus::NotFound,
            credential_message: None,
            success: false,
            tiers: vec![],
            extra_usage: None,
            error: None,
            queried_at: None,
        }
    }

    pub(crate) fn error(tool: &str, status: CredentialStatus, message: String) -> Self {
        Self {
            tool: tool.to_string(),
            credential_status: status,
            credential_message: Some(message.clone()),
            success: false,
            tiers: vec![],
            extra_usage: None,
            error: Some(message),
            queried_at: Some(now_millis()),
        }
    }
}

// ── Claude 凭据读取 ──────────────────────────────────────

/// Claude OAuth 凭据文件中的嵌套结构
#[derive(Deserialize)]
struct ClaudeOAuthEntry {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    #[serde(rename = "expiresAt")]
    expires_at: Option<serde_json::Value>,
}

/// 读取 Claude OAuth 凭据
///
/// 按优先级尝试以下来源：
/// 1. macOS Keychain (service: "Claude Code-credentials")
/// 2. 凭据文件 ~/.claude/.credentials.json
///
/// JSON 格式（两种 key 都兼容）：
/// {"claudeAiOauth": {"accessToken": "...", "expiresAt": ...}}
/// {"claude.ai_oauth": {"accessToken": "...", "expiresAt": ...}}
fn read_claude_credentials() -> (Option<String>, CredentialStatus, Option<String>) {
    // 来源 1: macOS Keychain
    #[cfg(target_os = "macos")]
    {
        if let Some(result) = read_claude_credentials_from_keychain() {
            return result;
        }
    }

    // 来源 2: 凭据文件
    read_claude_credentials_from_file()
}

/// 从 macOS Keychain 读取 Claude 凭据
#[cfg(target_os = "macos")]
fn read_claude_credentials_from_keychain(
) -> Option<(Option<String>, CredentialStatus, Option<String>)> {
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None; // Keychain 中无此条目，回退到文件
    }

    let json_str = String::from_utf8(output.stdout).ok()?;
    let json_str = json_str.trim();
    if json_str.is_empty() {
        return None;
    }

    Some(parse_claude_credentials_json(json_str))
}

/// 从文件读取 Claude 凭据
fn read_claude_credentials_from_file() -> (Option<String>, CredentialStatus, Option<String>) {
    let cred_path = config::get_claude_config_dir().join(".credentials.json");

    if !cred_path.exists() {
        return (None, CredentialStatus::NotFound, None);
    }

    let content = match std::fs::read_to_string(&cred_path) {
        Ok(c) => c,
        Err(e) => {
            return (
                None,
                CredentialStatus::ParseError,
                Some(format!("Failed to read credentials file: {e}")),
            );
        }
    };

    // Editors on Windows may save it with a byte-order mark.
    parse_claude_credentials_json(content.strip_prefix('\u{feff}').unwrap_or(&content))
}

/// 解析 Claude 凭据 JSON（Keychain 和文件共用）
fn parse_claude_credentials_json(
    content: &str,
) -> (Option<String>, CredentialStatus, Option<String>) {
    let parsed: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(e) => {
            return (
                None,
                CredentialStatus::ParseError,
                Some(format!("Failed to parse credentials JSON: {e}")),
            );
        }
    };

    // 兼容两种 key 名
    let entry_value = parsed
        .get("claudeAiOauth")
        .or_else(|| parsed.get("claude.ai_oauth"));

    let entry_value = match entry_value {
        Some(v) => v,
        None => {
            return (
                None,
                CredentialStatus::ParseError,
                Some("No OAuth entry found in credentials".to_string()),
            );
        }
    };

    let entry: ClaudeOAuthEntry = match serde_json::from_value(entry_value.clone()) {
        Ok(e) => e,
        Err(e) => {
            return (
                None,
                CredentialStatus::ParseError,
                Some(format!("Failed to parse OAuth entry: {e}")),
            );
        }
    };

    let access_token = match entry.access_token {
        Some(t) if !t.is_empty() => t,
        _ => {
            return (
                None,
                CredentialStatus::ParseError,
                Some("accessToken is empty or missing".to_string()),
            );
        }
    };

    // 检查 token 是否过期
    if let Some(expires_at) = entry.expires_at {
        if is_token_expired(&expires_at) {
            return (
                Some(access_token),
                CredentialStatus::Expired,
                Some("OAuth token has expired".to_string()),
            );
        }
    }

    (Some(access_token), CredentialStatus::Valid, None)
}

/// 判断 token 是否过期，兼容 Unix 时间戳（秒/毫秒）和 ISO 字符串
fn is_token_expired(expires_at: &serde_json::Value) -> bool {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    match expires_at {
        serde_json::Value::Number(n) => {
            if let Some(ts) = n.as_u64() {
                // 区分秒和毫秒（毫秒级时间戳大于 1e12）
                let ts_secs = if ts > 1_000_000_000_000 {
                    ts / 1000
                } else {
                    ts
                };
                ts_secs < now_secs
            } else {
                false
            }
        }
        serde_json::Value::String(s) => {
            // 尝试解析 ISO 8601 格式
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                (dt.timestamp() as u64) < now_secs
            } else if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
            {
                (dt.and_utc().timestamp() as u64) < now_secs
            } else {
                false // 无法解析时不视为过期
            }
        }
        _ => false,
    }
}

// ── Claude API 查询 ──────────────────────────────────────

/// Claude OAuth 用量 API 响应中的单个窗口
#[derive(Deserialize)]
struct ApiUsageWindow {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

/// Claude OAuth 用量 API 响应中的超额用量
#[derive(Deserialize)]
struct ApiExtraUsage {
    is_enabled: Option<bool>,
    monthly_limit: Option<f64>,
    used_credits: Option<f64>,
    utilization: Option<f64>,
    currency: Option<String>,
    resets_at: Option<String>,
}

/// 已知的 Claude 用量窗口名称。`QuotaTier::name` 会是其中之一。
pub const TIER_FIVE_HOUR: &str = "five_hour";
pub const TIER_SEVEN_DAY: &str = "seven_day";
pub const TIER_SEVEN_DAY_OPUS: &str = "seven_day_opus";
pub const TIER_SEVEN_DAY_SONNET: &str = "seven_day_sonnet";
/// 按模型的周窗口（新版 `limits` 数组）：`model_weekly:<模型显示名>`。
pub const TIER_MODEL_WEEKLY_PREFIX: &str = "model_weekly:";

/// Tier name for flat usage rows: the per-model weekly windows read as
/// "每周 · <model>"; known tier ids stay as they are for the frontend labels.
pub(crate) fn tier_display_name(name: &str) -> String {
    match name.strip_prefix(TIER_MODEL_WEEKLY_PREFIX) {
        Some(model) => format!("每周 · {model}"),
        None => name.to_string(),
    }
}

/// Coding Plan（Kimi / MiniMax）的周窗口 tier 名。与 `coding_plan::query_*`
/// 写入、tray 渲染、commands::provider 扁平化三处共用同一标识。
pub const TIER_WEEKLY_LIMIT: &str = "weekly_limit";

/// 月窗口 tier 名。火山方舟 Agent Plan / Coding Plan 有 5h / 周 / 月 三个展示
/// 窗口（Kimi / MiniMax 只有 5h + 周），月窗口共用此标识；前端 `TIER_I18N_KEYS`
/// 映射到 `subscription.monthly`。
pub const TIER_MONTHLY: &str = "monthly";

/// Codex 免费方案的 30 天（月）滚动窗口 tier 名。付费方案的次要窗口是 7 天
/// (`seven_day`)，免费方案则是 30 天。由 `window_seconds_to_tier_name` 产出、
/// tray 的月分组渲染、前端 `TIER_I18N_KEYS` 映射到 `subscription.thirtyDay`
/// 三处共用同一标识。见 #3651。
pub const TIER_THIRTY_DAY: &str = "30_day";

/// Gemini 用量分组名称（按模型而非时间窗口）。`classify_gemini_model` 输出。
pub const TIER_GEMINI_PRO: &str = "gemini_pro";
pub const TIER_GEMINI_FLASH: &str = "gemini_flash";
pub const TIER_GEMINI_FLASH_LITE: &str = "gemini_flash_lite";

const KNOWN_TIERS: &[&str] = &[
    TIER_FIVE_HOUR,
    TIER_SEVEN_DAY,
    TIER_SEVEN_DAY_OPUS,
    TIER_SEVEN_DAY_SONNET,
];

/// 查询 Claude 官方订阅额度
///
/// 瞬时传输失败（网络/超时/读体中断）返回 `Err`（前端 reject → retry + 保留上次
/// 成功值）；确定性失败（鉴权/非 2xx/响应体非法 JSON）返回 `Ok(success:false)`。
/// codex/gemini 两个查询函数遵守同一约定。
pub(crate) async fn query_claude_quota(access_token: &str) -> Result<SubscriptionQuota, String> {
    let client = crate::proxy::http_client::get();

    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error: {e}")),
    };

    let status = resp.status();

    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(SubscriptionQuota::error(
            "claude",
            CredentialStatus::Expired,
            format!("Authentication failed (HTTP {status}). Please re-login with Claude CLI."),
        ));
    }

    if !status.is_success() {
        // The body is not echoed: it is unbounded and of no use to the user.
        return Ok(SubscriptionQuota::error(
            "claude",
            CredentialStatus::Valid,
            format!("API error (HTTP {status})"),
        ));
    }

    // 先读完有界响应体再解析：读体失败（超时/连接中断/超限）是瞬时 → Err；
    // 拿到完整响应体后解析失败才是确定性。
    let raw = read_response_bytes_limited(resp, MAX_QUOTA_RESPONSE_BYTES, "Claude quota response")
        .await?;
    let body: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => {
            return Ok(SubscriptionQuota::error(
                "claude",
                CredentialStatus::Valid,
                format!("Failed to parse API response: {e}"),
            ));
        }
    };

    let (tiers, extra_usage) = parse_claude_usage(&body);

    Ok(SubscriptionQuota {
        tool: "claude".to_string(),
        credential_status: CredentialStatus::Valid,
        credential_message: None,
        success: true,
        tiers,
        extra_usage,
        error: None,
        queried_at: Some(now_millis()),
    })
}

/// 解析 `/api/oauth/usage` 响应体：时间窗口、按模型的周窗口与超额用量。
pub(crate) fn parse_claude_usage(body: &serde_json::Value) -> (Vec<QuotaTier>, Option<ExtraUsage>) {
    // 解析已知的 tier 窗口
    let mut tiers = Vec::new();
    for &tier_name in KNOWN_TIERS {
        if let Some(window) = body.get(tier_name) {
            if let Ok(w) = serde_json::from_value::<ApiUsageWindow>(window.clone()) {
                if let Some(util) = w.utilization {
                    tiers.push(QuotaTier {
                        name: tier_name.to_string(),
                        utilization: util,
                        resets_at: w.resets_at,
                        used_value_usd: None,
                        max_value_usd: None,
                    });
                }
            }
        }
    }

    // 也解析未知窗口（API 可能返回新的窗口类型）
    if let Some(obj) = body.as_object() {
        for (key, value) in obj {
            if key == "extra_usage" || key == "limits" || KNOWN_TIERS.contains(&key.as_str()) {
                continue;
            }
            if let Ok(w) = serde_json::from_value::<ApiUsageWindow>(value.clone()) {
                if let Some(util) = w.utilization {
                    tiers.push(QuotaTier {
                        name: key.clone(),
                        utilization: util,
                        resets_at: w.resets_at,
                        used_value_usd: None,
                        max_value_usd: None,
                    });
                }
            }
        }
    }

    // 解析超额使用
    let extra_usage = body.get("extra_usage").and_then(|v| {
        serde_json::from_value::<ApiExtraUsage>(v.clone())
            .ok()
            .map(|e| ExtraUsage {
                is_enabled: e.is_enabled.unwrap_or(false),
                monthly_limit: e.monthly_limit,
                used_credits: e.used_credits,
                utilization: e.utilization,
                currency: e.currency,
                resets_at: e.resets_at,
            })
    });

    // Adapted from realiti4/claude-swap 72ccd58 (src/claude_swap/oauth.py)
    // Per-model weekly limits (e.g. Fable) only appear in the newer `limits`
    // array, as entries with `scope.model.display_name` + `percent`.
    if let Some(limits) = body.get("limits").and_then(serde_json::Value::as_array) {
        for limit in limits {
            let name = limit
                .pointer("/scope/model/display_name")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            let percent = limit
                .get("percent")
                .and_then(serde_json::Value::as_f64)
                .filter(|percent| percent.is_finite());
            if let (Some(name), Some(percent)) = (name, percent) {
                tiers.push(QuotaTier {
                    name: format!("{TIER_MODEL_WEEKLY_PREFIX}{name}"),
                    utilization: percent,
                    resets_at: limit
                        .get("resets_at")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                    used_value_usd: None,
                    max_value_usd: None,
                });
            }
        }
    }

    (tiers, extra_usage)
}

// ── Codex 凭据读取 ──────────────────────────────────────

#[derive(Deserialize)]
struct CodexAuthJson {
    auth_mode: Option<String>,
    tokens: Option<CodexTokens>,
    last_refresh: Option<String>,
}

#[derive(Deserialize)]
struct CodexTokens {
    access_token: Option<String>,
    account_id: Option<String>,
}

/// (access_token, account_id, status, message)
type CodexCredentials = (
    Option<String>,
    Option<String>,
    CredentialStatus,
    Option<String>,
);

/// 读取 Codex OAuth 凭据
///
/// 按优先级尝试以下来源：
/// 1. macOS Keychain (service: "Codex Auth")
/// 2. 凭据文件 ~/.codex/auth.json
///
/// 仅 auth_mode == "chatgpt" (OAuth) 时有效，API key 模式不支持用量查询。
fn read_codex_credentials() -> CodexCredentials {
    #[cfg(target_os = "macos")]
    {
        if let Some(result) = read_codex_credentials_from_keychain() {
            return result;
        }
    }

    read_codex_credentials_from_file()
}

/// 从 macOS Keychain 读取 Codex 凭据
#[cfg(target_os = "macos")]
fn read_codex_credentials_from_keychain() -> Option<CodexCredentials> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "Codex Auth", "-w"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let json_str = String::from_utf8(output.stdout).ok()?;
    let json_str = json_str.trim();
    if json_str.is_empty() {
        return None;
    }

    Some(parse_codex_credentials_json(json_str))
}

/// 从文件读取 Codex 凭据
fn read_codex_credentials_from_file() -> CodexCredentials {
    let auth_path = crate::codex_config::get_codex_auth_path();

    if !auth_path.exists() {
        return (None, None, CredentialStatus::NotFound, None);
    }

    let content = match std::fs::read_to_string(&auth_path) {
        Ok(c) => c,
        Err(e) => {
            return (
                None,
                None,
                CredentialStatus::ParseError,
                Some(format!("Failed to read Codex auth file: {e}")),
            );
        }
    };

    parse_codex_credentials_json(&content)
}

/// 解析 Codex 凭据 JSON（Keychain 和文件共用）
fn parse_codex_credentials_json(content: &str) -> CodexCredentials {
    let auth: CodexAuthJson = match serde_json::from_str(content) {
        Ok(a) => a,
        Err(e) => {
            return (
                None,
                None,
                CredentialStatus::ParseError,
                Some(format!("Failed to parse Codex auth JSON: {e}")),
            );
        }
    };

    // 仅 OAuth 模式有用量数据
    if auth.auth_mode.as_deref() != Some("chatgpt") {
        return (
            None,
            None,
            CredentialStatus::NotFound,
            Some("Codex not using OAuth mode".to_string()),
        );
    }

    let tokens = match auth.tokens {
        Some(t) => t,
        None => {
            return (
                None,
                None,
                CredentialStatus::ParseError,
                Some("No tokens in Codex auth".to_string()),
            );
        }
    };

    let access_token = match tokens.access_token {
        Some(t) if !t.is_empty() => t,
        _ => {
            return (
                None,
                None,
                CredentialStatus::ParseError,
                Some("access_token is empty or missing".to_string()),
            );
        }
    };

    // 检查 token 是否可能过期（距上次刷新 > 8 天）
    if let Some(ref last_refresh) = auth.last_refresh {
        if is_codex_token_stale(last_refresh) {
            return (
                Some(access_token),
                tokens.account_id,
                CredentialStatus::Expired,
                Some("Codex token may be stale (>8 days since last refresh)".to_string()),
            );
        }
    }

    (
        Some(access_token),
        tokens.account_id,
        CredentialStatus::Valid,
        None,
    )
}

/// 判断 Codex token 是否可能过期（Codex CLI 在 >8 天时自动刷新）
fn is_codex_token_stale(last_refresh: &str) -> bool {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(last_refresh) {
        let age_secs = now_secs.saturating_sub(dt.timestamp() as u64);
        age_secs > 8 * 24 * 3600
    } else {
        false
    }
}

// ── Codex API 查询 ──────────────────────────────────────

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

#[derive(Deserialize)]
struct CodexRateLimitWindow {
    used_percent: Option<f64>,
    limit_window_seconds: Option<i64>,
    reset_at: Option<i64>,
    reset_after_seconds: Option<i64>,
}

#[derive(Deserialize)]
struct CodexRateLimit {
    primary_window: Option<CodexRateLimitWindow>,
    secondary_window: Option<CodexRateLimitWindow>,
}

#[derive(Deserialize)]
struct CodexUsageResponse {
    account_id: Option<String>,
    rate_limit: Option<CodexRateLimit>,
}

/// 根据窗口秒数映射到 tier 名称（与 Claude 的命名兼容以复用前端 i18n）
fn window_seconds_to_tier_name(secs: i64) -> String {
    match secs {
        18000 => TIER_FIVE_HOUR.to_string(),
        604800 => TIER_SEVEN_DAY.to_string(),
        // Codex 免费方案的 30 天窗口。显式映射到常量，与 tray 月分组、前端
        // TIER_I18N_KEYS 保持同一标识（否则动态回退虽也得到 "30_day"，但字符串
        // 分散在多处、易和托盘/前端白名单脱节）。见 #3651。
        2_592_000 => TIER_THIRTY_DAY.to_string(),
        s => {
            let hours = s / 3600;
            if hours >= 24 {
                format!("{}_day", hours / 24)
            } else {
                format!("{}_hour", hours)
            }
        }
    }
}

/// Unix 时间戳（秒）转 ISO 8601 字符串
fn unix_ts_to_iso(ts: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(ts, 0).map(|dt| dt.to_rfc3339())
}

/// What a non-success `wham/usage` status means. Only 401 says the login
/// itself was rejected: 403 is typically a network, region or edge block,
/// so the login stays valid. Every message keeps `HTTP <code>`, which the
/// quota hooks read to tell transient failures (5xx, 429) from lasting ones.
fn codex_quota_failure(
    status: reqwest::StatusCode,
    expired_message: &str,
) -> Option<(CredentialStatus, String)> {
    if status.is_success() {
        return None;
    }
    let code = status.as_u16();
    Some(match code {
        401 => (
            CredentialStatus::Expired,
            format!("{expired_message} (HTTP 401)"),
        ),
        403 => (
            CredentialStatus::Valid,
            "无法访问官方额度服务（HTTP 403），可能是网络或地区限制".to_string(),
        ),
        429 => (
            CredentialStatus::Valid,
            "查询过于频繁，请稍后再试（HTTP 429）".to_string(),
        ),
        300..=399 => (
            CredentialStatus::Valid,
            format!("官方额度服务返回了重定向（HTTP {code}），已停止请求"),
        ),
        500..=599 => (
            CredentialStatus::Valid,
            format!("官方额度服务暂不可用（HTTP {code}），请稍后再试"),
        ),
        _ => (
            CredentialStatus::Valid,
            format!("官方额度查询失败（HTTP {code}）"),
        ),
    })
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// One rate-limit window as a tier: a window without a finite percentage is
/// dropped rather than shown as 0%, and a reset time is never invented.
fn codex_quota_tier(
    window: CodexRateLimitWindow,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<QuotaTier> {
    let used = window.used_percent.filter(|used| used.is_finite())?;
    let utilization = used.clamp(0.0, 100.0);
    // Adapted from farion1231/cc-switch e1821b5e
    // An unused window carries a placeholder reset ("now + window length")
    // that restarts on every refresh, so it gets no countdown. The raw value
    // is checked, so a tiny non-zero use still keeps its real reset time.
    let resets_at = if used <= 0.0 {
        None
    } else {
        window.reset_at.and_then(unix_ts_to_iso).or_else(|| {
            window
                .reset_after_seconds
                .filter(|seconds| *seconds >= 0)
                .and_then(chrono::Duration::try_seconds)
                .and_then(|after| now.checked_add_signed(after))
                .map(|time| time.to_rfc3339())
        })
    };
    Some(QuotaTier {
        name: window
            .limit_window_seconds
            .filter(|seconds| *seconds > 0)
            .map(window_seconds_to_tier_name)
            .unwrap_or_else(|| "unknown".to_string()),
        utilization,
        resets_at,
        used_value_usd: None,
        max_value_usd: None,
    })
}

/// The tiers of a `wham/usage` body. A body for another account is refused,
/// and no identifier or response text ever reaches the error.
fn parse_codex_usage(
    raw: &[u8],
    expected_account_id: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<QuotaTier>, String> {
    let body: CodexUsageResponse = serde_json::from_slice(raw)
        .map_err(|_| "官方额度响应格式无法识别，请稍后再试".to_string())?;
    if let (Some(actual), Some(expected)) = (
        nonempty(body.account_id.as_deref()),
        nonempty(expected_account_id),
    ) {
        if actual != expected {
            return Err("额度响应与所选账号不一致，请刷新重试".to_string());
        }
    }
    let Some(rate_limit) = body.rate_limit else {
        return Ok(Vec::new());
    };
    Ok([rate_limit.primary_window, rate_limit.secondary_window]
        .into_iter()
        .flatten()
        .filter_map(|window| codex_quota_tier(window, now))
        .collect())
}

/// 查询 Codex / ChatGPT 反代订阅额度
///
/// 参数化 `tool_label` 和 `expired_message` 让该函数可被几个调用点共用：
/// - `"codex"` + "Please re-login with Codex CLI."（CLI 凭据路径）
/// - `"codex_oauth"` + "Please re-login via cc-switch."（cc-switch 自管 OAuth 路径）
/// - 官方账号页（按账号库身份查询）
///
/// 不跟随重定向：请求带着 Bearer 令牌，不能被 3xx 引到别处。
pub(crate) async fn query_codex_quota(
    access_token: &str,
    account_id: Option<&str>,
    tool_label: &str,
    expired_message: &str,
) -> Result<SubscriptionQuota, String> {
    let client = crate::proxy::http_client::get_for_auth_probe()?;

    let mut req = client
        .get(CODEX_USAGE_URL)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("User-Agent", "codex-cli")
        .header("Accept", "application/json");

    if let Some(id) = account_id {
        req = req.header("ChatGPT-Account-Id", id);
    }

    let resp = match req.timeout(std::time::Duration::from_secs(15)).send().await {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error: {e}")),
    };

    let status = resp.status();

    if let Some((credential_status, message)) = codex_quota_failure(status, expired_message) {
        // MH-16: this body comes from an endpoint we don't control and is
        // never surfaced verbatim to the caller/UI — only its status code
        // is. The body is capped and logged for diagnostics only.
        match read_response_text_limited(resp, MAX_QUOTA_ERROR_BODY_BYTES, "quota API error body")
            .await
        {
            Ok(body) => log::debug!("Codex quota API error (HTTP {status}): {body}"),
            Err(e) => log::debug!("Codex quota API error (HTTP {status}); body unreadable: {e}"),
        }
        return Ok(SubscriptionQuota::error(
            tool_label,
            credential_status,
            message,
        ));
    }

    let raw =
        match read_response_bytes_limited(resp, MAX_QUOTA_RESPONSE_BYTES, "quota API response")
            .await
        {
            Ok(b) => b,
            Err(e) => return Err(format!("Failed to read API response: {e}")),
        };
    let tiers = match parse_codex_usage(&raw, account_id, chrono::Utc::now()) {
        Ok(tiers) => tiers,
        Err(message) => {
            return Ok(SubscriptionQuota::error(
                tool_label,
                CredentialStatus::Valid,
                message,
            ));
        }
    };

    Ok(SubscriptionQuota {
        tool: tool_label.to_string(),
        credential_status: CredentialStatus::Valid,
        credential_message: None,
        success: true,
        tiers,
        extra_usage: None,
        error: None,
        queried_at: Some(now_millis()),
    })
}

// ── Gemini 凭据读取 ──────────────────────────────────────

/// Gemini OAuth 凭据文件格式（~/.gemini/oauth_creds.json）
#[derive(Deserialize)]
struct GeminiOAuthCredsFile {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expiry_date: Option<i64>, // 毫秒时间戳
}

/// (access_token, refresh_token, status, message)
type GeminiCredentials = (
    Option<String>,
    Option<String>,
    CredentialStatus,
    Option<String>,
);

/// 读取 Gemini OAuth 凭据
///
/// 按优先级尝试以下来源：
/// 1. macOS Keychain (service: "gemini-cli-oauth", account: "main-account")
/// 2. 凭据文件 ~/.gemini/oauth_creds.json（遗留格式）
///
/// 仅 OAuth 认证模式（`oauth-personal`）有效；API key 模式无法查询官方用量。
fn read_gemini_credentials() -> GeminiCredentials {
    #[cfg(target_os = "macos")]
    {
        if let Some(result) = read_gemini_credentials_from_keychain() {
            return result;
        }
    }

    read_gemini_credentials_from_file()
}

/// 从 macOS Keychain 读取 Gemini 凭据
#[cfg(target_os = "macos")]
fn read_gemini_credentials_from_keychain() -> Option<GeminiCredentials> {
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "gemini-cli-oauth",
            "-a",
            "main-account",
            "-w",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let json_str = String::from_utf8(output.stdout).ok()?;
    let json_str = json_str.trim();
    if json_str.is_empty() {
        return None;
    }

    Some(parse_gemini_keychain_json(json_str))
}

/// 解析 Keychain 格式的 Gemini 凭据
///
/// Keychain 格式（keytar）：
/// ```json
/// { "token": { "accessToken": "...", "refreshToken": "...", "expiresAt": 1234 }, "updatedAt": ... }
/// ```
#[cfg(target_os = "macos")]
fn parse_gemini_keychain_json(content: &str) -> GeminiCredentials {
    let parsed: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(e) => {
            return (
                None,
                None,
                CredentialStatus::ParseError,
                Some(format!("Failed to parse Gemini keychain JSON: {e}")),
            )
        }
    };

    let token = match parsed.get("token") {
        Some(t) => t,
        None => {
            // Keychain 中可能是扁平格式，尝试文件格式解析
            return parse_gemini_file_json(content);
        }
    };

    let access_token = token
        .get("accessToken")
        .and_then(|v| v.as_str())
        .map(String::from);
    let refresh_token = token
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .map(String::from);
    let expires_at = token.get("expiresAt").and_then(|v| v.as_i64());

    match access_token {
        Some(at) if !at.is_empty() => {
            // expiresAt 是毫秒时间戳
            if let Some(exp_ms) = expires_at {
                if exp_ms < now_millis() {
                    return (
                        Some(at),
                        refresh_token,
                        CredentialStatus::Expired,
                        Some("Gemini access token has expired".to_string()),
                    );
                }
            }
            (Some(at), refresh_token, CredentialStatus::Valid, None)
        }
        _ => (
            None,
            refresh_token,
            CredentialStatus::ParseError,
            Some("accessToken is empty or missing".to_string()),
        ),
    }
}

/// 从文件读取 Gemini 凭据
fn read_gemini_credentials_from_file() -> GeminiCredentials {
    let cred_path = crate::gemini_config::get_gemini_dir().join("oauth_creds.json");
    if !cred_path.exists() {
        return (None, None, CredentialStatus::NotFound, None);
    }

    let content = match std::fs::read_to_string(&cred_path) {
        Ok(c) => c,
        Err(e) => {
            return (
                None,
                None,
                CredentialStatus::ParseError,
                Some(format!("Failed to read Gemini credentials: {e}")),
            )
        }
    };

    parse_gemini_file_json(&content)
}

/// 解析文件格式的 Gemini 凭据
///
/// 文件格式（oauth_creds.json）：
/// ```json
/// { "access_token": "...", "refresh_token": "...", "expiry_date": 1234 }
/// ```
fn parse_gemini_file_json(content: &str) -> GeminiCredentials {
    let creds: GeminiOAuthCredsFile = match serde_json::from_str(content) {
        Ok(c) => c,
        Err(e) => {
            return (
                None,
                None,
                CredentialStatus::ParseError,
                Some(format!("Failed to parse Gemini credentials: {e}")),
            )
        }
    };

    let access_token = match creds.access_token {
        Some(t) if !t.is_empty() => t,
        _ => {
            return (
                None,
                creds.refresh_token,
                CredentialStatus::ParseError,
                Some("access_token is empty or missing".to_string()),
            )
        }
    };

    // expiry_date 是毫秒时间戳
    if let Some(exp_ms) = creds.expiry_date {
        if exp_ms < now_millis() {
            return (
                Some(access_token),
                creds.refresh_token,
                CredentialStatus::Expired,
                Some("Gemini access token has expired".to_string()),
            );
        }
    }

    (
        Some(access_token),
        creds.refresh_token,
        CredentialStatus::Valid,
        None,
    )
}

// ── Gemini Token 刷新 ──────────────────────────────────────

/// Gemini OAuth Client 凭据（公开值，来自 Gemini CLI 源码 google-gemini/gemini-cli）
const GEMINI_OAUTH_CLIENT_ID: &str =
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_OAUTH_CLIENT_SECRET: &str = "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";

/// 使用 refresh_token 刷新 Gemini access token
///
/// Google OAuth access_token 仅有 ~1h 有效期，需要定期用 refresh_token 刷新。
/// refresh_token 本身不过期（除非用户撤销授权）。
async fn refresh_gemini_token(refresh_token: &str) -> Option<String> {
    let client = crate::proxy::http_client::get();

    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", GEMINI_OAUTH_CLIENT_ID),
            ("client_secret", GEMINI_OAUTH_CLIENT_SECRET),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("access_token")?.as_str().map(String::from)
}

// ── Gemini API 查询 ──────────────────────────────────────

/// loadCodeAssist 响应
#[derive(Deserialize)]
struct GeminiLoadCodeAssistResponse {
    #[serde(rename = "cloudaicompanionProject")]
    cloudaicompanion_project: Option<serde_json::Value>,
}

/// 配额 bucket
#[derive(Deserialize)]
struct GeminiBucketInfo {
    #[serde(rename = "remainingFraction")]
    remaining_fraction: Option<f64>,
    #[serde(rename = "resetTime")]
    reset_time: Option<String>,
    #[serde(rename = "modelId")]
    model_id: Option<String>,
}

/// retrieveUserQuota 响应
#[derive(Deserialize)]
struct GeminiQuotaResponse {
    buckets: Option<Vec<GeminiBucketInfo>>,
}

/// 从 loadCodeAssist 响应中提取项目 ID
fn extract_project_id(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(obj) => obj
            .get("id")
            .or_else(|| obj.get("projectId"))
            .and_then(|v| v.as_str())
            .map(String::from),
        _ => None,
    }
}

/// 将 Gemini 模型 ID 分类为 Pro / Flash / Flash Lite
fn classify_gemini_model(model_id: &str) -> &str {
    if model_id.contains("flash-lite") {
        TIER_GEMINI_FLASH_LITE
    } else if model_id.contains("flash") {
        TIER_GEMINI_FLASH
    } else if model_id.contains("pro") {
        TIER_GEMINI_PRO
    } else {
        model_id
    }
}

/// 查询 Gemini 官方订阅额度
///
/// 两步 API 调用：
/// 1. loadCodeAssist → 获取 cloudaicompanionProject
/// 2. retrieveUserQuota → 获取按模型分桶的配额数据
async fn query_gemini_quota(access_token: &str) -> Result<SubscriptionQuota, String> {
    let client = crate::proxy::http_client::get();

    // ── Step 1: loadCodeAssist 获取项目 ID ──
    let load_resp = client
        .post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "metadata": {
                "ideType": "GEMINI_CLI",
                "pluginType": "GEMINI"
            }
        }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    let load_resp = match load_resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error (loadCodeAssist): {e}")),
    };

    let load_status = load_resp.status();
    if load_status == reqwest::StatusCode::UNAUTHORIZED
        || load_status == reqwest::StatusCode::FORBIDDEN
    {
        return Ok(SubscriptionQuota::error(
            "gemini",
            CredentialStatus::Expired,
            format!("Authentication failed (HTTP {load_status}). Please re-login with Gemini CLI."),
        ));
    }
    if !load_status.is_success() {
        let body = load_resp.text().await.unwrap_or_default();
        return Ok(SubscriptionQuota::error(
            "gemini",
            CredentialStatus::Valid,
            format!("loadCodeAssist failed (HTTP {load_status}): {body}"),
        ));
    }

    let load_raw = match load_resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(format!("Failed to read loadCodeAssist response: {e}")),
    };
    let load_body: GeminiLoadCodeAssistResponse = match serde_json::from_slice(&load_raw) {
        Ok(v) => v,
        Err(e) => {
            return Ok(SubscriptionQuota::error(
                "gemini",
                CredentialStatus::Valid,
                format!("Failed to parse loadCodeAssist response: {e}"),
            ));
        }
    };

    let project_id = load_body
        .cloudaicompanion_project
        .as_ref()
        .and_then(extract_project_id);

    // ── Step 2: retrieveUserQuota 获取配额 ──
    let mut quota_body = serde_json::json!({});
    if let Some(ref pid) = project_id {
        quota_body["project"] = serde_json::Value::String(pid.clone());
    }

    let quota_resp = client
        .post("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .json(&quota_body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    let quota_resp = match quota_resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error (retrieveUserQuota): {e}")),
    };

    let quota_status = quota_resp.status();
    if quota_status == reqwest::StatusCode::UNAUTHORIZED
        || quota_status == reqwest::StatusCode::FORBIDDEN
    {
        return Ok(SubscriptionQuota::error(
            "gemini",
            CredentialStatus::Expired,
            format!("Authentication failed (HTTP {quota_status})."),
        ));
    }
    if !quota_status.is_success() {
        let body = quota_resp.text().await.unwrap_or_default();
        return Ok(SubscriptionQuota::error(
            "gemini",
            CredentialStatus::Valid,
            format!("retrieveUserQuota failed (HTTP {quota_status}): {body}"),
        ));
    }

    let quota_raw = match quota_resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(format!("Failed to read quota response: {e}")),
    };
    let quota_data: GeminiQuotaResponse = match serde_json::from_slice(&quota_raw) {
        Ok(v) => v,
        Err(e) => {
            return Ok(SubscriptionQuota::error(
                "gemini",
                CredentialStatus::Valid,
                format!("Failed to parse quota response: {e}"),
            ));
        }
    };

    // ── 按模型分类汇总，每类取最低 remainingFraction ──
    let mut category_map: HashMap<String, (f64, Option<String>)> = HashMap::new();

    if let Some(buckets) = quota_data.buckets {
        for bucket in buckets {
            let model_id = bucket.model_id.as_deref().unwrap_or("unknown");
            let category = classify_gemini_model(model_id).to_string();
            let remaining = bucket.remaining_fraction.unwrap_or(1.0).clamp(0.0, 1.0);

            let entry = category_map
                .entry(category)
                .or_insert((remaining, bucket.reset_time.clone()));
            if remaining < entry.0 {
                entry.0 = remaining;
                if bucket.reset_time.is_some() {
                    entry.1.clone_from(&bucket.reset_time);
                }
            }
        }
    }

    // 转换为 tiers（remainingFraction → utilization: 已用百分比）
    let sort_order = |name: &str| -> usize {
        match name {
            TIER_GEMINI_PRO => 0,
            TIER_GEMINI_FLASH => 1,
            TIER_GEMINI_FLASH_LITE => 2,
            _ => 3,
        }
    };

    let mut tiers: Vec<QuotaTier> = category_map
        .into_iter()
        .map(|(name, (remaining, reset_time))| QuotaTier {
            name,
            utilization: (1.0 - remaining) * 100.0,
            resets_at: reset_time,
            used_value_usd: None,
            max_value_usd: None,
        })
        .collect();

    tiers.sort_by_key(|t| sort_order(&t.name));

    Ok(SubscriptionQuota {
        tool: "gemini".to_string(),
        credential_status: CredentialStatus::Valid,
        credential_message: None,
        success: true,
        tiers,
        extra_usage: None,
        error: None,
        queried_at: Some(now_millis()),
    })
}

// ── 入口函数 ──────────────────────────────────────────────

/// 查询指定 CLI 工具的官方订阅额度
///
/// 瞬时传输失败以 `Err` 传播（前端 reject → retry + 保留上次成功值）。Expired
/// 分支的"过期也试一把"重试同样用 `?` 传播瞬时错误——不能折叠成"已过期"，
/// 否则一次网络抖动会被误报成确定性的凭据过期。
pub async fn get_subscription_quota(tool: &str) -> Result<SubscriptionQuota, String> {
    match tool {
        "claude" => {
            let (token, status, message) = read_claude_credentials();

            match status {
                CredentialStatus::NotFound => Ok(SubscriptionQuota::not_found("claude")),
                CredentialStatus::ParseError => Ok(SubscriptionQuota::error(
                    "claude",
                    CredentialStatus::ParseError,
                    message.unwrap_or_else(|| "Failed to parse credentials".to_string()),
                )),
                CredentialStatus::Expired => {
                    // 即使过期也尝试调用 API（token 可能实际上仍有效）
                    if let Some(token) = token {
                        let result = query_claude_quota(&token).await?;
                        if result.success {
                            return Ok(result);
                        }
                    }
                    Ok(SubscriptionQuota::error(
                        "claude",
                        CredentialStatus::Expired,
                        message.unwrap_or_else(|| "OAuth token has expired".to_string()),
                    ))
                }
                CredentialStatus::Valid => {
                    let token = token.expect("token must be Some when status is Valid");
                    query_claude_quota(&token).await
                }
            }
        }
        "codex" => {
            let (token, account_id, status, message) = read_codex_credentials();

            match status {
                CredentialStatus::NotFound => Ok(SubscriptionQuota::not_found("codex")),
                CredentialStatus::ParseError => Ok(SubscriptionQuota::error(
                    "codex",
                    CredentialStatus::ParseError,
                    message.unwrap_or_else(|| "Failed to parse credentials".to_string()),
                )),
                CredentialStatus::Expired => {
                    // 即使可能过期也尝试调用 API
                    if let Some(token) = token {
                        let result = query_codex_quota(
                            &token,
                            account_id.as_deref(),
                            "codex",
                            "Authentication failed. Please re-login with Codex CLI.",
                        )
                        .await?;
                        if result.success {
                            return Ok(result);
                        }
                    }
                    Ok(SubscriptionQuota::error(
                        "codex",
                        CredentialStatus::Expired,
                        message.unwrap_or_else(|| "Codex OAuth token may be stale".to_string()),
                    ))
                }
                CredentialStatus::Valid => {
                    let token = token.expect("token must be Some when status is Valid");
                    query_codex_quota(
                        &token,
                        account_id.as_deref(),
                        "codex",
                        "Authentication failed. Please re-login with Codex CLI.",
                    )
                    .await
                }
            }
        }
        "gemini" => {
            let (token, refresh_token, status, message) = read_gemini_credentials();

            match status {
                CredentialStatus::NotFound => Ok(SubscriptionQuota::not_found("gemini")),
                CredentialStatus::ParseError => Ok(SubscriptionQuota::error(
                    "gemini",
                    CredentialStatus::ParseError,
                    message.unwrap_or_else(|| "Failed to parse credentials".to_string()),
                )),
                CredentialStatus::Expired => {
                    // Gemini access_token 仅 ~1h 有效，尝试用 refresh_token 刷新
                    if let Some(ref rt) = refresh_token {
                        if let Some(new_token) = refresh_gemini_token(rt).await {
                            return query_gemini_quota(&new_token).await;
                        }
                    }
                    // 刷新失败，尝试用旧 token
                    if let Some(ref token) = token {
                        let result = query_gemini_quota(token).await?;
                        if result.success {
                            return Ok(result);
                        }
                    }
                    Ok(SubscriptionQuota::error(
                        "gemini",
                        CredentialStatus::Expired,
                        message.unwrap_or_else(|| "Gemini OAuth token has expired".to_string()),
                    ))
                }
                CredentialStatus::Valid => {
                    let token = token.expect("token must be Some when status is Valid");
                    query_gemini_quota(&token).await
                }
            }
        }
        _ => Ok(SubscriptionQuota::not_found(tool)),
    }
}

// ── 辅助函数 ──────────────────────────────────────────────

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_model_weekly_tiers_get_a_readable_name() {
        assert_eq!(tier_display_name("model_weekly:Fable"), "每周 · Fable");
        assert_eq!(tier_display_name(TIER_FIVE_HOUR), TIER_FIVE_HOUR);
    }

    #[test]
    fn claude_usage_reads_windows_model_limits_and_extra_usage() {
        let body = serde_json::json!({
            "five_hour": {"utilization": 12.5, "resets_at": "2026-10-30T10:00:00Z"},
            "seven_day": {"utilization": 40.0, "resets_at": "2026-11-02T00:00:00Z"},
            "seven_day_opus": null,
            "limits": [
                {"kind": "weekly_scoped", "percent": 33, "resets_at": "2026-11-03T00:00:00Z",
                 "scope": {"model": {"display_name": "Fable"}}},
                {"kind": "weekly_scoped", "percent": "bad", "scope": {"model": {"display_name": "X"}}},
                {"percent": 5}
            ],
            "extra_usage": {
                "is_enabled": true, "monthly_limit": 5000, "used_credits": 1250,
                "utilization": 25.0, "currency": "USD", "resets_at": "2026-11-01T00:00:00Z"
            }
        });
        let (tiers, extra) = parse_claude_usage(&body);
        let names: Vec<&str> = tiers.iter().map(|tier| tier.name.as_str()).collect();
        assert_eq!(
            names,
            vec![TIER_FIVE_HOUR, TIER_SEVEN_DAY, "model_weekly:Fable"]
        );
        assert_eq!(tiers[2].utilization, 33.0);
        assert_eq!(tiers[2].resets_at.as_deref(), Some("2026-11-03T00:00:00Z"));
        let extra = extra.unwrap();
        assert!(extra.is_enabled);
        assert_eq!(extra.used_credits, Some(1250.0));
        assert_eq!(extra.resets_at.as_deref(), Some("2026-11-01T00:00:00Z"));
    }

    #[test]
    fn window_seconds_map_to_expected_tier_names() {
        // 官方特例窗口
        assert_eq!(window_seconds_to_tier_name(18000), TIER_FIVE_HOUR);
        assert_eq!(window_seconds_to_tier_name(604800), TIER_SEVEN_DAY);
        // Codex 免费方案的次要窗口是 30 天（30 * 24 * 3600 = 2_592_000 秒）。
        // 前端 TIER_I18N_KEYS 与 tray 月分组都需要认得 "30_day"，见 #3651。
        assert_eq!(window_seconds_to_tier_name(2_592_000), TIER_THIRTY_DAY);
        // 其他窗口按小时/天回退命名
        assert_eq!(window_seconds_to_tier_name(3600), "1_hour");
        assert_eq!(window_seconds_to_tier_name(86400), "1_day");
    }

    #[test]
    fn codex_quota_statuses_separate_rejected_logins_from_blocks_and_limits() {
        assert!(codex_quota_failure(reqwest::StatusCode::OK, "relogin").is_none());
        for (code, rejected, needle) in [
            (401_u16, true, "relogin"),
            (403, false, "可能是网络或地区限制"),
            (429, false, "查询过于频繁"),
            (302, false, "重定向"),
            (503, false, "暂不可用"),
            (404, false, "查询失败"),
        ] {
            let (credential, message) =
                codex_quota_failure(reqwest::StatusCode::from_u16(code).unwrap(), "relogin")
                    .unwrap();
            assert_eq!(
                matches!(credential, CredentialStatus::Expired),
                rejected,
                "{code}"
            );
            assert!(message.contains(needle), "{code}: {message}");
            // The quota hooks classify transient failures by this marker.
            assert!(
                message.contains(&format!("HTTP {code}")),
                "{code}: {message}"
            );
        }
    }

    fn quota_time(text: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn codex_usage_keeps_every_window_and_falls_back_to_reset_after_seconds() {
        let now = quota_time("2026-09-09T03:00:00Z");
        let body = serde_json::json!({
            "account_id": "acct-a",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 37.5,
                    "limit_window_seconds": 18000,
                    "reset_after_seconds": 600
                },
                "secondary_window": {
                    "used_percent": 130,
                    "limit_window_seconds": 2_592_000,
                    "reset_at": now.timestamp() + 3600,
                    "reset_after_seconds": 20
                }
            }
        });
        let tiers =
            parse_codex_usage(&serde_json::to_vec(&body).unwrap(), Some("acct-a"), now).unwrap();
        assert_eq!(tiers.len(), 2);
        assert_eq!(tiers[0].name, TIER_FIVE_HOUR);
        assert_eq!(tiers[0].utilization, 37.5);
        assert_eq!(
            tiers[0].resets_at.as_deref(),
            Some("2026-09-09T03:10:00+00:00")
        );
        // An absolute reset time wins over the relative one; percentages clamp.
        assert_eq!(tiers[1].name, TIER_THIRTY_DAY);
        assert_eq!(tiers[1].utilization, 100.0);
        assert_eq!(
            tiers[1].resets_at.as_deref(),
            Some("2026-09-09T04:00:00+00:00")
        );
    }

    #[test]
    fn codex_usage_gives_an_unused_window_no_placeholder_countdown() {
        let now = quota_time("2026-09-09T03:00:00Z");
        let body = serde_json::json!({
            "rate_limit": {
                "primary_window": {
                    "used_percent": 0,
                    "limit_window_seconds": 18000,
                    "reset_at": now.timestamp() + 18000,
                    "reset_after_seconds": 18000
                },
                "secondary_window": {
                    "used_percent": 0.4,
                    "limit_window_seconds": 604_800,
                    "reset_at": now.timestamp() + 3600
                }
            }
        });
        let tiers = parse_codex_usage(&serde_json::to_vec(&body).unwrap(), None, now).unwrap();
        assert_eq!(tiers.len(), 2);
        assert_eq!(tiers[0].utilization, 0.0);
        assert!(tiers[0].resets_at.is_none());
        // Light use keeps the real reset time.
        assert_eq!(tiers[1].utilization, 0.4);
        assert_eq!(
            tiers[1].resets_at.as_deref(),
            Some("2026-09-09T04:00:00+00:00")
        );
    }

    #[test]
    fn codex_usage_invents_no_percentage_window_or_reset_time() {
        let now = quota_time("2026-09-09T03:00:00Z");
        let body = serde_json::json!({
            "rate_limit": {
                "primary_window": { "limit_window_seconds": 18000 },
                "secondary_window": {
                    "used_percent": 10,
                    "limit_window_seconds": -1,
                    "reset_at": i64::MAX,
                    "reset_after_seconds": -10
                }
            }
        });
        let tiers = parse_codex_usage(&serde_json::to_vec(&body).unwrap(), None, now).unwrap();
        assert_eq!(tiers.len(), 1);
        assert_eq!(tiers[0].name, "unknown");
        assert!(tiers[0].resets_at.is_none());
        assert!(parse_codex_usage(b"{}", None, now).unwrap().is_empty());
    }

    #[test]
    fn codex_usage_for_another_account_or_garbage_echoes_nothing() {
        let now = quota_time("2026-09-09T03:00:00Z");
        let error = parse_codex_usage(
            br#"{"account_id":"other-private-account"}"#,
            Some("selected-private-account"),
            now,
        )
        .unwrap_err();
        assert!(error.contains("不一致"));
        assert!(!error.contains("private-account"));
        // A missing id on either side is not a mismatch.
        assert!(
            parse_codex_usage(br#"{"account_id":null}"#, Some("selected"), now)
                .unwrap()
                .is_empty()
        );
        assert!(parse_codex_usage(br#"{"account_id":"server"}"#, None, now)
            .unwrap()
            .is_empty());
        let error = parse_codex_usage(b"private-secret-token", None, now).unwrap_err();
        assert!(!error.contains("private-secret-token"));
    }

    // MH-16 regression: `read_response_bytes_limited`/`read_response_text_limited`
    // must reject an oversized body instead of buffering it without limit,
    // both when the server declares an oversized `Content-Length` up front
    // and when it streams past the cap without declaring a length at all
    // (chunked transfer encoding — the case a misbehaving/adversarial server
    // would use to dodge a naive `Content-Length` check).

    async fn serve_test_router(router: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (url, server)
    }

    #[tokio::test]
    async fn capped_read_rejects_oversized_body_declared_via_content_length() {
        let (url, server) =
            serve_test_router(axum::Router::new().fallback(|| async { "x".repeat(200_000) })).await;

        let resp = reqwest::get(&url).await.unwrap();
        let err = read_response_bytes_limited(resp, 1024, "test body")
            .await
            .unwrap_err();
        assert!(err.contains("exceeds"), "unexpected error: {err}");
        server.abort();
    }

    #[tokio::test]
    async fn capped_read_rejects_oversized_body_streamed_without_content_length() {
        let (url, server) = serve_test_router(axum::Router::new().fallback(|| async {
            let chunks: Vec<Result<bytes::Bytes, std::io::Error>> = (0..300)
                .map(|_| Ok(bytes::Bytes::from(vec![b'x'; 1024])))
                .collect();
            axum::response::Response::builder()
                .status(200)
                .body(axum::body::Body::from_stream(futures::stream::iter(chunks)))
                .unwrap()
        }))
        .await;

        let resp = reqwest::get(&url).await.unwrap();
        assert!(
            resp.content_length().is_none(),
            "test setup must exercise the no-Content-Length path"
        );
        let err = read_response_bytes_limited(resp, 1024, "test body")
            .await
            .unwrap_err();
        assert!(err.contains("exceeds"), "unexpected error: {err}");
        server.abort();
    }

    #[tokio::test]
    async fn capped_read_accepts_body_within_limit() {
        let (url, server) =
            serve_test_router(axum::Router::new().fallback(|| async { "small body" })).await;

        let resp = reqwest::get(&url).await.unwrap();
        let text = read_response_text_limited(resp, MAX_QUOTA_ERROR_BODY_BYTES, "test body")
            .await
            .unwrap();
        assert_eq!(text, "small body");
        server.abort();
    }
}
