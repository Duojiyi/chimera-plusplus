//! 供应商余额查询服务
//!
//! 支持 DeepSeek、StepFun、SiliconFlow、OpenRouter、Novita AI、Moonshot 与 ChimeraHub 的账户余额查询。
//! 返回 UsageResult 格式（外加可选 `status`），与现有用量系统无缝对接。
//!
//! 错误通道语义（与 coding_plan / subscription 两个服务保持一致）：
//! - `Err(String)` = 瞬时传输失败（网络不可达/超时/读体中断）。前端 invoke reject，
//!   react-query 触发 retry 并保留上一次成功的 data（天然 keep-last-good）。
//! - `Ok(success:false)` = 确定性失败（鉴权/非 2xx/响应体非法 JSON），立即透出错误文案。
//!   判定按 reqwest 错误种类在折叠点完成，不依赖错误文案匹配。
//! - `Ok(status: Some(..))` = 没有发请求：缺地址或 key（`missing_credentials`），
//!   或该地址没有已知余额接口（`unsupported`）。

use crate::provider::{UsageData, UsageResult};
use serde::Serialize;
use std::time::Duration;
use url::Url;

// ── 查询结果 ────────────────────────────────────────────────

/// 未发出余额请求的原因。类型化给前端，界面不再匹配后端错误文案。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BalanceStatus {
    /// 该请求地址没有已知的余额接口（并不说明它是不是中转站）。
    Unsupported,
    /// 请求地址或 API Key 为空。
    MissingCredentials,
}

impl BalanceStatus {
    fn message(self) -> &'static str {
        match self {
            BalanceStatus::Unsupported => "Balance query is not supported for this endpoint",
            BalanceStatus::MissingCredentials => "Base URL or API key is missing",
        }
    }
}

/// `UsageResult` 加上可选的 `status`；status 存在时表示没有发出请求。
#[derive(Debug, Clone, Serialize)]
pub struct BalanceResult {
    #[serde(flatten)]
    pub usage: UsageResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<BalanceStatus>,
}

impl BalanceResult {
    fn unavailable(status: BalanceStatus) -> Self {
        BalanceResult {
            usage: UsageResult {
                success: false,
                data: None,
                error: None,
            },
            status: Some(status),
        }
    }

    /// 给只认 `UsageResult` 的调用方（用量脚本模板）：status 折成稳定的错误文案。
    pub fn into_usage_result(self) -> UsageResult {
        let mut usage = self.usage;
        if let Some(status) = self.status {
            usage
                .error
                .get_or_insert_with(|| status.message().to_string());
        }
        usage
    }
}

impl From<UsageResult> for BalanceResult {
    fn from(usage: UsageResult) -> Self {
        BalanceResult {
            usage,
            status: None,
        }
    }
}

// ── 供应商检测 ──────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
enum BalanceProvider {
    DeepSeek,
    StepFun,
    SiliconFlow,
    SiliconFlowEn,
    OpenRouter,
    NovitaAI,
    /// 月之暗面国内站；国际站 api.moonshot.ai 没有这个余额接口。
    Moonshot,
    /// 自家中转站：整个 chimerahub.org 域（地址可编辑，含专属中转地址），
    /// 余额请求发回用户配置的同一 origin，key 不会离开该主机。
    ChimeraHub {
        origin: String,
    },
}

fn detect_provider(base_url: &str) -> Option<BalanceProvider> {
    let parsed = Url::parse(base_url.trim()).ok()?;

    // 必须为 https
    if parsed.scheme() != "https" {
        return None;
    }

    // 拒绝包含 userinfo
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }

    // 拒绝非标准端口
    if let Some(port) = parsed.port() {
        if port != 443 {
            return None;
        }
    }

    let host = parsed.host_str()?.to_ascii_lowercase();
    match host.as_str() {
        "api.deepseek.com" => Some(BalanceProvider::DeepSeek),
        "api.stepfun.com" | "api.stepfun.ai" => Some(BalanceProvider::StepFun),
        "api.siliconflow.cn" => Some(BalanceProvider::SiliconFlow),
        "api.siliconflow.com" => Some(BalanceProvider::SiliconFlowEn),
        "openrouter.ai" => Some(BalanceProvider::OpenRouter),
        "api.novita.ai" => Some(BalanceProvider::NovitaAI),
        "api.moonshot.cn" => Some(BalanceProvider::Moonshot),
        host if crate::builtin_templates::is_chimerahub_host(host) => {
            Some(BalanceProvider::ChimeraHub {
                origin: format!("https://{host}"),
            })
        }
        _ => None,
    }
}

fn make_error(msg: String) -> UsageResult {
    UsageResult {
        success: false,
        data: None,
        error: Some(msg),
    }
}

fn make_auth_error(status: reqwest::StatusCode) -> UsageResult {
    UsageResult {
        success: false,
        data: Some(vec![UsageData {
            plan_name: None,
            remaining: None,
            total: None,
            used: None,
            unit: None,
            is_valid: Some(false),
            invalid_message: Some(format!("Authentication failed (HTTP {status})")),
            extra: None,
        }]),
        error: Some(format!("Authentication failed (HTTP {status})")),
    }
}

// ── 纯解析函数 ──────────────────────────────────────────────

