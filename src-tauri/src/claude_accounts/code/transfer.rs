//! Moving saved logins in and out of the vault as a JSON file.
//!
//! The file is claude-swap's v1 envelope (`cswap --export` / `--import`), so
//! a file from that tool can be imported here and an export from here can be
//! imported there. It is plain text and holds live refresh tokens: whoever
//! has the file has the logins, which the callers say before writing it.
//! A bare Claude Code `.credentials.json` (`{ "claudeAiOauth": … }`) imports
//! as a single login too.
//!
//! Import follows claude-swap's rules: everything is validated before the
//! first write; a login the vault already has is left alone (its tokens may
//! be newer than the file's, and Claude rotates refresh tokens) unless it was
//! marked as needing a new sign-in, in which case the file's tokens heal it.

use super::manage::{self, Secret};
use super::*;
use serde_json::json;

const FORMAT_VERSION: u64 = 1;
/// Largest file accepted for import.
pub(crate) const MAX_IMPORT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOKEN_LEN: usize = 16 * 1024;
const MAX_OAUTH_BYTES: usize = 64 * 1024;
const MAX_ACCOUNT_BYTES: usize = 16 * 1024;

/// What an export produced. The text holds tokens; it is not `Debug`.
pub(crate) struct Exported {
    pub json: String,
    pub count: usize,
    /// Saved logins left out because the entry cannot be read here or lacks
    /// the account block the format needs.
    pub skipped: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedLogin {
    pub email: Option<String>,
    pub reason: String,
}

/// Outcome of an import. No tokens, only the same summaries the list shows.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: Vec<CodeAccountDto>,
    pub updated: Vec<CodeAccountDto>,
    pub skipped: Vec<SkippedLogin>,
    /// Things worth knowing about what was imported.
    pub notes: Vec<String>,
}

fn platform_tag() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// An export entry for a token or key. claude-swap needs an email for every
/// account, so it gets the placeholder one it uses for them too.
fn token_entry(number: usize, slot: &Slot, label: &str, credentials: Value) -> Value {
    let email = format!("{label}-{number}@token.local");
    json!({
        "number": number,
        "email": email,
        "uuid": "",
        "organizationUuid": "",
        "organizationName": "",
        "added": slot.created_at,
        "chimeraName": slot.name,
        "credentials": credentials,
        "config": { ACCOUNT_KEY: {
            "emailAddress": email,
            "accountUuid": "",
            "organizationUuid": Value::Null,
            "organizationName": Value::Null,
        } },
    })
}

