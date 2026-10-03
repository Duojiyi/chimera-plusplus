import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import {
  toolProviderFields,
  toolProviderSummary,
  updateToolProviderConfig,
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
  [
    "openclaw",
    { baseUrl: "https://claw.test", models: [{ id: "claw-model" }] },
    "https://claw.test",
    "claw-model",
  ],
  [
    "hermes",
    { base_url: "https://hermes.test", models: [{ id: "hermes-model" }] },
    "https://hermes.test",
    "hermes-model",
  ],
  [
    "mcode",
    { options: { baseURL: "https://mini.test" }, models: { mini: {} } },
    "https://mini.test",
    "mini",
  ],
] as const)(
  "reads %s using its native summary shape",
  (appId, settingsConfig, baseUrl, model) => {
    expect(
      toolProviderSummary(appId, { id: "p", name: "P", settingsConfig }),
    ).toMatchObject({ baseUrl, model });
  },
);
