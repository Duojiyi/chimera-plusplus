import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ModuleKind, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";
import {
  formatUsageTokens,
  totalDailyTokens,
  usageBucketLabel,
  usageTrendTicks,
  usageWindow,
} from "@/utils/usageMetrics";

describe("usageMetrics", () => {
  it.each([
    ["today", new Date(2026, 0, 2)],
    ["7d", new Date(2025, 11, 27)],
    ["30d", new Date(2025, 11, 4)],
  ] as const)(
    "uses local calendar midnight for %s, including year boundaries",
    (range, start) => {
      const now = new Date(2026, 0, 2, 14, 35, 12, 999);
      expect(usageWindow(range, now)).toEqual({
        start: start.getTime() / 1000,
        end: Math.floor(now.getTime() / 1000),
      });
      expect(now.getHours()).toBe(14);
    },
  );

  it.each([
    ["2026-11-01T23:30:00-05:00", "2026-11-01T00:00:00-04:00", 24.5],
    ["2026-03-08T23:30:00-04:00", "2026-03-08T00:00:00-05:00", 22.5],
  ] as const)(
    "preserves local midnight across DST at %s",
    (now, midnight, hours) => {
      // A separate process makes TZ reliable on Windows and Vitest worker threads.
      const source = readFileSync("src/utils/usageMetrics.ts", "utf8");
      const { outputText } = transpileModule(source, {
        compilerOptions: { module: ModuleKind.ESNext },
      });
      const moduleUrl =
        "data:text/javascript;base64," +
        Buffer.from(outputText).toString("base64");
      const result = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { usageWindow } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(usageWindow("today", new Date(${JSON.stringify(now)}))));`,
        ],
        { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" },
      );
      const window = JSON.parse(result);
      expect(window).toEqual({
        start: Date.parse(midnight) / 1000,
        end: Date.parse(now) / 1000,
      });
      expect(window.end - window.start).toBe(hours * 3600);
    },
  );

  it.each([0, 1, 7, 8, 24, 30, 31])(
    "selects sparse ticks with both endpoints for %i buckets",
    (length) => {
      const trends = Array.from({ length }, (_, index) => ({
        date: String(index),
        requestCount: 0,
        totalCost: "0",
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
      }));
      const ticks = usageTrendTicks(trends);
      if (length <= 7) {
        expect(ticks).toBeUndefined();
      } else {
        expect(ticks).toHaveLength(5);
        expect(new Set(ticks).size).toBe(5);
        expect(ticks![0]).toBe("0");
        expect(ticks![4]).toBe(String(length - 1));
        if (length === 30) expect(ticks).toEqual(["0", "7", "14", "21", "29"]);
      }
    },
  );

  it("adds both cache categories without double-counting the legacy totalTokens field", () => {
    expect(
      totalDailyTokens({
        date: "2026-09-18",
        requestCount: 1,
        totalCost: "0",
        totalTokens: 9999,
        totalInputTokens: 100,
        totalOutputTokens: 20,
        totalCacheCreationTokens: 30,
        totalCacheReadTokens: 400,
      }),
    ).toBe(550);
  });

  it("keeps RFC3339 hourly labels in the bucket's timezone and formats daily labels", () => {
    expect(usageBucketLabel("2026-09-18T09:00:00+08:00", true)).toBe("09:00");
    expect(usageBucketLabel("2026-09-18T00:00:00-07:00", true)).toBe("00:00");
    expect(usageBucketLabel("2026-09-18", false)).toBe("09/18");
    expect(usageBucketLabel("2026-11-01T00:00:00-04:00", false)).toBe("11/01");
  });

  it("formats small totals and Chinese units, including a shared model unit", () => {
    expect(formatUsageTokens(0)).toBe("0");
    expect(formatUsageTokens(9999)).toBe("9,999");
    expect(formatUsageTokens(12345)).toBe("1.2 万");
    expect(formatUsageTokens(123456789)).toBe("1.23 亿");
    expect(formatUsageTokens(450, "万")).toBe("0.05 万");
    expect(formatUsageTokens(20000, "万")).toBe("2 万");
  });
});
