#![allow(non_snake_case)]

use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// 应用更新下载进度（通过 `update-download-progress` 事件发给前端）。
#[derive(Clone, serde::Serialize)]
struct UpdateDownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

fn merge_settings_for_save(
    mut incoming: crate::settings::AppSettings,
    existing: &crate::settings::AppSettings,
) -> crate::settings::AppSettings {
    if incoming.settings_migration_version < existing.settings_migration_version {
        incoming.unify_codex_session_history = existing.unify_codex_session_history;
    }
    incoming.settings_migration_version = existing
        .settings_migration_version
        .max(incoming.settings_migration_version);
    match (&mut incoming.webdav_sync, &existing.webdav_sync) {
        // incoming 没有 webdav → 保留现有
        (None, _) => {
            incoming.webdav_sync = existing.webdav_sync.clone();
        }
        // incoming 有 webdav 但密码为空，且现有有密码 → 填回现有密码
        // （get_settings_for_frontend 总是清空密码，所以通过 save_settings
        //   传入的空密码意味着"保持现有"而非"用户主动清空"）
        (Some(incoming_sync), Some(existing_sync))
            if incoming_sync.password.is_empty() && !existing_sync.password.is_empty() =>
        {
            incoming_sync.password = existing_sync.password.clone();
        }
        _ => {}
    }
    match (&mut incoming.s3_sync, &existing.s3_sync) {
        // incoming 没有 s3 → 保留现有
        (None, _) => {
            incoming.s3_sync = existing.s3_sync.clone();
        }
        // incoming 有 s3 但密钥为空，且现有有密钥 → 填回现有密钥
        (Some(incoming_sync), Some(existing_sync))
            if incoming_sync.secret_access_key.is_empty()
                && !existing_sync.secret_access_key.is_empty() =>
        {
            incoming_sync.secret_access_key = existing_sync.secret_access_key.clone();
        }
        _ => {}
    }
    // local_migrations 是纯后端状态（迁移完成标记），前端没有合法的修改场景，
    // 无条件取现有值。若按 incoming 透传：后端清掉 marker（如关闭统一会话
    // 开关）后、前端 query 缓存刷新前的一次全量保存会把旧 marker 重放回来，
    // 重新开启时被"复活"的标记挡住而漏迁。
    incoming.local_migrations = existing.local_migrations.clone();
    incoming
}

/// 获取设置
#[tauri::command]
pub async fn get_settings() -> Result<crate::settings::AppSettings, String> {
    Ok(crate::settings::get_settings_for_frontend())
}

