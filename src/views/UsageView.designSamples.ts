import type {
  DailyStats,
  ModelStats,
  ProviderStats,
  UsageSummary,
} from "@/types/usage";

/** Read-only Codex activity for the seven-day v5.2 design preview. */
export const isUsageDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

const DAY_TOTALS = [
  1_450_000, 1_180_000, 1_940_000, 1_620_000, 2_640_000, 2_040_000, 1_610_000,
];
const TOTAL = DAY_TOTALS.reduce((sum, value) => sum + value, 0);
const OUTPUT = 2_660_000;
const CACHE_CREATION = 120_000;
const CACHE_READ = Math.round((TOTAL - OUTPUT) * 0.684);
const INPUT = TOTAL - OUTPUT - CACHE_CREATION - CACHE_READ;
const REQUESTS = 1_428;
const COST_CENTS = 3_460;
export const USAGE_SAMPLE_SESSION_FILES = 96;
export const USAGE_SAMPLE_SUMMARY: UsageSummary = {
  totalRequests: REQUESTS,
  totalCost: (COST_CENTS / 100).toFixed(2),
  totalInputTokens: INPUT,
  totalOutputTokens: OUTPUT,
  totalCacheCreationTokens: CACHE_CREATION,
  totalCacheReadTokens: CACHE_READ,
  successRate: 100,
  realTotalTokens: TOTAL,
  cacheHitRate: CACHE_READ / (TOTAL - OUTPUT),
};

/** Round cumulative shares so the buckets add up to the exact total. */
function spread(total: number): number[] {
  let cumulative = 0;
  return DAY_TOTALS.map((weight) => {
    const start = Math.round((total * cumulative) / TOTAL);
    cumulative += weight;
    return Math.round((total * cumulative) / TOTAL) - start;
  });
}

const pad = (value: number) => String(value).padStart(2, "0");

export function usageSampleTrends(now = new Date(2026, 10, 23)): DailyStats[] {
  const output = spread(OUTPUT);
  const creation = spread(CACHE_CREATION);
  const read = spread(CACHE_READ);
  const requests = spread(REQUESTS);
  const cost = spread(COST_CENTS);
  return DAY_TOTALS.map((total, index) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    day.setDate(day.getDate() - (DAY_TOTALS.length - 1 - index));
    const input = total - output[index] - creation[index] - read[index];
    return {
      date: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`,
      requestCount: requests[index],
      totalCost: (cost[index] / 100).toFixed(2),
      totalTokens: total,
      totalInputTokens: input,
      totalOutputTokens: output[index],
      totalCacheCreationTokens: creation[index],
      totalCacheReadTokens: read[index],
    };
  });
}

const model = (
  name: string,
  totalTokens: number,
  requestCount: number,
  totalCost: string,
): ModelStats => ({
  model: name,
  totalTokens,
  requestCount,
  totalCost,
  avgCostPerRequest: (Number(totalCost) / requestCount).toFixed(6),
});

export const USAGE_SAMPLE_MODELS: ModelStats[] = [
  model("gpt-5.4-codex", 6_420_000, 743, "19.26"),
  model("gpt-6.2-sol", 3_840_000, 432, "11.52"),
  model("claude-sonnet-4", 2_220_000, 253, "3.82"),
];

const provider = (
  providerName: string,
  totalTokens: number,
  requestCount: number,
  totalCost: string,
): ProviderStats => ({
  providerId: providerName,
  providerName,
  totalTokens,
  requestCount,
  totalCost,
  successRate: 99.9,
  avgLatencyMs: 840,
});

export const USAGE_SAMPLE_PROVIDERS: ProviderStats[] = [
  provider("新线路 · kimera", 7_820_000, 894, "21.12"),
  provider("OpenAI Official", 3_660_000, 388, "11.60"),
  provider("默认本地备用线路", 1_000_000, 146, "1.88"),
];
