//! What a proxy-issued token looks like, kept free of dependencies so the
//! config readers and writers can recognise one without reaching into the proxy.

/// Every token the local proxy hands to a client starts with this marker.
/// Live configs written before the per-install token carried exactly this text.
pub(crate) const PROXY_TOKEN_PREFIX: &str = "PROXY_MANAGED";

/// Whether `value` is a proxy-issued token (or the bare placeholder older
/// versions wrote) rather than a real provider credential.
pub(crate) fn is_proxy_token(value: &str) -> bool {
    value == PROXY_TOKEN_PREFIX
        || value
            .strip_prefix(PROXY_TOKEN_PREFIX)
            .and_then(|rest| rest.strip_prefix('.'))
            .is_some_and(|secret| !secret.is_empty())
}

#[cfg(test)]
mod tests {
    use super::is_proxy_token;

    #[test]
    fn proxy_tokens_are_recognised_but_real_keys_are_not() {
        assert!(is_proxy_token("PROXY_MANAGED"));
        assert!(is_proxy_token("PROXY_MANAGED.0123abcd"));
        for value in [
            "",
            "PROXY_MANAGED.",
            "PROXY_MANAGED_X",
            "sk-real",
            "xPROXY_MANAGED",
        ] {
            assert!(!is_proxy_token(value), "{value}");
        }
    }
}
