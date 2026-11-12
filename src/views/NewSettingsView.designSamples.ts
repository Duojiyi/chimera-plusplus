import type { Settings } from "@/types";

/**
 * Example values for the `?preview=design` browser preview only (design
 * system §6 baseline). Never used in the desktop app, where every value comes
 * from the backend.
 */
export const settingsDesignSamples = {
  appVersion: "2.9.0",
  /** The folder `get_app_config_path` resolves to on a default install. */
  configDir: "%USERPROFILE%\\.chimera-plus-plus",
  settings: {
    codexUpdateSource: "auto",
    codexInstallMode: "standard",
    launchOnStartup: true,
    silentStartup: true,
    showInTray: true,
    minimizeToTrayOnClose: true,
    lightweightOnClose: false,
    showProviderBalance: false,
    checkCodexUpdatesOnStart: true,
    checkProviderStatusOnStart: true,
  } as Settings,
};
