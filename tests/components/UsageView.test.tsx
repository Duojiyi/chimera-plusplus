import { StrictMode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { UsageView } from "@/views/UsageView";
import { usageApi } from "@/lib/api/usage";
import * as usageMetrics from "@/utils/usageMetrics";
import type {
  DailyStats,
  ModelStats,
  SessionSyncResult,
  UsageSummary,
} from "@/types/usage";

vi.mock("@/components/usage/UsageDashboard", () => ({
  UsageDashboard: ({ refreshIntervalMs }: { refreshIntervalMs: number }) => (
    <div data-testid="advanced-usage-dashboard">
      refresh:{refreshIntervalMs}
    </div>
  ),
}));

const originalTauri = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(
    window,
    "__TAURI_INTERNALS__",
  );
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  return descriptor;
});
vi.mock("@/lib/api/usage", () => ({
  usageApi: {
    syncCodexSessionUsage: vi.fn(),
    getUsageSummary: vi.fn(),
    getUsageTrends: vi.fn(),
    getModelStats: vi.fn(),
    rebuildCodexUsage: vi.fn(),
  },
}));
const api = vi.mocked(usageApi);
const sync: SessionSyncResult = {
  filesScanned: 2,
  imported: 4,
  skipped: 0,
  suspectedDuplicates: 0,
  deferredFiles: 0,
  errors: [],
};
const summary: UsageSummary = {
  totalRequests: 4,
  totalCost: "0",
  totalInputTokens: 600,
  totalOutputTokens: 400,
  totalCacheCreationTokens: 200,
  totalCacheReadTokens: 800,
  realTotalTokens: 2000,
  successRate: 100,
  cacheHitRate: 0.5,
};
const day: DailyStats = {
  date: "2026-09-18",
  requestCount: 4,
  totalCost: "0",
  totalTokens: 1000,
  totalInputTokens: 600,
  totalOutputTokens: 400,
  totalCacheCreationTokens: 200,
  totalCacheReadTokens: 800,
};
const models: ModelStats[] = [100, 400, 200, 300].map((totalTokens) => ({
  model: `model-${totalTokens}`,
  totalTokens,
  totalCost: totalTokens === 400 ? "0" : "9",
  requestCount: 1,
  avgCostPerRequest: "0",
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function loaded() {
  await waitFor(() => {
    expect(screen.getByText("统计加载完成")).toBeVisible();
    expect(screen.getByRole("button", { name: "同步词元记录" })).toBeEnabled();
  });
}
async function openRebuild(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "更多统计操作" }));
  await user.click(await screen.findByRole("menuitem", { name: "重建用量" }));
  return screen.findByRole("dialog", { name: "重建 Codex 用量？" });
}
beforeEach(() => {
  vi.resetAllMocks();
  api.syncCodexSessionUsage.mockResolvedValue(sync);
  api.getUsageSummary.mockResolvedValue(summary);
  api.getUsageTrends.mockResolvedValue([day]);
  api.getModelStats.mockResolvedValue(models);
  api.rebuildCodexUsage.mockResolvedValue({
    ...sync,
    backupPath: "C:\\backups\\usage.db",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => {
  if (originalTauri)
    Object.defineProperty(window, "__TAURI_INTERNALS__", originalTauri);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("UsageView", () => {
  it("exports CSV with a UTF-8 BOM, real line breaks and six correctly ordered columns", async () => {
    api.getUsageTrends.mockResolvedValue([
      day,
      {
        ...day,
        date: "2026-09-19",
        requestCount: 2,
        totalTokens: 30,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalCacheCreationTokens: 2,
        totalCacheReadTokens: 3,
      },
    ]);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "blob:usage-export");
        static revokeObjectURL = vi.fn();
      },
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const user = userEvent.setup();
    render(<UsageView />);
    await loaded();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/csv;charset=utf-8");
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const bytes = new Uint8Array(buffer);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(Array.from(bytes).filter((byte) => byte === 0x0a)).toHaveLength(2);
    const csv = new TextDecoder().decode(bytes.subarray(3));
    expect(csv).not.toContain("\\n");
    expect(csv).not.toContain("\\ufeff");
    expect(csv.split("\n").map((row) => row.split(","))).toEqual([
      ["日期", "请求数", "总词元", "输入", "输出", "缓存"],
      ["2026-09-18", "4", "2000", "600", "400", "1000"],
      ["2026-09-19", "2", "35", "10", "20", "5"],
    ]);
    expect(click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:usage-export");
  });

  it("queries the same Codex window, includes cache, and uses all models as the ranking denominator", async () => {
    const user = userEvent.setup();
    render(<UsageView />);
    await loaded();
    const args = api.getUsageSummary.mock.calls.at(-1)!;
    expect(args).toEqual([expect.any(Number), expect.any(Number), "codex"]);
    expect(args[0]).toBeLessThan(args[1]!);
    expect(api.getUsageTrends).toHaveBeenLastCalledWith(...args);
    expect(api.getModelStats).toHaveBeenLastCalledWith(...args);
    expect(api.getUsageSummary).toHaveBeenCalledTimes(2);
    const metrics = within(
      screen.getByRole("region", { name: "词元总量与构成" }),
    );
    expect(metrics.getByTitle("2,000 词元")).toHaveTextContent("2,000");
    expect(metrics.getByTitle("1,000 词元")).toHaveTextContent("1,000");
    expect(metrics.getByText("50.0% · 占总量")).toBeVisible();
    expect(screen.getByText("09/18 峰值 2,000 词元")).toBeVisible();
    const ranking = within(
      screen.getByRole("region", { name: "模型词元分布" }),
    );
    expect(
      ranking.getAllByTitle(/^model-/).map((el) => el.textContent),
    ).toEqual(["model-400", "model-300", "model-200"]);
    expect(ranking.getByText("40%")).toBeVisible();
    expect(ranking.queryByText("model-100")).not.toBeInTheDocument();
    await user.click(ranking.getByRole("button", { name: /查看全部/ }));
    const dialog = within(screen.getByRole("dialog", { name: "全部模型排行" }));
    expect(dialog.getAllByTitle(/^model-/).map((el) => el.textContent)).toEqual(
      ["model-400", "model-300", "model-200", "model-100"],
    );
    expect(dialog.getByText("100 词元")).toBeVisible();
    expect(dialog.getByText("400 词元")).toBeVisible();
    const firstModel = dialog
      .getByTitle("model-400")
      .closest(".usage-model-item")!;
    expect(firstModel.children).toHaveLength(4);
    expect(firstModel.firstElementChild).toHaveAttribute(
      "aria-label",
      "第 1 名",
    );
    await user.click(dialog.getByRole("button", { name: "关闭模型排行" }));
    expect(
      screen.queryByRole("dialog", { name: "全部模型排行" }),
    ).not.toBeInTheDocument();
  });

  it("separates daily totals and token categories into labelled table columns", async () => {
    api.getUsageTrends.mockResolvedValue([
      day,
      {
        ...day,
        date: "2026-09-19",
        requestCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
      },
      { ...day, date: "2026-09-20", requestCount: 2 },
    ]);
    render(<UsageView />);
    await loaded();
    const table = within(screen.getByRole("table", { name: "按日词元汇总" }));
    expect(
      table.getAllByRole("columnheader").map((cell) => cell.textContent),
    ).toEqual(["日期", "请求数", "总词元", "输入", "输出", "缓存"]);
    expect(
      table.getAllByRole("rowheader").map((cell) => cell.textContent),
    ).toEqual(["2026-09-20", "2026-09-18"]);
    const row = within(
      table.getByRole("rowheader", { name: "2026-09-18" }).closest("tr")!,
    );
    expect(row.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "4",
      "2,000",
      "600",
      "400",
      "1,000",
    ]);
  });

  it("shows the existing database result while the historical sync is pending", async () => {
    const pending = deferred<SessionSyncResult>();
    api.syncCodexSessionUsage.mockReturnValue(pending.promise);
    render(<UsageView />);

    expect(await screen.findByTitle("2,000 词元")).toBeVisible();
    expect(
      screen.getByText("正在后台同步本机会话记录，已有数据仍可查看…"),
    ).toBeVisible();
    expect(api.getUsageSummary).toHaveBeenCalled();
    expect(api.syncCodexSessionUsage).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve(sync));
    await loaded();
  });

  it.each(["reject", "throw"] as const)(
    "keeps existing statistics visible when session sync %ss",
    async (outcome) => {
      const failure = new Error("history unavailable");
      if (outcome === "reject")
        api.syncCodexSessionUsage.mockRejectedValueOnce(failure);
      else
        api.syncCodexSessionUsage.mockImplementationOnce(() => {
          throw failure;
        });

      render(<UsageView />);
      await loaded();

      expect(screen.getByTitle("2,000 词元")).toBeVisible();
      expect(
        screen.getByText("本机会话同步失败，正在显示已有记录", {
          exact: false,
        }),
      ).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent("无法更新统计");
    },
  );

  it("renders the first and last labels for a sparse 30-day axis", async () => {
    api.getUsageTrends.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        ...day,
        date: new Date(Date.UTC(2026, 7, 20 + index)).toISOString(),
      })),
    );
    render(<UsageView />);
    await loaded();
    for (const label of ["08/20", "08/27", "09/03", "09/10", "09/18"]) {
      expect(screen.getByText(label, { selector: "tspan" })).toBeVisible();
    }
    expect(
      screen.queryByText("08/21", { selector: "tspan" }),
    ).not.toBeInTheDocument();
  });

  it("labels today's buckets by hour and retains the loaded range when switching fails", async () => {
    const user = userEvent.setup();
    render(<UsageView />);
    await loaded();
    api.getUsageTrends.mockResolvedValue([
      { ...day, date: "2026-09-18T09:00:00+08:00" },
    ]);
    expect(screen.getByRole("button", { name: "今日" })).toHaveTextContent(
      "今日",
    );
    await user.click(screen.getByRole("button", { name: "今日" }));
    await loaded();
    expect(screen.getByText("09:00 峰值 2,000 词元")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "每小时消耗光谱" }),
    ).toBeVisible();
    expect(
      screen.getByText("09:00", { selector: "tspan" }),
    ).toBeInTheDocument();
    const args = api.getUsageSummary.mock.calls.at(-1)!;
    expect(api.getUsageTrends).toHaveBeenLastCalledWith(...args);
    expect(api.getModelStats).toHaveBeenLastCalledWith(...args);
    expect(args[2]).toBe("codex");
    expect(new Date(args[0]! * 1000).getHours()).toBe(0);
    api.getUsageSummary.mockRejectedValueOnce(new Error("range offline"));
    await user.click(screen.getByRole("button", { name: "7 天" }));
    await loaded();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "保留上次成功结果（今日）",
    );
    expect(screen.getByText("今日 · 含缓存")).toBeVisible();
    expect(document.querySelector(".usage-status-period")).toHaveTextContent(
      /近 1 天\s*·\s*今日/,
    );
    expect(screen.getByText("09:00 峰值 2,000 词元")).toBeVisible();
    expect(screen.getByRole("button", { name: "7 天" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it.each([86400, 86401, 88200])(
    "uses the backend grain for a %i-second today query and retains it on failed refresh",
    async (duration) => {
      const start = Date.parse("2026-11-01T00:00:00-04:00") / 1000;
      const actualWindow = usageMetrics.usageWindow;
      const windowMock = vi
        .spyOn(usageMetrics, "usageWindow")
        .mockImplementation((range, now) =>
          range === "today"
            ? { start, end: start + duration }
            : actualWindow(range, now),
        );
      const user = userEvent.setup();
      render(<UsageView />);
      await loaded();
      api.getUsageTrends.mockResolvedValue([
        { ...day, date: "2026-11-01T00:00:00-04:00" },
      ]);
      await user.click(screen.getByRole("button", { name: "今日" }));
      await waitFor(() =>
        expect(api.getUsageTrends).toHaveBeenLastCalledWith(
          start,
          start + duration,
          "codex",
        ),
      );
      await loaded();
      expect(api.getUsageTrends).toHaveBeenLastCalledWith(
        start,
        start + duration,
        "codex",
      );
      const hourly = duration <= 86400;
      const heading = hourly ? "每小时消耗光谱" : "每日消耗光谱";
      const label = hourly ? "00:00" : "11/01";
      expect(screen.getByRole("heading", { name: heading })).toBeVisible();
      expect(screen.getByText(label + " 峰值 2,000 词元")).toBeVisible();
      expect(screen.getByText(label, { selector: "tspan" })).toBeVisible();
      expect(screen.getByText("今日 · 含缓存")).toBeVisible();

      // A new query with the opposite grain must not relabel the retained data.
      windowMock.mockReturnValue({
        start,
        end: start + (hourly ? 88200 : 3600),
      });
      const pending = deferred<UsageSummary>();
      api.syncCodexSessionUsage.mockResolvedValueOnce({ ...sync, imported: 0 });
      api.getUsageSummary.mockReturnValueOnce(pending.promise);
      await user.click(screen.getByRole("button", { name: "同步词元记录" }));
      expect(screen.getByRole("heading", { name: heading })).toBeVisible();
      await act(async () => pending.reject(new Error("refresh offline")));
      await loaded();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "保留上次成功结果（今日）",
      );
      expect(screen.getByText("今日 · 含缓存")).toBeVisible();
      expect(screen.getByRole("heading", { name: heading })).toBeVisible();
      expect(screen.getByText(label + " 峰值 2,000 词元")).toBeVisible();
    },
  );

  it("reuses the initial sync across StrictMode effects and range changes", async () => {
    const user = userEvent.setup();
    const pending = deferred<SessionSyncResult>();
    api.syncCodexSessionUsage.mockReturnValue(pending.promise);
    render(
      <StrictMode>
        <UsageView />
      </StrictMode>,
    );
    expect(screen.getAllByText("正在读取统计…")[0]).toBeVisible();
    expect(screen.getByRole("button", { name: "同步词元记录" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(api.syncCodexSessionUsage).toHaveBeenCalledTimes(1);
    expect(api.getUsageSummary).toHaveBeenCalled();
    await act(async () => pending.resolve(sync));
    await loaded();
    expect(api.getUsageSummary).toHaveBeenCalledTimes(4);
    expect(screen.getByText("今日 · 含缓存")).toBeVisible();
    expect(screen.getByRole("button", { name: "同步词元记录" })).toBeEnabled();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a stale request that later %ss",
    async (outcome) => {
      const user = userEvent.setup();
      render(<UsageView />);
      await loaded();
      const stale = deferred<UsageSummary>();
      api.getUsageSummary.mockReturnValueOnce(stale.promise);
      await user.click(screen.getByRole("button", { name: "7 天" }));
      api.getUsageSummary.mockResolvedValueOnce({
        ...summary,
        realTotalTokens: 9000,
      });
      await user.click(screen.getByRole("button", { name: "今日" }));
      await loaded();
      await act(async () => {
        if (outcome === "resolve")
          stale.resolve({ ...summary, realTotalTokens: 7000 });
        else stale.reject(new Error("stale failure"));
      });
      expect(screen.getByTitle("9,000 词元")).toBeVisible();
      expect(screen.getByText("今日 · 含缓存")).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("keeps rebuild behind its menu and confirmation, then reports the backup and reloads", async () => {
    const user = userEvent.setup();
    render(<UsageView />);
    await loaded();
    const dialog = await openRebuild(user);
    expect(dialog).toHaveTextContent("先备份当前数据库");
    expect(dialog).toHaveTextContent("代理记录和其他本地数据不会被删除");
    expect(api.rebuildCodexUsage).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(api.rebuildCodexUsage).not.toHaveBeenCalled();
    const pending =
      deferred<Awaited<ReturnType<typeof usageApi.rebuildCodexUsage>>>();
    api.rebuildCodexUsage.mockReturnValueOnce(pending.promise);
    const confirmed = await openRebuild(user);
    await user.click(
      within(confirmed).getByRole("button", { name: "备份并重建" }),
    );
    expect(api.rebuildCodexUsage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "今日" })).toBeDisabled();
    expect(screen.getByText("正在备份并重建…")).toBeVisible();
    const refresh = screen.getByRole("button", { name: "同步词元记录" });
    expect(refresh).toBeDisabled();
    expect(refresh.querySelector("svg")).toHaveClass("spin");
    expect(screen.getByRole("button", { name: "更多统计操作" })).toBeDisabled();
    await act(async () =>
      pending.resolve({ ...sync, backupPath: "C:\\backups\\usage.db" }),
    );
    expect(await screen.findByText(/重建完成/)).toBeVisible();
    expect(screen.queryByText("正在备份并重建…")).not.toBeInTheDocument();
    expect(refresh).toBeEnabled();
    expect(refresh.querySelector("svg")).not.toHaveClass("spin");
    expect(screen.getByText("重建前备份：usage.db")).toHaveAttribute(
      "title",
      "C:\\backups\\usage.db",
    );
    expect(api.getUsageSummary).toHaveBeenCalledTimes(3);
    expect(api.syncCodexSessionUsage).toHaveBeenCalledTimes(1);
    expect(await openRebuild(user)).toBeVisible();
  });

  it("offers a confirmed retry after rebuild failure without losing previous data", async () => {
    const user = userEvent.setup();
    api.rebuildCodexUsage.mockRejectedValueOnce(new Error("backup failed"));
    render(<UsageView />);
    await loaded();
    const dialog = await openRebuild(user);
    await user.click(
      within(dialog).getByRole("button", { name: "备份并重建" }),
    );
    expect(await screen.findByText(/重建未完成/)).toBeVisible();
    expect(screen.getByTitle("2,000 词元")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重新尝试" }));
    expect(
      screen.getByRole("dialog", { name: "重建 Codex 用量？" }),
    ).toBeVisible();
    expect(api.rebuildCodexUsage).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an initial failure from an empty successful retry", async () => {
    const user = userEvent.setup();
    api.syncCodexSessionUsage.mockResolvedValueOnce({ ...sync, imported: 0 });
    api.getUsageSummary.mockRejectedValueOnce(new Error("offline"));
    render(<UsageView />);
    await loaded();
    expect(screen.getByRole("alert")).toHaveTextContent("尚无可显示的统计");
    expect(
      screen.queryByRole("region", { name: /没有 Codex 用量记录/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("暂无模型统计")).not.toBeInTheDocument();
    api.getUsageSummary.mockResolvedValue({
      ...summary,
      totalRequests: 0,
      realTotalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    });
    api.getUsageTrends.mockResolvedValue([]);
    api.getModelStats.mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: "重试" }));
    await loaded();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: /没有 Codex 用量记录/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "按线路模型排行" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出 CSV" })).toBeDisabled();
  });
});

it("does not paint token bars for zero usage", async () => {
  api.getUsageTrends.mockResolvedValue([
    {
      ...day,
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    },
  ]);
  render(<UsageView />);
  await loaded();
  expect(screen.getByText(/最近.*没有用量/)).toBeVisible();
  const bars = document.querySelectorAll<HTMLElement>(".usage-bar");
  expect(bars.length).toBeGreaterThan(0);
  bars.forEach((bar) => expect(bar.style.height).toBe("0%"));
});

it("opens existing cost and request tools only on demand, with polling off", async () => {
  render(<UsageView />);
  expect(
    screen.queryByTestId("advanced-usage-dashboard"),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "成本、计价与请求明细" }),
  );
  expect(
    await screen.findByTestId("advanced-usage-dashboard"),
  ).toHaveTextContent("refresh:0");
  await userEvent.click(
    screen.getByRole("button", { name: "收起成本与请求明细" }),
  );
  expect(
    screen.queryByTestId("advanced-usage-dashboard"),
  ).not.toBeInTheDocument();
});
