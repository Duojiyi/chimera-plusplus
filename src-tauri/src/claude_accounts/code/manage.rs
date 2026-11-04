//! What the saved logins are and how they are listed: tokens and keys that are
//! not a sign-in, which ones are held out of use, and their order.

use serde_json::json;

use super::*;

pub(super) const MAX_SECRET_LEN: usize = 2048;
const MIN_SECRET_LEN: usize = 20;
const SETUP_TOKEN_PREFIX: &str = "sk-ant-oat";
const REFRESH_TOKEN_PREFIX: &str = "sk-ant-ort";
const KEY_PREFIX: &str = "sk-ant-";
/// Setup-tokens are inference-only on the server; wider scopes would be refused.
const INFERENCE_SCOPE: &str = "user:inference";

pub(crate) const API_KEY_NAME: &str = "API Key 账号";
pub(crate) const SETUP_TOKEN_NAME: &str = "令牌账号";

/// A token or key given as text. Deliberately not `Debug`.
pub(crate) enum Secret {
    SetupToken(String),
    ApiKey(String),
}

impl Secret {
    pub(crate) fn value(&self) -> &str {
        match self {
            Secret::SetupToken(value) | Secret::ApiKey(value) => value,
        }
    }

    fn default_name(&self) -> &'static str {
        match self {
            Secret::SetupToken(_) => SETUP_TOKEN_NAME,
            Secret::ApiKey(_) => API_KEY_NAME,
        }
    }

    fn label(&self) -> &'static str {
        match self {
            Secret::SetupToken(_) => "令牌",
            Secret::ApiKey(_) => "密钥",
        }
    }
}

