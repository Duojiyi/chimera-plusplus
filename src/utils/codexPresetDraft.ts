// Turns the bundled Codex vendor presets into what the new-line page needs:
// a searchable list of starting points and, for the one the user picks, the
// fields to seed an editor draft with. Pure data work, no React.
import {
  codexProviderPresets,
  type CodexProviderPreset,
} from "@/config/codexProviderPresets";
import { getCodexCustomTemplate } from "@/config/codexTemplates";
import type {
  CodexApiFormatSelection,
  CodexCatalogModel,
  CodexChatReasoning,
  PromptCacheRoutingMode,
} from "@/types";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
} from "@/utils/providerConfigUtils";

/** Where a preset comes from, in the words a user would use. */
export type PresetGroup = "vendor" | "aggregator" | "relay";
export type PresetFilter = "all" | PresetGroup;

export const PRESET_GROUP_LABELS: Record<PresetGroup, string> = {
  vendor: "厂商官方",
  aggregator: "聚合平台",
  relay: "第三方",
};

export const PRESET_FILTERS: ReadonlyArray<{
  id: PresetFilter;
  label: string;
}> = [
  { id: "all", label: "全部" },
  { id: "vendor", label: PRESET_GROUP_LABELS.vendor },
  { id: "aggregator", label: PRESET_GROUP_LABELS.aggregator },
  { id: "relay", label: PRESET_GROUP_LABELS.relay },
];

const GROUP_ORDER: Record<PresetGroup, number> = {
  vendor: 0,
  aggregator: 1,
  relay: 2,
};

export interface PresetEntry {
  /** The preset's name; unique among startable presets. */
  id: string;
  preset: CodexProviderPreset;
  group: PresetGroup;
  /** The product's own template, always listed first. */
  builtin: boolean;
  /** Host of the request address, e.g. `api.moonshot.cn`; empty if unreadable. */
  host: string;
  baseUrl: string;
  model: string;
  /** Lower-cased text the search box matches against. */
  searchText: string;
}

/** Fields an editor draft is seeded with when a preset is picked. */
export interface PresetDraftSeed {
  name: string;
  websiteUrl: string;
  baseUrl: string;
  /** Always empty: a preset never carries a key. */
  apiKey: string;
  model: string;
  config: string;
  auth: Record<string, unknown>;
  apiFormat: CodexApiFormatSelection;
  catalogModels: CodexCatalogModel[];
  codexChatReasoning: CodexChatReasoning;
  promptCacheRouting: PromptCacheRoutingMode;
}

/** What the editor needs to remember about the starting point it applied. */
export interface PresetSelection {
  seed: PresetDraftSeed;
  /** Display name shown in the "starting point" row. */
  label: string;
  /** One line telling the user what is left to fill in. */
  hint: string;
  /** Where the user can get an API key, when the vendor has such a page. */
  apiKeyUrl?: string;
  /** A placeholder left in the request address, e.g. `YOUR_RESOURCE_NAME`. */
  endpointPlaceholder: string | null;
}

const PLACEHOLDER_IN_URL = /YOUR_[A-Z0-9_]+|<[^<>/\s]+>|\{[^{}\s]+\}/;

/** First unfilled placeholder in a request address, e.g. `YOUR_RESOURCE_NAME`. */
export function endpointPlaceholder(baseUrl: string): string | null {
  return PLACEHOLDER_IN_URL.exec(baseUrl)?.[0] ?? null;
}

