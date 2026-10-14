//! Verified online Codex skin catalog and schema-v2 theme application.
//!
//! The network and package rules are adapted from Codex App Manager at the
//! pinned commit registered in THIRD_PARTY_SOURCES.md. Catalog paths are
//! resolved only below the fixed mirror; packages are size and SHA-256 gated
//! before the upstream theme importer validates their archive contents.
//!
//! Every user-visible message is plain Chinese and keeps the underlying cause
//! where it is safe to show: catalog and package URLs are public, and network
//! errors are described without echoing request URLs.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use codex_theme_engine::native::NativeThemePaths;

const SKINS_BASE: &str = "https://skins.agentsmirror.com";
const CATALOG_URL: &str = "https://skins.agentsmirror.com/index.json";
const MAX_PACK_BYTES: u64 = 50 * 1024 * 1024;
/// 皮肤目录抓取超时（秒）。
const SKIN_CATALOG_TIMEOUT_SECS: u64 = 20;
/// 皮肤目录响应体积上限（防御异常响应无界读取）。
const SKIN_CATALOG_MAX_BYTES: usize = 8 * 1024 * 1024;
/// 发送给皮肤镜像站点的标准 User-Agent。
const SKIN_CATALOG_USER_AGENT: &str = "chimera-plus-plus";
const NOT_INSTALLED_MESSAGE: &str = "未检测到 Codex 安装，请先在“Codex 管理”中安装 Codex。";
const MSIX_CUSTOM_HOME_MESSAGE: &str = "Codex 标准安装使用自定义 CODEX_HOME 时无法应用皮肤：系统激活不能同时传入调试参数和自定义目录。请恢复默认的 ~/.codex 目录，或改用免安装版 Codex。";

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
        Err(format!(
            "皮肤目录中的资源路径不安全（{relative}），已拒绝下载。"
        ))
    }
}

/// Parse and retain only catalog entries that can be integrity-verified.
pub fn parse_catalog(json: &str) -> Result<Vec<CatalogSkin>, String> {
    let index: CatalogIndex = serde_json::from_str(json)
        .map_err(|error| format!("皮肤目录格式无效：{error}。请稍后重试。"))?;
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

fn portable_root() -> Result<PathBuf, String> {
    crate::settings::resolve_codex_portable_root()
}

// A fixed, source-code-visible debug port here would let any other local
// process attach via CDP and control the Codex renderer for as long as the
// skin-preview relaunch keeps it open — see the identical rationale on
// `codex_cdp::codex_renderer_debug_port`. Picked once per Chimera++ process
// so the launch call and the injection client that follows it agree.
static THEME_CDP_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

fn theme_cdp_port() -> u16 {
    *THEME_CDP_PORT.get_or_init(|| crate::codex_cdp::pick_ephemeral_loopback_port().unwrap_or(9345))
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
        .map_err(|error| {
            format!(
                "无法读取皮肤目录：{}。当前网络：{}。请检查网络或应用代理设置后重试。",
                crate::services::bounded_download::describe_reqwest_error(&error),
                crate::proxy::http_client::describe_network_mode()
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        let detail = response
            .bytes()
            .await
            .map(|bytes| String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).into_owned())
            .unwrap_or_default();
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            format!("皮肤目录服务器返回 HTTP {status}，请稍后重试。")
        } else {
            format!("皮肤目录服务器返回 HTTP {status}（{detail}），请稍后重试。")
        });
    }
    if response
        .content_length()
        .is_some_and(|len| len > SKIN_CATALOG_MAX_BYTES as u64)
    {
        return Err(catalog_too_large_message());
    }
    let bytes = response.bytes().await.map_err(|error| {
        format!(
            "读取皮肤目录响应失败：{}。请检查网络后重试。",
            crate::services::bounded_download::describe_reqwest_error(&error)
        )
    })?;
    if bytes.len() > SKIN_CATALOG_MAX_BYTES {
        return Err(catalog_too_large_message());
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|error| format!("皮肤目录响应不是有效的 UTF-8 文本：{error}"))
}

fn catalog_too_large_message() -> String {
    format!(
        "皮肤目录响应超过 {} MiB 上限，已拒绝读取。",
        SKIN_CATALOG_MAX_BYTES / (1024 * 1024)
    )
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
    .map_err(|error| format!("读取皮肤目录的任务被中断：{error}"))?
}

