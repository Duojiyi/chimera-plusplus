import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { parse as parseToml } from "smol-toml";
import { providerBalanceNotice } from "@/ChimeraApp";
import {
  PresetSortMode,
  sortPresetEntries,
  type PresetEntry,
} from "@/components/providers/forms/ProviderPresetSelector";
import { providerPresets } from "@/config/claudeProviderPresets";
import { claudeDesktopProviderPresets } from "@/config/claudeDesktopProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { getChimeraHubTemplate } from "@/config/codexTemplates";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";
import { hermesProviderPresets } from "@/config/hermesProviderPresets";
import { openclawProviderPresets } from "@/config/openclawProviderPresets";
import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";
import { chimeraHubTemplateFixture } from "../msw/handlers";

const CHIMERAHUB_V1 = "https://api.chimerahub.org/v1";
const t = ((key: string) => key) as TFunction;

describe("built-in ChimeraHub template (backend-owned)", () => {
  it("serves the backend template to the frontend wrapper", () => {
    // tests/setupTests.ts loads it from `get_chimerahub_template` like main.tsx.
    expect(getChimeraHubTemplate()).toEqual(chimeraHubTemplateFixture);
  });

  it("hands out copies, so an editor draft cannot change the template", () => {
    const draft = getChimeraHubTemplate();
    draft.auth.OPENAI_API_KEY = "sk-user";
    expect(getChimeraHubTemplate().auth).toEqual({ OPENAI_API_KEY: "" });
  });

  it("is an empty editable draft until the backend template is loaded", async () => {
    vi.resetModules();
    const fresh = await import("@/config/codexTemplates");
    expect(fresh.getChimeraHubTemplate()).toEqual({
      name: "",
      websiteUrl: "",
      baseUrl: "",
      model: "",
      auth: { OPENAI_API_KEY: "" },
      config: "",
    });
  });

  it("is the first Codex preset, labelled built-in, on the Responses protocol", () => {
    const [first] = codexProviderPresets;
    expect(first.isBuiltinTemplate).toBe(true);
    expect(first.name).toBe("ChimeraHub");
    expect(first.websiteUrl).toBe("https://api.chimerahub.org/");
    expect(first.isPartner).toBeUndefined();
    expect(first.auth).toEqual({ OPENAI_API_KEY: "" });
    expect(first.apiFormat).toBe("openai_responses");
    const config = parseToml(first.config) as {
      model?: string;
      model_providers?: { custom?: Record<string, unknown> };
    };
    expect(config.model).toBe("gpt-5.6-sol");
    expect(config.model_providers?.custom).toMatchObject({
      base_url: CHIMERAHUB_V1,
      wire_api: "responses",
    });
    // Spreading a preset (as the forms do) keeps every field.
    expect({ ...first }).toMatchObject({
      name: "ChimeraHub",
      config: first.config,
    });
    // Stable identities between reads, like a plain preset object.
    expect(first.auth).toBe(first.auth);
    expect(
      codexProviderPresets.filter((preset) => preset.isBuiltinTemplate),
    ).toHaveLength(1);
  });

  it("stays first in the preset selector in both sort modes", () => {
    const entries: PresetEntry[] = codexProviderPresets.map(
      (preset, index) => ({
        id: `codex-${index}`,
        preset,
      }),
    );
    for (const mode of [PresetSortMode.Original, PresetSortMode.NameAsc]) {
      expect(sortPresetEntries(entries, mode, t)[0].id).toBe("codex-0");
    }
  });

  it("adds OpenAI-compatible /v1 presets for OpenCode, OpenClaw and Hermes", () => {
    const opencode = opencodeProviderPresets.find(
      (p) => p.name === "ChimeraHub",
    );
    expect(opencode?.settingsConfig).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: CHIMERAHUB_V1, apiKey: "" },
      models: { "gpt-5.6-sol": { name: "GPT-5.6 Sol" } },
    });

    const openclaw = openclawProviderPresets.find(
      (p) => p.name === "ChimeraHub",
    );
    expect(openclaw?.settingsConfig).toMatchObject({
      baseUrl: CHIMERAHUB_V1,
      apiKey: "",
      api: "openai-completions",
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
    });
    expect(openclaw?.suggestedDefaults?.model).toEqual({
      primary: "chimerahub/gpt-5.6-sol",
    });

    const hermes = hermesProviderPresets.find((p) => p.name === "ChimeraHub");
    expect(hermes?.settingsConfig).toMatchObject({
      name: "chimerahub",
      base_url: CHIMERAHUB_V1,
      api_key: "",
      api_mode: "chat_completions",
    });
    expect(hermes?.suggestedDefaults?.model).toEqual({
      default: "gpt-5.6-sol",
      provider: "chimerahub",
    });

    // Not a default template elsewhere: only the Codex entry is pinned/labelled.
    for (const preset of [opencode, openclaw, hermes]) {
      expect(preset).toBeDefined();
      expect(preset).not.toHaveProperty("isBuiltinTemplate");
    }
  });

  it("offers no Anthropic or Gemini ChimeraHub preset (endpoints unverified)", () => {
    for (const presets of [
      providerPresets,
      claudeDesktopProviderPresets,
      geminiProviderPresets,
    ] as { name: string }[][]) {
      expect(presets.some((preset) => /chimera/i.test(preset.name))).toBe(
        false,
      );
    }
  });
});

describe("providerBalanceNotice", () => {
  it("asks for the endpoint and key when either is missing", () => {
    const hint = "填写请求地址和 API Key 后可查询余额";
    expect(providerBalanceNotice(false, undefined)).toBe(hint);
    expect(
      providerBalanceNotice(true, {
        success: false,
        status: "missing_credentials",
      }),
    ).toBe(hint);
  });

  it("uses a neutral hint for endpoints without a known balance API", () => {
    const notice = providerBalanceNotice(true, {
      success: false,
      status: "unsupported",
    });
    expect(notice).toBe("此线路暂不支持余额查询");
    expect(notice).not.toContain("中转");
  });

  it("ignores message text and shows real results and failures", () => {
    // The old UI matched these backend strings; they no longer mean anything.
    expect(
      providerBalanceNotice(true, {
        success: false,
        error: "Unknown balance provider",
      }),
    ).toBeNull();
    expect(
      providerBalanceNotice(true, {
        success: true,
        data: [{ remaining: 12, unit: "点" }],
      }),
    ).toBeNull();
    expect(providerBalanceNotice(true, undefined)).toBeNull();
  });
});
