import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderEditor, providerDraft } from "@/ChimeraApp";
import { CodexModelPicker } from "@/components/providers/CodexModelPicker";
import type { AppId } from "@/lib/api/types";
import type { Provider } from "@/types";
import {
  claudeModelValue,
  toolProviderFields,
} from "@/utils/toolProviderConfig";

const line: Provider = {
  id: "relay",
  name: "Relay",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://relay.example",
      ANTHROPIC_AUTH_TOKEN: "relay-key",
      ANTHROPIC_MODEL: "main-1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "mid-1",
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Mid",
    },
  },
};

function setup(
  appId: AppId,
  provider: Provider | null = line,
  { inUse = false }: { inUse?: boolean } = {},
) {
  const onFetchModels = vi.fn();
  let latest = providerDraft(provider, undefined, appId);
  function Harness() {
    const [draft, setDraft] = useState(latest);
    return (
      <div className="chimera-shell">
        <div className="provider-editor-page">
          <ProviderEditor
            appId={appId}
            editor={draft}
            setEditor={(value) => {
              if (!value) return;
              latest = value;
              setDraft(value);
            }}
            showKey={false}
            setShowKey={vi.fn()}
            fetchingModels={false}
            savingProvider={false}
            commonConfigSnippet=""
            commonConfigLoading={false}
            commonConfigLoaded
            onCommonConfigChange={vi.fn()}
            onFetchModels={onFetchModels}
            connection={{ kind: "unknown", message: "尚未测试" }}
            onTest={vi.fn()}
            onSave={vi.fn()}
            onDelete={vi.fn()}
            onRequestClose={vi.fn()}
            escapeDisabled={false}
            inUse={inUse}
          />
        </div>
      </div>
    );
  }
  render(<Harness />);
  return { onFetchModels, draft: () => latest };
}

const field = (name: string) => screen.getByRole("textbox", { name });

describe("Claude Code line models", () => {
  it("shows the line's tier mapping and edits it in place", () => {
    const { draft } = setup("claude");
    expect(field("Sonnet 实际请求模型")).toHaveValue("mid-1");
    expect(field("Sonnet 菜单显示名")).toHaveValue("Mid");
    // A menu name needs a model to name.
    expect(field("Opus 菜单显示名")).toBeDisabled();
    fireEvent.change(field("Opus 实际请求模型"), {
      target: { value: "big-1" },
    });
    expect(draft().claudeTiers.opus.model).toBe("big-1");
    expect(field("Opus 菜单显示名")).toBeEnabled();
    fireEvent.change(field("子代理实际请求模型"), {
      target: { value: "agent-1" },
    });
    expect(draft().subagentModel).toBe("agent-1");
    expect(draft().claudeTiers.sonnet).toEqual({ model: "mid-1", name: "Mid" });
  });

  it("opens the model list for the field it was asked from", () => {
    const { onFetchModels } = setup("claude");
    fireEvent.click(screen.getByRole("button", { name: /获取模型/ }));
    expect(onFetchModels).toHaveBeenLastCalledWith();
    fireEvent.click(
      screen.getByRole("button", { name: "从模型列表选择 Opus 模型" }),
    );
    expect(onFetchModels).toHaveBeenLastCalledWith("opus");
    fireEvent.click(
      screen.getByRole("button", { name: "从模型列表选择子代理模型" }),
    );
    expect(onFetchModels).toHaveBeenLastCalledWith("subagent");
  });

  it("gives other tools the same model control without tiers", () => {
    setup("gemini", null);
    expect(
      screen.getByRole("button", { name: "获取模型" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("模型映射")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /1M/ })).toBeNull();
  });

  it("lists the tiers in one table order with a 1M column", () => {
    setup("claude");
    const tiers = [...document.querySelectorAll(".mapping-row .mapping-role")];
    expect(tiers.map((cell) => cell.textContent)).toEqual([
      "Sonnet",
      "Opus",
      "Fable",
      "Haiku",
      "子代理",
    ]);
    expect(
      [...document.querySelectorAll(".mapping-head > span")].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(["档位", "菜单显示名（可选）", "实际请求模型", "声明支持 1M"]);
  });
});

const oneM: Provider = {
  id: "one-m",
  name: "1M",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://relay.example",
      ANTHROPIC_AUTH_TOKEN: "relay-key",
      ANTHROPIC_MODEL: "main-1[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "mid-1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "big-1[1M]",
    },
  },
};

