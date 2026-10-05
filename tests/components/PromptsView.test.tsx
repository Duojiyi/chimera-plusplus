import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledPromptTemplates } from "@/config/promptTemplates";
import { PromptsView } from "@/views/PromptsView";
import { promptsApi } from "@/lib/api/prompts";
import { toast } from "sonner";
import { open } from "@tauri-apps/plugin-dialog";
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/api/prompts", () => ({
  promptsApi: {
    getPrompts: vi.fn(),
    getCurrentFileContent: vi.fn(),
    upsertPrompt: vi.fn(),
    enablePrompt: vi.fn(),
    importFromFile: vi.fn(),
    deletePrompt: vi.fn(),
    adoptForeignCodex: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/MarkdownEditor", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Prompt content"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
const item = {
  id: "real",
  name: "真实模板",
  content: "Real instructions",
  enabled: false,
};
// The editor is a lazy chunk; a cold transform on a loaded machine can outlast
// the 1 s waitFor budgets below, which test behaviour rather than load time.
beforeAll(async () => {
  await import("@/components/prompts/PromptFormModal");
}, 60_000);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(open).mockResolvedValue("D:/templates/rules.md");
  vi.mocked(promptsApi.getPrompts).mockResolvedValue({ real: item });
  vi.mocked(promptsApi.getCurrentFileContent).mockResolvedValue(
    "Actual user file\n",
  );
  vi.mocked(promptsApi.upsertPrompt).mockResolvedValue();
  vi.mocked(promptsApi.deletePrompt).mockResolvedValue();
  vi.mocked(promptsApi.adoptForeignCodex).mockResolvedValue("adopted-id");
  vi.mocked(promptsApi.importFromFile).mockResolvedValue("imported");
});
describe("connected prompts", () => {
  it("requires explicit consent and serializes adoption using the displayed file", async () => {
    const original =
      "User\n<!-- CODEX-X:INSTRUCTIONS:BEGIN -->\nForeign\n<!-- CODEX-X:INSTRUCTIONS:END -->";
    vi.mocked(promptsApi.getCurrentFileContent).mockResolvedValue(original);
    let finish!: (id: string) => void;
    vi.mocked(promptsApi.adoptForeignCodex).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<PromptsView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "接管 Codex-X 区块" }),
    );
    const confirm = await screen.findByRole("button", { name: "确认接管" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(promptsApi.adoptForeignCodex).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    fireEvent.click(confirm);
    expect(promptsApi.adoptForeignCodex).toHaveBeenCalledExactlyOnceWith(
      original,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    vi.mocked(promptsApi.getCurrentFileContent).mockResolvedValue(
      original.replaceAll("CODEX-X:", "CHIMERA:"),
    );
    await act(async () => finish("adopted-id"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "接管 Codex-X 区块" }),
    ).not.toBeInTheDocument();
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
  });
  it("cancels adoption without writes and requires fresh consent after failure", async () => {
    vi.mocked(promptsApi.getCurrentFileContent).mockResolvedValue(
      "<!-- CODEX-X:INSTRUCTIONS:BEGIN -->\nForeign\n<!-- CODEX-X:INSTRUCTIONS:END -->",
    );
    render(<PromptsView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "接管 Codex-X 区块" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(promptsApi.adoptForeignCodex).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "接管 Codex-X 区块" }));
    fireEvent.click(screen.getByRole("checkbox"));
    vi.mocked(promptsApi.adoptForeignCodex).mockRejectedValueOnce(
      new Error("secret-path"),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认接管" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(toast.error).toHaveBeenCalledWith(
      expect.not.stringContaining("secret-path"),
    );
    fireEvent.click(screen.getByRole("button", { name: "接管 Codex-X 区块" }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "确认接管" })).toBeDisabled();
  });
  it("previews a bundled template without writing, then saves an editable disabled copy", async () => {
    render(<PromptsView />);
    await screen.findByText("真实模板");
    for (const template of bundledPromptTemplates)
      expect(
        screen.getByRole("button", { name: new RegExp(template.name) }),
      ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /代码审查/ }));
    expect(screen.getByLabelText("模板内容")).toHaveTextContent("#");
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "使用此模板" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Prompt content")).toHaveValue(
        bundledPromptTemplates[0].content,
      ),
    );
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("prompts.name"), {
      target: { value: "我的审查" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "codex",
      expect.stringMatching(/^prompt-[0-9a-f-]{36}$/),
      expect.objectContaining({
        name: "我的审查",
        templateId: bundledPromptTemplates[0].id,
        enabled: false,
        content: bundledPromptTemplates[0].content.trim(),
      }),
    );
  });
  it("retains template provenance when editing a reloaded copy", async () => {
    vi.mocked(promptsApi.getPrompts).mockResolvedValue({
      real: { ...item, templateId: bundledPromptTemplates[0].id },
    });
    render(<PromptsView />);
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "操作 真实模板" }),
      { key: "ArrowDown" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑" }));
    fireEvent.change(await screen.findByLabelText("Prompt content"), {
      target: { value: "Custom copy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
        "codex",
        "real",
        expect.objectContaining({
          templateId: bundledPromptTemplates[0].id,
          content: "Custom copy",
          enabled: false,
        }),
      ),
    );
  });

  it("cancels template selection without writes and clears the next blank draft", async () => {
    render(<PromptsView />);
    await screen.findByText("真实模板");
    fireEvent.click(screen.getByRole("button", { name: /技术文档/ }));
    fireEvent.click(screen.getByRole("button", { name: "使用此模板" }));
    await screen.findByLabelText("Prompt content");
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "新建提示词" }));
    expect(await screen.findByLabelText("Prompt content")).toHaveValue("");
    expect(screen.getByLabelText("prompts.name")).toHaveValue("");
  });
  it("renders actual library and file without fictional preview", async () => {
    render(<PromptsView />);
    expect(await screen.findByText("真实模板")).toBeInTheDocument();
    expect(screen.getByLabelText("AGENTS.md 当前内容")).toHaveTextContent(
      "Actual user file",
    );
    expect(screen.queryByText("# 项目约定")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Replace/ }),
    ).not.toBeInTheDocument();
  });
  it("does not report a toggle before backend success and serializes writes", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(promptsApi.upsertPrompt).mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    render(<PromptsView />);
    const toggle = await screen.findByRole("switch", { name: "启用 真实模板" });
    fireEvent.click(toggle);
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(promptsApi.upsertPrompt).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("secret-value")));
    expect(await screen.findByRole("switch")).not.toBeDisabled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.not.stringContaining("secret-value"),
    );
  });
  it("reloads authoritative data after a successful toggle", async () => {
    render(<PromptsView />);
    const toggle = await screen.findByRole("switch", { name: "启用 真实模板" });
    vi.mocked(promptsApi.getPrompts).mockResolvedValue({
      real: { ...item, enabled: true },
    });
    vi.mocked(promptsApi.getCurrentFileContent).mockResolvedValue(
      "Actual managed file",
    );
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole("switch")).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(screen.getByLabelText("AGENTS.md 当前内容")).toHaveTextContent(
      "Actual managed file",
    );
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "codex",
      "real",
      expect.objectContaining({ enabled: true }),
    );
  });
  it("imports a selected Markdown file through the real API", async () => {
    render(<PromptsView />);
    await screen.findByText("真实模板");
    fireEvent.click(screen.getByRole("button", { name: "导入 .md" }));
    await waitFor(() => expect(promptsApi.getPrompts).toHaveBeenCalledTimes(2));
    expect(promptsApi.importFromFile).toHaveBeenCalledWith(
      "codex",
      "D:/templates/rules.md",
    );
    expect(open).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
  });
  it("clears stale content when a post-write refresh fails and supports retry", async () => {
    render(<PromptsView />);
    await screen.findByText("真实模板");
    vi.mocked(promptsApi.getPrompts).mockRejectedValueOnce(new Error("secret"));
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取");
    expect(screen.queryByText("真实模板")).not.toBeInTheDocument();
    expect(screen.getByLabelText("AGENTS.md 当前内容")).not.toHaveTextContent(
      "Actual user file",
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("真实模板")).toBeInTheDocument();
  });
  it("creates a disabled prompt through the shared editor", async () => {
    render(<PromptsView />);
    await screen.findByText("真实模板");
    fireEvent.click(screen.getByRole("button", { name: "新建提示词" }));
    fireEvent.change(await screen.findByLabelText("prompts.name"), {
      target: { value: "New template" },
    });
    fireEvent.change(screen.getByLabelText("Prompt content"), {
      target: { value: "Instructions" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "codex",
      expect.any(String),
      expect.objectContaining({
        name: "New template",
        content: "Instructions",
        enabled: false,
      }),
    );
  });
  it("keeps an edited draft after failure and closes only after retry succeeds", async () => {
    vi.mocked(promptsApi.upsertPrompt).mockRejectedValueOnce(
      new Error("private-path"),
    );
    render(<PromptsView />);
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "操作 真实模板" }),
      { key: "ArrowDown" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑" }));
    const name = await screen.findByLabelText("prompts.name");
    expect(name).toHaveValue("真实模板");
    fireEvent.change(name, { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(name).toHaveValue("Updated");
    const retry = await screen.findByRole("button", { name: "common.save" });
    await waitFor(() => expect(retry).not.toBeDisabled());
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(promptsApi.upsertPrompt).toHaveBeenLastCalledWith(
      "codex",
      "real",
      expect.objectContaining({
        name: "Updated",
        content: item.content,
        enabled: false,
      }),
    );
  });
  it("does not import or report failure when the picker is cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    render(<PromptsView />);
    await screen.findByText("真实模板");
    fireEvent.click(screen.getByRole("button", { name: "导入 .md" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "导入 .md" }),
      ).not.toBeDisabled(),
    );
    expect(promptsApi.importFromFile).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
  it("serializes file selection and recovers from an import failure", async () => {
    let select!: (value: string) => void;
    vi.mocked(open).mockReturnValue(
      new Promise((resolve) => {
        select = resolve;
      }),
    );
    vi.mocked(promptsApi.importFromFile).mockRejectedValue(
      new Error("secret-file-path"),
    );
    render(<PromptsView />);
    await screen.findByText("真实模板");
    const button = screen.getByRole("button", { name: "导入 .md" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("switch")).toBeDisabled();
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => select("D:/templates/rules.md"));
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(toast.error).toHaveBeenCalledWith(
      expect.not.stringContaining("secret-file-path"),
    );
    expect(screen.getByText("真实模板")).toBeInTheDocument();
  });
  it("requires confirmation and leaves the library unchanged on cancel", async () => {
    render(<PromptsView />);
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "操作 真实模板" }),
      { key: "ArrowDown" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "不修改 AGENTS.md",
    );
    expect(promptsApi.deletePrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(promptsApi.deletePrompt).not.toHaveBeenCalled();
  });
  it("prevents deleting an enabled prompt", async () => {
    vi.mocked(promptsApi.getPrompts).mockResolvedValue({
      real: { ...item, enabled: true },
    });
    render(<PromptsView />);
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "操作 真实模板" }),
      { key: "ArrowDown" },
    );
    const remove = await screen.findByRole("menuitem", {
      name: "请先禁用后删除",
    });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(remove);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(promptsApi.deletePrompt).not.toHaveBeenCalled();
  });
  it("serializes confirmed deletion and reloads the authoritative library", async () => {
    let finish!: () => void;
    vi.mocked(promptsApi.deletePrompt).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<PromptsView />);
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "操作 真实模板" }),
      { key: "ArrowDown" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const confirm = await screen.findByRole("button", { name: "确认删除" });
    fireEvent.click(confirm);
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    fireEvent.click(confirm);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(promptsApi.deletePrompt).toHaveBeenCalledTimes(1);
    vi.mocked(promptsApi.getPrompts).mockResolvedValue({});
    await act(async () => finish());
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("从一条好指令开始")).toBeInTheDocument();
    expect(promptsApi.deletePrompt).toHaveBeenCalledWith("codex", "real");
    expect(screen.getByLabelText("AGENTS.md 当前内容")).toHaveTextContent(
      "Actual user file",
    );
  });
  it("keeps failed deletion recoverable without exposing backend details", async () => {
    vi.mocked(promptsApi.deletePrompt).mockRejectedValueOnce(
      new Error("private-data"),
    );
    render(<PromptsView />);
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "操作 真实模板" }),
      { key: "ArrowDown" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "确认删除" }),
      ).not.toBeDisabled(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith(
      expect.not.stringContaining("private-data"),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("真实模板")).toBeInTheDocument();
  });
});

