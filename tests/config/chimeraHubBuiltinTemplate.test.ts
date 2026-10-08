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
import { grokBuildProviderPresets } from "@/config/grokBuildProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { getChimeraHubTemplate } from "@/config/codexTemplates";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";

import { chimeraHubTemplateFixture } from "../msw/handlers";

const CHIMERAHUB_V1 = "https://api.chimerahub.org/v1";
const t = ((key: string) => key) as TFunction;

describe("built-in ChimeraHub template (backend-owned)", () => {
  it("serves the backend template to the frontend wrapper", () => {
    // tests/setupTests.ts loads it from `get_chimerahub_template` like main.tsx.
    const draft = getChimeraHubTemplate();
    expect(draft).toEqual({
      ...chimeraHubTemplateFixture,
      config: draft.config,
    });
    expect(parseToml(draft.config).model).toBe("gpt-6-astra");
    expect(draft.model).toBe("gpt-5.6-sol");
    expect(parseToml(chimeraHubTemplateFixture.config).model).toBe(
      "gpt-5.6-sol",
    );
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
    expect(config.model).toBe("gpt-6-astra");
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

  it("uses the Responses adapter for Desktop and Grok instead of inventing native endpoints", () => {
    const desktop = claudeDesktopProviderPresets.find(
      (p) => p.isBuiltinTemplate,
    )!;
    expect(desktop).toMatchObject({
      name: "ChimeraHub",
      baseUrl: CHIMERAHUB_V1,
      mode: "proxy",
      apiFormat: "openai_responses",
    });
    expect(desktop.modelRoutes?.[0].upstreamModel).toBe("gpt-5.6-sol");
    const grok = grokBuildProviderPresets.find((p) => p.isBuiltinTemplate)!;
    expect(grok.apiFormat).toBe("openai_responses");
    expect(parseToml(grok.config)).toMatchObject({ model: "gpt-5.6-sol" });
  });

  it("offers no Anthropic or Gemini ChimeraHub preset (endpoints unverified)", () => {
    for (const presets of [providerPresets, geminiProviderPresets] as {
      name: string;
    }[][]) {
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
