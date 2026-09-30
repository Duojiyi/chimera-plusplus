// Adapted from yynxxxxx/Codex-X apps/desktop/src-tauri/src/providers/official_auth.rs and official_profiles.rs (MIT)
//! Login classification, ChatGPT account identity and display metadata for
//! Codex `auth.json` values.
//!
//! JWT claims are decoded without verification. They are only used to tell
//! which account a login belongs to and what to show; they never grant
//! anything.

use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// Largest JWT payload segment decoded (Codex-X bound).
const MAX_JWT_PAYLOAD_CHARS: usize = 32 * 1024;
const AUTH_CLAIMS: &str = "/https:~1~1api.openai.com~1auth";

/// A `last_refresh` further than this many seconds in the future is refused:
/// it would win every freshness comparison forever.
const MAX_CLOCK_SKEW_SECS: i64 = 5 * 60;

fn value_has_material(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(values) => values.iter().any(value_has_material),
        Value::Object(values) => values.values().any(value_has_material),
        Value::Bool(_) | Value::Number(_) => true,
    }
}

pub(crate) fn auth_value_has_material(value: &Value) -> bool {
    value.as_object().is_some_and(|auth| {
        auth.iter()
            .filter(|(key, _)| key.as_str() != "auth_mode")
            .any(|(_, value)| value_has_material(value))
    })
}

/// Login-type classifier: whether `value` is an official ChatGPT-family login
/// (ChatGPT tokens, agent identity or personal access token) as Codex's
/// `AuthDotJson::resolved_mode` reads it. API keys and Bedrock are not.
pub(crate) fn is_chatgpt_auth(value: &Value) -> bool {
    let mode = value.get("auth_mode").and_then(Value::as_str);
    let has_api_key = value
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty());
    let has_bedrock_key = value.get("bedrock_api_key").is_some_and(value_has_material);
    if has_api_key || has_bedrock_key {
        return false;
    }

    let has_tokens = value
        .get("tokens")
        .and_then(Value::as_object)
        .is_some_and(|tokens| {
            ["access_token", "refresh_token", "id_token"]
                .iter()
                .any(|key| {
                    tokens
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|token| !token.trim().is_empty())
                })
        });
    let has_agent_identity = value.get("agent_identity").is_some_and(|identity| {
        identity.as_str().is_some_and(|jwt| !jwt.trim().is_empty())
            || identity.as_object().is_some_and(|record| {
                ["agent_runtime_id", "agent_private_key"].iter().all(|key| {
                    record
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
                })
            })
    });
    let has_personal_access_token = value
        .get("personal_access_token")
        .and_then(Value::as_str)
        .is_some_and(|token| !token.trim().is_empty());

    match mode {
        // Legacy token files default to ChatGPT, PAT infers its own mode;
        // agent identity needs an explicit auth_mode.
        None => has_tokens || has_personal_access_token,
        Some(mode)
            if mode.eq_ignore_ascii_case("chatgpt")
                || mode.eq_ignore_ascii_case("chatgptAuthTokens") =>
        {
            has_tokens
        }
        Some(mode) if mode.eq_ignore_ascii_case("agentIdentity") => has_agent_identity,
        Some(mode) if mode.eq_ignore_ascii_case("personalAccessToken") => has_personal_access_token,
        Some(_) => false,
    }
}

fn nonempty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn display_email(value: Option<&Value>) -> Option<String> {
    nonempty_string(value).filter(|email| {
        email.len() <= 320
            && email.contains('@')
            && !email
                .chars()
                .any(|character| character.is_control() || character.is_whitespace())
    })
}

/// Bounded, unverified JWT payload decode.
pub(crate) fn jwt_claims(token: Option<&Value>) -> Option<Value> {
    let token = token?.as_str()?;
    let mut parts = token.split('.');
    let header = parts.next()?;
    let payload = parts.next()?;
    let signature = parts.next()?;
    if header.is_empty()
        || payload.is_empty()
        || signature.is_empty()
        || parts.next().is_some()
        || payload.len() > MAX_JWT_PAYLOAD_CHARS
    {
        return None;
    }
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&payload).ok()?;
    claims.is_object().then_some(claims)
}

