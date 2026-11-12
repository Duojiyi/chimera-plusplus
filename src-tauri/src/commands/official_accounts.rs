use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use crate::app_config::AppType;
use crate::codex_accounts::{
    self,
    identity::{
        access_token_expires_at, auth_display_metadata, classify, AccountIdentity, LoginClass,
    },
    login::LoginPoll,
    vault::{validate_account_key, Vault},
    LiveAuth,
};
use crate::error::AppError;
use crate::official_account_meta::{self as meta, AccountGroup, AccountMetaIndex};
use crate::services::official_quota_cache::{self as quota_cache, QuotaQuery, QuotaRecord};
use crate::services::subscription::{query_codex_quota, CredentialStatus, SubscriptionQuota};
use crate::store::AppState;

/// Shown for a saved account whose slot cannot be read here (another
/// Windows profile or reset password, a migrated configuration, a damaged
/// file): no identity can be shown, only that it needs to sign in again.
const UNREADABLE_ACCOUNT_NAME: &str = "无法读取的账号";

/// Wall-clock milliseconds, the unit every stored account timestamp uses.
fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// How Codex's live login relates to the saved accounts. Page-level: every
/// row carries the same value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OfficialLiveState {
    /// A saved account, consistent with the selected line.
    Matched,
    /// A complete ChatGPT login that is not saved here.
    Unsaved,
    /// An account line is selected but Codex holds another login or none.
    Mismatch,
    /// Codex is routed to a third-party endpoint.
    ThirdParty,
    /// Nothing reliable to say (unreadable files, a profile override, or no
    /// ChatGPT login while no account line is selected).
    Unknown,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialAccountDto {
    pub key: String,
    pub account_id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    /// Name of the line that uses this account (the selected one first).
    pub line_name: Option<String>,
    pub captured_at: String,
    pub is_current: bool,
    /// The account's line is the line selected for Codex.
    pub is_selected: bool,
    pub needs_relogin: bool,
    /// The slot is missing or cannot be decrypted; it can only be signed in
    /// again or removed.
    pub unreadable: bool,
    /// The access token a quota query would present has expired; Codex
    /// renews it when the account is used, so this is not a sign-in problem.
    pub access_expired: bool,
    pub provider_id: Option<String>,
    pub live_state: OfficialLiveState,
    /// The user's tags for this account, normalized (`meta::normalize_tags`).
    pub tags: Vec<String>,
    /// The group this account belongs to, if any.
    pub group_id: Option<String>,
    /// The group's current name, resolved here so the list needs no second
    /// request. `None` while ungrouped or when the group is gone.
    pub group_name: Option<String>,
    /// The user's own words about this account.
    pub note: Option<String>,
    /// Held out of use by the user: not offered for switching. Independent of
    /// `needs_relogin`/`access_expired`, which describe the credentials.
    pub disabled: bool,
    pub disabled_at: Option<i64>,
    pub disabled_reason: Option<String>,
    /// Last time Codex was seen using this account, in milliseconds since the
    /// epoch. Survives a sign-in again (`unreadable` does not clear it).
    pub last_used_at: Option<i64>,
    /// The last stored quota reading, if this machine ever fetched one.
    ///
    /// This is a *cache*: the list never reaches the network, so the value may
    /// be minutes old. `quota.queriedAt` says when it was taken; call
    /// `get_official_account_quota` to refresh one account. `None` means
    /// "never read here", which is different from "read failed".
    pub quota: Option<OfficialQuotaDto>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialQuotaDto {
    #[serde(flatten)]
    pub quota: SubscriptionQuota,
    /// The local access token has expired, so nothing was queried.
    pub access_expired: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedLoginDto {
    pub flow_id: String,
    pub verification_url: String,
    pub user_code: String,
    pub expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollLoginDto {
    pub status: String,
    pub key: Option<String>,
    pub error: Option<String>,
}

/// Which accounts a filtered request wants back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OfficialAccountFilter {
    #[default]
    All,
    /// The account Codex is using right now.
    Current,
    /// The account the selected line is pinned to.
    Selected,
    /// The saved login cannot be applied (expired, tombstoned, unclassifiable).
    NeedsRelogin,
    /// The local access token has run out.
    AccessExpired,
    /// Held out of use by the user.
    Disabled,
    /// A saved account whose slot cannot be decrypted on this machine.
    Unreadable,
}

/// Sort keys for the account list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OfficialAccountSort {
    /// The order the lines page shows: line position, unbound accounts last.
    #[default]
    Manual,
    /// By quota headroom. Accounts with no reading sort last either way.
    Quota,
    Name,
    LastUsed,
    Added,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    #[default]
    Asc,
    Desc,
}

/// One filtered, sorted page of accounts.
///
/// `tags` and `groups` describe the *unfiltered* set, so the toolbar can show
/// the whole vocabulary even while a filter hides most rows.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OfficialAccountQuery {
    /// Case-insensitive match against name, email, account id, tags, note and
    /// group name.
    pub search: Option<String>,
    /// Every one of these tags must be present.
    pub tags: Vec<String>,
    /// A group id, or [`UNGROUPED_GROUP`] for accounts in no group.
    pub group: Option<String>,
    pub filter: OfficialAccountFilter,
    pub sort: OfficialAccountSort,
    pub direction: SortDirection,
    /// 1-based.
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

/// Group filter value meaning "accounts in no group". Chosen over an extra
/// boolean so the filter stays one string on the wire.
pub const UNGROUPED_GROUP: &str = "";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialAccountGroupDto {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_index: i64,
    pub account_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialAccountPageDto {
    pub items: Vec<OfficialAccountDto>,
    /// Items after filtering, before paging.
    pub total: usize,
    /// Items the whole list holds, with no filter applied.
    pub unfiltered_total: usize,
    pub page: u32,
    pub page_size: u32,
    pub total_pages: u32,
    /// Every tag in use, sorted, for the filter toolbar.
    pub tags: Vec<String>,
    /// Every group, in the user's order.
    pub groups: Vec<OfficialAccountGroupDto>,
}

const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 200;

/// How stale a `last_used_at` stamp may get before the account list refreshes
/// it. Long enough that opening the page is not a write on every refresh,
/// short enough that "last used" still means today.
const LAST_USED_THROTTLE_MS: i64 = 5 * 60 * 1000;

/// Longest accepted group color.
const GROUP_COLOR_MAX_CHARS: usize = 9;

#[tauri::command]
pub async fn list_official_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<OfficialAccountDto>, AppError> {
    Ok(load_official_accounts(&state).await?.0)
}

/// The account list plus the metadata index it was built from, so the search
/// and grouping commands do not read the database twice.
async fn load_official_accounts(
    state: &AppState,
) -> Result<(Vec<OfficialAccountDto>, AccountMetaIndex), AppError> {
    let vault = Vault::open_default()?;
    let lines = codex_accounts::official_lines(&state.db)?;
    let current_id = crate::settings::get_effective_current_provider(&state.db, &AppType::Codex)?;
    // Only the built-in official proxy target passes through live ChatGPT auth.
    // A failover queue may route elsewhere even while that target stays selected.
    let official_proxy_active = lines.iter().any(|line| {
        Some(&line.id) == current_id.as_ref()
            && crate::proxy::providers::is_codex_official_provider(line)
    }) && state
        .db
        .get_proxy_config_for_app("codex")
        .await
        .is_ok_and(|config| !config.auto_failover_enabled)
        && state.proxy_service.is_running().await
        && state
            .proxy_service
            .live_takeover_matches_current_proxy(&AppType::Codex)
            .await
            .unwrap_or(false);

    let meta_index = state.db.official_account_meta_index()?;
    // Cached quota readings only: listing never reaches the network.
    let quotas = stored_quota_records(state)?;
    let accounts = list_official_accounts_from_with(
        &vault,
        &lines,
        current_id.as_deref(),
        &crate::codex_config::get_codex_config_dir(),
        official_proxy_active,
        &meta_index,
        &quotas,
    );
    // Track real use without asking the page: whichever account Codex is
    // running on is, by definition, the one last used. Throttled so opening the
    // page does not rewrite (and auto-sync) that row on every refresh, and best
    // effort — remembering a timestamp must never fail the list. The rows above
    // were read before this write, so the page may show a stamp up to
    // `LAST_USED_THROTTLE_MS` old, which for a "last used" label is fine.
    if let Some(key) = accounts
        .iter()
        .find(|account| account.is_current)
        .map(|account| account.key.as_str())
    {
        if let Err(error) =
            state
                .db
                .touch_official_account_last_used(key, now_millis(), LAST_USED_THROTTLE_MS)
        {
            log::warn!("Recording the last-used time of {key} failed: {error}");
        }
    }
    Ok((accounts, meta_index))
}

/// The filtered, sorted, paged account list.
///
/// Kept free of I/O so the ordering rules are unit-testable: the caller hands
/// in the already-built rows and the metadata index.
#[tauri::command]
pub async fn query_official_accounts(
    state: tauri::State<'_, AppState>,
    query: Option<OfficialAccountQuery>,
) -> Result<OfficialAccountPageDto, AppError> {
    let (accounts, meta_index) = load_official_accounts(&state).await?;
    Ok(query_official_accounts_from(
        accounts,
        &meta_index,
        &query.unwrap_or_default(),
    ))
}

fn query_official_accounts_from(
    accounts: Vec<OfficialAccountDto>,
    meta_index: &AccountMetaIndex,
    query: &OfficialAccountQuery,
) -> OfficialAccountPageDto {
    let unfiltered_total = accounts.len();
    let mut tags: Vec<String> = accounts
        .iter()
        .flat_map(|account| account.tags.iter().cloned())
        .collect();
    tags.sort();
    tags.dedup();
    let groups = group_dtos(&accounts, meta_index);

    let needle = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|needle| !needle.is_empty())
        .map(str::to_lowercase);
    let wanted_tags: Vec<String> = query
        .tags
        .iter()
        .map(|tag| tag.trim().to_lowercase())
        .filter(|tag| !tag.is_empty())
        .collect();

    let mut items: Vec<OfficialAccountDto> = accounts
        .into_iter()
        .filter(|account| matches_filter(account, query.filter))
        .filter(|account| matches_group(account, query.group.as_deref()))
        .filter(|account| {
            wanted_tags
                .iter()
                .all(|tag| account.tags.iter().any(|own| own.to_lowercase() == *tag))
        })
        .filter(|account| {
            needle
                .as_deref()
                .is_none_or(|needle| matches(account, needle))
        })
        .collect();

    sort_accounts(&mut items, query.sort, query.direction);
    let total = items.len();
    let page_size = query
        .page_size
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let total_pages = total.div_ceil(page_size as usize) as u32;
    let page = query.page.unwrap_or(1).max(1).min(total_pages.max(1));
    let items = items
        .into_iter()
        .skip(((page - 1) as usize) * page_size as usize)
        .take(page_size as usize)
        .collect();
    OfficialAccountPageDto {
        items,
        total,
        unfiltered_total,
        page,
        page_size,
        total_pages,
        tags,
        groups,
    }
}

/// Case-insensitive substring match over the fields the user can see.
fn matches(account: &OfficialAccountDto, needle: &str) -> bool {
    let haystack = |value: &str| value.to_lowercase().contains(needle);
    haystack(&account.display_name)
        || account.email.as_deref().is_some_and(haystack)
        || haystack(&account.account_id)
        || account.note.as_deref().is_some_and(haystack)
        || account.group_name.as_deref().is_some_and(haystack)
        || account.plan_type.as_deref().is_some_and(haystack)
        || account.tags.iter().any(|tag| haystack(tag))
}

fn matches_filter(account: &OfficialAccountDto, filter: OfficialAccountFilter) -> bool {
    match filter {
        OfficialAccountFilter::All => true,
        OfficialAccountFilter::Current => account.is_current,
        OfficialAccountFilter::Selected => account.is_selected,
        OfficialAccountFilter::NeedsRelogin => account.needs_relogin,
        OfficialAccountFilter::AccessExpired => account.access_expired,
        OfficialAccountFilter::Disabled => account.disabled,
        OfficialAccountFilter::Unreadable => account.unreadable,
    }
}

fn matches_group(account: &OfficialAccountDto, group: Option<&str>) -> bool {
    match group {
        None => true,
        Some(UNGROUPED_GROUP) => account.group_id.is_none(),
        Some(id) => account.group_id.as_deref() == Some(id),
    }
}

/// The share of quota already spent, as the number a "least used first" sort
/// needs: the fullest window decides, so an account is not called roomy while
/// one of its windows is nearly gone. `None` when this machine holds no
/// successful reading for the account.
fn used_share(account: &OfficialAccountDto) -> Option<f64> {
    let quota = &account.quota.as_ref()?.quota;
    if !quota.success {
        return None;
    }
    quota
        .tiers
        .iter()
        .map(|tier| tier.utilization)
        .fold(None, |widest, value| {
            Some(widest.map_or(value, |current: f64| current.max(value)))
        })
}

/// Sorts by one key whose absence always lands last, in either direction: an
/// account with no reading must never take the top of the list.
fn sort_accounts(
    items: &mut [OfficialAccountDto],
    sort: OfficialAccountSort,
    direction: SortDirection,
) {
    let descending = direction == SortDirection::Desc;
    match sort {
        // Line position, as the lines page shows it.
        OfficialAccountSort::Manual => {
            if descending {
                items.reverse();
            }
        }
        OfficialAccountSort::Name => {
            items.sort_by_cached_key(|account| account.display_name.to_lowercase());
            if descending {
                items.reverse();
            }
        }
        // Ascending = least used first, descending = most used first.
        OfficialAccountSort::Quota => {
            items.sort_by(|left, right| match (used_share(left), used_share(right)) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(left), Some(right)) => {
                    let ordering = left.total_cmp(&right);
                    if descending {
                        ordering.reverse()
                    } else {
                        ordering
                    }
                }
            })
        }
        // Ascending = oldest first, descending = newest first.
        OfficialAccountSort::LastUsed => {
            items.sort_by(|left, right| {
                compare_present_last(left.last_used_at, right.last_used_at, descending)
            });
        }
        OfficialAccountSort::Added => items.sort_by(|left, right| {
            compare_present_last(
                added_key(&left.captured_at),
                added_key(&right.captured_at),
                descending,
            )
        }),
    }
}

