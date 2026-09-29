use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use chimera_plus_plus_lib::{update_settings, AppSettings, AppState, Database, MultiAppConfig};

/// 为测试设置隔离的 HOME 目录，避免污染真实用户数据。
pub fn ensure_test_home() -> &'static Path {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        let base = std::env::temp_dir().join("cc-switch-test-home");
        if base.exists() {
            let _ = std::fs::remove_dir_all(&base);
        }
        std::fs::create_dir_all(&base).expect("create test home");
        // Windows 上 `dirs::home_dir()` 不受 HOME/USERPROFILE 影响（走 Known Folder API），
        // 用 CC_SWITCH_TEST_HOME 显式覆盖，以确保测试不会污染真实用户目录。
        std::env::set_var("CC_SWITCH_TEST_HOME", &base);
        std::env::set_var("HOME", &base);
        #[cfg(windows)]
        std::env::set_var("USERPROFILE", &base);
        // Claude Desktop 与 Hermes 在 Windows 上按 LOCALAPPDATA 定位目录；不覆盖
        // 它，测试会读写真实用户的 %LOCALAPPDATA%\Claude* 与 %LOCALAPPDATA%\hermes。
        #[cfg(windows)]
        std::env::set_var("LOCALAPPDATA", base.join("AppData").join("Local"));
        base
    })
    .as_path()
}

/// 清理测试目录中生成的配置文件与缓存。
pub fn reset_test_fs() {
    let home = ensure_test_home();
    for sub in [
        ".claude",
        ".codex",
        ".cc-switch",
        chimera_plus_plus_lib::product_policy::PRODUCT_DATA_DIR,
        ".gemini",
        ".grok",
        ".config",
        ".openclaw",
        "profiles",
        "AppData",
    ] {
        let path = home.join(sub);
        if path.exists() {
            if let Err(err) = std::fs::remove_dir_all(&path) {
                eprintln!("failed to clean {}: {}", path.display(), err);
            }
        }
    }
    let claude_json = home.join(".claude.json");
    if claude_json.exists() {
        let _ = std::fs::remove_file(&claude_json);
    }

    // 重置内存中的设置缓存，确保测试环境不受上一次调用影响
    let _ = update_settings(AppSettings::default());
}

#[allow(dead_code)]
pub fn enable_codex_official_auth_preservation() {
    update_settings(AppSettings {
        preserve_codex_official_auth_on_switch: true,
        ..Default::default()
    })
    .expect("enable Codex official auth preservation");
}

#[allow(dead_code)]
pub fn disable_codex_official_auth_preservation() {
    update_settings(AppSettings {
        preserve_codex_official_auth_on_switch: false,
        ..Default::default()
    })
    .expect("disable Codex official auth preservation");
}

/// 全局互斥锁，避免多测试并发写入相同的 HOME 目录。
///
/// 这个文件通过 `#[path]` 被每个集成测试各自包含一份，所以「未使用」是按包含方
/// 分别判定的：改用 `#[serial]` 串行化的测试（profile_roundtrip、deeplink_import）
/// 不再需要它，但其余九个仍在用。`#[serial]` 是异步测试的正确做法——把
/// `std::sync::MutexGuard` 持过 `.await` 会阻塞整个 runtime 线程。
#[allow(dead_code)]
pub fn test_mutex() -> &'static Mutex<()> {
    static MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
    MUTEX.get_or_init(|| Mutex::new(()))
}

/// 创建测试用的 AppState，包含一个空的数据库
#[allow(dead_code)]
pub fn create_test_state() -> Result<AppState, Box<dyn std::error::Error>> {
    let db = Arc::new(Database::init()?);
    Ok(AppState::new(db))
}

/// 创建测试用的 AppState，并从 MultiAppConfig 迁移数据
#[allow(dead_code)]
pub fn create_test_state_with_config(
    config: &MultiAppConfig,
) -> Result<AppState, Box<dyn std::error::Error>> {
    let db = Arc::new(Database::init()?);
    db.migrate_from_json(config)?;
    Ok(AppState::new(db))
}
