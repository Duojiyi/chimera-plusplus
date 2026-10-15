//! Verified online Codex skin catalog and schema-v2 theme application.
//!
//! The network and package rules are adapted from Codex App Manager at the
//! pinned commit registered in THIRD_PARTY_SOURCES.md. Catalog paths are
//! resolved only below the fixed mirror; packages are size and SHA-256 gated
//! before the upstream theme importer validates their archive contents.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use chimera_platform::lock::OperationLock;
use codex_theme_engine::native::NativeThemePaths;

use crate::state::AppState;

const SKINS_BASE: &str = "https://skins.agentsmirror.com";
const CATALOG_URL: &str = "https://skins.agentsmirror.com/index.json";
const THEME_CDP_PORT: u16 = 9345;
const MAX_PACK_BYTES: u64 = 50 * 1024 * 1024;

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

fn themes_root(state: &AppState) -> PathBuf {
    state.paths.data_root.join("codex-skins-v2")
}

fn active_path(state: &AppState) -> PathBuf {
    state.paths.data_root.join("active-codex-skin.txt")
}

fn native_paths(state: &AppState) -> NativeThemePaths {
    NativeThemePaths {
        config: state.paths.codex_config(),
        backup: state.paths.data_root.join("codex-theme-native-backup.json"),
    }
}

fn active_id(state: &AppState) -> Option<String> {
    std::fs::read_to_string(active_path(state))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn fetch_catalog() -> Result<Vec<CatalogSkin>, String> {
    let text = codex_win_engine::fetch_text(CATALOG_URL)
        .map_err(|_| "Could not reach the verified skin catalog.".to_string())?;
    parse_catalog(&text)
}

/// Fetch the online skin marketplace and annotate local installation state.
#[tauri::command]
pub async fn list_skin_catalog(state: State<'_, AppState>) -> Result<Vec<CatalogSkin>, String> {
    let root = themes_root(&state);
    let active = active_id(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let installed = codex_theme_engine::theme::list_themes(&root)
            .into_iter()
            .map(|theme| theme.id)
            .collect::<std::collections::HashSet<_>>();
        let mut catalog = fetch_catalog()?;
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
    state: State<'_, AppState>,
) -> Result<CatalogSkin, String> {
    let data_root = state.paths.data_root.clone();
    let root = themes_root(&state);
    let lock_path = state.paths.operation_lock();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = OperationLock::new(lock_path);
        let _guard = lock
            .try_acquire("install_catalog_skin")
            .map_err(|_| "Another Chimera++ operation is already running.".to_string())?;
        let skin = fetch_catalog()?
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
pub async fn import_skin_package(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = themes_root(&state);
    let archive = PathBuf::from(path);
    let lock_path = state.paths.operation_lock();
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
    if installed.source == "msix" {
        codex_win_engine::close_msix_codex_processes(30)
            .map_err(|_| "Could not close Codex before applying the skin.".to_string())?;
    } else {
        codex_win_engine::close_codex_gracefully_for_root(30, portable_root)
            .map_err(|_| "Could not close Codex before applying the skin.".to_string())?;
    }
    Ok(())
}

fn close_and_launch(portable_root: &Path, debug_port: Option<u16>) -> Result<(), String> {
    let installed = codex_win_engine::detect_installed_codex(portable_root)
        .ok_or_else(|| "Install Codex before applying a skin.".to_string())?;
    close_codex(&installed, portable_root)?;
    codex_win_engine::launch_codex_with_options(
        &installed,
        codex_win_engine::LaunchOptions {
            disable_codex_self_updates: true,
            remote_debugging_port: debug_port,
            ..Default::default()
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
pub async fn apply_skin_package(skin_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = themes_root(&state);
    let portable_root = state.paths.data_root.join("codex-portable");
    let native = native_paths(&state);
    let active = active_path(&state);
    let lock_path = state.paths.operation_lock();
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
        codex_win_engine::launch_codex_with_options(
            &installed,
            codex_win_engine::LaunchOptions {
                disable_codex_self_updates: true,
                remote_debugging_port: Some(THEME_CDP_PORT),
                ..Default::default()
            },
        )
        .map_err(|_| "Could not restart Codex for skin injection.".to_string())
    })
    .await
    .map_err(|_| "The skin apply operation was interrupted.".to_string())??;
    inject_skin(root, &skin_id).await?;
    let selection_lock = OperationLock::new(state.paths.operation_lock());
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
pub async fn try_skin_package(skin_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = themes_root(&state);
    let portable_root = state.paths.data_root.join("codex-portable");
    tauri::async_runtime::spawn_blocking(move || {
        close_and_launch(&portable_root, Some(THEME_CDP_PORT))
    })
    .await
    .map_err(|_| "The skin preview was interrupted.".to_string())??;
    inject_skin(root, &skin_id).await
}

/// Restore stock Codex rendering and the original native appearance settings.
#[tauri::command]
pub async fn restore_skin_package(state: State<'_, AppState>) -> Result<(), String> {
    let portable_root = state.paths.data_root.join("codex-portable");
    let native = native_paths(&state);
    let active = active_path(&state);
    let lock_path = state.paths.operation_lock();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = OperationLock::new(lock_path);
        let _guard = lock
            .try_acquire("restore_skin_package")
            .map_err(|_| "Another Chimera++ operation is already running.".to_string())?;
        let installed = codex_win_engine::detect_installed_codex(&portable_root)
            .ok_or_else(|| "Codex is not installed.".to_string())?;
        if installed.source == "msix" {
            codex_win_engine::close_msix_codex_processes(30)
                .map_err(|_| "Could not close Codex for restore.".to_string())?;
        } else {
            codex_win_engine::close_codex_gracefully_for_root(30, &portable_root)
                .map_err(|_| "Could not close Codex for restore.".to_string())?;
        }
        codex_theme_engine::native::restore_native_theme(&native)
            .map_err(|error| error.to_string())?;
        codex_win_engine::launch_codex(&installed).map_err(|_| {
            "Codex appearance was restored, but Codex could not restart.".to_string()
        })?;
        if active.exists() {
            std::fs::remove_file(active)
                .map_err(|_| "Could not clear the active skin selection.".to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|_| "The skin restore was interrupted.".to_string())?
}
