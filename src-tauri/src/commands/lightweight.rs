#[tauri::command]
pub fn enter_lightweight_mode(app: tauri::AppHandle) -> Result<(), String> {
    crate::lightweight::enter_lightweight_mode(&app)
}

#[tauri::command]
pub fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    crate::lightweight::hide_main_window(&app)
}