/// Orders present values by `descending`, and keeps absent values last.
fn compare_present_last(
    left: Option<i64>,
    right: Option<i64>,
    descending: bool,
) -> std::cmp::Ordering {
    match (left, right) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(left), Some(right)) => {
            let ordering = left.cmp(&right);
            if descending {
                ordering.reverse()
            } else {
                ordering
            }
        }
    }
}

/// `YYYYMMDD` of an RFC 3339 capture time; enough to order accounts saved on
/// different days, which is all this sort claims.
fn added_key(captured_at: &str) -> Option<i64> {
    let mut parts = captured_at.get(..10)?.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    Some(year * 10_000 + month * 100 + day)
}

/// DTO fields that come from `official_account_meta` instead of the vault, so
/// the vault-free listing path and the command share one construction.
#[derive(Default)]
struct AccountMetaFields {
    tags: Vec<String>,
    group_id: Option<String>,
    group_name: Option<String>,
    note: Option<String>,
    disabled: bool,
    disabled_at: Option<i64>,
    disabled_reason: Option<String>,
    last_used_at: Option<i64>,
}

impl AccountMetaFields {
    /// An account without a stored row reads as [`AccountMetaFields::default`].
    fn lookup(index: &AccountMetaIndex, key: &str) -> Self {
        let Some(meta) = index.meta(key) else {
            return Self::default();
        };
        Self {
            tags: meta.tags.clone(),
            group_id: meta.group_id.clone(),
            group_name: meta
                .group_id
                .as_deref()
                .and_then(|id| index.group(id))
                .map(|group| group.name.clone()),
            note: meta.note.clone(),
            disabled: meta.disabled,
            disabled_at: meta.disabled_at,
            disabled_reason: meta.disabled_reason.clone(),
            last_used_at: meta.last_used_at,
        }
    }
}

/// Every stored quota reading, keyed by account.
fn stored_quota_records(state: &AppState) -> Result<HashMap<String, QuotaRecord>, AppError> {
    Ok(state
        .db
        .official_account_quota_index()?
        .into_iter()
        .map(|(key, row)| (key, QuotaRecord::from_row(Some(row))))
        .collect())
}

/// The stored quota reading of one account, as the IPC shape the frontend
/// already knows from `get_official_account_quota`.
fn cached_quota(quotas: &HashMap<String, QuotaRecord>, key: &str) -> Option<OfficialQuotaDto> {
    let record = quotas.get(key)?;
    let quota = record.cached()?.clone();
    Some(OfficialQuotaDto {
        quota,
        access_expired: record.access_expired,
    })
}

fn list_official_accounts_from_with(
    vault: &Vault,
    lines: &[crate::provider::Provider],
    current_id: Option<&str>,
    codex_dir: &Path,
    official_proxy_active: bool,
    meta_index: &AccountMetaIndex,
    quotas: &HashMap<String, QuotaRecord>,
) -> Vec<OfficialAccountDto> {
    let live_auth = codex_accounts::read_live_auth(&codex_dir.join("auth.json"))
        .ok()
        .map(|(_, auth)| auth);
    let live_value = match &live_auth {
        Some(LiveAuth::Present(auth)) => Some(auth),
        _ => None,
    };
    // A saved line is a selection, not evidence of the login Codex uses now.
    // Unknown/unreadable live state must leave every account available to apply.
    let live_key = match live_login(codex_dir, official_proxy_active, live_auth.as_ref()) {
        LiveLogin::Chatgpt(identity) => Ok(identity.key()),
        other => Err(other),
    };
    let saved = vault.slot_keys();
    let selected_key = lines
        .iter()
        .find(|line| Some(line.id.as_str()) == current_id)
        .and_then(|line| line.official_account_key());
    let live_state = match &live_key {
        Ok(key) if !saved.contains(key) => OfficialLiveState::Unsaved,
        Ok(key) if selected_key.is_some_and(|selected| selected != key.as_str()) => {
            OfficialLiveState::Mismatch
        }
        Ok(_) => OfficialLiveState::Matched,
        // An account line is selected, yet Codex has no login of it in use.
        Err(LiveLogin::NoChatgpt | LiveLogin::ThirdParty) if selected_key.is_some() => {
            OfficialLiveState::Mismatch
        }
        Err(LiveLogin::ThirdParty) => OfficialLiveState::ThirdParty,
        Err(_) => OfficialLiveState::Unknown,
    };
    // A line may pin an account whose slot never reached this machine; it
    // stays visible so it can be signed in again or removed (U4 A1).
    let mut keys = saved;
    keys.extend(
        lines
            .iter()
            .filter_map(|line| line.official_account_key())
            .filter(|key| validate_account_key(key).is_ok())
            .map(str::to_string),
    );
    keys.sort();
    keys.dedup();
    // Same order as the official group on the lines page; unbound last.
    keys.sort_by_key(|key| {
        lines
            .iter()
            .position(|line| line.official_account_key() == Some(key.as_str()))
            .unwrap_or(usize::MAX)
    });
    let now = chrono::Utc::now().timestamp();
    keys.into_iter()
        .map(|key| {
            let line = official_account_line(lines, &key, current_id);
            let is_selected = line.is_some_and(|line| Some(line.id.as_str()) == current_id);
            let provider_id = line.map(|line| line.id.clone());
            let line_name = line.map(|line| line.name.clone());
            let is_live = live_key.as_ref().is_ok_and(|live| *live == key);
            // Metadata is keyed by account key, not stored in the slot, so it
            // survives a slot this machine cannot decrypt.
            let meta = AccountMetaFields::lookup(meta_index, &key);
            let quota = cached_quota(quotas, &key);
            // A slot that cannot be read is still an account the user saved.
            let Ok(Some(slot)) = vault.read_slot(&key) else {
                return OfficialAccountDto {
                    key,
                    account_id: String::new(),
                    display_name: UNREADABLE_ACCOUNT_NAME.to_string(),
                    email: None,
                    plan_type: None,
                    line_name,
                    captured_at: String::new(),
                    is_current: is_live,
                    is_selected,
                    needs_relogin: true,
                    unreadable: true,
                    access_expired: false,
                    provider_id,
                    live_state,
                    tags: meta.tags,
                    group_id: meta.group_id,
                    group_name: meta.group_name,
                    note: meta.note,
                    disabled: meta.disabled,
                    disabled_at: meta.disabled_at,
                    disabled_reason: meta.disabled_reason,
                    last_used_at: meta.last_used_at,
                    quota,
                };
            };
            let display = auth_display_metadata(&slot.auth);
            let applicable =
                matches!(classify(&slot.auth), LoginClass::Chatgpt(account) if account.key() == key);
            let access_expired = codex_accounts::access_expired(
                access_token_expires_at(codex_accounts::quota_login(&slot.auth, live_value, &key)),
                now,
            );
            let needs_relogin = !applicable || vault.has_tombstone(&key);
            OfficialAccountDto {
                account_id: slot.account_id().to_string(),
                display_name: codex_accounts::default_line_name(&display),
                email: display.email,
                plan_type: display.plan_type,
                line_name,
                captured_at: slot.captured_at,
                is_current: applicable && is_live,
                is_selected,
                needs_relogin,
                unreadable: false,
                access_expired,
                provider_id,
                live_state,
                key,
                tags: meta.tags,
                group_id: meta.group_id,
                group_name: meta.group_name,
                note: meta.note,
                disabled: meta.disabled,
                disabled_at: meta.disabled_at,
                disabled_reason: meta.disabled_reason,
                last_used_at: meta.last_used_at,
                quota,
            }
        })
        .collect()
}

