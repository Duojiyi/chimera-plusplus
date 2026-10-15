#[tauri::command]
pub fn enter_lightweight_mode(app: tauri::AppHandle) -> Result<(), String> {
    crate::lightweight::enter_lightweight_mode(&app)
}

#[tauri::command]
pub fn exit_lightweight_mode(app: tauri::AppHandle) -> Result<(), String> {
    crate::lightweight::exit_lightweight_mode(&app)
}

#[tauri::command]
pub fn is_lightweight_mode() -> bool {
    crate::lightweight::is_lightweight_mode()
}

/// Whether silent startup hid the window for this launch; consumed once, so a
/// reload after the window was opened by the tray or a link still shows it.
#[tauri::command]
pub fn take_started_hidden() -> bool {
    crate::lightweight::take_started_hidden()
}

#[tauri::command]
pub fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    crate::lightweight::hide_main_window(&app)
}
