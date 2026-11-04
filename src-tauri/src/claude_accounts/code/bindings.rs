//! Folders bound to a saved login.
//!
//! A bound folder, and anything under it, opens Claude with that login when
//! it is started from here (the terminal button on a folder, or "open Claude
//! here"). Nothing outside this app is changed: no PATH entry, no shell hook.
//!
//! `<vault>/bindings.json` maps a normalized folder path to the login's id
//! and email. The id is tried first; if the login was deleted and added
//! again (a new id), the email finds it.

use std::collections::BTreeMap;

use super::*;

const BINDINGS_FILE: &str = "bindings.json";
const BINDINGS_VERSION: u32 = 1;
const MAX_BINDINGS: usize = 200;
const MAX_PATH_LEN: usize = 1024;
const MAX_BINDINGS_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    /// The path as the user chose it (separators and case normalized for display).
    path: String,
    account_id: String,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: BTreeMap<String, Entry>,
}

/// Where a binding stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingState {
    Ready,
    /// The login was deleted.
    Missing,
    /// The login is held out of use.
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingDto {
    pub path: String,
    pub account_id: String,
    pub account_name: Option<String>,
    pub account_email: Option<String>,
    pub state: BindingState,
    /// The folder is gone (a drive that is not mounted, a deleted project).
    pub path_missing: bool,
}

fn bindings_path(vault: &CodeVault) -> PathBuf {
    vault.root.join(BINDINGS_FILE)
}

/// The path without the `\\?\` prefix, with `\` separators and no trailing
/// separator (a drive root keeps its one).
pub(crate) fn display_path(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        text = format!(r"\\{rest}");
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        text = rest.to_string();
    }
    if cfg!(windows) {
        text = text.replace('/', "\\");
    }
    let root_len = if text.len() >= 3 && text.as_bytes()[1] == b':' && text.as_bytes()[2] == b'\\' {
        3
    } else {
        1
    };
    while text.len() > root_len && (text.ends_with('\\') || text.ends_with('/')) {
        text.pop();
    }
    text
}

fn key_of(display: &str) -> String {
    if cfg!(windows) {
        display.to_lowercase()
    } else {
        display.to_string()
    }
}

fn is_absolute(display: &str) -> bool {
    let bytes = display.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    drive || display.starts_with(r"\\") || (!cfg!(windows) && display.starts_with('/'))
}

/// A folder path accepted for binding: absolute, no control characters, no `"`
/// (cmd would end its quoting there), not too long.
pub(crate) fn check_path(raw: &str) -> Result<(String, String), AppError> {
    let display = display_path(raw);
    let invalid = |message: &str| Err(AppError::InvalidInput(message.to_string()));
    if display.is_empty() || display.len() > MAX_PATH_LEN {
        return invalid("目录路径为空或太长");
    }
    if display.chars().any(|c| c.is_control() || c == '"') {
        return invalid("目录路径里有不能使用的字符");
    }
    if !is_absolute(&display) {
        return invalid("请选择一个完整的目录路径");
    }
    let key = key_of(&display);
    Ok((key, display))
}

fn read_file(vault: &CodeVault) -> Result<Store, AppError> {
    let path = bindings_path(vault);
    match read_limited(&path, MAX_BINDINGS_BYTES) {
        Ok(bytes) => {
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| AppError::Message("目录绑定文件不是 UTF-8 文本".to_string()))?;
            serde_json::from_str(strip_bom(text)).map_err(|_| {
                AppError::Message(
                    "目录绑定文件已损坏，已停止修改它。请修复或删除 bindings.json 后重试。"
                        .to_string(),
                )
            })
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Store::default()),
        Err(error) => Err(AppError::io(&path, error)),
    }
}

fn write_file(vault: &CodeVault, file: &mut Store) -> Result<(), AppError> {
    file.version = BINDINGS_VERSION;
    let data =
        serde_json::to_vec_pretty(file).map_err(|e| AppError::JsonSerialize { source: e })?;
    private_write(&bindings_path(vault), &data)
}

fn find_account(vault: &CodeVault, entry: &Entry) -> Option<Slot> {
    let slots = vault.readable_slots();
    slots
        .iter()
        .find(|slot| slot.id == entry.account_id)
        .or_else(|| {
            let email = entry.email.as_deref()?;
            slots.iter().find(|slot| {
                slot.identity()
                    .email
                    .as_deref()
                    .is_some_and(|e| e.eq_ignore_ascii_case(email))
            })
        })
        .cloned()
}

