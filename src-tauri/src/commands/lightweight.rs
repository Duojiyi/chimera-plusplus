use tauri::Manager;

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn enter_lightweight_mode(
    window: tauri::WebviewWindow,
    main_activation: u64,
) -> Result<(), String> {
    if !can_destroy_main(&window, main_activation)? {
        return Ok(());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::lightweight::enter_lightweight_mode(&app, main_activation)
    })
    .await
    .map_err(|error| error.to_string())?
}

// State saving reads the native window's geometry. Keep it on the UI thread
// on these platforms so geometry events cannot wait on its cache lock.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn enter_lightweight_mode(
    window: tauri::WebviewWindow,
    main_activation: u64,
) -> Result<(), String> {
    if can_destroy_main(&window, main_activation)? {
        crate::lightweight::enter_lightweight_mode(window.app_handle(), main_activation)?;
    }
    Ok(())
}

fn can_destroy_main(window: &tauri::WebviewWindow, main_activation: u64) -> Result<bool, String> {
    if !can_finish_close(window, main_activation)? {
        return Ok(false);
    }
    if super::runtime_operation_in_progress() {
        return Err("Codex 正在维护，请等待当前操作完成".into());
    }
    Ok(true)
}

#[tauri::command]
pub fn hide_main_window(window: tauri::WebviewWindow, main_activation: u64) -> Result<(), String> {
    if can_finish_close(&window, main_activation)? {
        crate::lightweight::hide_main_window(window.app_handle(), main_activation)?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_main_window(window: tauri::WebviewWindow, main_activation: u64) -> Result<(), String> {
    if can_finish_close(&window, main_activation)? {
        crate::lightweight::activate_main_window(window.app_handle(), &window)?;
    }
    Ok(())
}

fn can_finish_close(window: &tauri::WebviewWindow, main_activation: u64) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("此操作仅可从主窗口调用".into());
    }
    Ok(main_activation == crate::lightweight::main_activation())
}
