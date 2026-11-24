//! Windows tray flyout and mouse gestures.
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect, WebviewUrl, WebviewWindow};

use crate::app_config::AppType;
use crate::store::AppState;

pub const LABEL: &str = "tray-panel";
const WIDTH: u32 = 388;
const HEIGHT: u32 = 532;
const GAP: u32 = 8;
static BUILD: Mutex<()> = Mutex::new(());
static INTENT: Mutex<WindowIntent> = Mutex::new(WindowIntent::new());
static ACTIVE_PANEL_OPS: AtomicUsize = AtomicUsize::new(0);
const LIGHTWEIGHT_PANEL_IDLE_REAP: Duration = Duration::from_secs(20);

struct PanelOpGuard;

impl PanelOpGuard {
    fn enter() -> Self {
        ACTIVE_PANEL_OPS.fetch_add(1, Ordering::AcqRel);
        Self
    }
}

impl Drop for PanelOpGuard {
    fn drop(&mut self) {
        ACTIVE_PANEL_OPS.fetch_sub(1, Ordering::AcqRel);
    }
}

struct WindowIntent {
    panel: u64,
    main_activation: u64,
    tray_main: Option<u64>,
    explicit_main: Option<u64>,
}

#[derive(Debug, PartialEq, Eq)]
enum PanelActivation {
    Show,
    RestoreMainFirst(u64),
}

impl WindowIntent {
    const fn new() -> Self {
        Self {
            panel: 0,
            main_activation: 0,
            tray_main: None,
            explicit_main: None,
        }
    }

    fn cancel_panel(&mut self) {
        self.panel = self.panel.wrapping_add(1);
    }

    fn next_panel(&mut self) -> u64 {
        // A newer tray gesture supersedes a double-click, but cannot cancel a
        // second launch, deep link, or explicit request to open the main window.
        self.tray_main = None;
        self.cancel_panel();
        self.panel
    }

    fn next_activation(&mut self) -> u64 {
        self.cancel_panel();
        self.main_activation = self.main_activation.wrapping_add(1);
        self.main_activation
    }

    fn next_tray_main(&mut self) -> u64 {
        let activation = self.next_activation();
        self.tray_main = Some(activation);
        activation
    }

    fn next_main(&mut self) -> u64 {
        let activation = self.next_activation();
        self.tray_main = None;
        self.explicit_main = Some(activation);
        activation
    }

    fn is_panel_current(&self, request: u64) -> bool {
        self.panel == request
    }

    fn is_main_current(&self, request: u64) -> bool {
        self.tray_main == Some(request) || self.explicit_main == Some(request)
    }

    fn panel_activation(&self, request: u64) -> Option<PanelActivation> {
        self.is_panel_current(request)
            .then_some(match self.explicit_main {
                Some(main) => PanelActivation::RestoreMainFirst(main),
                None => PanelActivation::Show,
            })
    }

    fn finish_main_activation(&mut self, request: u64) {
        if self.tray_main == Some(request) {
            self.tray_main = None;
        }
        if self.explicit_main == Some(request) {
            self.explicit_main = None;
        }
    }

    fn finish_close(&mut self, generation: u64) {
        if self.main_activation == generation {
            self.tray_main = None;
            self.explicit_main = None;
        }
    }
}

fn intents() -> std::sync::MutexGuard<'static, WindowIntent> {
    INTENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Default)]
pub struct TrayClicks {
    skip_left_release: AtomicBool,
}

enum ClickAction {
    ShowPanel {
        icon: Rect,
        wait_for_double_click: bool,
    },
    ShowMain,
}

impl TrayClicks {
    fn action(&self, event: &TrayIconEvent) -> Option<ClickAction> {
        use MouseButton::{Left, Right};
        use MouseButtonState::{Down, Up};

        match event {
            TrayIconEvent::DoubleClick { button: Left, .. } => {
                // Windows sends double-click in place of the second press,
                // followed by another release on the same button.
                self.skip_left_release.store(true, Ordering::Relaxed);
                Some(ClickAction::ShowMain)
            }
            TrayIconEvent::Click {
                button: Left,
                button_state: Down,
                ..
            } => {
                // A fresh press also recovers when the last release was lost.
                self.skip_left_release.store(false, Ordering::Relaxed);
                None
            }
            TrayIconEvent::Click {
                button: Left,
                button_state: Up,
                ..
            } if self.skip_left_release.swap(false, Ordering::Relaxed) => None,
            TrayIconEvent::Click {
                button: button @ (Left | Right),
                button_state: Up,
                rect,
                ..
            } => Some(ClickAction::ShowPanel {
                icon: *rect,
                wait_for_double_click: *button == Left,
            }),
            _ => None,
        }
    }

