import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RequestDetailPanel } from "@/components/usage/RequestDetailPanel";
const fixture = vi.hoisted(() => ({
  requestId: "r1",
  providerId: "p1",
  appType: "codex",
  model: "test",
  costMultiplier: "1",
  inputTokens: 1000,
  inputTokenSemantics: 1,
  outputTokens: 50,
  cacheReadTokens: 600,
  cacheCreationTokens: 200,
  inputCostUsd: "0",
  outputCostUsd: "0",
  cacheReadCostUsd: "0",
  cacheCreationCostUsd: "0",
  totalCostUsd: "0",
  isStreaming: false,
  latencyMs: 1,
  statusCode: 200,
  createdAt: 1000,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: "en" },
  }),
}));
vi.mock("@/lib/query/usage", () => ({
  useRequestDetail: () => ({ data: fixture, isLoading: false }),
}));
it.each([
  [1, "200", "1,050"],
  [2, "1,000", "1,850"],
  [0, "400", "1,250"],
])(
  "renders DTO semantics %s and total including cache",
  (semantics, fresh, total) => {
    fixture.inputTokenSemantics = Number(semantics);
    render(<RequestDetailPanel requestId="r1" onClose={() => {}} />);
    const input = screen.getByText("输入 Tokens").parentElement!;
    expect(within(input).getByText(String(fresh))).toBeInTheDocument();
    const sum = screen.getByText("总计").parentElement!;
    expect(within(sum).getByText(String(total))).toBeInTheDocument();
  },
);
