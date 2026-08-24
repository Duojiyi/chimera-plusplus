//! Verified online Codex skin catalog and schema-v2 theme application.
//!
//! The network and package rules are adapted from Codex App Manager at the
//! pinned commit registered in THIRD_PARTY_SOURCES.md. Catalog paths are
//! resolved only below the fixed mirror; packages are size and SHA-256 gated
//! before the upstream theme importer validates their archive contents.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use chimera_platform::lock::OperationLock;
use codex_theme_engine::native::NativeThemePaths;

const SKINS_BASE: &str = "https://skins.agentsmirror.com";
const CATALOG_URL: &str = "https://skins.agentsmirror.com/index.json";
const THEME_CDP_PORT: u16 = 9345;
const MAX_PACK_BYTES: u64 = 50 * 1024 * 1024;
/// 皮肤目录抓取超时（秒）。
const SKIN_CATALOG_TIMEOUT_SECS: u64 = 20;
/// 皮肤目录响应体积上限（防御异常响应无界读取）。
const SKIN_CATALOG_MAX_BYTES: usize = 8 * 1024 * 1024;
/// 发送给皮肤镜像站点的标准 User-Agent。
const SKIN_CATALOG_USER_AGENT: &str = "chimera-plus-plus";

/// One verified catalog entry returned to the appearance gallery.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSkin {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub appearance: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub codex_verified: Option<String>,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub pack: String,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub applied: bool,
}

#[derive(Debug, Deserialize)]
struct CatalogIndex {
    #[serde(default)]
    skins: Vec<CatalogSkin>,
}

/// Resolve a catalog-relative asset under the fixed HTTPS mirror.
pub fn catalog_asset_url(relative: &str) -> Result<String, String> {
    let valid = !relative.is_empty()
        && !relative.contains("://")
        && !relative.starts_with('/')
        && !relative.contains("..")
        && relative
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/-_.".contains(&byte));
    if valid {
        Ok(format!("{SKINS_BASE}/{relative}"))
    } else {
        Err("The skin catalog contains an unsafe asset path.".to_string())
    }
}

/// Parse and retain only catalog entries that can be integrity-verified.
pub fn parse_catalog(json: &str) -> Result<Vec<CatalogSkin>, String> {
    let index: CatalogIndex = serde_json::from_str(json)
        .map_err(|_| "The skin catalog response is invalid.".to_string())?;
    let mut skins = index
        .skins
        .into_iter()
        .filter(|skin| {
            !skin.id.is_empty()
                && skin
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                && !skin.version.is_empty()
                && skin.bytes > 0
                && skin.bytes <= MAX_PACK_BYTES
                && skin.sha256.len() == 64
                && skin.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                && catalog_asset_url(&skin.pack).is_ok()
                && catalog_asset_url(&skin.preview).is_ok()
        })
        .collect::<Vec<_>>();
    skins.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(skins)
}

fn data_root() -> PathBuf {
    crate::config::get_app_config_dir()
}

fn themes_root() -> PathBuf {
    data_root().join("codex-skins-v2")
}

fn active_path() -> PathBuf {
    data_root().join("active-codex-skin.txt")
}

fn runtime_root() -> PathBuf {
    data_root().join("codex-runtime")
}

fn portable_root() -> Result<PathBuf, String> {
    crate::settings::resolve_codex_portable_root()
}

fn operation_lock() -> PathBuf {
    runtime_root().join("operation.lock")
}

fn native_paths() -> NativeThemePaths {
    NativeThemePaths {
        config: crate::codex_config::get_codex_config_path(),
        backup: data_root().join("codex-theme-native-backup.json"),
    }
}

fn active_id() -> Option<String> {
    std::fs::read_to_string(active_path())
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 通过应用内 reqwest 客户端抓取皮肤目录，跟随全局代理设置。
///
/// 取代进程外 `codex_win_engine::fetch_text`（curl）——后者先等进程退出再读
/// stdout，Windows 匿名管道缓冲仅约 4KB，大响应会使 curl 背压死锁（与 v2.6.3
/// 历史版本目录同根因，见 docs/plans/v2.6.3-audit.md 修复 2）。
async fn fetch_catalog_text() -> Result<String, String> {
    let client = crate::proxy::http_client::get();
    let response = client
        .get(CATALOG_URL)
        .header(reqwest::header::USER_AGENT, SKIN_CATALOG_USER_AGENT)
        .timeout(Duration::from_secs(SKIN_CATALOG_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|_| "Could not reach the verified skin catalog.".to_string())?;
    let status = response.status();
    if !status.is_success() {
        let detail = response
            .bytes()
            .await
            .map(|bytes| String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).into_owned())
            .unwrap_or_default();
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}: {detail}")
        });
    }
    if response
        .content_length()
        .is_some_and(|len| len > SKIN_CATALOG_MAX_BYTES as u64)
    {
        return Err("The skin catalog response is too large.".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read the skin catalog response.".to_string())?;
    if bytes.len() > SKIN_CATALOG_MAX_BYTES {
        return Err("The skin catalog response is too large.".to_string());
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|_| "The skin catalog response is not valid UTF-8.".to_string())
}

async fn fetch_catalog() -> Result<Vec<CatalogSkin>, String> {
    let text = fetch_catalog_text().await?;
    parse_catalog(&text)
}

/// Fetch the online skin marketplace and annotate local installation state.
#[tauri::command]
pub async fn list_skin_catalog() -> Result<Vec<CatalogSkin>, String> {
    let root = themes_root();
    let active = active_id();
    // 先经应用内客户端抓取目录，再在阻塞线程上枚举本地主题。
    let mut catalog = fetch_catalog().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let installed = codex_theme_engine::theme::list_themes(&root)
            .into_iter()
            .map(|theme| theme.id)
            .collect::<std::collections::HashSet<_>>();
        for skin in &mut catalog {
            skin.installed = installed.contains(&skin.id);
            skin.applied = active.as_deref() == Some(skin.id.as_str());
        }
        Ok(catalog)
    })
    .await
    .map_err(|_| "The skin catalog request was interrupted.".to_string())?
}

