import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptsView } from "@/views/PromptsView";
import { bundledPromptTemplates } from "@/config/promptTemplates";
import { promptsApi, type Prompt } from "@/lib/api/prompts";
import { toast } from "sonner";
import { open } from "@tauri-apps/plugin-dialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/api/prompts", () => ({
  promptsApi: {
    getPrompts: vi.fn(),
    getCategories: vi.fn(),
    createCategory: vi.fn(),
    renameCategory: vi.fn(),
    deleteCategory: vi.fn(),
    getCurrentFileContent: vi.fn(),
    upsertPrompt: vi.fn(),
    enablePrompt: vi.fn(),
    setPromptEnabled: vi.fn(),
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
    readOnly,
  }: {
    value: string;
    onChange?: (value: string) => void;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label="Prompt content"
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));
const item: Prompt = {
  id: "real",
  name: "真实模板",
  description: "我的工作习惯",
  content: "Real instructions",
  enabled: false,
  createdAt: 1,
};
const template = bundledPromptTemplates[0];
let rows: Record<string, Prompt>;
let live: string | null;
let categories: { id: string; name: string }[];
const card = (name: string) => screen.getByRole("article", { name });
const toggle = (name = item.name) =>
  screen.getByRole("switch", { name: `启用 ${name}` });
const ready = () => screen.findByRole("article", { name: item.name });
const openFile = async () => {
  fireEvent.click(screen.getByRole("button", { name: "查看当前指令" }));
  await waitFor(() =>
    expect(screen.queryByText("正在读取文件…")).not.toBeInTheDocument(),
  );
};
const edit = (name = item.name) =>
  fireEvent.click(screen.getByRole("button", { name: `编辑 ${name}` }));
const menu = async (name = item.name) => {
  fireEvent.keyDown(screen.getByRole("button", { name: `操作 ${name}` }), {
    key: "ArrowDown",
  });
  await screen.findByRole("menu");
};
const consent = () => {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认写入" }));
};
const save = async (label = "保存") => {
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
};
beforeAll(async () => {
  await import("@/components/prompts/PromptFormModal");
  await import("@/components/prompts/PromptCategoryManager");
}, 60_000);
beforeEach(() => {
  vi.resetAllMocks();
  rows = { real: { ...item } };
  live = "Actual user file\n";
  categories = [
    { id: "software-development", name: "软件开发" },
    { id: "writing", name: "写作" },
  ];
  vi.mocked(promptsApi.getCategories).mockImplementation(async () =>
    structuredClone(categories),
  );
  vi.mocked(promptsApi.createCategory).mockImplementation(
    async (_app, name) => {
      const id = "category-new";
      categories.push({ id, name });
      return id;
    },
  );
  vi.mocked(promptsApi.renameCategory).mockImplementation(
    async (_app, id, name) => {
      categories.find((category) => category.id === id)!.name = name;
    },
  );
  vi.mocked(promptsApi.deleteCategory).mockImplementation(async (_app, id) => {
    categories = categories.filter((category) => category.id !== id);
    for (const row of Object.values(rows))
      if (row.categoryId === id) row.categoryId = undefined;
  });
  vi.mocked(open).mockResolvedValue("D:/templates/rules.md");
  vi.mocked(promptsApi.getPrompts).mockImplementation(async () =>
    structuredClone(rows),
  );
  vi.mocked(promptsApi.getCurrentFileContent).mockImplementation(
    async () => live,
  );
  vi.mocked(promptsApi.upsertPrompt).mockImplementation(
    async (_app, id, prompt, expected) => {
      if (
        expected &&
        (!rows[id] ||
          Object.keys({ ...rows[id], ...expected }).some(
            (key) =>
              rows[id][key as keyof Prompt] !== expected[key as keyof Prompt],
          ))
      )
        throw new Error(
          "这条提示词已更新或被删除，请重新打开后编辑。当前草稿尚未保存。",
        );
      rows[id] = { ...prompt };
    },
  );
  vi.mocked(promptsApi.setPromptEnabled).mockImplementation(
    async (_app, id, enabled) => {
      if (!rows[id]) throw new Error("提示词不存在，请刷新后重试。");
      rows[id].enabled = enabled;
    },
  );
  vi.mocked(promptsApi.enablePrompt).mockImplementation(async (_app, id) => {
    for (const row of Object.values(rows)) row.enabled = row.id === id;
  });
  vi.mocked(promptsApi.deletePrompt).mockImplementation(async (_app, id) => {
    delete rows[id];
  });
  vi.mocked(promptsApi.adoptForeignCodex).mockResolvedValue("adopted");
  vi.mocked(promptsApi.importFromFile).mockImplementation(async () => {
    rows.imported = { ...item, id: "imported", name: "导入的规则" };
    return "imported";
  });
});

describe("unified prompt library", () => {
  it("shows all built-ins and saved entries without a permanent file preview", async () => {
    render(<PromptsView />);
    await ready();
    expect(screen.getAllByRole("article")).toHaveLength(7);
    expect(
      screen.getByRole("region", { name: "当前提示词状态" }),
    ).toHaveTextContent("未启用 Chimera 提示词");
    expect(screen.getByText("7 条提示词")).toBeVisible();
    expect(screen.queryByText("Actual user file")).not.toBeInTheDocument();
    expect(screen.queryByText("我的提示词")).not.toBeInTheDocument();
    expect(screen.queryByText("内置模板")).not.toBeInTheDocument();
  });
  it("searches names and descriptions case-insensitively and clears filters", async () => {
    rows.real.description = "Review notes";
    render(<PromptsView />);
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索提示词" }), {
      target: { value: "REVIEW" },
    });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(card(item.name)).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索提示词" }), {
      target: { value: "not-found" },
    });
    expect(screen.getByText("没有匹配的提示词")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
    expect(screen.getAllByRole("article")).toHaveLength(7);
  });
  it("filters active entries without conflating source and category", async () => {
    render(<PromptsView />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /^已启用/ }));
    expect(screen.getByText("还没有启用的提示词")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: /^已启用/ }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(card(item.name)).toBeVisible();
  });
  it("keeps every existing template copy and never matches by name", async () => {
    rows = {
      a: { ...item, id: "a", name: "个人审查一", templateId: template.id },
      b: { ...item, id: "b", name: "个人审查二", templateId: template.id },
      c: { ...item, id: "c", name: template.name },
    };
    render(<PromptsView />);
    await screen.findByRole("article", { name: "个人审查一" });
    expect(screen.getAllByRole("article")).toHaveLength(8);
    expect(card("个人审查二")).toBeVisible();
    expect(within(card(template.name)).getByText("自定义")).toBeVisible();
    expect(
      screen.queryByRole("switch", { name: "启用 个人审查一" }),
    ).toBeInTheDocument();
  });
  it("previews a built-in without saving a copy", async () => {
    render(<PromptsView />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: template.name }));
    expect(await screen.findByLabelText("Prompt content")).toHaveValue(
      template.content,
    );
    expect(screen.getByLabelText("Prompt content")).toHaveAttribute("readonly");
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("activates a built-in directly, preserving its position and provenance", async () => {
    render(<PromptsView />);
    await ready();
    const before = screen
      .getAllByRole("article")
      .map((element) => element.getAttribute("aria-label"));
    fireEvent.click(toggle(template.name));
    await waitFor(() => expect(toggle(template.name)).toBeChecked());
    expect(promptsApi.upsertPrompt).toHaveBeenCalledExactlyOnceWith(
      "codex",
      expect.stringMatching(/^prompt-[0-9a-f-]{36}$/),
      expect.objectContaining({
        templateId: template.id,
        name: template.name,
        content: template.content,
        enabled: true,
      }),
    );
    expect(
      screen
        .getAllByRole("article")
        .map((element) => element.getAttribute("aria-label")),
    ).toEqual(before);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("can activate from the details panel without creating a second copy", async () => {
    render(<PromptsView />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: template.name }));
    fireEvent.click(
      await screen.findByRole("button", { name: "启用此提示词" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(toggle(template.name)).toBeChecked();
    expect(
      screen.getAllByRole("article", { name: template.name }),
    ).toHaveLength(1);
  });
  it("does not report activation before success and serializes mutations", async () => {
    let finish!: () => void;
    vi.mocked(promptsApi.setPromptEnabled).mockImplementation(
      (_app, id, enabled) =>
        new Promise((resolve) => {
          finish = () => {
            rows[id].enabled = enabled;
            resolve();
          };
        }),
    );
    render(<PromptsView />);
    await ready();
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).toBeDisabled());
    expect(toggle()).not.toBeChecked();
    fireEvent.click(toggle());
    expect(promptsApi.setPromptEnabled).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(toggle()).toBeChecked();
  });
  it("shows safe actionable native errors and never leaks arbitrary failures", async () => {
    vi.mocked(promptsApi.setPromptEnabled).mockRejectedValueOnce(
      new Error("secret-path"),
    );
    render(<PromptsView />);
    await ready();
    fireEvent.click(toggle());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.not.stringContaining("secret-path"),
      ),
    );
    await waitFor(() => expect(toggle()).not.toBeDisabled());
    expect(toggle()).not.toBeChecked();
    vi.mocked(promptsApi.setPromptEnabled).mockRejectedValueOnce(
      new Error("请先关闭 Codex 代理接管，再修改生效提示词。"),
    );
    fireEvent.click(toggle());
    await waitFor(() =>
      expect(toast.error).toHaveBeenLastCalledWith(
        "请先关闭 Codex 代理接管，再修改生效提示词。",
      ),
    );
  });
  it("clears stale rows on refresh failure and supports retry", async () => {
    render(<PromptsView />);
    await ready();
    vi.mocked(promptsApi.getPrompts).mockRejectedValueOnce(
      new Error("private"),
    );
    fireEvent.click(toggle());
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取");
    expect(
      screen.queryByRole("article", { name: item.name }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建提示词" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: template.name }),
    ).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await ready();
  });
  it("has a single loading message and does not advertise unsupported tools", async () => {
    vi.mocked(promptsApi.getPrompts).mockReturnValue(new Promise(() => {}));
    render(<PromptsView />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取提示词…");
    expect(screen.getAllByText(/正在读取/)).toHaveLength(1);
    expect(
      screen.queryByRole("option", { name: /Pi|MiniMax|Desktop/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "提示词目标工具" }),
    ).toHaveAccessibleDescription("Claude Desktop 和 Pi 暂不支持提示词");
    expect(screen.queryByText(/暂不支持/)).not.toBeInTheDocument();
  });
});