/// What Codex's live files say about its login.
enum LiveLogin {
    /// A complete ChatGPT login on Codex's official route.
    Chatgpt(AccountIdentity),
    /// The official route without a ChatGPT login (none, API key, partial).
    NoChatgpt,
    /// Codex is routed to a third-party endpoint.
    ThirdParty,
    /// Unreadable files, a profile override, or a login policy Codex would
    /// apply differently.
    Unknown,
}

fn live_login(
    codex_dir: &Path,
    official_proxy_active: bool,
    live_auth: Option<&LiveAuth>,
) -> LiveLogin {
    let Ok(config) = crate::config::cas::FileSnapshot::read(codex_dir.join("config.toml")) else {
        return LiveLogin::Unknown;
    };
    // Missing config uses Codex's built-in official route; unreadable is unknown.
    let Ok(config) = std::str::from_utf8(config.contents().unwrap_or_default()) else {
        return LiveLogin::Unknown;
    };
    let config = if crate::codex_config::codex_config_has_owned_official_proxy_route(config, |_| {
        official_proxy_active
    }) {
        match crate::codex_config::remove_codex_official_proxy_route(config) {
            Ok(config) => config,
            Err(_) => return LiveLogin::Unknown,
        }
    } else if crate::codex_config::codex_config_routes_official_to_proxy(
        config,
        crate::codex_config::is_loopback_codex_proxy_base_url,
    ) {
        // Our official route shape while its proxy ownership is not confirmed
        // (any shape, legacy included): where the login goes is unknown.
        return LiveLogin::Unknown;
    } else {
        config.to_string()
    };
    let Ok(config) = crate::codex_config::strip_codex_unified_session_bucket(&config) else {
        return LiveLogin::Unknown;
    };
    let Ok(doc) = config.parse::<toml::Value>() else {
        return LiveLogin::Unknown;
    };
    match doc.get("model_provider").map(toml::Value::as_str) {
        None | Some(Some("openai")) => {}
        // Our official route while its proxy ownership is not confirmed, or
        // a value Codex would reject.
        Some(Some(crate::codex_config::CC_SWITCH_CODEX_OFFICIAL_PROXY_PROVIDER_ID))
        | Some(None) => return LiveLogin::Unknown,
        Some(Some(_)) => return LiveLogin::ThirdParty,
    }
    // Do not guess when a profile overrides the route or login policy.
    if let Some(profile) = doc.get("profile") {
        let overrides = profile
            .as_str()
            .and_then(|name| doc.get("profiles")?.get(name)?.as_table())
            .is_none_or(|profile| {
                crate::codex_key_ownership::PROFILE_ROUTE_KEYS
                    .iter()
                    .any(|key| profile.contains_key(*key))
            });
        if overrides {
            return LiveLogin::Unknown;
        }
    }
    if ["base_url", "openai_base_url", "chatgpt_base_url"]
        .iter()
        .any(|key| {
            doc.get(*key).is_some_and(|value| {
                !value
                    .as_str()
                    .is_some_and(crate::codex_key_ownership::is_official_codex_base_url)
            })
        })
        || crate::codex_config::extract_codex_base_url(&config)
            .is_some_and(|url| !crate::codex_key_ownership::is_official_codex_base_url(&url))
        || crate::codex_config::extract_codex_experimental_bearer_token(&config).is_some()
    {
        return LiveLogin::ThirdParty;
    }
    if doc
        .get("forced_login_method")
        .is_some_and(|value| value.as_str() != Some("chatgpt"))
    {
        return LiveLogin::Unknown;
    }
    let auth = match live_auth {
        Some(LiveAuth::Present(auth)) => auth,
        Some(LiveAuth::Missing) => return LiveLogin::NoChatgpt,
        Some(LiveAuth::Unreadable) | None => return LiveLogin::Unknown,
    };
    match classify(auth) {
        LoginClass::Chatgpt(identity)
            if doc
                .get("forced_chatgpt_workspace_id")
                .is_none_or(|value| value.as_str() == Some(identity.account_id.as_str())) =>
        {
            LiveLogin::Chatgpt(identity)
        }
        LoginClass::Chatgpt(_) | LoginClass::Conflict => LiveLogin::Unknown,
        LoginClass::Incomplete | LoginClass::Other | LoginClass::Empty => LiveLogin::NoChatgpt,
    }
}

fn official_account_line<'a>(
    lines: &'a [crate::provider::Provider],
    key: &str,
    current_id: Option<&str>,
) -> Option<&'a crate::provider::Provider> {
    let mut matching = lines
        .iter()
        .filter(|line| line.official_account_key() == Some(key));
    matching
        .clone()
        .find(|line| Some(line.id.as_str()) == current_id)
        .or_else(|| matching.next())
}

/// The answer when the local access token has already expired: nothing is
/// queried (the service would only reject it), and the login is not called
/// rejected, because Codex renews the token when the account is used.
fn expired_access_quota() -> OfficialQuotaDto {
    let mut quota = SubscriptionQuota::error(
        "codex",
        CredentialStatus::Valid,
        "令牌已过期，切换后由 Codex 续期".to_string(),
    );
    quota.queried_at = None;
    OfficialQuotaDto {
        quota,
        access_expired: true,
    }
}

/// Quota-only IPC: credentials stay inside the Vault/live-auth backend path.
///
/// The answer is served from the stored reading while it is fresh, so opening
/// the page no longer costs one request per account; `refresh` forces a new
/// reading (still debounced, and still backed off after a recent failure).
/// One account's quota only: a list-wide refresh stays a caller-driven loop so
/// the user can see progress instead of waiting on one long request.
#[tauri::command]
pub async fn get_official_account_quota(
    state: tauri::State<'_, AppState>,
    key: String,
    refresh: Option<bool>,
) -> Result<OfficialQuotaDto, String> {
    codex_accounts::require_enabled().map_err(|err| err.to_string())?;
    let now_ms = now_millis();
    let stored = QuotaRecord::from_row(
        state
            .db
            .official_account_quota(&key)
            .map_err(|err| err.to_string())?,
    );
    if quota_cache::decide(&stored, now_ms, refresh.unwrap_or(false)) == QuotaQuery::ReuseCache {
        return match stored.cached() {
            Some(quota) => Ok(OfficialQuotaDto {
                quota: quota.clone(),
                access_expired: stored.access_expired,
            }),
            // Nothing stored yet and no request allowed: answer the same way a
            // failed read would, without writing a fake reading.
            None => Ok(OfficialQuotaDto {
                quota: SubscriptionQuota::error(
                    "codex",
                    CredentialStatus::NotFound,
                    "暂未获取配额，请稍后刷新".to_string(),
                ),
                access_expired: false,
            }),
        };
    }
    let vault = Vault::open_default().map_err(|err| err.to_string())?;
    let codex_dir = crate::codex_config::get_codex_config_dir();
    let credentials = codex_accounts::quota_credentials(&vault, &codex_dir, &key)
        .map_err(|err| err.to_string())?;
    // An expired token is not queried: the service would only reject it, and
    // Codex renews it when the account is used. The fact is cached so the list
    // can show it without another attempt.
    if codex_accounts::access_expired(credentials.access_expires_at, now_ms / 1000) {
        let answer = expired_access_quota();
        let record = QuotaRecord {
            payload: Some(answer.quota.clone()),
            // An expired token is not a successful reading: keep the age of
            // the last real one so the freshness rule still applies to it.
            fetched_at: stored.fetched_at,
            last_attempt_at: now_ms,
            access_expired: true,
        };
        record
            .to_row()
            .and_then(|row| state.db.store_official_account_quota(&key, &row))
            .map_err(|err| err.to_string())?;
        return Ok(answer);
    }
    let quota = query_codex_quota(
        &credentials.access_token,
        Some(&credentials.account_id),
        "codex",
        "官方账号登录已失效，请重新登录",
    )
    .await?;
    let record = QuotaRecord {
        fetched_at: if quota.success {
            now_ms
        } else {
            stored.fetched_at
        },
        payload: Some(quota.clone()),
        last_attempt_at: now_ms,
        access_expired: false,
    };
    // A failure to persist must not fail the answer the user asked for.
    if let Err(err) = record
        .to_row()
        .and_then(|row| state.db.store_official_account_quota(&key, &row))
    {
        log::warn!("Storing the quota reading of one account failed: {err}");
    }
    Ok(OfficialQuotaDto {
        quota,
        access_expired: false,
    })
}

#[tauri::command]
pub async fn save_current_official_login(
    state: tauri::State<'_, AppState>,
    name: Option<String>,
) -> Result<String, AppError> {
    let vault = Vault::open_default()?;
    let codex_dir = crate::codex_config::get_codex_config_dir();
    codex_accounts::save_current_login(&state.db, &vault, &codex_dir, name)
}

#[tauri::command]
pub async fn start_official_device_login() -> Result<StartedLoginDto, AppError> {
    start_official_login(false).await
}

#[tauri::command]
pub async fn start_official_browser_login() -> Result<StartedLoginDto, AppError> {
    start_official_login(true).await
}

async fn start_official_login(browser: bool) -> Result<StartedLoginDto, AppError> {
    let started = tauri::async_runtime::spawn_blocking(move || {
        let vault = Vault::open_default()?;
        if browser {
            codex_accounts::login::start_browser(&vault)
        } else {
            codex_accounts::login::start(&vault)
        }
    })
    .await
    .map_err(|_| AppError::Message("登录任务未完成，请重试".to_string()))??;
    Ok(StartedLoginDto {
        flow_id: started.flow_id,
        verification_url: started.prompt.verification_url,
        user_code: started.prompt.user_code,
        expires_at: started.expires_at.to_rfc3339(),
    })
}