/// Download, hash-check, and import one schema-v2 catalog skin.
#[tauri::command]
pub async fn install_catalog_skin(
    app: tauri::AppHandle,
    skin_id: String,
) -> Result<CatalogSkin, String> {
    let data_root = data_root();
    let root = themes_root();
    // 先经应用内客户端抓取目录，再在阻塞线程上执行加锁与安装。
    let catalog = fetch_catalog().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = super::codex_runtime::acquire_operation_lock("install_catalog_skin")?;
        let skin = catalog
            .into_iter()
            .find(|entry| entry.id == skin_id)
            .ok_or_else(|| "皮肤目录中没有找到这个皮肤，请刷新目录后重试。".to_string())?;
        let url = catalog_asset_url(&skin.pack)?;
        let staging = data_root
            .join("downloads")
            .join(format!("{}.codexskin", skin.id));
        if let Some(parent) = staging.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建皮肤下载目录：{error}"))?;
        }
        let total = skin.bytes;
        let progress_app = app.clone();
        let on_progress: crate::services::bounded_download::ProgressCallback =
            std::sync::Arc::new(move |downloaded: u64| {
                let _ = progress_app.emit(
                    "skin://download-progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            });
        // Same client and proxy as the catalog request above; this runs on the
        // blocking thread that holds the runtime operation lock.
        crate::services::bounded_download::download_to_file_blocking(
            crate::proxy::http_client::get(),
            url,
            staging.clone(),
            total,
            crate::services::bounded_download::DownloadOptions::default(),
            on_progress,
        )
        .map_err(|error| {
            format!(
                "下载皮肤包失败：{error}。当前网络：{}。请检查网络或应用代理设置后重试。",
                crate::proxy::http_client::describe_network_mode()
            )
        })?;
        let digest = codex_win_engine::sha256_file(&staging).map_err(|error| {
            let _ = std::fs::remove_file(&staging);
            format!("无法校验下载的皮肤包：{error}")
        })?;
        if !digest.eq_ignore_ascii_case(&skin.sha256) {
            let _ = std::fs::remove_file(&staging);
            return Err("下载的皮肤包与目录中的校验值不一致，已删除。请稍后重试。".to_string());
        }
        let imported = codex_theme_engine::import::import_codexskin(&staging, &root);
        let _ = std::fs::remove_file(&staging);
        let imported = imported.map_err(|error| format!("导入皮肤包失败：{error}"))?;
        if imported.id != skin.id {
            return Err("皮肤包内容与目录中的皮肤不一致，已拒绝安装。".to_string());
        }
        let mut result = skin;
        result.installed = true;
        Ok(result)
    })
    .await
    .map_err(|error| format!("安装皮肤的任务被中断：{error}"))?
}

/// Import a local schema-v2 `.codexskin` through the reference validator.
#[tauri::command]
pub async fn import_skin_package(path: String) -> Result<String, String> {
    let root = themes_root();
    let archive = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = super::codex_runtime::acquire_operation_lock("import_skin_package")?;
        codex_theme_engine::import::import_codexskin(&archive, &root)
            .map(|summary| summary.id)
            .map_err(|error| format!("导入皮肤包失败：{error}"))
    })
    .await
    .map_err(|error| format!("导入皮肤的任务被中断：{error}"))?
}

/// Closing Codex already reports plain-Chinese reasons; keep them.
fn close_codex(
    installed: &codex_win_engine::InstalledWindowsCodex,
    portable_root: &Path,
) -> Result<(), String> {
    super::codex_runtime::close_codex_for_restart(installed, portable_root)
}

fn close_and_launch(portable_root: &Path, debug_port: Option<u16>) -> Result<(), String> {
    let installed = codex_win_engine::detect_installed_codex(portable_root)
        .ok_or_else(|| NOT_INSTALLED_MESSAGE.to_string())?;
    if debug_port.is_some() && !super::codex_runtime::renderer_unlock_available(&installed) {
        return Err(MSIX_CUSTOM_HOME_MESSAGE.to_string());
    }
    close_codex(&installed, portable_root)?;
    super::codex_runtime::launch_codex_with_config(
        &installed,
        codex_win_engine::LaunchOptions {
            disable_codex_self_updates: true,
            remote_debugging_port: debug_port,
        },
    )
    .map_err(|error| format!("重启 Codex 以应用皮肤失败：{error}"))
}

