//! Single source of truth for the upstream URL of a Codex request.
//!
//! The protocol probe used to derive its candidate URLs with one set of rules
//! and the forwarder built the real request URL with another. Wherever the two
//! disagreed (`/anthropic` bases, custom prefixes like `/api` or `/coding`,
//! bases that already end in the endpoint, bases carrying a `?query`), the probe
//! could confirm a protocol against a URL the router would never actually call,
//! and the saved line failed on its first real request. Every Codex URL now
//! goes through [`codex_upstream_url`], so a probe result is by construction a
//! statement about the URL that will be used.

use url::Url;

/// How the local router talks to a Codex line's upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CodexUpstreamProtocol {
    /// Responses API forwarded as-is.
    Native,
    /// Responses converted to Chat Completions.
    Chat,
    /// Responses converted to Anthropic Messages.
    Anthropic,
}

impl CodexUpstreamProtocol {
    #[cfg(test)]
    pub const ALL: [Self; 3] = [Self::Native, Self::Chat, Self::Anthropic];

    /// The `api_format` value stored on a provider for this protocol.
    pub fn api_format(self) -> &'static str {
        match self {
            Self::Native => "openai_responses",
            Self::Chat => "openai_chat",
            Self::Anthropic => "anthropic",
        }
    }

    /// The endpoint the router requests for this protocol. Codex itself posts
    /// to `/v1/responses`; the two conversion targets are fixed by their APIs.
    pub fn endpoint(self) -> &'static str {
        match self {
            Self::Native => "/v1/responses",
            Self::Chat => "/chat/completions",
            Self::Anthropic => "/v1/messages",
        }
    }

    /// A base URL already ending in this suffix is treated as the complete
    /// endpoint even when the "full URL" switch is off, so pasting
    /// `.../v1/messages` does not become `.../v1/messages/v1/messages`.
    /// Native Responses has no such fallback: its bases end in `/v1`, and a
    /// literal `/responses` suffix is what the full-URL switch is for.
    fn full_endpoint_suffix(self) -> Option<&'static str> {
        match self {
            Self::Native => None,
            Self::Chat => Some("/chat/completions"),
            Self::Anthropic => Some("/v1/messages"),
        }
    }
}

/// Resolve the exact upstream URL for a Codex request.
///
/// `endpoint` is the path the router wants to reach, optionally carrying a
/// query string; use [`CodexUpstreamProtocol::endpoint`] unless the request
/// targets a sibling like `/v1/responses/compact`. Query parameters on the
/// base URL are kept (gateways use them for tenant selection) and the
/// endpoint's query is appended after them.
pub fn codex_upstream_url(
    base_url: &str,
    is_full_url: bool,
    protocol: CodexUpstreamProtocol,
    endpoint: &str,
) -> Result<Url, String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Err("Base URL is empty".to_string());
    }
    let mut url = Url::parse(trimmed).map_err(|error| format!("Invalid base URL: {error}"))?;
    if url.host_str().is_none() || !matches!(url.scheme(), "http" | "https") {
        return Err("Base URL must be an http(s) URL".to_string());
    }

    let (endpoint_path, endpoint_query) = match endpoint.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (endpoint, None),
    };

    let base_path = url.path().trim_end_matches('/').to_string();
    let base_is_full_endpoint = protocol
        .full_endpoint_suffix()
        .is_some_and(|suffix| base_path.to_ascii_lowercase().ends_with(suffix));

    if matches!(endpoint_path, "/images/generations" | "/images/edits") {
        let lower_path = base_path.to_ascii_lowercase();
        let source_suffix = [
            "/responses/compact",
            "/responses",
            "/chat/completions",
            "/messages",
            "/images/generations",
            "/images/edits",
        ]
        .into_iter()
        .find(|suffix| lower_path.ends_with(suffix));
        if let Some(suffix) = source_suffix {
            url.set_path(&format!(
                "{}{endpoint_path}",
                &base_path[..base_path.len() - suffix.len()]
            ));
        } else if is_full_url {
            return Err("Cannot derive Images endpoint from an opaque full URL".to_string());
        } else {
            url.set_path(&join_codex_path(&base_path, endpoint_path));
        }
        url.set_fragment(None);
    } else if !(is_full_url || base_is_full_endpoint) {
        url.set_path(&join_codex_path(&base_path, endpoint_path));
    }

    if let Some(query) = endpoint_query.filter(|query| !query.is_empty()) {
        let merged = match url.query() {
            Some(existing) if !existing.is_empty() => format!("{existing}&{query}"),
            _ => query.to_string(),
        };
        url.set_query(Some(&merged));
    }
    Ok(url)
}

