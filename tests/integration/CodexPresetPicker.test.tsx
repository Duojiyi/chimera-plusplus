import { useState, type ComponentProps } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderEditor, providerDraft } from "@/ChimeraApp";
import { settingsApi } from "@/lib/api/settings";

vi.mock("@/lib/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/settings")>();
  return {
    ...actual,
    settingsApi: { ...actual.settingsApi, openExternal: vi.fn() },
  };
});

function setup(
  options: {
    name?: string;
    apiKey?: string;
    original?: Parameters<typeof providerDraft>[0];
    editorProps?: Partial<ComponentProps<typeof ProviderEditor>>;
  } = {},
) {
  const onRequestClose = vi.fn();
  const onDraftChange = vi.fn();
  const initial = {
    ...providerDraft(options.original ?? null, options.name ?? "新线路"),
    apiKey: options.apiKey ?? "",
  };
  function Harness() {
    const [draft, setDraft] = useState(initial);
    return (
      <div className="chimera-shell">
        <div className="provider-editor-page">
          <ProviderEditor
            editor={draft}
            setEditor={(value) => {
              if (value) {
                onDraftChange(value);
                setDraft(value as typeof draft);
              }
            }}
            showKey={false}
            setShowKey={vi.fn()}
            fetchingModels={false}
            savingProvider={false}
            modelFetchError={null}
            apiFormatDetection={null}
            apiFormatDetectionError={null}
            commonConfigSnippet=""
            commonConfigLoading={false}
            commonConfigLoaded={true}
            onCommonConfigChange={vi.fn()}
            onFetchModels={vi.fn()}
            connection={{ kind: "unknown", message: "尚未测试" }}
            onTest={vi.fn()}
            onSave={vi.fn()}
            onDelete={vi.fn()}
            onRequestClose={onRequestClose}
            escapeDisabled={false}
            {...options.editorProps}
          />
        </div>
      </div>
    );
  }
  return { ...render(<Harness />), onRequestClose, onDraftChange, initial };
}

const openPicker = async (label = "选择预设") => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: label }));
  });
  return screen.findByRole("dialog", { name: "选择预设" });
};

// A preset's row, found by its exact name: "Kimi" must not match "Kimi For Coding".
const rowOf = (dialog: HTMLElement, name: string) =>
  within(dialog)
    .getByText(name, { selector: ".preset-text b" })
    .closest("button")!;

const pickRow = (dialog: HTMLElement, name: string) =>
  fireEvent.click(rowOf(dialog, name));

beforeAll(async () => {
  await import("@/components/providers/CodexPresetPicker");
}, 30000);

beforeEach(() => {
  vi.mocked(settingsApi.openExternal).mockReset();
});

