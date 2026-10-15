import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import {
  claudeModelFieldLabel,
  claudeModelOneM,
  claudeModelValue,
  toolProviderFields,
  toolProviderSummary,
  updateToolProviderConfig,
  withClaudeModel,
  withClaudeOneM,
  type NativeToolAppId,
} from "@/utils/toolProviderConfig";

const cases: [NativeToolAppId, Record<string, unknown>][] = [
  [
    "claude",
    {
      env: {
        ANTHROPIC_BASE_URL: "https://old.example",
        ANTHROPIC_AUTH_TOKEN: "old-key",
        ANTHROPIC_API_KEY: "stale-key",
        ANTHROPIC_MODEL: "old-model",
        KEEP: "yes",
      },
      permissions: { allow: ["Read"] },
    },
  ],
  [
    "gemini",
    {
      env: {
        GOOGLE_GEMINI_BASE_URL: "https://old.example",
        GEMINI_API_KEY: "old-key",
        GEMINI_MODEL: "old-model",
        KEEP: "yes",
      },
      config: { theme: "Default", security: { trustedFolders: true } },
    },
  ],
  [
    "opencode",
    {
      npm: "@ai-sdk/anthropic",
      options: {
        baseURL: "https://old.example",
        apiKey: "old-key",
        timeout: 123,
      },
      models: {
        "old-model": { limit: { context: 123 } },
        other: { name: "Keep" },
      },
    },
  ],
  [
    "pi",
    {
      baseUrl: "https://old.example",
      apiKey: "old-key",
      api: "anthropic-messages",
      headers: { Custom: "keep" },
      models: [
        { id: "old-model", contextWindow: 123 },
        { id: "other", name: "Keep" },
      ],
    },
  ],
];

