//! Read-only access to a Claude Desktop profile's sign-in, so its plan and
//! quota can be shown. Nothing here writes to the profile or refreshes its
//! tokens: refreshing rotates the refresh token, and Claude Desktop would be
//! signed out. An expired token is reported and left for the app to renew.
//!
//! Claude Desktop keeps its tokens the way Chromium apps do: `config.json`
//! holds `oauth:tokenCacheV2`, base64 of `v10` + ciphertext. On Windows the
//! AES-256-GCM key sits in the profile's `Local State`
//! (`os_crypt.encrypted_key`, `DPAPI` + a DPAPI blob of the current user);
//! the ciphertext is a 12-byte nonce, the data and a 16-byte tag. The cache
//! is a map from `<accountUuid>:<orgUuid>:<audience>:<scopes>` to a token
//! record; its format is the app's own and every failure here is soft.
//!
//! Adapted from Nemo-Illusionist/claude-code-account-switcher bb3446ab
//! (src/desktop_auth.rs: cache parsing and token choice; that version reads
//! the macOS Keychain, which prompts, so other systems are not read here).

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::strip_bom;
use crate::security_limits::read_to_string_limited;

const MAX_DESKTOP_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// One token of the cache. Deliberately not `Debug`: it holds a token.
#[derive(Clone)]
pub(crate) struct DesktopToken {
    pub token: String,
    pub has_profile_scope: bool,
    pub expires_at_ms: Option<i64>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

pub(crate) enum TokenRead {
    Ok(DesktopToken),
    /// No token cache in the profile.
    NotSignedIn,
    /// Every token is past its expiry; opening Claude Desktop renews them.
    Expired {
        plan: Option<String>,
    },
    /// The cache could not be decrypted or parsed (another user's profile,
    /// a changed format), or this system is not supported.
    Unreadable,
}

/// Every token record with a non-empty token.
pub(crate) fn parse_cache(plain: &str) -> Vec<DesktopToken> {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(plain) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(key, value)| {
            let token = value.get("token")?.as_str()?;
            if token.is_empty() {
                return None;
            }
            let text = |field: &str| {
                value
                    .get(field)
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string)
            };
            Some(DesktopToken {
                token: token.to_string(),
                has_profile_scope: key.contains("user:profile"),
                expires_at_ms: value.get("expiresAt").and_then(Value::as_i64),
                subscription_type: text("subscriptionType"),
                rate_limit_tier: text("rateLimitTier"),
            })
        })
        .collect()
}

/// The token to read with: unexpired, preferring one with `user:profile`
/// (the usage and profile endpoints need it). No expiry counts as usable.
pub(crate) fn pick(entries: &[DesktopToken], now_ms: i64) -> Option<&DesktopToken> {
    let fresh = |entry: &&DesktopToken| entry.expires_at_ms.is_none_or(|at| at > now_ms);
    entries
        .iter()
        .filter(fresh)
        .find(|entry| entry.has_profile_scope)
        .or_else(|| entries.iter().find(fresh))
}

/// Plan from the token record: `rateLimitTier` tells Max 5x from 20x,
/// `subscriptionType` the rest.
pub(crate) fn plan_of(entry: &DesktopToken) -> Option<String> {
    let tier = entry.rate_limit_tier.as_deref().unwrap_or_default();
    if tier.contains("max_20x") {
        return Some("Max 20x".to_string());
    }
    if tier.contains("max_5x") {
        return Some("Max 5x".to_string());
    }
    super::plan_label(None, entry.subscription_type.as_deref()).map(str::to_string)
}

fn token_blob(user_data: &Path) -> Option<Vec<u8>> {
    use base64::Engine;
    let text =
        read_to_string_limited(&user_data.join("config.json"), MAX_DESKTOP_FILE_BYTES).ok()?;
    let json: Value = serde_json::from_str(strip_bom(&text)).ok()?;
    let cache = ["oauth:tokenCacheV2", "oauth:tokenCache"]
        .iter()
        .find_map(|key| {
            json.get(*key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
        })?;
    base64::engine::general_purpose::STANDARD.decode(cache).ok()
}

#[cfg(windows)]
fn decrypt(user_data: &Path, blob: &[u8]) -> Option<String> {
    use base64::Engine;
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};

    let text =
        read_to_string_limited(&user_data.join("Local State"), MAX_DESKTOP_FILE_BYTES).ok()?;
    let state: Value = serde_json::from_str(strip_bom(&text)).ok()?;
    let sealed = base64::engine::general_purpose::STANDARD
        .decode(state.pointer("/os_crypt/encrypted_key")?.as_str()?)
        .ok()?;
    let mut key =
        crate::codex_accounts::vault::win::unprotect(sealed.strip_prefix(b"DPAPI")?).ok()?;
    let body = blob.strip_prefix(b"v10")?;
    if body.len() < NONCE_LEN + AES_256_GCM.tag_len() {
        return None;
    }
    let (nonce, sealed_data) = body.split_at(NONCE_LEN);
    let opened = UnboundKey::new(&AES_256_GCM, &key)
        .ok()
        .and_then(|unbound| {
            let mut data = sealed_data.to_vec();
            let nonce = Nonce::try_assume_unique_for_key(nonce).ok()?;
            let plain = LessSafeKey::new(unbound)
                .open_in_place(nonce, Aad::empty(), &mut data)
                .ok()?;
            String::from_utf8(plain.to_vec()).ok()
        });
    key.fill(0);
    opened
}

