import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import ja from "@/i18n/locales/ja.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import zh from "@/i18n/locales/zh.json";

// Strings shown by screens that are reachable today (deep-link confirm and
// the "database too new" screen) must carry this product's name.
const reachableKeys = [
  "deeplink.confirmImportDescription",
  "dbUpgrade.description",
] as const;

type TranslationTree = Record<string, unknown>;

function readTranslation(tree: TranslationTree, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as TranslationTree)[segment];
  }, tree);
}

describe("reachable branding strings", () => {
  it.each([
    ["zh", zh],
    ["zh-TW", zhTW],
    ["en", en],
    ["ja", ja],
  ])("names Chimera++ in %s", (_locale, translations) => {
    for (const key of reachableKeys) {
      const value = readTranslation(translations, key);
      expect(typeof value, key).toBe("string");
      expect(value, key).toContain("Chimera++");
      expect(value, key).not.toContain("CC Switch");
    }
  });
});