/// 保存设置
#[tauri::command]
pub async fn save_settings(
    state: tauri::State<'_, crate::store::AppState>,
    settings: crate::settings::AppSettings,
) -> Result<bool, String> {
    // Read-then-write on a plain snapshot (the previous shape here) races
    // any concurrent backend-side write to settings — most notably the tray
    // menu / failover switching `current_provider_*` via `mutate_settings`
    // while this frontend save is in flight. The frontend's `settings`
    // payload is built from whatever `get_settings()` returned when its
    // panel last loaded, which can already be stale by the time the user
    // clicks save; merging it against a snapshot taken *now* (but still
    // outside any lock) does not fix that — a switch landing between this
    // read and the final `update_settings` write below would still be
    // silently reverted, taking the proxy's routing (which trusts settings
    // as authoritative) out of sync with what the DB/UI just switched to.
    // Do the read-merge-write inside `mutate_settings`'s write lock instead,
    // so "current" is genuinely current at the moment of merge and no
    // concurrent writer can land in between.
    let mut existing: Option<crate::settings::AppSettings> = None;
    let mut unify_codex_changed = false;
    let mut unify_codex_enabled = false;
    crate::settings::mutate_settings(|current| {
        let merged = merge_settings_for_save(settings, current);
        unify_codex_changed =
            merged.unify_codex_session_history != current.unify_codex_session_history;
        unify_codex_enabled = merged.unify_codex_session_history;
        existing = Some(current.clone());
        *current = merged;
    })
    .map_err(|e| e.to_string())?;
    let existing =
        existing.expect("mutate_settings invokes its mutator exactly once before returning Ok");

    // 统一会话开关变更时立即重写当前官方 Codex 供应商的 live 配置，
    // 不必等下一次切换才生效。
    if unify_codex_changed {
        // live 重写失败时回滚开关并把保存整体报失败：若设置保持已切换状态，
        // live 仍跑旧桶，后续的历史迁移/还原会让会话再次分裂（开启=历史
        // 迁走而新会话仍写 openai 桶；关闭=会话还原而 live 仍写 custom）。
        // 注意前端的保存载荷是完整设置表单（见 useSettings 的 saveSettings），
        // 不只是开关字段——所以这里的回滚只收窄到本代码路径真正拥有的两个
        // unify 字段，其余已合并的字段保持已提交状态（幂等，重新保存即可）。
        if let Err(err) =
            crate::services::provider::reapply_current_codex_official_live(state.inner())
        {
            log::warn!("统一 Codex 会话历史开关变更后重写 live 配置失败，回滚设置: {err}");
            // Revert only the fields this code path owns, inside a fresh
            // `mutate_settings` call that reads whatever is genuinely
            // current at rollback time. A blind `update_settings(existing)`
            // here would swap in the whole pre-merge snapshot and silently
            // discard any concurrent writer (tray failover, another save)
            // that landed on `settings_store` between the merge above and
            // this rollback — reintroducing the exact race this file's
            // `mutate_settings` switch was meant to close.
            let previous_unify = existing.unify_codex_session_history;
            let previous_migrate = existing.unify_codex_migrate_existing;
            if let Err(rollback_err) = crate::settings::mutate_settings(|current| {
                current.unify_codex_session_history = previous_unify;
                current.unify_codex_migrate_existing = previous_migrate;
            }) {
                log::error!("回滚统一会话开关设置失败: {rollback_err}");
            }
            return Err(format!(
                "统一 Codex 会话历史开关未生效（live 配置重写失败）: {err}"
            ));
        }

        if unify_codex_enabled {
            // 后台执行存量迁移（openai 桶 → custom 桶；仅当用户勾选了迁入既有
            // 会话，函数内部自门控）。大会话目录可能要读数秒，不能阻塞设置保存；
            // 失败时不写完成标记，下次启动自动重试。
            tauri::async_runtime::spawn_blocking(|| {
                match crate::codex_history_migration::maybe_migrate_codex_official_history_to_unified_bucket() {
                    Ok(outcome) => {
                        if let Some(reason) = outcome.skipped_reason {
                            log::debug!("○ Codex official history unify migration skipped: {reason}");
                        } else {
                            log::info!(
                                "✓ Codex official history unify migration completed: jsonl_files={}, state_rows={}",
                                outcome.migrated_jsonl_files,
                                outcome.migrated_state_rows
                            );
                        }
                    }
                    Err(e) => {
                        log::warn!("✗ Codex official history unify migration failed: {e}");
                    }
                }
            });
        } else {
            // 清除标记与迁移意愿，让重新开启并再次勾选时能补迁
            // 关闭期间落入 openai 桶的官方会话。
            if let Err(err) = crate::settings::clear_codex_official_history_unify_migration() {
                log::warn!("清除统一会话迁移标记失败: {err}");
            }
            if let Err(err) = crate::settings::clear_codex_unify_migrate_existing() {
                log::warn!("清除统一会话迁移意愿失败: {err}");
            }
        }
    }
    Ok(true)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUnifyHistoryRestoreResult {
    pub restored_jsonl_files: usize,
    pub restored_state_rows: usize,
    /// 本轮因文件疑似活跃而被推迟改写的会话文件数。成功场景下若 >0，
    /// 前端应提示"稍后重试以补齐"，而不是当作完全成功。
    pub deferred_jsonl_files: usize,
    /// 还原被跳过的原因（如当前目录没有账本），前端据此提示而非报"成功 0 项"。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_reason: Option<String>,
}

/// 是否存在统一会话开关的迁移备份（决定关闭弹窗里是否显示"恢复备份"勾选）。
#[tauri::command]
pub async fn has_codex_unify_history_backup() -> Result<bool, String> {
    Ok(crate::codex_history_migration::has_codex_official_history_unify_backup())
}

/// 按迁移备份账本把当时迁入共享桶的官方会话还原回 "openai" 桶。
/// 由关闭统一会话开关的确认弹窗触发；幂等，可安全重试。
#[tauri::command]
pub async fn restore_codex_unified_history() -> Result<CodexUnifyHistoryRestoreResult, String> {
    let outcome = tauri::async_runtime::spawn_blocking(|| {
        crate::codex_history_migration::restore_codex_official_history_from_backups()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    if let Some(reason) = &outcome.skipped_reason {
        log::debug!("○ Codex official history restore skipped: {reason}");
    } else {
        log::info!(
            "✓ Codex official history restored from backups: jsonl_files={}, state_rows={}",
            outcome.restored_jsonl_files,
            outcome.restored_state_rows
        );
    }

    Ok(CodexUnifyHistoryRestoreResult {
        restored_jsonl_files: outcome.restored_jsonl_files,
        restored_state_rows: outcome.restored_state_rows,
        deferred_jsonl_files: outcome.deferred_jsonl_files,
        skipped_reason: outcome.skipped_reason,
    })
}

/// 重启应用程序（当 app_config_dir 变更后使用）
#[tauri::command]
pub async fn restart_app(app: AppHandle) -> Result<bool, String> {
    crate::save_window_state_before_exit(&app);

    // 在后台延迟重启，让函数有时间返回响应
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        // app.restart() 走 RESTART_EXIT_CODE 路径，ExitRequested 处理器会直接
        // 放行给 Tauri 默认 re-exec，不执行代理/Live 清理。但本命令用于
        // app_config_dir 变更后的重启：新实例会切到新数据库，拿不到旧库里的
        // Live 备份，无法恢复被接管的 Live 配置。因此必须趁旧实例的事件循环
        // 仍存活，在这里同步完成恢复（保留代理状态，新实例启动时自动重新接管）。
        crate::cleanup_before_exit(&app).await;
        app.restart();
    });
    Ok(true)
}

/// 已下载并通过签名验证、但尚未安装的更新包。
///
/// 存在内存里而不落盘：`tauri-plugin-updater` 只在 `download()` 过程中校验
/// minisign 签名，落盘再读回就失去了这层保证，而重新实现验签风险更高。安装包
/// 约 13 MB，常驻内存的代价可以接受。
#[derive(Default)]
pub struct StagedUpdate {
    /// 已暂存字节对应的版本号，用于安装前比对，避免装上过期的包。
    pub version: Option<String>,
    pub bytes: Option<Vec<u8>>,
}

pub struct StagedUpdateState(pub std::sync::Arc<tokio::sync::Mutex<StagedUpdate>>);

/// 取出可用于安装 `available` 版本的暂存字节；版本不符则清空暂存槽。
///
/// 版本不匹配时返回 `None`，已被取用过（`bytes` 为 `None`）时同样返回 `None`
/// ——两种情况调用方都应重新下载。抽成纯函数是为了让"绝不安装过期包"这条规则
/// 能被测试覆盖，否则它埋在需要 `AppHandle` 和网络往返的命令里无法验证。
pub(crate) fn take_staged_bytes(staged: &mut StagedUpdate, available: &str) -> Option<Vec<u8>> {
    if staged.version.as_deref() == Some(available) {
        // 命中：取走字节。版本号留着，让重复调用能区分"装过了"和"没暂存过"。
        return staged.bytes.take();
    }
    // 未命中：这份暂存已经过期，丢掉以免占着内存，也杜绝装错版本。
    *staged = StagedUpdate::default();
    None
}

/// 后台下载更新包并暂存，让用户点"立即更新"时可以直接安装、不必等下载。
///
/// 返回已暂存的版本号；无更新或未配置更新源时返回 `None`。整个下载过程持锁：
/// 这样如果用户在暂存途中点了安装，`install_update_and_restart` 会等到这里
/// 完成、直接复用这份字节，而不是并行再下一份。
#[tauri::command]
pub async fn stage_update_download(
    app: AppHandle,
    staged: tauri::State<'_, StagedUpdateState>,
) -> Result<Option<String>, String> {
    if !crate::product_policy::app_update_channel_configured() {
        return Ok(None);
    }

    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("初始化更新器失败: {e}"))?;

    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?
    else {
        // 已是最新：清掉可能残留的旧暂存，否则它会一直占着内存。
        *staged.0.lock().await = StagedUpdate::default();
        return Ok(None);
    };

    let mut guard = staged.0.lock().await;
    if guard.version.as_deref() == Some(update.version.as_str()) && guard.bytes.is_some() {
        return Ok(Some(update.version.clone()));
    }

    log::info!("后台暂存应用更新: {}", update.version);
    let bytes = update
        .download(
            // 故意不发进度事件：用户没触发这次下载，界面上也没有进度条在等它。
            // 13 MB 会产生数千次回调，逐块发 IPC 给零个监听者纯属浪费。安装时
            // 复用这份字节的那条路径会补发一次 100% 的 update-download-progress。
            |_chunk_len, _content_len| {},
            || {},
        )
        .await
        .map_err(|e| format!("下载更新失败: {e}"))?;

    log::info!("✓ 更新包已暂存: {} ({} 字节)", update.version, bytes.len());
    guard.version = Some(update.version.clone());
    guard.bytes = Some(bytes);
    Ok(Some(update.version))
}