describe("prompt details and editing", () => {
  it("saves an inactive built-in edit in the same slot", async () => {
    render(<PromptsView />);
    await ready();
    edit(template.name);
    fireEvent.change(await screen.findByLabelText("名称"), {
      target: { value: "我的审查" },
    });
    await save();
    expect(card("我的审查")).toBeVisible();
    expect(
      screen.queryByRole("article", { name: template.name }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(7);
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "codex",
      expect.any(String),
      expect.objectContaining({
        name: "我的审查",
        templateId: template.id,
        enabled: false,
      }),
    );
  });
  it("retains identity and provenance when editing an existing copy", async () => {
    rows.real.templateId = template.id;
    render(<PromptsView />);
    await ready();
    edit();
    fireEvent.change(await screen.findByLabelText("Prompt content"), {
      target: { value: "Custom copy" },
    });
    await save();
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "codex",
      "real",
      expect.objectContaining({
        templateId: template.id,
        content: "Custom copy",
        enabled: false,
      }),
      expect.objectContaining({ id: "real" }),
    );
  });
  it("restores built-in content in the draft only until saved", async () => {
    rows.real.templateId = template.id;
    render(<PromptsView />);
    await ready();
    edit();
    fireEvent.click(
      await screen.findByRole("button", { name: "恢复内置内容" }),
    );
    expect(screen.getByLabelText("名称")).toHaveValue(template.name);
    expect(screen.getByLabelText("Prompt content")).toHaveValue(
      template.content,
    );
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    await save();
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "codex",
      "real",
      expect.objectContaining({
        content: template.content,
        templateId: template.id,
      }),
      expect.objectContaining({ id: "real" }),
    );
  });
  it("requires a name and body and creates a disabled entry", async () => {
    render(<PromptsView />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "新建提示词" }));
    fireEvent.change(await screen.findByLabelText("名称"), {
      target: { value: "New" },
    });
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Prompt content"), {
      target: { value: "Instructions" },
    });
    await save();
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "codex",
      expect.any(String),
      expect.objectContaining({
        name: "New",
        content: "Instructions",
        enabled: false,
      }),
    );
  });
  it("labels changed active content as applying changes", async () => {
    rows.real.enabled = true;
    render(<PromptsView />);
    await ready();
    edit();
    fireEvent.change(await screen.findByLabelText("Prompt content"), {
      target: { value: "Changed instructions" },
    });
    expect(
      await screen.findByRole("button", { name: "保存并应用" }),
    ).toBeVisible();
    await save("保存并应用");
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "codex",
      "real",
      expect.objectContaining({ enabled: true }),
      expect.objectContaining({ id: "real" }),
    );
  });
  it("warns before discarding a dirty draft and does not contaminate the next editor", async () => {
    render(<PromptsView />);
    await ready();
    edit(template.name);
    fireEvent.change(await screen.findByLabelText("名称"), {
      target: { value: "Draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("名称")).toHaveValue("Draft");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃修改" }));
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "新建提示词" }));
    expect(await screen.findByLabelText("名称")).toHaveValue("");
    expect(screen.getByLabelText("Prompt content")).toHaveValue("");
  });
  it("keeps failed drafts for retry without exposing native details", async () => {
    vi.mocked(promptsApi.upsertPrompt).mockRejectedValueOnce(
      new Error("private-path"),
    );
    render(<PromptsView />);
    await ready();
    edit();
    fireEvent.change(await screen.findByLabelText("名称"), {
      target: { value: "Updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled(),
    );
    expect(screen.getByLabelText("名称")).toHaveValue("Updated");
    await save();
    expect(card("Updated")).toBeVisible();
  });
  it("blocks closing and target switching during a save", async () => {
    let finish!: () => void;
    vi.mocked(promptsApi.upsertPrompt).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<PromptsView />);
    await ready();
    edit();
    fireEvent.click(await screen.findByRole("button", { name: "保存" }));
    expect(
      screen.getByRole("button", { name: "关闭提示词详情" }),
    ).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("提示词目标工具")).toBeDisabled();
    await act(async () => finish());
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("refreshes in the background without resetting unsaved fields", async () => {
    const view = render(<PromptsView refreshVersion={0} />);
    await ready();
    edit();
    fireEvent.change(await screen.findByLabelText("名称"), {
      target: { value: "Keep draft" },
    });
    view.rerender(<PromptsView refreshVersion={1} />);
    await waitFor(() => expect(promptsApi.getPrompts).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("名称")).toHaveValue("Keep draft");
  });
  it("updates save semantics after refresh without re-enabling a disabled entry", async () => {
    rows.real.enabled = true;
    const view = render(<PromptsView refreshVersion={0} />);
    await ready();
    edit();
    fireEvent.change(await screen.findByLabelText("名称"), {
      target: { value: "Keep draft" },
    });
    rows.real.enabled = false;
    view.rerender(<PromptsView refreshVersion={1} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled(),
    );
    expect(screen.getByLabelText("名称")).toHaveValue("Keep draft");
    await save();
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "codex",
      "real",
      expect.objectContaining({ name: "Keep draft", enabled: false }),
      expect.objectContaining({ id: "real" }),
    );
  });
  it("only duplicates after an explicit copy action", async () => {
    rows.real.enabled = true;
    render(<PromptsView />);
    await ready();
    await menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "复制" }));
    expect(await screen.findByLabelText("名称")).toHaveValue(
      `${item.name}（副本）`,
    );
    await save();
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "codex",
      expect.not.stringMatching(/^real$/),
      expect.objectContaining({ enabled: false, name: `${item.name}（副本）` }),
    );
    expect(card(item.name)).toBeVisible();
    expect(card(`${item.name}（副本）`)).toBeVisible();
  });
});