pub(crate) fn display_plan_type(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    if raw.len() > 64 || raw.chars().any(char::is_control) {
        return None;
    }
    let plan = raw.trim();
    (!plan.is_empty()
        && plan
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
    .then(|| plan.to_string())
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct DisplayMetadata {
    pub email: Option<String>,
    pub plan_type: Option<String>,
}

/// Email and plan for display, from top-level fields first, then the
/// id_token and access_token claims.
pub(crate) fn auth_display_metadata(auth: &Value) -> DisplayMetadata {
    let chatgpt_auth = is_chatgpt_auth(auth);
    let mut metadata = DisplayMetadata {
        email: display_email(auth.get("email")),
        plan_type: chatgpt_auth
            .then(|| {
                display_plan_type(auth.get("plan_type"))
                    .or_else(|| display_plan_type(auth.get("chatgpt_plan_type")))
            })
            .flatten(),
    };
    for token in [
        auth.pointer("/tokens/id_token"),
        auth.pointer("/tokens/access_token"),
    ] {
        if metadata.email.is_some() && (metadata.plan_type.is_some() || !chatgpt_auth) {
            break;
        }
        let Some(claims) = jwt_claims(token) else {
            continue;
        };
        metadata.email = metadata.email.or_else(|| {
            display_email(claims.get("email")).or_else(|| {
                display_email(claims.pointer("/https:~1~1api.openai.com~1profile/email"))
            })
        });
        if chatgpt_auth && metadata.plan_type.is_none() {
            metadata.plan_type =
                display_plan_type(claims.pointer(&format!("{AUTH_CLAIMS}/chatgpt_plan_type")));
        }
    }
    metadata
}

/// `li***@gmail.com`: what the account screens show instead of the address.
pub(crate) fn mask_email(email: &str) -> String {
    let (local, domain) = email.split_once('@').unwrap_or((email, ""));
    let keep = if local.chars().count() > 2 { 2 } else { 1 };
    let prefix: String = local.chars().take(keep).collect();
    format!("{prefix}***@{domain}")
}

pub(crate) fn normalize_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(AppError::localized(
            "official_accounts.name_invalid",
            "账号名称必须为 1–100 个字符",
            "Account names must be 1–100 characters",
        ));
    }
    Ok(name.to_string())
}

/// A ChatGPT account: (`chatgpt_user_id`, `chatgpt_account_id`). The account
/// id alone is a workspace, shared by every member of a Team.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct AccountIdentity {
    pub user_id: String,
    pub account_id: String,
}

impl AccountIdentity {
    /// Stable pseudonymous key: hex(sha256(len(user_id) ‖ user_id ‖ len(account_id) ‖ account_id)).
    pub fn key(&self) -> String {
        let mut digest = Sha256::new();
        digest.update((self.user_id.len() as u64).to_le_bytes());
        digest.update(self.user_id.as_bytes());
        digest.update((self.account_id.len() as u64).to_le_bytes());
        digest.update(self.account_id.as_bytes());
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

impl std::fmt::Debug for AccountIdentity {
    // Raw ids stay out of logs; the key is enough to correlate.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AccountIdentity({})", &self.key()[..12])
    }
}

/// What an `auth.json` value holds, as far as the account features care.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LoginClass {
    /// A complete ChatGPT login with a known, consistent identity.
    Chatgpt(AccountIdentity),
    /// ChatGPT tokens whose account ids disagree: a file mixed from two
    /// accounts (a refresh that landed across a switch). Never captured or
    /// applied.
    Conflict,
    /// ChatGPT tokens missing the id_token, refresh token or identity.
    Incomplete,
    /// API key, personal access token, agent identity, Bedrock, or a mode
    /// the account features do not manage.
    Other,
    Empty,
}

fn claim_string(claims: Option<&Value>, key: &str) -> Option<String> {
    nonempty_string(claims.and_then(|claims| claims.pointer(&format!("{AUTH_CLAIMS}/{key}"))))
}