/// Join a base path and an endpoint the way Codex-compatible gateways expect:
/// a bare origin gets `/v1`, a base already ending in `/v1` is used as-is, and
/// any other prefix (`/openai`, `/api`, `/coding`, `/paas/v4`) is kept verbatim
/// with the endpoint appended directly. A trailing `/V1` is normalised so it
/// is recognised as the version segment rather than a custom prefix.
fn join_codex_path(base_path: &str, endpoint_path: &str) -> String {
    let endpoint = endpoint_path.trim_start_matches('/');
    let base = match base_path.rsplit_once('/') {
        Some((parent, last)) if last.eq_ignore_ascii_case("v1") => format!("{parent}/v1"),
        _ => base_path.to_string(),
    };
    let mut path = if base.is_empty() {
        format!("/v1/{endpoint}")
    } else {
        format!("{base}/{endpoint}")
    };
    while path.contains("/v1/v1") {
        path = path.replace("/v1/v1", "/v1");
    }
    path
}

#[cfg(test)]
mod tests {
    #[test]
    fn image_siblings_preserve_prefix_query_and_ignore_suffix_case() {
        for suffix in [
            "responses",
            "responses/compact",
            "CHAT/completions",
            "messages",
            "images/generations",
            "images/edits",
        ] {
            for full in [true, false] {
                for endpoint in ["/images/generations", "/images/edits"] {
                    let base = format!("https://example.com/custom/v1/{suffix}?tenant=a#fragment");
                    let result =
                        codex_upstream_url(&base, full, CodexUpstreamProtocol::Native, endpoint)
                            .unwrap();
                    assert_eq!(
                        result.as_str(),
                        format!("https://example.com/custom/v1{endpoint}?tenant=a")
                    );
                }
            }
        }
        assert!(codex_upstream_url(
            "https://example.com/opaque",
            true,
            CodexUpstreamProtocol::Native,
            "/images/edits"
        )
        .is_err());
        assert_eq!(
            codex_upstream_url(
                "https://example.com",
                false,
                CodexUpstreamProtocol::Native,
                "/images/generations"
            )
            .unwrap()
            .as_str(),
            "https://example.com/v1/images/generations"
        );
    }

    use super::*;

    fn resolve(base: &str, full: bool, protocol: CodexUpstreamProtocol) -> String {
        codex_upstream_url(base, full, protocol, protocol.endpoint())
            .unwrap()
            .to_string()
    }

    #[test]
    fn origin_only_base_gets_v1_for_every_protocol() {
        assert_eq!(
            resolve(
                "https://api.openai.com",
                false,
                CodexUpstreamProtocol::Native
            ),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            resolve(
                "https://api.openai.com/",
                false,
                CodexUpstreamProtocol::Chat
            ),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            resolve(
                "https://api.openai.com",
                false,
                CodexUpstreamProtocol::Anthropic
            ),
            "https://api.openai.com/v1/messages"
        );
    }

