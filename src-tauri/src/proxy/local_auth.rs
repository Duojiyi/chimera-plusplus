//! Shared credential handling for the local proxy's own endpoints.
//!
//! Clients present the proxy token in whichever header their SDK uses:
//! `Authorization: Bearer …` (OpenAI / Codex), `x-api-key` (Anthropic) or
//! `x-goog-api-key` (Gemini). Comparison is constant-time so a local process
//! cannot recover a token byte by byte from response timing.

use axum::http::{header::AUTHORIZATION, HeaderMap};
use subtle::ConstantTimeEq;

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
    fn a_correct_key_header_wins_over_a_wrong_authorization_header() {
        let map = headers(&[
            ("authorization", "Bearer wrong"),
            ("x-api-key", "ccs-token"),
        ]);
        assert!(request_presents_token(&map, "ccs-token"));
    }
}
