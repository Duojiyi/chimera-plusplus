import { useState, type ComponentProps } from "react";
import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderEditor, providerDraft } from "@/ChimeraApp";

function setup(overrides: Partial<ComponentProps<typeof ProviderEditor>> = {}) {
  const onSave = vi.fn();
  const onRequestClose = vi.fn();
  const onDraftChange = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState({
      ...providerDraft(null, "测试线路"),
      apiKey: "test-key",
      apiFormat: "openai_responses" as const,
      catalogModels: [
        { model: "gpt-5.4", displayName: "主力模型", contextWindow: "" },
      ],
    });
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
            onSave={onSave}
            onDelete={vi.fn()}
            onRequestClose={onRequestClose}
            escapeDisabled={false}
            {...overrides}
          />
        </div>
      </div>
    );
  }
  return { ...render(<Harness />), onSave, onRequestClose, onDraftChange };
}

describe("full-page provider editor", () => {
  it("does not report untested models as failed when reopening persisted protocol results", () => {
    setup({
      editor: {
        ...providerDraft(null, "已有线路"),
        model: "gpt-current",
        apiFormat: "auto",
      },
      apiFormatDetection: {
        identity: "persisted-endpoint",
        formats: { "gpt-previous": { apiFormat: "openai_responses" } },
        failures: {},
      },
    });
    expect(screen.queryByText("未返回原因")).not.toBeInTheDocument();
    expect(
      screen.queryByText("也可以直接指定协议保存："),
    ).not.toBeInTheDocument();
  });

  it("still reports an explicitly failed model probe without a reason", () => {
    setup({
      editor: {
        ...providerDraft(null, "已有线路"),
        model: "gpt-current",
        apiFormat: "auto",
      },
      apiFormatDetection: {
        identity: "persisted-endpoint",
        formats: {},
        failures: { "gpt-current": "" },
      },
    });
    expect(screen.getByText("未返回原因")).toBeInTheDocument();
    expect(screen.getByText("也可以直接指定协议保存：")).toBeInTheDocument();
  });

  it("edits the persisted line color and restores the default without changing credentials", () => {
    const { onDraftChange } = setup();
    fireEvent.click(screen.getByLabelText("修改线路外观"));
    fireEvent.change(screen.getByLabelText("线路颜色"), {
      target: { value: "#8F6446" },
    });
    expect(onDraftChange.mock.lastCall![0]).toMatchObject({
      iconColor: "#8F6446",
      apiKey: "test-key",
    });
    expect(screen.getByLabelText("修改线路外观")).toHaveTextContent(
      "赭石 · 自动生成",
    );
    fireEvent.change(screen.getByLabelText("线路颜色"), {
      target: { value: "" },
    });
    expect(onDraftChange.mock.lastCall![0].iconColor).toBeUndefined();
  });

  it("retains existing custom colors and provider metadata in the draft", () => {
    const original = {
      id: "existing",
      name: "自定义",
      icon: "openai",
      iconColor: "#123456",
      sortIndex: 7,
      settingsConfig: { auth: {}, config: "" },
    };
    const draft = providerDraft(original);
    expect(draft.iconColor).toBe("#123456");
    expect(draft.original).toBe(original);
    setup({ editor: draft });
    fireEvent.click(screen.getByLabelText("修改线路外观"));
    expect(screen.getByLabelText("线路颜色")).toHaveValue("#123456");
    expect(
      screen.getByRole("option", { name: "当前自定义颜色" }),
    ).toBeInTheDocument();
  });

  it("locks appearance changes while saving", () => {
    setup({ savingProvider: true });
    expect(screen.getByLabelText("线路颜色")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("修改线路外观"));
    expect(
      screen.getByLabelText("修改线路外观").closest("details"),
    ).not.toHaveAttribute("open");
  });

  it("updates the visible route preview without exposing credentials or URL secrets", () => {
    setup();
    const preview = screen.getByLabelText("线路草稿预览");
    expect(preview).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("保存详情"));
    fireEvent.change(screen.getByLabelText("线路名称 *"), {
      target: { value: "预览线路" },
    });
    fireEvent.change(screen.getByLabelText(/API 请求地址/), {
      target: {
        value:
          "https://user:password@example.com/private-token?key=query-secret#fragment",
      },
    });
    fireEvent.change(screen.getByLabelText(/默认模型/), {
      target: { value: "example-model" },
    });
    expect(preview).toHaveTextContent("预览线路");
    expect(preview).toHaveTextContent("https://example.com");
    expect(preview).toHaveTextContent("example-model");
    for (const secret of [
      "test-key",
      "user:",
      "password",
      "private-token",
      "query-secret",
      "fragment",
    ])
      expect(preview).not.toHaveTextContent(secret);
    fireEvent.change(screen.getByLabelText(/API 请求地址/), {
      target: { value: "not-a-url secret-key" },
    });
    expect(preview).toHaveTextContent("尚未填写有效地址");
    expect(preview).not.toHaveTextContent("secret-key");
  });

  it("keeps keyboard-accessible protocol choices visible outside advanced configuration", () => {
    const { onDraftChange } = setup();
    const group = screen.getByRole("radiogroup", { name: "上游格式" });
    expect(group.closest("details")).toBeNull();
    fireEvent.click(within(group).getByRole("radio", { name: "Anthropic" }));
    expect(onDraftChange.mock.lastCall![0].apiFormat).toBe("anthropic");
    expect(
      within(group).getByRole("radio", { name: "Anthropic" }),
    ).toBeChecked();
    expect(screen.getByLabelText("线路草稿预览")).toHaveTextContent(
      "Anthropic",
    );
  });

  it("places deletion in the editor header and preserves the real save-and-apply operation", () => {
    const onDelete = vi.fn();
    const existing = {
      id: "existing",
      name: "已有线路",
      settingsConfig: { auth: {}, config: "" },
    };
    setup({
      editor: { ...providerDraft(existing), apiKey: "test-key" },
      onDelete,
    });
    const button = screen.getByRole("button", { name: "删除线路" });
    expect(button.closest("header")).not.toBeNull();
    fireEvent.click(button);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "保存并应用" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存" }),
    ).not.toBeInTheDocument();
  });

  it("is a non-modal page, focuses the heading, and exposes mapping outside advanced settings", () => {
    setup();
    expect(
      screen.getByRole("region", { name: "新建线路" }),
    ).not.toHaveAttribute("aria-modal");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "新建线路" })).toHaveFocus();
    expect(
      screen.getByLabelText("模型 1 实际请求模型").closest("details"),
    ).toBeNull();
    expect(screen.getByText("高级配置").closest("details")).not.toHaveAttribute(
      "open",
    );
    expect(
      screen.queryByRole("button", { name: "删除线路" }),
    ).not.toBeInTheDocument();
  });

  it("routes Back, Cancel and Escape through the same unsaved-close callback", () => {
    const { onRequestClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "返回线路" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onRequestClose).toHaveBeenCalledTimes(3);
  });

  it("blocks a blank mapped model with inline error and focus, retaining its other fields", () => {
    const { onSave } = setup();
    const model = screen.getByLabelText("模型 1 实际请求模型");
    fireEvent.change(model, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(model).toHaveFocus();
    expect(model).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("请填写实际请求模型");
    expect(screen.getByLabelText("模型 1 显示名")).toHaveValue("主力模型");
    fireEvent.change(model, { target: { value: "gpt-5.4-mini" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith();
  });

  it("allows saving with no mappings and closes indexed panels before a row is deleted", () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: "模型 1 思考等级" }));
    expect(screen.getByText("支持等级（可多选）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除模型 1 映射" }));
    expect(screen.queryByText("支持等级（可多选）")).not.toBeInTheDocument();
    expect(screen.getByText(/尚未添加自定义映射/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("locks fields and return actions during save", () => {
    const { onRequestClose } = setup({ savingProvider: true });
    expect(screen.getByLabelText("模型 1 实际请求模型")).toBeDisabled();
    expect(screen.getByRole("button", { name: "返回线路" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "删除模型 1 映射" }),
    ).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it("requires confirmation to restore a template and Escape only closes that dialog", async () => {
    const { onRequestClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "恢复模板" }));
    const dialog = screen.getByRole("alertdialog", { name: "恢复默认模板？" });
    expect(
      within(dialog).getByText(/地址、密钥、模型映射/),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("模型 1 显示名")).toHaveValue("主力模型");
  });

  it("restores only route fields without changing the draft identity or shared config", () => {
    const commonChange = vi.fn();
    const { onDraftChange } = setup({
      commonConfigSnippet: 'model = "shared"',
      onCommonConfigChange: commonChange,
    });
    fireEvent.change(screen.getByLabelText("模型 1 显示名"), {
      target: { value: "before reset" },
    });
    const id = onDraftChange.mock.lastCall![0].id;
    fireEvent.click(screen.getByRole("button", { name: "恢复模板" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "恢复模板",
      }),
    );
    expect(onDraftChange.mock.lastCall![0].id).toBe(id);
    expect(commonChange).not.toHaveBeenCalled();
  });

  it("opens and focuses invalid common configuration while preserving the save error", async () => {
    setup({ saveError: "通用配置无效，线路尚未保存：invalid TOML" });
    expect(screen.getByRole("alert")).toHaveTextContent("invalid TOML");
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: /通用 config.toml/ }),
      ).toHaveFocus(),
    );
    expect(screen.getByText("高级配置").closest("details")).toHaveAttribute(
      "open",
    );
  });

  it("keeps partial success visible and never calls save while a required field is blank", () => {
    const { onSave } = setup({
      saveError: "线路已保存并应用，但后续配置未完成。",
    });
    expect(screen.getByRole("alert")).toHaveTextContent("线路已保存并应用");
    const key = screen.getByLabelText(/API Key \*/);
    fireEvent.change(key, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(key).toHaveFocus();
  });
});

