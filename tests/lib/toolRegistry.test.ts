import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { toolRegistryApi } from "@/lib/api/toolRegistry";

describe("toolRegistryApi", () => {
  it("reads the backend tool registry", async () => {
    mocks.invoke.mockResolvedValue([]);

    await expect(toolRegistryApi.list()).resolves.toEqual([]);
    expect(mocks.invoke).toHaveBeenCalledWith("get_tool_registry");
  });
});