/// The envelope for the saved logins named by `ids` (all of them for `None`).
pub(crate) fn export_in(
    vault: &CodeVault,
    paths: &LivePaths,
    ids: Option<&[String]>,
) -> Result<Exported, AppError> {
    let _guard = CODE_LOCK.lock()?;
    // Newer tokens a session wrote belong in the file.
    sessions::harvest_all_locked(vault);
    // So do the ones Claude Code holds for the login it is signed in with: it
    // renews them as it goes, and the copy saved here is as old as the last
    // switch, whose refresh token the server has long since replaced.
    if let Ok(live) = read_live(paths) {
        // Not when the tokens are another saved login's while `.claude.json`
        // names a different one (a switch undone halfway): they would be put
        // under the wrong login.
        let stray = |oauth: &Value| {
            live_identity(&live).is_some_and(|ident| tokens_owned_elsewhere(vault, oauth, &ident))
        };
        if let Some(oauth) = live
            .oauth
            .as_ref()
            .filter(|oauth| !is_setup_token_oauth(oauth) && !stray(oauth))
        {
            for mut slot in vault.readable_slots() {
                if slot.kind == SlotKind::Oauth && live_holds(&live, &slot) {
                    slot.absorb(oauth.clone(), live.account.clone());
                    if let Err(error) = vault.write_slot(&slot) {
                        log::warn!("导出前同步当前登录失败: {error}");
                    }
                }
            }
        }
    }
    let mut accounts = Vec::new();
    let mut skipped = 0usize;
    let mut slots = vault.readable_slots();
    if let Some(ids) = ids {
        slots.retain(|slot| ids.contains(&slot.id));
    }
    for slot in slots {
        let number = accounts.len() + 1;
        match slot.kind() {
            SlotKind::Oauth => {
                let ident = slot.identity();
                let account = slot
                    .oauth_account
                    .as_ref()
                    .filter(|value| value.is_object());
                let (Some(email), Some(account)) = (ident.email.as_ref(), account) else {
                    skipped += 1;
                    continue;
                };
                accounts.push(json!({
                    "number": number,
                    "email": email,
                    "uuid": text_field(Some(account), "accountUuid").unwrap_or_default(),
                    "organizationUuid": text_field(Some(account), "organizationUuid")
                        .unwrap_or_default(),
                    "organizationName": text_field(Some(account), "organizationName")
                        .unwrap_or_default(),
                    "added": slot.created_at,
                    "chimeraName": slot.name,
                    "credentials": { CREDENTIALS_KEY: slot.claude_ai_oauth },
                    "config": { ACCOUNT_KEY: account },
                }));
            }
            SlotKind::SetupToken => accounts.push(token_entry(
                number,
                &slot,
                "setup-token",
                json!({ CREDENTIALS_KEY: slot.claude_ai_oauth }),
            )),
            SlotKind::ApiKey => {
                let Some(key) = slot.api_key.clone() else {
                    skipped += 1;
                    continue;
                };
                accounts.push(token_entry(number, &slot, "api-key", Value::String(key)));
            }
        }
    }
    if accounts.is_empty() {
        return Err(AppError::InvalidInput(
            "没有可导出的登录。已保存的登录需要同时有令牌和账号信息。".to_string(),
        ));
    }
    let count = accounts.len();
    let envelope = json!({
        "version": FORMAT_VERSION,
        "exportedAt": now_rfc3339(),
        "exportedFrom": platform_tag(),
        "swapVersion": format!("chimera-plusplus {}", env!("CARGO_PKG_VERSION")),
        "encrypted": false,
        "activeAccountNumber": Value::Null,
        "accounts": accounts,
    });
    let json = serde_json::to_string_pretty(&envelope)
        .map_err(|e| AppError::JsonSerialize { source: e })?
        + "\n";
    Ok(Exported {
        json,
        count,
        skipped,
    })
}

/// What a file entry holds.
enum Material {
    Login {
        oauth: Value,
        account: Option<Value>,
    },
    Secret(Secret),
}

/// One login read from a file, validated, not yet stored.
struct Candidate {
    name: Option<String>,
    material: Material,
}

impl Candidate {
    fn identity(&self) -> Identity {
        match &self.material {
            Material::Login { oauth, account } => identity(account.as_ref(), Some(oauth)),
            Material::Secret(secret) => Identity {
                fingerprint: Some(secret_fingerprint(secret.value())),
                ..Identity::default()
            },
        }
    }
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}

fn token_ok(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|token| {
        !token.is_empty()
            && token.len() <= MAX_TOKEN_LEN
            && !token.chars().any(char::is_control)
            && !token.chars().any(char::is_whitespace)
    })
}

/// A `claudeAiOauth` object that can be used and renewed.
pub(super) fn valid_oauth(value: Option<&Value>, label: &str) -> Result<Value, AppError> {
    let oauth = value
        .filter(|value| value.is_object())
        .ok_or_else(|| invalid(format!("{label}缺少 claudeAiOauth 登录信息")))?;
    if !token_ok(oauth.get("accessToken")) {
        return Err(invalid(format!("{label}的 accessToken 缺失或格式不对")));
    }
    if !token_ok(oauth.get("refreshToken")) {
        return Err(invalid(format!(
            "{label}缺少 refreshToken，这样的登录几小时后就会失效，无法导入"
        )));
    }
    if oauth.get("expiresAt").is_some_and(|at| !at.is_number()) {
        return Err(invalid(format!("{label}的 expiresAt 格式不对")));
    }
    if serde_json::to_vec(oauth).map_or(true, |bytes| bytes.len() > MAX_OAUTH_BYTES) {
        return Err(invalid(format!("{label}的登录信息过大")));
    }
    Ok(oauth.clone())
}

