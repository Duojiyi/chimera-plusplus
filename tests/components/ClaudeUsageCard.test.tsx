import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeUsageCard,
  bucketTokens,
  compact,
  dayLabel,
  heatmapWeeks,
  lastDays,
  money,
  usageFacts,
} from "@/components/claude-accounts/ClaudeUsageCard";
import {
  claudeAccountsApi,
  type ClaudeUsageBucket,
  type ClaudeUsageDay,
  type ClaudeUsageOverview,
} from "@/lib/api/claudeAccounts";

vi.mock("@/lib/api/claudeAccounts", () => ({
  claudeAccountsApi: { usageOverview: vi.fn() },
}));

const api = vi.mocked(claudeAccountsApi);

const bucket = (
  tokens: Partial<ClaudeUsageBucket["tokens"]>,
  over: Partial<ClaudeUsageBucket> = {},
): ClaudeUsageBucket => ({
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
  messages: 1,
  costUsd: 0,
  costPartial: false,
  ...over,
});

const day = (date: string, tokens: number): ClaudeUsageDay => ({
  day: date,
  ...bucket({ input: tokens }, { costUsd: tokens / 1e6 }),
});

function overview(
  over: Partial<ClaudeUsageOverview> = {},
): ClaudeUsageOverview {
  return {
    rangeDays: 30,
    filesScanned: 12,
    truncated: false,
    totals: bucket(
      {
        input: 1_200_000,
        output: 340_000,
        cacheRead: 45_000_000,
        cacheWrite: 2_100_000,
      },
      { messages: 321, costUsd: 18.456 },
    ),
    days: [day("2026-11-03", 1_000_000), day("2026-11-04", 3_000_000)],
    projects: [
      {
        name: "api",
        detail: "D:\\work\\api",
        lastDay: "2026-11-04",
        ...bucket({ input: 3_000_000 }, { costUsd: 12 }),
      },
      {
        name: "web",
        detail: "D:\\work\\web",
        lastDay: "2026-11-03",
        ...bucket({ input: 1_000_000 }, { costUsd: 4.5 }),
      },
    ],
    models: [
      {
        name: "claude-fable-5",
        ...bucket({ input: 4_000_000 }, { costUsd: 16.5 }),
      },
    ],
    sources: [
      { name: "默认登录", ...bucket({ input: 3_000_000 }) },
      { name: "工作号", detail: "a1b2", ...bucket({ input: 1_000_000 }) },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  api.usageOverview.mockResolvedValue(overview());
});

describe("number formats", () => {
  it("shortens token counts", () => {
    expect(compact(0)).toBe("0");
    expect(compact(999)).toBe("999");
    expect(compact(1_000)).toBe("1K");
    expect(compact(1_234)).toBe("1.2K");
    expect(compact(34_500)).toBe("34.5K");
    expect(compact(345_000)).toBe("345K");
    expect(compact(3_400_000)).toBe("3.4M");
    expect(compact(2_100_000_000)).toBe("2.1B");
  });

  it("shows an estimate as a lower bound when a model had no price", () => {
    expect(money(bucket({}, { costUsd: 18.456 }))).toBe("$18.46");
    expect(money(bucket({}, { costUsd: 0.0123 }))).toBe("$0.012");
    expect(money(bucket({}, { costUsd: 250.4 }))).toBe("$250");
    expect(money(bucket({}, { costUsd: 3, costPartial: true }))).toBe(
      "≥ $3.00",
    );
    expect(money(bucket({}, { costUsd: 0, costPartial: true }))).toBe("—");
    expect(
      bucketTokens(
        bucket({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
      ),
    ).toBe(10);
  });
});

describe("heatmapWeeks", () => {
  // Wednesday 4 November 2026.
  const today = new Date(2026, 10, 4);

  it("lays weeks out as columns, Monday first, ending with this week", () => {
    const weeks = heatmapWeeks([], 30, today);
    for (const column of weeks) expect(column).toHaveLength(7);
    const first = weeks[0][0].day;
    expect(new Date(`${first}T00:00:00`).getDay()).toBe(1);
    const last = weeks[weeks.length - 1];
    expect(last.map((cell) => cell.day)).toContain("2026-11-04");
    expect(last[6].day).toBe("2026-11-08");
    // Days after today are in the grid but not counted.
    expect(last[6].inRange).toBe(false);
    expect(last[2].inRange).toBe(true);
  });

  it("keeps only the chosen range inside the grid", () => {
    const week = heatmapWeeks([], 7, today);
    const inside = week.flat().filter((cell) => cell.inRange);
    expect(inside).toHaveLength(7);
    expect(inside[0].day).toBe("2026-10-29");
    expect(inside[6].day).toBe("2026-11-04");
  });

  it("scales the shade by the busiest day and leaves empty days empty", () => {
    const weeks = heatmapWeeks(
      [
        day("2026-11-02", 100),
        day("2026-11-03", 1_000_000),
        day("2026-11-04", 4_000_000),
      ],
      30,
      today,
    );
    const cells = new Map(weeks.flat().map((cell) => [cell.day, cell]));
    expect(cells.get("2026-11-04")?.level).toBe(4);
    expect(cells.get("2026-11-03")?.level).toBe(2);
    expect(cells.get("2026-11-02")?.level).toBe(1);
    expect(cells.get("2026-11-01")?.level).toBe(0);
  });

  it("for everything, starts at the first day with use and stops at a year", () => {
    const some = heatmapWeeks([day("2026-09-01", 5)], null, today);
    expect(some[0].some((cell) => cell.day === "2026-08-31")).toBe(true);
    const old = heatmapWeeks([day("2020-01-01", 5)], null, today);
    expect(old).toHaveLength(53);
    expect(heatmapWeeks([], null, today).length).toBeGreaterThan(0);
  });
});

describe("usageFacts", () => {
  it("counts active days, the busiest day and the longest run", () => {
    const facts = usageFacts([
      day("2026-11-01", 100),
      day("2026-11-02", 300),
      day("2026-11-03", 200),
      day("2026-11-05", 50),
      day("2026-11-06", 0),
    ]);
    expect(facts.activeDays).toBe(4);
    expect(facts.busiest?.day).toBe("2026-11-02");
    expect(facts.longestStreak).toBe(3);
    expect(facts.perActiveDay).toBeCloseTo(162.5);
  });

  it("has nothing to say about no use", () => {
    expect(usageFacts([])).toEqual({
      activeDays: 0,
      perActiveDay: 0,
      busiest: undefined,
      longestStreak: 0,
    });
  });
});

describe("day labels", () => {
  it("names days for people and lists the last days oldest first", () => {
    expect(dayLabel("2026-11-04")).toBe("11月4日");
    expect(dayLabel("2026-01-09")).toBe("1月9日");
    expect(lastDays(3, new Date(2026, 10, 4))).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
    expect(lastDays(2, new Date(2026, 0, 1))).toEqual([
      "2025-12-31",
      "2026-01-01",
    ]);
  });
});

describe("ClaudeUsageCard", () => {
  it("shows totals, the calendar and the biggest projects", async () => {
    render(<ClaudeUsageCard defaultOpen />);
    expect(await screen.findByText("$18.46")).toBeInTheDocument();
    expect(screen.getByText("321")).toBeInTheDocument();
    expect(screen.getByText("45M")).toBeInTheDocument();
    expect(screen.getByText("1.2M")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "最近 30 天每天的用量" }),
    ).toBeInTheDocument();
    const projects = screen.getByRole("list", { name: "项目" });
    expect(within(projects).getByText("api")).toBeInTheDocument();
    expect(within(projects).getByText("D:\\work\\api")).toBeInTheDocument();
    expect(within(projects).getByText("$12.00")).toBeInTheDocument();
    expect(api.usageOverview).toHaveBeenCalledWith(30);
    expect(screen.getByText(/读取了 12 个会话文件/)).toBeInTheDocument();
  });

  it("regroups by model and by account, and asks again for another range", async () => {
    render(<ClaudeUsageCard defaultOpen />);
    await screen.findByText("$18.46");
    fireEvent.click(screen.getByRole("tab", { name: "模型" }));
    expect(
      within(screen.getByRole("list", { name: "模型" })).getByText(
        "claude-fable-5",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "账号" }));
    const sources = screen.getByRole("list", { name: "账号" });
    expect(within(sources).getByText("工作号")).toBeInTheDocument();
    // An account's id is not something to show.
    expect(within(sources).queryByText("a1b2")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "全部" }));
    await waitFor(() =>
      expect(api.usageOverview).toHaveBeenLastCalledWith(null),
    );
    fireEvent.click(screen.getByRole("radio", { name: "7 天" }));
    await waitFor(() => expect(api.usageOverview).toHaveBeenLastCalledWith(7));
    expect(screen.getByRole("radio", { name: "7 天" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("shows the first ones and lets the rest be expanded", async () => {
    api.usageOverview.mockResolvedValue(
      overview({
        projects: Array.from({ length: 11 }, (_, i) => ({
          name: `p${i}`,
          detail: `D:\\p${i}`,
          lastDay: "2026-11-04",
          ...bucket({ input: 1000 - i }),
        })),
      }),
    );
    render(<ClaudeUsageCard defaultOpen />);
    const list = await screen.findByRole("list", { name: "项目" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "显示全部 11 项" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(11);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
  });

  it("says when there is nothing to count", async () => {
    api.usageOverview.mockResolvedValue(
      overview({
        totals: bucket({}, { messages: 0 }),
        days: [],
        projects: [],
        models: [],
        sources: [],
      }),
    );
    render(<ClaudeUsageCard defaultOpen />);
    expect(
      await screen.findByText("这段时间里没有 Claude Code 的会话记录。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "全部" }));
    expect(
      await screen.findByText("还没有找到 Claude Code 的会话记录。"),
    ).toBeInTheDocument();
  });

  it("flags a partial count and a partial price", async () => {
    api.usageOverview.mockResolvedValue(
      overview({
        truncated: true,
        totals: bucket(
          { input: 5_000_000 },
          { messages: 9, costUsd: 3, costPartial: true },
        ),
      }),
    );
    render(<ClaudeUsageCard defaultOpen />);
    expect(await screen.findByText("≥ $3.00")).toBeInTheDocument();
    expect(screen.getByText(/文件太多，只统计了一部分/)).toBeInTheDocument();
  });

  it("shows the reason and retries when counting fails", async () => {
    api.usageOverview.mockRejectedValueOnce(new Error("IO 错误: 拒绝访问"));
    render(<ClaudeUsageCard defaultOpen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("拒绝访问");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("$18.46")).toBeInTheDocument();
  });

  it("ignores a slow answer for a range that is no longer chosen", async () => {
    let finishSlow: (value: ClaudeUsageOverview) => void = () => {};
    api.usageOverview.mockImplementationOnce(
      () => new Promise((resolve) => (finishSlow = resolve)),
    );
    api.usageOverview.mockResolvedValueOnce(
      overview({ totals: bucket({ input: 7 }, { messages: 7, costUsd: 7 }) }),
    );
    render(<ClaudeUsageCard defaultOpen />);
    await waitFor(() => expect(api.usageOverview).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("radio", { name: "7 天" }));
    expect(await screen.findByText("$7.00")).toBeInTheDocument();
    finishSlow(overview());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("$18.46")).toBeNull();
    expect(screen.getByText("$7.00")).toBeInTheDocument();
  });

  it("counts nothing until it is opened, and remembers being opened", async () => {
    const { unmount } = render(<ClaudeUsageCard />);
    expect(
      screen.getByRole("button", { name: /展开用量总览/ }),
    ).toHaveAttribute("aria-expanded", "false");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.usageOverview).not.toHaveBeenCalled();
    expect(screen.queryByRole("radiogroup")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /展开用量总览/ }));
    expect(await screen.findByText("$18.46")).toBeInTheDocument();
    expect(api.usageOverview).toHaveBeenCalledTimes(1);
    unmount();

    // Next visit: still open.
    render(<ClaudeUsageCard />);
    expect(await screen.findByText("$18.46")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /收起用量总览/ }));
    expect(screen.queryByText("$18.46")).toBeNull();
    expect(window.localStorage.getItem("chimera.claude.usage.open")).toBe("0");
  });

  it("shows bars for a short range and a calendar with facts for a long one", async () => {
    render(<ClaudeUsageCard defaultOpen />);
    expect(
      await screen.findByRole("img", { name: "最近 30 天每天的用量" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /热力图/ })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "90 天" }));
    expect(
      await screen.findByRole("img", { name: /每日用量热力图/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("活跃天数")).toBeInTheDocument();
    expect(screen.getByText("最长连续")).toBeInTheDocument();
    expect(screen.getByText("最忙的一天")).toBeInTheDocument();
  });

  it("needs the desktop app", () => {
    render(<ClaudeUsageCard native={false} />);
    expect(screen.getByText("用量总览需要在桌面端使用。")).toBeInTheDocument();
    expect(api.usageOverview).not.toHaveBeenCalled();
  });
});