function groupOf(preset: CodexProviderPreset): PresetGroup {
  if (preset.category === "cn_official" || preset.category === "official") {
    return "vendor";
  }
  if (preset.category === "aggregator") return "aggregator";
  return "relay";
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/**
 * Presets that can start a new API-key line. Account-login presets (OpenAI's
 * own sign-in, Grok's OAuth) have nothing to seed, and an empty config is the
 * login flow rather than an endpoint.
 */
export function isStartablePreset(preset: CodexProviderPreset): boolean {
  if (preset.requiresOAuth || preset.providerType) return false;
  return preset.config.trim() !== "";
}

function toEntry(preset: CodexProviderPreset): PresetEntry {
  const baseUrl = extractCodexBaseUrl(preset.config) ?? "";
  const model = extractCodexModelName(preset.config) ?? "";
  const group = groupOf(preset);
  const catalog = (preset.modelCatalog ?? []).flatMap((row) => [
    row.model,
    row.displayName ?? "",
  ]);
  return {
    id: preset.name,
    preset,
    group,
    builtin: preset.isBuiltinTemplate === true,
    host: hostOf(baseUrl),
    baseUrl,
    model,
    searchText: [
      preset.name,
      PRESET_GROUP_LABELS[group],
      baseUrl,
      model,
      ...catalog,
    ]
      .join(" ")
      .toLowerCase(),
  };
}

const collator = new Intl.Collator("zh-Hans-CN", { sensitivity: "base" });

/** Startable presets: the built-in one first, then by group, then by name. */
export function startablePresets(
  source: readonly CodexProviderPreset[] = codexProviderPresets.filter(
    (preset) => preset.isBuiltinTemplate,
  ),
): PresetEntry[] {
  return source
    .filter(isStartablePreset)
    .map(toEntry)
    .sort(
      (a, b) =>
        Number(b.builtin) - Number(a.builtin) ||
        GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
        collator.compare(a.preset.name, b.preset.name),
    );
}

function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Entries of `filter` whose name, address, models or group contain every word
 * of `query`. With a query, name matches rank ahead of address/model matches;
 * ties keep the list order.
 */
export function filterPresets(
  entries: readonly PresetEntry[],
  query: string,
  filter: PresetFilter = "all",
): PresetEntry[] {
  const words = tokens(query);
  const matches = entries.filter(
    (entry) =>
      (filter === "all" || entry.group === filter) &&
      words.every((word) => entry.searchText.includes(word)),
  );
  if (!words.length) return matches;
  const rank = (entry: PresetEntry): number => {
    const name = entry.preset.name.toLowerCase();
    if (name.startsWith(words[0])) return 0;
    return words.every((word) => name.includes(word)) ? 1 : 2;
  };
  return matches
    .map((entry, index) => ({ entry, index, rank: rank(entry) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ entry }) => entry);
}

/** How many entries each filter tab would show for the current query. */
export function countByFilter(
  entries: readonly PresetEntry[],
  query: string,
): Record<PresetFilter, number> {
  const counts: Record<PresetFilter, number> = {
    all: 0,
    vendor: 0,
    aggregator: 0,
    relay: 0,
  };
  for (const entry of filterPresets(entries, query, "all")) {
    counts.all += 1;
    counts[entry.group] += 1;
  }
  return counts;
}

function copyCatalog(rows: readonly CodexCatalogModel[]): CodexCatalogModel[] {
  return rows.map((row) => {
    const copy: CodexCatalogModel = { ...row };
    if (row.inputModalities) copy.inputModalities = [...row.inputModalities];
    if (row.reasoningLevels) copy.reasoningLevels = [...row.reasoningLevels];
    return copy;
  });
}

/** The editor seed for a preset. Nothing in it aliases the preset itself. */
export function presetDraftSeed(preset: CodexProviderPreset): PresetDraftSeed {
  return {
    name: preset.name,
    websiteUrl: preset.websiteUrl,
    baseUrl: extractCodexBaseUrl(preset.config) ?? "",
    apiKey: "",
    model: extractCodexModelName(preset.config) ?? "",
    config: preset.config,
    auth: { ...preset.auth, OPENAI_API_KEY: "" },
    // A preset that names its protocol is applied as written; the others stay
    // on automatic selection.
    apiFormat: preset.apiFormat ?? "auto",
    catalogModels: copyCatalog(preset.modelCatalog ?? []),
    codexChatReasoning: { ...preset.codexChatReasoning },
    promptCacheRouting: preset.promptCacheRouting ?? "auto",
  };
}

export function selectPreset(preset: CodexProviderPreset): PresetSelection {
  const seed = presetDraftSeed(preset);
  const placeholder = endpointPlaceholder(seed.baseUrl);
  return {
    seed,
    label: preset.name,
    hint: placeholder
      ? `请把地址里的 ${placeholder} 换成你自己的内容，再填写 API Key。`
      : "已填好地址、模型和协议，只差你的 API Key。",
    apiKeyUrl: preset.apiKeyUrl,
    endpointPlaceholder: placeholder,
  };
}

export const BLANK_LINE_LABEL = "自定义线路";

/** A blank custom line: the user types the address and model themselves. */
export function blankSelection(): PresetSelection {
  const template = getCodexCustomTemplate();
  return {
    seed: {
      name: BLANK_LINE_LABEL,
      websiteUrl: "",
      baseUrl: "",
      apiKey: "",
      model: extractCodexModelName(template.config) ?? "",
      config: template.config,
      auth: { ...template.auth, OPENAI_API_KEY: "" },
      apiFormat: "auto",
      catalogModels: [],
      codexChatReasoning: {},
      promptCacheRouting: "auto",
    },
    label: BLANK_LINE_LABEL,
    hint: "请填写请求地址、模型和 API Key。",
    endpointPlaceholder: null,
  };
}
