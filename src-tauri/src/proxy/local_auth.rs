//! Shared credential handling for the local proxy's own endpoints.
//!
//! Clients present the proxy token in whichever header their SDK uses:
//! `Authorization: Bearer …` (OpenAI / Codex), `x-api-key` (Anthropic) or
//! `x-goog-api-key` (Gemini). Comparison is constant-time so a local process
//! cannot recover a token byte by byte from response timing.

use crate::database::Database;
use crate::error::AppError;
pub(crate) use crate::proxy_marker::{is_proxy_token, PROXY_TOKEN_PREFIX};
use axum::http::{header::AUTHORIZATION, HeaderMap};
use std::sync::RwLock;
use subtle::ConstantTimeEq;

const TOKEN_SETTING_KEY: &str = "local_proxy_token";
const LEGACY_UNTIL_SETTING_KEY: &str = "local_proxy_legacy_until";
/// Clients that were taken over before this install had a token still hold the
/// bare placeholder until they are restarted; it keeps working for this long.
const LEGACY_GRACE_SECS: i64 = 72 * 60 * 60;

#[cfg_attr(test, allow(dead_code))]
static ACTIVE_TOKEN: RwLock<Option<String>> = RwLock::new(None);

/// The token written into live configs. Unit tests keep the bare placeholder
/// so fixtures stay stable.
#[cfg(not(test))]
pub(crate) fn proxy_token() -> String {
    ACTIVE_TOKEN
        .read()
        .ok()
        .and_then(|token| token.clone())
        .unwrap_or_else(|| PROXY_TOKEN_PREFIX.to_string())
}

#[cfg(test)]
pub(crate) fn proxy_token() -> String {
    PROXY_TOKEN_PREFIX.to_string()
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// Load the install's proxy token, creating it on first use, and make it the
/// token live configs are written with. Idempotent.
pub(crate) fn ensure_proxy_token(db: &Database) -> Result<String, AppError> {
    let existing = db
        .get_setting(TOKEN_SETTING_KEY)?
        .map(|token| token.trim().to_string())
        .filter(|token| is_proxy_token(token) && token != PROXY_TOKEN_PREFIX);
    let token = match existing {
        Some(token) => token,
        None => {
            let token = format!(
                "{PROXY_TOKEN_PREFIX}.{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            if db.is_live_takeover_active_sync() {
                db.set_setting(
                    LEGACY_UNTIL_SETTING_KEY,
                    &(unix_now() + LEGACY_GRACE_SECS).to_string(),
                )?;
            }
            db.set_setting(TOKEN_SETTING_KEY, &token)?;
            token
        }
    };
    #[cfg(not(test))]
    if let Ok(mut active) = ACTIVE_TOKEN.write() {
        *active = Some(token.clone());
    }
    Ok(token)
}

/// Whether the bare placeholder of older live configs is still accepted.
pub(crate) fn legacy_token_accepted(db: &Database) -> bool {
    db.get_setting(LEGACY_UNTIL_SETTING_KEY)
        .ok()
        .flatten()
        .and_then(|until| until.trim().parse::<i64>().ok())
        .is_some_and(|until| unix_now() < until)
}

/// How a request to a proxy endpoint is judged.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProxyAuth {
    Authorized,
    /// Authorized with the bare placeholder of a pre-token live config.
    LegacyPlaceholder,
    Rejected,
}

pub(crate) fn authorize(
    headers: &HeaderMap,
    query: Option<&str>,
    expected: &str,
    legacy_accepted: bool,
) -> ProxyAuth {
    // Gemini SDKs may send the key as `?key=` instead of a header.
    let query_key = query.and_then(|query| {
        query
            .split('&')
            .find_map(|pair| pair.strip_prefix("key="))
            .map(str::to_string)
    });
    let mut credentials = presented_credentials(headers);
    credentials.extend(query_key);

    // Compare everything so timing does not reveal which credential matched.
    let mut current = false;
    let mut legacy = false;
    for credential in &credentials {
        current |= tokens_match(credential, expected);
        legacy |= tokens_match(credential, PROXY_TOKEN_PREFIX);
    }
    if current {
        ProxyAuth::Authorized
    } else if legacy && legacy_accepted {
        ProxyAuth::LegacyPlaceholder
    } else {
        ProxyAuth::Rejected
    }
}

/// Whether a `Host` header names the loopback interface. A DNS-rebinding page
/// reaches the proxy under its own host name, which this refuses.
pub(crate) fn host_is_loopback(host: &str) -> bool {
    let host = host.trim();
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map_or(host, |(name, _port)| name)
    };
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    matches!(name.as_str(), "127.0.0.1" | "localhost" | "::1")
}

/// Constant-time equality of two token strings.
pub(crate) fn tokens_match(provided: &str, expected: &str) -> bool {
    provided.as_bytes().ct_eq(expected.as_bytes()).into()
}

/// Every credential the request presents, with any `Bearer` prefix removed.
///
/// An `Authorization` value without a prefix is treated as the token itself,
/// matching how lenient clients send it.
pub(crate) fn presented_credentials(headers: &HeaderMap) -> Vec<String> {
    let mut credentials = Vec::new();
    if let Some(value) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        let token = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .unwrap_or(value)
            .trim();
        credentials.push(token.to_string());
    }
    for name in ["x-api-key", "x-goog-api-key"] {
        if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
            credentials.push(value.trim().to_string());
        }
    }
    credentials
}