describe("Claude Code 1M declaration", () => {
  it("shows the bare ID with a checked box, read in any case", () => {
    setup("claude", oneM);
    expect(field("默认模型（可选）")).toHaveValue("main-1");
    expect(
      screen.getByRole("checkbox", { name: "默认模型 声明支持 1M" }),
    ).toBeChecked();
    expect(field("Opus 实际请求模型")).toHaveValue("big-1");
    expect(
      screen.getByRole("checkbox", { name: "Opus 声明支持 1M" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Sonnet 声明支持 1M" }),
    ).not.toBeChecked();
    // A tier with no model of its own has nothing to declare.
    expect(
      screen.getByRole("checkbox", { name: "Fable 声明支持 1M" }),
    ).toBeDisabled();
    // Following the default model carries its declaration along.
    expect(field("Haiku 实际请求模型")).toHaveAttribute(
      "placeholder",
      "跟随默认模型（main-1 · 1M）",
    );
  });

  it("writes the [1M] suffix and keeps it while the ID is retyped", () => {
    const { draft } = setup("claude", oneM);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sonnet 声明支持 1M" }),
    );
    expect(draft().claudeTiers.sonnet.model).toBe("mid-1[1M]");
    fireEvent.click(screen.getByRole("checkbox", { name: "Opus 声明支持 1M" }));
    expect(draft().claudeTiers.opus.model).toBe("big-1");
    fireEvent.change(field("默认模型（可选）"), {
      target: { value: "main-2" },
    });
    expect(draft().model).toBe("main-2[1M]");
    expect(field("默认模型（可选）")).toHaveValue("main-2");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "子代理 声明支持 1M" }),
    );
    expect(draft().subagentModel).toBe("");
  });

  it("marks the stored model as current in the picker without its suffix", () => {
    render(
      <CodexModelPicker
        models={[
          { id: "big-1", ownedBy: null },
          { id: "big-2", ownedBy: null },
        ]}
        defaultModel={claudeModelValue(
          toolProviderFields("claude", oneM),
          "opus",
        )}
        target="Opus 模型"
        refetching={false}
        onPick={vi.fn()}
        onRefetch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^big-1/ })).toHaveTextContent(
      "当前",
    );
    expect(
      screen.getByRole("button", { name: /^big-2/ }),
    ).not.toHaveTextContent("当前");
  });

  it("warns once when the default model and some tiers are empty", () => {
    setup("claude", {
      id: "bare",
      name: "Bare",
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: "https://relay.example",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "mid-1",
        },
      },
    });
    const notices = screen.getAllByText(/未设置，也没有默认模型/);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toHaveTextContent(
      "Opus、Fable、Haiku 未设置，也没有默认模型",
    );
  });

  it("does not warn while a default model fills the empty tiers", () => {
    setup("claude");
    expect(screen.queryByText(/未设置，也没有默认模型/)).toBeNull();
  });
});

describe("active-line notice", () => {
  it.each([
    ["codex", "保存后立即写入 Codex 的配置"],
    ["claude", "保存后立即写入 Claude Code 的配置"],
    ["opencode", "这条线路已启用。保存后立即写入 OpenCode 的配置"],
  ] as const)("names what saving %s's line in use writes", (appId, text) => {
    setup(appId, line, { inUse: true });
    expect(screen.getByRole("note")).toHaveTextContent(text);
  });

  it("stays away from a line that is not in use", () => {
    setup("claude", line, { inUse: false });
    expect(screen.queryByRole("note")).toBeNull();
  });
});