#[cfg(not(windows))]
fn decrypt(_user_data: &Path, _blob: &[u8]) -> Option<String> {
    None
}

/// Whether this system can read Desktop tokens at all.
pub(crate) fn supported() -> bool {
    cfg!(windows)
}

pub(crate) fn read_token(user_data: &Path, now_ms: i64) -> TokenRead {
    let Some(blob) = token_blob(user_data) else {
        return TokenRead::NotSignedIn;
    };
    let Some(plain) = decrypt(user_data, &blob) else {
        return TokenRead::Unreadable;
    };
    let entries = parse_cache(&plain);
    if entries.is_empty() {
        return TokenRead::Unreadable;
    }
    match pick(&entries, now_ms) {
        Some(entry) => TokenRead::Ok(entry.clone()),
        None => TokenRead::Expired {
            plan: entries.first().and_then(plan_of),
        },
    }
}

/// Claude Desktop's own (default) data folder. A Microsoft Store install
/// may keep it in the package's redirected AppData; the one whose
/// `config.json` changed last is the one in use.
pub(crate) fn default_user_data_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(roaming) = dirs::config_dir() {
        candidates.push(roaming.join("Claude"));
    }
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        if let Ok(entries) = crate::security_limits::read_dir_without_links(&local.join("Packages"))
        {
            for entry in entries {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("Claude_") || name.starts_with("AnthropicPBC.Claude_") {
                    candidates.push(
                        entry
                            .path()
                            .join("LocalCache")
                            .join("Roaming")
                            .join("Claude"),
                    );
                }
            }
        }
    }
    candidates
        .into_iter()
        .filter_map(|dir| {
            let modified = std::fs::metadata(dir.join("config.json"))
                .ok()?
                .modified()
                .ok()?;
            Some((modified, dir))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, dir)| dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CACHE: &str = r#"{
        "acc:org:aud:user:inference": {"token": "t-inf", "expiresAt": 2000, "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"},
        "acc:org:aud:user:inference user:profile": {"token": "t-prof", "expiresAt": 2000, "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"},
        "acc:org:aud:user:empty": {"token": ""}
    }"#;

    #[test]
    fn the_profile_scoped_unexpired_token_is_chosen() {
        let entries = parse_cache(CACHE);
        assert_eq!(entries.len(), 2);
        assert_eq!(pick(&entries, 1000).unwrap().token, "t-prof");
        assert!(pick(&entries, 3000).is_none());
        assert_eq!(plan_of(&entries[0]).as_deref(), Some("Max 20x"));
    }

    #[test]
    fn unexpected_shapes_read_as_nothing() {
        assert!(parse_cache("not json").is_empty());
        assert!(parse_cache("[1,2]").is_empty());
        assert!(parse_cache(r#"{"k": {"token": 3}}"#).is_empty());
    }

    #[test]
    fn plans_come_from_the_tier_then_the_subscription() {
        let entry = |tier: Option<&str>, sub: Option<&str>| DesktopToken {
            token: "t".into(),
            has_profile_scope: true,
            expires_at_ms: None,
            subscription_type: sub.map(str::to_string),
            rate_limit_tier: tier.map(str::to_string),
        };
        assert_eq!(
            plan_of(&entry(Some("default_claude_max_5x"), Some("max"))).as_deref(),
            Some("Max 5x")
        );
        assert_eq!(
            plan_of(&entry(Some("default_claude_ai"), Some("pro"))).as_deref(),
            Some("Pro")
        );
        assert_eq!(plan_of(&entry(None, None)), None);
    }

    #[test]
    fn a_profile_without_a_cache_is_not_signed_in() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), r#"{"locale":"zh-CN"}"#).unwrap();
        assert!(matches!(read_token(dir.path(), 0), TokenRead::NotSignedIn));
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"oauth:tokenCacheV2":"djEwAAAA"}"#,
        )
        .unwrap();
        assert!(matches!(read_token(dir.path(), 0), TokenRead::Unreadable));
    }

    #[cfg(windows)]
    #[test]
    fn a_chromium_v10_cache_decrypts_with_the_dpapi_sealed_key() {
        use base64::Engine;
        use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
        let b64 = base64::engine::general_purpose::STANDARD;
        let dir = tempfile::tempdir().unwrap();
        let key = [7u8; 32];
        let mut sealed_key = b"DPAPI".to_vec();
        sealed_key.extend(crate::codex_accounts::vault::win::protect(&key).unwrap());
        std::fs::write(
            dir.path().join("Local State"),
            serde_json::json!({"os_crypt": {"encrypted_key": b64.encode(sealed_key)}}).to_string(),
        )
        .unwrap();
        let nonce = [9u8; 12];
        let mut data = CACHE.as_bytes().to_vec();
        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key).unwrap())
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut data)
            .unwrap();
        let mut blob = b"v10".to_vec();
        blob.extend(nonce);
        blob.extend(data);
        std::fs::write(
            dir.path().join("config.json"),
            serde_json::json!({"oauth:tokenCacheV2": b64.encode(blob)}).to_string(),
        )
        .unwrap();
        match read_token(dir.path(), 1000) {
            TokenRead::Ok(entry) => assert_eq!(entry.token, "t-prof"),
            _ => panic!("expected a token"),
        }
        assert!(matches!(
            read_token(dir.path(), 3000),
            TokenRead::Expired { .. }
        ));
    }
}
