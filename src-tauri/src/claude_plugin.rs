use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::config::cas::{Changeset, ChangesetError, FileSnapshot};

use crate::error::AppError;

const CLAUDE_DIR: &str = ".claude";
const CLAUDE_CONFIG_FILE: &str = "config.json";
const OWNERSHIP_FILE: &str = ".chimera-plus-plus-claude-plugin";
const OWNERSHIP_RECORD: &[u8] = b"primaryApiKey=any\n";
static CONFIG_WRITE: Mutex<()> = Mutex::new(());

fn claude_dir() -> Result<PathBuf, AppError> {
    // 优先使用设置中的覆盖目录
    if let Some(dir) = crate::settings::get_claude_override_dir() {
        return Ok(dir);
    }
    let home = dirs::home_dir().ok_or_else(|| AppError::Config("无法获取用户主目录".into()))?;
    Ok(home.join(CLAUDE_DIR))
}

pub fn claude_config_path() -> Result<PathBuf, AppError> {
    Ok(claude_dir()?.join(CLAUDE_CONFIG_FILE))
}

pub fn ensure_claude_dir_exists() -> Result<PathBuf, AppError> {
    let dir = claude_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| AppError::io(&dir, e))?;
    }
    Ok(dir)
}

pub fn read_claude_config() -> Result<Option<String>, AppError> {
    let path = claude_config_path()?;
    read_config_at(&path)
}

fn read_config_at(path: &Path) -> Result<Option<String>, AppError> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io(path, error)),
    }
}

fn is_managed_config(content: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(value) => value
            .get("primaryApiKey")
            .and_then(|v| v.as_str())
            .map(|val| val == "any")
            .unwrap_or(false),
        Err(_) => false,
    }
}

pub fn write_claude_config() -> Result<bool, AppError> {
    let dir = ensure_claude_dir_exists()?;
    write_config_at(&dir.join(CLAUDE_CONFIG_FILE))
}

fn config_error(error: ChangesetError) -> AppError {
    AppError::Config(error.to_string())
}

fn config_object(
    file: &FileSnapshot,
) -> Result<serde_json::Map<String, serde_json::Value>, AppError> {
    match file.contents() {
        Some(bytes) => serde_json::from_slice(bytes).map_err(|_| {
            AppError::Config(format!("{} 必须是有效的 JSON 对象", file.path().display()))
        }),
        None => Ok(serde_json::Map::new()),
    }
}