async fn inject_skin(root: PathBuf, skin_id: &str) -> Result<(), String> {
    let theme = codex_theme_engine::theme::resolve_theme_dir(&root, skin_id)
        .map_err(|error| format!("读取皮肤失败：{error}"))?;
    let payload = codex_theme_engine::payload::build_payload(&theme)
        .map_err(|error| format!("生成皮肤注入内容失败：{error}"))?;
    let targets =
        codex_theme_engine::cdp::connect_codex_targets(theme_cdp_port(), Duration::from_secs(45))
            .await
            .map_err(|error| {
                format!("无法连接 Codex 窗口以注入皮肤：{error}。请确认 Codex 已正常打开后重试。")
            })?;
    let mut applied = 0usize;
    for target in targets {
        if target.session.evaluate(&payload.payload).await.is_ok() {
            applied += 1;
        }
        target.session.close();
    }
    if applied == 0 {
        Err("没有 Codex 窗口接受皮肤注入。请确认 Codex 已正常打开后重试。".to_string())
    } else {
        Ok(())
    }
}

/// Apply a skin's native settings, restart Codex with loopback CDP, and inject.
#[tauri::command]
pub async fn apply_skin_package(skin_id: String, confirm: bool) -> Result<(), String> {
    if !confirm {
        return Err("应用皮肤需要用户明确确认".to_string());
    }
    let root = themes_root();
    let portable_root = portable_root()?;
    let native = native_paths();
    let active = active_path();
    let id = skin_id.clone();
    let apply_root = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = super::codex_runtime::acquire_operation_lock("apply_skin_package")?;
        let dir = codex_theme_engine::theme::resolve_theme_dir(&apply_root, &id)
            .map_err(|error| format!("读取皮肤失败：{error}"))?;
        let loaded = codex_theme_engine::theme::load_theme(&dir)
            .map_err(|error| format!("读取皮肤失败：{error}"))?;
        let installed = codex_win_engine::detect_installed_codex(&portable_root)
            .ok_or_else(|| NOT_INSTALLED_MESSAGE.to_string())?;
        if !super::codex_runtime::renderer_unlock_available(&installed) {
            return Err(MSIX_CUSTOM_HOME_MESSAGE.to_string());
        }
        close_codex(&installed, &portable_root)?;
        if let Some(block) = loaded.codex_theme.as_ref() {
            if block.is_object() {
                let parsed = codex_theme_engine::codex_theme::parse_codex_theme(
                    block,
                    codex_theme_engine::codex_theme::ValidateOptions {
                        require_code_theme_ids: false,
                        ..Default::default()
                    },
                )
                .map_err(|e| format!("codexTheme 校验失败: {e}"))?;
                codex_theme_engine::native::backup_native_theme(&native)
                    .map_err(|e| format!("备份 Codex 原生外观设置失败：{e}"))?;
                let current = crate::codex_config::read_codex_config_text()
                    .map_err(|e| format!("读取 Codex 配置失败：{e}"))?;
                let planned = codex_theme_engine::native::plan_native_config(
                    &current,
                    &codex_theme_engine::native::apply_plan(&parsed),
                )
                .map_err(|e| format!("生成 Codex 外观配置失败：{e}"))?;
                crate::codex_live_write::write_codex_live_files(
                    crate::codex_live_write::CodexLiveWrite::config_only(&planned),
                )
                .map_err(|e| format!("写入 Codex 配置失败：{e}"))?;
            }
        }
        super::codex_runtime::launch_codex_with_config(
            &installed,
            codex_win_engine::LaunchOptions {
                disable_codex_self_updates: true,
                remote_debugging_port: Some(theme_cdp_port()),
            },
        )
        .map_err(|error| format!("重启 Codex 以应用皮肤失败：{error}"))
    })
    .await
    .map_err(|error| format!("应用皮肤的任务被中断：{error}"))??;
    inject_skin(root, &skin_id).await?;
    // Acquiring the lock can wait, so keep it off the async executor.
    tauri::async_runtime::spawn_blocking(move || {
        let _selection_guard = super::codex_runtime::acquire_operation_lock("save_active_skin")
            .map_err(|reason| format!("皮肤已应用，但保存选择失败：{reason}"))?;
        let temporary = active.with_extension("tmp");
        std::fs::write(&temporary, &skin_id)
            .and_then(|_| {
                if active.exists() {
                    std::fs::remove_file(&active)?;
                }
                std::fs::rename(&temporary, &active)
            })
            .map_err(|error| format!("皮肤已应用，但保存选择失败：{error}"))
    })
    .await
    .map_err(|error| format!("保存皮肤选择的任务被中断：{error}"))?
}

