//! Cached quota readings for Codex official accounts, stored in SQLite
//! (`official_account_quota`) instead of being fetched on every page visit.
//!
//! The shape of a reading is the existing [`SubscriptionQuota`], so a cached
//! value and a live one are indistinguishable to the frontend and no second
//! DTO is needed. Two timestamps are kept apart on purpose:
//!
//! * `fetched_at` — the last *successful* reading. Only that ages into
//!   "stale, please refresh"; it never moves backwards on a failure.
//! * `last_attempt_at` — the last attempt of any kind. This is what the retry
//!   backoff and the manual-refresh debounce are measured against, so a failing
//!   endpoint cannot be hammered by a user clicking refresh, nor by the page
//!   reopening.
//!
//! Nothing here reads a token: the caller resolves credentials and queries.
//!
//! ## Sessions left in use
//!
//! A cached reading is *display* data only. Account switching re-reads quota
//! from the live endpoint, because a stale cache must never be the reason an
//! exhausted account looks healthy. See `docs/accounts/v2.9-account-model-zh.md`.

use crate::database::OfficialQuotaRow;
use crate::error::AppError;
use crate::services::subscription::SubscriptionQuota;

/// A reading younger than this is served from cache without a request
/// (the Claude account page uses the same 5 minutes).
pub(crate) const QUOTA_FRESH_MS: i64 = 5 * 60 * 1000;
/// After a failed attempt, wait this long before trying the endpoint again.
pub(crate) const QUOTA_ERROR_RETRY_MS: i64 = 60 * 1000;
/// Two manual refreshes closer than this collapse into the cached answer,
/// so a double click does not cost two requests.
pub(crate) const QUOTA_MANUAL_DEBOUNCE_MS: i64 = 10 * 1000;

/// One account's stored quota state.
#[derive(Debug, Clone, Default)]
pub(crate) struct QuotaRecord {
    /// Last reading, successful or not; `None` when the account was never
    /// queried on this machine.
    pub(crate) payload: Option<SubscriptionQuota>,
    /// Milliseconds since the epoch of the last successful reading, 0 if none.
    pub(crate) fetched_at: i64,
    /// Milliseconds since the epoch of the last attempt, 0 if none.
    pub(crate) last_attempt_at: i64,
    /// The stored reading was taken while the access token had run out.
    pub(crate) access_expired: bool,
}

/// Whether `at` lies within `window` before `now`. A stamp from the future
/// (the clock was set back since) is not: it must not keep a reading fresh,
/// or a retry held off, until the clock catches up.
fn within(now_ms: i64, at_ms: i64, window_ms: i64) -> bool {
    at_ms > 0 && (0..window_ms).contains(&now_ms.saturating_sub(at_ms))
}

impl QuotaRecord {
    /// The record behind a stored row; the default (never queried) for none.
    /// An unparsable payload is treated as "never queried" rather than
    /// failing the page: the next refresh overwrites it.
    pub(crate) fn from_row(row: Option<OfficialQuotaRow>) -> Self {
        let Some(row) = row else {
            return Self::default();
        };
        Self {
            payload: serde_json::from_str(&row.payload).ok(),
            fetched_at: row.fetched_at,
            last_attempt_at: row.last_attempt_at,
            access_expired: row.access_expired,
        }
    }

    /// The row to store for this record.
    pub(crate) fn to_row(&self) -> Result<OfficialQuotaRow, AppError> {
        let payload = self
            .payload
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| AppError::Database(format!("序列化配额缓存失败: {e}")))?
            .unwrap_or_default();
        Ok(OfficialQuotaRow {
            payload,
            fetched_at: self.fetched_at,
            last_attempt_at: self.last_attempt_at,
            access_expired: self.access_expired,
        })
    }

    /// Whether the last reading (if any) came back usable.
    fn is_successful(&self) -> bool {
        self.payload.as_ref().is_some_and(|quota| quota.success)
    }

    /// A successful reading newer than [`QUOTA_FRESH_MS`], which needs no
    /// request. A failed reading is never fresh, however recently it was taken.
    pub(crate) fn is_fresh(&self, now_ms: i64) -> bool {
        self.is_successful() && within(now_ms, self.fetched_at, QUOTA_FRESH_MS)
    }

    /// Whether the last attempt failed, judged by its own payload: a failed
    /// reading keeps its old `fetched_at`, so age alone would look stale.
    fn last_attempt_failed(&self) -> bool {
        self.payload.as_ref().is_some_and(|quota| !quota.success)
    }

    /// Whether the backoff after a failure is still running.
    pub(crate) fn is_backing_off(&self, now_ms: i64) -> bool {
        self.last_attempt_failed() && within(now_ms, self.last_attempt_at, QUOTA_ERROR_RETRY_MS)
    }

    /// The reading to show without touching the network, if one exists.
    pub(crate) fn cached(&self) -> Option<&SubscriptionQuota> {
        self.payload.as_ref()
    }
}