/// 下载并安装应用更新，然后由后端直接重启应用。
///
/// macOS 更新会原地替换 `.app` bundle。如果先返回前端、再让旧 WebView 调
/// `process.relaunch()`，旧进程可能已经处在 bundle 被替换后的不稳定窗口期。
/// 这里把退出清理、安装和重启串在同一个后端流程中，避免依赖旧前端继续执行。
#[tauri::command]
pub async fn install_update_and_restart(
    app: AppHandle,
    staged: tauri::State<'_, StagedUpdateState>,
) -> Result<bool, String> {
    if !crate::product_policy::app_update_channel_configured() {
        return Err("Chimera++ update source is not configured".to_string());
    }

    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("初始化更新器失败: {e}"))?;

    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?
    else {
        return Ok(false);
    };

    // 复用后台暂存的字节（如果版本对得上）。持锁等待意味着：若暂存正在进行，
    // 这里会等它下完再直接用，而不是并行下载第二份。
    let mut guard = staged.0.lock().await;
    let staged_bytes = take_staged_bytes(&mut guard, &update.version);
    drop(guard);

    let bytes = match staged_bytes {
        Some(bytes) => {
            log::info!(
                "复用已暂存的更新包: {} ({} 字节)，跳过下载",
                update.version,
                bytes.len()
            );
            // 补发一次"已下载完成"事件，否则前端进度条会停在暂存时的位置。
            let total = bytes.len() as u64;
            let _ = app.emit(
                "update-download-progress",
                UpdateDownloadProgress {
                    downloaded: total,
                    total: Some(total),
                },
            );
            bytes
        }
        None => {
            log::info!("开始下载应用更新: {}", update.version);
            let progress_handle = app.clone();
            let mut downloaded: u64 = 0;
            update
                .download(
                    move |chunk_len, content_len| {
                        downloaded = downloaded.saturating_add(chunk_len as u64);
                        let _ = progress_handle.emit(
                            "update-download-progress",
                            UpdateDownloadProgress {
                                downloaded,
                                total: content_len,
                            },
                        );
                    },
                    || {},
                )
                .await
                .map_err(|e| format!("下载更新失败: {e}"))?
        }
    };

    log::info!("开始安装应用更新: {}", update.version);

    #[cfg(target_os = "windows")]
    {
        // Windows updater 会在 install() 内启动安装器并直接退出当前进程
        // （插件内部 std::process::exit(0)，绕过 TrayIcon::drop、不发
        // NIM_DELETE，会残留死图标——与托盘"退出"路径相同的问题）。
        // 因此清理只能放在 install 前执行，且必须显式移除托盘图标。
        crate::save_window_state_before_exit(&app);
        crate::cleanup_before_exit(&app).await;
        crate::remove_tray_icon_before_exit(&app);
        crate::destroy_single_instance_lock(&app);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        update.install(bytes).map_err(|e| {
            format!(
                "Windows 更新安装失败: {e}。已执行退出前清理，代理或 Live 接管可能已暂停；请重启应用或重新开启代理后再试。"
            )
        })?;
        Ok(true)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // macOS/Linux install() 会返回；先安装，避免安装失败时误停代理/撤回接管。
        update
            .install(bytes)
            .map_err(|e| format!("安装更新失败: {e}"))?;

        crate::save_window_state_before_exit(&app);
        crate::cleanup_before_exit(&app).await;

        log::info!("应用更新安装完成，正在重启应用");
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        crate::restart_process(&app);
    }
}

