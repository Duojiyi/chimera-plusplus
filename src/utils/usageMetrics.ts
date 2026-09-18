import type { DailyStats } from "@/types/usage";

export type UsageRange = "today" | "7d" | "30d";
export const usageRangeLabels: Record<UsageRange, string> = {
  today: "今日",
  "7d": "7 天",
  "30d": "30 天",
};

/** Local calendar days match the backend's local daily buckets, including DST. */
export function usageWindow(range: UsageRange, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(
    start.getDate() - (range === "today" ? 0 : range === "7d" ? 6 : 29),
  );
  return {
    start: Math.floor(start.getTime() / 1000),
    end: Math.floor(now.getTime() / 1000),
  };
}

export function totalDailyTokens(day: DailyStats): number {
  return (
    day.totalInputTokens +
    day.totalOutputTokens +
    day.totalCacheCreationTokens +
    day.totalCacheReadTokens
  );
}

export function formatUsageTokens(value: number, unit?: "万"): string {
  if (unit === "万")
    return `${(value / 10000).toLocaleString("zh-CN", { maximumFractionDigits: value < 10000 ? 2 : 0 })} 万`;
  if (value >= 1e8)
    return `${(value / 1e8).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 亿`;
  if (value >= 1e4)
    return `${(value / 1e4).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万`;
  return value.toLocaleString("zh-CN");
}

/** Both hour and day buckets arrive as local RFC3339; date-only values also work. */
export function usageBucketLabel(date: string, hourly: boolean): string {
  return hourly ? date.slice(11, 16) : date.slice(5, 10).replace("-", "/");
}

/** Keep a sparse axis with both endpoints (30 buckets: 0, 7, 14, 21, 29). */
export function usageTrendTicks(trends: DailyStats[]): string[] | undefined {
  if (trends.length <= 7) return undefined;
  const last = trends.length - 1;
  const step = Math.round(last / 4);
  return [0, step, step * 2, step * 3, last].map((index) => trends[index].date);
}
