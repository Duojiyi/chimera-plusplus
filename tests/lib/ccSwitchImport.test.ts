import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ccSwitchImportApi } from "@/lib/api/ccSwitchImport";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.mocked(invoke).mockReset());
describe("cc-switch import IPC contract", () => {
  it("previews by path and commits only the opaque preview handle and decisions", async () => {
    await ccSwitchImportApi.preview("C:/cc-switch/config.json");
    expect(invoke).toHaveBeenLastCalledWith("preview_cc_switch_file", {
      path: "C:/cc-switch/config.json",
    });
    const selections = [
      { app: "codex", sourceId: "a", action: "import" as const },
      { app: "codex", sourceId: "b", action: "skip" as const },
    ];
    await ccSwitchImportApi.commit("preview-1", selections);
    expect(invoke).toHaveBeenLastCalledWith("commit_cc_switch_import", {
      previewId: "preview-1",
      selections,
    });
  });
  it("passes backend refusals through unchanged for the caller to map", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("IMPORT_SOURCE_CHANGED");
    await expect(ccSwitchImportApi.commit("preview-1", [])).rejects.toBe(
      "IMPORT_SOURCE_CHANGED",
    );
  });
});