describe("imports, deletion and actual files", () => {
  it("imports through the file picker, resets filters and reveals the inactive entry", async () => {
    render(<PromptsView />);
    await ready();
    fireEvent.change(screen.getByLabelText("搜索提示词"), {
      target: { value: "no match" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^已启用/ }));
    fireEvent.click(screen.getByRole("button", { name: "导入 .md" }));
    expect(
      await screen.findByRole("article", { name: "导入的规则" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "已导入提示词，尚未启用",
    );
    expect(toggle("导入的规则")).not.toBeChecked();
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
  it("does nothing when the file picker is cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    render(<PromptsView />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "导入 .md" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "导入 .md" }),
      ).not.toBeDisabled(),
    );
    expect(promptsApi.importFromFile).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
  it("serializes the picker and recovers from a failed import", async () => {
    let select!: (path: string) => void;
    vi.mocked(open).mockReturnValue(
      new Promise((resolve) => {
        select = resolve;
      }),
    );
    vi.mocked(promptsApi.importFromFile).mockRejectedValue(
      new Error("secret-file"),
    );
    render(<PromptsView />);
    await ready();
    const button = screen.getByRole("button", { name: "导入 .md" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    expect(toggle()).toBeDisabled();
    await act(async () => select("D:/rules.md"));
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(toast.error).toHaveBeenCalledWith(
      expect.not.stringContaining("secret-file"),
    );
  });
  it("confirms deletion and changes nothing on cancel", async () => {
    render(<PromptsView />);
    await ready();
    await menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "不修改 AGENTS.md",
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(promptsApi.deletePrompt).not.toHaveBeenCalled();
    expect(card(item.name)).toBeVisible();
  });
  it("requires disabling before deletion", async () => {
    rows.real.enabled = true;
    render(<PromptsView />);
    await ready();
    await menu();
    expect(
      screen.getByRole("menuitem", { name: "请先禁用后删除" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(promptsApi.deletePrompt).not.toHaveBeenCalled();
  });
  it("serializes deletion, blocks dismissal, and reloads the library", async () => {
    let finish!: () => void;
    vi.mocked(promptsApi.deletePrompt).mockReturnValue(
      new Promise((resolve) => {
        finish = () => {
          delete rows.real;
          resolve();
        };
      }),
    );
    render(<PromptsView />);
    await ready();
    await menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => finish());
    expect(
      screen.queryByRole("article", { name: item.name }),
    ).not.toBeInTheDocument();
    expect(promptsApi.deletePrompt).toHaveBeenCalledExactlyOnceWith(
      "codex",
      "real",
    );
  });
  it("keeps failed deletion available for retry", async () => {
    vi.mocked(promptsApi.deletePrompt).mockRejectedValueOnce(
      new Error("secret"),
    );
    render(<PromptsView />);
    await ready();
    await menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "确认删除" }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("previews and refreshes the actual file on demand", async () => {
    render(<PromptsView />);
    await ready();
    live = "Changed before preview opened";
    await openFile();
    expect(screen.getByLabelText("AGENTS.md 当前内容")).toHaveTextContent(
      "Changed before preview opened",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "写入成功不代表已有会话已重新加载",
    );
    live = "Updated externally";
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(screen.getByLabelText("AGENTS.md 当前内容")).toHaveTextContent(
        "Updated externally",
      ),
    );
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
  });
  it.each([null, ""])(
    "distinguishes missing and empty files (%s) without creating one",
    async (content) => {
      live = content;
      render(<PromptsView />);
      await ready();
      await openFile();
      if (content === null) {
        expect(screen.getByText("还没有 AGENTS.md")).toBeVisible();
        expect(
          screen.getByText("启用提示词之前，不会创建这个文件。"),
        ).toBeVisible();
      } else
        expect(screen.getByLabelText("AGENTS.md 当前内容")).toHaveTextContent(
          "文件为空",
        );
      expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    },
  );
});

describe("tool-specific file semantics", () => {
  it.each([
    ["claude", "CLAUDE.md"],
    ["gemini", "GEMINI.md"],
    ["grokbuild", "AGENTS.md"],
    ["opencode", "AGENTS.md"],
  ] as const)(
    "loads and imports for %s without multi-enable switches",
    async (app, file) => {
      render(<PromptsView initialApp={app} />);
      await ready();
      expect(promptsApi.getPrompts).toHaveBeenCalledWith(app);
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
      expect(
        screen.getByRole("region", { name: "当前提示词状态" }),
      ).toHaveTextContent(
        "每次使用一条，应用时替换整个指令文件；原文保留在提示词库。",
      );
      await openFile();
      expect(screen.getByLabelText(`${file} 当前内容`)).toHaveTextContent(
        "Actual user file",
      );
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
      fireEvent.click(screen.getByRole("button", { name: "导入 .md" }));
      await waitFor(() =>
        expect(promptsApi.importFromFile).toHaveBeenCalledWith(
          app,
          "D:/templates/rules.md",
        ),
      );
    },
  );
  it("requires explicit consent and uses exclusive activation", async () => {
    render(<PromptsView initialApp="claude" />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: `设为当前 ${item.name}` }),
    );
    expect(screen.getByRole("button", { name: "确认写入" })).toBeDisabled();
    expect(screen.getByLabelText("提示词目标工具")).toBeDisabled();
    expect(promptsApi.enablePrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(promptsApi.enablePrompt).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: `设为当前 ${item.name}` }),
    );
    consent();
    await waitFor(() =>
      expect(within(card(item.name)).getByText("当前使用")).toBeVisible(),
    );
    expect(promptsApi.enablePrompt).toHaveBeenCalledExactlyOnceWith(
      "claude",
      "real",
    );
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
  });
  it("saves a new template inactive before exclusive activation so original-file preservation is retained", async () => {
    render(<PromptsView initialApp="claude" />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: `设为当前 ${template.name}` }),
    );
    consent();
    await waitFor(() =>
      expect(promptsApi.enablePrompt).toHaveBeenCalledTimes(1),
    );
    const id = vi.mocked(promptsApi.upsertPrompt).mock.calls[0][1];
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "claude",
      id,
      expect.objectContaining({ enabled: false, templateId: template.id }),
    );
    expect(promptsApi.enablePrompt).toHaveBeenCalledWith("claude", id);
    expect(
      vi.mocked(promptsApi.upsertPrompt).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(promptsApi.enablePrompt).mock.invocationCallOrder[0],
    );
  });
  it("keeps a new template recoverable and inactive if activation fails", async () => {
    vi.mocked(promptsApi.enablePrompt).mockRejectedValueOnce(
      new Error("private"),
    );
    render(<PromptsView initialApp="claude" />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: `设为当前 ${template.name}` }),
    );
    consent();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: `设为当前 ${template.name}` }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: `设为当前 ${template.name}` }),
    );
    consent();
    await waitFor(() =>
      expect(within(card(template.name)).getByText("当前使用")).toBeVisible(),
    );
    expect(promptsApi.upsertPrompt).toHaveBeenCalledTimes(1);
  });
  it("retries activation in the details drawer without creating another template copy", async () => {
    vi.mocked(promptsApi.enablePrompt).mockRejectedValueOnce(
      new Error("private"),
    );
    render(<PromptsView initialApp="claude" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: template.name }));
    fireEvent.click(await screen.findByRole("button", { name: "设为当前" }));
    consent();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "设为当前" }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "设为当前" }));
    consent();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(promptsApi.upsertPrompt).toHaveBeenCalledTimes(1);
    expect(promptsApi.enablePrompt).toHaveBeenCalledTimes(2);
    expect(vi.mocked(promptsApi.enablePrompt).mock.calls[0][1]).toBe(
      vi.mocked(promptsApi.enablePrompt).mock.calls[1][1],
    );
  });
  it("keeps a pending whole-file confirmation usable through background refresh", async () => {
    const view = render(<PromptsView initialApp="claude" refreshVersion={0} />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "设为当前 " + item.name }),
    );
    view.rerender(<PromptsView initialApp="claude" refreshVersion={1} />);
    await waitFor(() => expect(promptsApi.getPrompts).toHaveBeenCalledTimes(2));
    consent();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(promptsApi.enablePrompt).toHaveBeenCalledExactlyOnceWith(
      "claude",
      "real",
    );
  });
  it("saves inactive entries without obsolete whole-file warnings", async () => {
    render(<PromptsView initialApp="claude" />);
    await ready();
    edit();
    await screen.findByLabelText("名称");
    await save();
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "claude",
      "real",
      expect.objectContaining({ enabled: false }),
      expect.objectContaining({ id: "real" }),
    );
    expect(promptsApi.enablePrompt).not.toHaveBeenCalled();
  });
  it("confirms active saves and keeps a cancelled draft", async () => {
    rows.real.enabled = true;
    render(<PromptsView initialApp="claude" />);
    await ready();
    edit();
    fireEvent.change(await screen.findByLabelText("名称"), {
      target: { value: "Draft" },
    });
    fireEvent.change(screen.getByLabelText("Prompt content"), {
      target: { value: "Changed instructions" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    expect(
      await screen.findByRole("button", { name: "确认写入" }),
    ).toBeDisabled();
    const confirmationDialog = screen
      .getAllByRole("dialog")
      .find((dialog) => dialog.textContent?.includes("确认修改提示词文件"))!;
    fireEvent.click(
      within(confirmationDialog).getByRole("button", {
        name: "取消",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "保存并应用" }),
      ).not.toBeDisabled(),
    );
    expect(screen.getByLabelText("名称")).toHaveValue("Draft");
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
  });
  it("explicitly warns that disabling clears the whole file without restoring old instructions", async () => {
    rows.real.enabled = true;
    render(<PromptsView initialApp="claude" />);
    await ready();
    await menu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "停用并清空指令文件" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "不会自动恢复之前的指令",
    );
    consent();
    await waitFor(() =>
      expect(promptsApi.setPromptEnabled).toHaveBeenCalledWith(
        "claude",
        "real",
        false,
      ),
    );
  });
  it("clears filters and old content when changing tools, ignoring late responses", async () => {
    let finish!: (value: string) => void;
    vi.mocked(promptsApi.getCurrentFileContent).mockImplementation((app) =>
      app === "codex"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve("Gemini file"),
    );
    render(<PromptsView />);
    fireEvent.change(screen.getByLabelText("搜索提示词"), {
      target: { value: "something" },
    });
    fireEvent.change(screen.getByLabelText("提示词目标工具"), {
      target: { value: "gemini" },
    });
    await ready();
    await act(async () => finish("Stale Codex file"));
    expect(screen.getByLabelText("搜索提示词")).toHaveValue("");
    await openFile();
    expect(screen.getByLabelText("GEMINI.md 当前内容")).toHaveTextContent(
      "Gemini file",
    );
    expect(screen.queryByText("Stale Codex file")).not.toBeInTheDocument();
  });
});

