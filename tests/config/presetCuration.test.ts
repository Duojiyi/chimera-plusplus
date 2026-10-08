import { describe, expect, it } from "vitest";
import { claudeDesktopProviderPresets } from "@/config/claudeDesktopProviderPresets";
import { providerPresets } from "@/config/claudeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";
import { grokBuildProviderPresets } from "@/config/grokBuildProviderPresets";

import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";

const lists: Record<string, readonly object[]> = {
  claude: providerPresets,
  claudeDesktop: claudeDesktopProviderPresets,
  codex: codexProviderPresets,
  gemini: geminiProviderPresets,
  grokBuild: grokBuildProviderPresets,

  opencode: opencodeProviderPresets,
};

// Query parameters that carry an affiliate / invite / tracking code.
const REFERRAL_PARAMS =
  /[?&#](aff|ref|invitecode|invite|ic|code|source|from|ch|ytag|ac|rc|utm_[a-z]+)=/i;

const collectUrls = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") {
    for (const match of value.matchAll(/https?:\/\/[^\s"'`]+/g)) {
      out.push(match[0]);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, out));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectUrls(item, out));
  }
  return out;
};

describe("provider preset curation", () => {
  it.each(Object.entries(lists))(
    "%s presets carry no partner or promotion data",
    (_tool, presets) => {
      for (const preset of presets as Record<string, unknown>[]) {
        expect(preset.isPartner, String(preset.name)).toBeUndefined();
        expect(preset.primePartner, String(preset.name)).toBeUndefined();
        // "google-official" is a functional marker (OAuth hint), not a promo.
        if (preset.partnerPromotionKey !== undefined) {
          expect(preset.partnerPromotionKey).toBe("google-official");
        }
      }
    },
  );

  it.each(Object.entries(lists))(
    "%s presets link to no referral or invite URL",
    (_tool, presets) => {
      const offending = collectUrls(presets).filter(
        (url) =>
          REFERRAL_PARAMS.test(url) ||
          /cc-?switch|\/invite\/|\/i\/[A-Za-z0-9]+$/i.test(url),
      );
      expect(offending).toEqual([]);
    },
  );

  // Direct presets use Anthropic; the builtin Desktop template uses its proxy adapter.
  it.each([
    ["claude", providerPresets],
    ["claudeDesktop", claudeDesktopProviderPresets],
  ] as const)("%s offers only native Anthropic presets", (_tool, presets) => {
    const foreign = (
      presets as {
        name: string;
        apiFormat?: string;
        isBuiltinTemplate?: boolean;
        mode?: string;
      }[]
    )
      .filter((preset) => {
        if (_tool === "claudeDesktop" && preset.isBuiltinTemplate) {
          expect(preset.mode).toBe("proxy");
          expect(preset.apiFormat).toBe("openai_responses");
          return false;
        }
        return (preset.apiFormat ?? "anthropic") !== "anthropic";
      })
      .map((preset) => preset.name);
    expect(foreign).toEqual([]);
  });
});