/// Why a quota query was or was not started, so the caller can log it and the
/// user interface can tell "cached" from "just fetched".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QuotaQuery {
    /// Serve [`QuotaRecord::cached`] as is.
    ReuseCache,
    /// Ask the endpoint, then store the answer.
    Query,
}

/// Decides whether one account's quota has to be fetched now.
///
/// `force` is a user-initiated refresh: it skips the freshness window but
/// still respects the short debounce, and it always respects the failure
/// backoff unless the user is looking at an error they want retried (hence
/// `force` clears only the freshness rule, not the backoff).
pub(crate) fn decide(record: &QuotaRecord, now_ms: i64, force: bool) -> QuotaQuery {
    if record.is_backing_off(now_ms) {
        return QuotaQuery::ReuseCache;
    }
    if force {
        let recently_attempted = within(now_ms, record.last_attempt_at, QUOTA_MANUAL_DEBOUNCE_MS);
        return if recently_attempted && record.payload.is_some() {
            QuotaQuery::ReuseCache
        } else {
            QuotaQuery::Query
        };
    }
    if record.is_fresh(now_ms) {
        QuotaQuery::ReuseCache
    } else {
        QuotaQuery::Query
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::subscription::{CredentialStatus, SubscriptionQuota};

    fn ok_quota() -> SubscriptionQuota {
        SubscriptionQuota {
            tool: "codex".to_string(),
            credential_status: CredentialStatus::Valid,
            credential_message: None,
            success: true,
            tiers: Vec::new(),
            extra_usage: None,
            error: None,
            queried_at: Some(1),
        }
    }

    fn failed_quota() -> SubscriptionQuota {
        SubscriptionQuota::error("codex", CredentialStatus::Valid, "boom".to_string())
    }

    fn record(
        payload: Option<SubscriptionQuota>,
        fetched_at: i64,
        last_attempt_at: i64,
    ) -> QuotaRecord {
        QuotaRecord {
            payload,
            fetched_at,
            last_attempt_at,
            access_expired: false,
        }
    }

    #[test]
    fn a_never_queried_account_is_always_queried() {
        assert_eq!(
            decide(&QuotaRecord::default(), 1000, false),
            QuotaQuery::Query
        );
        assert_eq!(
            decide(&QuotaRecord::default(), 1000, true),
            QuotaQuery::Query
        );
    }

    #[test]
    fn a_fresh_reading_is_reused_until_the_window_passes() {
        let now = 10 * QUOTA_FRESH_MS;
        let fresh = record(
            Some(ok_quota()),
            now - QUOTA_FRESH_MS + 1,
            now - QUOTA_FRESH_MS + 1,
        );
        assert_eq!(decide(&fresh, now, false), QuotaQuery::ReuseCache);
        let stale = record(Some(ok_quota()), now - QUOTA_FRESH_MS, now - QUOTA_FRESH_MS);
        assert_eq!(decide(&stale, now, false), QuotaQuery::Query);
    }

    #[test]
    fn forcing_skips_freshness_but_not_the_debounce() {
        let now = 10 * QUOTA_FRESH_MS;
        let fresh = record(Some(ok_quota()), now - 1000, now - 1000);
        assert_eq!(decide(&fresh, now, false), QuotaQuery::ReuseCache);
        assert_eq!(decide(&fresh, now, true), QuotaQuery::ReuseCache);
        let old = record(
            Some(ok_quota()),
            now - QUOTA_FRESH_MS * 2,
            now - QUOTA_MANUAL_DEBOUNCE_MS,
        );
        assert_eq!(decide(&old, now, true), QuotaQuery::Query);
    }

    #[test]
    fn a_failure_is_not_retried_until_the_backoff_ends() {
        let now = 10 * QUOTA_FRESH_MS;
        let failing = record(Some(failed_quota()), now - QUOTA_FRESH_MS * 3, now - 1);
        assert_eq!(decide(&failing, now, false), QuotaQuery::ReuseCache);
        assert_eq!(decide(&failing, now, true), QuotaQuery::ReuseCache);
        let recovered = record(
            Some(failed_quota()),
            now - QUOTA_FRESH_MS * 3,
            now - QUOTA_ERROR_RETRY_MS,
        );
        assert_eq!(decide(&recovered, now, false), QuotaQuery::Query);
    }

    #[test]
    fn a_reading_stamped_in_the_future_is_queried_again() {
        // The clock was set back after the reading was taken.
        let now = 10 * QUOTA_FRESH_MS;
        let ahead = record(Some(ok_quota()), now + 60_000, now + 60_000);
        assert!(!ahead.is_fresh(now));
        assert_eq!(decide(&ahead, now, false), QuotaQuery::Query);
        assert_eq!(decide(&ahead, now, true), QuotaQuery::Query);
        let failed_ahead = record(Some(failed_quota()), 0, now + 60_000);
        assert!(!failed_ahead.is_backing_off(now));
    }

    #[test]
    fn a_failed_reading_never_counts_as_fresh() {
        let now = 1000;
        let failed = record(Some(failed_quota()), now, now);
        assert!(!failed.is_fresh(now));
        assert!(failed.is_backing_off(now));
    }
}