fn optional_account(value: Option<&Value>, label: &str) -> Result<Option<Value>, AppError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(account) if account.is_object() => {
            if serde_json::to_vec(account).map_or(true, |bytes| bytes.len() > MAX_ACCOUNT_BYTES) {
                return Err(invalid(format!("{label}的 oauthAccount 过大")));
            }
            Ok(Some(account.clone()))
        }
        Some(_) => Err(invalid(format!("{label}的 oauthAccount 必须是对象"))),
    }
}

/// An entry's credentials: a subscription login, a setup-token (a
/// `claudeAiOauth` without a refresh token) or an API key (a bare string).
fn material_of(
    credentials: Option<&Value>,
    account: Option<&Value>,
    label: &str,
) -> Result<Material, AppError> {
    if let Some(Value::String(text)) = credentials {
        return match manage::parse_secret(text) {
            Ok(secret @ Secret::ApiKey(_)) => Ok(Material::Secret(secret)),
            _ => Err(invalid(format!("{label}的凭据不是有效的 API Key"))),
        };
    }
    let oauth = credentials.and_then(|value| value.get(CREDENTIALS_KEY));
    let setup_token = oauth
        .filter(|oauth| oauth.get("refreshToken").is_none())
        .and_then(|oauth| oauth.get("accessToken"))
        .and_then(Value::as_str)
        .and_then(|token| manage::parse_secret(token).ok())
        .filter(|secret| matches!(secret, Secret::SetupToken(_)));
    if let Some(secret) = setup_token {
        return Ok(Material::Secret(secret));
    }
    Ok(Material::Login {
        oauth: valid_oauth(oauth, label)?,
        account: optional_account(account, label)?,
    })
}

fn candidate_name(entry: &Value) -> Option<String> {
    ["chimeraName", "alias"]
        .iter()
        .filter_map(|key| entry.get(*key).and_then(Value::as_str))
        .find_map(|name| normalize_account_name(name).ok())
}

fn candidates_of(root: &Value) -> Result<Vec<Candidate>, AppError> {
    let object = root
        .as_object()
        .ok_or_else(|| invalid("文件内容必须是 JSON 对象"))?;

    if let Some(accounts) = object.get("accounts") {
        if object.get("version").and_then(Value::as_u64) != Some(FORMAT_VERSION) {
            return Err(invalid("不支持的导出文件版本（需要 version 1）"));
        }
        if object.get("encrypted").and_then(Value::as_bool) == Some(true) {
            return Err(invalid("这个文件是加密的，请先解密再导入"));
        }
        let accounts = accounts
            .as_array()
            .filter(|accounts| !accounts.is_empty())
            .ok_or_else(|| invalid("文件里没有可导入的账号"))?;
        if accounts.len() > MAX_ACCOUNTS {
            return Err(invalid(format!("一次最多导入 {MAX_ACCOUNTS} 个账号")));
        }
        return accounts
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let label = format!("第 {} 个账号", index + 1);
                if !entry.is_object() {
                    return Err(invalid(format!("{label}必须是对象")));
                }
                Ok(Candidate {
                    name: candidate_name(entry),
                    material: material_of(
                        entry.get("credentials"),
                        entry.get("config").and_then(|value| value.get(ACCOUNT_KEY)),
                        &label,
                    )?,
                })
            })
            .collect();
    }

    if object.contains_key(CREDENTIALS_KEY) {
        return Ok(vec![Candidate {
            name: None,
            material: material_of(Some(root), object.get(ACCOUNT_KEY), "文件")?,
        }]);
    }

    Err(invalid(
        "无法识别这个文件：需要 claude-swap 的导出文件，或 Claude Code 的 .credentials.json",
    ))
}

