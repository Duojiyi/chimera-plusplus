import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { useForm } from "react-hook-form";
import { Form } from "@/components/ui/form";
import type { ProviderCategory } from "@/types";
import {
  ProviderPresetSelector,
  filterPresetEntries,
  getPresetDisplayName,
  getPresetSearchText,
  getVisiblePresetEntries,
  sortPresetEntries,
  type PresetSortMode,
} from "@/components/providers/forms/ProviderPresetSelector";

const presetCategoryLabels = {
  official: "官方",
  cn_official: "国产官方",
  aggregator: "聚合服务",
  third_party: "第三方",
};

const translations: Record<string, string> = {
  "preset.alpha": "Alpha 本地名",
  "preset.gamma": "Gamma 本地名",
};

const t = ((key: string) => translations[key] ?? key) as TFunction;

type TestPresetEntry = {
  id: string;
  preset: {
    name: string;
    nameKey?: string;
    websiteUrl: string;
    settingsConfig: Record<string, never>;
    category: ProviderCategory;
    primePartner?: boolean;
    isPartner?: boolean;
    isBuiltinTemplate?: boolean;
  };
};

const presetEntries: TestPresetEntry[] = [
  {
    id: "gamma",
    preset: {
      name: "Gamma Raw",
      nameKey: "preset.gamma",
      websiteUrl: "https://gamma.example.com",
      settingsConfig: {},
      category: "aggregator",
    },
  },
  {
    id: "alpha",
    preset: {
      name: "Alpha Raw",
      nameKey: "preset.alpha",
      websiteUrl: "https://alpha.example.com/v1",
      settingsConfig: {},
      category: "official",
    },
  },
  {
    id: "beta",
    preset: {
      name: "Beta Gateway",
      websiteUrl: "https://CN-Gateway.example.com",
      settingsConfig: {},
      category: "cn_official",
    },
  },
  {
    id: "delta",
    preset: {
      name: "Delta Mirror",
      websiteUrl: "https://delta.example.com",
      settingsConfig: {},
      category: "third_party",
    },
  },
] satisfies TestPresetEntry[];

function getIds(entries: ReadonlyArray<{ id: string }>) {
  return entries.map((entry) => entry.id);
}

function renderSelector({
  entries = presetEntries,
  selectedPresetId = "custom",
  onPresetChange = vi.fn(),
  onManageUniversalProviders,
  onUniversalPresetSelect,
}: {
  entries?: TestPresetEntry[];
  selectedPresetId?: string | null;
  onPresetChange?: (value: string) => void;
  onManageUniversalProviders?: () => void;
  onUniversalPresetSelect?: () => void;
} = {}) {
  const Wrapper = () => {
    const form = useForm();
    return (
      <Form {...form}>
        <ProviderPresetSelector
          selectedPresetId={selectedPresetId}
          presetEntries={entries}
          presetCategoryLabels={presetCategoryLabels}
          onPresetChange={onPresetChange}
          onManageUniversalProviders={onManageUniversalProviders}
          onUniversalPresetSelect={onUniversalPresetSelect}
        />
      </Form>
    );
  };
  return render(<Wrapper />);
}

