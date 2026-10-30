import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { skillsApi, type UnmanagedSkill } from "@/lib/api/skills";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const row: UnmanagedSkill = {
  directory: "plain",
  name: "Plain",
  foundIn: ["codex"],
  path: "D:/codex/skills/plain",
  contentHash: "hash",
};
beforeEach(() => vi.mocked(invoke).mockReset());
describe("Skills scan contract", () => {
  it("keeps the plain list call unchanged", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([row]);
    await expect(skillsApi.scanUnmanaged("codex")).resolves.toEqual([row]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("scan_unmanaged_skills", {
      currentApp: "codex",
    });
  });
  it("asks for skipped folders and returns them", async () => {
    const skipped = [
      {
        directory: "broken",
        foundIn: ["agents"],
        reason: "无法读取目录或文件",
      },
    ];
    vi.mocked(invoke).mockResolvedValueOnce({ skills: [row], skipped });
    await expect(skillsApi.scanUnmanagedWithSkipped()).resolves.toEqual({
      skills: [row],
      skipped,
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("scan_unmanaged_skills", {
      currentApp: null,
      includeSkipped: true,
    });
  });
  it("accepts the plain list from an older backend", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([row]);
    await expect(skillsApi.scanUnmanagedWithSkipped("codex")).resolves.toEqual({
      skills: [row],
      skipped: [],
    });
  });
});