/// Stores a login that is not in the vault yet, or heals/skips one that is.
/// The caller holds `CODE_LOCK`.
fn store_candidate(
    vault: &CodeVault,
    candidate: Candidate,
    report: &mut ImportReport,
) -> Result<(), AppError> {
    let ident = candidate.identity();
    let skip = |report: &mut ImportReport, reason: &str| {
        report.skipped.push(SkippedLogin {
            email: ident.email.clone(),
            reason: reason.to_string(),
        });
    };
    let (oauth, account) = match candidate.material {
        Material::Login { oauth, account } => (oauth, account),
        Material::Secret(secret) => {
            if find_matching(vault, &ident).is_some() {
                skip(report, "已经保存了相同的令牌或密钥");
            } else if vault.slot_ids().len() >= MAX_ACCOUNTS {
                skip(report, &format!("已达到 {MAX_ACCOUNTS} 个账号的上限"));
            } else {
                let name = candidate.name.unwrap_or_else(|| match secret {
                    Secret::SetupToken(_) => manage::SETUP_TOKEN_NAME.to_string(),
                    Secret::ApiKey(_) => manage::API_KEY_NAME.to_string(),
                });
                let slot = manage::new_secret_slot(vault, name, secret)?;
                vault.write_slot(&slot)?;
                report.imported.push(slot.dto(None));
            }
            return Ok(());
        }
    };
    if let Some(mut slot) = find_matching(vault, &ident) {
        if refresh_token_of(&slot.claude_ai_oauth) == refresh_token_of(&oauth) {
            skip(report, "已经保存了相同的登录");
        } else if slot.needs_relogin {
            slot.absorb(oauth, account);
            vault.write_slot(&slot)?;
            report.updated.push(slot.dto(None));
        } else {
            skip(
                report,
                "已有这个账号的登录，保留本机的令牌（它可能比文件里的新）",
            );
        }
        return Ok(());
    }
    if vault.slot_ids().len() >= MAX_ACCOUNTS {
        skip(report, &format!("已达到 {MAX_ACCOUNTS} 个账号的上限"));
        return Ok(());
    }
    let name = candidate
        .name
        .unwrap_or_else(|| fitted_name(ident.email.as_deref().unwrap_or_default(), DEFAULT_NAME));
    let slot = new_slot(vault, name, oauth, account)?;
    vault.write_slot(&slot)?;
    // Without an account block a login is known only by its access token,
    // which changes on every refresh.
    if ident.email.is_none() && ident.account_uuid.is_none() {
        report.notes.push(format!(
            "「{}」的文件里没有账号信息（oauthAccount）。切换到它并用过之后，可能被当成另一个登录再保存一份。建议切换到它、在 Claude Code 里用一次，再点「保存当前登录」，或改用浏览器授权添加。",
            slot.name
        ));
    }
    report.imported.push(slot.dto(None));
    Ok(())
}

/// Imports the logins in `text`. Nothing is written unless the whole file
/// validates.
pub(crate) fn import_in(vault: &CodeVault, text: &str) -> Result<ImportReport, AppError> {
    let root: Value =
        serde_json::from_str(strip_bom(text)).map_err(|_| invalid("这不是有效的 JSON 文件"))?;
    let candidates = candidates_of(&root)?;
    let _guard = CODE_LOCK.lock()?;
    let mut report = ImportReport::default();
    let mut seen: Vec<Identity> = Vec::new();
    for candidate in candidates {
        let ident = candidate.identity();
        if seen.iter().any(|earlier| same_login(earlier, &ident)) {
            report.skipped.push(SkippedLogin {
                email: ident.email.clone(),
                reason: "文件里重复出现的同一账号".to_string(),
            });
            continue;
        }
        seen.push(ident);
        store_candidate(vault, candidate, &mut report)?;
    }
    Ok(report)
}