describe("ProviderPresetSelector pure helpers", () => {
  it("优先使用 nameKey 翻译作为显示名，否则使用原始 name", () => {
    expect(getPresetDisplayName(presetEntries[1].preset, t)).toBe(
      "Alpha 本地名",
    );
    expect(getPresetDisplayName(presetEntries[2].preset, t)).toBe(
      "Beta Gateway",
    );
  });

  it("仅拼接显示名与原始名称、统一 lower-case，不含 URL 或分类 label", () => {
    const searchText = getPresetSearchText(presetEntries[1], t);

    expect(searchText).toContain("alpha 本地名");
    expect(searchText).toContain("alpha raw");
    expect(searchText).not.toContain("example.com");
    expect(searchText).not.toContain("官方");
    expect(searchText).toBe(searchText.toLowerCase());
  });

  it("空 query 返回原数组，非空 query 大小写不敏感匹配", () => {
    expect(filterPresetEntries(presetEntries, "   ", t)).toBe(presetEntries);
    expect(
      getIds(filterPresetEntries(presetEntries, "ALPHA 本地名", t)),
    ).toEqual(["alpha"]);
  });

  it("不再通过 URL 或分类 label 搜索（仅匹配名称）", () => {
    expect(
      getIds(filterPresetEntries(presetEntries, "cn-gateway.example.com", t)),
    ).toEqual([]);
    expect(getIds(filterPresetEntries(presetEntries, "聚合", t))).toEqual([]);
  });

  it("支持 A-Z 排序、original 模式将官方分类置顶，并且 getVisible 先 filter 再 sort", () => {
    const originalMode: PresetSortMode = "original";
    const nameAscMode: PresetSortMode = "nameAsc";

    const original = sortPresetEntries(presetEntries, originalMode, t);
    expect(original).not.toBe(presetEntries);
    // original 模式置顶官方分类（alpha）；其余均非赞助商，按显示名排序
    // （Beta Gateway < Delta Mirror < Gamma 本地名）。
    expect(getIds(original)).toEqual(["alpha", "beta", "delta", "gamma"]);

    expect(getIds(sortPresetEntries(presetEntries, nameAscMode, t))).toEqual([
      "alpha",
      "beta",
      "delta",
      "gamma",
    ]);
    expect(getIds(presetEntries)).toEqual(["gamma", "alpha", "beta", "delta"]);

    expect(
      getIds(
        getVisiblePresetEntries(presetEntries, {
          query: "a",
          sortMode: nameAscMode,
          t,
        }),
      ),
    ).toEqual(["alpha", "beta", "delta", "gamma"]);
  });

  it("original 模式按「官方 → 尊享伙伴 → 赞助商 → 非赞助商」四段排序，前三组保序、末组按显示名，双重身份不重复", () => {
    // 故意打乱传入顺序，验证：
    // - official 组置顶（officialOnly、officialPrime 按出现顺序）；
    // - 非官方且 primePartner 的预设次之（primeAndPartner）；
    // - 赞助商（isPartner）第三段，保持传入（预设文件）顺序：
    //   partnerZeta 在 partnerAlpha 前，不按字母重排；
    // - 非赞助商按显示名排序：restAlpha 排到 restZulu 前；
    // - 既是 official 又是 primePartner 的只归入官方组；
    //   既是 primePartner 又是 isPartner 的只归入 prime 组、不在赞助商组重复。
    const mixed: TestPresetEntry[] = [
      {
        id: "restZulu",
        preset: {
          name: "Zulu Rest",
          websiteUrl: "https://rest-zulu.example.com",
          settingsConfig: {},
          category: "third_party",
        },
      },
      {
        id: "partnerZeta",
        preset: {
          name: "Zeta Partner",
          websiteUrl: "https://partner-zeta.example.com",
          settingsConfig: {},
          category: "aggregator",
          isPartner: true,
        },
      },
      {
        id: "primeAndPartner",
        preset: {
          name: "Prime And Partner",
          websiteUrl: "https://prime-and-partner.example.com",
          settingsConfig: {},
          category: "cn_official",
          primePartner: true,
          isPartner: true,
        },
      },
      {
        id: "officialOnly",
        preset: {
          name: "Official Only",
          websiteUrl: "https://official-only.example.com",
          settingsConfig: {},
          category: "official",
        },
      },
      {
        id: "officialPrime",
        preset: {
          name: "Official Prime",
          websiteUrl: "https://official-prime.example.com",
          settingsConfig: {},
          category: "official",
          primePartner: true,
        },
      },
      {
        id: "partnerAlpha",
        preset: {
          name: "Alpha Partner",
          websiteUrl: "https://partner-alpha.example.com",
          settingsConfig: {},
          category: "third_party",
          isPartner: true,
        },
      },
      {
        id: "restAlpha",
        preset: {
          name: "Alpha Rest",
          websiteUrl: "https://rest-alpha.example.com",
          settingsConfig: {},
          category: "aggregator",
        },
      },
    ];

    expect(getIds(sortPresetEntries(mixed, "original", t))).toEqual([
      "officialOnly",
      "officialPrime",
      "primeAndPartner",
      "partnerZeta",
      "partnerAlpha",
      "restAlpha",
      "restZulu",
    ]);
  });
});

describe("ProviderPresetSelector", () => {
  const builtin: TestPresetEntry = {
    id: "builtin",
    preset: {
      name: "ChimeraHub 内置模板完整名称",
      websiteUrl: "https://example.com",
      settingsConfig: {},
      category: "third_party",
      isBuiltinTemplate: true,
    },
  };

  it("only exposes the Chimera built-in template", () => {
    renderSelector({ entries: [...presetEntries, builtin] });
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual([builtin.preset.name]);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("selects the template with a keyboard and preserves accessible selection state", async () => {
    const user = userEvent.setup();
    const onPresetChange = vi.fn();
    renderSelector({
      entries: [builtin],
      selectedPresetId: "builtin",
      onPresetChange,
    });
    const button = screen.getByRole("button", { name: builtin.preset.name });
    expect(button).toHaveAttribute("aria-pressed", "true");
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onPresetChange).toHaveBeenCalledWith("builtin");
  });
  it("does not expose legacy presets when the template is unavailable", () => {
    renderSelector();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
  it("retains user-owned configuration management without the provider catalog", async () => {
    const user = userEvent.setup();
    const onManageUniversalProviders = vi.fn();
    const onUniversalPresetSelect = vi.fn();
    renderSelector({
      entries: [],
      onManageUniversalProviders,
      onUniversalPresetSelect,
    });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "管理统一供应商" }));
    expect(onManageUniversalProviders).toHaveBeenCalledOnce();
    expect(onUniversalPresetSelect).not.toHaveBeenCalled();
  });
});
