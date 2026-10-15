import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderEditor, providerDraft } from "@/ChimeraApp";
import type { Provider } from "@/types";

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

function setup(appId: "claude" | "gemini", provider: Provider | null = line) {
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

  it("keeps other tools to a typed model ID", () => {
    setup("gemini", null);
    expect(
      screen.queryByRole("button", { name: /获取模型/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("模型映射")).not.toBeInTheDocument();
  });
});