    fn request(
        &self,
        event: &TrayIconEvent,
        intents: &mut WindowIntent,
    ) -> Option<(u64, ClickAction)> {
        self.action(event).map(|action| {
            let intent = match action {
                ClickAction::ShowMain => intents.next_tray_main(),
                ClickAction::ShowPanel { .. } => intents.next_panel(),
            };
            (intent, action)
        })
    }

    pub fn handle(&self, app: &AppHandle, event: &TrayIconEvent) {
        let request = self.request(event, &mut intents());
        match request {
            Some((
                intent,
                ClickAction::ShowPanel {
                    icon,
                    wait_for_double_click,
                },
            )) => {
                show(app, icon, wait_for_double_click, intent);
            }
            Some((intent, ClickAction::ShowMain)) => spawn_main_activation(app, intent),
            None => {}
        }
    }
}

fn show(app: &AppHandle, icon: Rect, wait_for_double_click: bool, intent: u64) {
    let app = app.clone();
    // WebView2 creation can wait on the UI thread even when a Tauri method
    // is marked sync. The tray callback must return to its message loop.
    let show_panel = move || {
        if let Err(error) = show_from_worker(&app, icon, intent) {
            log::warn!("打开托盘面板失败: {error}");
            recover_panel_failure(&app, intent);
        }
    };
    if wait_for_double_click {
        // Focusing the flyout on the first release can close the notification
        // overflow before Windows has a chance to deliver the double-click.
        // SAFETY: GetDoubleClickTime takes no arguments and reads system state.
        let delay =
            unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime() };
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(u64::from(delay))).await;
            if intents().is_panel_current(intent) {
                tauri::async_runtime::spawn_blocking(show_panel);
            }
        });
    } else {
        tauri::async_runtime::spawn_blocking(show_panel);
    }
}

fn recover_panel_failure(app: &AppHandle, panel: u64) {
    let activation = {
        let mut state = intents();
        state
            .is_panel_current(panel)
            .then(|| state.next_tray_main())
    };
    if let Some(activation) = activation {
        spawn_main_activation(app, activation);
    }
}

fn spawn_main_activation(app: &AppHandle, intent: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = activate_main_from_worker(&app, intent) {
            log::error!("打开主窗口失败: {error}");
        }
    });
}

/// Reserve a window action when the user requests it, before queuing worker work.
pub(crate) fn request_main_activation() -> u64 {
    intents().next_main()
}

pub(crate) fn main_activation() -> u64 {
    intents().main_activation
}

pub(crate) fn finish_main_close(generation: u64) {
    intents().finish_close(generation);
}

pub(crate) fn restore_main_from_worker(app: &AppHandle) -> Result<(), String> {
    activate_main_from_worker(app, request_main_activation())
}

fn discard_unshown_main(created: bool, lightweight: bool, visible: bool) -> bool {
    created && lightweight && !visible
}

pub(crate) fn activate_main_from_worker(app: &AppHandle, intent: u64) -> Result<(), String> {
    let _creation = BUILD.lock().map_err(|_| "主窗口不可用")?;
    activate_pending_main(app, intent)
}

// Caller holds BUILD so the worker and the panel can share a pending restore.
fn activate_pending_main(app: &AppHandle, intent: u64) -> Result<(), String> {
    let outcome = restore_main_window(app, intent);
    intents().finish_main_activation(intent);
    outcome
}

