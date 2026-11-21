import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("tray and startup source contracts (not Rust runtime tests)", () => {
  it("routes Windows tray events to the flyout without attaching a native menu", () => {
    const lib = source("src-tauri/src/lib.rs");
    expect(lib).toMatch(
      /#\[cfg\(target_os = "windows"\)\]\s*tray_clicks\.handle\(tray\.app_handle\(\), &event\)/,
    );
    expect(lib).toMatch(
      /if tray::USE_NATIVE_TRAY_MENU \{\s*let menu = tray::create_tray_menu[^;]+;\s*tray_builder = tray_builder\.menu\(&menu\);/,
    );
    const tray = source("src-tauri/src/tray.rs");
    expect(tray).toContain(
      'USE_NATIVE_TRAY_MENU: bool = !cfg!(target_os = "windows")',
    );
    expect(tray).toMatch(/if USE_NATIVE_TRAY_MENU \{[\s\S]*?tray\.set_menu/);
    expect(lib).toContain("tray::update_tray_menu(&app, state.inner())");
    for (const path of [
      "src-tauri/src/commands/failover.rs",
      "src-tauri/src/proxy/failover_switch.rs",
    ]) {
      expect(source(path)).toContain("tray::refresh_tray_menu(");
      expect(source(path)).not.toContain(".set_menu(");
    }
  });
  it("shares main-window recovery between the native menu and Windows double-click", () => {
    const panel = source("src-tauri/src/tray_panel.rs");
    expect(panel).toMatch(
      /Some\(\(intent, ClickAction::ShowMain\)\) => spawn_main_activation\(app, intent\)/,
    );
    expect(panel).toContain("crate::lightweight::create_main_window(app)");
    expect(panel).toContain(
      "crate::lightweight::activate_main_window(&handle, &window)",
    );
    const lightweight = source("src-tauri/src/lightweight.rs");
    expect(lightweight).toContain(
      "crate::tray_panel::restore_main_from_worker(app)",
    );
    expect(panel).toContain("activate_main_from_worker(app, request_main_activation())");
    expect(source("src-tauri/src/lib.rs")).toContain(
      "let intent = tray_panel::request_main_activation()",
    );
    expect(panel).toContain("return open_main_from_panel(app.clone()).await");
    const tray = source("src-tauri/src/tray.rs");
    expect(tray).toMatch(
      /"show_main" => \{\s*if let Err\(error\) = crate::lightweight::show_main_window\(app\)/,
    );
  });
  it("defaults new preferences on and avoids automatic debug registration", () => {
    const settings = source("src-tauri/src/settings.rs");
    expect(settings).toMatch(
      /#\[serde\(default = "default_true"\)\]\s*pub launch_on_startup: bool/,
    );
    expect(settings).toContain("launch_on_startup: true");
    expect(source("src-tauri/src/lib.rs")).toMatch(
      /#\[cfg\(not\(debug_assertions\)\)\]\s*if let Err\(error\) = crate::auto_launch::sync_saved_preference/,
    );
  });
  it("persists the preference and rolls registration back on write failure", () => {
    const startup = source("src-tauri/src/auto_launch.rs");
    expect(startup).toContain("settings.launch_on_startup = enabled");
    expect(startup).toContain("apply_registration(previous)");
    expect(source("src-tauri/src/commands/settings.rs")).toContain(
      "crate::auto_launch::set_preference(enabled)",
    );
  });
});
