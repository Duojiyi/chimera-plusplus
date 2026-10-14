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
  ChevronRight,
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
import { HelpTip } from "@/components/ui/help-tip";
import { ConversationUsageSection } from "@/components/usage/ConversationUsageSection";
import { UsageCoverageNote } from "@/components/usage/UsageCoverageNote";
import { formatTokenCell } from "@/components/usage/format";
import {
  formatUsageDateTime,
  formatUsageTokens,
  totalDailyTokens,
  usageBucketLabel,
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
const RANGE_OPTIONS: UsageRange[] = ["today", "7d", "30d"];

/** More buckets than this get thin bars, no value labels and a sparse axis. */
const DENSE_BUCKETS = 14;

/** Placeholder bar heights (%) while the first statistics load. */
const SKELETON_BARS = [42, 64, 50, 78, 36, 58, 46];
const SKELETON_LINES = [78, 64, 52];

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

const n = (value: number) => value.toLocaleString("zh-CN");
const exact = (value: number) => `${n(value)} 词元`;
const share = (part: number, whole: number) =>
  `${whole ? ((part / whole) * 100).toFixed(0) : "0"}%`;
const clock = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

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
  // When the numbers on screen were read, not when the page last rendered.
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [range, setRange] = useState<UsageRange>("30d");
  const [statsError, setStatsError] = useState("");
  const [loadedHourly, setLoadedHourly] = useState(false);
  const [syncing, setSyncing] = useState(runningInTauri);
  const [syncFailure, setSyncFailure] = useState("");
  const [sessionFiles, setSessionFiles] = useState<number | null>(null);
  const [coverage, setCoverage] = useState<SessionSyncResult | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildDialogOpen, setRebuildDialogOpen] = useState(false);
  const [rebuildResult, setRebuildResult] =
    useState<CodexUsageRebuildResult | null>(null);
  const [rebuildError, setRebuildError] = useState("");
  const [rangeLoading, setRangeLoading] = useState(false);
  const [conversations, setConversations] =
    useState<ConversationUsageReport | null>(null);
  // Off until a report arrives: this build keeps the per-conversation summary
  // switched off, and the page must not announce a grouping it cannot show.
  const [conversationsAvailable, setConversationsAvailable] = useState(false);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationQuery, setConversationQuery] = useState("");
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
        setLoadedAt(Date.now());
        setStatsError("");
      } catch (reason) {
        if (nextRequestId === requestId.current) setStatsError(String(reason));
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
          setSyncFailure("");
          setSessionFiles(result.filesScanned);
          setCoverage(result);
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
          setSyncFailure(String(reason));
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
        return;
      }
      setRangeLoading(true);
      const stats = loadStats(selectedRange, nextId);
      if (syncSessions) {
        setSyncing(true);
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
      setCoverage(result);
      toast.success("Codex 用量重建完成", {
        description: `扫描 ${n(result.filesScanned)} 个文件，导入 ${n(result.imported)} 条记录`,
        closeButton: true,
      });
      await loadUsage(range, false);
    } catch (reason) {
      const message = String(reason);
      setRebuildError(message);
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
  const topModels = topModelsByTokens(models);
  const modelTotal = models.reduce((sum, item) => sum + item.totalTokens, 0);
  const displayedRange = summary ? loadedRange : range;
  const hasData = summary !== null && summary.totalRequests > 0;
  const showSkeleton = !summary && busy && runningInTauri;
  // A failed first load shows its error banner, not an "empty" verdict.
  const showEmpty = !hasData && (summary !== null || !runningInTauri);
  const bucketUnit = loadedHourly ? "小时" : "天";
  const activeBuckets = trends
    .filter((day) => day.requestCount > 0 || totalDailyTokens(day) > 0)
    .reverse();
  const dense = trends.length > DENSE_BUCKETS;
  const maxBucket = Math.max(...trends.map(totalDailyTokens), 1);
  const axisLabels = new Set(
    dense
      ? (usageTrendTicks(trends) ?? [])
      : trends.map((bucket) => bucket.date),
  );
  const peak = trends.reduce<DailyStats | null>(
    (best, item) =>
      totalDailyTokens(item) > (best ? totalDailyTokens(best) : 0)
        ? item
        : best,
    null,
  );
  const rangeStatus =
    rangeLoading && summary && range !== loadedRange
      ? `正在加载 ${usageRangeTitles[range]} · 下方暂时显示 ${usageRangeTitles[loadedRange]}`
      : "";

  const periodNote = summary
    ? summary.totalRequests
      ? `请求 ${n(summary.totalRequests)} 次 · 成功率 ${summary.successRate.toFixed(1)}%`
      : "暂无请求记录"
    : !runningInTauri
      ? "浏览器预览不读取本机数据"
      : busy
        ? "正在读取…"
        : "暂无统计";
  const filesNote = !runningInTauri
    ? "浏览器预览不读取"
    : syncing
      ? "正在同步…"
      : syncFailure
        ? "同步失败"
        : sessionFiles !== null
          ? `已读取 ${n(sessionFiles)} 个`
          : "等待同步";
  const groupingNote = !summary
    ? "—"
    : conversationsAvailable && conversations
      ? `${n(conversations.totalConversations)} 个对话`
      : `${activeBuckets.length} ${bucketUnit}有用量`;

  const emptyTitle = !runningInTauri
    ? "浏览器预览不读取本机会话记录"
    : sessionFiles === 0
      ? "本机还没有 Codex 会话记录"
      : `${usageRangeTitles[displayedRange]}没有 Codex 用量记录`;
  const emptyText = !runningInTauri
    ? "在 Chimera++ 应用里打开用量页，即可查看本机记录。"
    : sessionFiles === 0
      ? "用量来自 Codex 在本机保存的会话记录。用 Codex 完成一次对话后，点“刷新”即可看到。"
      : "换个时间范围看看，或用 Codex 完成对话后点“刷新”。";

  const failureReasons = [...new Set([statsError, syncFailure])].filter(
    Boolean,
  );
  const failureTitle = statsError
    ? summary
      ? "统计未更新"
      : "无法读取用量统计"
    : "本机会话同步失败";
  const failureDetail = statsError
    ? summary
      ? `下方仍是上次成功读取的结果（${usageRangeTitles[loadedRange]}）。`
      : ""
    : summary
      ? "下方是已导入的记录，可能不是最新。"
      : "";

  const liveStatus = busy
    ? "正在更新统计"
    : !runningInTauri
      ? "浏览器预览不会读取本机会话数据"
      : statsError
        ? summary
          ? "统计未更新，显示上次结果"
          : "无法读取用量统计"
        : summary
          ? `统计加载完成，${usageRangeTitles[loadedRange]}共 ${formatUsageTokens(total)} 词元`
          : "";

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
          <p>Codex · 本机会话记录与本地代理请求</p>
        </div>
        <button
          type="button"
          className="usage-secondary-button"
          onClick={exportUsage}
          disabled={!hasData}
          title={hasData ? "导出所选范围的每日用量" : "没有可导出的用量"}
        >
          <Download size={15} aria-hidden="true" /> 导出 CSV
        </button>
      </header>

      <section
        className="usage-status-board"
        aria-label="用量总览"
        data-signboard=""
      >
        <div className="usage-status-period">
          <span>{usageRangeTitles[displayedRange]}</span>
          <strong title={summary ? exact(total) : undefined}>
            {summary ? formatUsageTokens(total) : "—"}
            {summary && <small>词元</small>}
          </strong>
          <span>{periodNote}</span>
        </div>
        <div className="usage-status-step">
          <i aria-hidden="true" />
          <b>会话文件</b>
          <span>{filesNote}</span>
        </div>
        <div className="usage-status-step">
          <i aria-hidden="true" />
          <b
            title={
              loadedAt
                ? `统计读取于 ${formatUsageDateTime(loadedAt / 1000)}`
                : undefined
            }
          >
            汇总 · {loadedAt ? clock(loadedAt) : "—"}
          </b>
          <span>
            {hasData
              ? `${conversationsAvailable ? "子代理并入 · " : ""}缓存命中 ${(summary.cacheHitRate * 100).toFixed(0)}%`
              : "缓存命中 —"}
          </span>
        </div>
        <div className="usage-status-step">
          <i aria-hidden="true" />
          <b>
            {conversationsAvailable
              ? "按对话"
              : loadedHourly
                ? "按小时"
                : "按日"}
          </b>
          <span>{groupingNote}</span>
        </div>
        <HelpTip title="用量说明" align="end" className="usage-status-help">
          统计 Codex
          本机会话记录和经过本地代理的请求；词元含缓存，按本地时间分日。
        </HelpTip>
      </section>

      {failureReasons.length > 0 && (
        <div className="usage-notice is-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <div className="usage-notice-body">
            <strong>{failureTitle}</strong>
            {failureDetail && <span>{failureDetail}</span>}
            <small>原因：{failureReasons.join("；")}</small>
          </div>
          <button
            type="button"
            className="usage-notice-action"
            onClick={() => void loadUsage(range, true)}
            disabled={busy}
          >
            重试
          </button>
        </div>
      )}
      {rebuilding && (
        <div className="usage-notice is-info" role="status">
          <RefreshCw size={16} className="spin" aria-hidden="true" />
          <div className="usage-notice-body">
            <span>正在备份并重建…</span>
          </div>
        </div>
      )}
      {rebuildResult && (
        <div className="usage-notice is-success" role="status">
          <ShieldCheck size={16} aria-hidden="true" />
          <div className="usage-notice-body">
            <span>
              重建完成：扫描 {n(rebuildResult.filesScanned)} 个文件，导入{" "}
              {n(rebuildResult.imported)} 条记录。
            </span>
            {rebuildResult.backupPath && (
              <small title={rebuildResult.backupPath}>
                <DatabaseBackup size={12} aria-hidden="true" /> 重建前备份：
                {rebuildResult.backupPath.split(/[\\/]/).pop()}
              </small>
            )}
          </div>
          <button
            type="button"
            className="usage-notice-dismiss"
            aria-label="关闭重建结果"
            onClick={() => setRebuildResult(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {rebuildError && (
        <div className="usage-notice is-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <div className="usage-notice-body">
            <strong>重建未完成，原有统计没有改动。</strong>
            <small>原因：{rebuildError}</small>
          </div>
          <button
            type="button"
            className="usage-notice-action"
            onClick={() => {
              setRebuildError("");
              setRebuildDialogOpen(true);
            }}
          >
            重新尝试
          </button>
        </div>
      )}
      <UsageCoverageNote result={coverage} />

      <div className="usage-design-toolbar">
        <div className="usage-toolbar-title">
          <strong>{loadedHourly ? "每小时词元" : "每日词元"}</strong>
          {hasData && !tableMode && !rangeStatus && (
            <ul className="usage-legend" aria-label="图例">
              <li>
                <i className="is-input" aria-hidden="true" />
                输入
              </li>
              <li>
                <i className="is-output" aria-hidden="true" />
                输出
              </li>
              <li>
                <i className="is-cache" aria-hidden="true" />
                缓存
              </li>
            </ul>
          )}
          <p
            className="usage-range-status"
            role="status"
            aria-live="polite"
            title={rangeStatus || undefined}
          >
            {rangeStatus}
          </p>
        </div>
        <div className="usage-toolbar-actions">
          <button
            type="button"
            className="usage-tool-button"
            aria-pressed={tableMode}
            onClick={() => setTableMode((value) => !value)}
            disabled={!hasData}
          >
            <Table2 size={14} aria-hidden="true" /> 表格视图
          </button>
          <div className="usage-range-seg" role="group" aria-label="时间范围">
            {RANGE_OPTIONS.map((id) => (
              <button
                type="button"
                key={id}
                aria-pressed={range === id}
                onClick={() => setRange(id)}
                disabled={rebuilding}
              >
                {usageRangeTitles[id]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="usage-tool-button usage-icon-button"
            onClick={() => void loadUsage(range, true)}
            disabled={!runningInTauri || busy}
            aria-label="刷新用量"
            title="同步本机会话记录并刷新"
          >
            <RefreshCw
              size={15}
              className={busy ? "spin" : ""}
              aria-hidden="true"
            />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="usage-tool-button usage-icon-button"
                aria-label="更多统计操作"
                disabled={busy}
              >
                <MoreHorizontal size={18} aria-hidden="true" />
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
            {SKELETON_LINES.map((width) => (
              <span
                className="usage-skeleton-line"
                key={width}
                style={{ width: `${width}%` }}
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
            <p>{emptyText}</p>
          </div>
          {runningInTauri && (
            <button
              type="button"
              className="usage-secondary-button"
              onClick={() => void loadUsage(range, true)}
              disabled={busy}
            >
              <RefreshCw size={15} aria-hidden="true" /> 刷新
            </button>
          )}
        </section>
      )}

      {hasData && summary && (
        <section
          className={[
            "usage-analysis-grid",
            tableMode && "is-table",
            rangeStatus && "is-stale",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-busy={rangeStatus ? true : undefined}
        >
          <div className="usage-chart-card">
            {tableMode ? (
              <div className="usage-summary-scroll" tabIndex={0}>
                <table className="usage-summary-table">
                  <caption className="sr-only">
                    {loadedHourly ? "每小时词元表格" : "每日词元表格"}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{loadedHourly ? "时段" : "日期"}</th>
                      <th scope="col">请求</th>
                      <th scope="col">总词元</th>
                      <th scope="col">输入</th>
                      <th scope="col">输出</th>
                      <th scope="col">缓存</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trends.map((day) => {
                      const value = totalDailyTokens(day);
                      const idle = !value && !day.requestCount;
                      return (
                        <tr
                          key={day.date}
                          className={idle ? "is-idle" : undefined}
                        >
                          <th scope="row">
                            {usageBucketLabel(day.date, loadedHourly)}
                          </th>
                          <td>{idle ? "—" : n(day.requestCount)}</td>
                          <td>
                            {idle ? "—" : <b>{formatTokenCell(value)}</b>}
                          </td>
                          <td>
                            {idle ? "—" : formatTokenCell(day.totalInputTokens)}
                          </td>
                          <td>
                            {idle
                              ? "—"
                              : formatTokenCell(day.totalOutputTokens)}
                          </td>
                          <td>
                            {idle
                              ? "—"
                              : formatTokenCell(
                                  day.totalCacheCreationTokens +
                                    day.totalCacheReadTokens,
                                )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div
                className={`usage-bars${dense ? " is-dense" : ""}`}
                role="img"
                aria-label={`${usageRangeTitles[loadedRange]}${loadedHourly ? "每小时" : "每日"}词元柱状图${
                  peak
                    ? `，峰值 ${usageBucketLabel(peak.date, loadedHourly)} ${formatUsageTokens(totalDailyTokens(peak))}`
                    : ""
                }`}
              >
                {trends.map((day, index) => {
                  const value = totalDailyTokens(day);
                  const height = value
                    ? Math.max(2, (value / maxBucket) * 100)
                    : 0;
                  const input = value
                    ? (day.totalInputTokens / value) * 100
                    : 0;
                  const output = value
                    ? (day.totalOutputTokens / value) * 100
                    : 0;
                  const cache = value ? Math.max(0, 100 - input - output) : 0;
                  const label = usageBucketLabel(day.date, loadedHourly);
                  const current = index === trends.length - 1;
                  return (
                    <div
                      className={`usage-bar-column${current ? " is-current" : ""}`}
                      key={day.date}
                    >
                      {!dense && (
                        <strong aria-hidden="true">
                          {value ? formatUsageTokens(value) : ""}
                        </strong>
                      )}
                      <div
                        className="usage-bar"
                        style={{ height: `${height}%` }}
                        title={`${label} · ${exact(value)}`}
                      >
                        {cache > 0 && (
                          <span
                            className="is-cache"
                            style={{ height: `${cache}%` }}
                          />
                        )}
                        {output > 0 && (
                          <span
                            className="is-output"
                            style={{ height: `${output}%` }}
                          />
                        )}
                        {input > 0 && (
                          <span
                            className="is-input"
                            style={{ height: `${input}%` }}
                          />
                        )}
                      </div>
                      <small>{axisLabels.has(day.date) ? label : ""}</small>
                    </div>
                  );
                })}
                {!peak && (
                  <div className="usage-chart-empty">
                    {usageRangeTitles[loadedRange]}没有词元用量
                  </div>
                )}
              </div>
            )}
            <footer>
              <span>总计 {formatUsageTokens(total)} 词元 · 含缓存</span>
              {peak && (
                <span>
                  峰值 {usageBucketLabel(peak.date, loadedHourly)} ·{" "}
                  {formatUsageTokens(totalDailyTokens(peak))}
                </span>
              )}
            </footer>
          </div>
          {!tableMode && (
            <aside className="usage-model-card" aria-label="按模型排行">
              <header>
                <strong>按模型</strong>
                <span>按词元总量排序</span>
              </header>
              {topModels.length ? (
                topModels.map((model, index) => (
                  <div className="usage-model-item" key={model.model}>
                    <i
                      className={`usage-model-dot tone-${index % 6}`}
                      aria-hidden="true"
                    />
                    <div>
                      <strong title={model.model}>{model.model}</strong>
                      <small>{n(model.requestCount)} 次请求</small>
                    </div>
                    <span title={exact(model.totalTokens)}>
                      {formatUsageTokens(model.totalTokens)}
                    </span>
                    <em>{share(model.totalTokens, modelTotal)}</em>
                  </div>
                ))
              ) : (
                <p className="usage-model-empty">暂无模型统计</p>
              )}
              <button
                type="button"
                className="usage-view-all"
                onClick={() => setAllModelsOpen(true)}
                disabled={!models.length}
              >
                查看全部 {models.length} 个模型
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </aside>
          )}
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

      {hasData && summary && !tableMode && (
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
            <span>共 {n(summary.totalRequests)} 次请求</span>
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
                    <td>{n(day.requestCount)}</td>
                    <td>
                      <b>{formatTokenCell(totalDailyTokens(day))}</b>
                    </td>
                    <td>{formatTokenCell(day.totalInputTokens)}</td>
                    <td>{formatTokenCell(day.totalOutputTokens)}</td>
                    <td>
                      {formatTokenCell(
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
              共 {models.length} 个模型 · 按{usageRangeTitles[loadedRange]}
              的词元总量（含缓存）排序。
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
                <em>{share(model.totalTokens, modelTotal)}</em>
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
      <section aria-label="成本与请求明细" className="usage-advanced">
        <button
          type="button"
          className="usage-secondary-button usage-advanced-toggle"
          aria-expanded={advancedOpen}
          aria-controls="advanced-usage"
          disabled={!runningInTauri}
          title={runningInTauri ? undefined : "浏览器预览不读取本机数据"}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <ChevronRight size={15} aria-hidden="true" />
          {advancedOpen ? "收起成本与请求明细" : "成本、计价与请求明细"}
        </button>
        {advancedOpen && (
          <div id="advanced-usage" className="usage-advanced-body">
            <Suspense
              fallback={
                <p role="status" className="usage-advanced-loading">
                  正在加载请求明细…
                </p>
              }
            >
              <AdvancedUsageDashboard
                refreshIntervalMs={0}
                initialRange={{ preset: range }}
                initialAppType="codex"
              />
            </Suspense>
          </div>
        )}
      </section>
      <div className="sr-only usage-live-status" role="status">
        {liveStatus}
      </div>
    </section>
  );
}