describe("explicit Codex-X takeover", () => {
  const original =
    "User\n<!-- CODEX-X:INSTRUCTIONS:BEGIN -->\nForeign\n<!-- CODEX-X:INSTRUCTIONS:END -->";
  const openAdoption = async () => {
    fireEvent.click(screen.getByRole("button", { name: "查看与接管" }));
    expect(
      await screen.findByLabelText("AGENTS.md 当前内容"),
    ).toHaveTextContent("Foreign");
    fireEvent.click(screen.getByRole("button", { name: "接管 Codex-X 区块" }));
    await screen.findByRole("button", { name: "确认接管" });
  };
  it("requires preview and consent, serializes adoption and uses the observed snapshot", async () => {
    live = original;
    let finish!: (id: string) => void;
    vi.mocked(promptsApi.adoptForeignCodex).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<PromptsView />);
    await ready();
    await openAdoption();
    const button = screen.getByRole("button", { name: "确认接管" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(promptsApi.adoptForeignCodex).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    fireEvent.click(button);
    expect(promptsApi.adoptForeignCodex).toHaveBeenCalledExactlyOnceWith(
      original,
    );
    live = original.replaceAll("CODEX-X:", "CHIMERA:");
    await act(async () => finish("adopted"));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "确认接管" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "接管 Codex-X 区块" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("AGENTS.md 当前内容")).toHaveTextContent(
      "CHIMERA:",
    );
  });
  it("cancels without writes and requires fresh consent after failure", async () => {
    live = original;
    render(<PromptsView />);
    await ready();
    await openAdoption();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(promptsApi.adoptForeignCodex).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "接管 Codex-X 区块" }));
    fireEvent.click(screen.getByRole("checkbox"));
    vi.mocked(promptsApi.adoptForeignCodex).mockRejectedValueOnce(
      new Error("private-file"),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认接管" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "确认接管" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "接管 Codex-X 区块" }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "确认接管" })).toBeDisabled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.not.stringContaining("private-file"),
    );
  });
});

