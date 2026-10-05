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

/**
 * The one token-count format on the usage page: plain integers below 10,000,
 * then 万 with at most one decimal, then 亿 with two. Zero is "0".
 */
export function formatUsageTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const tokens = Math.round(value);
  if (tokens < 1e4) return tokens.toLocaleString("zh-CN");
  // Round first so 99,999,999 reads as 1.00 亿 rather than 10,000 万.
  const wan = Math.round(tokens / 1e3) / 10;
  if (wan < 1e4)
    return `${wan.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万`;
  return `${(tokens / 1e8).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 亿`;
}

/** "刚刚" / "N 分钟前" / "N 小时前" / "N 天前", then a calendar date. */
export function formatUsageRelativeTime(
  epochSeconds: number,
  now = Date.now(),
): string {
  const minutes = Math.floor((now - epochSeconds * 1000) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const date = new Date(epochSeconds * 1000);
  const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? day
    : `${date.getFullYear()} 年 ${day}`;
}

/** Local "YYYY-MM-DD HH:mm", used where a relative time needs its exact value. */
export function formatUsageDateTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
