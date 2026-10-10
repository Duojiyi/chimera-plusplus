import { describe, expect, it } from "vitest";
import { type CodexProviderPreset } from "@/config/codexProviderPresets";
import {
  BLANK_LINE_LABEL,
  blankSelection,
  countByFilter,
  endpointPlaceholder,
  filterPresets,
  isStartablePreset,
  presetDraftSeed,
  selectPreset,
  startablePresets,
} from "@/utils/codexPresetDraft";

const config = (baseUrl: string, model = "m-1") =>
  [
    'model_provider = "custom"',
    `model = "${model}"`,
    "",
    "[model_providers.custom]",
    'name = "custom"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
  ].join("\n");

const preset = (
  name: string,
  extra: Partial<CodexProviderPreset> = {},
): CodexProviderPreset => ({
  name,
  websiteUrl: `https://${name.toLowerCase().replace(/\s+/g, "")}.example`,
  auth: { OPENAI_API_KEY: "" },
  config: config(
    `https://api.${name.toLowerCase().replace(/\s+/g, "")}.example/v1`,
  ),
  category: "third_party",
  ...extra,
});

const SOURCE: CodexProviderPreset[] = [
  preset("Zeta Relay"),
  preset("Kimi", {
    category: "cn_official",
    apiKeyUrl: "https://platform.kimi.example/keys",
    apiFormat: "openai_responses",
    modelCatalog: [
      {
        model: "kimi-k3",
        displayName: "Kimi K3",
        contextWindow: 1048576,
        reasoningLevels: ["low", "high"],
        inputModalities: ["text"],
      },
    ],
  }),
  preset("Alpha Hub", { category: "aggregator" }),
  preset("Home", {
    isBuiltinTemplate: true,
    category: "third_party",
  }),
  preset("OpenAI Official", {
    isOfficial: true,
    category: "official",
    auth: {},
    config: "",
  }),
  preset("Grok", {
    providerType: "xai_oauth",
    requiresOAuth: true,
  }),
  preset("DeepSeek", { category: "cn_official" }),
];

describe("isStartablePreset", () => {
  it("rejects sign-in presets and empty configs, keeps key-based ones", () => {
    const names = SOURCE.filter(isStartablePreset).map((p) => p.name);
    expect(names).toEqual([
      "Zeta Relay",
      "Kimi",
      "Alpha Hub",
      "Home",
      "DeepSeek",
    ]);
  });
});

describe("startablePresets", () => {
  it("lists the built-in template first, then groups, each sorted by name", () => {
    expect(startablePresets(SOURCE).map((e) => e.id)).toEqual([
      "Home",
      "DeepSeek",
      "Kimi",
      "Alpha Hub",
      "Zeta Relay",
    ]);
  });

  it("derives address, host and default model from the config", () => {
    const kimi = startablePresets(SOURCE).find((e) => e.id === "Kimi");
    expect(kimi).toMatchObject({
      baseUrl: "https://api.kimi.example/v1",
      host: "api.kimi.example",
      model: "m-1",
      group: "vendor",
      builtin: false,
    });
  });

  it("leaves the host empty when the address is not a URL", () => {
    const [entry] = startablePresets([
      preset("Broken", { config: config("not a url") }),
    ]);
    expect(entry.host).toBe("");
  });
});

describe("filterPresets", () => {
  const entries = startablePresets(SOURCE);

  it("returns every entry for an empty query on the all tab", () => {
    expect(filterPresets(entries, "  ", "all")).toHaveLength(5);
  });

  it("narrows to one group", () => {
    expect(filterPresets(entries, "", "vendor").map((e) => e.id)).toEqual([
      "DeepSeek",
      "Kimi",
    ]);
    expect(filterPresets(entries, "", "aggregator").map((e) => e.id)).toEqual([
      "Alpha Hub",
    ]);
  });

  it("matches case-insensitively and needs every word", () => {
    expect(filterPresets(entries, "KIMI").map((e) => e.id)).toEqual(["Kimi"]);
    expect(filterPresets(entries, "kimi k3").map((e) => e.id)).toEqual([
      "Kimi",
    ]);
    expect(filterPresets(entries, "kimi relay")).toEqual([]);
  });

  it("matches the address, the models and the group label", () => {
    expect(filterPresets(entries, "api.alpha").map((e) => e.id)).toEqual([
      "Alpha Hub",
    ]);
    expect(filterPresets(entries, "Kimi K3").map((e) => e.id)).toEqual([
      "Kimi",
    ]);
    expect(filterPresets(entries, "聚合").map((e) => e.id)).toEqual([
      "Alpha Hub",
    ]);
  });

  it("ranks name matches ahead of address matches, keeping list order for ties", () => {
    const list = startablePresets([
      preset("Relay Two", {
        config: config("https://api.deep.example/v1"),
      }),
      preset("Deep Gate"),
      preset("Relay One", {
        config: config("https://api.deep.example/v1"),
      }),
    ]);
    expect(filterPresets(list, "deep").map((e) => e.id)).toEqual([
      "Deep Gate",
      "Relay One",
      "Relay Two",
    ]);
  });
});

describe("countByFilter", () => {
  it("counts per tab for the current query", () => {
    const entries = startablePresets(SOURCE);
    expect(countByFilter(entries, "")).toEqual({
      all: 5,
      vendor: 2,
      aggregator: 1,
      relay: 2,
    });
    expect(countByFilter(entries, "kimi")).toEqual({
      all: 1,
      vendor: 1,
      aggregator: 0,
      relay: 0,
    });
  });
});

