import "./UsageView.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CircleAlert,
  DatabaseBackup,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  MoreHorizontal,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
  UsageSummary,
  SessionSyncResult,
} from "@/types/usage";

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** How many models the 模型词元分布 panel shows. */
export const USAGE_TOP_MODEL_COUNT = 3;

/**
 * Rank models by the quantity the panel actually renders — tokens.
 *
 * The backend sorts by `total_cost DESC` (correct for the cost-columned
 * ModelStatsTable, so it is not changed there). Taking the first N of that
 * order here ranked by *cost* while the panel is labelled 模型词元分布 and
 * prints 词元 counts, so a cheap-but-chatty model outranked an expensive-but-
 * quiet one on screen. Worse, a model with no pricing entry has cost 0 and can
 * never enter the top N no matter how many tokens it burns — which makes the
 * panel look like a hardcoded model list.
 *
 * Sorted copy, not in place: the caller's array is React state.
 */
export function topModelsByTokens(
  models: ModelStats[],
  count = USAGE_TOP_MODEL_COUNT,
): ModelStats[] {
  return [...models]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, count);
}

export function UsageView() {
  const gradientId = useId().replace(/:/g, "");
  const [allModelsOpen, setAllModelsOpen] = useState(false);
  const [loadedRange, setLoadedRange] = useState<UsageRange>("30d");
  const [hourly, setHourly] = useState(false);
  const sessionSync = useRef<Promise<SessionSyncResult> | null>(null);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [trends, setTrends] = useState<DailyStats[]>([]);
  const [models, setModels] = useState<ModelStats[]>([]);
  const [range, setRange] = useState<"today" | "7d" | "30d">("30d");
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(runningInTauri);
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
  const initialUsageLoadStarted = useRef(false);
  const usageRequestId = useRef(0);

  const loadUsage = useCallback(
    async (selectedRange: "today" | "7d" | "30d", syncSessions: boolean) => {
      const requestId = ++usageRequestId.current;
      if (!runningInTauri) {
        setSummary(null);
        setTrends([]);
        setModels([]);
        setSyncing(false);
        setRangeLoading(false);
        setSyncNote("浏览器预览不会读取本机会话数据");
        return;
      }
      if (syncSessions) setSyncing(true);
      else setRangeLoading(true);
      setError("");
      if (syncSessions || sessionSync.current) {
        try {
          if (!sessionSync.current)
            sessionSync.current = usageApi.syncCodexSessionUsage();
          const result = await sessionSync.current;
          if (requestId !== usageRequestId.current) return;
          sessionSync.current = null;
          setSyncNote(
            result.errors.length
              ? `已读取 ${result.filesScanned} 个文件，${result.errors.length} 项未能导入`
              : `已同步 ${result.filesScanned} 个本机会话文件`,
          );
        } catch (reason) {
          if (requestId !== usageRequestId.current) return;
          sessionSync.current = null;
          setSyncNote("本机会话同步失败，正在显示已有记录");
          setError(String(reason));
        }
      }
      const { start, end } = usageWindow(selectedRange);
      try {
        const [nextSummary, nextTrends, nextModels] = await Promise.all([
          usageApi.getUsageSummary(start, end, "codex"),
          usageApi.getUsageTrends(start, end, "codex"),
          usageApi.getModelStats(start, end, "codex"),
        ]);
        if (requestId !== usageRequestId.current) return;
        setLoadedRange(selectedRange);
        // Match the backend duration threshold, including 25-hour DST days.
        setHourly(end - start <= 86400);
        setSummary(nextSummary);
        setTrends(nextTrends);
        // Keep every model: the top-N slice happens at render time, and the
        // percentage denominator needs the full set to be a real share.
        setModels(nextModels);
      } catch (reason) {
        if (requestId !== usageRequestId.current) return;
        setError(String(reason));
      } finally {
        if (requestId === usageRequestId.current) {
          setSyncing(false);
          setRangeLoading(false);
        }
      }
    },
    [],
  );

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
      setRebuildError(message);
      setError(message);
      toast.error("Codex 用量重建失败", {
        description:
          "旧数据库已在重建前尝试备份，可直接重试或从设置中恢复备份。",
        closeButton: true,
      });
    } finally {
      setRebuilding(false);
    }
  }, [loadUsage, range, rebuilding]);

  useEffect(() => {
    const shouldSyncSessions = !initialUsageLoadStarted.current;
    initialUsageLoadStarted.current = true;
    void loadUsage(range, shouldSyncSessions);
    return () => {
      usageRequestId.current += 1;
    };
  }, [loadUsage, range]);

  const busy = syncing || rangeLoading || rebuilding;
  const total = summary?.realTotalTokens ?? 0;
  const input = summary?.totalInputTokens ?? 0;
  const output = summary?.totalOutputTokens ?? 0;
  const cache =
    (summary?.totalCacheCreationTokens ?? 0) +
    (summary?.totalCacheReadTokens ?? 0);
  const chartTrends = trends.map((item) => ({
    ...item,
    totalTokens: totalDailyTokens(item),
  }));
  const modelTotal = models.reduce((sum, item) => sum + item.totalTokens, 0);
  const topModels = topModelsByTokens(models);
  const peak = chartTrends.reduce<(typeof chartTrends)[number] | null>(
    (best, item) =>
      !best || item.totalTokens > best.totalTokens ? item : best,
    null,
  );
  const hasRecords = summary !== null && summary.totalRequests > 0;
  const exact = (value: number) => `${value.toLocaleString("zh-CN")} 词元`;
  const modelUnit = modelTotal >= 10000 ? ("万" as const) : undefined;
  const renderModel = (item: ModelStats) => {
    const ratio = modelTotal > 0 ? (item.totalTokens / modelTotal) * 100 : 0;
    return (
      <div className="usage-spectrum-model" key={item.model}>
        <div className="usage-model-name" title={item.model}>
          {item.model}
        </div>
        <div className="usage-model-value">
          <strong title={exact(item.totalTokens)}>
            {formatUsageTokens(item.totalTokens, modelUnit)}
          </strong>
          <span>
            {ratio.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%
          </span>
        </div>
        <div className="usage-model-track" aria-hidden="true">
          <div style={{ width: `${ratio}%` }} />
        </div>
      </div>
    );
  };
  const rebuildBackupName = rebuildResult?.backupPath
    ? rebuildResult.backupPath.split(/[\\/]/).pop()
    : null;
  return (
    <section className="usage-surface usage-spectrum" aria-label="词元统计">
      <div className="usage-heading">
        <div>
          <h1>词元消耗</h1>
          <p>
            {rebuilding
              ? "正在备份并重建…"
              : syncing
                ? "正在同步本机会话记录…"
                : `${syncNote}，所有数据仅保存在这台电脑。`}
          </p>
        </div>
        <div className="usage-toolbar">
          <button
            className="usage-refresh"
            onClick={() => void loadUsage(range, true)}
            disabled={!runningInTauri || busy}
            aria-label="同步词元记录"
            title="同步词元记录"
          >
            <RefreshCw
              size={18}
              className={syncing || rebuilding ? "spin" : ""}
            />
          </button>
          <div className="range-segment" role="group" aria-label="统计时间范围">
            {(
              [
                ["today", "今日"],
                ["7d", "7 天"],
                ["30d", "30 天"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={range === id ? "is-active" : ""}
                onClick={() => setRange(id)}
                disabled={rebuilding}
                aria-pressed={range === id}
              >
                {label}
              </button>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="usage-more"
                disabled={rebuilding}
                aria-label="更多统计操作"
                title="更多统计操作"
              >
                <MoreHorizontal size={20} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => setRebuildDialogOpen(true)}
                disabled={!runningInTauri || busy}
              >
                <RotateCcw size={16} /> 重建用量
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {rebuildResult && (
        <div className="usage-rebuild-result is-success" role="status">
          <ShieldCheck size={16} />
          <div>
            <strong>重建完成</strong>
            <span>
              扫描 {rebuildResult.filesScanned} 个文件，导入{" "}
              {rebuildResult.imported} 条，跳过 {rebuildResult.skipped} 条
              {rebuildResult.suspectedDuplicates
                ? `，识别 ${rebuildResult.suspectedDuplicates} 条疑似重复记录`
                : ""}
              {rebuildResult.errors.length
                ? `，另有 ${rebuildResult.errors.length} 项未能导入`
                : "。"}
            </span>
            <small title={rebuildResult.backupPath ?? undefined}>
              <DatabaseBackup size={12} />
              {rebuildBackupName
                ? `重建前备份：${rebuildBackupName}`
                : "首次运行尚无旧数据库，无需创建备份"}
            </small>
          </div>
        </div>
      )}
      {rebuildError && (
        <div className="usage-rebuild-result is-error" role="alert">
          <CircleAlert size={16} />
          <div>
            <strong>重建未完成</strong>
            <span>{rebuildError}</span>
            <button onClick={() => setRebuildDialogOpen(true)}>重新尝试</button>
          </div>
        </div>
      )}
      {error && (
        <div className="usage-load-error" role="alert">
          <CircleAlert size={18} />
          <span>
            无法更新统计。
            {summary
              ? `保留上次成功结果（${usageRangeLabels[loadedRange]}）。`
              : "尚无可显示的统计。"}
            <small>{error}</small>
          </span>
          <button onClick={() => void loadUsage(range, true)} disabled={busy}>
            重试
          </button>
        </div>
      )}
      <div className="sr-only" role="status">
        {busy ? "正在更新统计" : "统计加载完成"}
      </div>
      <article className="usage-spectrum-panel" aria-busy={busy}>
        <section className="usage-spectrum-summary" aria-label="词元总量与构成">
          {[
            [
              "累计词元",
              total,
              `${usageRangeLabels[summary ? loadedRange : range]} · 含缓存`,
            ],
            [
              "非缓存输入",
              input,
              total
                ? `${((input / total) * 100).toFixed(1)}% · 占总量`
                : "0% · 占总量",
            ],
            [
              "输出词元",
              output,
              total
                ? `${((output / total) * 100).toFixed(1)}% · 占总量`
                : "0% · 占总量",
            ],
            [
              "缓存词元",
              cache,
              total
                ? `${((cache / total) * 100).toFixed(1)}% · 占总量`
                : "0% · 占总量",
            ],
          ].map(([label, value, description]) => (
            <div className="usage-metric" key={label}>
              <span>{label}</span>
              <strong title={summary ? exact(Number(value)) : undefined}>
                {summary ? formatUsageTokens(Number(value)) : "—"}
              </strong>
              <small>{summary || !error ? description : "尚未加载"}</small>
            </div>
          ))}
        </section>
        <section
          className="usage-spectrum-trend"
          aria-label={hourly ? "每小时词元消耗光谱" : "每日词元消耗光谱"}
        >
          <header>
            <h2>{hourly ? "每小时" : "每日"}消耗光谱</h2>
            <span>
              {peak && hasRecords
                ? `${usageBucketLabel(peak.date, hourly)} 峰值 ${formatUsageTokens(peak.totalTokens)}`
                : "峰值 —"}
            </span>
          </header>
          <div className="usage-spectrum-chart">
            {hasRecords && chartTrends.length ? (
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 1012, height: 174 }}
              >
                <BarChart
                  data={chartTrends}
                  margin={{ top: 8, right: 0, bottom: 0, left: 0 }}
                  accessibilityLayer
                >
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#a7a6ff" />
                      <stop offset="100%" stopColor="#525da2" />
                    </linearGradient>
                    <linearGradient
                      id={`${gradientId}-peak`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor="#d4c2ff" />
                      <stop offset="100%" stopColor="#6e61b1" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="#b9c9ed22" />
                  <XAxis
                    dataKey="date"
                    axisLine={false}
                    tickLine={false}
                    minTickGap={36}
                    ticks={usageTrendTicks(chartTrends)}
                    interval={
                      chartTrends.length > 7 ? "preserveStartEnd" : undefined
                    }
                    tick={{ fill: "#bac7de", fontSize: 13 }}
                    tickFormatter={(date) => usageBucketLabel(date, hourly)}
                  />
                  <YAxis
                    width={58}
                    axisLine={false}
                    tickLine={false}
                    tickCount={3}
                    tick={{ fill: "#bac7de", fontSize: 13 }}
                    tickFormatter={(value) => formatUsageTokens(Number(value))}
                  />
                  <Tooltip
                    cursor={{ fill: "#ffffff0a" }}
                    content={({ active, payload }) => {
                      const day = payload?.[0]?.payload as
                        (typeof chartTrends)[number] | undefined;
                      return active && day ? (
                        <div className="usage-chart-tooltip" role="status">
                          <strong>
                            {day.date
                              .replace("T", " ")
                              .slice(0, hourly ? 16 : 10)}
                          </strong>
                          <b>总计 {exact(day.totalTokens)}</b>
                          <span>非缓存输入 {exact(day.totalInputTokens)}</span>
                          <span>输出 {exact(day.totalOutputTokens)}</span>
                          <span>
                            缓存{" "}
                            {exact(
                              day.totalCacheCreationTokens +
                                day.totalCacheReadTokens,
                            )}
                          </span>
                          <span>
                            {day.requestCount.toLocaleString("zh-CN")} 次请求
                          </span>
                        </div>
                      ) : null;
                    }}
                  />
                  <Bar
                    dataKey="totalTokens"
                    name="总词元"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={28}
                    isAnimationActive={false}
                  >
                    {chartTrends.map((day) => (
                      <Cell
                        key={day.date}
                        fill={`url(#${day === peak ? `${gradientId}-peak` : gradientId})`}
                        style={
                          day === peak
                            ? { filter: "drop-shadow(0 0 6px #aa8aff66)" }
                            : undefined
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="chart-empty" role="status">
                <strong>
                  {busy
                    ? "正在读取统计…"
                    : error && !summary
                      ? "统计暂时不可用"
                      : "当前时间范围暂无记录"}
                </strong>
                <span>
                  {!runningInTauri
                    ? "请在桌面应用中同步本机会话"
                    : busy
                      ? "加载后将展示真实消耗"
                      : "可切换时间范围或同步词元记录"}
                </span>
              </div>
            )}
          </div>
          <footer>
            <span>{hourly ? "每小时" : "每日"}总量 · 含缓存</span>
            <span>
              {summary
                ? `${summary.totalRequests.toLocaleString("zh-CN")} 次请求 · ${summary.totalRequests ? `${summary.successRate.toFixed(1)}% 成功` : "成功率 —"}`
                : "请求数 — · 成功率 —"}
            </span>
          </footer>
        </section>
        <section className="usage-model-section" aria-label="模型词元分布">
          <header>
            <h2>模型排行</h2>
            <div>
              <span>按非缓存输入 + 输出</span>
              <button
                onClick={() => setAllModelsOpen(true)}
                disabled={!models.length}
              >
                查看全部 <ArrowRight size={15} />
              </button>
            </div>
          </header>
          <div className="usage-spectrum-models">
            {topModels.length ? (
              topModels.map(renderModel)
            ) : (
              <p className="usage-model-empty">
                {busy
                  ? "正在读取模型统计…"
                  : error && !summary
                    ? "模型统计暂时不可用"
                    : "暂无模型统计"}
              </p>
            )}
          </div>
        </section>
      </article>
      <Dialog open={allModelsOpen} onOpenChange={setAllModelsOpen}>
        <DialogContent className="usage-all-models">
          <DialogHeader>
            <DialogTitle>全部模型排行</DialogTitle>
            <DialogDescription>
              按非缓存输入 +
              输出排序，占比以当前范围内全部模型为分母，不含缓存。
            </DialogDescription>
          </DialogHeader>
          <div className="usage-all-models-list">
            {topModelsByTokens(models, models.length).map(renderModel)}
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        isOpen={rebuildDialogOpen}
        title="重建 Codex 用量？"
        message={
          "Chimera++ 会先备份当前数据库，再清理仅来自 Codex 会话的用量数据并重新扫描。\n\n代理记录和其他本地数据不会被删除。重建期间请勿退出应用。"
        }
        confirmText="备份并重建"
        cancelText="取消"
        variant="destructive"
        onConfirm={() => void rebuildUsage()}
        onCancel={() => setRebuildDialogOpen(false)}
      />
    </section>
  );
}
