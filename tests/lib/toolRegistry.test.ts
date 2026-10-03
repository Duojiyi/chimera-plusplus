import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { toolRegistryApi, type ToolInfo } from "@/lib/api/toolRegistry";

describe("toolRegistryApi", () => {
  it("reads the backend tool registry", async () => {
    const mcode: ToolInfo = {
      id: "mcode",
      mode: "additive",
      liveFiles: ["~/.minimax/config.yaml"],
      tray: false,
      deeplink: "reject",
      proxy: false,
    };
    mocks.invoke.mockResolvedValue([mcode]);

    await expect(toolRegistryApi.list()).resolves.toEqual([mcode]);
    expect(mocks.invoke).toHaveBeenCalledWith("get_tool_registry");
  });
});