describe("presetDraftSeed", () => {
  const kimi = SOURCE.find((p) => p.name === "Kimi")!;

  it("seeds address, model, protocol and mapping rows without a key", () => {
    const seed = presetDraftSeed(kimi);
    expect(seed).toMatchObject({
      name: "Kimi",
      baseUrl: "https://api.kimi.example/v1",
      model: "m-1",
      apiKey: "",
      apiFormat: "openai_responses",
      promptCacheRouting: "auto",
    });
    expect(seed.auth).toEqual({ OPENAI_API_KEY: "" });
    expect(seed.catalogModels).toEqual([
      expect.objectContaining({
        model: "kimi-k3",
        displayName: "Kimi K3",
        contextWindow: 1048576,
      }),
    ]);
  });

  it("keeps automatic protocol selection when the preset names none", () => {
    expect(presetDraftSeed(preset("Plain")).apiFormat).toBe("auto");
  });

  it("never carries a key, even if a preset's auth held one", () => {
    const seed = presetDraftSeed(
      preset("Leaky", { auth: { OPENAI_API_KEY: "sk-leak" } }),
    );
    expect(seed.apiKey).toBe("");
    expect(seed.auth.OPENAI_API_KEY).toBe("");
  });

  it("does not alias the preset's catalog rows or auth", () => {
    const seed = presetDraftSeed(kimi);
    seed.catalogModels[0].displayName = "changed";
    seed.catalogModels[0].reasoningLevels!.push("max");
    seed.auth.extra = true;
    expect(kimi.modelCatalog![0].displayName).toBe("Kimi K3");
    expect(kimi.modelCatalog![0].reasoningLevels).toEqual(["low", "high"]);
    expect(kimi.auth).toEqual({ OPENAI_API_KEY: "" });
  });
});

describe("selectPreset", () => {
  it("carries the label and the key page for the starting-point row", () => {
    const selection = selectPreset(SOURCE.find((p) => p.name === "Kimi")!);
    expect(selection.label).toBe("Kimi");
    expect(selection.apiKeyUrl).toBe("https://platform.kimi.example/keys");
    expect(selection.endpointPlaceholder).toBeNull();
  });

  it("flags a placeholder left in the address", () => {
    const selection = selectPreset(
      preset("Azure", {
        config: config("https://YOUR_RESOURCE_NAME.openai.azure.com/openai"),
      }),
    );
    expect(selection.endpointPlaceholder).toBe("YOUR_RESOURCE_NAME");
  });
});

describe("endpointPlaceholder", () => {
  it.each([
    [
      "https://YOUR_RESOURCE_NAME.openai.azure.com/openai",
      "YOUR_RESOURCE_NAME",
    ],
    ["https://api.example.com/{tenant}/v1", "{tenant}"],
    ["https://<resource>.example.com/v1", "<resource>"],
    ["https://api.example.com/v1", null],
    ["", null],
  ])("%s -> %s", (url, expected) => {
    expect(endpointPlaceholder(url)).toBe(expected);
  });
});

describe("blankSelection", () => {
  it("starts an empty custom line with no address and no key", () => {
    const { seed, label, endpointPlaceholder: placeholder } = blankSelection();
    expect(label).toBe(BLANK_LINE_LABEL);
    expect(seed.name).toBe(BLANK_LINE_LABEL);
    expect(seed.baseUrl).toBe("");
    expect(seed.apiKey).toBe("");
    expect(seed.model).not.toBe("");
    expect(seed.config).toContain('model_provider = "custom"');
    expect(seed.apiFormat).toBe("auto");
    expect(seed.catalogModels).toEqual([]);
    expect(placeholder).toBeNull();
  });
});

describe("the bundled Codex presets", () => {
  const entries = startablePresets();

  it("only offers the Chimera template", () => {
    expect(entries.map((entry) => entry.id)).toEqual(["ChimeraHub"]);
  });

  it("gives every starting point a unique name", () => {
    const names = entries.map((e) => e.id);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every starting point an https address and a default model", () => {
    const broken = entries
      .filter((e) => !/^https:\/\//.test(e.baseUrl) || !e.model)
      .map((e) => e.id);
    expect(broken).toEqual([]);
  });

  it("never ships a key", () => {
    const withKey = entries
      .filter((e) => Object.values(e.preset.auth).some((v) => v !== ""))
      .map((e) => e.id);
    expect(withKey).toEqual([]);
  });

  it("only leaves a placeholder in the address where the user must fill one in", () => {
    const placeholders = entries
      .filter((e) => endpointPlaceholder(e.baseUrl))
      .map((e) => e.id);
    expect(placeholders).toEqual([]);
  });

  it("is a model catalog that stays inside its own list: the default model is mapped or built in", () => {
    // A mapped catalog must contain the model the config selects, otherwise the
    // picker would seed a default model the mapping table does not know.
    const orphaned = entries
      .filter(
        (e) =>
          e.preset.modelCatalog?.length &&
          !e.preset.modelCatalog.some((row) => row.model === e.model),
      )
      .map((e) => `${e.id}: ${e.model}`);
    expect(orphaned).toEqual([]);
  });
});