pub(crate) fn classify(auth: &Value) -> LoginClass {
    if !auth_value_has_material(auth) {
        return LoginClass::Empty;
    }
    let mode = auth.get("auth_mode").and_then(Value::as_str);
    let chatgpt_mode = mode.is_none_or(|mode| {
        mode.eq_ignore_ascii_case("chatgpt") || mode.eq_ignore_ascii_case("chatgptAuthTokens")
    });
    if !is_chatgpt_auth(auth) || !chatgpt_mode || auth.get("tokens").is_none() {
        return LoginClass::Other;
    }

    let token = |name: &str| nonempty_string(auth.pointer(&format!("/tokens/{name}")));
    let id_claims = jwt_claims(auth.pointer("/tokens/id_token"));
    let access_claims = jwt_claims(auth.pointer("/tokens/access_token"));
    let file_account_id = token("account_id");
    let claimed_account_ids = [
        claim_string(id_claims.as_ref(), "chatgpt_account_id"),
        claim_string(access_claims.as_ref(), "chatgpt_account_id"),
    ];
    let mut known = claimed_account_ids
        .iter()
        .flatten()
        .chain(file_account_id.iter());
    if let Some(first) = known.next() {
        if known.any(|other| other != first) {
            return LoginClass::Conflict;
        }
    }

    if id_claims.is_none() || token("access_token").is_none() || token("refresh_token").is_none() {
        return LoginClass::Incomplete;
    }
    let user_id = claim_string(id_claims.as_ref(), "chatgpt_user_id")
        .or_else(|| claim_string(id_claims.as_ref(), "user_id"));
    let account_id = claimed_account_ids[0].clone().or(file_account_id);
    match (user_id, account_id) {
        (Some(user_id), Some(account_id)) => LoginClass::Chatgpt(AccountIdentity {
            user_id,
            account_id,
        }),
        _ => LoginClass::Incomplete,
    }
}

/// Whether `value` holds ChatGPT token material at all (complete or not).
pub(crate) fn has_chatgpt_tokens(value: &Value) -> bool {
    matches!(
        classify(value),
        LoginClass::Chatgpt(_) | LoginClass::Conflict | LoginClass::Incomplete
    )
}

pub(crate) fn last_refresh(auth: &Value) -> Option<DateTime<Utc>> {
    auth.get("last_refresh")
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|time| time.with_timezone(&Utc))
}

fn jwt_time(auth: &Value, token: &str, claim: &str) -> Option<i64> {
    jwt_claims(auth.pointer(&format!("/tokens/{token}")))?
        .get(claim)?
        .as_i64()
}

/// Access-token expiry (unix seconds), when the token is a readable JWT.
pub(crate) fn access_token_expires_at(auth: &Value) -> Option<i64> {
    jwt_time(auth, "access_token", "exp")
}

/// Freshness within one identity: `last_refresh`, then access-token `exp`,
/// then id_token `iat`; the first pair known on both sides decides. When
/// nothing is comparable the candidate wins: it is the newer observation.
pub(crate) fn is_at_least_as_fresh(candidate: &Value, current: &Value) -> bool {
    let ordered = [
        (
            last_refresh(candidate).map(|time| time.timestamp_millis()),
            last_refresh(current).map(|time| time.timestamp_millis()),
        ),
        (
            access_token_expires_at(candidate),
            access_token_expires_at(current),
        ),
        (
            jwt_time(candidate, "id_token", "iat"),
            jwt_time(current, "id_token", "iat"),
        ),
    ];
    ordered
        .into_iter()
        .find_map(|pair| match pair {
            (Some(candidate), Some(current)) => Some(candidate >= current),
            _ => None,
        })
        .unwrap_or(true)
}