describe("prompt categories", () => {
  const filter = (name: string) =>
    fireEvent.click(
      within(screen.getByRole("group", { name: "分类筛选" })).getByRole(
        "button",
        { name: new RegExp("^" + name) },
      ),
    );
  const manage = async () => {
    fireEvent.click(screen.getByRole("button", { name: "管理分类" }));
    await screen.findByLabelText("新分类名称");
  };
  it("filters built-ins by purpose, independently of enabled status", async () => {
    render(<PromptsView />);
    await ready();
    filter("软件开发");
    expect(screen.getAllByRole("article")).toHaveLength(3);
    fireEvent.click(toggle(template.name));
    await waitFor(() => expect(toggle(template.name)).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: /^已启用/ }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(
      rows[Object.keys(rows).find((id) => id !== "real")!].categoryId,
    ).toBe("software-development");
  });
  it("preserves saved copies and custom categories after a bundled template is removed", async () => {
    categories.push({ id: "custom-research", name: "研究" });
    rows.real = {
      ...rows.real,
      templateId: "retired-template",
      categoryId: "custom-research",
      enabled: true,
    };
    const saved = structuredClone(rows.real);
    render(<PromptsView />);
    await ready();
    expect(screen.getAllByRole("article")).toHaveLength(7);
    filter("研究");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(toggle()).toBeChecked();
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    edit();
    expect(await screen.findByLabelText("Prompt content")).toHaveValue(
      saved.content,
    );
    expect(screen.getByLabelText("分类")).toHaveValue("custom-research");
    expect(rows.real).toEqual(saved);
  });
  it("never assigns a default category to an explicitly unclassified saved template", async () => {
    rows.real.templateId = template.id;
    render(<PromptsView />);
    await ready();
    filter("软件开发");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    filter("未分类");
    expect(card(item.name)).toBeVisible();
  });
  it("uses the selected category for new prompts, and allows clearing it", async () => {
    render(<PromptsView />);
    await ready();
    filter("写作");
    fireEvent.click(screen.getByRole("button", { name: "新建提示词" }));
    expect(await screen.findByLabelText("分类")).toHaveValue("writing");
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByLabelText("Prompt content"), {
      target: { value: " body\n" },
    });
    await save();
    expect(card("New")).toBeVisible();
    expect(Object.values(rows).find((row) => row.name === "New")).toMatchObject(
      { categoryId: "writing", content: " body\n" },
    );
    edit("New");
    fireEvent.change(await screen.findByLabelText("分类"), {
      target: { value: "" },
    });
    await save();
    expect(
      Object.values(rows).find((row) => row.name === "New")?.categoryId,
    ).toBeUndefined();
  });
  it("creates, renames and deletes categories without deleting or disabling prompts", async () => {
    rows.real.categoryId = "writing";
    rows.real.enabled = true;
    render(<PromptsView />);
    await ready();
    await manage();
    fireEvent.change(screen.getByLabelText("新分类名称"), {
      target: { value: "日常办公" },
    });
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    await screen.findByRole("button", { name: "重命名 日常办公" });
    expect(promptsApi.createCategory).toHaveBeenCalledWith("codex", "日常办公");
    fireEvent.click(screen.getByRole("button", { name: "重命名 写作" }));
    fireEvent.change(screen.getByLabelText("分类新名称"), {
      target: { value: "文案" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存分类" }));
    await screen.findByRole("button", { name: "删除分类 文案" });
    fireEvent.click(screen.getByRole("button", { name: "删除分类 文案" }));
    expect(
      screen.getByRole("dialog", { name: "删除分类？" }),
    ).toHaveTextContent("不会删除提示词或修改生效文件");
    fireEvent.click(screen.getByRole("button", { name: "删除分类" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "删除分类？" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    filter("未分类");
    expect(card(item.name)).toBeVisible();
    expect(toggle()).toBeChecked();
    expect(rows.real).toMatchObject({
      content: item.content,
      enabled: true,
      categoryId: undefined,
    });
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    expect(promptsApi.deletePrompt).not.toHaveBeenCalled();
  });
  it("rejects duplicate and reserved category names before sending", async () => {
    render(<PromptsView />);
    await ready();
    await manage();
    for (const name of ["写作", "未分类", "全部", " "]) {
      fireEvent.change(screen.getByLabelText("新分类名称"), {
        target: { value: name },
      });
      expect(screen.getByRole("button", { name: "新增" })).toBeDisabled();
    }
    expect(promptsApi.createCategory).not.toHaveBeenCalled();
  });
  it("keeps the category draft on failure and masks unexpected backend errors", async () => {
    vi.mocked(promptsApi.createCategory).mockRejectedValueOnce(
      "secret database path",
    );
    render(<PromptsView />);
    await ready();
    await manage();
    fireEvent.change(screen.getByLabelText("新分类名称"), {
      target: { value: "工作" },
    });
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "提示词操作未完成，请检查当前状态后重试。",
      ),
    );
    expect(screen.getByLabelText("新分类名称")).toHaveValue("工作");
  });
  it("allows closing category management after a background read failure", async () => {
    const view = render(<PromptsView />);
    await ready();
    await manage();
    vi.mocked(promptsApi.getCategories).mockRejectedValueOnce("unavailable");
    view.rerender(<PromptsView refreshVersion={1} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "新增" })).toBeDisabled(),
    );
    await waitFor(() =>
      expect(promptsApi.getCategories).toHaveBeenCalledTimes(2),
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭分类管理" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("resets a removed active filter and keeps deleted defaults unclassified", async () => {
    const view = render(<PromptsView />);
    await ready();
    filter("写作");
    categories = [];
    view.rerender(<PromptsView refreshVersion={1} />);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(7));
    expect(within(card(template.name)).getByText("未分类")).toBeVisible();
  });
  it("reveals imports even when a category and enabled filter hide them", async () => {
    render(<PromptsView />);
    await ready();
    filter("写作");
    fireEvent.click(screen.getByRole("button", { name: /^已启用/ }));
    fireEvent.click(screen.getByRole("button", { name: "导入 .md" }));
    expect(
      await screen.findByRole("article", { name: "导入的规则" }),
    ).toBeVisible();
  });
  it("saves active whole-file metadata without requiring file-write consent", async () => {
    rows.real.enabled = true;
    rows.real.content = " rules\n";
    render(<PromptsView initialApp="claude" />);
    await ready();
    edit();
    fireEvent.change(await screen.findByLabelText("分类"), {
      target: { value: "writing" },
    });
    await save();
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "claude",
      "real",
      expect.objectContaining({
        content: " rules\n",
        categoryId: "writing",
        enabled: true,
      }),
      expect.objectContaining({ id: "real" }),
    );
  });
  it("preserves a draft and blocks saving after its record was deleted elsewhere", async () => {
    const view = render(<PromptsView />);
    await ready();
    edit();
    fireEvent.change(await screen.findByLabelText("名称"), {
      target: { value: "Draft" },
    });
    rows = {};
    view.rerender(<PromptsView refreshVersion={1} />);
    await screen.findByText(/这条提示词已被删除/);
    expect(screen.getByLabelText("名称")).toHaveValue("Draft");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });
  it("can repair an old orphaned category without weakening the content baseline", async () => {
    rows.real.categoryId = "old-missing-category";
    render(<PromptsView />);
    await ready();
    edit();
    await screen.findByLabelText("分类");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("分类"), {
      target: { value: "writing" },
    });
    await save();
    expect(rows.real.categoryId).toBe("writing");
    expect(rows.real.content).toBe(item.content);
  });
  it("requires a fresh category choice if the draft's category was removed", async () => {
    rows.real.categoryId = "writing";
    const view = render(<PromptsView />);
    await ready();
    edit();
    await screen.findByLabelText("分类");
    categories = [];
    rows.real.categoryId = undefined;
    view.rerender(<PromptsView refreshVersion={1} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeDisabled(),
    );
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "" } });
    await save();
    expect(rows.real.categoryId).toBeUndefined();
  });
});

