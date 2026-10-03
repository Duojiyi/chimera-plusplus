import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { promptsApi } from "@/lib/api/prompts";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
describe("prompt import command contract", () => {
  it("passes only observed content for explicit Codex takeover", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("adopted-id");
    expect(await promptsApi.adoptForeignCodex("observed bytes")).toBe(
      "adopted-id",
    );
    expect(invoke).toHaveBeenCalledWith("adopt_foreign_codex_prompt", {
      expectedContent: "observed bytes",
    });
  });
  it("preserves current-file import for existing callers", async () => {
    await promptsApi.importFromFile("codex");
    expect(invoke).toHaveBeenCalledWith("import_prompt_from_file", {
      app: "codex",
    });
  });
  it("passes the selected file using Tauri camelCase arguments", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("new-id");
    expect(await promptsApi.importFromFile("codex", "D:/rules.md")).toBe(
      "new-id",
    );
    expect(invoke).toHaveBeenCalledWith("import_prompt_from_file", {
      app: "codex",
      filePath: "D:/rules.md",
    });
  });
});