fn config_bytes(config: &serde_json::Map<String, serde_json::Value>) -> Result<Vec<u8>, AppError> {
    let mut bytes =
        serde_json::to_vec_pretty(config).map_err(|source| AppError::JsonSerialize { source })?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn write_config_at(path: &Path) -> Result<bool, AppError> {
    let _guard = CONFIG_WRITE
        .lock()
        .map_err(|_| AppError::Config("Claude 插件配置写入锁不可用".into()))?;
    let file = FileSnapshot::read(path).map_err(config_error)?;
    let mut config = config_object(&file)?;
    if config.contains_key("primaryApiKey") {
        return Ok(false);
    }
    let ownership =
        FileSnapshot::read(path.with_file_name(OWNERSHIP_FILE)).map_err(config_error)?;
    if ownership
        .contents()
        .is_some_and(|bytes| bytes != OWNERSHIP_RECORD)
    {
        return Err(AppError::Config(
            "Claude 插件配置的所有权记录无法识别".into(),
        ));
    }
    config.insert("primaryApiKey".into(), "any".into());
    let mut change = Changeset::new();
    // Write the record last. A crash between the two writes leaves an unowned
    // key, which is deliberately preserved by clear.
    change
        .write(file, config_bytes(&config)?)
        .map_err(config_error)?;
    change
        .write_private(ownership, OWNERSHIP_RECORD)
        .map_err(config_error)?;
    change.commit().map_err(config_error)?;
    Ok(true)
}

pub fn clear_claude_config() -> Result<bool, AppError> {
    clear_config_at(&claude_config_path()?)
}

fn clear_config_at(path: &Path) -> Result<bool, AppError> {
    let _guard = CONFIG_WRITE
        .lock()
        .map_err(|_| AppError::Config("Claude 插件配置写入锁不可用".into()))?;
    let ownership =
        FileSnapshot::read(path.with_file_name(OWNERSHIP_FILE)).map_err(config_error)?;
    if ownership.contents() != Some(OWNERSHIP_RECORD) {
        return Ok(false);
    }
    let file = FileSnapshot::read(path).map_err(config_error)?;
    let mut config = config_object(&file)?;
    let remove_key = config.get("primaryApiKey").and_then(|value| value.as_str()) == Some("any");
    let mut change = Changeset::new();
    // Drop the claim first, so interrupted cleanup never leaves a stale claim
    // against a key added after our own was removed.
    change.delete(ownership).map_err(config_error)?;
    if remove_key {
        config.remove("primaryApiKey");
        change
            .write(file, config_bytes(&config)?)
            .map_err(config_error)?;
    }
    change.commit().map_err(config_error)?;
    Ok(remove_key)
}

pub fn claude_config_status() -> Result<(bool, PathBuf), AppError> {
    let path = claude_config_path()?;
    Ok((path.exists(), path))
}

pub fn is_claude_config_applied() -> Result<bool, AppError> {
    match read_claude_config()? {
        Some(content) => Ok(is_managed_config(&content)),
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_plugin_config_refuses_to_replace_unreadable_or_non_object_content() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(CLAUDE_CONFIG_FILE);
        for original in [b"{broken".as_slice(), b"[]", b"null", b"\xff"] {
            fs::write(&path, original).unwrap();
            assert!(write_config_at(&path).is_err());
            assert_eq!(fs::read(&path).unwrap(), original);
        }
    }

    #[test]
    fn claude_plugin_config_creates_merges_and_avoids_rewriting_unchanged_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(CLAUDE_CONFIG_FILE);
        assert!(write_config_at(&path).unwrap());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
            serde_json::json!({"primaryApiKey": "any"})
        );
        fs::write(&path, r#"{"feature":{"keep":true}}"#).unwrap();
        assert!(write_config_at(&path).unwrap());
        let merged = fs::read(&path).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&merged).unwrap(),
            serde_json::json!({"primaryApiKey": "any", "feature": {"keep": true}})
        );
        let unchanged = br#"{ "primaryApiKey":"any", "other":true }"#;
        fs::write(&path, unchanged).unwrap();
        assert!(!write_config_at(&path).unwrap());
        assert_eq!(fs::read(&path).unwrap(), unchanged);
    }

    #[test]
    fn claude_plugin_never_adopts_or_replaces_a_preexisting_primary_key() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(CLAUDE_CONFIG_FILE);
        for original in [
            br#"{ "primaryApiKey": "any" }"#.as_slice(),
            br#"{ "primaryApiKey": "user-owned" }"#,
            br#"{"primaryApiKey":null}"#,
        ] {
            fs::write(&path, original).unwrap();
            assert!(!write_config_at(&path).unwrap());
            assert!(!clear_config_at(&path).unwrap());
            assert_eq!(fs::read(&path).unwrap(), original);
            assert!(!path.with_file_name(OWNERSHIP_FILE).exists());
        }
    }

    #[test]
    fn claude_plugin_clears_its_own_key_without_touching_other_settings_or_user_edits() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(CLAUDE_CONFIG_FILE);
        fs::write(&path, r#"{"feature":true}"#).unwrap();
        assert!(write_config_at(&path).unwrap());
        assert!(clear_config_at(&path).unwrap());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
            serde_json::json!({"feature": true})
        );
        assert!(write_config_at(&path).unwrap());
        let edited = br#"{ "feature": true, "primaryApiKey": "replaced" }"#;
        fs::write(&path, edited).unwrap();
        assert!(!clear_config_at(&path).unwrap());
        assert_eq!(fs::read(&path).unwrap(), edited);
        assert!(!path.with_file_name(OWNERSHIP_FILE).exists());
    }
}