fn parse_deepseek_response(body: &serde_json::Value) -> Result<Vec<UsageData>, String> {
    let is_available = body
        .get("is_available")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let infos = match body.get("balance_infos").and_then(|v| v.as_array()) {
        Some(arr) if !arr.is_empty() => arr,
        _ => return Err("Missing or empty 'balance_infos' in response".to_string()),
    };

    let mut data = Vec::with_capacity(infos.len());
    for info in infos {
        let currency = info
            .get("currency")
            .and_then(|v| v.as_str())
            .unwrap_or("CNY");
        let total = match parse_f64_field(info, "total_balance") {
            Some(t) => t,
            None => return Err("Missing or invalid 'total_balance' in balance_infos".to_string()),
        };

        data.push(UsageData {
            plan_name: Some(currency.to_string()),
            remaining: Some(total),
            total: None,
            used: None,
            unit: Some(currency.to_string()),
            is_valid: Some(is_available),
            invalid_message: if !is_available {
                Some("Insufficient balance".to_string())
            } else {
                None
            },
            extra: None,
        });
    }

    // Adapted from farion1231/cc-switch a94b592a
    // 同一账号会列出 CNY / USD 两个钱包，扣费走有余额的那个。只要还有币种有余额，
    // 就不再列出空钱包，否则界面取到空钱包会显示余额为 0。全部为空时保留全部。
    if data.iter().any(|d| d.remaining.is_some_and(|v| v > 0.0)) {
        data.retain(|d| d.remaining.is_none_or(|v| v > 0.0));
    }

    Ok(data)
}

fn parse_stepfun_response(body: &serde_json::Value) -> Result<Vec<UsageData>, String> {
    let balance = match parse_f64_field(body, "balance") {
        Some(b) => b,
        None => return Err("Missing or invalid 'balance' field in response".to_string()),
    };

    Ok(vec![UsageData {
        plan_name: Some("StepFun".to_string()),
        remaining: Some(balance),
        total: None,
        used: None,
        unit: Some("CNY".to_string()),
        is_valid: Some(true),
        invalid_message: None,
        extra: None,
    }])
}

fn parse_siliconflow_response(
    body: &serde_json::Value,
    is_cn: bool,
) -> Result<Vec<UsageData>, String> {
    let data = match body.get("data") {
        Some(d) if d.is_object() => d,
        _ => return Err("Missing or invalid 'data' field in response".to_string()),
    };

    let total_balance = match parse_f64_field(data, "totalBalance") {
        Some(b) => b,
        None => return Err("Missing or invalid 'totalBalance' field in response".to_string()),
    };

    let unit = if is_cn { "CNY" } else { "USD" };
    let plan_name = if is_cn {
        "SiliconFlow"
    } else {
        "SiliconFlow (EN)"
    };

    Ok(vec![UsageData {
        plan_name: Some(plan_name.to_string()),
        remaining: Some(total_balance),
        total: None,
        used: None,
        unit: Some(unit.to_string()),
        is_valid: Some(true),
        invalid_message: None,
        extra: None,
    }])
}

fn parse_openrouter_response(body: &serde_json::Value) -> Result<Vec<UsageData>, String> {
    let data = if let Some(d) = body.get("data") {
        if d.is_object() {
            d
        } else {
            return Err("Invalid 'data' field in response".to_string());
        }
    } else if body.is_object() {
        body
    } else {
        return Err("Invalid JSON response".to_string());
    };

    let total_credits = match parse_f64_field(data, "total_credits") {
        Some(c) => c,
        None => return Err("Missing or invalid 'total_credits' field in response".to_string()),
    };
    let total_usage = match parse_f64_field(data, "total_usage") {
        Some(u) => u,
        None => return Err("Missing or invalid 'total_usage' field in response".to_string()),
    };
    let remaining = total_credits - total_usage;
    if !remaining.is_finite() {
        return Err("Invalid OpenRouter credit balance".to_string());
    }
    let remaining = round_money(remaining);

    Ok(vec![UsageData {
        plan_name: Some("OpenRouter".to_string()),
        remaining: Some(remaining),
        total: Some(total_credits),
        used: Some(total_usage),
        unit: Some("USD".to_string()),
        // `/credits` reports purchased credits, not whether the key works: a
        // free account with no credits can still use free models, and an
        // exhausted or overdrawn balance is an answer, not an expired plan.
        is_valid: Some(true),
        invalid_message: None,
        extra: None,
    }])
}

/// `GET /api/v1/key` describes the key itself. Ordinary model keys can read
/// it, while `/credits` needs management permission. `limit_remaining` is
/// `null` when the key has no spending limit.
fn parse_openrouter_key_response(body: &serde_json::Value) -> Option<UsageData> {
    let data = body.get("data").filter(|d| d.is_object()).unwrap_or(body);
    let remaining = parse_f64_field(data, "limit_remaining")?;
    Some(UsageData {
        plan_name: Some("OpenRouter Key".to_string()),
        remaining: Some(round_money(remaining)),
        total: parse_f64_field(data, "limit"),
        used: parse_f64_field(data, "usage"),
        unit: Some("USD".to_string()),
        is_valid: Some(true),
        invalid_message: None,
        extra: None,
    })
}