it("gives advanced configuration a visible disclosure action", () => {
  const { container } = setup();
  const summary = screen.getByText("高级配置").closest("summary")!;
  expect(within(summary).getByText("展开")).toBeInTheDocument();
  expect(within(summary).getByText("收起")).toBeInTheDocument();
  const details = container.querySelector("details.advanced-options")!;
  expect(details).not.toHaveAttribute("open");
  fireEvent.click(summary);
  expect(details).toHaveAttribute("open");
  fireEvent.click(summary);
  expect(details).not.toHaveAttribute("open");
});

describe("1M context switch in the line editor", () => {
  const openAdvanced = () =>
    fireEvent.click(screen.getByText("高级配置").closest("summary")!);

  it("is hidden while the capability is off", () => {
    setup();
    openAdvanced();
    expect(
      screen.queryByRole("switch", { name: "1M 上下文" }),
    ).not.toBeInTheDocument();
  });

  it("writes the preset into the draft's config and takes it out again", () => {
    const { onDraftChange } = setup({ context1mEnabled: true });
    openAdvanced();
    const toggle = screen.getByRole("switch", { name: "1M 上下文" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    const on = onDraftChange.mock.lastCall![0].config as string;
    expect(on).toContain("model_context_window = 1000000");
    expect(on).toContain("model_auto_compact_token_limit = 900000");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    const off = onDraftChange.mock.lastCall![0].config as string;
    expect(off).not.toContain("model_context_window");
    expect(off).not.toContain("model_auto_compact_token_limit");
  });

  it("is locked while the line is saving", () => {
    setup({ context1mEnabled: true, savingProvider: true });
    openAdvanced();
    expect(screen.getByRole("switch", { name: "1M 上下文" })).toBeDisabled();
  });
});