// The vault saves no login on macOS (Claude Code keeps it in the keychain).
#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    use super::*;
    use crate::claude_accounts::code::tests::{fixture, login};

    fn saved(
        f: &crate::claude_accounts::code::tests::Fixture,
        email: &str,
        uuid: &str,
        token: &str,
    ) {
        login(&f.paths, email, uuid, token);
        save_current_in(&f.vault, &f.paths, None).unwrap();
    }

    #[test]
    fn an_export_carries_the_tokens_claude_code_holds_for_the_login_in_use() {
        let f = fixture();
        saved(&f, "a@example.com", "uuid-a", "token-a");
        saved(&f, "b@example.com", "uuid-b", "token-b");
        // Claude Code renewed A's tokens since they were saved here.
        login(&f.paths, "a@example.com", "uuid-a", "token-a-renewed");
        let envelope: Value =
            serde_json::from_str(&export_in(&f.vault, &f.paths, None).unwrap().json).unwrap();
        let token_of = |email: &str| {
            envelope["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["email"] == email)
                .map(|entry| entry["credentials"]["claudeAiOauth"]["accessToken"].clone())
                .unwrap()
        };
        assert_eq!(token_of("a@example.com"), "token-a-renewed");
        assert_eq!(
            token_of("b@example.com"),
            "token-b",
            "the other one is as saved"
        );
        // And the saved copy was brought up to date too.
        let kept = f
            .vault
            .readable_slots()
            .into_iter()
            .find(|slot| slot.identity().email.as_deref() == Some("a@example.com"))
            .unwrap();
        assert_eq!(kept.claude_ai_oauth["accessToken"], "token-a-renewed");
    }

    #[test]
    fn an_export_in_a_half_switched_state_leaves_every_login_as_saved() {
        let f = fixture();
        saved(&f, "a@example.com", "uuid-a", "token-a");
        saved(&f, "b@example.com", "uuid-b", "token-b");
        // `.claude.json` names A, the tokens are B's.
        login(&f.paths, "a@example.com", "uuid-a", "token-b");
        let envelope: Value =
            serde_json::from_str(&export_in(&f.vault, &f.paths, None).unwrap().json).unwrap();
        let token_of = |email: &str| {
            envelope["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["email"] == email)
                .map(|entry| entry["credentials"]["claudeAiOauth"]["accessToken"].clone())
                .unwrap()
        };
        assert_eq!(token_of("a@example.com"), "token-a");
        assert_eq!(token_of("b@example.com"), "token-b");
        let slots = f.vault.readable_slots();
        assert_eq!(slots.len(), 2);
        for slot in slots {
            let email = slot.identity().email.unwrap();
            let expected = if email == "a@example.com" {
                "token-a"
            } else {
                "token-b"
            };
            assert_eq!(slot.claude_ai_oauth["accessToken"], expected, "{email}");
        }
    }

    #[test]
    fn export_is_the_claude_swap_envelope_and_round_trips_into_another_vault() {
        let source = fixture();
        saved(&source, "a@example.com", "uuid-a", "token-a");
        saved(&source, "b@example.com", "uuid-b", "token-b");

        let exported = export_in(&source.vault, &source.paths, None).unwrap();
        assert_eq!((exported.count, exported.skipped), (2, 0));
        let envelope: Value = serde_json::from_str(&exported.json).unwrap();
        assert_eq!(envelope["version"], 1);
        assert_eq!(envelope["encrypted"], false);
        let first = &envelope["accounts"][0];
        assert_eq!(first["number"], 1);
        assert_eq!(first["email"], "a@example.com");
        assert_eq!(first["uuid"], "uuid-a");
        assert_eq!(
            first["credentials"]["claudeAiOauth"]["accessToken"],
            "token-a"
        );
        assert_eq!(
            first["config"]["oauthAccount"]["emailAddress"],
            "a@example.com"
        );
        assert!(first["credentials"].get("otherTool").is_none());

        let target = fixture();
        let report = import_in(&target.vault, &exported.json).unwrap();
        assert_eq!(report.imported.len(), 2);
        assert!(report.updated.is_empty() && report.skipped.is_empty());
        let names: Vec<_> = report.imported.iter().map(|a| a.email.clone()).collect();
        assert_eq!(
            names,
            vec![Some("a@example.com".into()), Some("b@example.com".into())]
        );
        // The tokens arrived intact.
        let slots = target.vault.readable_slots();
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].claude_ai_oauth["accessToken"], "token-a");
        assert_eq!(slots[0].claude_ai_oauth["refreshToken"], "r-token-a");
    }

    #[test]
    fn export_can_be_limited_to_chosen_logins_and_refuses_nothing_to_export() {
        let f = fixture();
        saved(&f, "a@example.com", "uuid-a", "token-a");
        saved(&f, "b@example.com", "uuid-b", "token-b");
        let b_id = f
            .vault
            .readable_slots()
            .into_iter()
            .find(|slot| slot.identity().email.as_deref() == Some("b@example.com"))
            .unwrap()
            .id;

        let one = export_in(&f.vault, &f.paths, Some(&[b_id])).unwrap();
        assert_eq!(one.count, 1);
        assert!(one.json.contains("b@example.com") && !one.json.contains("a@example.com"));

        assert!(export_in(&f.vault, &f.paths, Some(&["nope".to_string()])).is_err());
        let empty = fixture();
        assert!(export_in(&empty.vault, &empty.paths, None).is_err());
    }

    #[test]
    fn import_keeps_a_login_the_vault_has_but_heals_one_that_needs_a_new_sign_in() {
        let f = fixture();
        saved(&f, "a@example.com", "uuid-a", "token-a");
        let id = f.vault.readable_slots()[0].id.clone();
        let file = json!({
            "version": 1, "encrypted": false,
            "accounts": [{
                "number": 1, "email": "a@example.com",
                "credentials": {"claudeAiOauth": {
                    "accessToken": "token-new", "refreshToken": "r-new", "expiresAt": 1
                }},
                "config": {"oauthAccount": {"accountUuid": "uuid-a", "emailAddress": "a@example.com"}}
            }]
        })
        .to_string();

        let report = import_in(&f.vault, &file).unwrap();
        assert_eq!(
            report.skipped.len(),
            1,
            "a working login is not overwritten"
        );
        assert_eq!(
            f.vault.read_slot(&id).unwrap().claude_ai_oauth["accessToken"],
            "token-a"
        );

        mark_needs_relogin(&f.vault, &id).unwrap();
        let report = import_in(&f.vault, &file).unwrap();
        assert_eq!(report.updated.len(), 1);
        let slot = f.vault.read_slot(&id).unwrap();
        assert_eq!(slot.claude_ai_oauth["accessToken"], "token-new");
        assert!(!slot.needs_relogin());

        // The same file again changes nothing.
        let report = import_in(&f.vault, &file).unwrap();
        assert_eq!(
            (
                report.imported.len(),
                report.updated.len(),
                report.skipped.len()
            ),
            (0, 0, 1)
        );
    }

    #[test]
    fn a_bare_credentials_file_imports_as_one_login() {
        let f = fixture();
        let file = json!({
            "claudeAiOauth": {"accessToken": "t", "refreshToken": "r", "subscriptionType": "max"},
            "mcpOAuth": {"must": "not be imported"}
        })
        .to_string();
        let report = import_in(&f.vault, &file).unwrap();
        assert_eq!(report.imported.len(), 1);
        assert_eq!(report.imported[0].plan.as_deref(), Some("Max"));
        assert_eq!(
            report.notes.len(),
            1,
            "the missing account info is pointed out"
        );
        let stored = serde_json::to_string(&f.vault.readable_slots()[0].claude_ai_oauth).unwrap();
        assert!(!stored.contains("mcpOAuth"));
    }

    #[test]
    fn a_bad_file_is_refused_before_anything_is_written() {
        let f = fixture();
        let good = json!({
            "number": 1, "email": "a@example.com",
            "credentials": {"claudeAiOauth": {"accessToken": "t", "refreshToken": "r"}},
            "config": {"oauthAccount": {"accountUuid": "u", "emailAddress": "a@example.com"}}
        });
        let broken = json!({
            "number": 2, "email": "b@example.com",
            "credentials": {"claudeAiOauth": {"accessToken": "t"}},
            "config": {"oauthAccount": {"accountUuid": "v", "emailAddress": "b@example.com"}}
        });
        let envelope = |version: u64, encrypted: bool, accounts: Vec<Value>| {
            json!({"version": version, "encrypted": encrypted, "accounts": accounts}).to_string()
        };
        for (text, why) in [
            ("not json".to_string(), "json"),
            ("[]".to_string(), "object"),
            ("{}".to_string(), "unrecognised"),
            (envelope(2, false, vec![good.clone()]), "version"),
            (envelope(1, true, vec![good.clone()]), "encrypted"),
            (envelope(1, false, vec![]), "empty"),
            (
                envelope(1, false, vec![good.clone(), broken]),
                "missing refresh token",
            ),
            (
                envelope(1, false, vec![json!({"credentials": "an-api-key-string"})]),
                "api key",
            ),
            (
                json!({"claudeAiOauth": {"accessToken": "t r", "refreshToken": "r"}}).to_string(),
                "whitespace in a token",
            ),
        ] {
            assert!(import_in(&f.vault, &text).is_err(), "{why}");
            assert!(
                f.vault.readable_slots().is_empty(),
                "{why} left a partial import"
            );
        }
    }

    #[test]
    fn the_same_account_twice_in_one_file_is_stored_once_and_names_are_used() {
        let f = fixture();
        let entry = |name: &str, token: &str| {
            json!({
                "number": 1, "email": "a@example.com", "chimeraName": name,
                "credentials": {"claudeAiOauth": {"accessToken": token, "refreshToken": format!("r-{token}")}},
                "config": {"oauthAccount": {"accountUuid": "u", "emailAddress": "a@example.com"}}
            })
        };
        let file = json!({"version": 1, "encrypted": false,
            "accounts": [entry("工作号", "t1"), entry("重复", "t2")]})
        .to_string();
        let report = import_in(&f.vault, &file).unwrap();
        assert_eq!((report.imported.len(), report.skipped.len()), (1, 1));
        assert_eq!(report.imported[0].name, "工作号");
    }

    const KEY: &str = concat!(
        "sk-ant-api03-",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-xyz_1234567890"
    );
    const TOKEN: &str = concat!(
        "sk-ant-oat01-",
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB-xyz_1234567890"
    );

    #[test]
    fn tokens_and_keys_travel_in_claude_swaps_shape_and_come_back_as_what_they_were() {
        let source = fixture();
        saved(&source, "a@example.com", "uuid-a", "token-a");
        manage::add_secret_in(&source.vault, Some("CI"), TOKEN).unwrap();
        manage::add_secret_in(&source.vault, Some("Console"), KEY).unwrap();

        let exported = export_in(&source.vault, &source.paths, None).unwrap();
        assert_eq!((exported.count, exported.skipped), (3, 0));
        let envelope: Value = serde_json::from_str(&exported.json).unwrap();
        let by_name = |name: &str| {
            envelope["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["chimeraName"] == name)
                .unwrap()
                .clone()
        };
        let token = by_name("CI");
        assert_eq!(token["credentials"]["claudeAiOauth"]["accessToken"], TOKEN);
        assert!(token["credentials"]["claudeAiOauth"]
            .get("refreshToken")
            .is_none());
        assert!(token["email"].as_str().unwrap().ends_with("@token.local"));
        let key = by_name("Console");
        assert_eq!(key["credentials"], KEY, "an API key is a bare string");

        let target = fixture();
        let report = import_in(&target.vault, &exported.json).unwrap();
        assert_eq!((report.imported.len(), report.skipped.len()), (3, 0));
        let kinds: Vec<_> = target
            .vault
            .readable_slots()
            .iter()
            .map(|s| s.kind())
            .collect();
        assert_eq!(
            kinds,
            vec![SlotKind::Oauth, SlotKind::SetupToken, SlotKind::ApiKey]
        );
        let names: Vec<_> = report.imported.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names[1..], ["CI", "Console"]);

        // The same file again adds nothing.
        let again = import_in(&target.vault, &exported.json).unwrap();
        assert_eq!((again.imported.len(), again.skipped.len()), (0, 3));
        let text = serde_json::to_string(&report).unwrap();
        assert!(!text.contains("AAAAAAAA") && !text.contains("BBBBBBBB"));
    }

    #[test]
    fn a_bare_setup_token_credentials_file_imports_as_a_token_account() {
        let f = fixture();
        let file = json!({"claudeAiOauth": {"accessToken": TOKEN, "scopes": ["user:inference"]}})
            .to_string();
        let report = import_in(&f.vault, &file).unwrap();
        assert_eq!(report.imported[0].kind, SlotKind::SetupToken);
        // A token that is not a setup-token still needs its refresh token.
        let no_refresh =
            json!({"claudeAiOauth": {"accessToken": "an-access-token-without-refresh"}})
                .to_string();
        assert!(import_in(&f.vault, &no_refresh).is_err());
    }

    #[test]
    fn reports_never_carry_a_token() {
        let f = fixture();
        saved(&f, "a@example.com", "uuid-a", "token-secret");
        let exported = export_in(&f.vault, &f.paths, None).unwrap();
        let report = import_in(&fixture().vault, &exported.json).unwrap();
        let text = serde_json::to_string(&report).unwrap();
        assert!(!text.contains("token-secret") && !text.contains("r-token-secret"));
    }
}