pub(crate) fn last_refresh_is_in_future(auth: &Value, now: DateTime<Utc>) -> bool {
    if last_refresh(auth).is_some_and(|time| time > now + Duration::seconds(MAX_CLOCK_SKEW_SECS)) {
        return true;
    }
    if let Some(exp) = access_token_expires_at(auth) {
        if exp > (now + Duration::days(30)).timestamp() {
            return true;
        }
    }
    if let Some(iat) = jwt_time(auth, "id_token", "iat") {
        if iat > (now + Duration::seconds(MAX_CLOCK_SKEW_SECS)).timestamp() {
            return true;
        }
    }
    false
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use serde_json::json;

    pub(crate) fn jwt(claims: Value) -> String {
        format!(
            "e30.{}.fixture-signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
        )
    }

    /// A complete ChatGPT login for `label`: user `user-<label>`, account
    /// `acct-<label>`, tokens `access-<label>` / `refresh-<label>`.
    pub(crate) fn chatgpt_login(label: &str, last_refresh: &str) -> Value {
        json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": jwt(json!({
                    "email": format!("{label}@example.test"),
                    "https://api.openai.com/auth": {
                        "chatgpt_user_id": format!("user-{label}"),
                        "chatgpt_account_id": format!("acct-{label}"),
                        "chatgpt_plan_type": "pro"
                    }
                })),
                "access_token": format!("access-{label}"),
                "refresh_token": format!("refresh-{label}"),
                "account_id": format!("acct-{label}")
            },
            "last_refresh": last_refresh
        })
    }

    pub(crate) fn identity(label: &str) -> AccountIdentity {
        AccountIdentity {
            user_id: format!("user-{label}"),
            account_id: format!("acct-{label}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{chatgpt_login, identity, jwt};
    use super::*;
    use serde_json::json;

    // ACC-T1
    #[test]
    fn identity_comes_from_id_token_claims_and_a_mismatch_is_a_conflict() {
        let login = chatgpt_login("a", "2026-09-27T12:00:00Z");
        assert_eq!(classify(&login), LoginClass::Chatgpt(identity("a")));

        // `user_id` is Codex's fallback claim for the user.
        let mut fallback = login.clone();
        fallback["tokens"]["id_token"] = json!(jwt(json!({
            "https://api.openai.com/auth": {"user_id": "user-a", "chatgpt_account_id": "acct-a"}
        })));
        assert_eq!(classify(&fallback), LoginClass::Chatgpt(identity("a")));

        // A refresh that landed across a switch: tokens of one account, the
        // account id of another.
        let mut hybrid = login.clone();
        hybrid["tokens"]["account_id"] = json!("acct-b");
        assert_eq!(classify(&hybrid), LoginClass::Conflict);

        // Same user in another workspace is another account.
        let mut team = login.clone();
        team["tokens"]["id_token"] = json!(jwt(json!({
            "https://api.openai.com/auth": {"chatgpt_user_id": "user-a", "chatgpt_account_id": "acct-team"}
        })));
        team["tokens"]["account_id"] = json!("acct-team");
        let LoginClass::Chatgpt(team_identity) = classify(&team) else {
            panic!("team login should classify");
        };
        assert_ne!(team_identity.key(), identity("a").key());

        let mut no_refresh = login.clone();
        no_refresh["tokens"]["refresh_token"] = json!("");
        assert_eq!(classify(&no_refresh), LoginClass::Incomplete);
        let mut no_id_token = login;
        no_id_token["tokens"]["id_token"] = json!("not-a-jwt");
        assert_eq!(classify(&no_id_token), LoginClass::Incomplete);

        assert_eq!(classify(&json!({})), LoginClass::Empty);
        assert_eq!(
            classify(&json!({"auth_mode": "apikey", "OPENAI_API_KEY": "sk-test"})),
            LoginClass::Other
        );
    }

    #[test]
    fn account_key_is_stable_hex_and_debug_hides_raw_ids() {
        let key = identity("a").key();
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(key, identity("a").key());
        assert!(!format!("{:?}", identity("a")).contains("user-a"));
    }

    // ACC-T2 (port of Codex-X official_profiles.rs:981-1093)
    #[test]
    fn display_email_decodes_only_bounded_claims() {
        let mut auth = chatgpt_login("email", "2026-09-27T12:00:00Z");
        auth["tokens"]["id_token"] = json!(jwt(json!({"email": "id@example.test"})));
        auth["tokens"]["access_token"] = json!(jwt(
            json!({"https://api.openai.com/profile": {"email": "access@example.test"}})
        ));
        assert_eq!(
            auth_display_metadata(&auth).email.as_deref(),
            Some("id@example.test")
        );
        auth["email"] = json!(" direct@example.test ");
        assert_eq!(
            auth_display_metadata(&auth).email.as_deref(),
            Some("direct@example.test")
        );
        auth["email"] = json!("\n");
        auth["tokens"]["id_token"] = json!("invalid-token");
        assert_eq!(
            auth_display_metadata(&auth).email.as_deref(),
            Some("access@example.test")
        );
        auth["tokens"]["access_token"] = json!(format!("e30.{}.sig", "A".repeat(32769)));
        assert!(auth_display_metadata(&auth).email.is_none());
        auth["email"] = json!("unsafe\nemail@example.test");
        assert!(auth_display_metadata(&auth).email.is_none());
    }

    #[test]
    fn display_plan_uses_validated_fallbacks_and_rejects_unsafe_values() {
        let mut auth = chatgpt_login("plan", "2026-09-27T12:00:00Z");
        assert_eq!(
            auth_display_metadata(&auth).plan_type.as_deref(),
            Some("pro")
        );
        auth["plan_type"] = json!(" pro_lite ");
        assert_eq!(
            auth_display_metadata(&auth).plan_type.as_deref(),
            Some("pro_lite")
        );
        for value in [
            json!(""),
            json!("\npro"),
            json!("pro lite"),
            json!("pro\u{202e}lite"),
            json!("<script>"),
            json!("p".repeat(65)),
            json!(["pro"]),
        ] {
            let mut auth = chatgpt_login("bad", "2026-09-27T12:00:00Z");
            auth["plan_type"] = value.clone();
            auth["tokens"]["id_token"] = json!(jwt(json!({
                "https://api.openai.com/auth": {"chatgpt_plan_type": value}
            })));
            assert!(auth_display_metadata(&auth).plan_type.is_none());
        }
        let api_key = json!({"auth_mode": "apikey", "OPENAI_API_KEY": "sk-x", "plan_type": "pro"});
        assert!(auth_display_metadata(&api_key).plan_type.is_none());
    }

    #[test]
    fn masked_email_keeps_only_a_short_prefix_and_the_domain() {
        assert_eq!(mask_email("lin@gmail.com"), "li***@gmail.com");
        assert_eq!(mask_email("ab@acme.cn"), "a***@acme.cn");
    }

    // ACC-T3 (port of Codex-X official_auth.rs:1182-1223)
    #[test]
    fn login_type_classifier_matches_codex_resolved_modes() {
        assert!(is_chatgpt_auth(&json!({
            "OPENAI_API_KEY": null,
            "tokens": {"access_token": "legacy-access"}
        })));
        assert!(!is_chatgpt_auth(&json!({
            "auth_mode": "apikey",
            "tokens": {"access_token": "must-not-trust"}
        })));
        assert!(!is_chatgpt_auth(&json!({
            "tokens": {"access_token": "legacy-access"},
            "OPENAI_API_KEY": "sk-third-party"
        })));
        assert!(is_chatgpt_auth(&json!({
            "auth_mode": "agentIdentity",
            "agent_identity": {"agent_runtime_id": "runtime", "agent_private_key": "key"}
        })));
        assert!(is_chatgpt_auth(&json!({
            "auth_mode": "personalAccessToken",
            "personal_access_token": "pat-test"
        })));
        assert!(!is_chatgpt_auth(&json!({
            "auth_mode": "bedrockApiKey",
            "bedrock_api_key": {"api_key": "bedrock-test"}
        })));
        // Only ChatGPT token logins are accounts; the other official modes
        // are left to Codex untouched.
        for other in [
            json!({"auth_mode": "personalAccessToken", "personal_access_token": "pat"}),
            json!({"auth_mode": "agentIdentity", "agent_identity": "jwt"}),
        ] {
            assert_eq!(classify(&other), LoginClass::Other);
        }
    }

    // ACC-T4
    #[test]
    fn freshness_orders_last_refresh_then_expiry_and_defaults_to_the_candidate() {
        let older = chatgpt_login("a", "2026-09-01T00:00:00Z");
        let newer = chatgpt_login("a", "2026-09-20T00:00:00Z");
        assert!(is_at_least_as_fresh(&newer, &older));
        assert!(!is_at_least_as_fresh(&older, &newer));

        let mut expiring = older.clone();
        expiring.as_object_mut().unwrap().remove("last_refresh");
        let mut later = expiring.clone();
        expiring["tokens"]["access_token"] = json!(jwt(json!({"exp": 1_000})));
        later["tokens"]["access_token"] = json!(jwt(json!({"exp": 2_000})));
        assert!(is_at_least_as_fresh(&later, &expiring));
        assert!(!is_at_least_as_fresh(&expiring, &later));

        let mut unknown = older;
        unknown.as_object_mut().unwrap().remove("last_refresh");
        assert!(is_at_least_as_fresh(&unknown, &newer));
    }

    #[test]
    fn a_last_refresh_beyond_the_allowed_skew_is_in_the_future() {
        let now = DateTime::parse_from_rfc3339("2026-09-27T14:22:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(!last_refresh_is_in_future(
            &chatgpt_login("a", "2026-09-27T14:25:00Z"),
            now
        ));
        assert!(last_refresh_is_in_future(
            &chatgpt_login("a", "2026-09-27T14:40:00Z"),
            now
        ));
    }
}
