//! Per-account metadata for Codex official accounts: tags, the group, the
//! user's note, the "held out of use" flag and the last-used stamp.
//!
//! Deliberately not stored in the `codex_accounts::vault`: a vault slot is an
//! encrypted credential envelope (DPAPI sealed, owner-only DACL, versioned
//! format) whose loss costs the user a sign-in, so nothing presentational is
//! written into it. These fields live in the SQLite database keyed by the
//! account key instead, which also makes search and sort a plain in-memory
//! pass over a few dozen rows, and keeps them when a slot is re-created by
//! signing in again. See `docs/accounts/v2.9-account-model-zh.md`.
//!
//! Nothing here is a secret: no token, cookie or account id ever reaches
//! these fields.

use std::collections::HashMap;

use crate::error::AppError;

/// Longest accepted tag, in Unicode scalar values (`chars().count()`).
pub(crate) const TAG_MAX_CHARS: usize = 24;
/// Most tags one account may carry.
pub(crate) const TAGS_MAX_COUNT: usize = 12;
/// Longest accepted note, matching the Skills/MCP note limit (`dao::notes`).
pub(crate) const NOTE_MAX_CHARS: usize = 1000;
/// Longest accepted group name.
pub(crate) const GROUP_NAME_MAX_CHARS: usize = 40;
/// Longest accepted "held out of use" reason.
pub(crate) const DISABLED_REASON_MAX_CHARS: usize = 200;

/// User-controlled metadata of one saved account.
///
/// Every field is optional in practice: an account with no row in
/// `official_account_meta` behaves exactly like `AccountMeta::default()`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AccountMeta {
    /// Normalized by [`normalize_tags`]; never empty strings, never duplicates.
    pub(crate) tags: Vec<String>,
    /// Group id, `None` while ungrouped.
    pub(crate) group_id: Option<String>,
    pub(crate) note: Option<String>,
    /// Held out of use by the user: not offered for switching.
    pub(crate) disabled: bool,
    pub(crate) disabled_at: Option<i64>,
    pub(crate) disabled_reason: Option<String>,
    /// Last time Codex was seen using this account (ms since the epoch).
    pub(crate) last_used_at: Option<i64>,
}

/// A user-defined group of accounts. Groups carry no credentials; deleting
/// one only clears `group_id` of its members.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AccountGroup {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) color: Option<String>,
    pub(crate) sort_index: i64,
}

/// Everything the account list needs about user metadata, read in one go so
/// the list stays a single database round-trip (no query per account).
#[derive(Debug, Clone, Default)]
pub(crate) struct AccountMetaIndex {
    metas: HashMap<String, AccountMeta>,
    groups: HashMap<String, AccountGroup>,
}

impl AccountMetaIndex {
    pub(crate) fn new(
        metas: HashMap<String, AccountMeta>,
        groups: HashMap<String, AccountGroup>,
    ) -> Self {
        Self { metas, groups }
    }

    pub(crate) fn meta(&self, key: &str) -> Option<&AccountMeta> {
        self.metas.get(key)
    }

    pub(crate) fn group(&self, id: &str) -> Option<&AccountGroup> {
        self.groups.get(id)
    }

    /// Every group, in the order the user arranged them. Ties fall back to the
    /// name so two groups sharing a `sort_index` keep a stable order.
    pub(crate) fn groups_sorted(&self) -> Vec<AccountGroup> {
        let mut groups: Vec<AccountGroup> = self.groups.values().cloned().collect();
        groups.sort_by(|left, right| {
            left.sort_index
                .cmp(&right.sort_index)
                .then_with(|| left.name.cmp(&right.name))
        });
        groups
    }
}

/// Trims tags, drops empties and duplicates (first spelling wins), and
/// enforces the length/count limits.
///
/// Case is preserved: `API` and `api` are different tags, because the user
/// typed them that way. Search lowercases both sides instead.
pub(crate) fn normalize_tags(tags: &[String]) -> Result<Vec<String>, AppError> {
    let mut normalized: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > TAG_MAX_CHARS {
            return Err(AppError::InvalidInput(format!(
                "标签不能超过 {TAG_MAX_CHARS} 个字符"
            )));
        }
        if tag.chars().any(char::is_control) {
            return Err(AppError::InvalidInput("标签不能包含控制字符".to_string()));
        }
        if normalized.iter().any(|existing| existing == tag) {
            continue;
        }
        normalized.push(tag.to_string());
        if normalized.len() > TAGS_MAX_COUNT {
            return Err(AppError::InvalidInput(format!(
                "一个账号最多 {TAGS_MAX_COUNT} 个标签"
            )));
        }
    }
    Ok(normalized)
}

