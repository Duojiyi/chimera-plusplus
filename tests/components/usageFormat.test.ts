import { describe, expect, it } from "vitest";
import {
  formatAxisTokens,
  formatTokensShort,
  getLocaleFromLanguage,
} from "@/components/usage/format";

describe("usage format helpers", () => {
  it("formats Traditional Chinese token units with Traditional characters", () => {
    expect(formatTokensShort(12_345, "zh-TW")).toBe("1.2 萬");
    expect(formatTokensShort(123_456_789, "zh-Hant", 2)).toBe("1.23 億");
  });

  it("resolves Traditional Chinese locale aliases", () => {
    expect(getLocaleFromLanguage("zh_TW")).toBe("zh-TW");
    expect(getLocaleFromLanguage("zh-HK")).toBe("zh-TW");
  });

  it("writes token axis ticks with the shortest CJK unit", () => {
    expect(formatAxisTokens(0)).toBe("0");
    expect(formatAxisTokens(5000)).toBe("5000");
    expect(formatAxisTokens(12000)).toBe("1.2万");
    expect(formatAxisTokens(50_000_000)).toBe("5千万");
    expect(formatAxisTokens(25_000_000)).toBe("2.5千万");
    expect(formatAxisTokens(300_000_000)).toBe("3亿");
    expect(formatAxisTokens(200_000_000_000)).toBe("2千亿");
    expect(formatAxisTokens(123_456)).toBe("12.3万");
  });
});
