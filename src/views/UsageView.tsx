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
  History,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Table2,
  X,
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
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConversationUsageSection } from "@/components/usage/ConversationUsageSection";
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
  ConversationUsageReport,
  DailyStats,
  ModelStats,
  SessionSyncResult,
  UsageSummary,
} from "@/types/usage";

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const USAGE_TOP_MODEL_COUNT = 3;

const usageRangeTitles: Record<UsageRange, string> = {
  today: "今日",
  "7d": "近 7 天",
  "30d": "近 30 天",
};

/** Placeholder bar heights (%) while the first statistics load. */
const SKELETON_BARS = [42, 64, 50, 78, 36, 58, 46];

/** Typing pauses this long before the title search asks the backend. */
const CONVERSATION_SEARCH_DELAY_MS = 250;

export function topModelsByTokens(
  models: ModelStats[],
  count = USAGE_TOP_MODEL_COUNT,
): ModelStats[] {
  return [...models]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, count);
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
  const [sessionFiles, setSessionFiles] = useState<number | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildDialogOpen, setRebuildDialogOpen] = useState(false);
  const [rebuildResult, setRebuildResult] =
    useState<CodexUsageRebuildResult | null>(null);
  const [rebuildError, setRebuildError] = useState("");
  const [rangeLoading, setRangeLoading] = useState(false);
  const [conversations, setConversations] =
    useState<ConversationUsageReport | null>(null);
  const [conversationsAvailable, setConversationsAvailable] =
    useState(runningInTauri);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationQuery, setConversationQuery] = useState("");
  const [syncNote, setSyncNote] = useState(
    runningInTauri
      ? "正在读取 Codex 本机会话记录"
      : "浏览器预览不会读取本机会话数据",
  );
  const sessionSync = useRef<Promise<SessionSyncResult> | null>(null);
  const initialLoad = useRef(false);
  const requestId = useRef(0);
  const conversationRequest = useRef(0);
  const latestRange = useRef(range);
  const latestConversationQuery = useRef(conversationQuery);
  const fetchedConversationQuery = useRef("");
  const mounted = useRef(true);
  latestRange.current = range;
  latestConversationQuery.current = conversationQuery;

  const loadConversations = useCallback(async (start: number, end: number) => {
    const nextId = ++conversationRequest.current;
    const query = latestConversationQuery.current.trim();
    fetchedConversationQuery.current = query;
    setConversationsLoading(true);
    try {
      const report = await usageApi.getUsageByConversation(
        start,
        end,
        query || undefined,
      );
      if (nextId !== conversationRequest.current) return;
      setConversations(report);
      setConversationsAvailable(true);
    } catch {
      // The summary is optional: while the backend keeps it off, or when it
      // fails, the section disappears instead of reporting an error.
      if (nextId !== conversationRequest.current) return;
      setConversations(null);
      setConversationsAvailable(false);
    } finally {
      if (nextId === conversationRequest.current)
        setConversationsLoading(false);
    }
  }, []);

  const loadStats = useCallback(
    async (selectedRange: UsageRange, nextRequestId: number) => {
      const { start, end } = usageWindow(selectedRange);
      void loadConversations(start, end);
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
    [loadConversations],
  );

  const finishSync = useCallback(
    (promise: Promise<SessionSyncResult>) => {
      void promise.then(
        (result) => {
          if (!mounted.current || sessionSync.current !== promise) return;
          sessionSync.current = null;
          setSyncing(false);
          setSyncError(false);
          setSessionFiles(result.filesScanned);
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
      conversationRequest.current += 1;
    };
  }, []);

  useEffect(() => {
    const sync = !initialLoad.current;
    initialLoad.current = true;
    void loadUsage(range, sync);
  }, [loadUsage, range]);

  useEffect(() => {
    const query = conversationQuery.trim();
    const timer = window.setTimeout(() => {
      if (query === fetchedConversationQuery.current) return;
      const { start, end } = usageWindow(latestRange.current);
      void loadConversations(start, end);
    }, CONVERSATION_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [conversationQuery, loadConversations]);

  const rebuildUsage = useCallback(async () => {
    if (!runningInTauri || rebuilding) return;
    setRebuildDialogOpen(false);
    setRebuilding(true);
    setRebuildError("");
    setRebuildResult(null);
    try {
      const result = await usageApi.rebuildCodexUsage();
      setRebuildResult(result);
      setSessionFiles(result.filesScanned);
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
  const hasData = summary !== null && summary.totalRequests > 0;
  // A failed first load shows its error banner, not an "empty" verdict.
  const showSkeleton = !hasData && busy && runningInTauri;
  const showEmpty = !hasData && !busy && (summary !== null || !runningInTauri);
  const bucketUnit = loadedHourly ? "小时" : "天";
  const activeBuckets = trends
    .filter((day) => day.requestCount > 0 || totalDailyTokens(day) > 0)
    .reverse();
  const emptyTitle = !runningInTauri
    ? "浏览器预览不读取本机会话记录"
    : sessionFiles === 0
      ? "本机还没有 Codex 会话记录"
      : `${usageRangeTitles[displayedRange]}没有 Codex 用量记录`;
  const conversationNote = !summary
    ? "等待同步"
    : conversationsAvailable
      ? conversations
        ? `${conversations.totalConversations.toLocaleString("zh-CN")} 个对话`
        : "正在汇总…"
      : `${activeBuckets.length} ${bucketUnit}有用量`;

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
      new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }),
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
          disabled={!hasData}
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
          <strong>{summary ? formatUsageTokens(total) : "—"}</strong>
          <small>
            {syncing
              ? "正在后台同步本机会话记录，已有数据仍可查看…"
              : syncError
                ? syncNote
                : summary
                  ? summary.totalRequests
                    ? `请求 ${summary.totalRequests.toLocaleString("zh-CN")} 次 · 成功率 ${summary.successRate.toFixed(1)}%`
                    : "暂无请求记录"
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
            {hasData
              ? `${conversationsAvailable ? "子代理并入 · " : ""}缓存命中 ${(summary.cacheHitRate * 100).toFixed(0)}%`
              : "缓存命中 —"}
          </span>
        </div>
        <div className="usage-status-step">
          <i />
          <b>
            {conversationsAvailable
              ? "按对话"
              : loadedHourly
                ? "按小时"
                : "按日"}
          </b>
          <span>{conversationNote}</span>
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
          <strong>{loadedHourly ? "每小时词元" : "每日词元"}</strong>
          <span>按输入、输出、缓存分段</span>
        </div>
        <div className="usage-toolbar-actions">
          <button
            className={tableMode ? "is-active" : ""}
            onClick={() => setTableMode((value) => !value)}
            disabled={!hasData}
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

      {showSkeleton && (
        <section
          className="usage-analysis-grid usage-skeleton"
          aria-hidden="true"
        >
          <div className="usage-chart-card">
            <div className="usage-bars">
              {SKELETON_BARS.map((height, index) => (
                <div className="usage-bar-column" key={index}>
                  <div className="usage-bar" style={{ height: `${height}%` }} />
                </div>
              ))}
            </div>
          </div>
          <div className="usage-model-card">
            {SKELETON_BARS.slice(0, 3).map((width, index) => (
              <span
                className="usage-skeleton-line"
                key={index}
                style={{ width: `${width + 20}%` }}
              />
            ))}
          </div>
        </section>
      )}

      {showEmpty && (
        <section
          className="usage-empty-state"
          aria-labelledby="usage-empty-title"
        >
          <span className="usage-empty-icon" aria-hidden="true">
            <History size={20} />
          </span>
          <div>
            <h2 id="usage-empty-title">{emptyTitle}</h2>
            <p>
              {runningInTauri
                ? "用量来自 Codex 在本机保存的会话记录。用 Codex 完成一次对话后，点“刷新”即可看到。"
                : "在 Chimera++ 应用里打开用量页，即可查看本机记录。"}
            </p>
          </div>
          {runningInTauri && (
            <button
              type="button"
              className="usage-export"
              onClick={() => void loadUsage(range, true)}
            >
              <RefreshCw size={15} /> 刷新
            </button>
          )}
        </section>
      )}

      {hasData && summary && (
        <section className="usage-analysis-grid">
          <div className="usage-chart-card">
            {tableMode ? (
              <div
                className="usage-daily-table"
                role="table"
                aria-label="每日词元表格"
              >
                <div className="usage-daily-row usage-daily-head">
                  <span>{loadedHourly ? "时段" : "日期"}</span>
                  <span>请求</span>
                  <span>总词元</span>
                  <span>输入 / 输出</span>
                </div>
                {trends.slice(-14).map((day) => (
                  <div className="usage-daily-row" key={day.date}>
                    <span>{usageBucketLabel(day.date, loadedHourly)}</span>
                    <span>{day.requestCount}</span>
                    <b>{formatUsageTokens(totalDailyTokens(day))}</b>
                    <span>
                      {formatUsageTokens(day.totalInputTokens)} /{" "}
                      {formatUsageTokens(day.totalOutputTokens)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="usage-bars"
                role="img"
                aria-label={loadedHourly ? "每小时词元图" : "每日词元图"}
              >
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
                      <strong>{formatUsageTokens(value)}</strong>
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
                        {usageBucketLabel(day.date, loadedHourly).replace(
                          "/",
                          "-",
                        )}
                      </small>
                    </div>
                  );
                })}
                {!days.some((day) => totalDailyTokens(day) > 0) && (
                  <div className="usage-chart-empty">
                    最近 {days.length} {bucketUnit}没有用量
                  </div>
                )}
              </div>
            )}
            <footer>
              <span>总计 {formatUsageTokens(total)} · 含缓存</span>
              <span>
                请求 {summary.totalRequests.toLocaleString("zh-CN")} · 成功率{" "}
                {summary.successRate.toFixed(1)}%
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
                    <span>{formatUsageTokens(model.totalTokens)}</span>
                    <em>{(ratio * 100).toFixed(0)}%</em>
                  </div>
                );
              })
            ) : (
              <p className="usage-chart-empty">暂无模型统计</p>
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
      )}

      {hasData && conversationsAvailable && (
        <ConversationUsageSection
          report={conversations}
          loading={conversationsLoading}
          query={conversationQuery}
          onQueryChange={setConversationQuery}
        />
      )}

      {hasData && summary && (
        <section
          className="usage-summary-section"
          aria-labelledby="usage-daily-title"
        >
          <header>
            <div>
              <h2 id="usage-daily-title">
                {loadedHourly ? "按小时汇总" : "按日汇总"}
              </h2>
              <span>只列出有请求的{loadedHourly ? "时段" : "日期"}</span>
            </div>
            <span>
              全部 {summary.totalRequests.toLocaleString("zh-CN")} 次请求
            </span>
          </header>
          <div className="usage-summary-scroll" tabIndex={0}>
            <table className="usage-summary-table">
              <caption className="sr-only">
                {loadedHourly ? "按小时词元汇总" : "按日词元汇总"}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{loadedHourly ? "时段" : "日期"}</th>
                  <th scope="col">请求数</th>
                  <th scope="col">总词元</th>
                  <th scope="col">输入</th>
                  <th scope="col">输出</th>
                  <th scope="col">缓存</th>
                </tr>
              </thead>
              <tbody>
                {activeBuckets.map((day) => (
                  <tr key={day.date}>
                    <th scope="row">
                      {loadedHourly
                        ? usageBucketLabel(day.date, true)
                        : day.date.slice(0, 10)}
                    </th>
                    <td>{day.requestCount.toLocaleString("zh-CN")}</td>
                    <td>
                      <b>{formatUsageTokens(totalDailyTokens(day))}</b>
                    </td>
                    <td>{formatUsageTokens(day.totalInputTokens)}</td>
                    <td>{formatUsageTokens(day.totalOutputTokens)}</td>
                    <td>
                      {formatUsageTokens(
                        day.totalCacheCreationTokens + day.totalCacheReadTokens,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Dialog open={allModelsOpen} onOpenChange={setAllModelsOpen}>
        <DialogContent className="usage-all-models">
          <DialogHeader>
            <DialogTitle>全部模型排行</DialogTitle>
            <DialogDescription>
              共 {models.length} 个模型 · 按当前范围内的真实词元总量排序。
            </DialogDescription>
            <DialogClose
              className="usage-models-close"
              aria-label="关闭模型排行"
            >
              <X size={18} />
            </DialogClose>
          </DialogHeader>
          <div className="usage-all-models-head" aria-hidden="true">
            <span>模型</span>
            <span>总词元</span>
            <span>占比</span>
          </div>
          <div className="usage-all-models-list">
            {topModelsByTokens(models, models.length).map((model, index) => (
              <div className="usage-model-item" key={model.model}>
                <span
                  className="usage-model-rank"
                  aria-label={`第 ${index + 1} 名`}
                >
                  {index + 1}
                </span>
                <div>
                  <strong title={model.model}>{model.model}</strong>
                  <code>{exact(model.totalTokens)}</code>
                </div>
                <span>{formatUsageTokens(model.totalTokens)}</span>
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
            ? `统计加载完成，累计 ${formatUsageTokens(total)} 词元`
            : "浏览器预览不会读取本机会话数据"}
      </div>
    </section>
  );
}