fn dto_of(vault: &CodeVault, entry: &Entry) -> BindingDto {
    let slot = find_account(vault, entry);
    BindingDto {
        path: entry.path.clone(),
        account_id: slot
            .as_ref()
            .map_or_else(|| entry.account_id.clone(), |slot| slot.id.clone()),
        account_name: slot.as_ref().map(|slot| slot.name.clone()),
        account_email: slot.as_ref().and_then(|slot| slot.identity().email),
        state: match &slot {
            None => BindingState::Missing,
            Some(slot) if slot.disabled => BindingState::Disabled,
            Some(_) => BindingState::Ready,
        },
        path_missing: !Path::new(&entry.path).is_dir(),
    }
}

pub(crate) fn list_in(vault: &CodeVault) -> Result<Vec<BindingDto>, AppError> {
    let _guard = CODE_LOCK.lock()?;
    let file = read_file(vault)?;
    Ok(file
        .entries
        .values()
        .map(|entry| dto_of(vault, entry))
        .collect())
}

/// Binds a folder to a login (replacing an earlier binding of that folder).
pub(crate) fn set_in(
    vault: &CodeVault,
    path: &str,
    account_id: &str,
) -> Result<BindingDto, AppError> {
    ensure_supported()?;
    crate::claude_accounts::validate_account_id(account_id)?;
    let (key, display) = check_path(path)?;
    if !Path::new(&display).is_dir() {
        return Err(AppError::InvalidInput("这个目录不存在".to_string()));
    }
    let _guard = CODE_LOCK.lock()?;
    let slot = vault.read_slot(account_id)?;
    if slot.disabled {
        return Err(manage::disabled_error(&slot));
    }
    let mut file = read_file(vault)?;
    if !file.entries.contains_key(&key) && file.entries.len() >= MAX_BINDINGS {
        return Err(AppError::InvalidInput(format!(
            "最多绑定 {MAX_BINDINGS} 个目录"
        )));
    }
    let entry = Entry {
        path: display,
        account_id: slot.id.clone(),
        email: slot.identity().email,
    };
    file.entries.insert(key, entry.clone());
    write_file(vault, &mut file)?;
    Ok(dto_of(vault, &entry))
}

pub(crate) fn remove_in(vault: &CodeVault, path: &str) -> Result<(), AppError> {
    let (key, _) = check_path(path)?;
    let _guard = CODE_LOCK.lock()?;
    let mut file = read_file(vault)?;
    if file.entries.remove(&key).is_some() {
        write_file(vault, &mut file)?;
    }
    Ok(())
}

