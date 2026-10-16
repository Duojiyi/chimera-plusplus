import { afterEach, describe, expect, it, vi } from "vitest";

// Adapted from farion1231/cc-switch 09237ebd
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";

// The drag constants are computed once at import time.
async function loadPlatform(userAgent: string, platform: string) {
  vi.resetModules();
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
  return import("@/lib/platform");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("window drag regions", () => {
  it("drags on Windows through Tauri's handler without native app-region CSS", async () => {
    const platform = await loadPlatform(WINDOWS_UA, "Win32");

    // "deep" lets plain text inside the region start a drag; clickable
    // elements still block it in drag.js.
    expect(platform.DRAG_REGION_ATTR).toEqual({
      "data-tauri-drag-region": "deep",
    });
    expect(platform.DRAG_REGION_STYLE).toEqual({});
  });

  it("keeps the native drag style on macOS", async () => {
    const platform = await loadPlatform(MAC_UA, "MacIntel");

    expect(platform.DRAG_REGION_ATTR).toEqual({
      "data-tauri-drag-region": "deep",
    });
    expect(platform.DRAG_REGION_STYLE).toEqual({ WebkitAppRegion: "drag" });
  });

  it("renders no drag region on Linux", async () => {
    const platform = await loadPlatform(LINUX_UA, "Linux x86_64");

    expect(platform.DRAG_REGION_ENABLED).toBe(false);
    expect(platform.DRAG_REGION_ATTR).toEqual({});
    expect(platform.DRAG_REGION_STYLE).toEqual({});
  });
});