/// Trims a free-form note; whitespace-only clears it.
pub(crate) fn normalize_note(note: Option<&str>) -> Result<Option<String>, AppError> {
    let note = note.map(str::trim).filter(|text| !text.is_empty());
    if note.is_some_and(|text| text.chars().count() > NOTE_MAX_CHARS) {
        return Err(AppError::InvalidInput(format!(
            "备注不能超过 {NOTE_MAX_CHARS} 个字符"
        )));
    }
    Ok(note.map(str::to_string))
}

/// Trims and validates a group name; an empty name is refused (a group
/// always shows a label).
pub(crate) fn normalize_group_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("分组名称不能为空".to_string()));
    }
    if name.chars().count() > GROUP_NAME_MAX_CHARS {
        return Err(AppError::InvalidInput(format!(
            "分组名称不能超过 {GROUP_NAME_MAX_CHARS} 个字符"
        )));
    }
    if name.chars().any(char::is_control) {
        return Err(AppError::InvalidInput(
            "分组名称不能包含控制字符".to_string(),
        ));
    }
    Ok(name.to_string())
}

/// Trims an optional "why is this account held out" reason.
pub(crate) fn normalize_disabled_reason(reason: Option<&str>) -> Result<Option<String>, AppError> {
    let reason = reason.map(str::trim).filter(|text| !text.is_empty());
    if reason.is_some_and(|text| text.chars().count() > DISABLED_REASON_MAX_CHARS) {
        return Err(AppError::InvalidInput(format!(
            "停用原因不能超过 {DISABLED_REASON_MAX_CHARS} 个字符"
        )));
    }
    Ok(reason.map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn tags_are_trimmed_deduplicated_and_keep_the_first_spelling() {
        let normalized = normalize_tags(&tags(&[" api ", "", "API", "api", "  "])).unwrap();
        assert_eq!(normalized, tags(&["api", "API"]));
    }

    #[test]
    fn tag_limits_count_unicode_characters() {
        let widest = "界".repeat(TAG_MAX_CHARS);
        assert_eq!(normalize_tags(&[widest.clone()]).unwrap(), vec![widest]);
        let too_wide = "界".repeat(TAG_MAX_CHARS + 1);
        assert!(normalize_tags(&[too_wide]).is_err());
        let many: Vec<String> = (0..TAGS_MAX_COUNT).map(|i| i.to_string()).collect();
        assert_eq!(normalize_tags(&many).unwrap().len(), TAGS_MAX_COUNT);
        let one_too_many: Vec<String> = (0..=TAGS_MAX_COUNT).map(|i| i.to_string()).collect();
        assert!(normalize_tags(&one_too_many).is_err());
    }

    #[test]
    fn control_characters_are_refused_in_tags_and_group_names() {
        assert!(normalize_tags(&tags(&["a\nb"])).is_err());
        assert!(normalize_group_name("a\tb").is_err());
        assert!(normalize_group_name("   ").is_err());
        assert_eq!(normalize_group_name("  主力  ").unwrap(), "主力");
    }

    #[test]
    fn notes_and_reasons_clear_on_whitespace() {
        assert_eq!(normalize_note(Some("   ")).unwrap(), None);
        assert_eq!(normalize_note(None).unwrap(), None);
        assert_eq!(
            normalize_note(Some(" 备用 ")).unwrap(),
            Some("备用".to_string())
        );
        assert_eq!(normalize_disabled_reason(Some("")).unwrap(), None);
        assert!(normalize_note(Some(&"界".repeat(NOTE_MAX_CHARS + 1))).is_err());
    }

    #[test]
    fn the_index_answers_absent_keys_with_nothing() {
        let index = AccountMetaIndex::default();
        assert!(index.meta("missing").is_none());
        assert!(index.group("missing").is_none());
    }
}