fn restore_main_window(app: &AppHandle, intent: u64) -> Result<(), String> {
    if !intents().is_main_current(intent) {
        return Ok(());
    }
    let (window, created) = match app.get_webview_window("main") {
        Some(window) => (window, false),
        None => (crate::lightweight::create_main_window(app)?, true),
    };
    let handle = app.clone();
    let (complete, result) = mpsc::channel();
    // WebView2 creation can outlast a newer tray gesture. Finalize on the UI
    // thread, and keep the worker lock until a discarded window is unregistered
    // so another restore can't pick up its closing handle.
    app.run_on_main_thread(move || {
        let outcome = if intents().is_main_current(intent) {
            crate::lightweight::activate_main_window(&handle, &window).inspect(|()| {
                if intents().is_main_current(intent) {
                    hide_window(&handle);
                }
            })
        } else if discard_unshown_main(
            created,
            crate::lightweight::is_lightweight_mode(),
            window.is_visible().unwrap_or(true),
        ) {
            match destroy_main_window(&window, complete.clone()) {
                Ok(()) => return,
                Err(error) => Err(error),
            }
        } else {
            Ok(())
        };
        let _ = complete.send(outcome);
    })
    .map_err(|error| error.to_string())?;
    result.recv().map_err(|_| "主窗口恢复已中断")?
}

fn destroy_main_window(
    window: &WebviewWindow,
    complete: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    window.on_window_event(move |event| {
        // Tauri removes the window from its manager before invoking this listener.
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = complete.send(Ok(()));
        }
    });
    window
        .destroy()
        .map_err(|error| format!("销毁主窗口失败: {error}"))
}

pub(crate) fn enter_lightweight_from_worker(
    app: &AppHandle,
    main_activation: u64,
) -> Result<(), String> {
    // Keep this lock through Destroyed, so a restore cannot reuse a closing window.
    let _creation = BUILD.lock().map_err(|_| "主窗口不可用")?;
    let handle = app.clone();
    let (complete, result) = mpsc::channel();
    app.run_on_main_thread(move || {
        if main_activation != intents().main_activation {
            let _ = complete.send(Ok(()));
            return;
        }
        if crate::commands::runtime_operation_in_progress() {
            let _ = complete.send(Err("Codex 正在维护，请等待当前操作完成".into()));
            return;
        }
        let closed = crate::lightweight::enter_lightweight_with(&handle, |window| {
            destroy_main_window(window, complete.clone())
        });
        if closed.is_ok() {
            finish_main_close(main_activation);
        }
        match closed {
            Ok(true) => {} // The Destroyed listener sends the result.
            Ok(false) => {
                let _ = complete.send(Ok(()));
            }
            Err(error) => {
                let _ = complete.send(Err(error));
            }
        }
    })
    .map_err(|error| error.to_string())?;
    let outcome = result.recv().map_err(|_| "关闭主窗口已中断")?;
    if outcome.is_ok() {
        schedule_idle_reap(app);
    }
    outcome
}

fn schedule_idle_reap(app: &AppHandle) {
    if !crate::lightweight::is_lightweight_mode() || app.get_webview_window(LABEL).is_none() {
        return;
    }
    let expected_panel = intents().panel;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LIGHTWEIGHT_PANEL_IDLE_REAP).await;
        if !crate::lightweight::is_lightweight_mode()
            || !intents().is_panel_current(expected_panel)
            || ACTIVE_PANEL_OPS.load(Ordering::Acquire) > 0
        {
            return;
        }
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let Ok(_creation) = BUILD.lock() else {
                return;
            };
            if !crate::lightweight::is_lightweight_mode()
                || !intents().is_panel_current(expected_panel)
                || ACTIVE_PANEL_OPS.load(Ordering::Acquire) > 0
            {
                return;
            }
            let handle = app.clone();
            let (complete, result) = mpsc::channel();
            if app
                .run_on_main_thread(move || {
                    if !crate::lightweight::is_lightweight_mode()
                        || !intents().is_panel_current(expected_panel)
                        || ACTIVE_PANEL_OPS.load(Ordering::Acquire) > 0
                    {
                        let _ = complete.send(());
                        return;
                    }
                    if let Some(window) = handle.get_webview_window(LABEL) {
                        if !window.is_visible().unwrap_or(true) {
                            let done = complete.clone();
                            window.on_window_event(move |event| {
                                if matches!(event, tauri::WindowEvent::Destroyed) {
                                    let _ = done.send(());
                                }
                            });
                            if window.destroy().is_ok() {
                                return;
                            }
                        }
                    }
                    let _ = complete.send(());
                })
                .is_ok()
            {
                let _ = result.recv_timeout(Duration::from_secs(5));
            }
        })
        .await;
    });
}

async fn open_main_from_panel(app: AppHandle) -> Result<(), String> {
    let intent = request_main_activation();
    tauri::async_runtime::spawn_blocking(move || activate_main_from_worker(&app, intent))
        .await
        .map_err(|error| error.to_string())?
}