describe("new-line preset picker", () => {
  it("starts on the default template and offers presets", () => {
    setup();
    expect(screen.getByText("默认模板")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "选择预设" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "恢复模板" }),
    ).toBeInTheDocument();
  });

  it("is not offered when editing an existing line", () => {
    setup({
      original: {
        id: "existing",
        name: "已有线路",
        settingsConfig: { auth: {}, config: "" },
      },
    });
    expect(
      screen.queryByRole("button", { name: "选择预设" }),
    ).not.toBeInTheDocument();
  });

  it("lists presets, narrows by search and applies the pick without a key", async () => {
    const { onDraftChange, initial } = setup({ apiKey: "sk-typed-earlier" });
    const dialog = await openPicker();
    expect(
      within(dialog).getByRole("list", { name: "预设列表" }),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("searchbox"), {
      target: { value: "moonshot" },
    });
    // The address and model names are searched too, so a few vendors match.
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      /^找到 [2-9] 个预设$/,
    );
    expect(
      within(dialog).queryByText("DeepSeek", { selector: ".preset-text b" }),
    ).not.toBeInTheDocument();
    pickRow(dialog, "Kimi");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(onDraftChange.mock.lastCall![0]).toMatchObject({
      id: initial.id,
      name: "Kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k3",
      apiKey: "",
      apiFormat: "openai_responses",
      original: null,
    });
    expect(
      onDraftChange.mock.lastCall![0].catalogModels.length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("起点：Kimi")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "更换预设" }),
    ).toBeInTheDocument();
  });

  it("keeps a name the user typed", async () => {
    setup({ name: "我的备用线路" });
    const dialog = await openPicker();
    pickRow(dialog, "DeepSeek");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("线路名称 *")).toHaveValue("我的备用线路");
  });

  it("renames a line whose name was filled in automatically", async () => {
    setup({ name: "默认线路" });
    const dialog = await openPicker();
    pickRow(dialog, "DeepSeek");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("线路名称 *")).toHaveValue("DeepSeek");
  });

  it("follows a later pick while the name is still the previous preset's", async () => {
    setup({ name: "新线路" });
    let dialog = await openPicker();
    pickRow(dialog, "DeepSeek");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    dialog = await openPicker("更换预设");
    expect(rowOf(dialog, "DeepSeek")).toHaveAttribute("aria-current", "true");
    pickRow(dialog, "Kimi");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("线路名称 *")).toHaveValue("Kimi");
    expect(screen.getByText("起点：Kimi")).toBeInTheDocument();
  });

  it("moves the caret to the API key after a complete preset", async () => {
    setup();
    const dialog = await openPicker();
    pickRow(dialog, "DeepSeek");
    await waitFor(() =>
      expect(screen.getByLabelText(/API Key \*/)).toHaveFocus(),
    );
  });

  it("sends the caret to the address when the preset leaves a placeholder in it", async () => {
    const { onDraftChange } = setup();
    const dialog = await openPicker();
    pickRow(dialog, "Azure OpenAI");
    await waitFor(() =>
      expect(screen.getByLabelText(/API 请求地址/)).toHaveFocus(),
    );
    expect(onDraftChange.mock.lastCall![0].baseUrl).toContain(
      "YOUR_RESOURCE_NAME",
    );
    expect(
      screen.getByText(/请把地址里的 YOUR_RESOURCE_NAME 换成你自己的内容/),
    ).toBeInTheDocument();
    expect(
      screen
        .getByText("起点：Azure OpenAI")
        .closest(".editor-template-actions"),
    ).toHaveClass("has-warning");
  });

  it("starts a blank custom line from the footer", async () => {
    const { onDraftChange } = setup({ apiKey: "sk-typed-earlier" });
    const dialog = await openPicker();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "自定义线路，手动填写" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/API 请求地址/)).toHaveFocus(),
    );
    expect(onDraftChange.mock.lastCall![0]).toMatchObject({
      baseUrl: "",
      apiKey: "",
      apiFormat: "auto",
      catalogModels: [],
    });
    expect(screen.getByText("起点：自定义线路")).toBeInTheDocument();
  });

  it("never offers sign-in presets", async () => {
    setup();
    const dialog = await openPicker();
    const names = within(dialog)
      .getAllByText(/./, { selector: ".preset-text b" })
      .map((node) => node.textContent);
    expect(names).not.toContain("OpenAI Official");
    expect(names).not.toContain("xAI (Grok) OAuth");
    // The same vendor's API-key preset stays.
    expect(names).toContain("xAI (Grok)");
  });

  it("filters by group and shows an empty state with a way back", async () => {
    setup();
    const dialog = await openPicker();
    const group = within(dialog).getByRole("group", { name: "预设分类" });
    fireEvent.click(within(group).getByRole("button", { name: /聚合平台/ }));
    expect(
      within(dialog).queryByText("DeepSeek", { selector: ".preset-text b" }),
    ).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("searchbox"), {
      target: { value: "zzzz-no-such-vendor" },
    });
    expect(within(dialog).getByText("没有匹配的预设")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "清除搜索" }));
    expect(within(dialog).getByRole("searchbox")).toHaveValue("");
    expect(rowOf(dialog, "DeepSeek")).toBeInTheDocument();
  });

  it("does not warn when the draft has no edits", async () => {
    setup({ editorProps: { dirty: false } });
    const dialog = await openPicker();
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
  });

  it("warns that a pick replaces the edits already made", async () => {
    setup({ editorProps: { dirty: true } });
    const dialog = await openPicker();
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "套用预设会重置地址、密钥、模型映射和高级设置",
    );
  });

  it("closes alone on Escape and leaves the editor open", async () => {
    const { onRequestClose } = setup();
    await openPicker();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it("picks the first result on Enter, but not while an IME composition is committed", async () => {
    const { onDraftChange } = setup();
    const dialog = await openPicker();
    const search = within(dialog).getByRole("searchbox");
    fireEvent.change(search, { target: { value: "moonshot" } });
    fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    expect(
      screen.getByRole("dialog", { name: "选择预设" }),
    ).toBeInTheDocument();
    expect(onDraftChange).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(onDraftChange.mock.lastCall![0].baseUrl).toBe(
      "https://api.moonshot.cn/v1",
    );
  });

  it("walks the list with the arrow keys and returns to the search box", async () => {
    setup();
    const dialog = await openPicker();
    const search = within(dialog).getByRole("searchbox");
    const rows = within(
      within(dialog).getByRole("list", { name: "预设列表" }),
    ).getAllByRole("button");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1], { key: "ArrowUp" });
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0], { key: "ArrowUp" });
    expect(search).toHaveFocus();
  });

  it("opens the vendor's key page in the system browser", async () => {
    setup();
    const dialog = await openPicker();
    pickRow(dialog, "DeepSeek");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "获取 API Key" }));
    expect(settingsApi.openExternal).toHaveBeenCalledWith(
      "https://platform.deepseek.com/api_keys",
    );
  });

  it("returns to the default template after a confirmed restore", async () => {
    setup();
    const dialog = await openPicker();
    pickRow(dialog, "DeepSeek");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("起点：DeepSeek")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复模板" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "恢复模板",
      }),
    );
    expect(screen.getByText("默认模板")).toBeInTheDocument();
    expect(screen.queryByText("起点：DeepSeek")).not.toBeInTheDocument();
  });
});
