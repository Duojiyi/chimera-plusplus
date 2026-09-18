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
