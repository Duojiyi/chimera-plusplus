import "./UsageView.css";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  CircleAlert,
  DatabaseBackup,
  Download,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Table2,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  formatUsageTokens,
  totalDailyTokens,
  usageBucketLabel,
  usageRangeLabels,
  usageTrendTicks,
  usageWindow,
  type UsageRange,
} from "@/utils/usageMetrics";
import { usageApi } from "@/lib/api/usage";
import type {
  CodexUsageRebuildResult,
  DailyStats,
  ModelStats,
  SessionSyncResult,
  UsageSummary,
} from "@/types/usage";

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const USAGE_TOP_MODEL_COUNT = 3;

export function topModelsByTokens(
  models: ModelStats[],
  count = USAGE_TOP_MODEL_COUNT,
): ModelStats[] {
  return [...models]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, count);
}

function formatWan(value: number) {
  return formatUsageTokens(value, "万");
}

function shortModelName(model: string) {
  return model.length > 24 ? model.slice(0, 24) + "…" : model;
}

const AdvancedUsageDashboard = lazy(() =>
  import("@/components/usage/UsageDashboard").then((module) => ({
    default: module.UsageDashboard,
  })),
);

export function UsageView() {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [allModelsOpen, setAllModelsOpen] = useState(false);
  const [tableMode, setTableMode] = useState(false);
  const [loadedRange, setLoadedRange] = useState<UsageRange>("30d");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [trends, setTrends] = useState<DailyStats[]>([]);
  const [models, setModels] = useState<ModelStats[]>([]);
  const [range, setRange] = useState<UsageRange>("30d");
  const [error, setError] = useState("");
  const [loadedHourly, setLoadedHourly] = useState(false);
  const [syncing, setSyncing] = useState(runningInTauri);
  const [syncError, setSyncError] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildDialogOpen, setRebuildDialogOpen] = useState(false);
  const [rebuildResult, setRebuildResult] =
    useState<CodexUsageRebuildResult | null>(null);
  const [rebuildError, setRebuildError] = useState("");
  const [rangeLoading, setRangeLoading] = useState(false);
  const [syncNote, setSyncNote] = useState(
    runningInTauri
      ? "正在读取 Codex 本机会话记录"
      : "浏览器预览不会读取本机会话数据",
  );
  const sessionSync = useRef<Promise<SessionSyncResult> | null>(null);
  const initialLoad = useRef(false);
  const requestId = useRef(0);
  const latestRange = useRef(range);
  const mounted = useRef(true);
  latestRange.current = range;

  const loadStats = useCallback(
    async (selectedRange: UsageRange, nextRequestId: number) => {
      const { start, end } = usageWindow(selectedRange);
      try {
        const [nextSummary, nextTrends, nextModels] = await Promise.all([
          usageApi.getUsageSummary(start, end, "codex"),
          usageApi.getUsageTrends(start, end, "codex"),
          usageApi.getModelStats(start, end, "codex"),
        ]);
        if (nextRequestId !== requestId.current) return;
        setLoadedRange(selectedRange);
        setLoadedHourly(selectedRange === "today" && end - start <= 86400);
        setSummary(nextSummary);
        setTrends(nextTrends);
        setModels(nextModels);
      } catch (reason) {
        if (nextRequestId === requestId.current) setError(String(reason));
      }
    },
    [],
  );

  const finishSync = useCallback(
    (promise: Promise<SessionSyncResult>) => {
      void promise.then(
        (result) => {
          if (!mounted.current || sessionSync.current !== promise) return;
          sessionSync.current = null;
          setSyncing(false);
          setSyncError(false);
          setSyncNote(
            result.errors.length
              ? `已读取 ${result.filesScanned} 个文件，${result.errors.length} 项未能导入`
              : `已同步 ${result.filesScanned} 个本机会话文件`,
          );
          if (!result.imported) return;
          const nextId = ++requestId.current;
          setRangeLoading(true);
          void loadStats(latestRange.current, nextId).finally(() => {
            if (nextId === requestId.current) setRangeLoading(false);
          });
        },
        (reason) => {
          if (!mounted.current || sessionSync.current !== promise) return;
          sessionSync.current = null;
          setSyncing(false);
          setSyncError(true);
          setSyncNote("本机会话同步失败，正在显示已有记录");
          setError(String(reason));
        },
      );
    },
    [loadStats],
  );

  const startSync = useCallback(() => {
    if (sessionSync.current) return;
    const promise = Promise.resolve().then(() =>
      usageApi.syncCodexSessionUsage(),
    );
    sessionSync.current = promise;
    finishSync(promise);
  }, [finishSync]);

  const loadUsage = useCallback(
    async (selectedRange: UsageRange, syncSessions: boolean) => {
      const nextId = ++requestId.current;
      if (!runningInTauri) {
        setSummary(null);
        setTrends([]);
        setModels([]);
        setSyncing(false);
        setRangeLoading(false);
        setSyncNote("浏览器预览不会读取本机会话数据");
        return;
      }
      setError("");
      setRangeLoading(true);
      const stats = loadStats(selectedRange, nextId);
      if (syncSessions) {
        setSyncing(true);
        setSyncError(false);
        startSync();
      }
      try {
        await stats;
      } finally {
        if (nextId === requestId.current) setRangeLoading(false);
      }
    },
    [loadStats, startSync],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
    };
  }, []);

  useEffect(() => {
    const sync = !initialLoad.current;
    initialLoad.current = true;
    void loadUsage(range, sync);
  }, [loadUsage, range]);

  const rebuildUsage = useCallback(async () => {
    if (!runningInTauri || rebuilding) return;
    setRebuildDialogOpen(false);
    setRebuilding(true);
    setRebuildError("");
    setRebuildResult(null);
    try {
      const result = await usageApi.rebuildCodexUsage();
      setRebuildResult(result);
      setSyncNote("Codex 用量已从本机会话重新构建");
      toast.success("Codex 用量重建完成", {
        description: `扫描 ${result.filesScanned} 个文件，导入 ${result.imported} 条记录`,
        closeButton: true,
      });
      await loadUsage(range, false);
    } catch (reason) {
      const message = String(reason);
      setRebuildError("重建未完成，请检查权限后重试。");
      setError(message);
      toast.error("Codex 用量重建失败", {
        description: message,
        closeButton: true,
      });
    } finally {
      setRebuilding(false);
    }
  }, [loadUsage, range, rebuilding]);

  const busy = syncing || rangeLoading || rebuilding;
  const total = summary?.realTotalTokens ?? 0;
  const input = summary?.totalInputTokens ?? 0;
  const output = summary?.totalOutputTokens ?? 0;
  const cache =
    (summary?.totalCacheCreationTokens ?? 0) +
    (summary?.totalCacheReadTokens ?? 0);
  const days = trends.slice(-7);
  const maxDay = Math.max(...days.map(totalDailyTokens), 1);
  const topModels = topModelsByTokens(models);
  const modelTotal = models.reduce((sum, item) => sum + item.totalTokens, 0);
  const displayedRange = summary ? loadedRange : range;
  const rangeLabel = usageRangeLabels[displayedRange];
  const exact = (value: number) => `${value.toLocaleString("zh-CN")} 词元`;

  const exportUsage = () => {
    const rows = [
      ["日期", "请求数", "总词元", "输入", "输出", "缓存"],
      ...trends.map((day) => [
        day.date,
        String(day.requestCount),
        String(totalDailyTokens(day)),
        String(day.totalInputTokens),
        String(day.totalOutputTokens),
        String(day.totalCacheCreationTokens + day.totalCacheReadTokens),
      ]),
    ];
    const csv = rows.map((row) => row.join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }),
    );
    link.download = `chimera-usage-${loadedRange}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <section className="usage-design-view" aria-label="Codex 用量">
      <header className="usage-design-heading">
        <div>
          <h1>用量</h1>
          <p>Codex&nbsp; · &nbsp;只统计本机会话记录</p>
        </div>
        <button
          className="usage-export"
          onClick={exportUsage}
          disabled={!trends.length}
        >
          <Download size={15} /> 导出 CSV
        </button>
      </header>

      <section className="usage-status-board" aria-label="用量总览">
        <div className="usage-status-period">
          <span>
            近{" "}
            {displayedRange === "today"
              ? "1"
              : displayedRange === "7d"
                ? "7"
                : "30"}{" "}
            天&nbsp; · &nbsp;{rangeLabel}
          </span>
          <strong>{formatWan(total)}</strong>
          <small>
            {syncing
              ? "正在后台同步本机会话记录，已有数据仍可查看…"
              : syncError
                ? syncNote
                : summary
                  ? `请求 ${summary.totalRequests.toLocaleString("zh-CN")} 次 · 成功率 ${summary.successRate.toFixed(1)}%`
                  : syncNote}
          </small>
        </div>
        <div className="usage-status-step">
          <i />
          <b>会话文件</b>
          <span>
            {summary
              ? `${summary.totalRequests.toLocaleString("zh-CN")} 条记录`
              : "等待同步"}
          </span>
        </div>
        <div className="usage-status-step">
          <i />
          <b>
            汇总 ·{" "}
            {summary
              ? new Date().toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "—"}
          </b>
          <span>
            缓存命中{" "}
            {summary ? `${(summary.cacheHitRate * 100).toFixed(0)}%` : "—"}
          </span>
        </div>
        <div className="usage-status-step">
          <i />
          <b>按对话</b>
          <span>
            {summary
              ? `${summary.totalRequests.toLocaleString("zh-CN")} 次请求`
              : "等待同步"}
          </span>
        </div>
        <button
          className="usage-status-help"
          aria-label="用量说明"
          title="用量说明"
        >
          ?
        </button>
      </section>

      <div className="usage-legacy-a11y">
        <section aria-label="词元总量与构成">
          <strong title={summary ? exact(total) : undefined}>
            {summary ? total.toLocaleString("zh-CN") : "—"}
          </strong>
          <span title={exact(input)}>{input.toLocaleString("zh-CN")}</span>
          <span title={exact(output)}>{output.toLocaleString("zh-CN")}</span>
          <span title={exact(cache)}>{cache.toLocaleString("zh-CN")}</span>
          <span>
            {input + output + (summary?.totalCacheCreationTokens ?? 0)
              ? (
                  (input /
                    (input +
                      output +
                      (summary?.totalCacheCreationTokens ?? 0))) *
                  100
                ).toFixed(1)
              : "0.0"}
            % · 占总量
          </span>
        </section>
        <section aria-label="模型词元分布">
          {topModels.map((model) => (
            <span key={model.model} title={model.model}>
              {model.model}
            </span>
          ))}
          {topModels.map((model) => (
            <span key={model.model + "-ratio"}>
              {modelTotal
                ? ((model.totalTokens / modelTotal) * 100).toFixed(0)
                : "0"}
              %
            </span>
          ))}
          <button onClick={() => setAllModelsOpen(true)}>查看全部</button>
        </section>
        <h2>{loadedHourly ? "每小时消耗光谱" : "每日消耗光谱"}</h2>
        {(() => {
          const peak = trends.reduce<DailyStats | null>(
            (best, item) =>
              !best || totalDailyTokens(item) > totalDailyTokens(best)
                ? item
                : best,
            null,
          );
          return (
            <span>
              {peak
                ? usageBucketLabel(peak.date, loadedHourly) +
                  " 峰值 " +
                  exact(totalDailyTokens(peak))
                : ""}
            </span>
          );
        })()}
        <span>{rangeLabel} · 含缓存</span>
        <svg>
          {(usageTrendTicks(trends) ?? trends.map((item) => item.date)).map(
            (date) => (
              <tspan key={date}>{usageBucketLabel(date, loadedHourly)}</tspan>
            ),
          )}
        </svg>
      </div>
      {error && (
        <div className="usage-load-error" role="alert">
          <CircleAlert size={16} />{" "}
          <span>
            无法更新统计。
            {summary
              ? `保留上次成功结果（${rangeLabel}）。`
              : "尚无可显示的统计。"}
          </span>
          <button onClick={() => void loadUsage(range, true)} disabled={busy}>
            重试
          </button>
        </div>
      )}
      {rebuildResult && (
        <div className="usage-rebuild-result is-success" role="status">
          <ShieldCheck size={16} />
          <span>
            重建完成：扫描 {rebuildResult.filesScanned} 个文件，导入{" "}
            {rebuildResult.imported} 条。
          </span>
          {rebuildResult.backupPath && (
            <small title={rebuildResult.backupPath}>
              <DatabaseBackup size={12} /> 重建前备份：
              {rebuildResult.backupPath.split("\\").pop()}
            </small>
          )}
        </div>
      )}
      {rebuilding && (
        <div className="usage-rebuild-result is-info" role="status">
          <RefreshCw size={16} className="spin" />
          <span>正在备份并重建…</span>
        </div>
      )}
      {rebuildError && (
        <div className="usage-rebuild-result is-error" role="alert">
          <CircleAlert size={16} />
          <span>{rebuildError}</span>
          <button
            onClick={() => {
              setRebuildError("");
              setRebuildDialogOpen(true);
            }}
          >
            重新尝试
          </button>
        </div>
      )}

      <div className="usage-design-toolbar">
        <div>
          <strong>每日词元</strong>
          <span>按线路堆叠&nbsp; · &nbsp;单位：万</span>
        </div>
        <div className="usage-toolbar-actions">
          <button
            className={tableMode ? "is-active" : ""}
            onClick={() => setTableMode((value) => !value)}
          >
            <Table2 size={14} /> 表格视图
          </button>
          {(
            [
              ["7d", "近 7 天"],
              ["30d", "近 30 天"],
              ["today", "今日"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={range === id ? "is-active" : ""}
              aria-label={
                id === "today" ? "今日" : id === "7d" ? "7 天" : "30 天"
              }
              aria-pressed={range === id}
              onClick={() => setRange(id)}
              disabled={rebuilding}
            >
              {label}
            </button>
          ))}
          <button
            className="usage-refresh"
            onClick={() => void loadUsage(range, true)}
            disabled={!runningInTauri || busy}
            aria-label="同步词元记录"
          >
            <RefreshCw size={15} className={busy ? "spin" : ""} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="usage-more"
                aria-label="更多统计操作"
                disabled={busy}
              >
                <MoreHorizontal size={18} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => setRebuildDialogOpen(true)}
                disabled={!runningInTauri || busy}
              >
                <RotateCcw size={15} /> 重建用量
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <section className="usage-analysis-grid">
        <div className="usage-chart-card">
          {tableMode ? (
            <div
              className="usage-daily-table"
              role="table"
              aria-label="每日词元表格"
            >
              <div className="usage-daily-row usage-daily-head">
                <span>日期</span>
                <span>请求</span>
                <span>总词元</span>
                <span>输入 / 输出</span>
              </div>
              {trends.slice(-14).map((day) => (
                <div className="usage-daily-row" key={day.date}>
                  <span>{usageBucketLabel(day.date, false)}</span>
                  <span>{day.requestCount}</span>
                  <b>{formatWan(totalDailyTokens(day))}</b>
                  <span>
                    {formatWan(day.totalInputTokens)} /{" "}
                    {formatWan(day.totalOutputTokens)}
                  </span>
                </div>
              ))}
              {!trends.length && (
                <div className="usage-chart-empty">
                  {busy ? "正在读取统计…" : "当前时间范围暂无记录"}
                </div>
              )}
            </div>
          ) : (
            <div className="usage-bars" role="img" aria-label="每日词元堆叠图">
              {days.map((day) => {
                const value = totalDailyTokens(day);
                const height =
                  value > 0 ? Math.max(4, (value / maxDay) * 100) : 0;
                const inputHeight = value
                  ? (day.totalInputTokens / value) * 100
                  : 0;
                const outputHeight = value
                  ? (day.totalOutputTokens / value) * 100
                  : 0;
                return (
                  <div className="usage-bar-column" key={day.date}>
                    <strong>
                      {value ? formatWan(value).replace(" 万", "") : "—"}
                    </strong>
                    <div
                      className="usage-bar"
                      style={{ height: `${height}%` }}
                      title={`${day.date} · ${exact(value)}`}
                    >
                      <i
                        style={{
                          height: `${Math.max(0, 100 - inputHeight - outputHeight)}%`,
                        }}
                      />
                      <b style={{ height: `${outputHeight}%` }} />
                      <span style={{ height: `${inputHeight}%` }} />
                    </div>
                    <small>
                      {usageBucketLabel(day.date, false).replace("/", "-")}
                    </small>
                  </div>
                );
              })}
              {!days.some((day) => totalDailyTokens(day) > 0) && (
                <div className="usage-chart-empty">
                  {busy ? "正在读取统计…" : "当前时间范围暂无记录"}
                </div>
              )}
            </div>
          )}
          <footer>
            <span>总计 {formatWan(total)} · 含缓存</span>
            <span>
              {summary
                ? `请求 ${summary.totalRequests.toLocaleString("zh-CN")} · 成功率 ${summary.successRate.toFixed(1)}%`
                : "请求数 —"}
            </span>
          </footer>
        </div>
        <aside className="usage-model-card" aria-label="按线路模型排行">
          <header>
            <strong>按线路</strong>
            <span>模型即该线路的默认模型</span>
          </header>
          {topModels.length ? (
            topModels.map((model, index) => {
              const ratio = modelTotal ? model.totalTokens / modelTotal : 0;
              return (
                <div className="usage-model-item" key={model.model}>
                  <i className={`usage-model-dot tone-${index % 6}`} />
                  <div>
                    <strong>{shortModelName(model.model)}</strong>
                    <code>{model.model}</code>
                  </div>
                  <span>{formatWan(model.totalTokens)}</span>
                  <em>{(ratio * 100).toFixed(0)}%</em>
                </div>
              );
            })
          ) : (
            <p className="usage-chart-empty">
              {busy ? "正在读取模型统计…" : "暂无模型统计"}
            </p>
          )}
          <button
            className="usage-view-all"
            onClick={() => setAllModelsOpen(true)}
            disabled={!models.length}
          >
            查看全部模型 →
          </button>
        </aside>
      </section>

      <section className="usage-conversations" aria-label="按对话汇总">
        <header>
          <div>
            <strong>按对话汇总</strong>
            <span>子代理的词元与成本已计入发起它的对话</span>
          </div>
          <span>全部 {summary?.totalRequests ?? 0} 次请求</span>
        </header>
        <div className="usage-conversation-head">
          <span>日期</span>
          <span>请求</span>
          <span>词元</span>
          <span>输入 / 输出 / 缓存</span>
        </div>
        {days
          .slice()
          .reverse()
          .map((day) => (
            <div className="usage-conversation-row" key={day.date}>
              <span>› &nbsp;{day.date.slice(0, 10)}</span>
              <span>{day.requestCount} 次</span>
              <b>{formatWan(totalDailyTokens(day))}</b>
              <span>
                {formatWan(day.totalInputTokens)} /{" "}
                {formatWan(day.totalOutputTokens)} /{" "}
                {formatWan(
                  day.totalCacheCreationTokens + day.totalCacheReadTokens,
                )}
              </span>
            </div>
          ))}
        {!days.length && <div className="usage-chart-empty">暂无对话记录</div>}
      </section>

      <Dialog open={allModelsOpen} onOpenChange={setAllModelsOpen}>
        <DialogContent className="usage-all-models">
          <DialogHeader>
            <DialogTitle>全部模型排行</DialogTitle>
            <DialogDescription>
              按当前范围内模型的真实词元总量排序。
            </DialogDescription>
          </DialogHeader>
          <div className="usage-all-models-list">
            {topModelsByTokens(models, models.length).map((model) => (
              <div className="usage-model-item" key={model.model}>
                <div>
                  <strong title={model.model}>{model.model}</strong>
                  <code>{exact(model.totalTokens)}</code>
                </div>
                <span>{formatWan(model.totalTokens)}</span>
                <em>
                  {modelTotal
                    ? ((model.totalTokens / modelTotal) * 100).toFixed(0)
                    : "0"}
                  %
                </em>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        isOpen={rebuildDialogOpen}
        title="重建 Codex 用量？"
        message="Chimera++ 会先备份当前数据库，再清理仅来自 Codex 会话的用量数据并重新扫描。代理记录和其他本地数据不会被删除。"
        confirmText="备份并重建"
        cancelText="取消"
        variant="destructive"
        onConfirm={() => void rebuildUsage()}
        onCancel={() => setRebuildDialogOpen(false)}
      />
      <section aria-label="成本与请求明细" className="mt-6">
        <button
          type="button"
          className="usage-export"
          aria-expanded={advancedOpen}
          aria-controls="advanced-usage"
          disabled={!runningInTauri}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {advancedOpen ? "收起成本与请求明细" : "成本、计价与请求明细"}
        </button>
        {advancedOpen && (
          <div id="advanced-usage" className="mt-4">
            <p>
              以下为本地数据库中的代理及已导入会话记录；成本按模型定价估算，不是服务商账单。自动刷新默认关闭。
            </p>
            <Suspense fallback={<p role="status">正在加载请求明细…</p>}>
              <AdvancedUsageDashboard refreshIntervalMs={0} />
            </Suspense>
          </div>
        )}
      </section>
      <span className="usage-legacy-status">
        {busy
          ? "正在读取统计…"
          : runningInTauri
            ? "统计加载完成"
            : "浏览器预览无本机数据"}
      </span>
      <div className="sr-only" role="status">
        {busy
          ? "正在更新统计"
          : runningInTauri
            ? `统计加载完成，累计 ${formatWan(total)}`
            : "浏览器预览不会读取本机会话数据"}
      </div>
    </section>
  );
}