fn parse_moonshot_response(body: &serde_json::Value) -> Result<Vec<UsageData>, String> {
    let accepted = body.get("status").and_then(|v| v.as_bool()) == Some(true)
        && body.get("code").and_then(|v| v.as_i64()) == Some(0);
    if !accepted {
        return Err("Moonshot balance query was rejected".to_string());
    }
    let data = match body.get("data") {
        Some(d) if d.is_object() => d,
        _ => return Err("Missing or invalid 'data' field in response".to_string()),
    };
    let available = parse_f64_field(data, "available_balance")
        .ok_or_else(|| "Missing or invalid 'available_balance' field in response".to_string())?;
    Ok(vec![UsageData {
        plan_name: Some("Moonshot".to_string()),
        remaining: Some(round_money(available)),
        total: None,
        used: None,
        unit: Some("CNY".to_string()),
        // A negative balance (arrears) is still an answer about the account.
        is_valid: Some(true),
        invalid_message: None,
        extra: None,
    }])
}

fn parse_novita_response(body: &serde_json::Value) -> Result<Vec<UsageData>, String> {
    let raw_balance = match parse_f64_field(body, "availableBalance") {
        Some(b) => b,
        None => return Err("Missing or invalid 'availableBalance' field in response".to_string()),
    };
    let available = raw_balance / 10000.0;

    Ok(vec![UsageData {
        plan_name: Some("Novita AI".to_string()),
        remaining: Some(available),
        total: None,
        used: None,
        unit: Some("USD".to_string()),
        // A zero or negative balance does not make the key invalid; the
        // amount itself tells the user the balance is used up.
        is_valid: Some(true),
        invalid_message: None,
        extra: None,
    }])
}

fn parse_chimerahub_response(body: &serde_json::Value) -> Result<Vec<UsageData>, String> {
    let data = body
        .get("data")
        .filter(|value| value.is_object())
        .ok_or_else(|| "Missing or invalid 'data' field in response".to_string())?;
    let granted = parse_f64_field(data, "total_granted")
        .ok_or_else(|| "Missing or invalid 'total_granted' field in response".to_string())?;
    let used = parse_f64_field(data, "total_used")
        .ok_or_else(|| "Missing or invalid 'total_used' field in response".to_string())?;
    let available = parse_f64_field(data, "total_available")
        .ok_or_else(|| "Missing or invalid 'total_available' field in response".to_string())?;
    let unlimited = data
        .get("unlimited_quota")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(vec![UsageData {
        plan_name: Some("ChimeraHub API Key".to_string()),
        remaining: Some(available),
        total: Some(granted),
        used: Some(used),
        unit: Some("点".to_string()),
        is_valid: Some(unlimited || available > 0.0),
        invalid_message: if !unlimited && available <= 0.0 {
            Some("额度不足".to_string())
        } else {
            None
        },
        extra: Some(format!("unlimited_quota={unlimited}")),
    }])
}

async fn query_chimerahub(origin: &str, api_key: &str) -> Result<UsageResult, String> {
    let resp = crate::proxy::http_client::get()
        .get(format!("{origin}/api/usage/token/"))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(make_auth_error(status));
    }
    if !status.is_success() {
        return Ok(make_error(format!("API error (HTTP {status})")));
    }
    let raw = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?;
    let body =
        serde_json::from_slice(&raw).map_err(|e| format!("Failed to parse response: {e}"))?;
    let mut data = match parse_chimerahub_response(&body) {
        Ok(d) => d,
        Err(e) => return Ok(make_error(e)),
    };
    // 账户余额（美元）为最佳真实数据：token 用量接口对不限量 key 只报负数。
    // 此处为尽力而为：失败不改变已成功的 token 结果。
    // 换算规则（中转站计价）：1 元 = 10 点，充值比例 1 元 ≈ 1 美元，
    // 故 soft_limit_usd × 10 = 总点数，total_usage ÷ 10 = 已用点数。
    if let Some(data0) = data.first_mut() {
        if let Some(account) = query_chimerahub_account(origin, api_key).await {
            let points = (account.soft_limit * 10.0 - account.used / 10.0).max(0.0);
            data0.remaining = Some(points);
            data0.used = Some(account.used / 10.0);
            data0.unit = Some("点".to_string());
            data0.plan_name = Some("ChimeraHub 账户".to_string());
            let extra = data0.extra.take().unwrap_or_default();
            data0.extra = Some(format!("{extra};account_balance_points={:.2}", points));
        }
    }
    Ok(UsageResult {
        success: true,
        data: Some(data),
        error: None,
    })
}

/// GET /v1/dashboard/billing/subscription + /usage（OpenAI 风格账户余额接口）。
/// 任一步失败返回 None（调用方尽力而为）。
struct ChimeraHubAccount {
    soft_limit: f64,
    used: f64,
}

async fn query_chimerahub_account(origin: &str, api_key: &str) -> Option<ChimeraHubAccount> {
    let client = crate::proxy::http_client::get();
    let sub = client
        .get(format!("{origin}/v1/dashboard/billing/subscription"))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let sub_json: serde_json::Value = sub.json().await.ok()?;
    let soft_limit = sub_json
        .get("soft_limit_usd")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let used = client
        .get(format!("{origin}/v1/dashboard/billing/usage"))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok()?
        .get("total_usage")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    Some(ChimeraHubAccount { soft_limit, used })
}

