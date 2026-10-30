//! Plan quota for saved Claude Code accounts: the 5-hour and weekly windows,
//! per-model weekly windows and extra usage, plus whether a window has reset
//! since the last reading.
//!
//! The usage request and its parsing are `services::subscription`'s. Here:
//! - the account Claude Code uses now is queried with the live credentials
//!   only and never refreshed from the vault copy;
//! - a saved, inactive account whose token is about to expire is refreshed
//!   and the rotated tokens are written back to the vault at once;
//! - the last good reading (windows only, never tokens) is kept per account
//!   and automatic readings are spaced at least five minutes apart.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::code::{self, CodeVault, LivePaths, QuotaSource};
use crate::error::AppError;
use crate::services::subscription::{
    CredentialStatus, SubscriptionQuota, TIER_FIVE_HOUR, TIER_MODEL_WEEKLY_PREFIX, TIER_SEVEN_DAY,
    TIER_SEVEN_DAY_OPUS, TIER_SEVEN_DAY_SONNET,
};

const OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const MAX_TOKEN_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024;
const REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;
/// Automatic readings per account are at least this far apart.
const AUTO_INTERVAL_MS: i64 = 5 * 60 * 1000;
/// Even a manual refresh reuses a reading this fresh.
const MANUAL_DEBOUNCE_MS: i64 = 10 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuotaStatus {
    /// Read just now.
    Fresh,
    /// The last reading, reused (within the automatic interval).
    Cached,
    /// The saved login's refresh token was rejected.
    NeedsRelogin,
    /// The active login has expired; Claude Code renews it when used.
    LiveExpired,
    /// Refresh or reading failed for now; the last reading is shown.
    Unavailable,
    /// No login to read with.
    NotSignedIn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowKind {
    Session,
    Weekly,
    Model,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredWindow {
    pub name: String,
    pub utilization: f64,
    pub resets_at: Option<String>,
    /// When a reset was observed (the previous reset time), kept while the
    /// window keeps the same reset time.
    #[serde(default)]
    pub reset_observed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraUsageView {
    pub used: f64,
    pub limit: f64,
    pub utilization: f64,
    pub currency: String,
    pub resets_at: Option<String>,
}

/// The last good reading of an account. No tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub fetched_at: i64,
    pub windows: Vec<StoredWindow>,
    #[serde(default)]
    pub extra_usage: Option<ExtraUsageView>,
    /// Claude Desktop accounts only: what the profile API said last time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindowView {
    pub name: String,
    pub label: String,
    pub kind: WindowKind,
    pub utilization: f64,
    /// Next reset; `None` once the known reset time has passed.
    pub resets_at: Option<String>,
    /// The window has reset since the last reading.
    pub reset: bool,
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaView {
    pub status: QuotaStatus,
    pub windows: Vec<QuotaWindowView>,
    pub extra_usage: Option<ExtraUsageView>,
    pub fetched_at: Option<i64>,
}

// ===== pure helpers =====

fn parse_ms(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn window_meta(name: &str) -> Option<(String, WindowKind)> {
    match name {
        TIER_FIVE_HOUR => Some(("5 小时".to_string(), WindowKind::Session)),
        TIER_SEVEN_DAY => Some(("每周".to_string(), WindowKind::Weekly)),
        TIER_SEVEN_DAY_OPUS => Some(("每周 · Opus".to_string(), WindowKind::Model)),
        TIER_SEVEN_DAY_SONNET => Some(("每周 · Sonnet".to_string(), WindowKind::Model)),
        _ => name
            .strip_prefix(TIER_MODEL_WEEKLY_PREFIX)
            .map(|model| (format!("每周 · {model}"), WindowKind::Model)),
    }
}

/// The windows worth showing from a successful reading.
pub(crate) fn fresh_windows(quota: &SubscriptionQuota) -> Vec<StoredWindow> {
    quota
        .tiers
        .iter()
        .filter(|tier| window_meta(&tier.name).is_some() && tier.utilization.is_finite())
        .map(|tier| StoredWindow {
            name: tier.name.clone(),
            utilization: tier.utilization.clamp(0.0, 100.0),
            resets_at: tier.resets_at.clone(),
            reset_observed_at: None,
        })
        .collect()
}

/// Extra usage, credits in cents converted to currency units.
// Adapted from realiti4/claude-swap 72ccd58 (src/claude_swap/oauth.py)
pub(crate) fn extra_usage_view(quota: &SubscriptionQuota) -> Option<ExtraUsageView> {
    let extra = quota
        .extra_usage
        .as_ref()
        .filter(|extra| extra.is_enabled)?;
    Some(ExtraUsageView {
        used: extra.used_credits? / 100.0,
        limit: extra.monthly_limit? / 100.0,
        utilization: extra.utilization?,
        currency: extra.currency.clone().unwrap_or_else(|| "USD".to_string()),
        resets_at: extra.resets_at.clone(),
    })
}

/// How long a window shows as "just reset" after its reset time.
const RESET_BADGE_MS: i64 = 60 * 60 * 1000;

/// A fresh reading against the previous one: a window whose previous reset
/// time has passed and now resets later has reset.
pub(crate) fn merge_windows(
    previous: Option<&Snapshot>,
    fresh: Vec<StoredWindow>,
    now_ms: i64,
) -> Vec<StoredWindow> {
    fresh
        .into_iter()
        .map(|mut window| {
            let old = previous
                .and_then(|snapshot| snapshot.windows.iter().find(|old| old.name == window.name));
            if let Some(old) = old {
                let old_reset = old.resets_at.as_deref().and_then(parse_ms);
                let new_reset = window.resets_at.as_deref().and_then(parse_ms);
                window.reset_observed_at = match (old_reset, new_reset) {
                    (Some(before), Some(after)) if before <= now_ms && after > before => {
                        old.resets_at.clone()
                    }
                    _ if old.resets_at == window.resets_at => old.reset_observed_at.clone(),
                    _ => None,
                };
            }
            window
        })
        .collect()
}

/// What to show from a stored reading: a window whose reset time has passed
/// shows as reset, with nothing used, until the next reading.
pub(crate) fn view_of(snapshot: Option<&Snapshot>, status: QuotaStatus, now_ms: i64) -> QuotaView {
    let windows = snapshot
        .map(|snapshot| {
            snapshot
                .windows
                .iter()
                .filter_map(|window| {
                    let (label, kind) = window_meta(&window.name)?;
                    let passed = window
                        .resets_at
                        .as_deref()
                        .and_then(parse_ms)
                        .is_some_and(|reset| reset <= now_ms);
                    Some(if passed {
                        QuotaWindowView {
                            name: window.name.clone(),
                            label,
                            kind,
                            utilization: 0.0,
                            resets_at: None,
                            reset: true,
                            reset_at: window.resets_at.clone(),
                        }
                    } else {
                        // "Just reset" is news for a while, not for the
                        // whole new window.
                        let recent_reset = window.reset_observed_at.clone().filter(|at| {
                            parse_ms(at).is_some_and(|at| now_ms - at < RESET_BADGE_MS)
                        });
                        QuotaWindowView {
                            name: window.name.clone(),
                            label,
                            kind,
                            utilization: window.utilization,
                            resets_at: window.resets_at.clone(),
                            reset: recent_reset.is_some(),
                            reset_at: recent_reset,
                        }
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    QuotaView {
        status,
        windows,
        extra_usage: snapshot.and_then(|snapshot| snapshot.extra_usage.clone()),
        fetched_at: snapshot.map(|snapshot| snapshot.fetched_at),
    }
}

/// `expiresAt` (ms, or seconds from older writers) within the margin or past.
pub(crate) fn needs_refresh(expires_at: Option<&Value>, now_ms: i64) -> bool {
    let Some(raw) = expires_at.and_then(Value::as_f64) else {
        return false;
    };
    let ms = if raw < 1e12 { raw * 1000.0 } else { raw };
    ms - (now_ms as f64) <= REFRESH_MARGIN_MS as f64
}

pub(crate) struct RefreshedTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at_ms: i64,
    pub scopes: Option<Vec<String>>,
}

pub(crate) enum RefreshOutcome {
    Refreshed(RefreshedTokens),
    /// The grant is dead: sign in again.
    InvalidGrant,
    /// Our client id was refused: systemic, says nothing about the login.
    InvalidClient,
    /// Network, server or unexpected answer: keep the old data.
    Transient,
}

/// Classifies a token-endpoint answer. Permanent only when a 400/401/403
/// carries a top-level JSON `error` saying so; everything ambiguous stays
/// transient.
// Adapted from realiti4/claude-swap 72ccd58 (src/claude_swap/oauth.py)
pub(crate) fn classify_refresh_response(status: u16, body: &[u8], now_ms: i64) -> RefreshOutcome {
    let json = serde_json::from_slice::<Value>(body).ok();
    if (200..300).contains(&status) {
        let Some(json) = json else {
            return RefreshOutcome::Transient;
        };
        let access = json
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty());
        let expires_in = json.get("expires_in").and_then(Value::as_f64);
        let (Some(access), Some(expires_in)) = (access, expires_in) else {
            return RefreshOutcome::Transient;
        };
        return RefreshOutcome::Refreshed(RefreshedTokens {
            access_token: access.to_string(),
            refresh_token: json
                .get("refresh_token")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
                .map(str::to_string),
            expires_at_ms: now_ms.saturating_add((expires_in * 1000.0) as i64),
            scopes: json
                .get("scope")
                .and_then(Value::as_str)
                .map(|scope| scope.split_whitespace().map(str::to_string).collect()),
        });
    }
    if matches!(status, 400 | 401 | 403) {
        match json
            .as_ref()
            .and_then(|json| json.get("error"))
            .and_then(Value::as_str)
        {
            Some("invalid_grant") => return RefreshOutcome::InvalidGrant,
            Some("invalid_client") => return RefreshOutcome::InvalidClient,
            _ => {}
        }
    }
    RefreshOutcome::Transient
}

// ===== snapshot storage =====

fn read_snapshot(vault: &CodeVault, id: &str) -> Option<Snapshot> {
    let path = vault.quota_path(id).ok()?;
    let bytes = crate::security_limits::read_limited(&path, MAX_SNAPSHOT_BYTES).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_snapshot(vault: &CodeVault, id: &str, snapshot: &Snapshot) -> Result<(), AppError> {
    let path = vault.quota_path(id)?;
    let bytes = serde_json::to_vec(snapshot).map_err(|e| AppError::JsonSerialize { source: e })?;
    crate::config::atomic_write(&path, &bytes)
}

// ===== network =====

/// The network side, injectable for tests.
pub(crate) trait QuotaHttp {
    async fn refresh(&self, refresh_token: &str) -> RefreshOutcome;
    async fn usage(&self, access_token: &str) -> Result<SubscriptionQuota, String>;
    async fn live_usage(&self) -> Result<SubscriptionQuota, String>;
}

pub(crate) struct NetworkQuotaHttp;

async fn read_body_limited(response: reqwest::Response, max: usize) -> Option<Vec<u8>> {
    use futures::StreamExt;
    if response
        .content_length()
        .is_some_and(|length| length > max as u64)
    {
        return None;
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if body.len() + chunk.len() > max {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    Some(body)
}

impl QuotaHttp for NetworkQuotaHttp {
    // Adapted from realiti4/claude-swap 72ccd58 (src/claude_swap/oauth.py)
    async fn refresh(&self, refresh_token: &str) -> RefreshOutcome {
        // No redirects: the request carries a refresh token.
        let Ok(client) = crate::proxy::http_client::get_for_auth_probe() else {
            return RefreshOutcome::Transient;
        };
        let body = serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": OAUTH_CLIENT_ID,
        });
        let Ok(body) = serde_json::to_vec(&body) else {
            return RefreshOutcome::Transient;
        };
        let response = client
            .post(OAUTH_TOKEN_URL)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .timeout(std::time::Duration::from_secs(15))
            .body(body)
            .send()
            .await;
        let Ok(response) = response else {
            return RefreshOutcome::Transient;
        };
        let status = response.status().as_u16();
        match read_body_limited(response, MAX_TOKEN_RESPONSE_BYTES).await {
            Some(body) => classify_refresh_response(status, &body, now_ms()),
            None => RefreshOutcome::Transient,
        }
    }

    async fn usage(&self, access_token: &str) -> Result<SubscriptionQuota, String> {
        crate::services::subscription::query_claude_quota(access_token).await
    }

    async fn live_usage(&self) -> Result<SubscriptionQuota, String> {
        crate::services::subscription::get_subscription_quota("claude").await
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn token_of(oauth: &Value, key: &str) -> Option<String> {
    oauth
        .get(key)
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

fn is_auth_failure(quota: &SubscriptionQuota) -> bool {
    !quota.success && matches!(quota.credential_status, CredentialStatus::Expired)
}

/// Refreshes a saved login, writing the result straight to the vault.
/// `Err(status)` is what to show when no usable token came out.
async fn refresh_saved(
    vault: &CodeVault,
    id: &str,
    oauth: &Value,
    http: &impl QuotaHttp,
) -> Result<String, QuotaStatus> {
    let Some(refresh_token) = token_of(oauth, "refreshToken") else {
        let _ = code::mark_needs_relogin(vault, id);
        return Err(QuotaStatus::NeedsRelogin);
    };
    match http.refresh(&refresh_token).await {
        RefreshOutcome::Refreshed(tokens) => {
            // The old refresh token is spent now, so the new one must reach
            // the vault: retry a briefly locked file before giving up.
            let mut attempt = 0;
            loop {
                match code::store_refreshed(
                    vault,
                    id,
                    &tokens.access_token,
                    tokens.refresh_token.as_deref(),
                    tokens.expires_at_ms,
                    tokens.scopes.clone(),
                ) {
                    Ok(()) => break,
                    Err(error) if attempt < 2 => {
                        attempt += 1;
                        log::warn!("保存刷新后的 Claude 登录失败，重试: {error}");
                        tokio::time::sleep(std::time::Duration::from_millis(200 * attempt)).await;
                    }
                    Err(error) => {
                        log::error!("保存刷新后的 Claude 登录失败: {error}");
                        return Err(QuotaStatus::Unavailable);
                    }
                }
            }
            Ok(tokens.access_token)
        }
        RefreshOutcome::InvalidGrant => {
            let _ = code::mark_needs_relogin(vault, id);
            Err(QuotaStatus::NeedsRelogin)
        }
        RefreshOutcome::InvalidClient | RefreshOutcome::Transient => Err(QuotaStatus::Unavailable),
    }
}

/// Reads one account's quota. The caller holds that account's lock.
pub(crate) async fn read_quota(
    vault: &CodeVault,
    paths: &LivePaths,
    id: &str,
    force: bool,
    now: i64,
    http: &impl QuotaHttp,
) -> Result<QuotaView, AppError> {
    let previous = read_snapshot(vault, id);
    let age = previous.as_ref().map(|snapshot| now - snapshot.fetched_at);
    let limit = if force {
        MANUAL_DEBOUNCE_MS
    } else {
        AUTO_INTERVAL_MS
    };
    let cached = |status: QuotaStatus| -> Result<QuotaView, AppError> {
        Ok(view_of(previous.as_ref(), status, now))
    };

    let quota = match code::quota_source(vault, paths, id)? {
        QuotaSource::Live => {
            if age.is_some_and(|age| (0..limit).contains(&age)) {
                return cached(QuotaStatus::Cached);
            }
            let result = http.live_usage().await;
            // A switch may have replaced the live login during the request;
            // then the reading belongs to another account.
            if !matches!(code::quota_source(vault, paths, id)?, QuotaSource::Live) {
                return cached(QuotaStatus::Unavailable);
            }
            match result {
                Ok(quota) if quota.success => quota,
                Ok(quota) => {
                    return cached(match quota.credential_status {
                        CredentialStatus::Expired => QuotaStatus::LiveExpired,
                        CredentialStatus::NotFound => QuotaStatus::NotSignedIn,
                        _ => QuotaStatus::Unavailable,
                    })
                }
                Err(_) => return cached(QuotaStatus::Unavailable),
            }
        }
        QuotaSource::Saved(slot) => {
            if slot.needs_relogin() {
                return cached(QuotaStatus::NeedsRelogin);
            }
            if age.is_some_and(|age| (0..limit).contains(&age)) {
                return cached(QuotaStatus::Cached);
            }
            let oauth = slot.oauth().clone();
            let mut refreshed = false;
            let mut token = match token_of(&oauth, "accessToken") {
                Some(token) if !needs_refresh(oauth.get("expiresAt"), now) => token,
                _ => {
                    refreshed = true;
                    match refresh_saved(vault, id, &oauth, http).await {
                        Ok(token) => token,
                        Err(status) => return cached(status),
                    }
                }
            };
            let mut result = http.usage(&token).await;
            if !refreshed && result.as_ref().is_ok_and(is_auth_failure) {
                token = match refresh_saved(vault, id, &oauth, http).await {
                    Ok(token) => token,
                    Err(status) => return cached(status),
                };
                result = http.usage(&token).await;
            }
            match result {
                Ok(quota) if quota.success => quota,
                // The token was just refreshed, so a refusal now (a 403 from a
                // missing scope or a blocked region) is not a dead login; only
                // a rejected refresh token asks for a new login.
                _ => return cached(QuotaStatus::Unavailable),
            }
        }
    };

    let snapshot = Snapshot {
        fetched_at: now,
        windows: merge_windows(previous.as_ref(), fresh_windows(&quota), now),
        extra_usage: extra_usage_view(&quota),
        email: None,
        plan: None,
    };
    if let Err(error) = write_snapshot(vault, id, &snapshot) {
        log::warn!("保存 Claude 账号额度快照失败: {error}");
    }
    Ok(view_of(Some(&snapshot), QuotaStatus::Fresh, now))
}

/// Entry point for the command: one reading per account at a time.
pub async fn account_quota(id: String, force: bool) -> Result<QuotaView, AppError> {
    super::validate_account_id(&id)?;
    let lock = code::account_lock(&id);
    let _guard = lock.lock().await;
    let vault = CodeVault::open_default()?;
    read_quota(
        &vault,
        &LivePaths::current(),
        &id,
        force,
        now_ms(),
        &NetworkQuotaHttp,
    )
    .await
}

// ===== Claude Desktop =====

/// A Claude Desktop account's plan and quota, read with the profile's own
/// token. Never refreshed: an expired token is Claude Desktop's to renew.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopQuotaDto {
    pub email: Option<String>,
    pub plan: Option<String>,
    pub quota: QuotaView,
}

/// `default` is Claude Desktop's own data folder.
pub(crate) const DEFAULT_DESKTOP_ID: &str = "default";
const MAX_PROFILE_RESPONSE_BYTES: usize = 64 * 1024;

/// Email and organization type from the OAuth profile endpoint.
async fn desktop_profile(access_token: &str) -> (Option<String>, Option<String>) {
    let response = crate::proxy::http_client::get()
        .get("https://api.anthropic.com/api/oauth/profile")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;
    let Ok(response) = response else {
        return (None, None);
    };
    if !response.status().is_success() {
        return (None, None);
    }
    let Some(body) = read_body_limited(response, MAX_PROFILE_RESPONSE_BYTES).await else {
        return (None, None);
    };
    let Ok(value) = serde_json::from_slice::<Value>(&body) else {
        return (None, None);
    };
    let text = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty() && text.len() <= 320)
            .map(str::to_string)
    };
    (
        text("/account/email"),
        text("/organization/organization_type"),
    )
}

pub async fn desktop_quota(id: String, force: bool) -> Result<DesktopQuotaDto, AppError> {
    use super::desktop_auth::{self, TokenRead};

    let user_data = if id == DEFAULT_DESKTOP_ID {
        desktop_auth::default_user_data_dir()
    } else {
        super::validate_account_id(&id)?;
        Some(super::desktop::profile_user_data(&id)?)
    };
    let key = format!("desktop-{id}");
    let lock = code::account_lock(&key);
    let _guard = lock.lock().await;
    let vault = CodeVault::open_default()?;
    let now = now_ms();
    let previous = read_snapshot(&vault, &key);
    let answer = |status: QuotaStatus, plan: Option<String>| DesktopQuotaDto {
        email: previous
            .as_ref()
            .and_then(|snapshot| snapshot.email.clone()),
        plan: plan.or_else(|| previous.as_ref().and_then(|snapshot| snapshot.plan.clone())),
        quota: view_of(previous.as_ref(), status, now),
    };

    let Some(user_data) = user_data else {
        return Ok(answer(QuotaStatus::NotSignedIn, None));
    };
    if !desktop_auth::supported() {
        return Ok(answer(QuotaStatus::Unavailable, None));
    }
    let read =
        tauri::async_runtime::spawn_blocking(move || desktop_auth::read_token(&user_data, now))
            .await
            .map_err(|_| AppError::Message("后台任务未完成，请重试".to_string()))?;
    let entry = match read {
        TokenRead::Ok(entry) => entry,
        TokenRead::NotSignedIn => return Ok(answer(QuotaStatus::NotSignedIn, None)),
        TokenRead::Expired { plan } => return Ok(answer(QuotaStatus::LiveExpired, plan)),
        TokenRead::Unreadable => return Ok(answer(QuotaStatus::Unavailable, None)),
    };
    let token_plan = desktop_auth::plan_of(&entry);
    let limit = if force {
        MANUAL_DEBOUNCE_MS
    } else {
        AUTO_INTERVAL_MS
    };
    let age = previous.as_ref().map(|snapshot| now - snapshot.fetched_at);
    if age.is_some_and(|age| (0..limit).contains(&age)) {
        return Ok(answer(QuotaStatus::Cached, token_plan));
    }

    let quota = match crate::services::subscription::query_claude_quota(&entry.token).await {
        Ok(quota) if quota.success => quota,
        Ok(quota) if is_auth_failure(&quota) => {
            return Ok(answer(QuotaStatus::LiveExpired, token_plan))
        }
        _ => return Ok(answer(QuotaStatus::Unavailable, token_plan)),
    };
    let (email, organization_type) = desktop_profile(&entry.token).await;
    let plan = token_plan
        .or_else(|| super::plan_label(organization_type.as_deref(), None).map(str::to_string));
    let snapshot = Snapshot {
        fetched_at: now,
        windows: merge_windows(previous.as_ref(), fresh_windows(&quota), now),
        extra_usage: extra_usage_view(&quota),
        email: email.or_else(|| {
            previous
                .as_ref()
                .and_then(|snapshot| snapshot.email.clone())
        }),
        plan: plan.clone(),
    };
    if let Err(error) = write_snapshot(&vault, &key, &snapshot) {
        log::warn!("保存 Claude Desktop 账号额度快照失败: {error}");
    }
    Ok(DesktopQuotaDto {
        email: snapshot.email.clone(),
        plan,
        quota: view_of(Some(&snapshot), QuotaStatus::Fresh, now),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_accounts::code::tests::{fixture, login};
    use crate::services::subscription::{ExtraUsage, QuotaTier};
    use std::sync::Mutex;

    const NOW: i64 = 1_790_000_000_000;

    fn iso(ms: i64) -> String {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339()
    }

    fn tier(name: &str, utilization: f64, resets_at: Option<String>) -> QuotaTier {
        QuotaTier {
            name: name.to_string(),
            utilization,
            resets_at,
            used_value_usd: None,
            max_value_usd: None,
        }
    }

    fn quota(tiers: Vec<QuotaTier>) -> SubscriptionQuota {
        SubscriptionQuota {
            tool: "claude".to_string(),
            credential_status: CredentialStatus::Valid,
            credential_message: None,
            success: true,
            tiers,
            extra_usage: None,
            error: None,
            queried_at: Some(NOW),
        }
    }

    fn expired() -> SubscriptionQuota {
        SubscriptionQuota::error("claude", CredentialStatus::Expired, "401".to_string())
    }

    #[derive(Default)]
    struct FakeHttp {
        refresh: Mutex<Vec<RefreshOutcome>>,
        usage: Mutex<Vec<Result<SubscriptionQuota, String>>>,
        live: Mutex<Vec<Result<SubscriptionQuota, String>>>,
        refresh_calls: Mutex<Vec<String>>,
        usage_calls: Mutex<Vec<String>>,
    }

    impl QuotaHttp for FakeHttp {
        async fn refresh(&self, refresh_token: &str) -> RefreshOutcome {
            self.refresh_calls
                .lock()
                .unwrap()
                .push(refresh_token.to_string());
            self.refresh
                .lock()
                .unwrap()
                .pop()
                .unwrap_or(RefreshOutcome::Transient)
        }
        async fn usage(&self, access_token: &str) -> Result<SubscriptionQuota, String> {
            self.usage_calls
                .lock()
                .unwrap()
                .push(access_token.to_string());
            self.usage
                .lock()
                .unwrap()
                .pop()
                .unwrap_or_else(|| Err("none".to_string()))
        }
        async fn live_usage(&self) -> Result<SubscriptionQuota, String> {
            self.live
                .lock()
                .unwrap()
                .pop()
                .unwrap_or_else(|| Err("none".to_string()))
        }
    }

    fn refreshed(token: &str) -> RefreshOutcome {
        RefreshOutcome::Refreshed(RefreshedTokens {
            access_token: token.to_string(),
            refresh_token: Some(format!("r2-{token}")),
            expires_at_ms: NOW + 3_600_000,
            scopes: None,
        })
    }

    #[test]
    fn windows_keep_session_weekly_and_per_model_entries() {
        let reading = quota(vec![
            tier(TIER_FIVE_HOUR, 12.0, Some(iso(NOW + 60_000))),
            tier(TIER_SEVEN_DAY, 40.0, None),
            tier("model_weekly:Fable", 33.0, None),
            tier("seven_day_oauth_apps", 1.0, None),
        ]);
        let view = view_of(
            Some(&Snapshot {
                fetched_at: NOW,
                windows: fresh_windows(&reading),
                extra_usage: None,
                email: None,
                plan: None,
            }),
            QuotaStatus::Fresh,
            NOW,
        );
        let labels: Vec<&str> = view.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, vec!["5 小时", "每周", "每周 · Fable"]);
        assert_eq!(view.windows[2].kind, WindowKind::Model);
    }

    #[test]
    fn extra_usage_converts_cents_and_needs_all_numbers() {
        let mut reading = quota(vec![]);
        reading.extra_usage = Some(ExtraUsage {
            is_enabled: true,
            monthly_limit: Some(5000.0),
            used_credits: Some(1250.0),
            utilization: Some(25.0),
            currency: None,
            resets_at: Some("2026-11-01T00:00:00Z".to_string()),
        });
        let view = extra_usage_view(&reading).unwrap();
        assert_eq!(
            (view.used, view.limit, view.utilization),
            (12.5, 50.0, 25.0)
        );
        assert_eq!(view.currency, "USD");
        reading.extra_usage.as_mut().unwrap().monthly_limit = None;
        assert!(extra_usage_view(&reading).is_none());
        reading.extra_usage.as_mut().unwrap().is_enabled = false;
        assert!(extra_usage_view(&reading).is_none());
    }

    #[test]
    fn a_passed_reset_time_shows_as_reset_until_the_next_reading() {
        let snapshot = Snapshot {
            fetched_at: NOW - 3_600_000,
            windows: vec![StoredWindow {
                name: TIER_FIVE_HOUR.to_string(),
                utilization: 80.0,
                resets_at: Some(iso(NOW - 1_000)),
                reset_observed_at: None,
            }],
            extra_usage: None,
            email: None,
            plan: None,
        };
        let view = view_of(Some(&snapshot), QuotaStatus::Cached, NOW);
        assert!(view.windows[0].reset);
        assert_eq!(view.windows[0].utilization, 0.0);
        assert_eq!(view.windows[0].resets_at, None);
        assert_eq!(view.windows[0].reset_at, Some(iso(NOW - 1_000)));
    }

    #[test]
    fn a_later_reset_time_after_the_old_one_passed_marks_a_reset() {
        let old = Snapshot {
            fetched_at: NOW - 6 * 3_600_000,
            windows: vec![StoredWindow {
                name: TIER_FIVE_HOUR.to_string(),
                utilization: 90.0,
                resets_at: Some(iso(NOW - 3_600_000)),
                reset_observed_at: None,
            }],
            extra_usage: None,
            email: None,
            plan: None,
        };
        let fresh = vec![StoredWindow {
            name: TIER_FIVE_HOUR.to_string(),
            utilization: 5.0,
            resets_at: Some(iso(NOW + 4 * 3_600_000)),
            reset_observed_at: None,
        }];
        let merged = merge_windows(Some(&old), fresh.clone(), NOW);
        assert_eq!(merged[0].reset_observed_at, Some(iso(NOW - 3_600_000)));
        // Same reset time on the next reading: the mark is kept.
        let next = Snapshot {
            fetched_at: NOW,
            windows: merged,
            extra_usage: None,
            email: None,
            plan: None,
        };
        let again = merge_windows(Some(&next), fresh.clone(), NOW + 60_000);
        assert!(again[0].reset_observed_at.is_some());
        // An unchanged window that never passed its reset is not reset.
        let unchanged = merge_windows(
            Some(&Snapshot {
                fetched_at: NOW,
                windows: fresh.clone(),
                extra_usage: None,
                email: None,
                plan: None,
            }),
            fresh,
            NOW,
        );
        assert_eq!(unchanged[0].reset_observed_at, None);
    }

    #[test]
    fn the_reset_mark_shows_for_an_hour_then_only_usage() {
        let snapshot = |observed: i64| Snapshot {
            fetched_at: NOW,
            windows: vec![StoredWindow {
                name: TIER_FIVE_HOUR.to_string(),
                utilization: 40.0,
                resets_at: Some(iso(NOW + 3_600_000)),
                reset_observed_at: Some(iso(observed)),
            }],
            extra_usage: None,
            email: None,
            plan: None,
        };
        let recent = view_of(Some(&snapshot(NOW - 600_000)), QuotaStatus::Fresh, NOW);
        assert!(recent.windows[0].reset);
        assert_eq!(recent.windows[0].utilization, 40.0);
        let old = view_of(
            Some(&snapshot(NOW - 2 * 3_600_000)),
            QuotaStatus::Fresh,
            NOW,
        );
        assert!(!old.windows[0].reset);
        assert_eq!(old.windows[0].reset_at, None);
    }

    #[test]
    fn refresh_answers_are_classified_like_claude_swap() {
        let ok = br#"{"access_token":"a2","expires_in":3600,"refresh_token":"r2","scope":"user:inference user:profile"}"#;
        match classify_refresh_response(200, ok, NOW) {
            RefreshOutcome::Refreshed(tokens) => {
                assert_eq!(tokens.access_token, "a2");
                assert_eq!(tokens.refresh_token.as_deref(), Some("r2"));
                assert_eq!(tokens.expires_at_ms, NOW + 3_600_000);
                assert_eq!(tokens.scopes.unwrap().len(), 2);
            }
            _ => panic!("expected refreshed"),
        }
        assert!(matches!(
            classify_refresh_response(400, br#"{"error":"invalid_grant"}"#, NOW),
            RefreshOutcome::InvalidGrant
        ));
        assert!(matches!(
            classify_refresh_response(401, br#"{"error":"invalid_client"}"#, NOW),
            RefreshOutcome::InvalidClient
        ));
        for (status, body) in [
            (400, &br#"{"detail":"invalid_grant"}"#[..]),
            (500, &br#"{"error":"invalid_grant"}"#[..]),
            (403, &b"<html>"[..]),
            (200, &br#"{"access_token":""}"#[..]),
            (200, &b"not json"[..]),
        ] {
            assert!(
                matches!(
                    classify_refresh_response(status, body, NOW),
                    RefreshOutcome::Transient
                ),
                "{status}"
            );
        }
    }

    #[test]
    fn refresh_is_due_within_five_minutes_of_expiry() {
        assert!(needs_refresh(Some(&Value::from(NOW + 60_000)), NOW));
        assert!(needs_refresh(Some(&Value::from(NOW - 1)), NOW));
        assert!(!needs_refresh(Some(&Value::from(NOW + 3_600_000)), NOW));
        assert!(
            needs_refresh(Some(&Value::from(NOW / 1000)), NOW),
            "seconds"
        );
        assert!(!needs_refresh(None, NOW));
    }

    #[tokio::test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    async fn the_active_account_is_read_live_and_never_refreshed() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = code::save_current_in(&fx.vault, &fx.paths, None).unwrap();
        let http = FakeHttp::default();
        http.live.lock().unwrap().push(Ok(expired()));
        http.refresh.lock().unwrap().push(refreshed("never"));
        let view = read_quota(&fx.vault, &fx.paths, &work.id, true, NOW, &http)
            .await
            .unwrap();
        assert_eq!(view.status, QuotaStatus::LiveExpired);
        assert!(http.refresh_calls.lock().unwrap().is_empty());
        assert!(http.usage_calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    async fn an_inactive_account_near_expiry_is_refreshed_and_stored() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = code::save_current_in(&fx.vault, &fx.paths, None).unwrap();
        // Make the saved copy expire soon, then move Claude Code to another login.
        code::store_refreshed(&fx.vault, &work.id, "tok-work", None, NOW + 1_000, None).unwrap();
        login(&fx.paths, "me@example.com", "u-me", "tok-me");

        let http = FakeHttp::default();
        http.refresh.lock().unwrap().push(refreshed("tok-work-2"));
        http.usage
            .lock()
            .unwrap()
            .push(Ok(quota(vec![tier(TIER_FIVE_HOUR, 10.0, None)])));
        let view = read_quota(&fx.vault, &fx.paths, &work.id, false, NOW, &http)
            .await
            .unwrap();
        assert_eq!(view.status, QuotaStatus::Fresh);
        assert_eq!(*http.refresh_calls.lock().unwrap(), vec!["r-tok-work"]);
        assert_eq!(*http.usage_calls.lock().unwrap(), vec!["tok-work-2"]);
        let slot = fx.vault.read_slot(&work.id).unwrap();
        assert_eq!(slot.oauth()["accessToken"], "tok-work-2");
        assert_eq!(slot.oauth()["refreshToken"], "r2-tok-work-2");

        // Within five minutes an automatic reading reuses the snapshot.
        let again = read_quota(&fx.vault, &fx.paths, &work.id, false, NOW + 60_000, &http)
            .await
            .unwrap();
        assert_eq!(again.status, QuotaStatus::Cached);
        assert_eq!(http.usage_calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    #[cfg_attr(target_os = "macos", ignore = "switching is unsupported on macOS")]
    async fn a_rejected_grant_marks_the_account_for_relogin() {
        let fx = fixture();
        login(&fx.paths, "work@example.com", "u-work", "tok-work");
        let work = code::save_current_in(&fx.vault, &fx.paths, None).unwrap();
        code::store_refreshed(&fx.vault, &work.id, "tok-work", None, NOW - 1, None).unwrap();
        login(&fx.paths, "me@example.com", "u-me", "tok-me");

        let http = FakeHttp::default();
        http.refresh
            .lock()
            .unwrap()
            .push(RefreshOutcome::InvalidGrant);
        let view = read_quota(&fx.vault, &fx.paths, &work.id, true, NOW, &http)
            .await
            .unwrap();
        assert_eq!(view.status, QuotaStatus::NeedsRelogin);
        assert!(fx.vault.read_slot(&work.id).unwrap().needs_relogin());

        // A transient failure keeps the old data.
        let other = FakeHttp::default();
        code::store_refreshed(&fx.vault, &work.id, "tok-work", None, NOW - 1, None).unwrap();
        other
            .refresh
            .lock()
            .unwrap()
            .push(RefreshOutcome::InvalidClient);
        let view = read_quota(&fx.vault, &fx.paths, &work.id, true, NOW, &other)
            .await
            .unwrap();
        assert_eq!(view.status, QuotaStatus::Unavailable);
        let slot = fx.vault.read_slot(&work.id).unwrap();
        assert!(!slot.needs_relogin());
        assert_eq!(slot.oauth()["accessToken"], "tok-work");
    }
}