#[tauri::command]
pub async fn poll_official_device_login(
    state: tauri::State<'_, AppState>,
    flow_id: String,
) -> Result<PollLoginDto, AppError> {
    let vault = Vault::open_default()?;
    match codex_accounts::login::poll(&flow_id)? {
        LoginPoll::Pending => Ok(PollLoginDto {
            status: "pending".to_string(),
            key: None,
            error: None,
        }),
        LoginPoll::Completed(identity, auth) => {
            let codex_dir = crate::codex_config::get_codex_config_dir();
            let key = codex_accounts::register_cli_login(
                &state.db, &vault, &codex_dir, &identity, &auth,
            )?;
            Ok(PollLoginDto {
                status: "completed".to_string(),
                key: Some(key),
                error: None,
            })
        }
        LoginPoll::Expired => Ok(PollLoginDto {
            status: "expired".to_string(),
            key: None,
            error: Some("登录已过期，请重试".to_string()),
        }),
        LoginPoll::Failed(err) => Ok(PollLoginDto {
            status: "failed".to_string(),
            key: None,
            error: Some(err.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn cancel_official_device_login(flow_id: String) -> Result<(), AppError> {
    codex_accounts::login::cancel(&flow_id)
}

#[tauri::command]
pub async fn remove_official_account(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<(), AppError> {
    let vault = Vault::open_default()?;
    remove_official_account_from(&state.db, &key, || vault.remove_account(&key))?;
    forget_official_account_metadata(&state.db, &key);
    Ok(())
}

/// One account a batch removal could not finish.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialAccountRemovalFailure {
    pub key: String,
    pub error: String,
}

/// The outcome of a batch removal: the keys that went away, and the ones that
/// did not, each with the reason.
///
/// A batch is never all-or-nothing: the accounts that succeeded stay removed,
/// so retrying only has to deal with the failures.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialAccountRemovalDto {
    pub removed: Vec<String>,
    pub failed: Vec<OfficialAccountRemovalFailure>,
}

/// Removes several accounts, one at a time.
///
/// Each account goes through the whole single-removal path (detach every line,
/// then delete the credentials), so a batch cannot half-detach an account.
#[tauri::command]
pub async fn remove_official_accounts(
    state: tauri::State<'_, AppState>,
    keys: Vec<String>,
) -> Result<OfficialAccountRemovalDto, AppError> {
    codex_accounts::require_enabled()?;
    // Opening the vault once for the whole batch: each open re-reads the
    // DPAPI-protected directory listing, which is the expensive part.
    let vault = Vault::open_default()?;
    let mut seen = std::collections::HashSet::new();
    let mut removed = Vec::new();
    let mut failed = Vec::new();
    for key in keys {
        if !seen.insert(key.clone()) {
            continue;
        }
        match remove_official_account_from(&state.db, &key, || vault.remove_account(&key)) {
            Ok(()) => {
                forget_official_account_metadata(&state.db, &key);
                removed.push(key);
            }
            // A partial failure leaves the account (or its lines) in place, so
            // its labels must stay too: dropping them would lose the user's
            // tags and note for an account that is still listed.
            Err(error) => failed.push(OfficialAccountRemovalFailure {
                key,
                error: error.to_string(),
            }),
        }
    }
    Ok(OfficialAccountRemovalDto { removed, failed })
}

/// Drops the labels and the cached reading of an account that is gone.
///
/// Best effort: the credentials are already removed by the time this runs, so
/// a failure here must not turn a successful removal into an error. The leftover
/// rows are harmless (nothing lists an account without a slot) and are cleared
/// the next time the same account is removed.
fn forget_official_account_metadata(db: &crate::database::Database, key: &str) {
    if let Err(error) = db.forget_official_account(key) {
        log::warn!("Dropping the metadata of a removed account failed ({key}): {error}");
    }
}

fn remove_official_account_from(
    db: &crate::database::Database,
    key: &str,
    remove_credentials: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    let transaction = codex_accounts::account_mutation()?;
    // Never remove credentials until every binding is detached. A failed DB write
    // leaves the account present; retry only needs to detach the remaining lines.
    let lines = codex_accounts::official_lines(db)?;
    for mut line in lines {
        if line.official_account_key() == Some(key) {
            codex_accounts::set_pin(&mut line, None);
            db.save_provider_with_account_pin(&transaction, &line).map_err(|error| {
                AppError::Message(format!(
                    "Account retained: failed to detach provider {}: {error}. Some providers may already be detached; retry removal.", line.id
                ))
            })?;
        }
    }
    remove_credentials().map_err(|error| {
        AppError::Message(format!(
            "Providers detached, but credential removal is incomplete: {error}. Retry removal."
        ))
    })
}

#[tauri::command]
pub async fn get_notes(
    state: tauri::State<'_, AppState>,
    table: String,
) -> Result<HashMap<String, String>, AppError> {
    let notes_table = parse_notes_table(&table)?;
    state.db.get_notes(notes_table)
}

#[tauri::command]
pub async fn set_notes(
    state: tauri::State<'_, AppState>,
    table: String,
    id: String,
    notes: Option<String>,
) -> Result<(), AppError> {
    let notes_table = parse_notes_table(&table)?;
    if !state.db.set_notes(notes_table, &id, notes.as_deref())? {
        return Err(AppError::InvalidInput("备注对象不存在".to_string()));
    }
    Ok(())
}

/// Replaces an account's tags. Returns the stored (trimmed, deduplicated) set
/// so the caller can render exactly what was saved.
#[tauri::command]
pub async fn set_official_account_tags(
    state: tauri::State<'_, AppState>,
    key: String,
    tags: Vec<String>,
) -> Result<Vec<String>, AppError> {
    validate_account_key(&key)?;
    let tags = meta::normalize_tags(&tags)?;
    let stored = state
        .db
        .update_official_account_meta(&key, now_millis(), |meta| meta.tags = tags)?;
    Ok(stored.tags)
}

/// Moves an account into a group, or out of every group when `group` is `None`
/// (or empty).
#[tauri::command]
pub async fn set_official_account_group(
    state: tauri::State<'_, AppState>,
    key: String,
    group: Option<String>,
) -> Result<(), AppError> {
    validate_account_key(&key)?;
    let group = group
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    if let Some(id) = group.as_deref() {
        // The page may still hold a group the user deleted in another window:
        // refuse the dangling reference rather than storing it, because the
        // group list is what the toolbar renders from.
        let index = state.db.official_account_meta_index()?;
        if index.group(id).is_none() {
            return Err(AppError::InvalidInput("分组不存在或已被删除".to_string()));
        }
    }
    state
        .db
        .update_official_account_meta(&key, now_millis(), |meta| meta.group_id = group)?;
    Ok(())
}

/// Replaces an account's note; `None` or blank clears it.
#[tauri::command]
pub async fn set_official_account_note(
    state: tauri::State<'_, AppState>,
    key: String,
    note: Option<String>,
) -> Result<(), AppError> {
    validate_account_key(&key)?;
    let note = meta::normalize_note(note.as_deref())?;
    state
        .db
        .update_official_account_meta(&key, now_millis(), |meta| meta.note = note)?;
    Ok(())
}

/// Holds an account out of use, or puts it back.
///
/// This is a label only: the credentials stay, so the account can be re-enabled
/// without signing in again. Re-enabling clears both the timestamp and the
/// reason, which is why the two are written together.
#[tauri::command]
pub async fn set_official_account_disabled(
    state: tauri::State<'_, AppState>,
    key: String,
    disabled: bool,
    reason: Option<String>,
) -> Result<(), AppError> {
    validate_account_key(&key)?;
    let reason = meta::normalize_disabled_reason(reason.as_deref())?;
    let now = now_millis();
    state.db.update_official_account_meta(&key, now, |meta| {
        meta.disabled = disabled;
        meta.disabled_at = disabled.then_some(now);
        meta.disabled_reason = if disabled { reason } else { None };
    })?;
    Ok(())
}

/// Records that an account was used right now.
///
/// The account list already refreshes this for the account Codex runs on; this
/// command exists for the switch that makes an account current, so the stamp is
/// exact instead of up to [`LAST_USED_THROTTLE_MS`] late.
#[tauri::command]
pub async fn mark_official_account_used(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<(), AppError> {
    validate_account_key(&key)?;
    // No throttle: the caller is stating a fact, not opening a page.
    state
        .db
        .touch_official_account_last_used(&key, now_millis(), 0)?;
    Ok(())
}

/// Every group with the number of accounts it holds.
#[tauri::command]
pub async fn list_official_account_groups(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<OfficialAccountGroupDto>, AppError> {
    let (accounts, meta_index) = load_official_accounts(&state).await?;
    Ok(group_dtos(&accounts, &meta_index))
}

/// Creates a group at the end of the list.
#[tauri::command]
pub async fn create_official_account_group(
    state: tauri::State<'_, AppState>,
    name: String,
    color: Option<String>,
) -> Result<OfficialAccountGroupDto, AppError> {
    let name = meta::normalize_group_name(&name)?;
    let color = normalize_group_color(color)?;
    let sort_index = state.db.next_official_account_group_sort_index()?;
    let group = AccountGroup {
        // Prefixed like `dao::prompts` category ids, so a group id is
        // recognizable in a log or a hand-edited database.
        id: format!("group-{}", uuid::Uuid::new_v4()),
        name,
        color,
        sort_index,
    };
    state
        .db
        .create_official_account_group(&group, now_millis())?;
    Ok(OfficialAccountGroupDto {
        id: group.id,
        name: group.name,
        color: group.color,
        sort_index: group.sort_index,
        account_count: 0,
    })
}

/// Renames, recolors or reorders a group. A `color` of `None` clears it.
#[tauri::command]
pub async fn update_official_account_group(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
    color: Option<String>,
    sort_index: Option<i64>,
) -> Result<(), AppError> {
    let name = meta::normalize_group_name(&name)?;
    let color = normalize_group_color(color)?;
    let changed = state.db.update_official_account_group(
        &id,
        &name,
        color.as_deref(),
        sort_index,
        now_millis(),
    )?;
    if !changed {
        return Err(AppError::InvalidInput("分组不存在或已被删除".to_string()));
    }
    Ok(())
}

/// Deletes a group and leaves its accounts ungrouped. Returns how many accounts
/// that affected, so the page can say so.
#[tauri::command]
pub async fn delete_official_account_group(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<usize, AppError> {
    state.db.delete_official_account_group(&id, now_millis())
}

/// Applies a new group order; the first id becomes the first group.
#[tauri::command]
pub async fn reorder_official_account_groups(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), AppError> {
    state.db.reorder_official_account_groups(&ids, now_millis())
}

/// Groups with their member counts, in the user's order.
///
/// Counted from the rows the page is about to show, not from the metadata
/// table, so a group never claims members the list does not have (a label row
/// can survive a slot the user deleted outside the app).
fn group_dtos(
    accounts: &[OfficialAccountDto],
    index: &AccountMetaIndex,
) -> Vec<OfficialAccountGroupDto> {
    let mut groups: Vec<OfficialAccountGroupDto> = index
        .groups_sorted()
        .into_iter()
        .map(|group| OfficialAccountGroupDto {
            account_count: accounts
                .iter()
                .filter(|account| account.group_id.as_deref() == Some(group.id.as_str()))
                .count(),
            id: group.id,
            name: group.name,
            color: group.color,
            sort_index: group.sort_index,
        })
        .collect();
    // A stable secondary key keeps the sidebar from reshuffling between two
    // groups that share a sort_index.
    groups.sort_by(|left, right| {
        left.sort_index
            .cmp(&right.sort_index)
            .then_with(|| left.name.cmp(&right.name))
    });
    groups
}

/// Accepts `#RGB`/`#RRGGBB` (the shapes the design system uses) and rejects
/// anything else, so the color column cannot become arbitrary user text that a
/// later renderer might treat as a style injection.
fn normalize_group_color(color: Option<String>) -> Result<Option<String>, AppError> {
    let Some(color) = color else {
        return Ok(None);
    };
    let color = color.trim().to_lowercase();
    if color.is_empty() {
        return Ok(None);
    }
    let digits = color.strip_prefix('#');
    let valid = match digits {
        Some(digits) => {
            matches!(digits.len(), 3 | 6 | 8) && digits.chars().all(|c| c.is_ascii_hexdigit())
        }
        None => false,
    };
    if !valid || color.chars().count() > GROUP_COLOR_MAX_CHARS {
        return Err(AppError::InvalidInput("分组颜色需形如 #RRGGBB".to_string()));
    }
    Ok(Some(color))
}

#[tauri::command]
pub async fn get_codex_mcp_section_preview(
    id: String,
    spec: serde_json::Value,
    mask: Option<String>,
) -> Result<(String, String), AppError> {
    let mask_str = mask.unwrap_or_else(|| "[已设置]".to_string());
    crate::mcp::codex_mcp_section_preview(&id, &spec, move |_| mask_str.clone())
}

fn parse_notes_table(table: &str) -> Result<crate::database::NotesTable, AppError> {
    match table {
        "skills" => Ok(crate::database::NotesTable::Skills),
        "mcp_servers" => Ok(crate::database::NotesTable::McpServers),
        _ => Err(AppError::InvalidInput("不支持的备注类型".to_string())),
    }
}

#[cfg(test)]
mod account_line_tests {
    use super::*;
    use crate::provider::Provider;

    fn lines() -> Vec<Provider> {
        [
            ("other", "other-account"),
            ("first", "account"),
            ("second", "account"),
        ]
        .into_iter()
        .map(|(id, key)| {
            let mut line = Provider::with_id(
                id.into(),
                id.into(),
                serde_json::json!({"auth": {}, "config": ""}),
                None,
            );
            line.category = Some("official".into());
            codex_accounts::set_pin(&mut line, Some(key));
            line
        })
        .collect()
    }

    #[test]
    fn shared_account_prefers_current_line_even_when_it_is_second() {
        let lines = lines();
        for current_id in ["second", "first"] {
            let line = official_account_line(&lines, "account", Some(current_id)).unwrap();
            assert_eq!(line.id, current_id);
        }
    }

    #[test]
    fn shared_account_falls_back_to_first_matching_line() {
        let lines = lines();
        for current_id in [None, Some("other"), Some("missing")] {
            let line = official_account_line(&lines, "account", current_id).unwrap();
            assert_eq!(line.id, "first");
        }
        assert!(official_account_line(&lines, "missing-account", Some("second")).is_none());
    }
}

#[cfg(test)]
mod live_account_tests {
    use super::*;
    use crate::codex_accounts::identity::test_support::{chatgpt_login, identity, jwt};
    use crate::codex_accounts::test_support::Fixture;
    use crate::codex_accounts::vault::SlotSource;
    use serde_json::{json, Value};

    fn save(fx: &Fixture, line_id: &str, auth: &Value) -> String {
        let LoginClass::Chatgpt(identity) = classify(auth) else {
            panic!("fixture must be a complete login");
        };
        fx.vault
            .store_slot(&identity, auth, SlotSource::Live)
            .unwrap();
        let key = identity.key();
        fx.add_line(line_id, Some(&key));
        key
    }

    fn list(fx: &Fixture, current_id: Option<&str>, proxy_active: bool) -> Vec<OfficialAccountDto> {
        // These cases are about what the vault and the lines say, so the labels
        // and the quota cache are deliberately empty.
        list_official_accounts_from_with(
            &fx.vault,
            &codex_accounts::official_lines(&fx.db).unwrap(),
            current_id,
            &fx.codex_dir(),
            proxy_active,
            &AccountMetaIndex::default(),
            &HashMap::new(),
        )
    }

    fn current_keys(accounts: &[OfficialAccountDto]) -> Vec<&str> {
        accounts
            .iter()
            .filter(|a| a.is_current)
            .map(|a| a.key.as_str())
            .collect()
    }

    #[test]
    fn stored_a_live_b_marks_only_the_live_identity_without_changing_either_store() {
        let fx = Fixture::new();
        let a = chatgpt_login("a", "2020-01-01T00:00:00Z");
        let b = chatgpt_login("b", "2020-01-01T00:00:00Z");
        let a_key = save(&fx, "line-a", &a);
        let b_key = save(&fx, "line-b", &b);
        fx.write_live(&b);
        let before = fx.live_bytes();
        let accounts = list(&fx, Some("line-a"), false);
        assert_eq!(current_keys(&accounts), vec![b_key.as_str()]);
        assert_eq!(
            accounts
                .iter()
                .find(|a| a.key == a_key)
                .unwrap()
                .provider_id
                .as_deref(),
            Some("line-a")
        );
        assert_eq!(fx.live_bytes(), before);
        assert_eq!(fx.vault.read_slot(&a_key).unwrap().unwrap().auth, a);
    }

    #[test]
    fn unsaved_live_account_does_not_leave_the_stored_account_current() {
        let fx = Fixture::new();
        save(&fx, "line-a", &chatgpt_login("a", "2020-01-01T00:00:00Z"));
        fx.write_live(&chatgpt_login("b", "2020-01-01T00:00:00Z"));
        assert!(current_keys(&list(&fx, Some("line-a"), false)).is_empty());
    }

    #[test]
    fn third_party_routes_do_not_mark_retained_official_auth_current() {
        for config in [
            "model_provider = 'custom'\n[model_providers.custom]\nbase_url = 'https://relay.example/v1'\n",
            "openai_base_url = 'https://relay.example/v1'\n",
            "chatgpt_base_url = 'https://relay.example/backend-api'\n",
            "model_provider = 'openai'\n[model_providers.openai]\nbase_url = 'https://relay.example/v1'\n",
            "profile = 'relay'\n[profiles.relay]\nmodel_provider = 'custom'\n",
            "profile = 'relay'\n[profiles.relay]\nchatgpt_base_url = 'https://relay.example'\n",
            "experimental_bearer_token = 'third-party-key'\n",
            "forced_login_method = 'api'\n",
            "forced_chatgpt_workspace_id = 'other-workspace'\n",
        ] {
            let fx = Fixture::new();
            let a = chatgpt_login("a", "2020-01-01T00:00:00Z");
            save(&fx, "line-a", &a);
            fx.write_live(&a);
            std::fs::write(fx.codex_dir().join("config.toml"), config).unwrap();
            assert!(current_keys(&list(&fx, Some("line-a"), false)).is_empty(), "{config}");
        }
    }

    #[test]
    fn unreadable_missing_or_incomplete_live_login_never_falls_back_to_stored_selection() {
        for auth in [
            None,
            Some("{"),
            Some("{}"),
            Some(r#"{"auth_mode":"apikey","OPENAI_API_KEY":"key"}"#),
        ] {
            let fx = Fixture::new();
            save(&fx, "line-a", &chatgpt_login("a", "2020-01-01T00:00:00Z"));
            if let Some(auth) = auth {
                std::fs::write(fx.codex_dir().join("auth.json"), auth).unwrap();
            }
            let accounts = list(&fx, Some("line-a"), false);
            assert_eq!(accounts.len(), 1);
            assert!(current_keys(&accounts).is_empty());
        }
        let fx = Fixture::new();
        save(&fx, "line-a", &chatgpt_login("a", "2020-01-01T00:00:00Z"));
        std::fs::create_dir(fx.codex_dir().join("auth.json")).unwrap();
        assert!(current_keys(&list(&fx, Some("line-a"), false)).is_empty());
    }

    #[test]
    fn unreadable_live_route_never_confirms_a_matching_login() {
        for contents in [b"model_provider = [".as_slice(), b"\xff".as_slice()] {
            let fx = Fixture::new();
            let a = chatgpt_login("a", "2020-01-01T00:00:00Z");
            save(&fx, "line-a", &a);
            fx.write_live(&a);
            std::fs::write(fx.codex_dir().join("config.toml"), contents).unwrap();
            assert!(current_keys(&list(&fx, Some("line-a"), false)).is_empty());
        }
    }

    #[test]
    fn users_sharing_a_workspace_remain_distinct() {
        let fx = Fixture::new();
        let a = chatgpt_login("a", "2020-01-01T00:00:00Z");
        let mut b = chatgpt_login("b", "2020-01-01T00:00:00Z");
        b["tokens"]["account_id"] = json!(identity("a").account_id);
        b["tokens"]["id_token"] = json!(jwt(json!({
            "https://api.openai.com/auth": {
                "chatgpt_user_id": identity("b").user_id,
                "chatgpt_account_id": identity("a").account_id,
            }
        })));
        save(&fx, "line-a", &a);
        let b_key = save(&fx, "line-b", &b);
        fx.write_live(&b);
        let accounts = list(&fx, Some("line-a"), false);
        assert_eq!(accounts[0].account_id, accounts[1].account_id);
        assert_eq!(current_keys(&accounts), vec![b_key.as_str()]);
    }

    #[test]
    fn matching_live_identity_is_current_on_native_and_unified_official_routes() {
        let fx = Fixture::new();
        let key = save(&fx, "line-a", &chatgpt_login("a", "2020-01-01T00:00:00Z"));
        // Token rotation does not change identity; the stored pointer is not proof either way.
        let mut live = chatgpt_login("a", "2020-01-02T00:00:00Z");
        live["tokens"]["access_token"] = json!("rotated-access-token");
        fx.write_live(&live);
        for config in [
            String::new(),
            "model_provider = 'openai'\n".to_string(),
            "chatgpt_base_url = 'https://chatgpt.com/backend-api/'\n".to_string(),
            crate::codex_config::inject_codex_unified_session_bucket("model = 'gpt-5.4'\n")
                .unwrap(),
        ] {
            std::fs::write(fx.codex_dir().join("config.toml"), config).unwrap();
            for current_id in [Some("line-a"), Some("stale-line"), None] {
                assert_eq!(
                    current_keys(&list(&fx, current_id, false)),
                    vec![key.as_str()]
                );
            }
        }
    }

    fn slot_file(fx: &Fixture, key: &str) -> std::path::PathBuf {
        fx.dir
            .path()
            .join("vault/accounts")
            .join(format!("{key}.json"))
    }

    // U4 A1: unreadable or missing slots stay visible and removable.
    #[test]
    fn unreadable_and_line_only_accounts_are_listed_as_needing_login() {
        let fx = Fixture::new();
        let a_key = save(&fx, "line-a", &chatgpt_login("a", "2020-01-01T00:00:00Z"));
        let b_key = save(&fx, "line-b", &chatgpt_login("b", "2020-01-01T00:00:00Z"));
        std::fs::write(slot_file(&fx, &a_key), b"corrupt").unwrap();
        // A line pinned to an account whose slot never reached this machine.
        let ghost_key = identity("ghost").key();
        fx.add_line("line-ghost", Some(&ghost_key));
        // A malformed pin can never be removed by key, so it is not listed.
        fx.add_line("line-forged", Some("forged-key"));

        let accounts = list(&fx, Some("line-b"), false);
        assert_eq!(accounts.len(), 3);
        for key in [&a_key, &ghost_key] {
            let row = accounts.iter().find(|row| row.key == *key).unwrap();
            assert!(row.unreadable && row.needs_relogin, "{key}");
            assert_eq!(row.display_name, "无法读取的账号");
            assert!(row.email.is_none() && row.plan_type.is_none());
            assert!(row.account_id.is_empty());
        }
        assert_eq!(
            accounts
                .iter()
                .find(|row| row.key == ghost_key)
                .unwrap()
                .provider_id
                .as_deref(),
            Some("line-ghost")
        );
        let b = accounts.iter().find(|row| row.key == b_key).unwrap();
        assert!(!b.unreadable && !b.needs_relogin && b.is_selected);
        assert_eq!(b.plan_type.as_deref(), Some("pro"));

        // Removing the unreadable account needs no decryption and leaves B alone.
        remove_official_account_from(&fx.db, &a_key, || fx.vault.remove_account(&a_key)).unwrap();
        assert!(!slot_file(&fx, &a_key).exists());
        assert!(fx.line("line-a").official_account_key().is_none());
        assert!(fx.vault.applicable_slot(&b_key).is_ok());
        let accounts = list(&fx, Some("line-b"), false);
        assert!(accounts.iter().all(|row| row.key != a_key));
    }

    // U4 A1: re-login and import repair an unreadable slot in place.
    #[test]
    fn signing_in_again_repairs_an_unreadable_account() {
        for cli in [false, true] {
            let fx = Fixture::new();
            let login = chatgpt_login("a", "2020-01-01T00:00:00Z");
            let key = save(&fx, "line-a", &login);
            std::fs::write(slot_file(&fx, &key), b"corrupt").unwrap();
            let fresh = chatgpt_login("a", "2020-01-02T00:00:00Z");
            fx.write_live(&fresh);
            let saved = if cli {
                let LoginClass::Chatgpt(account) = classify(&fresh) else {
                    panic!("fixture must be a complete login");
                };
                codex_accounts::register_cli_login(
                    &fx.db,
                    &fx.vault,
                    &fx.codex_dir(),
                    &account,
                    &fresh,
                )
            } else {
                codex_accounts::save_current_login(&fx.db, &fx.vault, &fx.codex_dir(), None)
            };
            assert_eq!(saved.unwrap(), key);
            assert_eq!(fx.vault.applicable_slot(&key).unwrap().auth, fresh);
            let accounts = list(&fx, Some("line-a"), false);
            assert_eq!(accounts.len(), 1);
            assert!(!accounts[0].unreadable && !accounts[0].needs_relogin);
            assert_eq!(codex_accounts::official_lines(&fx.db).unwrap().len(), 1);
        }
    }

    #[test]
    fn live_state_tells_unsaved_mismatched_and_third_party_logins_apart() {
        let fx = Fixture::new();
        let a = chatgpt_login("a", "2020-01-01T00:00:00Z");
        save(&fx, "line-a", &a);
        save(&fx, "line-b", &chatgpt_login("b", "2020-01-01T00:00:00Z"));
        let state = |fx: &Fixture, current: Option<&str>| list(fx, current, false)[0].live_state;

        fx.write_live(&a);
        assert_eq!(state(&fx, Some("line-a")), OfficialLiveState::Matched);
        assert_eq!(state(&fx, Some("line-b")), OfficialLiveState::Mismatch);
        fx.write_live(&chatgpt_login("stranger", "2020-01-01T00:00:00Z"));
        assert_eq!(state(&fx, Some("line-a")), OfficialLiveState::Unsaved);
        fx.write_live(&json!({"auth_mode": "apikey", "OPENAI_API_KEY": "sk-x"}));
        assert_eq!(state(&fx, Some("line-a")), OfficialLiveState::Mismatch);
        assert_eq!(state(&fx, None), OfficialLiveState::Unknown);
        std::fs::write(
            fx.codex_dir().join("config.toml"),
            "model_provider = 'custom'\n[model_providers.custom]\nbase_url = 'https://relay.example/v1'\n",
        )
        .unwrap();
        assert_eq!(
            state(&fx, Some("third-party")),
            OfficialLiveState::ThirdParty
        );
        std::fs::write(fx.codex_dir().join("config.toml"), "model_provider = [").unwrap();
        assert_eq!(state(&fx, Some("third-party")), OfficialLiveState::Unknown);
    }

    #[test]
    fn an_expired_access_token_is_reported_without_asking_for_a_new_login() {
        let fx = Fixture::new();
        let mut login = chatgpt_login("a", "2020-01-01T00:00:00Z");
        login["tokens"]["access_token"] = json!(jwt(json!({"exp": 1_000})));
        save(&fx, "line-a", &login);
        let accounts = list(&fx, Some("line-a"), false);
        assert!(accounts[0].access_expired);
        assert!(!accounts[0].needs_relogin);
        let quota = serde_json::to_value(expired_access_quota()).unwrap();
        assert_eq!(quota["accessExpired"], json!(true));
        assert_eq!(quota["credentialStatus"], json!("valid"));
        assert_eq!(quota["success"], json!(false));
        assert!(quota["queriedAt"].is_null());
    }

    #[test]
    fn official_proxy_route_requires_confirmed_proxy_ownership() {
        let fx = Fixture::new();
        let a = chatgpt_login("a", "2020-01-01T00:00:00Z");
        let key = save(&fx, "line-a", &a);
        fx.write_live(&a);
        // Current shapes (unified off/on) and the legacy cc-switch-official route.
        let unified_direct = crate::codex_config::inject_codex_unified_session_bucket("").unwrap();
        for config in [
            crate::codex_config::apply_codex_official_proxy_route(
                "",
                "http://127.0.0.1:15721/v1",
                false,
            )
            .unwrap(),
            crate::codex_config::apply_codex_official_proxy_route(
                &unified_direct,
                "http://127.0.0.1:15721/v1",
                true,
            )
            .unwrap(),
            "model_provider = \"cc-switch-official\"\n\n[model_providers.cc-switch-official]\nname = \"OpenAI\"\nrequires_openai_auth = true\nsupports_websockets = false\nwire_api = \"responses\"\nbase_url = \"http://127.0.0.1:15721/v1\"\n".to_string(),
        ] {
            std::fs::write(fx.codex_dir().join("config.toml"), &config).unwrap();
            let unconfirmed = list(&fx, Some("line-a"), false);
            assert!(current_keys(&unconfirmed).is_empty(), "{config}");
            // Not a third-party route nor another login: just unconfirmed.
            assert_eq!(
                unconfirmed[0].live_state,
                OfficialLiveState::Unknown,
                "{config}"
            );
            assert_eq!(
                current_keys(&list(&fx, Some("line-a"), true)),
                vec![key.as_str()],
                "{config}"
            );
        }
    }
}

#[cfg(test)]
mod notes_contract_tests {
    use super::*;
    #[test]
    fn notes_table_rejects_unknown_targets() {
        assert!(parse_notes_table("providers").is_err());
        assert!(parse_notes_table("").is_err());
        assert_eq!(
            parse_notes_table("skills").unwrap(),
            crate::database::NotesTable::Skills
        );
        assert_eq!(
            parse_notes_table("mcp_servers").unwrap(),
            crate::database::NotesTable::McpServers
        );
    }
}

#[cfg(test)]
mod audit_b09_tests {
    use super::*;
    use crate::{database::Database, provider::Provider};
    use std::cell::Cell;

    fn fixture() -> Database {
        let db = Database::memory().unwrap();
        for id in ["audit-first", "audit-second"] {
            let mut line = Provider::with_id(
                id.into(),
                id.into(),
                serde_json::json!({"auth": {}, "config": ""}),
                None,
            );
            line.category = Some("official".into());
            codex_accounts::set_pin(&mut line, Some("audit-account"));
            db.save_provider_with_account_pin(&codex_accounts::account_mutation().unwrap(), &line)
                .unwrap();
        }
        db
    }

    #[test]
    fn second_detach_failure_retains_credentials_and_retry_completes() {
        let db = fixture();
        // Reject whichever write happens second, independent of provider ordering.
        db.conn.lock().unwrap().execute_batch(
            "CREATE TABLE audit_writes (n INTEGER); INSERT INTO audit_writes VALUES (0);
             CREATE TRIGGER audit_count AFTER UPDATE ON providers BEGIN UPDATE audit_writes SET n = n + 1; END;
             CREATE TRIGGER audit_reject BEFORE UPDATE ON providers WHEN (SELECT n FROM audit_writes) >= 1
             BEGIN SELECT RAISE(ABORT, 'injected second detach failure'); END;"
        ).unwrap();
        let removed = Cell::new(false);
        let result = remove_official_account_from(&db, "audit-account", || {
            removed.set(true);
            Ok(())
        });
        assert!(result.unwrap_err().to_string().contains("Account retained"));
        assert!(!removed.get());
        assert_eq!(
            codex_accounts::official_lines(&db)
                .unwrap()
                .iter()
                .filter(|line| line.official_account_key() == Some("audit-account"))
                .count(),
            1
        );
        db.conn
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER audit_reject;")
            .unwrap();
        remove_official_account_from(&db, "audit-account", || {
            removed.set(true);
            Ok(())
        })
        .unwrap();
        assert!(removed.get());
        assert!(codex_accounts::official_lines(&db)
            .unwrap()
            .iter()
            .all(|line| line.official_account_key().is_none()));
    }

    #[test]
    fn vault_failure_is_explicit_and_retryable_after_detach() {
        let db = fixture();
        let result = remove_official_account_from(&db, "audit-account", || {
            Err(AppError::Message("injected Vault failure".into()))
        });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("credential removal is incomplete"));
        assert!(codex_accounts::official_lines(&db)
            .unwrap()
            .iter()
            .all(|line| line.official_account_key().is_none()));
        remove_official_account_from(&db, "audit-account", || Ok(())).unwrap();
    }
}

#[cfg(test)]
mod audit_b05_tests {
    use super::*;
    use crate::codex_accounts::identity::test_support::{chatgpt_login, identity};
    use crate::codex_accounts::test_support::Fixture;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn deletion_serializes_live_save_and_cli_registration_through_vault_removal() {
        for cli in [false, true] {
            let fx = Fixture::new();
            let account = identity("b05");
            let auth = chatgpt_login("b05", "2020-01-01T00:00:00Z");
            let key = account.key();
            fx.write_live(&auth);
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
            let live_before = fx.live_bytes();
            let (detached_tx, detached_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let (started_tx, started_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();
            std::thread::scope(|scope| {
                let fx = &fx;
                let key = &key;
                let removal = scope.spawn(move || {
                    remove_official_account_from(&fx.db, key, move || {
                        detached_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        fx.vault.remove_account(key)
                    })
                });
                detached_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                let account = &account;
                let auth = &auth;
                let writer = scope.spawn(move || {
                    started_tx.send(()).unwrap();
                    let result = if cli {
                        codex_accounts::register_cli_login(
                            &fx.db,
                            &fx.vault,
                            &fx.codex_dir(),
                            account,
                            auth,
                        )
                    } else {
                        codex_accounts::save_current_login(&fx.db, &fx.vault, &fx.codex_dir(), None)
                    };
                    done_tx.send(result).unwrap();
                });
                started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                let early = done_rx.recv_timeout(Duration::from_millis(100));
                // Always unblock deletion before asserting, including on regression.
                release_tx.send(()).unwrap();
                removal.join().unwrap().unwrap();
                writer.join().unwrap();
                assert!(matches!(early, Err(mpsc::RecvTimeoutError::Timeout)));
                assert_eq!(&done_rx.recv().unwrap().unwrap(), key);
            });
            assert_eq!(fx.vault.read_slot(&key).unwrap().unwrap().auth, auth);
            assert_eq!(
                codex_accounts::official_lines(&fx.db)
                    .unwrap()
                    .iter()
                    .filter(|line| line.official_account_key() == Some(key.as_str()))
                    .count(),
                1
            );
            assert_eq!(fx.live_bytes(), live_before);
            // The opposite serial order ends with neither a slot nor a binding.
            remove_official_account_from(&fx.db, &key, || fx.vault.remove_account(&key)).unwrap();
            assert!(fx.vault.read_slot(&key).unwrap().is_none());
            assert!(codex_accounts::official_lines(&fx.db)
                .unwrap()
                .iter()
                .all(|line| line.official_account_key().is_none()));
            assert_eq!(fx.live_bytes(), live_before);
        }
    }

    #[test]
    fn stale_provider_writes_during_and_after_deletion_cannot_restore_the_pin() {
        let fx = Fixture::new();
        let account = identity("stale-edit");
        let auth = chatgpt_login("stale-edit", "2020-01-01T00:00:00Z");
        let key =
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
        let mut stale = codex_accounts::official_lines(&fx.db).unwrap().remove(0);
        stale.name = "edited while removing".into();
        remove_official_account_from(&fx.db, &key, || {
            // Same primitive used by provider updates/backfill/rollback, after
            // detachment but before the vault unlink. It must not re-lock accounts.
            fx.db.save_provider("codex", &stale)?;
            assert!(fx.line(&stale.id).official_account_key().is_none());
            fx.vault.remove_account(&key)
        })
        .unwrap();
        fx.db.save_provider("codex", &stale).unwrap();
        assert_eq!(fx.line(&stale.id).name, stale.name);
        assert!(fx.line(&stale.id).official_account_key().is_none());
        assert!(fx.vault.read_slot(&key).unwrap().is_none());

        // Caller-owned transactions (bulk import) must obey the same rule.
        let mut conn = fx.db.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        crate::database::Database::save_provider_on_connection(&tx, "codex", &stale).unwrap();
        stale.id = "copied-stale-line".into();
        crate::database::Database::save_provider_on_connection(&tx, "codex", &stale).unwrap();
        tx.commit().unwrap();
        drop(conn);
        assert!(codex_accounts::official_lines(&fx.db)
            .unwrap()
            .iter()
            .all(|line| line.official_account_key().is_none()));
    }

    #[test]
    fn generic_writes_preserve_the_current_pin_but_cannot_import_one() {
        let fx = Fixture::new();
        let account = identity("current-pin");
        let auth = chatgpt_login("current-pin", "2020-01-01T00:00:00Z");
        let key =
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
        let mut edited = codex_accounts::official_lines(&fx.db).unwrap().remove(0);
        for pin in [None, Some("forged-key")] {
            codex_accounts::set_pin(&mut edited, pin);
            fx.db.save_provider("codex", &edited).unwrap();
            assert_eq!(
                fx.line(&edited.id).official_account_key(),
                Some(key.as_str())
            );
        }
        let mut copy = edited.clone();
        copy.id = "copied-line".into();
        fx.db.save_provider("codex", &copy).unwrap();
        assert!(fx.line(&copy.id).official_account_key().is_none());
        // Changing category cannot hide a bound row from official-account deletion.
        edited.category = Some("custom".into());
        fx.db.save_provider("codex", &edited).unwrap();
        assert!(fx.line(&edited.id).official_account_key().is_none());
        remove_official_account_from(&fx.db, &key, || fx.vault.remove_account(&key)).unwrap();
        assert!(fx.vault.read_slot(&key).unwrap().is_none());
    }

    #[test]
    fn switch_backfill_waits_for_deletion_and_cannot_recreate_a_slot_or_pin() {
        let fx = Fixture::new();
        let account = identity("backfill");
        let auth = chatgpt_login("backfill", "2020-01-01T00:00:00Z");
        let key =
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
        let stale = codex_accounts::official_lines(&fx.db).unwrap().remove(0);
        let (detached_tx, detached_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            let fx = &fx;
            let key = &key;
            let removal = scope.spawn(move || {
                remove_official_account_from(&fx.db, key, move || {
                    detached_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    fx.vault.remove_account(key)
                })
            });
            detached_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            let account = &account;
            let auth = &auth;
            let stale = &stale;
            let backfill = scope.spawn(move || {
                started_tx.send(()).unwrap();
                let result = fx
                    .vault
                    .refresh_existing_slot(account, auth)
                    .and_then(|()| fx.db.save_provider("codex", stale));
                done_tx.send(result).unwrap();
            });
            started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            let early = done_rx.recv_timeout(Duration::from_millis(100));
            release_tx.send(()).unwrap();
            removal.join().unwrap().unwrap();
            backfill.join().unwrap();
            assert!(matches!(early, Err(mpsc::RecvTimeoutError::Timeout)));
            done_rx.recv().unwrap().unwrap();
        });
        assert!(fx.vault.read_slot(&key).unwrap().is_none());
        assert!(fx.line(&stale.id).official_account_key().is_none());
    }

    #[test]
    fn backfill_refreshes_existing_credentials_but_preserves_tombstones() {
        let fx = Fixture::new();
        let account = identity("rotation");
        let auth = chatgpt_login("rotation", "2020-01-01T00:00:00Z");
        let newer = chatgpt_login("rotation", "2020-01-02T00:00:00Z");
        let key =
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
        fx.vault.refresh_existing_slot(&account, &newer).unwrap();
        assert_eq!(fx.vault.read_slot(&key).unwrap().unwrap().auth, newer);
        fx.vault.set_tombstone(&key).unwrap();
        fx.vault.refresh_existing_slot(&account, &newer).unwrap();
        assert!(fx.vault.has_tombstone(&key));
        remove_official_account_from(&fx.db, &key, || fx.vault.remove_account(&key)).unwrap();
        fx.vault.refresh_existing_slot(&account, &newer).unwrap();
        assert!(fx.vault.read_slot(&key).unwrap().is_none());
    }

    #[test]
    fn database_snapshot_replacement_keeps_only_current_local_bindings() {
        let fx = Fixture::new();
        let account = identity("snapshot");
        let auth = chatgpt_login("snapshot", "2020-01-01T00:00:00Z");
        let key =
            codex_accounts::register_cli_login(&fx.db, &fx.vault, &fx.codex_dir(), &account, &auth)
                .unwrap();
        let line = codex_accounts::official_lines(&fx.db).unwrap().remove(0);
        // Snapshot contains a formerly valid pin and another machine's line.
        let staged = fx.db.snapshot_to_memory().unwrap();
        let mut remote = line.clone();
        remote.id = "remote-only".into();
        crate::database::Database::save_provider_on_connection(&staged, "codex", &remote).unwrap();
        staged
            .execute(
                "UPDATE providers SET meta = ?1 WHERE id = ?2",
                rusqlite::params![serde_json::to_string(&line.meta).unwrap(), remote.id],
            )
            .unwrap();
        {
            let local = fx.db.conn.lock().unwrap();
            crate::database::Database::preserve_local_account_pins_on_connection(&local, &staged)
                .unwrap();
            let lines =
                crate::database::Database::get_all_providers_on_connection(&staged, "codex")
                    .unwrap();
            assert_eq!(lines[&line.id].official_account_key(), Some(key.as_str()));
            assert!(lines[&remote.id].official_account_key().is_none());
        }
        remove_official_account_from(&fx.db, &key, || fx.vault.remove_account(&key)).unwrap();
        {
            let mut local = fx.db.conn.lock().unwrap();
            crate::database::Database::preserve_local_account_pins_on_connection(&local, &staged)
                .unwrap();
            let backup = rusqlite::backup::Backup::new(&staged, &mut local).unwrap();
            backup.step(-1).unwrap();
        }
        assert!(codex_accounts::official_lines(&fx.db)
            .unwrap()
            .iter()
            .all(|line| line.official_account_key().is_none()));
        assert!(fx.vault.read_slot(&key).unwrap().is_none());

        // A damaged local catalog must not disable backup recovery or cause
        // recovery to trust an old pin from the backup instead.
        staged
            .execute(
                "UPDATE providers SET meta = ?1 WHERE id = ?2",
                rusqlite::params![serde_json::to_string(&line.meta).unwrap(), line.id],
            )
            .unwrap();
        let local = fx.db.conn.lock().unwrap();
        local
            .execute(
                "UPDATE providers SET meta = 'invalid-json' WHERE id = ?1",
                rusqlite::params![line.id],
            )
            .unwrap();
        crate::database::Database::preserve_local_account_pins_on_connection(&local, &staged)
            .unwrap();
        let lines =
            crate::database::Database::get_all_providers_on_connection(&staged, "codex").unwrap();
        assert!(lines[&line.id].official_account_key().is_none());
    }
}

/// The search, filter, sort and paging rules, exercised on plain rows: no
/// vault, no database, so a failure points at the rule and nothing else.
#[cfg(test)]
mod account_query_tests {
    use super::*;
    use crate::official_account_meta::{AccountGroup, AccountMeta, TAGS_MAX_COUNT};
    use crate::services::subscription::QuotaTier;

    /// A minimal account row; tests override only the fields they are about.
    fn account(key: &str) -> OfficialAccountDto {
        OfficialAccountDto {
            key: key.to_string(),
            account_id: format!("acct-{key}"),
            display_name: key.to_string(),
            email: None,
            plan_type: None,
            line_name: None,
            captured_at: "2026-11-01T09:00:00Z".to_string(),
            is_current: false,
            is_selected: false,
            needs_relogin: false,
            unreadable: false,
            access_expired: false,
            provider_id: None,
            live_state: OfficialLiveState::Unknown,
            tags: Vec::new(),
            group_id: None,
            group_name: None,
            note: None,
            disabled: false,
            disabled_at: None,
            disabled_reason: None,
            last_used_at: None,
            quota: None,
        }
    }

    fn with_quota(mut account: OfficialAccountDto, utilization: f64) -> OfficialAccountDto {
        account.quota = Some(OfficialQuotaDto {
            quota: SubscriptionQuota {
                tool: "codex".to_string(),
                credential_status: CredentialStatus::Valid,
                credential_message: None,
                success: true,
                tiers: vec![QuotaTier {
                    name: "five_hour".to_string(),
                    utilization,
                    resets_at: None,
                    used_value_usd: None,
                    max_value_usd: None,
                }],
                extra_usage: None,
                error: None,
                queried_at: Some(1_700_000_000_000),
            },
            access_expired: false,
        });
        account
    }

    fn index_with(groups: &[(&str, &str)], metas: &[(&str, Option<&str>)]) -> AccountMetaIndex {
        let mut group_map = HashMap::new();
        for (id, name) in groups {
            group_map.insert(
                id.to_string(),
                AccountGroup {
                    id: id.to_string(),
                    name: name.to_string(),
                    color: None,
                    sort_index: 0,
                },
            );
        }
        let mut meta_map = HashMap::new();
        for (key, group) in metas {
            meta_map.insert(
                key.to_string(),
                AccountMeta {
                    group_id: group.map(str::to_string),
                    ..AccountMeta::default()
                },
            );
        }
        AccountMetaIndex::new(meta_map, group_map)
    }

    fn keys(page: &OfficialAccountPageDto) -> Vec<&str> {
        page.items.iter().map(|item| item.key.as_str()).collect()
    }

    #[test]
    fn search_looks_at_names_emails_tags_and_notes_ignoring_case() {
        let mut email_hit = account("a");
        email_hit.email = Some("Person@Example.com".to_string());
        let mut tag_hit = account("b");
        tag_hit.tags = vec!["Work".to_string()];
        let mut note_hit = account("c");
        note_hit.note = Some("客户 A 的备用号".to_string());
        let accounts = vec![email_hit, tag_hit, note_hit, account("d")];

        let page = query_official_accounts_from(
            accounts.clone(),
            &AccountMetaIndex::default(),
            &OfficialAccountQuery {
                search: Some("example".to_string()),
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(keys(&page), vec!["a"]);

        let page = query_official_accounts_from(
            accounts.clone(),
            &AccountMetaIndex::default(),
            &OfficialAccountQuery {
                search: Some("  WORK  ".to_string()),
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(keys(&page), vec!["b"]);

        let page = query_official_accounts_from(
            accounts,
            &AccountMetaIndex::default(),
            &OfficialAccountQuery {
                search: Some("备用号".to_string()),
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(keys(&page), vec!["c"]);
    }

    #[test]
    fn a_blank_search_filters_nothing() {
        let accounts = vec![account("a"), account("b")];
        let page = query_official_accounts_from(
            accounts,
            &AccountMetaIndex::default(),
            &OfficialAccountQuery {
                search: Some("   ".to_string()),
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(page.total, 2);
        assert_eq!(page.unfiltered_total, 2);
    }

    #[test]
    fn every_requested_tag_must_be_present() {
        let mut both = account("both");
        both.tags = vec!["work".to_string(), "api".to_string()];
        let mut one = account("one");
        one.tags = vec!["work".to_string()];
        let accounts = vec![both, one];

        let page = query_official_accounts_from(
            accounts,
            &AccountMetaIndex::default(),
            &OfficialAccountQuery {
                tags: vec!["WORK".to_string(), "Api".to_string()],
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(keys(&page), vec!["both"]);
        assert_eq!(page.unfiltered_total, 2);
    }

    #[test]
    fn filters_keep_the_concepts_apart() {
        let mut current = account("current");
        current.is_current = true;
        let mut relogin = account("relogin");
        relogin.needs_relogin = true;
        let mut disabled = account("disabled");
        disabled.disabled = true;
        let mut unreadable = account("unreadable");
        unreadable.unreadable = true;
        let accounts = vec![current, relogin, disabled, unreadable];

        let only = |filter: OfficialAccountFilter| {
            let page = query_official_accounts_from(
                accounts.clone(),
                &AccountMetaIndex::default(),
                &OfficialAccountQuery {
                    filter,
                    ..OfficialAccountQuery::default()
                },
            );
            keys(&page).join(",")
        };
        assert_eq!(
            only(OfficialAccountFilter::All),
            "current,relogin,disabled,unreadable"
        );
        assert_eq!(only(OfficialAccountFilter::Current), "current");
        assert_eq!(only(OfficialAccountFilter::NeedsRelogin), "relogin");
        assert_eq!(only(OfficialAccountFilter::Disabled), "disabled");
        assert_eq!(only(OfficialAccountFilter::Unreadable), "unreadable");
    }

    #[test]
    fn the_ungrouped_filter_is_its_own_choice() {
        let mut grouped = account("grouped");
        grouped.group_id = Some("g1".to_string());
        let accounts = vec![grouped, account("loose")];
        let index = index_with(&[("g1", "工作")], &[]);

        let page = query_official_accounts_from(
            accounts.clone(),
            &index,
            &OfficialAccountQuery {
                group: Some("g1".to_string()),
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(keys(&page), vec!["grouped"]);

        let page = query_official_accounts_from(
            accounts,
            &index,
            &OfficialAccountQuery {
                group: Some(UNGROUPED_GROUP.to_string()),
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(keys(&page), vec!["loose"]);
    }

    #[test]
    fn sorting_by_quota_puts_the_least_used_first_and_unread_last_both_ways() {
        let accounts = vec![
            with_quota(account("heavy"), 91.0),
            account("never"),
            with_quota(account("light"), 12.0),
        ];
        let sort = |direction| {
            let page = query_official_accounts_from(
                accounts.clone(),
                &AccountMetaIndex::default(),
                &OfficialAccountQuery {
                    sort: OfficialAccountSort::Quota,
                    direction,
                    ..OfficialAccountQuery::default()
                },
            );
            keys(&page).join(",")
        };
        assert_eq!(sort(SortDirection::Asc), "light,heavy,never");
        // An account with no reading has no place in a usage order, so it stays
        // last instead of pretending to be zero.
        assert_eq!(sort(SortDirection::Desc), "heavy,light,never");
    }

    #[test]
    fn sorting_by_name_and_last_used_keeps_missing_stamps_last() {
        let mut recent = account("bbb");
        recent.last_used_at = Some(2_000);
        let mut old = account("aaa");
        old.last_used_at = Some(1_000);
        let accounts = vec![recent, account("ccc"), old];

        let page = query_official_accounts_from(
            accounts.clone(),
            &AccountMetaIndex::default(),
            &OfficialAccountQuery {
                sort: OfficialAccountSort::Name,
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(keys(&page), vec!["aaa", "bbb", "ccc"]);

        let page = query_official_accounts_from(
            accounts,
            &AccountMetaIndex::default(),
            &OfficialAccountQuery {
                sort: OfficialAccountSort::LastUsed,
                direction: SortDirection::Desc,
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(keys(&page), vec!["bbb", "aaa", "ccc"]);
    }

    #[test]
    fn paging_clamps_and_reports_the_whole_set() {
        let accounts: Vec<_> = (0..7).map(|index| account(&format!("k{index}"))).collect();
        let page = query_official_accounts_from(
            accounts.clone(),
            &AccountMetaIndex::default(),
            &OfficialAccountQuery {
                page: Some(2),
                page_size: Some(3),
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(keys(&page), vec!["k3", "k4", "k5"]);
        assert_eq!((page.total, page.total_pages), (7, 3));

        // A stale page number from a shrinking list lands on the last page
        // instead of returning nothing.
        let page = query_official_accounts_from(
            accounts,
            &AccountMetaIndex::default(),
            &OfficialAccountQuery {
                page: Some(99),
                page_size: Some(3),
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(page.page, 3);
        assert_eq!(keys(&page), vec!["k6"]);

        // An absurd page size is clamped, not honoured.
        let page = query_official_accounts_from(
            Vec::new(),
            &AccountMetaIndex::default(),
            &OfficialAccountQuery {
                page_size: Some(100_000),
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(page.page_size, MAX_PAGE_SIZE);
        assert_eq!(page.page, 1);
        assert_eq!(page.total_pages, 0);
    }

    #[test]
    fn the_tag_vocabulary_and_group_counts_describe_the_whole_list() {
        let mut first = account("first");
        first.tags = vec!["work".to_string()];
        first.group_id = Some("g1".to_string());
        let mut second = account("second");
        second.tags = vec!["api".to_string(), "work".to_string()];
        second.group_id = Some("g1".to_string());
        let mut third = account("third");
        third.group_id = Some("g2".to_string());
        let accounts = vec![first, second, third];
        let index = index_with(&[("g1", "工作"), ("g2", "测试")], &[]);

        let page = query_official_accounts_from(
            accounts,
            &index,
            &OfficialAccountQuery {
                // Filtering must not shrink the vocabulary the toolbar shows.
                filter: OfficialAccountFilter::Disabled,
                ..OfficialAccountQuery::default()
            },
        );
        assert_eq!(page.total, 0);
        assert_eq!(page.unfiltered_total, 3);
        assert_eq!(page.tags, vec!["api".to_string(), "work".to_string()]);
        assert_eq!(
            page.groups
                .iter()
                .map(|group| (group.id.as_str(), group.account_count))
                .collect::<Vec<_>>(),
            vec![("g1", 2), ("g2", 1)]
        );
    }

    #[test]
    fn group_colors_are_hex_or_nothing() {
        assert_eq!(
            normalize_group_color(Some("  #AABBCC ".to_string())).unwrap(),
            Some("#aabbcc".to_string())
        );
        assert_eq!(
            normalize_group_color(Some("#abc".to_string())).unwrap(),
            Some("#abc".to_string())
        );
        assert_eq!(
            normalize_group_color(Some("   ".to_string())).unwrap(),
            None
        );
        assert_eq!(normalize_group_color(None).unwrap(), None);
        for bad in ["aabbcc", "#12345", "rgb(1,2,3)", "#GGGGGG"] {
            assert!(
                normalize_group_color(Some(bad.to_string())).is_err(),
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn tag_limits_match_the_storage_limits() {
        assert!(meta::normalize_tags(&["x".repeat(meta::TAG_MAX_CHARS + 1)]).is_err());
        let too_many: Vec<String> = (0..=TAGS_MAX_COUNT)
            .map(|index| format!("tag{index}"))
            .collect();
        assert!(meta::normalize_tags(&too_many).is_err());
    }
}