/// Try a skin live without changing native settings or the persisted selection.
#[tauri::command]
pub async fn try_skin_package(skin_id: String, confirm: bool) -> Result<(), String> {
    if !confirm {
        return Err("试穿皮肤需要用户明确确认".to_string());
    }
    let root = themes_root();
    let portable_root = portable_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        // Must take the same cross-process lock as apply/restore/install: this
        // closes and relaunches Codex, which can otherwise race an in-flight
        // runtime update/install that is mid rename-swap on the same install
        // root (the update would see its freshly-launched process holding the
        // directory open and fail, or trigger a spurious auto-rollback).
        let _guard = super::codex_runtime::acquire_operation_lock("try_skin_package")?;
        close_and_launch(&portable_root, Some(theme_cdp_port()))
    })
    .await
    .map_err(|error| format!("试穿皮肤的任务被中断：{error}"))??;
    inject_skin(root, &skin_id).await
}

/// Restore stock Codex rendering and the original native appearance settings.
#[tauri::command]
pub async fn restore_skin_package(confirm: bool) -> Result<(), String> {
    if !confirm {
        return Err("恢复 Codex 默认外观需要用户明确确认".to_string());
    }
    let portable_root = portable_root()?;
    let native = native_paths();
    let active = active_path();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = super::codex_runtime::acquire_operation_lock("restore_skin_package")?;
        let installed = codex_win_engine::detect_installed_codex(&portable_root)
            .ok_or_else(|| NOT_INSTALLED_MESSAGE.to_string())?;
        close_codex(&installed, &portable_root)
            .map_err(|error| format!("恢复外观前无法关闭 Codex：{error}"))?;
        let current = crate::codex_config::read_codex_config_text()
            .map_err(|e| format!("读取 Codex 配置失败：{e}"))?;
        if let Some(planned) = codex_theme_engine::native::planned_restore_text(&native, &current)
            .map_err(|error| format!("生成恢复后的 Codex 配置失败：{error}"))?
        {
            crate::codex_live_write::write_codex_live_files(
                crate::codex_live_write::CodexLiveWrite::config_only(&planned),
            )
            .map_err(|error| format!("写入 Codex 配置失败：{error}"))?;
            codex_theme_engine::native::drop_backup(&native)
                .map_err(|error| format!("清理外观备份失败：{error}"))?;
        }
        super::codex_runtime::launch_codex_with_config(
            &installed,
            codex_win_engine::LaunchOptions::default(),
        )
        .map_err(|error| format!("已恢复 Codex 默认外观，但重启 Codex 失败：{error}"))?;
        if active.exists() {
            std::fs::remove_file(active)
                .map_err(|error| format!("无法清除当前皮肤选择：{error}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("恢复外观的任务被中断：{error}"))?
}

#[cfg(test)]
mod tests {
    #[test]
    fn catalog_errors_are_plain_chinese_and_keep_their_cause() {
        let error = super::parse_catalog("not json").expect_err("invalid JSON is rejected");
        assert!(error.starts_with("皮肤目录格式无效："), "{error}");
        assert!(
            error.contains("expected"),
            "the parser's reason is kept: {error}"
        );

        let error = super::catalog_asset_url("../escape.codexskin").expect_err("unsafe path");
        assert!(error.contains("不安全"), "{error}");
        assert!(error.contains("../escape.codexskin"), "{error}");
        assert_eq!(
            super::catalog_asset_url("packs/aurora.codexskin").as_deref(),
            Ok("https://skins.agentsmirror.com/packs/aurora.codexskin")
        );
        assert!(super::catalog_too_large_message().contains("8 MiB"));
    }

    #[test]
    fn skin_commands_keep_underlying_causes_and_chinese_launch_errors() {
        let source = include_str!("skin_catalog.rs")
            .split("mod tests {")
            .next()
            .expect("source before tests");
        // Every failure keeps its cause instead of replacing it wholesale.
        assert!(!source.contains("map_err(|_|"));
        // Launch-path failures from the runtime are already plain Chinese.
        assert!(source.contains("重启 Codex 以应用皮肤失败：{error}"));
        assert!(source.contains("已恢复 Codex 默认外观，但重启 Codex 失败：{error}"));
        assert!(source
            .contains("super::codex_runtime::close_codex_for_restart(installed, portable_root)\n"));
        for english in [
            "Could not",
            "The skin",
            "Install Codex before",
            "requires explicit confirmation",
            "was interrupted",
        ] {
            assert!(!source.contains(english), "{english}");
        }
    }
}
