import type {
  DailyStats,
  ModelStats,
  ProviderStats,
  UsageSummary,
} from "@/types/usage";

/**
 * Browser design-preview fixtures for the 用量 page (L08).
 *
 * Only used when the renderer runs outside Tauri with `?preview=design`, so
 * the layout can be reviewed without a backend. Numbers follow the shared
 * fake-data baseline (design system §6): input 12.4M + output 3.18M, cache
 * read 48.9M (79% hit), 41,208 requests with 9 failures. Refresh, rebuild and
 * range switching stay disabled while these are on screen.
 */
export const isUsageDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

const INPUT = 12_400_000;
const OUTPUT = 3_180_000;
const CACHE_CREATION = 600_000;
const CACHE_READ = 48_900_000;
const REQUESTS = 41_208;
const FAILURES = 9;

export const USAGE_SAMPLE_SESSION_FILES = 1_958;

export const USAGE_SAMPLE_SUMMARY: UsageSummary = {
  totalRequests: REQUESTS,
  totalCost: "25.80",
  totalInputTokens: INPUT,
  totalOutputTokens: OUTPUT,
  totalCacheCreationTokens: CACHE_CREATION,
  totalCacheReadTokens: CACHE_READ,
  successRate: ((REQUESTS - FAILURES) / REQUESTS) * 100,
  realTotalTokens: INPUT + OUTPUT + CACHE_CREATION + CACHE_READ,
  cacheHitRate: CACHE_READ / (INPUT + CACHE_CREATION + CACHE_READ),
};

/** Relative daily load, oldest first; the shape of the L08 board. */
const SHAPE = [
  48, 56, 43, 70, 62, 80, 55, 38, 66, 75, 50, 88, 95, 70, 65, 80, 75, 58, 100,
  83, 70, 55, 80, 93, 75, 62, 132, 160, 108, 100,
];

/** Split `total` by SHAPE so the days add up exactly. */
function spread(total: number): number[] {
  const weight = SHAPE.reduce((sum, value) => sum + value, 0);
  const parts = SHAPE.map((value) => Math.floor((total * value) / weight));
  parts[parts.length - 1] += total - parts.reduce((sum, v) => sum + v, 0);
  return parts;
}

const pad = (value: number) => String(value).padStart(2, "0");

export function usageSampleTrends(now = new Date()): DailyStats[] {
  const input = spread(INPUT);
  const output = spread(OUTPUT);
  const creation = spread(CACHE_CREATION);
  const read = spread(CACHE_READ);
  const requests = spread(REQUESTS);
  const cost = spread(2580);
  return SHAPE.map((_, index) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    day.setDate(day.getDate() - (SHAPE.length - 1 - index));
    const total = input[index] + output[index] + creation[index] + read[index];
    return {
      date: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`,
      requestCount: requests[index],
      totalCost: (cost[index] / 100).toFixed(2),
      totalTokens: total,
      totalInputTokens: input[index],
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

/** Model totals are fresh input + output, like the backend's model ranking. */
export const USAGE_SAMPLE_MODELS: ModelStats[] = [
  model("deepseek-v4-pro", 8_850_000, 21_406, "6.92"),
  model("gpt-5.6", 3_320_000, 9_812, "12.64"),
  model("kimi-k2", 2_120_000, 6_204, "3.41"),
  model("glm-5", 890_000, 2_731, "1.12"),
  model("claude-sonnet-4-6", 400_000, 1_055, "1.71"),
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
  provider("DeepSeek", 6_140_000, 16_240, "5.10"),
  provider("OpenAI 官方", 4_050_000, 10_715, "13.06"),
  provider("Kimi", 2_910_000, 7_706, "3.91"),
  provider("智谱 GLM", 1_590_000, 4_212, "1.92"),
  provider("OpenRouter", 890_000, 2_335, "1.81"),
];