/// Download, hash-check, and import one schema-v2 catalog skin.
#[tauri::command]
pub async fn install_catalog_skin(
    app: tauri::AppHandle,
    skin_id: String,
) -> Result<CatalogSkin, String> {
    let data_root = data_root();
    let root = themes_root();
    let lock_path = operation_lock();
    // 先经应用内客户端抓取目录，再在阻塞线程上执行加锁与安装。
    let catalog = fetch_catalog().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let lock = OperationLock::new(lock_path);
        let _guard = lock
            .try_acquire("install_catalog_skin")
            .map_err(|_| "Another Chimera++ operation is already running.".to_string())?;
        let skin = catalog
            .into_iter()
            .find(|entry| entry.id == skin_id)
            .ok_or_else(|| "That skin is not in the verified catalog.".to_string())?;
        let url = catalog_asset_url(&skin.pack)?;
        let staging = data_root
            .join("downloads")
            .join(format!("{}.codexskin", skin.id));
        if let Some(parent) = staging.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| "Could not prepare the skin download folder.".to_string())?;
        }
        let total = skin.bytes;
        let progress_app = app.clone();
        codex_win_engine::download_to_with_progress_bounded(&url, &staging, total, &|downloaded| {
            let _ = progress_app.emit(
                "skin://download-progress",
                serde_json::json!({ "downloaded": downloaded, "total": total }),
            );
        })
        .map_err(|_| "The skin package download failed.".to_string())?;
        let digest = codex_win_engine::sha256_file(&staging)
            .map_err(|_| "Could not verify the downloaded skin.".to_string())?;
        if !digest.eq_ignore_ascii_case(&skin.sha256) {
            let _ = std::fs::remove_file(&staging);
            return Err("The skin package checksum does not match the catalog.".to_string());
        }
        let imported = codex_theme_engine::import::import_codexskin(&staging, &root)
            .map_err(|error| error.to_string())?;
        let _ = std::fs::remove_file(&staging);
        if imported.id != skin.id {
            return Err("The skin package identity does not match the catalog.".to_string());
        }
        let mut result = skin;
        result.installed = true;
        Ok(result)
    })
    .await
    .map_err(|_| "The skin install was interrupted.".to_string())?
}

/// Import a local schema-v2 `.codexskin` through the reference validator.
#[tauri::command]
pub async fn import_skin_package(path: String) -> Result<String, String> {
    let root = themes_root();
    let archive = PathBuf::from(path);
    let lock_path = operation_lock();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = OperationLock::new(lock_path);
        let _guard = lock
            .try_acquire("import_skin_package")
            .map_err(|_| "Another Chimera++ operation is already running.".to_string())?;
        codex_theme_engine::import::import_codexskin(&archive, &root)
            .map(|summary| summary.id)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "The skin import was interrupted.".to_string())?
}

fn close_codex(
    installed: &codex_win_engine::InstalledWindowsCodex,
    portable_root: &Path,
) -> Result<(), String> {
    super::codex_runtime::close_codex_for_restart(installed, portable_root)
        .map_err(|_| "Could not close Codex before applying the skin.".to_string())
}

fn close_and_launch(portable_root: &Path, debug_port: Option<u16>) -> Result<(), String> {
    let installed = codex_win_engine::detect_installed_codex(portable_root)
        .ok_or_else(|| "Install Codex before applying a skin.".to_string())?;
    close_codex(&installed, portable_root)?;
    super::codex_runtime::launch_codex_with_config(
        &installed,
        codex_win_engine::LaunchOptions {
            disable_codex_self_updates: true,
            remote_debugging_port: debug_port,
        },
    )
    .map_err(|_| "Could not restart Codex for skin injection.".to_string())
}

