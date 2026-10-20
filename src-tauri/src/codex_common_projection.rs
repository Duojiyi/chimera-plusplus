//! Reversible common-snippet projection, independent of line/provider projection.
//!
//! The caller owns locking, atomic persistence, backups and when to seed a legacy
//! ledger. Both APIs only transform strings. Ledger items are complete single-item TOML
//! documents under `v`; paths retain individual TOML key components, not dotted
//! strings. An entry's applied value is the last desired value, even if a user
//! has since edited or removed that key. Keeping that intent prevents the next
//! unchanged projection from undoing the user's edit.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use toml_edit::{DocumentMut, Item, Table, TableLike};

use crate::codex_key_ownership::{
    canonical_toml_item, validate_codex_common_snippet, CodexCommonSnippet,
};
use crate::error::AppError;

pub(crate) const BACKUP_KEY: &str = "chimera_common_projection";
const LEDGER_VERSION: u32 = 1;

pub(crate) fn ledger_path() -> PathBuf {
    crate::codex_config::get_codex_config_dir().join("chimera-common-projection.json")
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectionLedger {
    version: u32,
    entries: Vec<ProjectionEntry>,
    #[serde(default)]
    created_parents: BTreeSet<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectionEntry {
    path: Vec<String>,
    applied_toml: String,
    original_toml: Option<String>,
}

struct ParsedEntry {
    record: ProjectionEntry,
    applied: Item,
    original: Option<Item>,
}

type DesiredItems = BTreeMap<Vec<String>, Item>;

fn invalid_ledger() -> AppError {
    // Neither JSON/TOML parser diagnostics nor recorded values may escape.
    AppError::Config(format!(
        "Codex 通用配置投影记录损坏或格式无效：{}（可删除该文件后重试，下次保存会重新生成）",
        ledger_path().display()
    ))
}

fn path_conflict(path: &[String]) -> AppError {
    AppError::Config(format!(
        "Codex 通用配置投影存在表与值冲突，不能替换父表或删除兄弟键: {}",
        path.join(".")
    ))
}

fn same_item(left: &Item, right: &Item) -> bool {
    match (canonical_toml_item(left), canonical_toml_item(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn encode_item(item: &Item) -> Result<String, AppError> {
    if canonical_toml_item(item).is_none() {
        return Err(invalid_ledger());
    }
    let mut doc = DocumentMut::new();
    doc.insert("v", item.clone());
    Ok(doc.to_string())
}

fn decode_item(text: &str) -> Result<Item, AppError> {
    let doc = text.parse::<DocumentMut>().map_err(|_| invalid_ledger())?;
    if doc.iter().count() != 1 {
        return Err(invalid_ledger());
    }
    let item = doc.get("v").ok_or_else(invalid_ledger)?;
    if canonical_toml_item(item).is_none() {
        return Err(invalid_ledger());
    }
    Ok(item.clone())
}

fn get_path<'a>(table: &'a dyn TableLike, path: &[String]) -> Option<&'a Item> {
    let (first, rest) = path.split_first()?;
    let item = table.get(first)?;
    if rest.is_empty() {
        Some(item)
    } else {
        get_path(item.as_table_like()?, rest)
    }
}

/// Leaves merge individually; arrays (including arrays of tables) are atomic
/// values and their full previous contents are saved. Empty tables are leaves.
fn collect_leaves(table: &dyn TableLike, path: &mut Vec<String>, out: &mut DesiredItems) {
    for (key, item) in table.iter() {
        path.push(key.to_string());
        match item.as_table_like() {
            Some(child) if !child.is_empty() => collect_leaves(child, path, out),
            _ => {
                out.insert(path.clone(), item.clone());
            }
        }
        path.pop();
    }
}

fn check_replacement(current: &Item, replacement: &Item) -> bool {
    // Inserting an array of tables into an inline parent converts it to an
    // array of inline tables. These are the same atomic shape, not a conflict.
    let both_arrays = (current.is_array() || current.is_array_of_tables())
        && (replacement.is_array() || replacement.is_array_of_tables());
    same_item(current, replacement)
        || (!current.is_table_like()
            && !replacement.is_table_like()
            && (both_arrays || current.is_array_of_tables() == replacement.is_array_of_tables()))
}

/// Check the whole destination before creating any parents. Nonempty tables
/// are never replaced wholesale, including when an empty table is requested.
fn check_path(table: &dyn TableLike, path: &[String], item: &Item) -> Result<(), AppError> {
    let mut parent = table;
    for (index, key) in path.iter().enumerate() {
        let Some(current) = parent.get(key) else {
            return Ok(());
        };
        if index + 1 == path.len() {
            if !check_replacement(current, item) {
                return Err(path_conflict(path));
            }
        } else {
            parent = current
                .as_table_like()
                .ok_or_else(|| path_conflict(&path[..=index]))?;
        }
    }
    Ok(())
}

// Only used after check_path (or on a fresh document for ledger validation).
fn insert_path(table: &mut dyn TableLike, path: &[String], item: Item) {
    match path {
        [] => {}
        [last] => {
            table.insert(last, item);
        }
        [first, rest @ ..] => {
            if table.get(first).is_none() {
                let mut child = Table::new();
                child.set_implicit(true);
                table.insert(first, Item::Table(child));
            }
            if let Some(parent) = table.get_mut(first) {
                if let Some(child) = parent.as_table_like_mut() {
                    insert_path(child, rest, item);
                }
                // A value cloned from a normal table may carry a line comment.
                // Such decoration is not valid between inline-table fields.
                if let Some(inline) = parent.as_inline_table_mut() {
                    inline.fmt();
                }
            }
        }
    }
}

fn remove_path(table: &mut dyn TableLike, path: &[String]) -> bool {
    match path {
        [] => false,
        [last] => table.remove(last).is_some(),
        [first, rest @ ..] => {
            let Some(child) = table.get_mut(first).and_then(Item::as_table_like_mut) else {
                return false;
            };
            remove_path(child, rest)
        }
    }
}

fn parse_ledger(text: Option<&str>) -> Result<(Vec<ParsedEntry>, BTreeSet<Vec<String>>), AppError> {
    let Some(text) = text else {
        return Ok((Vec::new(), BTreeSet::new()));
    };
    let ledger: ProjectionLedger = serde_json::from_str(text).map_err(|_| invalid_ledger())?;
    if ledger.version != LEDGER_VERSION {
        return Err(AppError::Config(
            "Codex 通用配置投影记录版本不受支持".to_string(),
        ));
    }
    let mut paths = BTreeSet::new();
    let mut entries = Vec::new();
    for record in ledger.entries {
        if record.path.is_empty() || !paths.insert(record.path.clone()) {
            return Err(invalid_ledger());
        }
        let applied = decode_item(&record.applied_toml)?;
        // Generated records always describe leaves, not overlapping subtrees.
        if applied
            .as_table_like()
            .is_some_and(|table| !table.is_empty())
        {
            return Err(invalid_ledger());
        }
        let original = record
            .original_toml
            .as_deref()
            .map(decode_item)
            .transpose()?;
        if original
            .as_ref()
            .is_some_and(|original| !check_replacement(original, &applied))
        {
            return Err(invalid_ledger());
        }
        let mut probe = DocumentMut::new();
        insert_path(probe.as_table_mut(), &record.path, applied.clone());
        // A damaged ledger must not gain authority over line/execution keys.
        validate_codex_common_snippet(&probe.to_string()).map_err(|_| invalid_ledger())?;
        entries.push(ParsedEntry {
            record,
            applied,
            original,
        });
    }
    let ordered: Vec<_> = paths.iter().collect();
    if ordered
        .windows(2)
        .any(|pair| pair[1].starts_with(pair[0].as_slice()))
    {
        return Err(invalid_ledger());
    }
    // Parent cleanup has authority only over ancestors of recorded common leaves.
    if ledger.created_parents.iter().any(|parent| {
        parent.is_empty()
            || !paths
                .iter()
                .any(|path| path.len() > parent.len() && path.starts_with(parent))
    }) {
        return Err(invalid_ledger());
    }
    Ok((entries, ledger.created_parents))
}

/// Prune only tables created by this projection, never pre-existing user tables.
fn prune_created_parents(doc: &mut DocumentMut, parents: &mut BTreeSet<Vec<String>>) -> bool {
    let mut ordered: Vec<_> = parents.iter().cloned().collect();
    ordered.sort_by_key(|path| std::cmp::Reverse(path.len()));
    let mut changed = false;
    for path in ordered {
        if get_path(doc.as_table(), &path)
            .and_then(Item::as_table_like)
            .is_some_and(|table| table.is_empty())
        {
            changed |= remove_path(doc.as_table_mut(), &path);
        }
    }
    parents.retain(|path| get_path(doc.as_table(), path).is_some());
    changed
}

fn snippet_items(snippet: Option<&CodexCommonSnippet>) -> Result<DesiredItems, AppError> {
    let mut desired = DesiredItems::new();
    if let Some(snippet) = snippet {
        validate_codex_common_snippet(&snippet.text)?;
        if snippet.enabled {
            let doc = snippet
                .text
                .parse::<DocumentMut>()
                .map_err(|_| AppError::Config("Codex 通用配置 TOML 语法无效".to_string()))?;
            collect_leaves(doc.as_table(), &mut Vec::new(), &mut desired);
        }
    }
    Ok(desired)
}

fn parse_live(live: &str) -> Result<DocumentMut, AppError> {
    live.parse::<DocumentMut>()
        .map_err(|_| AppError::Config("Codex 当前配置 TOML 语法无效，无法投影通用配置".to_string()))
}

fn serialize_ledger(
    entries: Vec<ProjectionEntry>,
    created_parents: BTreeSet<Vec<String>>,
) -> Result<String, AppError> {
    serde_json::to_string_pretty(&ProjectionLedger {
        version: LEDGER_VERSION,
        entries,
        created_parents,
    })
    .map_err(|_| invalid_ledger())
}

/// Seed a missing legacy ledger before the first common update or cleanup.
/// Only enabled, strictly valid snippet leaves equal to live are claimed;
/// mismatched or missing leaves are left unclaimed. Their original values
/// cannot be inferred, so every seeded record has `original_toml: None`.
/// This returns JSON only: it never applies the snippet or changes live.
/// Disabled snippets are still validated but produce an empty ledger.
pub(crate) fn seed_legacy(
    live: &str,
    old_snippet: &CodexCommonSnippet,
) -> Result<String, AppError> {
    let desired = snippet_items(Some(old_snippet))?;
    let live = parse_live(live)?;
    let mut entries = Vec::new();
    for (path, applied) in desired {
        if get_path(live.as_table(), &path).is_some_and(|current| same_item(current, &applied)) {
            entries.push(ProjectionEntry {
                path,
                applied_toml: encode_item(&applied)?,
                original_toml: None,
            });
        }
    }
    serialize_ledger(entries, BTreeSet::new())
}

/// Reconcile only common keys. `None`, a disabled snippet, or an enabled empty
/// snippet removes the old projection. A user's changed value is never undone
/// during cleanup. Reapplying the same desired value preserves that edit and
/// retains the old desired/original record; changing desired explicitly starts
/// a new projection over the current value. The caller must pass live before
/// merging the new common snippet, otherwise its original values are lost.
/// No filesystem I/O is performed.
pub(crate) fn project(
    live: &str,
    snippet: Option<&CodexCommonSnippet>,
    ledger_json: Option<&str>,
) -> Result<(String, String), AppError> {
    let mut desired = snippet_items(snippet)?;
    let (old_entries, mut created_parents) = parse_ledger(ledger_json)?;
    let mut out = parse_live(live)?;
    let mut records = BTreeMap::new();
    let mut changed = false;

    // Undo removed or changed intent before applying new keys. Unchanged
    // intent retains its original snapshot even when live was manually edited.
    for entry in old_entries {
        let path = &entry.record.path;
        if desired
            .get(path)
            .is_some_and(|item| same_item(item, &entry.applied))
        {
            desired.remove(path);
            records.insert(path.clone(), entry.record);
            continue;
        }
        if get_path(out.as_table(), path).is_some_and(|item| same_item(item, &entry.applied)) {
            if let Some(original) = entry.original {
                check_path(out.as_table(), path, &original)?;
                if !same_item(&original, &entry.applied) {
                    insert_path(out.as_table_mut(), path, original);
                    changed = true;
                }
            } else {
                changed |= remove_path(out.as_table_mut(), path);
            }
        }
    }

    changed |= prune_created_parents(&mut out, &mut created_parents);
    for (path, item) in desired {
        check_path(out.as_table(), &path, &item)?;
        for length in 1..path.len() {
            let parent = &path[..length];
            if get_path(out.as_table(), parent).is_none() {
                created_parents.insert(parent.to_vec());
            }
        }
        let original = get_path(out.as_table(), &path).cloned();
        let record = ProjectionEntry {
            path: path.clone(),
            applied_toml: encode_item(&item)?,
            original_toml: original.as_ref().map(encode_item).transpose()?,
        };
        if !original
            .as_ref()
            .is_some_and(|original| same_item(original, &item))
        {
            insert_path(out.as_table_mut(), &path, item);
            changed = true;
        }
        records.insert(path, record);
    }

    // Once no common leaf remains beneath a parent, release its cleanup authority.
    created_parents.retain(|parent| {
        records
            .keys()
            .any(|path| path.len() > parent.len() && path.starts_with(parent))
    });
    let json = serialize_ledger(records.into_values().collect(), created_parents)?;
    Ok((
        if changed {
            out.to_string()
        } else {
            live.to_string()
        },
        json,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn enabled(text: &str) -> CodexCommonSnippet {
        CodexCommonSnippet {
            text: text.to_string(),
            enabled: true,
        }
    }

    fn values(text: &str) -> toml::Table {
        toml::from_str(text).unwrap()
    }

    fn ledger(text: &str) -> ProjectionLedger {
        serde_json::from_str(text).unwrap()
    }

    fn assert_empty_ledger(text: &str) {
        let ledger = ledger(text);
        assert_eq!(ledger.version, LEDGER_VERSION);
        assert!(ledger.entries.is_empty());
    }

    fn entry_json(path: &[&str], applied: &str, original: Option<&str>) -> Value {
        json!({ "path": path, "applied_toml": applied, "original_toml": original })
    }

    fn ledger_json(entries: Vec<Value>) -> String {
        json!({ "version": LEDGER_VERSION, "entries": entries }).to_string()
    }

    #[test]
    fn cleanup_preserves_preexisting_empty_normal_and_inline_tables() {
        for live in ["[tui]\n", "tui = {}\n"] {
            let common = enabled("[tui]\nnotifications = true\n");
            let (applied, saved) = project(live, Some(&common), None).unwrap();
            let (restored, next) = project(&applied, None, Some(&saved)).unwrap();
            assert_eq!(values(&restored), values(live));
            assert_empty_ledger(&next);
        }
    }

    #[test]
    fn shared_generated_parents_are_removed_only_after_last_common_leaf() {
        let common = enabled("[tui]\nnotifications = true\nanimations = false\n");
        let (applied, saved) = project("", Some(&common), None).unwrap();
        let remaining = enabled("[tui]\nnotifications = true\n");
        let (partial, next) = project(&applied, Some(&remaining), Some(&saved)).unwrap();
        assert!(values(&partial).contains_key("tui"));
        let (restored, final_ledger) = project(&partial, None, Some(&next)).unwrap();
        assert!(values(&restored).is_empty());
        assert_empty_ledger(&final_ledger);
    }

    #[test]
    fn enabling_and_disabling_restore_overwritten_values_and_remove_added_keys() {
        let live = "# line and shared values\nmodel = 'line-model'\napproval_policy = 'on-request'\n[tui]\nnotifications = true\nkeep = 7\n[agents]\ndefault_subagent_model = 'line-mini'\nmax_threads = 4\n";
        let on = enabled("approval_policy = 'never'\npersonality = 'friendly'\n[tui]\nnotifications = false\n[agents]\nmax_threads = 8\n");
        let (applied, saved) = project(live, Some(&on), None).unwrap();
        assert_eq!(values(&applied)["approval_policy"].as_str(), Some("never"));
        assert_eq!(ledger(&saved).entries.len(), 4);
        let off = CodexCommonSnippet {
            enabled: false,
            ..on
        };
        let (restored, saved) = project(&applied, Some(&off), Some(&saved)).unwrap();
        assert_eq!(values(&restored), values(live));
        assert_empty_ledger(&saved);
    }

    #[test]
    fn absent_empty_or_comments_only_snippet_clears_the_projection() {
        let live = "model = 'line-model'\n";
        let on = enabled("personality = 'friendly'\n[tui]\nnotifications = false\n");
        let (applied, saved) = project(live, Some(&on), None).unwrap();
        for snippet in [None, Some(enabled("")), Some(enabled(" # cleared\n"))] {
            let (restored, next) = project(&applied, snippet.as_ref(), Some(&saved)).unwrap();
            assert_eq!(values(&restored), values(live));
            assert_empty_ledger(&next);
        }
    }

    #[test]
    fn deleting_one_common_key_only_cleans_that_key() {
        let live = "approval_policy = 'on-request'\n[tui]\nnotifications = true\nkeep = 7\n";
        let on = enabled("approval_policy = 'never'\n[tui]\nnotifications = false\n");
        let (applied, saved) = project(live, Some(&on), None).unwrap();
        let reduced = enabled("[tui]\nnotifications = false\n");
        let (updated, next) = project(&applied, Some(&reduced), Some(&saved)).unwrap();
        let doc = values(&updated);
        assert_eq!(doc["approval_policy"].as_str(), Some("on-request"));
        assert_eq!(doc["tui"]["notifications"].as_bool(), Some(false));
        assert_eq!(doc["tui"]["keep"].as_integer(), Some(7));
        assert_eq!(ledger(&next).entries.len(), 1);
        let (restored, _) = project(&updated, None, Some(&next)).unwrap();
        assert_eq!(values(&restored), values(live));
    }

    #[test]
    fn changing_desired_keeps_the_original_baseline() {
        let live = "personality = 'original'\n";
        let (first, saved) =
            project(live, Some(&enabled("personality = 'first'\n")), None).unwrap();
        let (second, next) = project(
            &first,
            Some(&enabled("personality = 'second'\n")),
            Some(&saved),
        )
        .unwrap();
        assert_eq!(values(&second)["personality"].as_str(), Some("second"));
        assert_eq!(
            ledger(&saved).entries[0].original_toml,
            ledger(&next).entries[0].original_toml
        );
        let (restored, _) = project(&second, None, Some(&next)).unwrap();
        assert_eq!(values(&restored), values(live));
    }

    #[test]
    fn same_desired_keeps_manual_edits_and_the_desired_original_record() {
        let live = "personality = 'original'\n";
        let on = enabled("personality = 'desired'\n");
        let (_, saved) = project(live, Some(&on), None).unwrap();
        let manual = "# user formatting and changed value\r\npersonality  = 'manual'\r\n";
        let (kept, next) = project(manual, Some(&on), Some(&saved)).unwrap();
        assert_eq!(kept, manual);
        assert_eq!(next, saved);
        let (kept, next) = project(&kept, None, Some(&next)).unwrap();
        assert_eq!(kept, manual);
        assert_empty_ledger(&next);
    }

    #[test]
    fn new_desired_may_override_a_manual_edit_and_then_restore_it() {
        let first = enabled("personality = 'first'\n");
        let (_, saved) = project("personality = 'original'\n", Some(&first), None).unwrap();
        let manual = "personality = 'manual'\n";
        let second = enabled("personality = 'second'\n");
        let (updated, next) = project(manual, Some(&second), Some(&saved)).unwrap();
        assert_eq!(values(&updated)["personality"].as_str(), Some("second"));
        let original =
            decode_item(ledger(&next).entries[0].original_toml.as_deref().unwrap()).unwrap();
        assert_eq!(original.as_str(), Some("manual"));
        let (restored, _) = project(&updated, None, Some(&next)).unwrap();
        assert_eq!(values(&restored), values(manual));
    }

    #[test]
    fn same_desired_does_not_recreate_a_manually_deleted_key() {
        let on = enabled("personality = 'first'\n");
        let (_, saved) = project("", Some(&on), None).unwrap();
        let (kept, next) = project("# user deleted the key\n", Some(&on), Some(&saved)).unwrap();
        assert_eq!(kept, "# user deleted the key\n");
        assert_eq!(saved, next);
        let (updated, next) = project(
            &kept,
            Some(&enabled("personality = 'second'\n")),
            Some(&next),
        )
        .unwrap();
        assert_eq!(values(&updated)["personality"].as_str(), Some("second"));
        assert!(ledger(&next).entries[0].original_toml.is_none());
        let (restored, _) = project(&updated, None, Some(&next)).unwrap();
        assert!(values(&restored).is_empty());
    }

    #[test]
    fn changed_parent_is_kept_until_a_new_desired_value_hits_a_shape_conflict() {
        let on = enabled("[tui]\nnotifications = false\n");
        let (_, saved) = project("", Some(&on), None).unwrap();
        let manual = "tui = 'a4-private-value'\n";
        let (kept, next) = project(manual, Some(&on), Some(&saved)).unwrap();
        assert_eq!(kept, manual);
        assert_eq!(next, saved);
        let error = project(
            manual,
            Some(&enabled("[tui]\nnotifications = true\n")),
            Some(&saved),
        )
        .unwrap_err();
        assert!(error.to_string().contains("tui"));
        assert!(!error.to_string().contains("a4-private-value"));
        let (kept, next) = project(manual, None, Some(&saved)).unwrap();
        assert_eq!(kept, manual);
        assert_empty_ledger(&next);
    }

    #[test]
    fn cleanup_uses_semantic_equality_not_source_formatting() {
        let on = enabled("shared = [{ b = 2, a = 1 }]\n");
        let (_, saved) = project("shared = [{ original = true }]\n", Some(&on), None).unwrap();
        let equivalent = "shared=[{a=1,b=2}] # only formatting changed\n";
        let (restored, next) = project(equivalent, None, Some(&saved)).unwrap();
        assert_eq!(
            values(&restored),
            values("shared = [{ original = true }]\n")
        );
        assert_empty_ledger(&next);
    }

    #[test]
    fn cleanup_and_updates_are_independent_for_sibling_keys() {
        let live = "[tui]\nnotifications = true\nkeep = 7\n";
        let on = enabled("[tui]\nnotifications = false\nshared = 'first'\n");
        let (_, saved) = project(live, Some(&on), None).unwrap();
        let manual = "[tui]\nnotifications = 'manual'\nshared = 'first'\nkeep = 9\n";
        let updated = enabled("[tui]\nnotifications = false\nshared = 'second'\n");
        let (applied, next) = project(manual, Some(&updated), Some(&saved)).unwrap();
        assert_eq!(
            values(&applied)["tui"]["notifications"].as_str(),
            Some("manual")
        );
        assert_eq!(values(&applied)["tui"]["shared"].as_str(), Some("second"));
        assert_eq!(values(&applied)["tui"]["keep"].as_integer(), Some(9));
        let (restored, _) = project(&applied, None, Some(&next)).unwrap();
        let doc = values(&restored);
        assert_eq!(doc["tui"]["notifications"].as_str(), Some("manual"));
        assert_eq!(doc["tui"]["keep"].as_integer(), Some(9));
        assert!(doc["tui"].get("shared").is_none());
    }

    #[test]
    fn table_scalar_and_empty_table_conflicts_are_rejected_without_values() {
        for (live, snippet, key) in [
            (
                "tui = 'a4-private-value'\n",
                "[tui]\nnotifications = false\n",
                "tui",
            ),
            ("[tui]\nkeep = 'a4-private-value'\n", "tui = false\n", "tui"),
            ("[tui]\nkeep = 'a4-private-value'\n", "tui = {}\n", "tui"),
            (
                "tui = { keep = 'a4-private-value' }\n",
                "tui = false\n",
                "tui",
            ),
            (
                "[[shared]]\nkeep = 'a4-private-value'\n",
                "shared = false\n",
                "shared",
            ),
            (
                "[tui]\nnotifications = { keep = 'a4-private-value' }\n",
                "[tui]\nnotifications = false\n",
                "tui.notifications",
            ),
        ] {
            let error = project(live, Some(&enabled(snippet)), None).unwrap_err();
            assert!(error.to_string().contains(key), "{error}");
            assert!(!error.to_string().contains("a4-private-value"), "{error}");
        }
    }

    #[test]
    fn inline_table_siblings_survive_projection_and_cleanup() {
        let live = "tui = { keep = 7, notifications = true }\n";
        let on = enabled("[tui]\nnotifications = false\nnew_key = 8\n");
        let (applied, saved) = project(live, Some(&on), None).unwrap();
        assert_eq!(values(&applied)["tui"]["keep"].as_integer(), Some(7));
        let (restored, _) = project(&applied, None, Some(&saved)).unwrap();
        assert_eq!(values(&restored), values(live));
    }

    #[test]
    fn overwritten_arrays_of_tables_are_fully_recorded_and_restored() {
        let live = "[[shared]]\nname = 'first'\nargs = ['a', 'b']\n[shared.extra]\nkeep = 7\n[[shared]]\nname = 'second'\n";
        let on = enabled("[[shared]]\nname = 'desired'\nargs = ['new']\n");
        let (applied, saved) = project(live, Some(&on), None).unwrap();
        let original = ledger(&saved).entries.remove(0).original_toml.unwrap();
        let original = decode_item(&original).unwrap();
        let live_doc = live.parse::<DocumentMut>().unwrap();
        assert!(same_item(&original, live_doc.get("shared").unwrap()));
        let (restored, _) = project(&applied, None, Some(&saved)).unwrap();
        assert_eq!(values(&restored), values(live));
    }

    #[test]
    fn inline_parent_arrays_of_tables_round_trip_across_desired_updates() {
        let live = "shared = { keep = 7, slots = [{ name = 'original', args = ['a', 'b'] }] }\n";
        let first = enabled("[[shared.slots]]\nname = 'first'\n");
        let (applied, saved) = project(live, Some(&first), None).unwrap();
        assert_eq!(values(&applied)["shared"]["keep"].as_integer(), Some(7));
        assert_eq!(
            values(&applied)["shared"]["slots"][0]["name"].as_str(),
            Some("first")
        );
        let second = enabled("[[shared.slots]]\nname = 'second'\nargs = ['new']\n");
        let (updated, saved) = project(&applied, Some(&second), Some(&saved)).unwrap();
        assert_eq!(
            values(&updated)["shared"]["slots"][0]["name"].as_str(),
            Some("second")
        );
        let (restored, next) = project(&updated, None, Some(&saved)).unwrap();
        assert_eq!(values(&restored), values(live));
        assert_empty_ledger(&next);
    }

    #[test]
    fn quoted_and_dotted_keys_keep_their_individual_path_components() {
        let on = enabled("[tui]\n\"color.style\" = 'dark'\n[profiles.\"work.with.dots\"]\napproval_policy = 'never'\n");
        let (applied, saved) = project("", Some(&on), None).unwrap();
        let paths: Vec<_> = ledger(&saved)
            .entries
            .into_iter()
            .map(|entry| entry.path)
            .collect();
        assert!(paths.contains(&vec!["tui".to_string(), "color.style".to_string()]));
        assert!(paths.contains(&vec![
            "profiles".to_string(),
            "work.with.dots".to_string(),
            "approval_policy".to_string()
        ]));
        let (restored, _) = project(&applied, None, Some(&saved)).unwrap();
        assert!(values(&restored).is_empty());
    }

    #[test]
    fn reapplying_a_projection_is_idempotent() {
        let on = enabled("approval_policy = 'never'\n[tui]\nnotifications = false\n");
        let (first, saved) = project("", Some(&on), None).unwrap();
        let (second, next) = project(&first, Some(&on), Some(&saved)).unwrap();
        assert_eq!(second, first);
        assert_eq!(next, saved);
    }

    #[test]
    fn already_equal_live_values_are_not_removed_when_common_is_disabled() {
        let live = "# unchanged formatting\r\napproval_policy  = 'never'\r\n";
        let on = enabled("approval_policy = \"never\"\n");
        let (first, saved) = project(live, Some(&on), None).unwrap();
        assert_eq!(first, live);
        assert!(ledger(&saved).entries[0].original_toml.is_some());
        let (restored, next) = project(&first, None, Some(&saved)).unwrap();
        assert_eq!(restored, live);
        assert_empty_ledger(&next);
    }

    #[test]
    fn an_empty_ledger_is_not_legacy_bootstrapping() {
        let live = "# no inference from snippet\napproval_policy = 'never'\n";
        let off = CodexCommonSnippet {
            text: "approval_policy = 'never'\n".to_string(),
            enabled: false,
        };
        let (kept, saved) = project(live, Some(&off), None).unwrap();
        assert_eq!(kept, live);
        assert_empty_ledger(&saved);
        assert_eq!(BACKUP_KEY, "chimera_common_projection");
    }

    #[test]
    fn invalid_or_owned_snippets_are_rejected_even_when_disabled() {
        for text in [
            "model = 'a4-private-value'\n",
            "[model_providers.custom]\nbase_url = 'a4-private-value'\n",
            "profiles.work.memories.extract_model = 'a4-private-value'\n",
            "features = false\n",
            "notify = ['a4-private-value']\n",
            "approval_policy = 'a4-private-value'\n[unfinished\n",
        ] {
            for enabled in [true, false] {
                let snippet = CodexCommonSnippet {
                    text: text.to_string(),
                    enabled,
                };
                let error = project("", Some(&snippet), None).unwrap_err();
                assert!(!error.to_string().contains("a4-private-value"), "{error}");
            }
        }
    }

    #[test]
    fn legacy_seed_claims_only_enabled_matching_leaves_without_changing_inputs() {
        let live = "# exact input remains untouched\r\nmodel = 'line-model'\r\napproval_policy = 'never'\r\npersonality = 'manual'\r\n[tui]\r\nnotifications = false\r\nkeep = 7\r\n".to_string();
        let before = live.clone();
        let old = enabled("approval_policy = \"never\"\npersonality = 'old'\nmissing = true\n[tui]\nnotifications = false\nmissing = true\n");
        let old_text = old.text.clone();
        let saved = seed_legacy(&live, &old).unwrap();
        let seeded = ledger(&saved);
        let paths: Vec<_> = seeded
            .entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect();
        assert_eq!(
            paths,
            vec![
                vec!["approval_policy".to_string()],
                vec!["tui".to_string(), "notifications".to_string()]
            ]
        );
        assert!(seeded
            .entries
            .iter()
            .all(|entry| entry.original_toml.is_none()));
        assert_eq!(live, before);
        assert_eq!(old.text, old_text);
        let (cleared, next) = project(&live, None, Some(&saved)).unwrap();
        let doc = values(&cleared);
        assert!(doc.get("approval_policy").is_none());
        assert!(doc["tui"].get("notifications").is_none());
        assert_eq!(doc["personality"].as_str(), Some("manual"));
        assert_eq!(doc["model"].as_str(), Some("line-model"));
        assert_eq!(doc["tui"]["keep"].as_integer(), Some(7));
        assert_empty_ledger(&next);
    }

    #[test]
    fn legacy_seed_disabled_empty_or_unmatched_snippets_claim_nothing() {
        let live = "approval_policy = 'never'\ntui = 'manual-parent'\n";
        let off = CodexCommonSnippet {
            enabled: false,
            ..enabled("approval_policy = 'never'\n")
        };
        for old in [
            off,
            enabled(""),
            enabled("# empty common\n"),
            enabled("approval_policy = 'on-request'\n[tui]\nnotifications = false\n"),
        ] {
            let saved = seed_legacy(live, &old).unwrap();
            assert_empty_ledger(&saved);
            let (kept, _) = project(live, None, Some(&saved)).unwrap();
            assert_eq!(kept, live);
        }
    }

    #[test]
    fn legacy_seed_uses_semantic_equality_and_individual_quoted_paths() {
        let live = "shared = [{ b = 2, a = 1 }]\n[tui]\n\"color.style\" = 'dark'\n[profiles.\"work.with.dots\"]\napproval_policy = 'never'\n";
        let old = enabled("[[shared]]\na = 1\nb = 2\n[tui]\n\"color.style\" = \"dark\"\n[profiles.\"work.with.dots\"]\napproval_policy = \"never\"\n");
        let saved = seed_legacy(live, &old).unwrap();
        let seeded = ledger(&saved);
        assert_eq!(seeded.entries.len(), 3);
        assert!(seeded
            .entries
            .iter()
            .any(|entry| entry.path == ["tui", "color.style"]));
        assert!(seeded
            .entries
            .iter()
            .any(|entry| entry.path == ["profiles", "work.with.dots", "approval_policy"]));
        let (cleared, next) = project(live, None, Some(&saved)).unwrap();
        let cleared = values(&cleared);
        assert!(cleared.get("shared").is_none());
        assert!(cleared["tui"].get("color.style").is_none());
        assert!(cleared["profiles"]["work.with.dots"]
            .get("approval_policy")
            .is_none());
        // Legacy seeding cannot prove these empty parents were projection-created.
        assert!(cleared["tui"]
            .as_table()
            .is_some_and(|table| table.is_empty()));
        assert!(cleared["profiles"]["work.with.dots"]
            .as_table()
            .is_some_and(|table| table.is_empty()));
        assert_empty_ledger(&next);
    }

    #[test]
    fn legacy_seed_does_not_claim_whole_tables_or_prefix_collisions() {
        let live = "personality = { keep = 7 }\n[tui]\nnotifications = { keep = 9 }\n";
        let old = enabled("personality = 'friendly'\n[tui]\nnotifications = false\n");
        let saved = seed_legacy(live, &old).unwrap();
        assert_empty_ledger(&saved);
        let (kept, _) = project(live, None, Some(&saved)).unwrap();
        assert_eq!(kept, live);
    }

    #[test]
    fn legacy_seed_allows_first_update_and_preserves_unclaimed_manual_values() {
        let live = "personality = 'old'\napproval_policy = 'manual'\n";
        let old = enabled("personality = 'old'\napproval_policy = 'never'\n");
        let saved = seed_legacy(live, &old).unwrap();
        let new = enabled("personality = 'new'\napproval_policy = 'on-request'\n");
        let (updated, saved) = project(live, Some(&new), Some(&saved)).unwrap();
        assert_eq!(values(&updated)["personality"].as_str(), Some("new"));
        assert_eq!(
            values(&updated)["approval_policy"].as_str(),
            Some("on-request")
        );
        let (cleared, next) = project(&updated, None, Some(&saved)).unwrap();
        assert_eq!(values(&cleared), values("approval_policy = 'manual'\n"));
        assert_empty_ledger(&next);
    }

    #[test]
    fn legacy_seed_keeps_edits_made_after_seeding_during_first_cleanup() {
        let old = enabled("personality = 'old'\n");
        let saved = seed_legacy("personality = 'old'\n", &old).unwrap();
        let manual = "# user edited after migration\npersonality = 'manual'\n";
        let (kept, next) = project(manual, None, Some(&saved)).unwrap();
        assert_eq!(kept, manual);
        assert_empty_ledger(&next);
    }

    #[test]
    fn legacy_seed_rejects_invalid_owned_or_execution_text_without_values() {
        for text in [
            "model = 'a4-private-value'\n",
            "[profiles.work]\nmodel_provider = 'a4-private-value'\n",
            "profiles.work.agents.default_subagent_model = 'a4-private-value'\n",
            "notify = ['a4-private-value']\n",
            "[model_providers.custom]\nbase_url = 'a4-private-value'\n",
            "approval_policy = ['a4-private-value'\n",
        ] {
            for enabled in [true, false] {
                let old = CodexCommonSnippet {
                    text: text.to_string(),
                    enabled,
                };
                let error = seed_legacy("", &old).unwrap_err();
                assert!(!error.to_string().contains("a4-private-value"), "{error}");
            }
        }
        let error = seed_legacy(
            "private = ['a4-private-value'\n",
            &enabled("personality = 'old'\n"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("TOML"));
        assert!(!error.to_string().contains("a4-private-value"));
    }

    #[test]
    fn inline_parents_accept_new_nested_paths_and_commented_common_values() {
        let live = "tui = { keep = 7 }\n";
        let on = enabled("[tui.nested]\n# comment from the common document\nstyle = 'dark' # trailing common comment\n");
        let (applied, saved) = project(live, Some(&on), None).unwrap();
        let doc = values(&applied);
        assert_eq!(doc["tui"]["keep"].as_integer(), Some(7));
        assert_eq!(doc["tui"]["nested"]["style"].as_str(), Some("dark"));
        let (restored, _) = project(&applied, None, Some(&saved)).unwrap();
        assert_eq!(values(&restored), values(live));
    }

    #[test]
    fn malformed_live_does_not_echo_source_values() {
        let error = project("private = ['a4-private-value'\n", None, None).unwrap_err();
        assert!(error.to_string().contains("TOML"));
        assert!(!error.to_string().contains("a4-private-value"));
    }

    #[test]
    fn malformed_and_unknown_version_ledgers_fail_without_echoing_values() {
        for text in [
            "a4-private-value",
            "",
            "null",
            "{}",
            r#"{"version":1,"entries":"a4-private-value"}"#,
            r#"{"version":2,"entries":[]}"#,
            r#"{"version":1,"entries":[],"private":"a4-private-value"}"#,
            r#"{"version":1,"entries":[{"path":[],"applied_toml":"a4-private-value"}]}"#,
        ] {
            let error = project("", None, Some(text)).unwrap_err();
            assert!(error.to_string().contains("投影记录"), "{error}");
            assert!(!error.to_string().contains("a4-private-value"), "{error}");
        }
    }

    #[test]
    fn malformed_or_unauthorized_ledger_entries_are_rejected() {
        for entries in [
            vec![entry_json(&[], "v = 'a4-private-value'\n", None)],
            vec![entry_json(
                &["personality"],
                "bad = 'a4-private-value'\n",
                None,
            )],
            vec![entry_json(
                &["personality"],
                "v = ['a4-private-value'\n",
                None,
            )],
            vec![entry_json(
                &["personality"],
                "v = 1\nextra = 'a4-private-value'\n",
                None,
            )],
            vec![entry_json(
                &["personality"],
                "v = 1\n",
                Some("bad = 'a4-private-value'\n"),
            )],
            vec![entry_json(
                &["tui"],
                "[v]\nkeep = 'a4-private-value'\n",
                None,
            )],
            vec![entry_json(
                &["tui"],
                "v = false\n",
                Some("[v]\nkeep = 'a4-private-value'\n"),
            )],
            vec![entry_json(&["model"], "v = 'a4-private-value'\n", None)],
            vec![entry_json(
                &["profiles", "work", "model_provider"],
                "v = 'a4-private-value'\n",
                None,
            )],
            vec![entry_json(&["agents"], "[v]\n", None)],
            vec![
                entry_json(&["personality"], "v = 'a4-private-value'\n", None),
                entry_json(&["personality"], "v = 1\n", None),
            ],
            vec![
                entry_json(&["tui"], "[v]\n", None),
                entry_json(&["tui", "notifications"], "v = false\n", None),
            ],
        ] {
            let error = project("", None, Some(&ledger_json(entries))).unwrap_err();
            assert!(error.to_string().contains("投影记录"), "{error}");
            assert!(!error.to_string().contains("a4-private-value"), "{error}");
        }
    }
}
