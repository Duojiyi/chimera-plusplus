use serde_json::Value;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};
use tauri_plugin_store::StoreExt;

use crate::error::AppError;

/// Store 中的键名
const STORE_KEY_APP_CONFIG_DIR: &str = "app_config_dir_override";

/// 缓存当前的 app_config_dir 覆盖路径，避免存储 AppHandle
static APP_CONFIG_DIR_OVERRIDE: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

fn override_cache() -> &'static RwLock<Option<PathBuf>> {
    APP_CONFIG_DIR_OVERRIDE.get_or_init(|| RwLock::new(None))
}

fn update_cached_override(value: Option<PathBuf>) {
    if let Ok(mut guard) = override_cache().write() {
        *guard = value;
    }
}

/// 获取缓存中的 app_config_dir 覆盖路径
pub fn get_app_config_dir_override() -> Option<PathBuf> {
    override_cache().read().ok()?.clone()
}

fn read_override_from_store(app: &tauri::AppHandle) -> Option<PathBuf> {
    let store = match app.store_builder("app_paths.json").build() {
        Ok(store) => store,
        Err(e) => {
            log::warn!("无法创建 Store: {e}");
            return None;
        }
    };

    match store.get(STORE_KEY_APP_CONFIG_DIR) {
        Some(Value::String(path_str)) => {
            let path_str = path_str.trim();
            if path_str.is_empty() {
                return None;
            }

            let path = resolve_path(path_str);

            if !path.exists() {
                log::warn!(
                    "Store 中配置的 app_config_dir 不存在: {path:?}\n\
                     将使用默认路径。"
                );
                return None;
            }

            log::info!("使用 Store 中的 app_config_dir: {path:?}");
            Some(path)
        }
        Some(_) => {
            log::warn!("Store 中的 {STORE_KEY_APP_CONFIG_DIR} 类型不正确，应为字符串");
            None
        }
        None => None,
    }
}

/// The override saved in the Store, which takes effect at the next start.
/// Reading it does not change the directory this process is already using.
pub fn saved_app_config_dir_override(app: &tauri::AppHandle) -> Option<PathBuf> {
    read_override_from_store(app)
}

/// A directory the app can keep its database in: absolute, creatable, a real
/// folder (not a link) and writable.
pub(crate) fn validate_app_config_dir(raw: &str) -> Result<PathBuf, AppError> {
    let path = resolve_path(raw.trim());
    if !path.is_absolute() {
        return Err(AppError::InvalidInput(
            "应用数据目录必须是绝对路径。".to_string(),
        ));
    }
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() {
            return Err(AppError::InvalidInput(
                "应用数据目录不能是符号链接。".to_string(),
            ));
        }
    }
    std::fs::create_dir_all(&path)
        .map_err(|e| AppError::InvalidInput(format!("无法创建应用数据目录：{e}")))?;
    if !path.is_dir() {
        return Err(AppError::InvalidInput(
            "应用数据目录必须是文件夹。".to_string(),
        ));
    }
    // Writable: the database cannot live somewhere it cannot create files.
    tempfile::Builder::new()
        .prefix(".chimera-write-check-")
        .tempfile_in(&path)
        .map_err(|e| AppError::InvalidInput(format!("应用数据目录不可写：{e}")))?;
    Ok(path)
}

/// 从 Store 刷新 app_config_dir 覆盖值并更新缓存
pub fn refresh_app_config_dir_override(app: &tauri::AppHandle) -> Option<PathBuf> {
    let value = read_override_from_store(app);
    update_cached_override(value.clone());
    value
}

/// 写入 app_config_dir 到 Tauri Store
pub fn set_app_config_dir_to_store(
    app: &tauri::AppHandle,
    path: Option<&str>,
) -> Result<(), AppError> {
    let store = app
        .store_builder("app_paths.json")
        .build()
        .map_err(|e| AppError::Message(format!("创建 Store 失败: {e}")))?;

    match path {
        Some(p) => {
            let trimmed = p.trim();
            if !trimmed.is_empty() {
                validate_app_config_dir(trimmed)?;
                store.set(STORE_KEY_APP_CONFIG_DIR, Value::String(trimmed.to_string()));
                log::info!("已将 app_config_dir 写入 Store: {trimmed}");
            } else {
                store.delete(STORE_KEY_APP_CONFIG_DIR);
                log::info!("已从 Store 中删除 app_config_dir 配置");
            }
        }
        None => {
            store.delete(STORE_KEY_APP_CONFIG_DIR);
            log::info!("已从 Store 中删除 app_config_dir 配置");
        }
    }

    store
        .save()
        .map_err(|e| AppError::Message(format!("保存 Store 失败: {e}")))?;

    // The running process keeps its directory: the database, logs and the OAuth
    // managers were opened there, and switching the answer of
    // `get_app_config_dir()` mid-session splits the data. The saved value is
    // read once at the next start.
    Ok(())
}

/// 解析路径，支持 ~ 开头的相对路径
fn resolve_path(raw: &str) -> PathBuf {
    if raw == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    } else if let Some(stripped) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    } else if let Some(stripped) = raw.strip_prefix("~\\") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }

    PathBuf::from(raw)
}

/// 从旧的 settings.json 迁移 app_config_dir 到 Store
pub fn migrate_app_config_dir_from_settings(app: &tauri::AppHandle) -> Result<(), AppError> {
    // app_config_dir 已从 settings.json 移除，此函数保留但不再执行迁移
    // 如果用户在旧版本设置过 app_config_dir，需要在 Store 中手动配置
    log::info!("app_config_dir 迁移功能已移除，请在设置中重新配置");

    let _ = refresh_app_config_dir_override(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_app_config_dir;

    #[test]
    fn data_directory_override_must_be_a_writable_absolute_folder() {
        let temp = tempfile::tempdir().expect("temp dir");
        let fresh = temp.path().join("chimera data");
        assert_eq!(
            validate_app_config_dir(&fresh.to_string_lossy()).expect("created"),
            fresh
        );
        assert!(fresh.is_dir(), "a missing directory is created");

        assert!(validate_app_config_dir("relative/dir").is_err());

        let file = temp.path().join("file.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_app_config_dir(&file.to_string_lossy()).is_err());
    }
}
