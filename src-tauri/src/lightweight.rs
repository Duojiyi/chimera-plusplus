use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

static LIGHTWEIGHT_MODE: AtomicBool = AtomicBool::new(false);

pub fn hide_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
        #[cfg(target_os = "windows")]
        window.set_skip_taskbar(true).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        crate::tray::apply_tray_policy(app, false);
    }
    Ok(())
}

pub fn enter_lightweight_mode(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_skip_taskbar(true);
        }
    }
    #[cfg(target_os = "macos")]
    {
        crate::tray::apply_tray_policy(app, false);
    }

    if let Some(window) = app.get_webview_window("main") {
        crate::save_window_state_before_exit(app);
        window
            .destroy()
            .map_err(|e| format!("销毁主窗口失败: {e}"))?;
    }
    // else: already in lightweight mode or window not found, just set the flag

    LIGHTWEIGHT_MODE.store(true, Ordering::Release);
    crate::tray::refresh_tray_menu(app);
    log::info!("进入轻量模式");
    Ok(())
}

pub fn exit_lightweight_mode(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "linux")]
        {
            crate::linux_fix::nudge_main_window(window.clone());
        }
        #[cfg(target_os = "windows")]
        {
            let _ = window.set_skip_taskbar(false);
        }
        #[cfg(target_os = "macos")]
        {
            crate::tray::apply_tray_policy(app, true);
        }
        LIGHTWEIGHT_MODE.store(false, Ordering::Release);
        crate::tray::refresh_tray_menu(app);
        log::info!("退出轻量模式");
        return Ok(());
    }

    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .ok_or("主窗口配置未找到")?;

    WebviewWindowBuilder::from_config(app, window_config)
        .map_err(|e| format!("加载主窗口配置失败: {e}"))?
        .build()
        .map_err(|e| format!("创建主窗口失败: {e}"))?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "linux")]
        {
            crate::linux_fix::nudge_main_window(window.clone());
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_skip_taskbar(false);
        }
    }
    #[cfg(target_os = "macos")]
    {
        crate::tray::apply_tray_policy(app, true);
    }

    LIGHTWEIGHT_MODE.store(false, Ordering::Release);
    crate::tray::refresh_tray_menu(app);
    log::info!("退出轻量模式");
    Ok(())
}

pub fn is_lightweight_mode() -> bool {
    LIGHTWEIGHT_MODE.load(Ordering::Acquire)
}

/// Marker for "show the main window on the next start", left by a restart or
/// update the user asked for: with silent startup on, the relaunch would
/// otherwise go to the tray and the window they were using would vanish. A
/// file, because the Windows installer relaunches the app without arguments.
const WINDOW_ON_NEXT_START: &str = "show-window-on-next-start";

pub fn request_window_on_next_start(app: &tauri::AppHandle) {
    match app.path().app_local_data_dir() {
        Ok(dir) => request_window_on_next_start_in(&dir),
        Err(error) => log::warn!("无法记录下次启动显示主窗口: {error}"),
    }
}

/// Whether the previous run asked for a visible start. Consumes the request,
/// so it applies to one start only.
pub fn take_window_on_next_start(app: &tauri::AppHandle) -> bool {
    app.path()
        .app_local_data_dir()
        .map(|dir| take_window_on_next_start_in(&dir))
        .unwrap_or(false)
}

fn request_window_on_next_start_in(dir: &std::path::Path) {
    let written = std::fs::create_dir_all(dir)
        .and_then(|()| std::fs::write(dir.join(WINDOW_ON_NEXT_START), b""));
    if let Err(error) = written {
        log::warn!("无法记录下次启动显示主窗口: {error}");
    }
}

fn take_window_on_next_start_in(dir: &std::path::Path) -> bool {
    std::fs::remove_file(dir.join(WINDOW_ON_NEXT_START)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_requested_visible_start_applies_once() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!take_window_on_next_start_in(dir.path()));
        request_window_on_next_start_in(dir.path());
        assert!(take_window_on_next_start_in(dir.path()));
        // The following start is an ordinary one again.
        assert!(!take_window_on_next_start_in(dir.path()));
    }
}
