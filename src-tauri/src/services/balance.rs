//! 供应商余额查询服务
//!
//! 支持 DeepSeek、StepFun、SiliconFlow、OpenRouter、Novita AI 的账户余额查询。
//! 返回 UsageResult 格式，与现有用量系统无缝对接。
//!
//! 错误通道语义（与 coding_plan / subscription 两个服务保持一致）：
//! - `Err(String)` = 瞬时传输失败（网络不可达/超时/读体中断）。前端 invoke reject，
//!   react-query 触发 retry 并保留上一次成功的 data（天然 keep-last-good）。
//! - `Ok(success:false)` = 确定性失败（空 key/未知供应商/鉴权/非 2xx/响应体非法 JSON），
//!   立即透出错误文案。判定按 reqwest 错误种类在折叠点完成，不依赖错误文案匹配。

use crate::provider::{UsageData, UsageResult};
use std::time::Duration;
use url::Url;

// ── 供应商检测 ──────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
enum BalanceProvider {
    DeepSeek,
    StepFun,
    SiliconFlow,
    SiliconFlowEn,
    OpenRouter,
    NovitaAI,
    ChimeraHub,
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
        "api.chimerahub.org" => Some(BalanceProvider::ChimeraHub),
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

    Ok(vec![UsageData {
        plan_name: Some("OpenRouter".to_string()),
        remaining: Some(remaining),
        total: Some(total_credits),
        used: Some(total_usage),
        unit: Some("USD".to_string()),
        is_valid: Some(remaining > 0.0),
        invalid_message: if remaining <= 0.0 {
            Some("No credits remaining".to_string())
        } else {
            None
        },
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
        is_valid: Some(available > 0.0),
        invalid_message: if available <= 0.0 {
            Some("No balance remaining".to_string())
        } else {
            None
        },
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

async fn query_chimerahub(api_key: &str) -> Result<UsageResult, String> {
    let resp = crate::proxy::http_client::get()
        .get("https://api.chimerahub.org/api/usage/token/")
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
        if let Some(account) = query_chimerahub_account(api_key).await {
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

async fn query_chimerahub_account(api_key: &str) -> Option<ChimeraHubAccount> {
    let client = crate::proxy::http_client::get();
    let sub = client
        .get("https://api.chimerahub.org/v1/dashboard/billing/subscription")
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
        .get("https://api.chimerahub.org/v1/dashboard/billing/usage")
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
// GET https://openrouter.ai/api/v1/credits
// Response: { data: { total_credits, total_usage } }

async fn query_openrouter(api_key: &str) -> Result<UsageResult, String> {
    let client = crate::proxy::http_client::get();

    let resp = client
        .get("https://openrouter.ai/api/v1/credits")
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

    match parse_openrouter_response(&body) {
        Ok(data) => Ok(UsageResult {
            success: true,
            data: Some(data),
            error: None,
        }),
        Err(err) => Ok(make_error(err)),
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
/// 确定性失败返回 `Ok(success:false)`（见模块级文档）。
pub async fn get_balance(base_url: &str, api_key: &str) -> Result<UsageResult, String> {
    if api_key.trim().is_empty() {
        return Ok(UsageResult {
            success: false,
            data: None,
            error: Some("API key is empty".to_string()),
        });
    }

    let provider = match detect_provider(base_url) {
        Some(p) => p,
        None => {
            return Ok(UsageResult {
                success: false,
                data: None,
                error: Some("Unknown balance provider".to_string()),
            })
        }
    };

    match provider {
        BalanceProvider::DeepSeek => query_deepseek(api_key).await,
        BalanceProvider::StepFun => query_stepfun(api_key).await,
        BalanceProvider::SiliconFlow => query_siliconflow(api_key, true).await,
        BalanceProvider::SiliconFlowEn => query_siliconflow(api_key, false).await,
        BalanceProvider::OpenRouter => query_openrouter(api_key).await,
        BalanceProvider::NovitaAI => query_novita(api_key).await,
        BalanceProvider::ChimeraHub => query_chimerahub(api_key).await,
    }
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
        assert_eq!(or_res[0].is_valid, Some(false));

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
}
