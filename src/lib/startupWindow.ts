import { invoke } from "@tauri-apps/api/core";

/**
 * Shows and focuses the main window after the first render, so a launch never
 * ends with a hidden window and no handle to bring it back. The one exception
 * is silent startup: the backend only hides the window when the user turned
 * it on, a tray icon can bring the window back, and neither an import link nor
 * a startup error needs it (lib.rs setup). If that answer cannot be read, the
 * window is shown.
 */
export async function revealMainWindow(): Promise<void> {
  const startedHidden = await invoke<boolean>("take_started_hidden").catch(
    () => false,
  );
  if (startedHidden === true) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWin = getCurrentWindow();
  await appWin.show();
  await appWin.setFocus();
}
