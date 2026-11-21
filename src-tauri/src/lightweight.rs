use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, Manager};

static LIGHTWEIGHT_MODE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseRequest {
    from_tray: bool,
    main_activation: u64,
}

pub(crate) fn main_activation() -> u64 {
    #[cfg(target_os = "windows")]
    return crate::tray_panel::main_activation();

    #[cfg(not(target_os = "windows"))]
    0
}

pub(crate) fn request_close(app: &tauri::AppHandle, from_tray: bool) -> Result<(), String> {
    app.emit(
        "request-lightweight-close",
        CloseRequest {
            from_tray,
            main_activation: main_activation(),
        },
    )
    .map_err(|error| error.to_string())
}

pub fn hide_main_window(app: &tauri::AppHandle, main_activation: u64) -> Result<(), String> {
    if main_activation != self::main_activation() {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
        #[cfg(target_os = "windows")]
        {
            crate::tray_panel::finish_main_close(main_activation);
            window.set_skip_taskbar(true).map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "macos")]
        crate::tray::apply_tray_policy(app, false);
    }
    Ok(())
}

/// On Windows this must run on a worker so it can wait for window destruction.
pub fn enter_lightweight_mode(app: &tauri::AppHandle, main_activation: u64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return crate::tray_panel::enter_lightweight_from_worker(app, main_activation);

    #[cfg(not(target_os = "windows"))]
    {
        let _ = main_activation;
        enter_lightweight_with(app, |window| {
            window
                .destroy()
                .map_err(|error| format!("销毁主窗口失败: {error}"))
        })
        .map(|_| ())
    }
}

/// Returns whether there was a main window to destroy.
pub(crate) fn enter_lightweight_with(
    app: &tauri::AppHandle,
    destroy: impl FnOnce(&tauri::WebviewWindow) -> Result<(), String>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    crate::tray::apply_tray_policy(app, false);

    let window = app.get_webview_window("main");
    if let Some(window) = &window {
        crate::save_window_state_before_exit(app);
        destroy(window)?;
    }

    LIGHTWEIGHT_MODE.store(true, Ordering::Release);
    crate::tray::refresh_tray_menu(app);
    log::info!("进入轻量模式");
    Ok(window.is_some())
}

/// Reveal the existing main window or recreate it when lightweight mode
/// destroyed its webview. Call from a worker when invoked by a Windows tray
/// event, so WebView2 can initialize on the main thread.
pub fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return crate::tray_panel::restore_main_from_worker(app);

    #[cfg(not(target_os = "windows"))]
    {
        let window = match app.get_webview_window("main") {
            Some(window) => window,
            None => create_main_window(app)?,
        };
        activate_main_window(app, &window)
    }
}

pub(crate) fn create_main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or("主窗口配置未找到")?;
    tauri::WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| format!("加载主窗口配置失败: {error}"))?
        .visible(false)
        .focused(false)
        .build()
        .map_err(|error| format!("创建主窗口失败: {error}"))
}

pub(crate) fn activate_main_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    window
        .set_skip_taskbar(false)
        .map_err(|error| format!("恢复任务栏图标失败: {error}"))?;
    window
        .unminimize()
        .and_then(|()| window.show())
        .and_then(|()| window.set_focus())
        .map_err(|error| format!("打开主窗口失败: {error}"))?;
    #[cfg(target_os = "linux")]
    crate::linux_fix::nudge_main_window(window.clone());
    #[cfg(target_os = "macos")]
    crate::tray::apply_tray_policy(app, true);

    if LIGHTWEIGHT_MODE.swap(false, Ordering::AcqRel) {
        crate::tray::refresh_tray_menu(app);
        log::info!("退出轻量模式");
    }
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
