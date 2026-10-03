import { describe, expect, it } from "vitest";
import { getFreshInputTokens } from "@/types/usage";

describe("request DTO input token semantics", () => {
  it.each(["codex", "gemini", "grokbuild"])(
    "normalizes %s total, fresh and legacy records",
    (appType) => {
      const log = {
        appType,
        inputTokens: 1000,
        cacheReadTokens: 600,
        cacheCreationTokens: 200,
      };
      expect(getFreshInputTokens({ ...log, inputTokenSemantics: 1 })).toBe(200);
      expect(getFreshInputTokens({ ...log, inputTokenSemantics: 2 })).toBe(
        1000,
      );
      expect(getFreshInputTokens({ ...log, inputTokenSemantics: 0 })).toBe(400);
      expect(getFreshInputTokens(log)).toBe(400);
      expect(
        getFreshInputTokens({
          ...log,
          inputTokens: 100,
          inputTokenSemantics: 1,
        }),
      ).toBe(100);
    },
  );
  it("preserves Anthropic fresh input", () => {
    expect(
      getFreshInputTokens({
        appType: "claude",
        inputTokens: 1000,
        cacheReadTokens: 600,
        cacheCreationTokens: 200,
        inputTokenSemantics: 1,
      }),
    ).toBe(1000);
  });
});
