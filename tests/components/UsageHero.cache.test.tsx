import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { UsageHero } from "@/components/usage/UsageHero";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));
vi.mock("@/lib/query/usage", () => ({
  useUsageSummaryByApp: () => ({
    data: [
      {
        appType: "codex",
        summary: {
          totalRequests: 1,
          totalCost: "0",
          totalInputTokens: 200,
          totalOutputTokens: 50,
          totalCacheReadTokens: 600,
          totalCacheCreationTokens: 321,
          successRate: 1,
          realTotalTokens: 1171,
          cacheHitRate: 0.5,
        },
      },
    ],
    isLoading: false,
  }),
}));
it("shows reported Codex cache writes instead of N/A", () => {
  render(
    <UsageHero
      range={{ preset: "30d" }}
      appType="codex"
      refreshIntervalMs={0}
    />,
  );
  expect(screen.queryByText("N/A")).not.toBeInTheDocument();
  expect(screen.getByText("321")).toBeInTheDocument();
});