/// Letters, digits, `-` and `_`: what Anthropic tokens and keys are made of.
pub(super) fn secret_chars_ok(text: &str) -> bool {
    text.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// What `claude setup-token` or the Console gave, told apart by prefix: an
/// `sk-ant-oat…` token is OAuth, any other `sk-ant-…` value a Console key.
/// Nothing is sent anywhere to check it.
pub(crate) fn parse_secret(input: &str) -> Result<Secret, AppError> {
    let text = input.trim();
    let refuse = |message: &str| Err(AppError::InvalidInput(message.to_string()));
    if text.is_empty() {
        return refuse("请粘贴令牌或密钥");
    }
    if text.len() < MIN_SECRET_LEN || text.len() > MAX_SECRET_LEN {
        return refuse("长度不对，请确认复制的是完整的令牌或密钥");
    }
    if !secret_chars_ok(text) {
        return refuse("令牌或密钥里只能有字母、数字、- 和 _，请确认没有多复制空格或换行");
    }
    if text.starts_with(REFRESH_TOKEN_PREFIX) {
        return refuse("这是 refresh token，不能单独添加。请用 claude setup-token 生成长期令牌，或从浏览器授权添加");
    }
    if text.starts_with(SETUP_TOKEN_PREFIX) {
        return Ok(Secret::SetupToken(text.to_string()));
    }
    if text.starts_with(KEY_PREFIX) {
        return Ok(Secret::ApiKey(text.to_string()));
    }
    refuse("无法识别：令牌或密钥应以 sk-ant- 开头")
}

/// What Claude Code stores to remember an approved key: its last 20 characters.
pub(super) fn approved_form(key: &str) -> &str {
    match key.char_indices().rev().nth(19) {
        Some((start, _)) => &key[start..],
        None => key,
    }
}

/// A new saved login holding a token or key.
pub(super) fn new_secret_slot(
    vault: &CodeVault,
    name: String,
    secret: Secret,
) -> Result<Slot, AppError> {
    let mut slot = blank_slot(vault, name)?;
    match secret {
        Secret::SetupToken(token) => {
            slot.kind = SlotKind::SetupToken;
            slot.claude_ai_oauth = json!({ "accessToken": token, "scopes": [INFERENCE_SCOPE] });
        }
        Secret::ApiKey(key) => {
            slot.kind = SlotKind::ApiKey;
            slot.api_key = Some(key);
        }
    }
    Ok(slot)
}

/// Saves a pasted setup-token or Console API key as an account.
pub(crate) fn add_secret_in(
    vault: &CodeVault,
    name: Option<&str>,
    input: &str,
) -> Result<CodeAccountDto, AppError> {
    ensure_supported()?;
    let secret = parse_secret(input)?;
    let name = name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(normalize_account_name)
        .transpose()?
        .unwrap_or_else(|| secret.default_name().to_string());
    let fingerprint = secret_fingerprint(secret.value());
    let _guard = CODE_LOCK.lock()?;
    if vault
        .readable_slots()
        .iter()
        .any(|slot| slot.identity().fingerprint.as_deref() == Some(fingerprint.as_str()))
    {
        return Err(AppError::InvalidInput(format!(
            "这个{}已经保存过了",
            secret.label()
        )));
    }
    let slot = new_secret_slot(vault, name, secret)?;
    vault.write_slot(&slot)?;
    Ok(slot.dto(None))
}

pub(crate) fn disabled_error(slot: &Slot) -> AppError {
    AppError::Message(format!("「{}」已停用，请先启用它", slot.name))
}

/// Holds a login out of use, or puts it back. The login Claude Code is using
/// now cannot be held out: switch to another one first.
pub(crate) fn set_disabled_in(
    vault: &CodeVault,
    paths: &LivePaths,
    id: &str,
    disabled: bool,
) -> Result<(), AppError> {
    ensure_supported()?;
    let _guard = CODE_LOCK.lock()?;
    let mut slot = vault.read_slot(id)?;
    if slot.disabled == disabled {
        return Ok(());
    }
    if disabled {
        if sessions::is_running(vault, id) {
            return Err(sessions::running_error());
        }
        let live = read_live(paths)?;
        if live_holds(&live, &slot) {
            return Err(AppError::Message(
                "这个账号正是 Claude Code 现在使用的登录。先切换到别的账号，再停用它".to_string(),
            ));
        }
    }
    slot.disabled = disabled;
    slot.updated_at = now_rfc3339();
    vault.write_slot(&slot)
}

/// Puts the listed logins first, in the given order; the others follow in
/// the order they had.
pub(crate) fn reorder_in(vault: &CodeVault, ids: &[String]) -> Result<(), AppError> {
    for id in ids {
        crate::claude_accounts::validate_account_id(id)?;
    }
    let _guard = CODE_LOCK.lock()?;
    let current: Vec<String> = vault
        .readable_slots()
        .into_iter()
        .map(|slot| slot.id)
        .collect();
    let mut ordered: Vec<String> = Vec::with_capacity(current.len());
    for id in ids {
        if ordered.contains(id) {
            return Err(AppError::InvalidInput("排序里有重复的账号".to_string()));
        }
        if !current.contains(id) {
            return Err(AppError::InvalidInput("排序里有不存在的账号".to_string()));
        }
        ordered.push(id.clone());
    }
    ordered.extend(current.into_iter().filter(|id| !ids.contains(id)));
    for (index, id) in ordered.iter().enumerate() {
        let mut slot = vault.read_slot(id)?;
        let position = index as u64;
        if slot.position != Some(position) {
            slot.position = Some(position);
            vault.write_slot(&slot)?;
        }
    }
    Ok(())
}

// The vault saves no login on macOS (Claude Code keeps it in the keychain).
#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    use super::*;
    use crate::claude_accounts::code::tests::{fixture, login, Fixture};

    const KEY: &str = concat!(
        "sk-ant-api03-",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-xyz_1234567890"
    );
    const TOKEN: &str = concat!(
        "sk-ant-oat01-",
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB-xyz_1234567890"
    );

    fn saved(f: &Fixture, email: &str, uuid: &str, token: &str) -> String {
        login(&f.paths, email, uuid, token);
        save_current_in(&f.vault, &f.paths, None).unwrap().id
    }

    fn switch(f: &Fixture, id: &str) -> SwitchOutcome {
        switch_in(&f.vault, &f.paths, id, true, || false).unwrap()
    }

    fn live_json(f: &Fixture) -> Value {
        serde_json::from_str(&fs::read_to_string(&f.paths.claude_json).unwrap()).unwrap()
    }

    fn live_credentials(f: &Fixture) -> Value {
        serde_json::from_str(&fs::read_to_string(&f.paths.credentials).unwrap()).unwrap()
    }

    #[test]
    fn tokens_and_keys_are_told_apart_by_prefix_and_checked_for_shape() {
        assert!(matches!(parse_secret(TOKEN), Ok(Secret::SetupToken(_))));
        assert!(matches!(parse_secret(KEY), Ok(Secret::ApiKey(_))));
        assert!(matches!(
            parse_secret(&format!("  {KEY}\r\n")),
            Ok(Secret::ApiKey(_))
        ));
        assert!(matches!(
            parse_secret("sk-ant-usr-ZZZZZZZZZZZZZZZZZZZZZZZZ"),
            Ok(Secret::ApiKey(_))
        ));
        for (bad, why) in [
            ("", "empty"),
            ("sk-ant-short", "too short"),
            (
                "sk-ant-oat01-with space inside-AAAAAAAAAAAAAAAA",
                "whitespace",
            ),
            (
                "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA\nsk-ant-oat01-BBBBBBBB",
                "two lines",
            ),
            ("sk-ant-ort01-CCCCCCCCCCCCCCCCCCCCCCCCCCCC", "refresh token"),
            (
                "sk-openai-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
                "not anthropic",
            ),
            ("sk-ant-api03-ünïcödé-EEEEEEEEEEEEEEEEEEEEEEE", "non-ascii"),
        ] {
            assert!(parse_secret(bad).is_err(), "{why}");
        }
        let too_long = format!("sk-ant-api03-{}", "A".repeat(MAX_SECRET_LEN));
        assert!(parse_secret(&too_long).is_err());
        let error = parse_secret("sk-ant-oat01-with space inside-AAAAAAAAAAAAAAAA")
            .err()
            .unwrap()
            .to_string();
        assert!(!error.contains("AAAA"), "an error never echoes the secret");
    }

    #[test]
    fn approved_form_is_the_last_twenty_characters() {
        assert_eq!(
            approved_form("0123456789abcdefghijKLMNO"),
            "56789abcdefghijKLMNO"
        );
        assert_eq!(approved_form("short"), "short");
        assert_eq!(approved_form("é".repeat(30).as_str()).chars().count(), 20);
    }

    #[test]
    fn a_token_or_key_becomes_an_account_that_never_shows_the_secret() {
        let f = fixture();
        let token = add_secret_in(&f.vault, Some(" CI "), TOKEN).unwrap();
        let key = add_secret_in(&f.vault, None, KEY).unwrap();
        assert_eq!(
            (token.name.as_str(), token.kind),
            ("CI", SlotKind::SetupToken)
        );
        assert_eq!(
            (key.name.as_str(), key.kind),
            (API_KEY_NAME, SlotKind::ApiKey)
        );
        assert!(token.email.is_none() && key.email.is_none());
        assert!(token.plan.is_none() && key.plan.is_none());
        assert_eq!(
            token.fingerprint.as_deref(),
            Some(secret_fingerprint(TOKEN).as_str())
        );
        let text = serde_json::to_string(&list_in(&f.vault, &f.paths)).unwrap();
        assert!(!text.contains("AAAAAAAA") && !text.contains("BBBBBBBB"));

        let again = add_secret_in(&f.vault, None, TOKEN)
            .unwrap_err()
            .to_string();
        assert!(again.contains("已经保存过"), "{again}");
        assert!(add_secret_in(&f.vault, None, "not a key").is_err());
        assert_eq!(f.vault.readable_slots().len(), 2);
    }

    #[test]
    fn switching_to_an_api_key_writes_the_key_and_drops_the_subscription_login() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a", "token-a");
        let key = add_secret_in(&f.vault, None, KEY).unwrap();

        let outcome = switch(&f, &key.id);
        assert_eq!(outcome.status, SwitchStatus::Switched);
        let creds = live_credentials(&f);
        assert!(
            creds.get(CREDENTIALS_KEY).is_none(),
            "the OAuth login is removed"
        );
        assert_eq!(creds["otherTool"]["keep"], true, "other keys stay");
        let json = live_json(&f);
        assert_eq!(json[API_KEY_FIELD], KEY);
        assert!(json.get(ACCOUNT_KEY).is_none());
        assert_eq!(json["numStartups"], 7, "unrelated state stays");
        assert!(json["projects"]["D:/work"].is_object());
        let approved: Vec<_> = json[API_KEY_RESPONSES]["approved"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(approved, vec![approved_form(KEY).to_string()]);

        let listed = list_in(&f.vault, &f.paths);
        assert!(listed.live.signed_in);
        assert_eq!(listed.live.plan.as_deref(), Some("API Key"));
        assert_eq!(listed.live.saved_id.as_deref(), Some(key.id.as_str()));
        assert!(listed
            .accounts
            .iter()
            .any(|x| x.id == key.id && x.is_current));
        assert_eq!(switch(&f, &key.id).status, SwitchStatus::AlreadyCurrent);

        // Back to the subscription login: the key leaves, the login returns.
        assert_eq!(switch(&f, &a).status, SwitchStatus::Switched);
        let json = live_json(&f);
        assert!(json.get(API_KEY_FIELD).is_none());
        assert_eq!(json[ACCOUNT_KEY]["emailAddress"], "a@example.com");
        assert_eq!(
            live_credentials(&f)[CREDENTIALS_KEY]["accessToken"],
            "token-a"
        );
        assert_eq!(f.vault.readable_slots().len(), 2, "no duplicate was made");
    }

    #[test]
    fn an_api_key_in_use_is_saved_before_a_subscription_login_replaces_it() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a", "token-a");
        // Claude Code signed in with a key only.
        fs::write(&f.paths.credentials, "{}").unwrap();
        fs::write(
            &f.paths.claude_json,
            json!({ API_KEY_FIELD: KEY, "numStartups": 3 }).to_string(),
        )
        .unwrap();
        let listed = list_in(&f.vault, &f.paths);
        assert!(listed.live.signed_in);
        assert!(listed.live.saved_id.is_none());

        let outcome = switch(&f, &a);
        assert!(outcome.auto_saved_id.is_some());
        assert!(live_json(&f).get(API_KEY_FIELD).is_none());
        let saved = f
            .vault
            .readable_slots()
            .into_iter()
            .find(|slot| slot.kind() == SlotKind::ApiKey)
            .expect("the key was kept");
        assert_eq!(saved.api_key.as_deref(), Some(KEY));
        // Saving what is live now reuses it instead of adding a copy.
        switch(&f, &saved.id);
        let again = save_current_in(&f.vault, &f.paths, None).unwrap();
        assert_eq!(again.id, saved.id);
        assert_eq!(f.vault.readable_slots().len(), 2);
    }

    #[test]
    fn switching_to_a_setup_token_writes_it_as_the_login_without_an_account() {
        let f = fixture();
        saved(&f, "a@example.com", "uuid-a", "token-a");
        let token = add_secret_in(&f.vault, None, TOKEN).unwrap();
        switch(&f, &token.id);
        let oauth = &live_credentials(&f)[CREDENTIALS_KEY];
        assert_eq!(oauth["accessToken"], TOKEN);
        assert_eq!(oauth["scopes"], json!(["user:inference"]));
        assert!(oauth.get("refreshToken").is_none());
        assert!(live_json(&f).get(ACCOUNT_KEY).is_none());
        assert_eq!(switch(&f, &token.id).status, SwitchStatus::AlreadyCurrent);
        assert!(list_in(&f.vault, &f.paths)
            .accounts
            .iter()
            .any(|x| x.id == token.id && x.is_current));
    }

    #[test]
    fn a_held_out_login_cannot_be_used_and_the_one_in_use_cannot_be_held_out() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a", "token-a");
        let b = saved(&f, "b@example.com", "uuid-b", "token-b");

        let error = set_disabled_in(&f.vault, &f.paths, &b, true)
            .unwrap_err()
            .to_string();
        assert!(error.contains("正是 Claude Code 现在使用"), "{error}");

        set_disabled_in(&f.vault, &f.paths, &a, true).unwrap();
        let listed = list_in(&f.vault, &f.paths);
        assert!(listed.accounts.iter().any(|x| x.id == a && x.disabled));
        let error = switch_in(&f.vault, &f.paths, &a, true, || false)
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("已停用"), "{error}");
        assert!(matches!(
            quota_source(&f.vault, &f.paths, &a).unwrap(),
            QuotaSource::Unsupported
        ));

        set_disabled_in(&f.vault, &f.paths, &a, false).unwrap();
        assert_eq!(switch(&f, &a).status, SwitchStatus::Switched);
        assert!(matches!(
            quota_source(&f.vault, &f.paths, &b).unwrap(),
            QuotaSource::Saved(_)
        ));
        // Setting the state it already has changes nothing.
        set_disabled_in(&f.vault, &f.paths, &a, false).unwrap();
    }

    #[test]
    fn tokens_and_keys_have_no_quota_to_read() {
        let f = fixture();
        let key = add_secret_in(&f.vault, None, KEY).unwrap();
        let token = add_secret_in(&f.vault, None, TOKEN).unwrap();
        for id in [&key.id, &token.id] {
            assert!(matches!(
                quota_source(&f.vault, &f.paths, id).unwrap(),
                QuotaSource::Unsupported
            ));
        }
    }

    #[test]
    fn the_order_the_user_sets_is_kept_and_new_logins_go_last() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a", "token-a");
        let b = saved(&f, "b@example.com", "uuid-b", "token-b");
        let c = saved(&f, "c@example.com", "uuid-c", "token-c");
        let ids = |f: &Fixture| -> Vec<String> {
            list_in(&f.vault, &f.paths)
                .accounts
                .into_iter()
                .map(|x| x.id)
                .collect()
        };
        assert_eq!(
            ids(&f),
            vec![a.clone(), b.clone(), c.clone()],
            "added order by default"
        );

        reorder_in(&f.vault, &[c.clone(), a.clone(), b.clone()]).unwrap();
        assert_eq!(ids(&f), vec![c.clone(), a.clone(), b.clone()]);

        // A partial list puts those first and keeps the rest in order.
        reorder_in(&f.vault, &[b.clone()]).unwrap();
        assert_eq!(ids(&f), vec![b.clone(), c.clone(), a.clone()]);

        let d = add_secret_in(&f.vault, None, KEY).unwrap().id;
        assert_eq!(ids(&f), vec![b.clone(), c.clone(), a.clone(), d.clone()]);

        assert!(reorder_in(&f.vault, &[a.clone(), a.clone()]).is_err());
        assert!(reorder_in(&f.vault, &["anope".to_string()]).is_err());
        assert!(reorder_in(&f.vault, &["../x".to_string()]).is_err());
        assert_eq!(ids(&f), vec![b, c, a, d], "a refused order changes nothing");
    }

    #[test]
    fn saved_files_stay_readable_by_the_previous_version_unless_they_use_new_kinds() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a", "token-a");
        let slot = f.vault.read_slot(&a).unwrap();
        let value = serde_json::to_value(&slot).unwrap();
        for field in ["kind", "disabled", "position", "apiKey"] {
            assert!(
                value.get(field).is_none(),
                "{field} is written only when set"
            );
        }
        // A file from before these fields existed.
        let old = json!({
            "version": 1, "id": "aold", "name": "旧", "createdAt": "2026-01-01",
            "updatedAt": "2026-01-01",
            "oauthAccount": {"accountUuid": "u", "emailAddress": "o@example.com"},
            "claudeAiOauth": {"accessToken": "t", "refreshToken": "r"}
        });
        let slot: Slot = serde_json::from_value(old).unwrap();
        assert_eq!(
            (slot.kind(), slot.disabled, slot.position),
            (SlotKind::Oauth, false, None)
        );
    }
}