// ── DeepSeek ────────────────────────────────────────────────
// GET https://api.deepseek.com/user/balance
// Response: { balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }], is_available }

async fn query_deepseek(api_key: &str) -> Result<UsageResult, String> {
    let client = crate::proxy::http_client::get();

    let resp = client
        .get("https://api.deepseek.com/user/balance")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(make_auth_error(status));
    }
    if !status.is_success() {
        return Ok(make_error(format!("API error (HTTP {status})")));
    }

    let raw = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(format!("Failed to read response: {e}")),
    };
    let body: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return Ok(make_error(format!("Failed to parse response: {e}"))),
    };

    match parse_deepseek_response(&body) {
        Ok(data) => Ok(UsageResult {
            success: true,
            data: Some(data),
            error: None,
        }),
        Err(err) => Ok(make_error(err)),
    }
}

// ── StepFun ─────────────────────────────────────────────────
// GET https://api.stepfun.com/v1/accounts
// Response: { object, type, balance, total_cash_balance, total_voucher_balance }

async fn query_stepfun(api_key: &str) -> Result<UsageResult, String> {
    let client = crate::proxy::http_client::get();

    let resp = client
        .get("https://api.stepfun.com/v1/accounts")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(make_auth_error(status));
    }
    if !status.is_success() {
        return Ok(make_error(format!("API error (HTTP {status})")));
    }

    let raw = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(format!("Failed to read response: {e}")),
    };
    let body: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return Ok(make_error(format!("Failed to parse response: {e}"))),
    };

    match parse_stepfun_response(&body) {
        Ok(data) => Ok(UsageResult {
            success: true,
            data: Some(data),
            error: None,
        }),
        Err(err) => Ok(make_error(err)),
    }
}

// ── SiliconFlow ─────────────────────────────────────────────
// GET https://api.siliconflow.cn/v1/user/info (or .com for EN)
// Response: { code, data: { balance, chargeBalance, totalBalance, status } }

async fn query_siliconflow(api_key: &str, is_cn: bool) -> Result<UsageResult, String> {
    let client = crate::proxy::http_client::get();

    let domain = if is_cn {
        "api.siliconflow.cn"
    } else {
        "api.siliconflow.com"
    };
    let url = format!("https://{domain}/v1/user/info");

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(make_auth_error(status));
    }
    if !status.is_success() {
        return Ok(make_error(format!("API error (HTTP {status})")));
    }

    let raw = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(format!("Failed to read response: {e}")),
    };
    let body: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return Ok(make_error(format!("Failed to parse response: {e}"))),
    };

    match parse_siliconflow_response(&body, is_cn) {
        Ok(data) => Ok(UsageResult {
            success: true,
            data: Some(data),
            error: None,
        }),
        Err(err) => Ok(make_error(err)),
    }
}

// ── OpenRouter ──────────────────────────────────────────────
// GET https://openrouter.ai/api/v1/key      → { data: { limit, usage, limit_remaining } }
// GET https://openrouter.ai/api/v1/credits  → { data: { total_credits, total_usage } }
// A key with a spending limit reports what is left of that limit; otherwise
// the account credits are shown, which needs management permission.

enum JsonReply {
    Body(serde_json::Value),
    Status(reqwest::StatusCode),
    Unparsable(String),
}

async fn get_json(url: &str, api_key: &str) -> Result<JsonReply, String> {
    let resp = crate::proxy::http_client::get()
        .get(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Ok(JsonReply::Status(status));
    }
    let raw = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?;
    Ok(match serde_json::from_slice(&raw) {
        Ok(v) => JsonReply::Body(v),
        Err(e) => JsonReply::Unparsable(format!("Failed to parse response: {e}")),
    })
}

fn is_auth_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN
}

async fn query_openrouter(api_key: &str) -> Result<UsageResult, String> {
    let key_accepted = match get_json("https://openrouter.ai/api/v1/key", api_key).await? {
        JsonReply::Body(body) => {
            if let Some(data) = parse_openrouter_key_response(&body) {
                return Ok(UsageResult {
                    success: true,
                    data: Some(vec![data]),
                    error: None,
                });
            }
            true
        }
        JsonReply::Status(status) if status == reqwest::StatusCode::UNAUTHORIZED => {
            return Ok(make_auth_error(status));
        }
        JsonReply::Status(_) | JsonReply::Unparsable(_) => false,
    };

    match get_json("https://openrouter.ai/api/v1/credits", api_key).await? {
        JsonReply::Body(body) => match parse_openrouter_response(&body) {
            Ok(data) => Ok(UsageResult {
                success: true,
                data: Some(data),
                error: None,
            }),
            Err(err) => Ok(make_error(err)),
        },
        // `/key` already accepted this key: a refusal here is about the
        // permission to read account credits, not about the key working.
        JsonReply::Status(status) if is_auth_status(status) && key_accepted => Ok(make_error(
            "此 Key 未设消费上限，也没有读取账户余额的权限".to_string(),
        )),
        JsonReply::Status(status) if is_auth_status(status) => Ok(make_auth_error(status)),
        JsonReply::Status(status) => Ok(make_error(format!("API error (HTTP {status})"))),
        JsonReply::Unparsable(err) => Ok(make_error(err)),
    }
}

