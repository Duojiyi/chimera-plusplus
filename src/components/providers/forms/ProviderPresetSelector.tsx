import { useTranslation } from "react-i18next";
import type { ProviderPreset } from "@/config/claudeProviderPresets";
import type { CodexProviderPreset } from "@/config/codexProviderPresets";
import type { GeminiProviderPreset } from "@/config/geminiProviderPresets";
import type { ClaudeDesktopProviderPreset } from "@/config/claudeDesktopProviderPresets";
import type { OpenCodeProviderPreset } from "@/config/opencodeProviderPresets";

import type { ProviderCategory } from "@/types";
import type { UniversalProviderPreset } from "@/config/universalProviderPresets";

type PresetTranslator = (key: string) => unknown;

export const PresetSortMode = {
  Original: "original",
  NameAsc: "nameAsc",
} as const;

export type PresetSortMode =
  (typeof PresetSortMode)[keyof typeof PresetSortMode];

export type AnyPreset =
  | ProviderPreset
  | CodexProviderPreset
  | GeminiProviderPreset
  | ClaudeDesktopProviderPreset
  | OpenCodeProviderPreset;

export type PresetEntry = {
  id: string;
  preset: AnyPreset;
};

export function isBuiltinTemplate(preset: AnyPreset): boolean {
  return "isBuiltinTemplate" in preset && preset.isBuiltinTemplate === true;
}

export function getPresetDisplayName(
  preset: AnyPreset,
  t: PresetTranslator,
): string {
  return preset.nameKey ? String(t(preset.nameKey)) : preset.name;
}

export function getPresetSearchText(
  entry: PresetEntry,
  t: PresetTranslator,
): string {
  return [getPresetDisplayName(entry.preset, t), entry.preset.name]
    .join(" ")
    .toLowerCase();
}

export function filterPresetEntries(
  entries: PresetEntry[],
  query: string,
  t: PresetTranslator,
): PresetEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return entries;
  }

  return entries.filter((entry) =>
    getPresetSearchText(entry, t).includes(normalizedQuery),
  );
}

export function sortPresetEntries(
  entries: PresetEntry[],
  sortMode: PresetSortMode,
  t: PresetTranslator,
): PresetEntry[] {
  const byDisplayName = (a: PresetEntry, b: PresetEntry) =>
    getPresetDisplayName(a.preset, t).localeCompare(
      getPresetDisplayName(b.preset, t),
    );

  // The product's own built-in template (ChimeraHub) always leads the list.
  const builtin = entries.filter((entry) => isBuiltinTemplate(entry.preset));
  if (builtin.length > 0) {
    return [
      ...builtin,
      ...sortPresetEntries(
        entries.filter((entry) => !isBuiltinTemplate(entry.preset)),
        sortMode,
        t,
      ),
    ];
  }

  if (sortMode === PresetSortMode.Original) {
    // 置顶优先级：官方分类 > 尊享合作伙伴（Kimi）> 其余赞助商 > 非赞助商。
    // 前三组用分区拼接而非排序，保持各自在预设文件里的相对顺序
    // （赞助商的文件顺序与 README 赞助商表对齐）；非赞助商按显示名排序。
    // 排他条件保证同时命中多组的预设只归入最前面的组、不被重复。
    const official = entries.filter(
      (entry) => entry.preset.category === "official",
    );
    const prime = entries.filter(
      (entry) =>
        entry.preset.category !== "official" && entry.preset.primePartner,
    );
    const partner = entries.filter(
      (entry) =>
        entry.preset.category !== "official" &&
        !entry.preset.primePartner &&
        entry.preset.isPartner,
    );
    const rest = entries
      .filter(
        (entry) =>
          entry.preset.category !== "official" &&
          !entry.preset.primePartner &&
          !entry.preset.isPartner,
      )
      .sort(byDisplayName);
    return [...official, ...prime, ...partner, ...rest];
  }

  return [...entries].sort(byDisplayName);
}

export interface PresetVisibilityOptions {
  query: string;
  sortMode: PresetSortMode;
  t: PresetTranslator;
}

export function getVisiblePresetEntries(
  entries: PresetEntry[],
  options: PresetVisibilityOptions,
): PresetEntry[] {
  const { query, sortMode, t } = options;

  return sortPresetEntries(filterPresetEntries(entries, query, t), sortMode, t);
}

interface ProviderPresetSelectorProps {
  selectedPresetId: string | null;
  presetEntries: PresetEntry[];
  presetCategoryLabels: Record<string, string>;
  onPresetChange: (value: string) => void;
  onUniversalPresetSelect?: (preset: UniversalProviderPreset) => void;
  onManageUniversalProviders?: () => void;
  category?: ProviderCategory; // 当前选中的分类
}

export function ProviderPresetSelector({
  selectedPresetId,
  presetEntries,
  onPresetChange,
  onManageUniversalProviders,
}: Readonly<ProviderPresetSelectorProps>) {
  const { t } = useTranslation();
  // Keep legacy helpers available, but never render the provider catalog.
  const visiblePresetEntries = presetEntries.filter(
    ({ preset }) => preset.category === "official" || isBuiltinTemplate(preset),
  );
  const choices = [
    { id: "custom", name: t("providerPreset.custom") },
    ...visiblePresetEntries.map(({ id, preset }) => ({
      id,
      name: getPresetDisplayName(preset, t) || "中转站模板",
    })),
  ];

  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-medium">
        {t("providerPreset.label")}
      </legend>
      <div className="flex flex-wrap gap-2">
        {choices.map(({ id, name }) => (
          <button
            key={id}
            type="button"
            aria-pressed={selectedPresetId === id}
            onClick={() => onPresetChange(id)}
            className={`max-w-full whitespace-normal break-words rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              selectedPresetId === id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground hover:bg-accent"
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      {onManageUniversalProviders && (
        <button
          type="button"
          onClick={onManageUniversalProviders}
          className="max-w-full whitespace-normal break-words rounded-md px-2 py-1 text-left text-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("universalProvider.manage", {
            defaultValue: "管理统一供应商",
          })}
        </button>
      )}
    </fieldset>
  );
}