    #[test]
    fn base_ending_in_v1_is_not_doubled() {
        assert_eq!(
            resolve(
                "https://api.openai.com/v1",
                false,
                CodexUpstreamProtocol::Native
            ),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            resolve(
                "https://api.openai.com/v1/",
                false,
                CodexUpstreamProtocol::Anthropic
            ),
            "https://api.openai.com/v1/messages"
        );
        assert_eq!(
            resolve(
                "https://api.openai.com/v1",
                false,
                CodexUpstreamProtocol::Chat
            ),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn uppercase_v1_is_treated_as_the_version_segment() {
        assert_eq!(
            resolve(
                "https://relay.example/V1",
                false,
                CodexUpstreamProtocol::Native
            ),
            "https://relay.example/v1/responses"
        );
    }

    #[test]
    fn custom_prefixes_keep_the_prefix_and_never_insert_v1() {
        // Anthropic-compatible sub-paths: DeepSeek, Zhipu, MiniMax.
        assert_eq!(
            resolve(
                "https://api.deepseek.com/anthropic",
                false,
                CodexUpstreamProtocol::Anthropic
            ),
            "https://api.deepseek.com/anthropic/v1/messages"
        );
        assert_eq!(
            resolve(
                "https://relay.example/claudecode",
                false,
                CodexUpstreamProtocol::Anthropic
            ),
            "https://relay.example/claudecode/v1/messages"
        );
        // Versioned prefixes that are not `/v1`.
        assert_eq!(
            resolve(
                "https://open.bigmodel.cn/api/paas/v4",
                false,
                CodexUpstreamProtocol::Chat
            ),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
        assert_eq!(
            resolve(
                "https://ark.cn-beijing.volces.com/api/v3",
                false,
                CodexUpstreamProtocol::Chat
            ),
            "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
        );
        // Plain custom prefixes.
        for base in [
            "https://relay.example/api",
            "https://api.kimi.com/coding",
            "https://qianfan.example/v2/coding",
            "https://gateway.example/compat",
            "https://openrouter.ai/api",
            "https://relay.example/openai",
        ] {
            let chat = resolve(base, false, CodexUpstreamProtocol::Chat);
            assert_eq!(chat, format!("{base}/chat/completions"), "{base}");
            let native = resolve(base, false, CodexUpstreamProtocol::Native);
            assert_eq!(native, format!("{base}/v1/responses"), "{base}");
        }
        assert_eq!(
            resolve(
                "https://chatgpt.com/backend-api/codex",
                false,
                CodexUpstreamProtocol::Native
            ),
            "https://chatgpt.com/backend-api/codex/v1/responses"
        );
    }

    #[test]
    fn full_url_is_used_verbatim_for_every_protocol() {
        for protocol in CodexUpstreamProtocol::ALL {
            assert_eq!(
                resolve("https://relay.example/custom/path", true, protocol),
                "https://relay.example/custom/path"
            );
        }
    }

    #[test]
    fn base_already_ending_in_conversion_endpoint_is_not_doubled() {
        assert_eq!(
            resolve(
                "https://relay.example/v1/messages",
                false,
                CodexUpstreamProtocol::Anthropic
            ),
            "https://relay.example/v1/messages"
        );
        assert_eq!(
            resolve(
                "https://relay.example/api/v1/messages/",
                false,
                CodexUpstreamProtocol::Anthropic
            ),
            "https://relay.example/api/v1/messages/"
        );
        assert_eq!(
            resolve(
                "https://relay.example/v1/chat/completions",
                false,
                CodexUpstreamProtocol::Chat
            ),
            "https://relay.example/v1/chat/completions"
        );
        // The Native protocol has no such fallback.
        assert_eq!(
            resolve(
                "https://relay.example/v1/responses",
                false,
                CodexUpstreamProtocol::Native
            ),
            "https://relay.example/v1/responses/v1/responses"
        );
    }

    #[test]
    fn base_query_is_kept_and_endpoint_query_is_appended() {
        assert_eq!(
            resolve(
                "https://relay.example/v1?tenant=a",
                false,
                CodexUpstreamProtocol::Native
            ),
            "https://relay.example/v1/responses?tenant=a"
        );
        let with_query = codex_upstream_url(
            "https://relay.example/v1?tenant=a",
            false,
            CodexUpstreamProtocol::Chat,
            "/chat/completions?beta=1",
        )
        .unwrap();
        assert_eq!(
            with_query.to_string(),
            "https://relay.example/v1/chat/completions?tenant=a&beta=1"
        );
        let full_with_query = codex_upstream_url(
            "https://relay.example/x?tenant=a",
            true,
            CodexUpstreamProtocol::Native,
            "/v1/responses?beta=1",
        )
        .unwrap();
        assert_eq!(
            full_with_query.to_string(),
            "https://relay.example/x?tenant=a&beta=1"
        );
    }

    #[test]
    fn sibling_endpoints_follow_the_same_rules() {
        let compact = codex_upstream_url(
            "https://relay.example/api",
            false,
            CodexUpstreamProtocol::Native,
            "/v1/responses/compact",
        )
        .unwrap();
        assert_eq!(
            compact.to_string(),
            "https://relay.example/api/v1/responses/compact"
        );
    }

    #[test]
    fn rejects_non_http_and_empty_bases() {
        assert!(
            codex_upstream_url("", false, CodexUpstreamProtocol::Native, "/v1/responses").is_err()
        );
        assert!(codex_upstream_url(
            "ftp://relay.example",
            false,
            CodexUpstreamProtocol::Native,
            "/v1/responses"
        )
        .is_err());
        assert!(codex_upstream_url(
            "not a url",
            false,
            CodexUpstreamProtocol::Native,
            "/v1/responses"
        )
        .is_err());
    }
}