pub fn hide(app: &AppHandle) {
    intents().cancel_panel();
    hide_window(app);
}

fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
    schedule_idle_reap(app);
}

fn show_from_worker(app: &AppHandle, icon: Rect, intent: u64) -> Result<(), String> {
    let _creation = BUILD.lock().map_err(|_| "托盘面板不可用")?;
    let activation = intents().panel_activation(intent);
    match activation {
        None => return Ok(()),
        Some(PanelActivation::RestoreMainFirst(restore)) => {
            // Preserve a second launch or deep link, but give the newer tray
            // click final focus regardless of which worker acquired BUILD first.
            if let Err(error) = activate_pending_main(app, restore) {
                log::error!("恢复托盘面板前打开主窗口失败: {error}");
            }
            if !intents().is_panel_current(intent) {
                return Ok(());
            }
        }
        Some(PanelActivation::Show) => {}
    }
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => {
            let built =
                tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
                    .title("Chimera++ · 托盘")
                    .decorations(false)
                    .shadow(true)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .resizable(false)
                    .drag_and_drop(false)
                    .visible(false)
                    .focused(false)
                    .inner_size(f64::from(WIDTH), f64::from(HEIGHT))
                    .build()
                    .map_err(|error| error.to_string())?;
            apply_tray_rounded_corners(&built);
            built
        }
    };
    app.run_on_main_thread(move || {
        if !intents().is_panel_current(intent) {
            return;
        }
        if let Err(error) = place(&window, icon)
            .and_then(|()| window.show())
            .and_then(|()| window.set_focus())
        {
            log::warn!("定位托盘面板失败: {error}");
            let _ = window.hide();
            recover_panel_failure(window.app_handle(), intent);
        }
    })
    .map_err(|error| error.to_string())
}

fn apply_tray_rounded_corners(window: &WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let preference = DWMWCP_ROUND;
    // SAFETY: hwnd is a valid HWND owned by Tauri and `preference` is a stack i32 matching DWMWCP_ROUND.
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            (&preference as *const i32).cast(),
            std::mem::size_of_val(&preference) as u32,
        )
    };
}