/// 检查是否有可用的应用更新，返回可用的新版本号（无更新时返回 None）。
///
/// 数据库版本过新的恢复界面用它判断：升级应用能否解决问题。若返回 None，说明
/// 已是最新版本，但数据库仍不兼容（通常由第三方客户端或更高版本创建），应提示用户
/// 升级无法解决，而不是让其反复尝试。
#[tauri::command]
pub async fn check_app_update_available(app: AppHandle) -> Result<Option<String>, String> {
    if !crate::product_policy::app_update_channel_configured() {
        return Ok(None);
    }

    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("初始化更新器失败: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?;
    Ok(update.map(|u| u.version))
}

/// 获取 app_config_dir 覆盖配置 (从 Store)
#[tauri::command]
pub async fn get_app_config_dir_override(app: AppHandle) -> Result<Option<String>, String> {
    Ok(crate::app_store::refresh_app_config_dir_override(&app)
        .map(|p| p.to_string_lossy().to_string()))
}

/// 设置 app_config_dir 覆盖配置 (到 Store)
#[tauri::command]
pub async fn set_app_config_dir_override(
    app: AppHandle,
    path: Option<String>,
) -> Result<bool, String> {
    crate::app_store::set_app_config_dir_to_store(&app, path.as_deref())?;
    Ok(true)
}

/// 设置开机自启
#[tauri::command]
pub async fn set_auto_launch(enabled: bool) -> Result<bool, String> {
    if enabled {
        crate::auto_launch::enable_auto_launch().map_err(|e| format!("启用开机自启失败: {e}"))?;
    } else {
        crate::auto_launch::disable_auto_launch().map_err(|e| format!("禁用开机自启失败: {e}"))?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{merge_settings_for_save, take_staged_bytes, StagedUpdate};
    use crate::settings::{
        AppSettings, CodexOfficialHistoryUnifyMigration, CodexProviderTemplateMigration,
        CodexThirdPartyHistoryProviderBucketMigration, LocalMigrations, S3SyncSettings,
        WebDavSyncSettings,
    };

    fn staged(version: &str, bytes: &[u8]) -> StagedUpdate {
        StagedUpdate {
            version: Some(version.to_string()),
            bytes: Some(bytes.to_vec()),
        }
    }

    #[test]
    fn staged_bytes_are_reused_when_the_version_matches() {
        let mut slot = staged("2.3.0", b"msi");
        assert_eq!(take_staged_bytes(&mut slot, "2.3.0"), Some(b"msi".to_vec()));
    }

    /// The rule worth protecting: a stale package must never be installed. If
    /// the release moved on between staging and install, those bytes are the
    /// wrong build and reusing them would silently install the older version.
    #[test]
    fn stale_staged_bytes_are_discarded_rather_than_installed() {
        let mut slot = staged("2.3.0", b"old");
        assert_eq!(take_staged_bytes(&mut slot, "2.4.0"), None);
        // And the slot is cleared, so the bytes cannot be picked up later.
        assert!(slot.bytes.is_none());
        assert!(slot.version.is_none());
    }

    #[test]
    fn an_empty_slot_reports_no_bytes() {
        let mut slot = StagedUpdate::default();
        assert_eq!(take_staged_bytes(&mut slot, "2.3.0"), None);
    }

    /// Taking twice must not hand out the same bytes again — the second caller
    /// has to download, or it would install from a slot already consumed.
    #[test]
    fn bytes_are_handed_out_only_once() {
        let mut slot = staged("2.3.0", b"msi");
        assert!(take_staged_bytes(&mut slot, "2.3.0").is_some());
        assert_eq!(take_staged_bytes(&mut slot, "2.3.0"), None);
    }

    /// A consumed slot keeps its version, so a later mismatched request still
    /// takes the discard path rather than looking like a fresh empty slot.
    #[test]
    fn a_consumed_slot_still_discards_on_version_mismatch() {
        let mut slot = staged("2.3.0", b"msi");
        take_staged_bytes(&mut slot, "2.3.0");
        assert_eq!(slot.version.as_deref(), Some("2.3.0"));
        assert_eq!(take_staged_bytes(&mut slot, "2.4.0"), None);
        assert!(slot.version.is_none());
    }

    #[test]
    fn save_settings_should_preserve_existing_webdav_when_payload_omits_it() {
        let existing = AppSettings {
            webdav_sync: Some(WebDavSyncSettings {
                base_url: "https://dav.example.com".to_string(),
                username: "alice".to_string(),
                password: "secret".to_string(),
                ..WebDavSyncSettings::default()
            }),
            ..AppSettings::default()
        };

        let incoming = AppSettings::default();
        let merged = merge_settings_for_save(incoming, &existing);

        assert!(merged.webdav_sync.is_some());
        assert_eq!(
            merged.webdav_sync.as_ref().map(|v| v.base_url.as_str()),
            Some("https://dav.example.com")
        );
    }

    #[test]
    fn save_settings_should_keep_incoming_webdav_when_present() {
        let existing = AppSettings {
            webdav_sync: Some(WebDavSyncSettings {
                base_url: "https://dav.old.example.com".to_string(),
                username: "old".to_string(),
                password: "old-pass".to_string(),
                ..WebDavSyncSettings::default()
            }),
            ..AppSettings::default()
        };

        let incoming = AppSettings {
            webdav_sync: Some(WebDavSyncSettings {
                base_url: "https://dav.new.example.com".to_string(),
                username: "new".to_string(),
                password: "new-pass".to_string(),
                ..WebDavSyncSettings::default()
            }),
            ..AppSettings::default()
        };

        let merged = merge_settings_for_save(incoming, &existing);

        assert_eq!(
            merged.webdav_sync.as_ref().map(|v| v.base_url.as_str()),
            Some("https://dav.new.example.com")
        );
    }

    /// Regression test: frontend always receives empty password from
    /// get_settings_for_frontend(). If a component accidentally spreads
    /// the full settings object into save_settings, the empty password
    /// must NOT overwrite the existing one.
    #[test]
    fn save_settings_should_preserve_password_when_incoming_has_empty_password() {
        let existing = AppSettings {
            webdav_sync: Some(WebDavSyncSettings {
                base_url: "https://dav.example.com".to_string(),
                username: "alice".to_string(),
                password: "secret".to_string(),
                ..WebDavSyncSettings::default()
            }),
            ..AppSettings::default()
        };

        // Simulate frontend sending settings with cleared password
        let incoming = AppSettings {
            webdav_sync: Some(WebDavSyncSettings {
                base_url: "https://dav.example.com".to_string(),
                username: "alice".to_string(),
                password: "".to_string(),
                ..WebDavSyncSettings::default()
            }),
            ..AppSettings::default()
        };

        let merged = merge_settings_for_save(incoming, &existing);

        assert_eq!(
            merged.webdav_sync.as_ref().map(|v| v.password.as_str()),
            Some("secret"),
            "empty password from frontend must not overwrite existing password"
        );
    }

    /// When both incoming and existing have no password, merge should
    /// work without panicking and keep the empty state.
    #[test]
    fn save_settings_should_handle_both_empty_passwords() {
        let existing = AppSettings {
            webdav_sync: Some(WebDavSyncSettings {
                base_url: "https://dav.example.com".to_string(),
                username: "alice".to_string(),
                password: "".to_string(),
                ..WebDavSyncSettings::default()
            }),
            ..AppSettings::default()
        };

        let incoming = AppSettings {
            webdav_sync: Some(WebDavSyncSettings {
                base_url: "https://dav.example.com".to_string(),
                username: "alice".to_string(),
                password: "".to_string(),
                ..WebDavSyncSettings::default()
            }),
            ..AppSettings::default()
        };

        let merged = merge_settings_for_save(incoming, &existing);

        assert_eq!(
            merged.webdav_sync.as_ref().map(|v| v.password.as_str()),
            Some("")
        );
    }

    #[test]
    fn save_settings_should_preserve_existing_s3_when_payload_omits_it() {
        let existing = AppSettings {
            s3_sync: Some(S3SyncSettings {
                bucket: "bucket".to_string(),
                access_key_id: "ak".to_string(),
                secret_access_key: "secret".to_string(),
                ..S3SyncSettings::default()
            }),
            ..AppSettings::default()
        };

        let incoming = AppSettings::default();
        let merged = merge_settings_for_save(incoming, &existing);

        assert!(merged.s3_sync.is_some());
        assert_eq!(
            merged
                .s3_sync
                .as_ref()
                .map(|v| v.secret_access_key.as_str()),
            Some("secret")
        );
    }

    #[test]
    fn save_settings_should_preserve_s3_secret_when_incoming_has_empty_secret() {
        let existing = AppSettings {
            s3_sync: Some(S3SyncSettings {
                bucket: "bucket".to_string(),
                access_key_id: "ak".to_string(),
                secret_access_key: "secret".to_string(),
                ..S3SyncSettings::default()
            }),
            ..AppSettings::default()
        };

        let incoming = AppSettings {
            s3_sync: Some(S3SyncSettings {
                bucket: "bucket".to_string(),
                access_key_id: "ak".to_string(),
                secret_access_key: "".to_string(),
                ..S3SyncSettings::default()
            }),
            ..AppSettings::default()
        };

        let merged = merge_settings_for_save(incoming, &existing);

        assert_eq!(
            merged
                .s3_sync
                .as_ref()
                .map(|v| v.secret_access_key.as_str()),
            Some("secret")
        );
    }

    #[test]
    fn save_settings_should_preserve_local_migrations_when_payload_omits_it() {
        let existing = AppSettings {
            local_migrations: Some(LocalMigrations {
                codex_third_party_history_provider_bucket_v1: Some(
                    CodexThirdPartyHistoryProviderBucketMigration {
                        completed_at: "2026-05-20T00:00:00Z".to_string(),
                        target_provider_id: "custom".to_string(),
                        source_provider_ids: vec!["rightcode".to_string()],
                        migrated_jsonl_files: 2,
                        migrated_state_rows: 3,
                        scanned_history_files: true,
                    },
                ),
                codex_provider_template_v1: Some(CodexProviderTemplateMigration {
                    completed_at: "2026-05-20T00:01:00Z".to_string(),
                    migrated_provider_ids: vec!["legacy".to_string()],
                }),
                codex_official_history_unify_v1: Some(CodexOfficialHistoryUnifyMigration {
                    completed_at: "2026-06-12T00:00:00Z".to_string(),
                    target_provider_id: "custom".to_string(),
                    migrated_jsonl_files: 5,
                    migrated_state_rows: 7,
                    codex_config_dir: None,
                }),
            }),
            ..AppSettings::default()
        };

        let incoming = AppSettings::default();
        let merged = merge_settings_for_save(incoming, &existing);

        let migration = merged
            .local_migrations
            .as_ref()
            .and_then(|migrations| {
                migrations
                    .codex_third_party_history_provider_bucket_v1
                    .as_ref()
            })
            .expect("local migration marker should be preserved");
        assert_eq!(migration.target_provider_id, "custom");
        assert_eq!(migration.migrated_jsonl_files, 2);
        assert_eq!(migration.migrated_state_rows, 3);

        let template_migration = merged
            .local_migrations
            .as_ref()
            .and_then(|migrations| migrations.codex_provider_template_v1.as_ref())
            .expect("template migration marker should be preserved");
        assert_eq!(
            template_migration.migrated_provider_ids,
            vec!["legacy".to_string()]
        );

        let unify_migration = merged
            .local_migrations
            .as_ref()
            .and_then(|migrations| migrations.codex_official_history_unify_v1.as_ref())
            .expect("official unify migration marker should be preserved");
        assert_eq!(unify_migration.migrated_jsonl_files, 5);
        assert_eq!(unify_migration.migrated_state_rows, 7);
    }

    /// incoming 带有 local_migrations（哪怕是空的）也不能覆盖后端维护的标记。
    #[test]
    fn save_settings_should_keep_backend_migration_markers_over_incoming() {
        let existing = AppSettings {
            local_migrations: Some(LocalMigrations {
                codex_third_party_history_provider_bucket_v1: None,
                codex_provider_template_v1: None,
                codex_official_history_unify_v1: Some(CodexOfficialHistoryUnifyMigration {
                    completed_at: "2026-06-12T00:00:00Z".to_string(),
                    target_provider_id: "custom".to_string(),
                    migrated_jsonl_files: 1,
                    migrated_state_rows: 2,
                    codex_config_dir: None,
                }),
            }),
            ..AppSettings::default()
        };

        let incoming = AppSettings {
            local_migrations: Some(LocalMigrations::default()),
            ..AppSettings::default()
        };
        let merged = merge_settings_for_save(incoming, &existing);

        assert!(merged
            .local_migrations
            .as_ref()
            .and_then(|migrations| migrations.codex_official_history_unify_v1.as_ref())
            .is_some());
    }

    /// 后端清掉 marker 后（如关闭统一会话开关）、前端缓存刷新前的全量保存
    /// 会携带旧 marker；merge 必须忽略它，否则被"复活"的标记会让重新开启
    /// 时误判已迁移而漏迁。
    #[test]
    fn save_settings_should_ignore_stale_incoming_migration_markers() {
        let existing = AppSettings::default();

        let incoming = AppSettings {
            local_migrations: Some(LocalMigrations {
                codex_official_history_unify_v1: Some(CodexOfficialHistoryUnifyMigration {
                    completed_at: "2026-06-12T00:00:00Z".to_string(),
                    target_provider_id: "custom".to_string(),
                    migrated_jsonl_files: 1,
                    migrated_state_rows: 2,
                    codex_config_dir: None,
                }),
                ..LocalMigrations::default()
            }),
            ..AppSettings::default()
        };
        let merged = merge_settings_for_save(incoming, &existing);

        assert!(merged.local_migrations.is_none());
    }
}

/// 获取开机自启状态
#[tauri::command]
pub async fn get_auto_launch_status() -> Result<bool, String> {
    crate::auto_launch::is_auto_launch_enabled().map_err(|e| format!("获取开机自启状态失败: {e}"))
}

/// 获取整流器配置
#[tauri::command]
pub async fn get_rectifier_config(
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::proxy::types::RectifierConfig, String> {
    state.db.get_rectifier_config().map_err(|e| e.to_string())
}

/// 设置整流器配置
#[tauri::command]
pub async fn set_rectifier_config(
    state: tauri::State<'_, crate::AppState>,
    config: crate::proxy::types::RectifierConfig,
) -> Result<bool, String> {
    state
        .db
        .set_rectifier_config(&config)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// 获取优化器配置
#[tauri::command]
pub async fn get_optimizer_config(
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::proxy::types::OptimizerConfig, String> {
    state.db.get_optimizer_config().map_err(|e| e.to_string())
}

/// 设置优化器配置
#[tauri::command]
pub async fn set_optimizer_config(
    state: tauri::State<'_, crate::AppState>,
    config: crate::proxy::types::OptimizerConfig,
) -> Result<bool, String> {
    state
        .db
        .set_optimizer_config(&config)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// 获取 Copilot 优化器配置
#[tauri::command]
pub async fn get_copilot_optimizer_config(
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::proxy::types::CopilotOptimizerConfig, String> {
    state
        .db
        .get_copilot_optimizer_config()
        .map_err(|e| e.to_string())
}

/// 设置 Copilot 优化器配置
#[tauri::command]
pub async fn set_copilot_optimizer_config(
    state: tauri::State<'_, crate::AppState>,
    config: crate::proxy::types::CopilotOptimizerConfig,
) -> Result<bool, String> {
    state
        .db
        .set_copilot_optimizer_config(&config)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// 获取日志配置
#[tauri::command]
pub async fn get_log_config(
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::proxy::types::LogConfig, String> {
    state.db.get_log_config().map_err(|e| e.to_string())
}

/// 设置日志配置
#[tauri::command]
pub async fn set_log_config(
    state: tauri::State<'_, crate::AppState>,
    config: crate::proxy::types::LogConfig,
) -> Result<bool, String> {
    state
        .db
        .set_log_config(&config)
        .map_err(|e| e.to_string())?;
    log::set_max_level(config.to_level_filter());
    log::info!(
        "日志配置已更新: enabled={}, level={}",
        config.enabled,
        config.level
    );
    Ok(true)
}