/// Whether any presented credential equals `expected`.
pub(crate) fn request_presents_token(headers: &HeaderMap, expected: &str) -> bool {
    // Compare every candidate so the work done does not depend on which
    // header carried the right value.
    presented_credentials(headers)
        .iter()
        .fold(false, |matched, credential| {
            matched | tokens_match(credential, expected)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        map
    }

    #[test]
    fn accepts_bearer_in_either_case_and_bare_authorization() {
        for value in ["Bearer ccs-token", "bearer ccs-token", "ccs-token"] {
            let map = headers(&[("authorization", value)]);
            assert_eq!(presented_credentials(&map), vec!["ccs-token".to_string()]);
            assert!(request_presents_token(&map, "ccs-token"));
        }
    }

    #[test]
    fn accepts_anthropic_and_gemini_key_headers() {
        assert!(request_presents_token(
            &headers(&[("x-api-key", "ccs-token")]),
            "ccs-token"
        ));
        assert!(request_presents_token(
            &headers(&[("x-goog-api-key", " ccs-token ")]),
            "ccs-token"
        ));
    }

    #[test]
    fn rejects_missing_wrong_and_prefix_only_credentials() {
        assert!(!request_presents_token(&HeaderMap::new(), "ccs-token"));
        assert!(!request_presents_token(
            &headers(&[("authorization", "Bearer other")]),
            "ccs-token"
        ));
        assert!(!request_presents_token(
            &headers(&[("authorization", "Bearer ccs-tok")]),
            "ccs-token"
        ));
        assert!(!request_presents_token(
            &headers(&[("authorization", "Bearer ")]),
            "ccs-token"
        ));
    }

    #[test]
    fn authorize_accepts_the_current_token_in_any_client_header() {
        let token = "PROXY_MANAGED.secret";
        for pairs in [
            vec![("authorization", "Bearer PROXY_MANAGED.secret")],
            vec![("x-api-key", "PROXY_MANAGED.secret")],
            vec![("x-goog-api-key", "PROXY_MANAGED.secret")],
        ] {
            assert_eq!(
                authorize(&headers(&pairs), None, token, false),
                ProxyAuth::Authorized
            );
        }
        assert_eq!(
            authorize(
                &HeaderMap::new(),
                Some("alt=sse&key=PROXY_MANAGED.secret"),
                token,
                false
            ),
            ProxyAuth::Authorized
        );
    }

    #[test]
    fn authorize_rejects_missing_wrong_and_foreign_credentials() {
        let token = "PROXY_MANAGED.secret";
        for pairs in [
            vec![],
            vec![("authorization", "Bearer PROXY_MANAGED.other")],
            vec![("authorization", "Bearer sk-real-provider-key")],
            vec![("x-api-key", "")],
        ] {
            assert_eq!(
                authorize(&headers(&pairs), None, token, true),
                ProxyAuth::Rejected,
                "{pairs:?}"
            );
        }
    }

    #[test]
    fn the_bare_placeholder_only_works_inside_the_grace_window() {
        let token = "PROXY_MANAGED.secret";
        let legacy = headers(&[("authorization", "Bearer PROXY_MANAGED")]);
        assert_eq!(
            authorize(&legacy, None, token, true),
            ProxyAuth::LegacyPlaceholder
        );
        assert_eq!(authorize(&legacy, None, token, false), ProxyAuth::Rejected);
    }

    #[test]
    fn only_loopback_host_names_are_served() {
        for host in [
            "127.0.0.1:15721",
            "localhost",
            "LOCALHOST:80",
            "[::1]:15721",
            "127.0.0.1",
        ] {
            assert!(host_is_loopback(host), "{host}");
        }
        for host in [
            "evil.example",
            "evil.example:15721",
            "127.0.0.1.evil.example",
            "10.0.0.5:15721",
            "",
        ] {
            assert!(!host_is_loopback(host), "{host}");
        }
    }

    #[test]
    fn the_token_is_created_once_and_the_grace_window_marks_upgrades() -> Result<(), AppError> {
        let fresh = Database::memory()?;
        let token = ensure_proxy_token(&fresh)?;
        assert!(is_proxy_token(&token) && token != PROXY_TOKEN_PREFIX);
        assert_eq!(ensure_proxy_token(&fresh)?, token);
        assert!(
            !legacy_token_accepted(&fresh),
            "a fresh install has no legacy clients"
        );

        let upgraded = Database::memory()?;
        {
            let conn = crate::database::lock_conn!(upgraded.conn);
            conn.execute(
                "INSERT OR REPLACE INTO proxy_config (app_type, enabled) VALUES ('codex', 1)",
                [],
            )?;
        }
        ensure_proxy_token(&upgraded)?;
        assert!(
            legacy_token_accepted(&upgraded),
            "taken-over clients keep working for a while"
        );
        Ok(())
    }

    #[test]
    fn a_correct_key_header_wins_over_a_wrong_authorization_header() {
        let map = headers(&[
            ("authorization", "Bearer wrong"),
            ("x-api-key", "ccs-token"),
        ]);
        assert!(request_presents_token(&map, "ccs-token"));
    }
}
