/**
 * The 模型词元分布 panel ranks models by tokens, not by cost.
 *
 * Numbers below are a real 30-day `codex` sample, which is what makes the bug
 * concrete: the backend returns `ORDER BY total_cost DESC`, so taking the first
 * three of that order put gpt-5.5 (56K tokens, $0.39) on screen and hid
 * codex-auto-review (1.18M tokens, $0.00) — 20x the tokens, ranked lower purely
 * because it has no pricing entry.
 */
import { describe, expect, it } from "vitest";
import { USAGE_TOP_MODEL_COUNT, topModelsByTokens } from "@/views/UsageView";
import type { ModelStats } from "@/types/usage";

function stat(
  model: string,
  totalTokens: number,
  totalCost: string,
): ModelStats {
  return {
    model,
    totalTokens,
    totalCost,
    requestCount: 1,
    avgCostPerRequest: totalCost,
  };
}

/**
 * In backend order: ORDER BY total_cost DESC.
 *
 * A factory, not a shared const: a helper that sorts in place would mutate a
 * shared fixture, and because sorting is idempotent the purity assertion below
 * would then pass against an already-sorted array — the bug would hide itself.
 * A fresh array per test also keeps the cases independent of execution order.
 */
function sample(): ModelStats[] {
  return [
    stat("gpt-5.6-sol", 457_428_461, "6471.712884"),
    stat("gpt-5.6-terra", 46_074_565, "310.327271"),
    stat("gpt-5.5", 56_780, "0.393249"),
    stat("kimi-k3", 15_034, "0.048359"),
    stat("gpt-5.6-luna", 27_895, "0.028285"),
    stat("codex-auto-review", 1_176_721, "0.000000"),
    stat("claude-opus-5", 36_544, "0.000000"),
    stat("claude-opus-4-5-20251101", 0, "0.000000"),
  ];
}

describe("topModelsByTokens", () => {
  it("ranks by tokens rather than the backend's cost order", () => {
    expect(topModelsByTokens(sample(), 3).map((m) => m.model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "codex-auto-review",
    ]);
  });

  it("lets an unpriced model in when it has the tokens", () => {
    // The structural failure of cost-ranking: cost 0 could never place, no
    // matter the token count, so unpriced models were permanently invisible.
    const ranked = topModelsByTokens(sample(), 3);
    expect(ranked.map((m) => m.model)).toContain("codex-auto-review");
    expect(ranked.map((m) => m.model)).not.toContain("gpt-5.5");
  });

  it("does not mutate the caller's array", () => {
    // The argument is React state, so sorting in place would mutate it.
    // Asserted against the literal backend order rather than a snapshot of the
    // input: a snapshot taken from an array the helper already sorted would
    // match trivially.
    const input = sample();
    topModelsByTokens(input);
    expect(input.map((m) => m.model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.5",
      "kimi-k3",
      "gpt-5.6-luna",
      "codex-auto-review",
      "claude-opus-5",
      "claude-opus-4-5-20251101",
    ]);
  });

  it("returns everything it has when there are fewer models than the cap", () => {
    expect(topModelsByTokens(sample().slice(0, 2))).toHaveLength(2);
    expect(topModelsByTokens([])).toEqual([]);
  });

  it("caps at the configured count", () => {
    expect(topModelsByTokens(sample())).toHaveLength(USAGE_TOP_MODEL_COUNT);
  });
});