async fn inject_skin(root: PathBuf, skin_id: &str) -> Result<(), String> {
    let theme = codex_theme_engine::theme::resolve_theme_dir(&root, skin_id)
        .map_err(|error| error.to_string())?;
    let payload =
        codex_theme_engine::payload::build_payload(&theme).map_err(|error| error.to_string())?;
    let targets =
        codex_theme_engine::cdp::connect_codex_targets(THEME_CDP_PORT, Duration::from_secs(45))
            .await
            .map_err(|error| error.to_string())?;
    let mut applied = 0usize;
    for target in targets {
        if target.session.evaluate(&payload.payload).await.is_ok() {
            applied += 1;
        }
        target.session.close();
    }
    if applied == 0 {
        Err("No verified Codex window accepted the skin.".to_string())
    } else {
        Ok(())
    }
}

/// Apply a skin's native settings, restart Codex with loopback CDP, and inject.
#[tauri::command]
pub async fn apply_skin_package(skin_id: String, confirm: bool) -> Result<(), String> {
    if !confirm {
        return Err("Applying a skin requires explicit confirmation.".to_string());
    }
    let root = themes_root();
    let portable_root = portable_root()?;
    let native = native_paths();
    let active = active_path();
    let lock_path = operation_lock();
    let id = skin_id.clone();
    let apply_root = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = OperationLock::new(lock_path);
        let _guard = lock
            .try_acquire("apply_skin_package")
            .map_err(|_| "Another Chimera++ operation is already running.".to_string())?;
        let dir = codex_theme_engine::theme::resolve_theme_dir(&apply_root, &id)
            .map_err(|error| error.to_string())?;
        let loaded =
            codex_theme_engine::theme::load_theme(&dir).map_err(|error| error.to_string())?;
        let installed = codex_win_engine::detect_installed_codex(&portable_root)
            .ok_or_else(|| "Install Codex before applying a skin.".to_string())?;
        close_codex(&installed, &portable_root)?;
        if let Some(block) = loaded.codex_theme.as_ref() {
            codex_theme_engine::native::apply_native_theme_value(&native, block)
                .map_err(|error| error.to_string())?;
        }
        super::codex_runtime::launch_codex_with_config(
            &installed,
            codex_win_engine::LaunchOptions {
                disable_codex_self_updates: true,
                remote_debugging_port: Some(THEME_CDP_PORT),
            },
        )
        .map_err(|_| "Could not restart Codex for skin injection.".to_string())
    })
    .await
    .map_err(|_| "The skin apply operation was interrupted.".to_string())??;
    inject_skin(root, &skin_id).await?;
    let selection_lock = OperationLock::new(operation_lock());
    let _selection_guard = selection_lock
        .try_acquire("save_active_skin")
        .map_err(|_| {
            "The skin was applied, but another operation prevented saving it.".to_string()
        })?;
    let temporary = active.with_extension("tmp");
    std::fs::write(&temporary, &skin_id)
        .and_then(|_| {
            if active.exists() {
                std::fs::remove_file(&active)?;
            }
            std::fs::rename(&temporary, &active)
        })
        .map_err(|_| "The skin was applied but its selection could not be saved.".to_string())
}

/// Try a skin live without changing native settings or the persisted selection.
#[tauri::command]
pub async fn try_skin_package(skin_id: String, confirm: bool) -> Result<(), String> {
    if !confirm {
        return Err("Trying a skin requires explicit confirmation.".to_string());
    }
    let root = themes_root();
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        close_and_launch(&portable_root, Some(THEME_CDP_PORT))
    })
    .await
    .map_err(|_| "The skin preview was interrupted.".to_string())??;
    inject_skin(root, &skin_id).await
}

/// Restore stock Codex rendering and the original native appearance settings.
#[tauri::command]
pub async fn restore_skin_package(confirm: bool) -> Result<(), String> {
    if !confirm {
        return Err("Restoring Codex appearance requires explicit confirmation.".to_string());
    }
    let portable_root = portable_root()?;
    let native = native_paths();
    let active = active_path();
    let lock_path = operation_lock();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = OperationLock::new(lock_path);
        let _guard = lock
            .try_acquire("restore_skin_package")
            .map_err(|_| "Another Chimera++ operation is already running.".to_string())?;
        let installed = codex_win_engine::detect_installed_codex(&portable_root)
            .ok_or_else(|| "Codex is not installed.".to_string())?;
        close_codex(&installed, &portable_root)
            .map_err(|_| "Could not close Codex for restore.".to_string())?;
        codex_theme_engine::native::restore_native_theme(&native)
            .map_err(|error| error.to_string())?;
        super::codex_runtime::launch_codex_with_config(
            &installed,
            codex_win_engine::LaunchOptions::default(),
        )
        .map_err(|_| "Codex appearance was restored, but Codex could not restart.".to_string())?;
        if active.exists() {
            std::fs::remove_file(active)
                .map_err(|_| "Could not clear the active skin selection.".to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|_| "The skin restore was interrupted.".to_string())?
}
