import { useState, type ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderEditor, providerDraft } from "@/ChimeraApp";
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

describe("Chimera-only new-line template", () => {
  it("prefills Chimera and does not offer a provider catalog", () => {
    const { initial } = setup();
    expect(initial.baseUrl).toBe("https://api.chimerahub.org/v1");
    expect(initial.apiKey).toBe("");
    expect(screen.getByText("配置模板 · ChimeraHub")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "选择预设" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "恢复 Chimera 模板" }),
    ).toBeInTheDocument();
  });
  it("keeps addresses editable", () => {
    const { onDraftChange } = setup();
    fireEvent.change(
      screen.getByDisplayValue("https://api.chimerahub.org/v1"),
      { target: { value: "https://my-relay.example/v1" } },
    );
    expect(onDraftChange.mock.lastCall![0].baseUrl).toBe(
      "https://my-relay.example/v1",
    );
  });
  it("does not overwrite an existing route", () => {
    const { initial } = setup({
      original: {
        id: "existing",
        name: "已有线路",
        settingsConfig: { auth: {}, config: "" },
      },
    });
    expect(initial.baseUrl).toBe("");
    expect(
      screen.queryByRole("button", { name: "恢复 Chimera 模板" }),
    ).not.toBeInTheDocument();
  });
  it("requires confirmation before restoring and clearing a key", () => {
    const { onDraftChange } = setup({ apiKey: "sk-entered", name: "我的线路" });
    fireEvent.click(screen.getByRole("button", { name: "恢复 Chimera 模板" }));
    expect(onDraftChange).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "恢复模板",
      }),
    );
    expect(onDraftChange.mock.lastCall![0]).toMatchObject({
      name: "我的线路",
      baseUrl: "https://api.chimerahub.org/v1",
      apiKey: "",
    });
  });
  it.each(["claude", "gemini", "pi", "opencode"] as const)(
    "prefills %s without changing existing routes",
    (appId) => {
      expect(providerDraft(null, "新线路", appId).baseUrl).toBe(
        "https://api.chimerahub.org/v1",
      );
      expect(
        providerDraft(
          { id: "old", name: "旧线路", settingsConfig: {} },
          undefined,
          appId,
        ).baseUrl,
      ).toBe("");
    },
  );
});