describe("native tool provider configuration", () => {
  it.each(cases)(
    "round-trips %s without Codex fields or loss of native settings",
    (appId, settingsConfig) => {
      const provider: Provider = {
        id: "same-id",
        name: "Native",
        settingsConfig,
      };
      const before = structuredClone(provider);
      const fields = toolProviderFields(appId, provider);
      expect(fields).toMatchObject({
        baseUrl: "https://old.example",
        apiKey: "old-key",
        model: "old-model",
      });
      const saved = updateToolProviderConfig(appId, provider, {
        ...fields,
        baseUrl: " https://new.example/custom ",
        apiKey: " new-key ",
        model: " new-model ",
      });
      expect(
        toolProviderFields(appId, { ...provider, settingsConfig: saved }),
      ).toMatchObject({
        baseUrl: "https://new.example/custom",
        apiKey: "new-key",
        model: "new-model",
      });
      expect(saved).not.toHaveProperty("auth");
      expect(saved).not.toHaveProperty("modelCatalog");
      expect(provider).toEqual(before);
      if (appId === "claude") {
        expect(saved).toMatchObject({
          env: { KEEP: "yes" },
          permissions: settingsConfig.permissions,
        });
        expect(saved.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      } else if (appId === "gemini") {
        expect(saved.config).toEqual(settingsConfig.config);
        expect(saved.env).toHaveProperty("KEEP", "yes");
      } else if (appId === "opencode") {
        expect(saved).toMatchObject({
          options: { timeout: 123 },
          models: {
            "new-model": { limit: { context: 123 } },
            other: { name: "Keep" },
          },
        });
        expect(saved.models).not.toHaveProperty("old-model");
      } else {
        expect(saved).toMatchObject({
          headers: { Custom: "keep" },
          models: [
            { id: "new-model", contextWindow: 123 },
            { id: "other", name: "Keep" },
          ],
        });
      }
    },
  );

  it("keeps optional Claude/Gemini auth and model fields absent instead of adding Codex defaults", () => {
    for (const appId of ["claude", "gemini"] as const) {
      const fields = toolProviderFields(appId);
      expect(fields).toMatchObject({ apiKey: "", model: "", baseUrl: "" });
      const saved = updateToolProviderConfig(appId, null, {
        ...fields,
        baseUrl: "https://local.example",
      });
      expect(saved).toEqual({
        env:
          appId === "claude"
            ? { ANTHROPIC_BASE_URL: "https://local.example" }
            : { GOOGLE_GEMINI_BASE_URL: "https://local.example" },
      });
    }
  });

  it("can change Claude authentication without keeping a competing credential", () => {
    const provider: Provider = {
      id: "x",
      name: "x",
      settingsConfig: cases[0][1],
    };
    const saved = updateToolProviderConfig("claude", provider, {
      ...toolProviderFields("claude", provider),
      apiKey: "new-api-key",
      anthropicAuthField: "ANTHROPIC_API_KEY",
    });
    expect(saved.env).toHaveProperty("ANTHROPIC_API_KEY", "new-api-key");
    expect(saved.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("updates Pi model-specific endpoint/protocol overrides without changing other models", () => {
    const provider: Provider = {
      id: "pi",
      name: "Pi",
      settingsConfig: {
        baseUrl: "https://provider.example",
        api: "openai-completions",
        models: [
          {
            id: "first",
            baseUrl: "https://first.example",
            api: "anthropic-messages",
          },
          { id: "second", baseUrl: "https://second.example" },
        ],
      },
    };
    const fields = toolProviderFields("pi", provider);
    expect(fields).toMatchObject({
      baseUrl: "https://first.example",
      nativeProtocol: "anthropic-messages",
    });
    const saved = updateToolProviderConfig("pi", provider, {
      ...fields,
      baseUrl: "https://changed.example",
      nativeProtocol: "openai-responses",
    });
    expect(saved.models).toEqual([
      {
        id: "first",
        baseUrl: "https://changed.example",
        api: "openai-responses",
      },
      { id: "second", baseUrl: "https://second.example" },
    ]);
  });
});

it.each([
  [
    "claude-desktop",
    { env: { ANTHROPIC_BASE_URL: "https://desktop.test" } },
    "https://desktop.test",
    "",
  ],
] as const)(
  "reads %s using its native summary shape",
  (appId, settingsConfig, baseUrl, model) => {
    expect(
      toolProviderSummary(appId, { id: "p", name: "P", settingsConfig }),
    ).toMatchObject({ baseUrl, model });
  },
);

describe("Claude Code model tiers", () => {
  const provider: Provider = {
    id: "tiers",
    name: "Tiers",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://relay.example",
        ANTHROPIC_AUTH_TOKEN: "relay-key",
        ANTHROPIC_MODEL: "main-1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "small-1",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "mid-1",
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Mid",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "big-1[1M]",
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Big",
        ANTHROPIC_SMALL_FAST_MODEL: "legacy-small",
        CLAUDE_CODE_SUBAGENT_MODEL: "agent-1",
      },
    },
  };

  it("reads what earlier versions saved and writes it back", () => {
    const fields = toolProviderFields("claude", provider);
    expect(fields.claudeTiers).toEqual({
      haiku: { model: "small-1", name: "" },
      sonnet: { model: "mid-1", name: "Mid" },
      opus: { model: "big-1[1M]", name: "Big" },
      fable: { model: "", name: "" },
    });
    expect(fields.subagentModel).toBe("agent-1");
    // Only the legacy small/fast key goes: the Haiku row replaces it.
    const { ANTHROPIC_SMALL_FAST_MODEL: _legacy, ...rest } = (
      provider.settingsConfig as { env: Record<string, string> }
    ).env;
    expect(updateToolProviderConfig("claude", provider, fields)).toEqual({
      env: rest,
    });
  });

  it("sets, clears and names tiers without touching other keys", () => {
    const fields = toolProviderFields("claude", provider);
    const saved = updateToolProviderConfig("claude", provider, {
      ...fields,
      claudeTiers: {
        haiku: { model: "small-1", name: " Small " },
        sonnet: fields.claudeTiers.sonnet,
        // Clearing a model drops its menu name too.
        opus: { model: " ", name: "Big" },
        fable: { model: " top-1 ", name: "Top" },
      },
      subagentModel: "",
    });
    expect(saved.env).toEqual({
      ANTHROPIC_BASE_URL: "https://relay.example",
      ANTHROPIC_AUTH_TOKEN: "relay-key",
      ANTHROPIC_MODEL: "main-1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "small-1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "Small",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "mid-1",
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Mid",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "top-1",
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "Top",
    });
  });

  it("shows tiers stored as the default model as following it", () => {
    // How the backend stores an empty Haiku, Sonnet or Opus tier
    // (normalize_claude_models_in_value) after every save.
    const filled: Provider = {
      id: "filled",
      name: "Filled",
      settingsConfig: {
        env: {
          ANTHROPIC_MODEL: "glm-4.6",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-4.6",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-4.6",
          ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "GLM",
          ANTHROPIC_DEFAULT_FABLE_MODEL: "glm-4.6",
        },
      },
    };
    const fields = toolProviderFields("claude", filled);
    expect(fields.claudeTiers).toEqual({
      haiku: { model: "glm-4.5-air", name: "" },
      sonnet: { model: "", name: "" },
      // A menu name makes it a deliberate mapping; Fable is never filled.
      opus: { model: "glm-4.6", name: "GLM" },
      fable: { model: "glm-4.6", name: "" },
    });
    // Saved empty, Sonnet is filled with the new default by the backend.
    const saved = updateToolProviderConfig("claude", filled, {
      ...fields,
      model: "glm-4.7",
    }) as { env: Record<string, string> };
    expect(saved.env).not.toHaveProperty("ANTHROPIC_DEFAULT_SONNET_MODEL");
    expect(saved.env.ANTHROPIC_MODEL).toBe("glm-4.7");
  });

  it("shows a legacy small/fast model in the Haiku row", () => {
    const fields = toolProviderFields("claude", {
      id: "legacy",
      name: "Legacy",
      settingsConfig: {
        env: {
          ANTHROPIC_MODEL: "main-1",
          ANTHROPIC_SMALL_FAST_MODEL: "small-legacy",
        },
      },
    });
    expect(fields.claudeTiers.haiku.model).toBe("small-legacy");
  });

  it("fills one model field from the model list", () => {
    const fields = toolProviderFields("claude");
    const next = withClaudeModel(fields, "opus", "big-2");
    expect(claudeModelValue(next, "opus")).toBe("big-2");
    expect(next.claudeTiers.sonnet).toEqual(fields.claudeTiers.sonnet);
    expect(fields.claudeTiers.opus.model).toBe("");
    expect(withClaudeModel(fields, "default", "main-2").model).toBe("main-2");
    expect(withClaudeModel(fields, "subagent", "agent-2").subagentModel).toBe(
      "agent-2",
    );
    expect(claudeModelFieldLabel("opus")).toBe("Opus 模型");
    expect(claudeModelFieldLabel("subagent")).toBe("子代理模型");
  });
});

describe("Claude Code 1M declaration ([1M] suffix)", () => {
  const env = {
    ANTHROPIC_BASE_URL: "https://relay.example",
    ANTHROPIC_AUTH_TOKEN: "relay-key",
    ANTHROPIC_MODEL: "main-1[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "mid-1 [1M]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "big-1",
    CLAUDE_CODE_SUBAGENT_MODEL: "agent-1[1M]",
  };
  const provider: Provider = {
    id: "one-m",
    name: "1M",
    settingsConfig: { env },
  };

  it("reads the suffix in any case as a declaration on the bare ID", () => {
    const fields = toolProviderFields("claude", provider);
    expect(claudeModelValue(fields, "default")).toBe("main-1");
    expect(claudeModelOneM(fields, "default")).toBe(true);
    expect(claudeModelValue(fields, "sonnet")).toBe("mid-1");
    expect(claudeModelOneM(fields, "sonnet")).toBe(true);
    expect(claudeModelValue(fields, "opus")).toBe("big-1");
    expect(claudeModelOneM(fields, "opus")).toBe(false);
    expect(claudeModelValue(fields, "subagent")).toBe("agent-1");
    expect(claudeModelOneM(fields, "subagent")).toBe(true);
    expect(claudeModelOneM(fields, "fable")).toBe(false);
  });

  it("saves an untouched line exactly as it was stored", () => {
    const fields = toolProviderFields("claude", provider);
    expect(updateToolProviderConfig("claude", provider, fields)).toEqual({
      env,
    });
  });

  it("writes [1M] when checked, drops only the suffix when cleared, and reads it back", () => {
    let fields = toolProviderFields("claude", provider);
    fields = withClaudeOneM(fields, "opus", true);
    fields = withClaudeOneM(fields, "sonnet", false);
    expect(fields.claudeTiers.opus.model).toBe("big-1[1M]");
    expect(fields.claudeTiers.sonnet.model).toBe("mid-1");
    const saved = updateToolProviderConfig("claude", provider, fields) as {
      env: Record<string, string>;
    };
    expect(saved.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("big-1[1M]");
    expect(saved.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("mid-1");
    const reread = toolProviderFields("claude", {
      ...provider,
      settingsConfig: saved,
    });
    expect(claudeModelValue(reread, "opus")).toBe("big-1");
    expect(claudeModelOneM(reread, "opus")).toBe(true);
    expect(claudeModelOneM(reread, "sonnet")).toBe(false);
  });

  it("keeps the declaration when the model is typed or picked again", () => {
    const fields = toolProviderFields("claude", provider);
    // The picker and the input hand over a bare ID.
    expect(withClaudeModel(fields, "default", "main-2").model).toBe(
      "main-2[1M]",
    );
    expect(
      withClaudeModel(fields, "opus", "big-2").claudeTiers.opus.model,
    ).toBe("big-2");
    // An ID typed with the suffix turns the declaration on.
    expect(
      withClaudeModel(fields, "opus", "big-2[1m]").claudeTiers.opus.model,
    ).toBe("big-2[1M]");
    // An empty field declares nothing.
    expect(withClaudeModel(fields, "default", "").model).toBe("");
    expect(withClaudeOneM(fields, "fable", true).claudeTiers.fable.model).toBe(
      "",
    );
  });

  it("shows a tier the backend filled from a 1M default as following it", () => {
    // normalize_claude_models_in_value copies ANTHROPIC_MODEL, suffix and all.
    const fields = toolProviderFields("claude", {
      id: "filled",
      name: "Filled",
      settingsConfig: {
        env: {
          ANTHROPIC_MODEL: "glm-5[1M]",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5[1M]",
        },
      },
    });
    expect(fields.claudeTiers.sonnet).toEqual({ model: "", name: "" });
    expect(claudeModelOneM(fields, "default")).toBe(true);
  });
});
