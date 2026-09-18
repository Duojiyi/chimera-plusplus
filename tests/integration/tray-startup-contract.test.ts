import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("tray and startup source contracts (not Rust runtime tests)", () => {
  it("routes left double-click through the existing main-window recovery handler", () => {
    const lib = source("src-tauri/src/lib.rs");
    expect(lib).toMatch(
      /TrayIconEvent::DoubleClick\s*\{\s*button: tauri::tray::MouseButton::Left,[\s\S]*?handle_tray_menu_event\(tray.app_handle\(\), "show_main"\)/,
    );
    expect(lib).toContain(".show_menu_on_left_click(false)");
    const tray = source("src-tauri/src/tray.rs");
    expect(tray).toMatch(/"show_main" =>[\s\S]*?exit_lightweight_mode\(app\)/);
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