fn place(window: &WebviewWindow, icon: Rect) -> tauri::Result<()> {
    // Windows tray-icon reports the anchor in physical screen pixels.
    let anchor = icon.position.to_physical::<i32>(1.0);
    let icon_size = icon.size.to_physical::<u32>(1.0);
    let x = anchor.x + (icon_size.width / 2) as i32;
    let y = anchor.y + (icon_size.height / 2) as i32;
    let Some(monitor) = window
        .monitor_from_point(x.into(), y.into())?
        .or(window.primary_monitor()?)
    else {
        return Ok(());
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let px = |value| (f64::from(value) * scale).round() as u32;
    let gap = px(GAP);
    let size = PhysicalSize::new(
        px(WIDTH).min(area.size.width),
        px(HEIGHT).min(area.size.height),
    );
    let position = panel_position(
        area.position,
        area.size,
        size,
        PhysicalPosition::new(x, y),
        gap,
    );
    // Moving first establishes the destination DPI. Set the final pixel size
    // afterwards so a per-monitor scale transition cannot stretch the panel.
    window.set_position(position)?;
    window.set_size(size)?;
    Ok(())
}

fn panel_position(
    origin: PhysicalPosition<i32>,
    area: PhysicalSize<u32>,
    panel: PhysicalSize<u32>,
    anchor: PhysicalPosition<i32>,
    gap: u32,
) -> PhysicalPosition<i32> {
    let right = origin.x + area.width as i32;
    let bottom = origin.y + area.height as i32;
    let width = panel.width as i32;
    let height = panel.height as i32;
    let gap = gap as i32;
    let (x, y) = if anchor.x < origin.x {
        (origin.x + gap, anchor.y - height / 2)
    } else if anchor.x >= right {
        (right - width - gap, anchor.y - height / 2)
    } else if anchor.y < origin.y {
        (anchor.x - width / 2, origin.y + gap)
    } else {
        (anchor.x - width / 2, bottom - height - gap)
    };
    PhysicalPosition::new(
        x.clamp(origin.x, (right - width).max(origin.x)),
        y.clamp(origin.y, (bottom - height).max(origin.y)),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayLine {
    id: String,
    name: String,
    category: Option<String>,
    icon_color: Option<String>,
    badge_text: Option<String>,
    blocked_by_takeover: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayTool {
    id: &'static str,
    name: &'static str,
    current_id: Option<String>,
    auto_failover: bool,
    current_usage_summary: Option<String>,
    lines: Vec<TrayLine>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayPanelState {
    language: &'static str,
    tools: Vec<TrayTool>,
    has_projects: bool,
    lightweight: bool,
}

fn require_panel(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == LABEL {
        Ok(())
    } else {
        Err("此操作仅用于托盘面板".into())
    }
}

#[tauri::command]
pub async fn get_tray_panel(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<TrayPanelState, String> {
    require_panel(&window)?;
    let _op = PanelOpGuard::enter();
    let settings = crate::settings::get_settings();
    let language = crate::tray::tray_language(&settings);
    let visible = settings.visible_apps.unwrap_or_default();
    let mut tools = Vec::new();
    for section in crate::tray::TRAY_SECTIONS
        .iter()
        .filter(|section| crate::tray::tray_app_enabled(&section.app_type, &visible))
    {
        let id = section.app_type.as_str();
        let providers = state.db.get_all_providers(id).map_err(|e| e.to_string())?;
        let current_id =
            crate::settings::get_effective_current_provider(&state.db, &section.app_type)
                .map_err(|e| e.to_string())?;
        let takeover = crate::tray::manual_switch_takeover_active(&state, &section.app_type)
            .await
            .map_err(|error| error.to_string())?;
        let (_, auto_failover) = state.db.get_proxy_flags_sync(id);
        let lines = crate::tray::sort_providers(&providers)
            .into_iter()
            .map(|(id, provider)| TrayLine {
                id: id.clone(),
                name: provider.name.clone(),
                category: provider.category.clone(),
                icon_color: provider.icon_color.clone(),
                blocked_by_takeover: takeover
                    && crate::services::provider::official_provider_blocked_during_takeover(
                        &section.app_type,
                        provider,
                    ),
                badge_text: provider
                    .meta
                    .as_ref()
                    .and_then(|meta| meta.badge_text.clone()),
            })
            .collect();
        let current_usage_summary = current_id.as_deref().and_then(|id| {
            let provider = providers.get(id)?;
            crate::tray::cached_usage_summary(&state, &section.app_type, provider, id)
        });
        tools.push(TrayTool {
            id,
            name: section.header_label,
            current_id,
            auto_failover,
            current_usage_summary,
            lines,
        });
    }
    let has_projects = crate::tray::visible_profile_scopes(&visible)
        .next()
        .is_some()
        && state.db.has_profiles().unwrap_or_else(|error| {
            log::warn!("读取托盘项目状态失败: {error}");
            false
        });
    Ok(TrayPanelState {
        language,
        tools,
        has_projects,
        lightweight: crate::lightweight::is_lightweight_mode(),
    })
}

#[tauri::command]
pub async fn switch_tray_line(
    window: WebviewWindow,
    tool: String,
    id: String,
) -> Result<(), String> {
    require_panel(&window)?;
    let _op = PanelOpGuard::enter();
    let app = window.app_handle();
    let app_type = AppType::from_str(&tool).map_err(|e| e.to_string())?;
    crate::tray::switch_tray_provider(app, app_type, id).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PanelAction {
    Hide,
    OpenMain,
    ToggleLightweight,
    Projects,
    Quit,
}

#[tauri::command]
pub async fn tray_panel_action(window: WebviewWindow, action: PanelAction) -> Result<(), String> {
    require_panel(&window)?;
    let _op = PanelOpGuard::enter();
    let app = window.app_handle();
    if matches!(action, PanelAction::ToggleLightweight)
        && !crate::lightweight::is_lightweight_mode()
        && crate::commands::runtime_operation_in_progress()
    {
        return Err("Codex 正在维护，请等待当前操作完成".into());
    }
    match action {
        PanelAction::Hide => {}
        PanelAction::OpenMain => return open_main_from_panel(app.clone()).await,
        PanelAction::ToggleLightweight if crate::lightweight::is_lightweight_mode() => {
            return open_main_from_panel(app.clone()).await;
        }
        PanelAction::ToggleLightweight => crate::tray::request_lightweight_mode(app)?,
        PanelAction::Projects => {
            // Cancelling the context menu keeps the underlying panel available.
            return show_projects_menu(&window, &app.state::<AppState>());
        }
        PanelAction::Quit => crate::tray::handle_tray_menu_event(app, "quit"),
    }
    hide(app);
    Ok(())
}

fn show_projects_menu(window: &WebviewWindow, state: &AppState) -> Result<(), String> {
    let app = window.app_handle();
    let settings = crate::settings::get_settings();
    let texts = crate::tray::TrayTexts::for_settings(&settings);
    let submenus = crate::tray::build_profile_scope_menus(
        app,
        state,
        &settings.visible_apps.unwrap_or_default(),
        texts,
    )
    .map_err(|error| error.to_string())?;
    if submenus.is_empty() {
        return Ok(());
    }
    let mut menu = tauri::menu::MenuBuilder::new(app);
    for submenu in &submenus {
        menu = menu.item(submenu);
    }
    window
        .popup_menu(&menu.build().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: tauri::tray::TrayIconId::new(crate::tray::TRAY_ID),
            rect: Rect::default(),
            position: PhysicalPosition::default(),
            button,
            button_state,
        }
    }

    fn left_double_click() -> TrayIconEvent {
        TrayIconEvent::DoubleClick {
            id: tauri::tray::TrayIconId::new(crate::tray::TRAY_ID),
            rect: Rect::default(),
            position: PhysicalPosition::default(),
            button: MouseButton::Left,
        }
    }

    #[test]
    fn tray_click_releases_open_the_same_panel_for_left_and_right_buttons() {
        let clicks = TrayClicks::default();
        for button in [MouseButton::Left, MouseButton::Right] {
            assert!(clicks
                .action(&click(button, MouseButtonState::Down))
                .is_none());
            assert!(matches!(
                clicks.action(&click(button, MouseButtonState::Up)),
                Some(ClickAction::ShowPanel { wait_for_double_click, .. })
                    if wait_for_double_click == (button == MouseButton::Left)
            ));
        }
        assert!(clicks
            .action(&click(MouseButton::Middle, MouseButtonState::Up))
            .is_none());
    }

    #[test]
    fn tray_click_double_click_supersedes_the_delayed_single_click() {
        use MouseButton::Left;
        use MouseButtonState::Up;

        let clicks = TrayClicks::default();
        let mut intents = WindowIntent::new();
        let (panel, action) = clicks.request(&click(Left, Up), &mut intents).unwrap();
        assert!(matches!(
            action,
            ClickAction::ShowPanel {
                wait_for_double_click: true,
                ..
            }
        ));
        let (main, action) = clicks.request(&left_double_click(), &mut intents).unwrap();
        assert!(matches!(action, ClickAction::ShowMain));
        assert!(clicks.request(&click(Left, Up), &mut intents).is_none());

        assert!(!intents.is_panel_current(panel));
        assert!(intents.is_main_current(main));
    }

    #[test]
    fn tray_click_right_click_supersedes_an_unfinished_main_activation() {
        let clicks = TrayClicks::default();
        let mut intents = WindowIntent::new();
        let (main, _) = clicks.request(&left_double_click(), &mut intents).unwrap();
        let (panel, action) = clicks
            .request(
                &click(MouseButton::Right, MouseButtonState::Up),
                &mut intents,
            )
            .unwrap();
        assert!(matches!(
            action,
            ClickAction::ShowPanel {
                wait_for_double_click: false,
                ..
            }
        ));

        assert!(intents.is_panel_current(panel));
        assert!(!intents.is_main_current(main));
    }

    #[test]
    fn tray_panel_dismissal_and_new_gestures_do_not_cancel_an_explicit_restore() {
        let mut intents = WindowIntent::new();
        let explicit = intents.next_main();
        let double_click = intents.next_tray_main();
        let panel = intents.next_panel();
        intents.cancel_panel();
        assert!(!intents.is_panel_current(panel));
        assert!(!intents.is_main_current(double_click));
        assert!(intents.is_main_current(explicit));
        let later = intents.next_tray_main();
        intents.cancel_panel();
        assert!(intents.is_main_current(later));
    }

    #[test]
    fn tray_panel_gets_final_focus_even_if_the_panel_worker_runs_first() {
        let mut intents = WindowIntent::new();
        let main = intents.next_main();
        let panel = intents.next_panel();
        assert_eq!(
            intents.panel_activation(panel),
            Some(PanelActivation::RestoreMainFirst(main))
        );

        // The panel worker completes that restore before showing the panel.
        intents.finish_main_activation(main);
        assert_eq!(intents.panel_activation(panel), Some(PanelActivation::Show));
        assert!(!intents.is_main_current(main));
    }

    #[test]
    fn tray_panel_can_show_after_the_explicit_worker_finishes_first() {
        let mut intents = WindowIntent::new();
        let main = intents.next_main();
        let panel = intents.next_panel();

        intents.finish_main_activation(main);
        assert_eq!(intents.panel_activation(panel), Some(PanelActivation::Show));

        let newer_main = intents.next_main();
        assert_eq!(intents.panel_activation(panel), None);
        intents.finish_main_activation(main);
        assert!(intents.is_main_current(newer_main));
    }

    #[test]
    fn tray_close_only_cancels_restores_that_precede_it() {
        let mut intents = WindowIntent::new();
        let before = intents.next_main();
        let after = intents.next_tray_main();
        intents.finish_close(before);
        assert!(intents.is_main_current(after));
        intents.finish_close(after);
        assert!(!intents.is_main_current(before));
        assert!(!intents.is_main_current(after));
    }

    #[test]
    fn a_superseded_restore_discards_only_the_window_it_created_and_has_not_shown() {
        assert!(discard_unshown_main(true, true, false));
        assert!(!discard_unshown_main(false, true, false));
        assert!(!discard_unshown_main(true, true, true));
        assert!(!discard_unshown_main(true, false, false));
    }

    #[test]
    fn tray_click_only_a_main_activation_supersedes_a_pending_close() {
        let clicks = TrayClicks::default();
        let mut intents = WindowIntent::new();
        let close = intents.main_activation;
        clicks.request(
            &click(MouseButton::Right, MouseButtonState::Up),
            &mut intents,
        );
        assert_eq!(intents.main_activation, close);
        clicks.request(&left_double_click(), &mut intents);
        assert_ne!(intents.main_activation, close);
    }

    #[test]
    fn tray_click_double_click_consumes_only_its_own_release() {
        use MouseButton::{Left, Right};
        use MouseButtonState::{Down, Up};

        let clicks = TrayClicks::default();
        assert!(clicks.action(&click(Left, Down)).is_none());
        assert!(matches!(
            clicks.action(&click(Left, Up)),
            Some(ClickAction::ShowPanel { .. })
        ));
        assert!(matches!(
            clicks.action(&left_double_click()),
            Some(ClickAction::ShowMain)
        ));
        assert!(matches!(
            clicks.action(&click(Right, Up)),
            Some(ClickAction::ShowPanel { .. })
        ));
        assert!(clicks.action(&click(Left, Up)).is_none());
        assert!(clicks.action(&click(Left, Down)).is_none());
        assert!(matches!(
            clicks.action(&click(Left, Up)),
            Some(ClickAction::ShowPanel { .. })
        ));
    }

    #[test]
    fn tray_click_fresh_press_recovers_after_a_dropped_double_click_release() {
        use MouseButton::Left;
        use MouseButtonState::{Down, Up};

        let clicks = TrayClicks::default();
        assert!(matches!(
            clicks.action(&left_double_click()),
            Some(ClickAction::ShowMain)
        ));
        assert!(clicks.action(&click(Left, Down)).is_none());
        assert!(matches!(
            clicks.action(&click(Left, Up)),
            Some(ClickAction::ShowPanel { .. })
        ));
    }

    #[test]
    fn tray_panel_is_clamped_to_the_icons_work_area_at_any_taskbar_edge() {
        let origin = PhysicalPosition::new(-1920, 100);
        let work = PhysicalSize::new(1920, 990);
        let size = PhysicalSize::new(552, 681); // 150% scale
        let examples = [
            ((-26, 1100), (-552, 397)),
            ((-960, 65), (-1236, 112)),
            ((-1940, 142), (-1908, 100)),
            ((12, 1098), (-564, 409)),
        ];
        for ((x, y), (left, top)) in examples {
            assert_eq!(
                panel_position(origin, work, size, PhysicalPosition::new(x, y), 12),
                PhysicalPosition::new(left, top)
            );
        }
    }
}