// ── Moonshot ────────────────────────────────────────────────
// GET https://api.moonshot.cn/v1/users/me/balance
// Response: { code: 0, status: true, data: { available_balance, voucher_balance, cash_balance } }

async fn query_moonshot(api_key: &str) -> Result<UsageResult, String> {
    match get_json("https://api.moonshot.cn/v1/users/me/balance", api_key).await? {
        JsonReply::Body(body) => match parse_moonshot_response(&body) {
            Ok(data) => Ok(UsageResult {
                success: true,
                data: Some(data),
                error: None,
            }),
            Err(err) => Ok(make_error(err)),
        },
        JsonReply::Status(status) if is_auth_status(status) => Ok(make_auth_error(status)),
        JsonReply::Status(status) => Ok(make_error(format!("API error (HTTP {status})"))),
        JsonReply::Unparsable(err) => Ok(make_error(err)),
    }
}

// ── Novita AI ───────────────────────────────────────────────
// GET https://api.novita.ai/v3/user/balance
// Response: { availableBalance, cashBalance, creditLimit, outstandingInvoices }
// 金额单位：0.0001 USD

async fn query_novita(api_key: &str) -> Result<UsageResult, String> {
    let client = crate::proxy::http_client::get();

    let resp = client
        .get("https://api.novita.ai/v3/user/balance")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(make_auth_error(status));
    }
    if !status.is_success() {
        return Ok(make_error(format!("API error (HTTP {status})")));
    }

    let raw = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(format!("Failed to read response: {e}")),
    };
    let body: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return Ok(make_error(format!("Failed to parse response: {e}"))),
    };

    match parse_novita_response(&body) {
        Ok(data) => Ok(UsageResult {
            success: true,
            data: Some(data),
            error: None,
        }),
        Err(err) => Ok(make_error(err)),
    }
}

// ── 工具函数 ────────────────────────────────────────────────

/// 解析 JSON 字段为有限 f64，兼容数字和合法浮点数字符串。
/// 拒绝缺失、null、布尔、非法字符串、NaN 和 Infinity。
/// Balances are shown with a few decimals; drop float noise such as
/// `0.30000000000000004` left by a subtraction.
fn round_money(value: f64) -> f64 {
    let rounded = (value * 1_000_000.0).round() / 1_000_000.0;
    if rounded.is_finite() {
        rounded
    } else {
        value
    }
}

fn parse_f64_field(obj: &serde_json::Value, field: &str) -> Option<f64> {
    let val = obj.get(field)?;
    let num = if let Some(n) = val.as_f64() {
        n
    } else if let Some(s) = val.as_str() {
        let s = s.trim();
        if s.eq_ignore_ascii_case("nan")
            || s.eq_ignore_ascii_case("inf")
            || s.eq_ignore_ascii_case("infinity")
            || s.eq_ignore_ascii_case("+inf")
            || s.eq_ignore_ascii_case("-inf")
            || s.eq_ignore_ascii_case("+infinity")
            || s.eq_ignore_ascii_case("-infinity")
        {
            return None;
        }
        s.parse::<f64>().ok()?
    } else {
        return None;
    };
    if num.is_finite() {
        Some(num)
    } else {
        None
    }
}

// ── 公开入口 ────────────────────────────────────────────────