/// The nearest binding at or above `dir`.
pub(crate) fn resolve_in(vault: &CodeVault, dir: &str) -> Result<Option<BindingDto>, AppError> {
    let (key, _) = check_path(dir)?;
    let _guard = CODE_LOCK.lock()?;
    let file = read_file(vault)?;
    let best = file
        .entries
        .iter()
        .filter(|(bound, _)| {
            let bound = bound.as_str();
            key == bound
                || (key.starts_with(bound)
                    && (bound.ends_with('\\')
                        || bound.ends_with('/')
                        || key[bound.len()..].starts_with(['\\', '/'])))
        })
        .max_by_key(|(bound, _)| bound.len())
        .map(|(_, entry)| dto_of(vault, entry));
    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_accounts::code::tests::{fixture, login, Fixture};

    fn saved(f: &Fixture, email: &str, uuid: &str, token: &str) -> String {
        login(&f.paths, email, uuid, token);
        save_current_in(&f.vault, &f.paths, None).unwrap().id
    }

    #[test]
    fn paths_are_normalized_and_unsafe_ones_refused() {
        assert_eq!(display_path(r"\\?\C:\work\repo\"), r"C:\work\repo");
        assert_eq!(display_path(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(display_path(r"C:\"), r"C:\");
        if cfg!(windows) {
            assert_eq!(display_path("C:/work/repo/"), r"C:\work\repo");
            assert_eq!(check_path(r"C:\Work\Repo").unwrap().0, r"c:\work\repo");
        }
        for bad in ["", "relative\\dir", "C:\\a\"b", "C:\\a\u{7}b"] {
            assert!(check_path(bad).is_err(), "{bad:?}");
        }
        assert!(check_path(&format!("C:\\{}", "a".repeat(2000))).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_binding_covers_its_subfolders_and_the_nearest_one_wins() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a", "token-a");
        let b = saved(&f, "b@example.com", "uuid-b", "token-b");
        let work = tempfile::tempdir().unwrap();
        let sub = work.path().join("api").join("v1");
        fs::create_dir_all(&sub).unwrap();
        let work_path = work.path().to_string_lossy().to_string();

        assert!(resolve_in(&f.vault, &work_path).unwrap().is_none());
        set_in(&f.vault, &work_path, &a).unwrap();
        set_in(&f.vault, &sub.parent().unwrap().to_string_lossy(), &b).unwrap();

        let hit = |p: &Path| {
            resolve_in(&f.vault, &p.to_string_lossy())
                .unwrap()
                .map(|d| d.account_id)
        };
        assert_eq!(hit(work.path()), Some(a.clone()));
        assert_eq!(hit(&sub), Some(b.clone()), "the nearest binding wins");
        assert_eq!(hit(&work.path().join("other")), Some(a.clone()));
        // A sibling whose name only starts the same way is not inside.
        let sibling = PathBuf::from(format!("{work_path}-extra"));
        assert_eq!(hit(&sibling), None);
        // Case does not matter on Windows.
        let upper = work_path.to_uppercase();
        assert_eq!(
            resolve_in(&f.vault, &upper).unwrap().map(|d| d.account_id),
            Some(a.clone())
        );

        remove_in(&f.vault, &sub.parent().unwrap().to_string_lossy()).unwrap();
        assert_eq!(hit(&sub), Some(a));
        assert_eq!(list_in(&f.vault).unwrap().len(), 1);
    }

    #[test]
    fn a_binding_follows_its_account_through_delete_disable_and_re_adding() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a", "token-a");
        let _b = saved(&f, "b@example.com", "uuid-b", "token-b");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let dto = set_in(&f.vault, &path, &a).unwrap();
        assert_eq!(
            (dto.state, dto.account_name.as_deref()),
            (BindingState::Ready, Some("a@example.com"))
        );
        assert!(!dto.path_missing);

        manage::set_disabled_in(&f.vault, &f.paths, &a, true).unwrap();
        assert_eq!(list_in(&f.vault).unwrap()[0].state, BindingState::Disabled);
        assert!(set_in(&f.vault, &path, &a)
            .err()
            .unwrap()
            .to_string()
            .contains("已停用"));
        manage::set_disabled_in(&f.vault, &f.paths, &a, false).unwrap();

        {
            let _guard = CODE_LOCK.lock().unwrap();
            f.vault.remove_slot(&a).unwrap();
        }
        let gone = &list_in(&f.vault).unwrap()[0];
        assert_eq!(gone.state, BindingState::Missing);
        assert!(gone.account_name.is_none());

        // The same account added again has a new id; the email finds it.
        let again = saved(&f, "a@example.com", "uuid-a", "token-a2");
        assert_ne!(again, a);
        let found = &list_in(&f.vault).unwrap()[0];
        assert_eq!(
            (found.state, found.account_id.as_str()),
            (BindingState::Ready, again.as_str())
        );
    }

    #[test]
    fn a_folder_that_is_gone_is_flagged_and_bad_requests_change_nothing() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a", "token-a");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        set_in(&f.vault, &path, &a).unwrap();
        drop(dir);
        assert!(list_in(&f.vault).unwrap()[0].path_missing);

        let missing = std::env::temp_dir().join("chimera-no-such-folder-123456");
        assert!(set_in(&f.vault, &missing.to_string_lossy(), &a).is_err());
        assert!(set_in(&f.vault, "C:\\", "../x").is_err());
        assert_eq!(list_in(&f.vault).unwrap().len(), 1);
    }

    #[test]
    fn a_damaged_bindings_file_is_reported_and_never_overwritten() {
        let f = fixture();
        let a = saved(&f, "a@example.com", "uuid-a", "token-a");
        fs::write(bindings_path(&f.vault), "{ not json").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        assert!(list_in(&f.vault)
            .err()
            .unwrap()
            .to_string()
            .contains("已损坏"));
        assert!(set_in(&f.vault, &path, &a).is_err());
        assert_eq!(
            fs::read_to_string(bindings_path(&f.vault)).unwrap(),
            "{ not json"
        );
    }
}