describe("audited prompt write races", () => {
  it("rejects stale metadata saves after the live record body changed and keeps the draft", async () => {
    rows.real.enabled = true;
    const view = render(<PromptsView initialApp="claude" />);
    await ready();
    edit();
    fireEvent.change(await screen.findByLabelText("分类"), {
      target: { value: "writing" },
    });
    rows.real.content = "Newer body from another editor";
    rows.real.updatedAt = 123;
    view.rerender(<PromptsView initialApp="claude" refreshVersion={1} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "这条提示词已更新或被删除，请重新打开后编辑。当前草稿尚未保存。",
      ),
    );
    expect(rows.real.content).toBe("Newer body from another editor");
    expect(rows.real.categoryId).toBeUndefined();
    expect(screen.getByLabelText("Prompt content")).toHaveValue(item.content);
    expect(screen.getByLabelText("分类")).toHaveValue("writing");
    expect(
      screen.queryByRole("button", { name: "确认写入" }),
    ).not.toBeInTheDocument();
    expect(promptsApi.upsertPrompt).toHaveBeenCalledWith(
      "claude",
      "real",
      expect.any(Object),
      expect.objectContaining({ content: item.content, enabled: true }),
    );
  });
  it("activates the latest saved Codex record from a stale preview without overwriting it", async () => {
    rows.other = {
      ...item,
      id: "other",
      name: "Other",
      content: "Also enabled",
      enabled: true,
    };
    const view = render(<PromptsView />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: item.name }));
    await screen.findByLabelText("Prompt content");
    rows.real.content = "Newer saved content";
    rows.real.categoryId = "writing";
    view.rerender(<PromptsView refreshVersion={1} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "启用此提示词" }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "启用此提示词" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(promptsApi.setPromptEnabled).toHaveBeenCalledExactlyOnceWith(
      "codex",
      "real",
      true,
    );
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    expect(rows.real).toMatchObject({
      content: "Newer saved content",
      categoryId: "writing",
      enabled: true,
    });
    expect(rows.other.enabled).toBe(true);
  });
  it("cancels an outstanding write confirmation when refresh observes a deletion", async () => {
    rows.real.enabled = true;
    const view = render(<PromptsView initialApp="claude" />);
    await ready();
    edit();
    fireEvent.change(await screen.findByLabelText("Prompt content"), {
      target: { value: "Keep my draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findByRole("button", { name: "确认写入" });
    delete rows.real;
    view.rerender(<PromptsView initialApp="claude" refreshVersion={1} />);
    await screen.findByText(/这条提示词已被删除/);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "确认写入" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Prompt content")).toHaveValue(
      "Keep my draft",
    );
    expect(promptsApi.upsertPrompt).not.toHaveBeenCalled();
    expect(rows.real).toBeUndefined();
  });
  it("also refuses a deleted record when no refresh occurred during confirmation", async () => {
    rows.real.enabled = true;
    render(<PromptsView initialApp="claude" />);
    await ready();
    edit();
    fireEvent.change(await screen.findByLabelText("Prompt content"), {
      target: { value: "Keep my draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findByRole("button", { name: "确认写入" });
    delete rows.real;
    consent();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "这条提示词已更新或被删除，请重新打开后编辑。当前草稿尚未保存。",
      ),
    );
    expect(rows.real).toBeUndefined();
    expect(screen.getByLabelText("Prompt content")).toHaveValue(
      "Keep my draft",
    );
  });
});