/// 查询余额。瞬时传输失败返回 `Err`（前端 reject → retry + 保留上次成功值），
/// 确定性失败返回 `Ok(success:false)`（见模块级文档）。缺凭据或地址没有已知
/// 余额接口时不发请求，返回带类型化 `status` 的结果。
pub async fn get_balance(base_url: &str, api_key: &str) -> Result<BalanceResult, String> {
    if base_url.trim().is_empty() || api_key.trim().is_empty() {
        return Ok(BalanceResult::unavailable(
            BalanceStatus::MissingCredentials,
        ));
    }

    let Some(provider) = detect_provider(base_url) else {
        return Ok(BalanceResult::unavailable(BalanceStatus::Unsupported));
    };

    let usage = match provider {
        BalanceProvider::DeepSeek => query_deepseek(api_key).await,
        BalanceProvider::StepFun => query_stepfun(api_key).await,
        BalanceProvider::SiliconFlow => query_siliconflow(api_key, true).await,
        BalanceProvider::SiliconFlowEn => query_siliconflow(api_key, false).await,
        BalanceProvider::OpenRouter => query_openrouter(api_key).await,
        BalanceProvider::NovitaAI => query_novita(api_key).await,
        BalanceProvider::Moonshot => query_moonshot(api_key).await,
        BalanceProvider::ChimeraHub { origin } => query_chimerahub(&origin, api_key).await,
    }?;
    Ok(usage.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chimerahub_uses_points_and_preserves_unlimited() {
        let data = parse_chimerahub_response(&json!({"data":{"total_granted":1000,"total_used":25,"total_available":975,"unlimited_quota":false}})).unwrap();
        assert_eq!(data[0].unit.as_deref(), Some("点"));
        assert_eq!(data[0].remaining, Some(975.0));
        assert_eq!(data[0].extra.as_deref(), Some("unlimited_quota=false"));
        assert!(
            parse_chimerahub_response(&json!({"data":{"total_granted":1000,"total_used":25}}))
                .is_err()
        );
        let unlimited = parse_chimerahub_response(&json!({"data":{"total_granted":0,"total_used":0,"total_available":0,"unlimited_quota":true}})).unwrap();
        assert_eq!(unlimited[0].is_valid, Some(true));
    }

    #[test]
    fn balance_required_amounts() {
        // 1. StepFun: missing balance, null, bool, invalid str, NaN, 0.0, negative, string number
        assert!(parse_stepfun_response(&json!({})).is_err());
        assert!(parse_stepfun_response(&json!({ "balance": null })).is_err());
        assert!(parse_stepfun_response(&json!({ "balance": true })).is_err());
        assert!(parse_stepfun_response(&json!({ "balance": "abc" })).is_err());
        assert!(parse_stepfun_response(&json!({ "balance": "NaN" })).is_err());
        assert!(parse_stepfun_response(&json!({ "balance": "Infinity" })).is_err());

        let zero_res = parse_stepfun_response(&json!({ "balance": 0.0 })).expect("0.0 succeeds");
        assert_eq!(zero_res[0].remaining, Some(0.0));

        let str_zero =
            parse_stepfun_response(&json!({ "balance": "0.0" })).expect("str 0.0 succeeds");
        assert_eq!(str_zero[0].remaining, Some(0.0));

        let neg_res = parse_stepfun_response(&json!({ "balance": -15.5 }))
            .expect("negative balance succeeds");
        assert_eq!(neg_res[0].remaining, Some(-15.5));

        // 2. OpenRouter: must have both total_credits and total_usage
        assert!(parse_openrouter_response(&json!({ "data": { "total_credits": 10.0 } })).is_err());
        assert!(parse_openrouter_response(&json!({ "data": { "total_usage": 5.0 } })).is_err());
        assert!(parse_openrouter_response(
            &json!({ "data": { "total_credits": null, "total_usage": 5.0 } })
        )
        .is_err());
        assert!(parse_openrouter_response(
            &json!({ "data": { "total_credits": "NaN", "total_usage": 5.0 } })
        )
        .is_err());

        let or_res = parse_openrouter_response(&json!({
            "data": { "total_credits": 10.0, "total_usage": 15.0 }
        }))
        .expect("negative balance on openrouter succeeds");
        assert_eq!(or_res[0].remaining, Some(-5.0));
        assert_eq!(or_res[0].is_valid, Some(true));

        let or_zero = parse_openrouter_response(&json!({
            "data": { "total_credits": 10.0, "total_usage": 10.0 }
        }))
        .expect("zero balance succeeds");
        assert_eq!(or_zero[0].remaining, Some(0.0));

        // 3. SiliconFlow: missing data, missing totalBalance, null, string number
        assert!(parse_siliconflow_response(&json!({}), true).is_err());
        assert!(parse_siliconflow_response(&json!({ "data": {} }), true).is_err());
        assert!(
            parse_siliconflow_response(&json!({ "data": { "totalBalance": null } }), true).is_err()
        );
        assert!(parse_siliconflow_response(
            &json!({ "data": { "totalBalance": "invalid" } }),
            true
        )
        .is_err());
        let sf_ok =
            parse_siliconflow_response(&json!({ "data": { "totalBalance": "12.34" } }), true)
                .expect("sf ok");
        assert_eq!(sf_ok[0].remaining, Some(12.34));

        // 4. Novita: missing availableBalance, null, negative, zero
        assert!(parse_novita_response(&json!({})).is_err());
        assert!(parse_novita_response(&json!({ "availableBalance": null })).is_err());
        let nov_zero = parse_novita_response(&json!({ "availableBalance": 0 })).expect("nov zero");
        assert_eq!(nov_zero[0].remaining, Some(0.0));

        // 5. DeepSeek: missing balance_infos, empty array, missing total_balance
        assert!(parse_deepseek_response(&json!({})).is_err());
        assert!(parse_deepseek_response(&json!({ "balance_infos": [] })).is_err());
        assert!(
            parse_deepseek_response(&json!({ "balance_infos": [{ "currency": "CNY" }] })).is_err()
        );
        let ds_ok = parse_deepseek_response(&json!({
            "is_available": true,
            "balance_infos": [{ "currency": "CNY", "total_balance": 0.0 }]
        }))
        .expect("ds ok");
        assert_eq!(ds_ok[0].remaining, Some(0.0));
    }

    #[test]
    fn deepseek_balance_hides_empty_wallets_when_another_has_funds() {
        let data = parse_deepseek_response(&json!({
            "is_available": true,
            "balance_infos": [
                { "currency": "CNY", "total_balance": "0.00" },
                { "currency": "USD", "total_balance": "12.34" }
            ]
        }))
        .expect("parsed");
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].unit.as_deref(), Some("USD"));
        assert_eq!(data[0].remaining, Some(12.34));
    }

    #[test]
    fn deepseek_balance_keeps_every_wallet_when_none_or_all_have_funds() {
        for (cny, usd) in [("0.00", "0.00"), ("5.00", "1.00")] {
            let data = parse_deepseek_response(&json!({
                "is_available": true,
                "balance_infos": [
                    { "currency": "CNY", "total_balance": cny },
                    { "currency": "USD", "total_balance": usd }
                ]
            }))
            .expect("parsed");
            assert_eq!(data.len(), 2, "cny={cny} usd={usd}");
        }

        let single = parse_deepseek_response(&json!({
            "is_available": false,
            "balance_infos": [{ "currency": "CNY", "total_balance": "0.00" }]
        }))
        .expect("parsed");
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].remaining, Some(0.0));
    }

    #[test]
    fn openrouter_balance_does_not_decide_key_validity() {
        // Free, exhausted, overdrawn and funded accounts all report a balance;
        // none of them means the key expired.
        for (credits, usage, remaining) in [
            (0.0, 0.0, 0.0),
            (100.0, 100.0, 0.0),
            (100.0, 105.0, -5.0),
            (100.0, 25.5, 74.5),
        ] {
            let data = parse_openrouter_response(&json!({
                "data": { "total_credits": credits, "total_usage": usage }
            }))
            .expect("a parsed balance succeeds");
            assert_eq!(data.len(), 1);
            let balance = &data[0];
            assert_eq!(balance.plan_name.as_deref(), Some("OpenRouter"));
            assert_eq!(balance.unit.as_deref(), Some("USD"));
            assert_eq!(balance.total, Some(credits));
            assert_eq!(balance.used, Some(usage));
            assert_eq!(balance.remaining, Some(remaining));
            assert_eq!(balance.is_valid, Some(true));
            assert!(balance.invalid_message.is_none());
        }

        // Strings and an unwrapped body still parse.
        let data = parse_openrouter_response(
            &json!({ "total_credits": "100.00", "total_usage": "25.50" }),
        )
        .expect("unwrapped numeric strings");
        assert_eq!(data[0].remaining, Some(74.5));

        // Finite inputs whose difference overflows are not a balance.
        assert!(parse_openrouter_response(&json!({
            "data": { "total_credits": 1e308, "total_usage": -1e308 }
        }))
        .is_err());
    }

    #[test]
    fn openrouter_key_limit_is_preferred_and_unlimited_keys_fall_back() {
        let data = parse_openrouter_key_response(&json!({
            "data": { "label": "k", "limit": 20, "usage": 7.3, "limit_remaining": 12.7 }
        }))
        .expect("a key with a limit");
        assert_eq!(data.plan_name.as_deref(), Some("OpenRouter Key"));
        assert_eq!(data.remaining, Some(12.7));
        assert_eq!(data.total, Some(20.0));
        assert_eq!(data.used, Some(7.3));
        assert_eq!(data.is_valid, Some(true));

        // No spending limit: `/credits` decides.
        assert!(parse_openrouter_key_response(&json!({
            "data": { "limit": null, "usage": 3, "limit_remaining": null }
        }))
        .is_none());
    }

    #[test]
    fn openrouter_credit_subtraction_has_no_float_noise() {
        let data = parse_openrouter_response(&json!({
            "data": { "total_credits": 1.1, "total_usage": 0.8 }
        }))
        .expect("parsed");
        assert_eq!(data[0].remaining, Some(0.3));
    }

    #[test]
    fn moonshot_balance_requires_an_accepted_reply() {
        let data = parse_moonshot_response(&json!({
            "code": 0, "status": true,
            "data": { "available_balance": 49.58894, "voucher_balance": 46.58893, "cash_balance": 3.00001 }
        }))
        .expect("accepted");
        assert_eq!(data[0].plan_name.as_deref(), Some("Moonshot"));
        assert_eq!(data[0].unit.as_deref(), Some("CNY"));
        assert_eq!(data[0].remaining, Some(49.58894));

        assert!(parse_moonshot_response(&json!({
            "code": 1, "status": false, "data": { "available_balance": 1 }
        }))
        .is_err());
        assert!(
            parse_moonshot_response(&json!({ "code": 0, "status": true, "data": {} })).is_err()
        );
    }

    #[test]
    fn novita_balance_does_not_decide_key_validity() {
        for (raw, available) in [(0.0, 0.0), (-50000.0, -5.0), (255000.0, 25.5)] {
            let data = parse_novita_response(&json!({ "availableBalance": raw }))
                .expect("a parsed balance succeeds");
            assert_eq!(data.len(), 1);
            let balance = &data[0];
            assert_eq!(balance.remaining, Some(available));
            assert_eq!(balance.unit.as_deref(), Some("USD"));
            assert_eq!(balance.is_valid, Some(true));
            assert!(balance.invalid_message.is_none());
        }
        let data =
            parse_novita_response(&json!({ "availableBalance": "10000" })).expect("numeric string");
        assert_eq!(data[0].remaining, Some(1.0));
        for body in [
            json!({ "availableBalance": "invalid" }),
            json!({ "availableBalance": "inf" }),
            json!({ "cashBalance": 10000 }),
        ] {
            assert!(
                parse_novita_response(&body).is_err(),
                "unexpected success for {body}"
            );
        }
    }

    #[test]
    fn detect_provider_strict_url() {
        assert!(matches!(
            detect_provider("https://api.deepseek.com"),
            Some(BalanceProvider::DeepSeek)
        ));
        assert!(matches!(
            detect_provider("https://api.deepseek.com/v1"),
            Some(BalanceProvider::DeepSeek)
        ));
        assert!(matches!(
            detect_provider("https://API.DEEPSEEK.COM/v1"),
            Some(BalanceProvider::DeepSeek)
        ));
        assert!(matches!(
            detect_provider("https://api.deepseek.com:443/v1"),
            Some(BalanceProvider::DeepSeek)
        ));
        assert!(matches!(
            detect_provider("https://api.stepfun.ai/v1"),
            Some(BalanceProvider::StepFun)
        ));
        assert!(matches!(
            detect_provider("https://api.stepfun.com/v1"),
            Some(BalanceProvider::StepFun)
        ));
        assert!(matches!(
            detect_provider("https://api.siliconflow.cn/v1"),
            Some(BalanceProvider::SiliconFlow)
        ));
        assert!(matches!(
            detect_provider("https://api.siliconflow.com/v1"),
            Some(BalanceProvider::SiliconFlowEn)
        ));
        assert!(matches!(
            detect_provider("https://openrouter.ai/api"),
            Some(BalanceProvider::OpenRouter)
        ));
        assert!(matches!(
            detect_provider("https://api.novita.ai/v3"),
            Some(BalanceProvider::NovitaAI)
        ));
        assert!(matches!(
            detect_provider("https://api.moonshot.cn/v1"),
            Some(BalanceProvider::Moonshot)
        ));
        assert_eq!(detect_provider("https://api.moonshot.ai/v1"), None);

        // 拒绝非 https、路径/查询伪装、子域伪装、userinfo、异常端口
        assert!(detect_provider("http://api.deepseek.com/v1").is_none());
        assert!(detect_provider("https://evil.test/?api.deepseek.com").is_none());
        assert!(detect_provider("https://api.deepseek.com.evil.test/v1").is_none());
        assert!(detect_provider("https://evil.test/api.deepseek.com").is_none());
        assert!(detect_provider("https://user:pass@api.deepseek.com/v1").is_none());
        assert!(detect_provider("https://api.deepseek.com:8443/v1").is_none());
        assert!(detect_provider("").is_none());
        assert!(detect_provider("not a url").is_none());
    }

    #[test]
    fn chimerahub_is_detected_on_its_whole_domain_and_queried_on_the_same_origin() {
        assert_eq!(
            detect_provider(crate::builtin_templates::CHIMERAHUB_BASE_URL),
            Some(BalanceProvider::ChimeraHub {
                origin: "https://api.chimerahub.org".to_string()
            })
        );
        // A dedicated relay address keeps its own host; the key never goes to
        // a different host than the one the line already uses.
        assert_eq!(
            detect_provider("https://Relay-2.ChimeraHub.org/v1"),
            Some(BalanceProvider::ChimeraHub {
                origin: "https://relay-2.chimerahub.org".to_string()
            })
        );
        assert!(detect_provider("http://api.chimerahub.org/v1").is_none());
        assert!(detect_provider("https://api.chimerahub.org:8443/v1").is_none());
        assert!(detect_provider("https://user:pass@api.chimerahub.org/v1").is_none());
        assert!(detect_provider("https://chimerahub.org.evil.test/v1").is_none());
        assert!(detect_provider("https://evilchimerahub.org/v1").is_none());
    }

    #[tokio::test]
    async fn balance_without_credentials_or_known_api_returns_a_typed_status() {
        for (base_url, api_key) in [
            ("", "sk-test"),
            ("   ", "sk-test"),
            ("https://api.chimerahub.org/v1", ""),
            ("https://api.chimerahub.org/v1", "  "),
        ] {
            let result = get_balance(base_url, api_key).await.expect("no request");
            assert_eq!(result.status, Some(BalanceStatus::MissingCredentials));
            assert!(!result.usage.success);
            assert!(result.usage.error.is_none());
        }

        // Any relay without a known balance API, not only "non-relay" lines.
        let result = get_balance("https://relay.example.com/v1", "sk-test")
            .await
            .expect("no request");
        assert_eq!(result.status, Some(BalanceStatus::Unsupported));
        assert!(!result.usage.success);
        assert!(result.usage.error.is_none());
    }

    #[test]
    fn balance_status_serializes_next_to_the_usage_fields() {
        let unsupported =
            serde_json::to_value(BalanceResult::unavailable(BalanceStatus::Unsupported)).unwrap();
        assert_eq!(
            unsupported,
            json!({ "success": false, "status": "unsupported" })
        );
        let missing = serde_json::to_value(BalanceResult::unavailable(
            BalanceStatus::MissingCredentials,
        ))
        .unwrap();
        assert_eq!(missing["status"], "missing_credentials");

        let ok = serde_json::to_value(BalanceResult::from(UsageResult {
            success: true,
            data: None,
            error: None,
        }))
        .unwrap();
        assert_eq!(ok, json!({ "success": true }));
    }

    #[test]
    fn usage_template_callers_get_a_stable_message_for_a_status() {
        let usage = BalanceResult::unavailable(BalanceStatus::Unsupported).into_usage_result();
        assert!(!usage.success);
        assert_eq!(
            usage.error.as_deref(),
            Some("Balance query is not supported for this endpoint")
        );
        let untouched =
            BalanceResult::from(make_error("API error (HTTP 500)".to_string())).into_usage_result();
        assert_eq!(untouched.error.as_deref(), Some("API error (HTTP 500)"));
    }
}
