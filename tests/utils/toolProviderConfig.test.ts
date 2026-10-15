import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import {
  claudeModelFieldLabel,
  claudeModelValue,
  toolProviderFields,
  toolProviderSummary,
  updateToolProviderConfig,
  withClaudeModel,
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
