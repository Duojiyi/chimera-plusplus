/**
 * Browser design-preview fixtures for the Codex 管理 page (L09/L19/L20).
 *
 * Only used when the renderer runs outside Tauri with `?preview=design`, so
 * the layout can be reviewed without a backend. Values follow the shared fake
 * data baseline (design system §6): Codex CLI 0.61.0 is the current stable
 * build. Every write on the page stays disabled while these are on screen.
 */
export const isRuntimeDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

export const RUNTIME_DESIGN_SAMPLE = {
  runtime: {
    supported: true,
    installed: true,
    version: "0.61.0",
    installMode: "standard",
    installPath: "%LOCALAPPDATA%\\Programs\\codex\\bin",
    canRepair: true,
    canRollback: true,
    canUninstall: true,
    history: [
      { version: "0.61.0", state: "active" },
      { version: "0.60.2", state: "previous" },
    ],
  },
  release: {
    currentVersion: "0.61.0",
    latestVersion: "0.62.0",
    updateAvailable: true,
    installMode: "standard",
    sizeBytes: 64_906_444,
    source: "auto",
    releasedAt: "2026-11-08T10:24:00+08:00",
  },
  preferences: {
    codexInstallMode: "standard" as const,
    codexUpdateSource: "auto" as const,
    checkCodexUpdatesOnStart: true,
  },
  releases: [
    {
      tag: "v0.61.0",
      name: "0.61.0",
      publishedAt: "2026-11-08T10:24:00+08:00",
      prerelease: false,
      installable: true,
    },
    {
      tag: "v0.60.2",
      name: "0.60.2",
      publishedAt: "2026-10-31T21:15:00+08:00",
      prerelease: false,
      installable: true,
    },
    {
      tag: "v0.59.4",
      name: "0.59.4",
      publishedAt: "2026-10-18T09:02:00+08:00",
      prerelease: false,
      installable: true,
    },
    {
      tag: "v0.58.1",
      name: "0.58.1",
      publishedAt: "2026-10-04T16:40:00+08:00",
      prerelease: false,
      installable: true,
    },
    {
      tag: "v0.57.3",
      name: "0.57.3",
      publishedAt: "2026-09-22T11:12:00+08:00",
      prerelease: false,
      installable: true,
    },
    {
      tag: "v0.56.0",
      name: "0.56.0",
      publishedAt: "2026-09-09T14:30:00+08:00",
      prerelease: false,
      installable: true,
    },
    {
      tag: "v0.55.2",
      name: "0.55.2",
      publishedAt: "2026-08-27T10:05:00+08:00",
      prerelease: false,
      installable: true,
    },
    {
      tag: "v0.54.0",
      name: "0.54.0",
      publishedAt: "2026-08-14T18:20:00+08:00",
      prerelease: false,
      installable: false,
    },
  ],
};
