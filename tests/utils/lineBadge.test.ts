import { describe, expect, it } from "vitest";
import {
  autoLineBadgeText,
  lineBadgeText,
  normalizeLineBadgeText,
  type LineBadgeSource,
} from "@/utils/lineBadge";

const line = (name: string, extra: Partial<LineBadgeSource> = {}) => ({
  id: "line",
  name,
  category: "custom",
  ...extra,
});
// Built through unknown so the test does not depend on when `badgeText`
// lands in ProviderMeta.
const badge = (badgeText: string) =>
  ({ badgeText }) as unknown as LineBadgeSource["meta"];

describe("lineBadgeText", () => {
  it.each([
    ["two Latin words", line("Claude Code"), "CC"],
    ["camel humps", line("DeepSeek"), "DS"],
    ["camel humps with an acronym", line("OpenAI"), "OA"],
    ["one Latin word", line("Kimi"), "Ki"],
    ["one lower-case word", line("openrouter"), "Op"],
    ["an acronym stays upper-case", line("GLM"), "GL"],
    ["digits do not count as initials", line("Qwen3 Coder"), "QC"],
    ["a CJK name", line("智谱 GLM"), "智谱"],
    ["a CJK name without spaces", line("自建中转"), "自建"],
    ["a single CJK character", line("备"), "备"],
    ["CJK after a number", line("302 中转"), "中转"],
    ["digits only", line("302"), "30"],
    ["an empty name", line("   "), "未"],
    [
      "an official line",
      line("OpenAI 官方 · 主力", { category: "official" }),
      "官",
    ],
    ["the built-in official id", line("ChatGPT", { id: "codex-official" }), "官"],
  ])("%s", (_case, source, expected) => {
    expect(lineBadgeText(source)).toBe(expected);
  });

  it("prefers the user's own badge text, even on official lines", () => {
    expect(lineBadgeText(line("DeepSeek", { meta: badge("深") }))).toBe("深");
    expect(
      lineBadgeText(
        line("OpenAI 官方", { category: "official", meta: badge("主") }),
      ),
    ).toBe("主");
  });

  it("falls back to the generated badge when the user's text is blank", () => {
    expect(lineBadgeText(line("DeepSeek", { meta: badge("  ") }))).toBe("DS");
    expect(autoLineBadgeText(line("DeepSeek", { meta: badge("X") }))).toBe(
      "DS",
    );
  });

  it("clamps the user's text to two CJK or three Latin characters", () => {
    expect(lineBadgeText(line("DeepSeek", { meta: badge(" 深度求索 ") }))).toBe(
      "深度",
    );
    expect(lineBadgeText(line("DeepSeek", { meta: badge("ABCD") }))).toBe(
      "ABC",
    );
  });
});

describe("normalizeLineBadgeText", () => {
  it.each([
    ["  主力  ", "主力"],
    ["主力线路", "主力"],
    ["G智谱", "G智"],
    ["dsk1", "dsk"],
    ["", ""],
  ])("%j becomes %j", (input, expected) => {
    expect(normalizeLineBadgeText(input)).toBe(expected);
  });
});