it("explains the native takeover guard without exposing arbitrary error details", async () => {
  vi.mocked(promptsApi.upsertPrompt).mockRejectedValue(
    new Error("请先关闭 Codex 代理接管，再修改生效提示词。 secret-token"),
  );
  render(<PromptsView />);
  fireEvent.click(await screen.findByRole("switch", { name: "启用 真实模板" }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "请先关闭 Codex 代理接管，再修改生效提示词。",
    ),
  );
});

describe("A08 prompt targets and A07 refresh", () => {
  it.each([
    ["claude", "CLAUDE.md"],
    ["gemini", "GEMINI.md"],
    ["grokbuild", "AGENTS.md"],
    ["opencode", "AGENTS.md"],
    ["openclaw", "AGENTS.md"],
    ["hermes", "SOUL.md"],
  ] as const)(
    "loads and imports for %s with the actual filename",
    async (app, file) => {
      render(<PromptsView initialApp={app} />);
      await screen.findByText("真实模板");
      expect(promptsApi.getPrompts).toHaveBeenCalledWith(app);
      expect(promptsApi.getCurrentFileContent).toHaveBeenCalledWith(app);
      expect(screen.getByLabelText(`${file} 当前内容`)).toHaveTextContent(
        "Actual user file",
      );
      fireEvent.click(screen.getByRole("button", { name: "导入 .md" }));
      await waitFor(() =>
        expect(promptsApi.importFromFile).toHaveBeenCalledWith(
          app,
          "D:/templates/rules.md",
        ),
      );
      expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    },
  );
  it("does not advertise unsupported tools and switches without retaining old content", async () => {
    render(<PromptsView />);
    await screen.findByText("真实模板");
    expect(
      screen.queryByRole("option", { name: /Pi|MiniMax|Desktop/ }),
    ).not.toBeInTheDocument();
    vi.mocked(promptsApi.getCurrentFileContent).mockResolvedValue(
      "Gemini file",
    );
    fireEvent.change(screen.getByRole("combobox", { name: "提示词目标工具" }), {
      target: { value: "gemini" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("GEMINI.md 当前内容")).toHaveTextContent(
        "Gemini file",
      ),
    );
    expect(promptsApi.getPrompts).toHaveBeenLastCalledWith("gemini");
  });
  it("requires consent before non-Codex activation and uses exclusive enable API", async () => {
    render(<PromptsView initialApp="claude" />);
    fireEvent.click(await screen.findByRole("switch"));
    expect(promptsApi.enablePrompt).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认写入" })).toBeDisabled();
    expect(screen.getByLabelText("提示词目标工具")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(promptsApi.enablePrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认写入" }));
    await waitFor(() =>
      expect(promptsApi.enablePrompt).toHaveBeenCalledExactlyOnceWith(
        "claude",
        "real",
      ),
    );
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
  });
  it("refreshes live data without resetting an open editor draft", async () => {
    const view = render(<PromptsView refreshVersion={0} />);
    await screen.findByText("真实模板");
    fireEvent.click(screen.getByRole("button", { name: "新建提示词" }));
    const name = await screen.findByLabelText("prompts.name");
    fireEvent.change(name, { target: { value: "Keep draft" } });
    vi.mocked(promptsApi.getCurrentFileContent).mockResolvedValue(
      "Refreshed live",
    );
    view.rerender(<PromptsView refreshVersion={1} />);
    await waitFor(() => expect(promptsApi.getPrompts).toHaveBeenCalledTimes(2));
    expect(name).toHaveValue("Keep draft");
    expect(screen.getByLabelText("AGENTS.md 当前内容")).toHaveTextContent(
      "Refreshed live",
    );
  });
  it("keeps tool limits on the target selector instead of a page-wide notice", async () => {
    render(<PromptsView />);
    await screen.findByText("真实模板");
    expect(screen.queryByText(/暂不支持/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "提示词目标工具" }),
    ).toHaveAccessibleDescription(
      "Claude Desktop、Pi 和 MiniMax Code 暂不支持提示词",
    );
    // Template provenance lives in THIRD_PARTY_NOTICES.md, not in the UI.
    expect(screen.queryByText(/Codex-X/)).not.toBeInTheDocument();
    expect(
      screen.getByText(`${bundledPromptTemplates.length} 个`),
    ).toBeVisible();
  });
  it("shows a single loading line while the library is read", async () => {
    vi.mocked(promptsApi.getPrompts).mockReturnValue(new Promise(() => {}));
    render(<PromptsView />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取提示词…");
    expect(screen.getAllByText(/正在读取/)).toHaveLength(1);
    expect(screen.queryByText("从一条好指令开始")).not.toBeInTheDocument();
  });
  it("explains a missing AGENTS.md and that nothing is written before enabling", async () => {
    vi.mocked(promptsApi.getCurrentFileContent).mockResolvedValue(null);
    render(<PromptsView />);
    const preview = await screen.findByRole("region", { name: "提示词预览" });
    expect(await within(preview).findByText("还没有 AGENTS.md")).toBeVisible();
    expect(within(preview).getByText("尚未创建")).toBeVisible();
    expect(
      within(preview).getByText(/只维护文件中带标记的这一段/),
    ).toBeVisible();
    expect(
      within(preview).getByText("启用提示词之前，不会创建这个文件。"),
    ).toBeVisible();
    expect(
      screen.queryByLabelText("AGENTS.md 当前内容"),
    ).not.toBeInTheDocument();
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /代码审查/ }));
    expect(screen.getByLabelText("模板内容")).toHaveTextContent("#");
  });
  it("does not promise a managed block for tools that take the whole file", async () => {
    vi.mocked(promptsApi.getCurrentFileContent).mockResolvedValue(null);
    render(<PromptsView initialApp="claude" />);
    const preview = await screen.findByRole("region", { name: "提示词预览" });
    expect(await within(preview).findByText("还没有 CLAUDE.md")).toBeVisible();
    expect(
      within(preview).getByText(
        "启用一条提示词时，它的内容会写入整个 CLAUDE.md。",
      ),
    ).toBeVisible();
    expect(
      within(preview).queryByText(/带标记的这一段/),
    ).not.toBeInTheDocument();
  });
  it("confirms even inactive non-Codex saves and preserves a cancelled draft", async () => {
    render(<PromptsView initialApp="hermes" />);
    await screen.findByText("真实模板");
    fireEvent.click(screen.getByRole("button", { name: "新建提示词" }));
    fireEvent.change(await screen.findByLabelText("prompts.name"), {
      target: { value: "Soul draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    expect(
      await screen.findByText(/若没有其他启用条目也会清空文件/),
    ).toHaveTextContent("SOUL.md");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    expect(screen.getByLabelText("prompts.name")).toHaveValue("Soul draft");
  });
});
