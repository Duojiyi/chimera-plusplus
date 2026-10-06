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

describe("prompt category command contract", () => {
  it("scopes every category operation to its target tool", async () => {
    await promptsApi.getCategories("claude");
    expect(invoke).toHaveBeenCalledWith("get_prompt_categories", {
      app: "claude",
    });
    await promptsApi.createCategory("codex", "开发");
    expect(invoke).toHaveBeenCalledWith("create_prompt_category", {
      app: "codex",
      name: "开发",
    });
    await promptsApi.renameCategory("gemini", "category-1", "写作");
    expect(invoke).toHaveBeenCalledWith("rename_prompt_category", {
      app: "gemini",
      id: "category-1",
      name: "写作",
    });
    await promptsApi.deleteCategory("hermes", "category-1");
    expect(invoke).toHaveBeenCalledWith("delete_prompt_category", {
      app: "hermes",
      id: "category-1",
    });
  });
});

describe("prompt write command contract", () => {
  const expected = {
    id: "saved",
    name: "Name",
    content: "Old",
    enabled: false,
  };
  it("passes the editor baseline to the backend", async () => {
    const edited = { ...expected, content: "New" };
    await promptsApi.upsertPrompt("claude", "saved", edited, expected);
    expect(invoke).toHaveBeenCalledWith("upsert_prompt", {
      app: "claude",
      id: "saved",
      prompt: edited,
      expected,
    });
  });
  it("toggles a record without resubmitting its content", async () => {
    await promptsApi.setPromptEnabled("codex", "saved", true);
    expect(invoke).toHaveBeenCalledWith("set_prompt_enabled", {
      app: "codex",
      id: "saved",
      enabled: true,
    });
  });
});
