import "./UsageView.css";
import "@/theme/v3/usage.css";
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
  History,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
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
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationUsageSection } from "@/components/usage/ConversationUsageSection";
import { UsageCoverageNote } from "@/components/usage/UsageCoverageNote";
import { formatTokenCell } from "@/components/usage/format";
import {
  formatUsageDateTime,
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
  ProviderStats,
  SessionSyncResult,
  UsageSummary,
} from "@/types/usage";
import {
  isUsageDesignPreview,
  USAGE_SAMPLE_MODELS,
  USAGE_SAMPLE_PROVIDERS,
  USAGE_SAMPLE_SESSION_FILES,
  USAGE_SAMPLE_SUMMARY,
  usageSampleTrends,
} from "./UsageView.designSamples";

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const USAGE_TOP_MODEL_COUNT = 5;
/** Lines listed in the 按线路 card before "查看全部". */
const USAGE_TOP_PROVIDER_COUNT = 5;

const usageRangeTitles: Record<UsageRange, string> = {
  today: "今日",
  "7d": "近 7 天",
  "30d": "近 30 天",
};
const RANGE_OPTIONS: UsageRange[] = ["today", "7d", "30d"];

/** More buckets than this get thin bars, no value labels and a sparse axis. */
const DENSE_BUCKETS = 14;

/** Placeholder rows while the first statistics load (design §3.5: 4 rows). */
const SKELETON_ROWS = [0, 1, 2, 3];

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

/** Three significant digits with a K / M / B suffix; exact below 10,000. */
export function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const tokens = Math.round(value);
  if (tokens < 1e4) return n(tokens);
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, unit] of units) {
    if (tokens < size) continue;
    const scaled = Number((tokens / size).toPrecision(3));
    if (scaled >= 1000 && unit !== "B") continue;
    return `${scaled}${unit}`;
  }
  return n(tokens);
}

/** A ranked list shares one unit so its numbers line up (0.89M under 6.14M). */
const listTokens = (value: number, max: number) =>
  max >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : compactTokens(value);

/** 0 / step / … / top, with a round step so the axis reads 0.4M, 0.8M … */
function axisScale(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0] };
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
      .map((m) => m * magnitude)
      .find((s) => s >= raw) ?? raw;
  return { top: step * 4, ticks: [0, 1, 2, 3, 4].map((i) => i * step) };
}
const axisLabel = (value: number, top: number) =>
  value === 0
    ? "0"
    : top >= 1e6
      ? `${Number((value / 1e6).toFixed(2))}M`
      : compactTokens(value);
const usd = (value: string | undefined) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : "—";
};
const exact = (value: number) => `${n(value)} 词元`;
const share = (part: number, whole: number) =>
  `${whole ? ((part / whole) * 100).toFixed(1) : "0.0"}%`;
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
  // Optional: the 按线路 card disappears when the line ranking cannot load.
  const [providers, setProviders] = useState<ProviderStats[] | null>(null);
  const [allProvidersOpen, setAllProvidersOpen] = useState(false);
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

  const loadProviders = useCallback(
    async (start: number, end: number, nextRequestId: number) => {
      try {
        const rows = await Promise.resolve().then(() =>
          usageApi.getProviderStats(start, end, "codex"),
        );
        if (nextRequestId === requestId.current)
          setProviders(Array.isArray(rows) ? rows : null);
      } catch {
        if (nextRequestId === requestId.current) setProviders(null);
      }
    },
    [],
  );

  const loadStats = useCallback(
    async (selectedRange: UsageRange, nextRequestId: number) => {
      const { start, end } = usageWindow(selectedRange);
      void loadConversations(start, end);
      void loadProviders(start, end, nextRequestId);
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
    [loadConversations, loadProviders],
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
        // `?preview=design` shows the §6 baseline so the layout can be
        // reviewed in a browser; nothing is read from or written to disk.
        const sample = isUsageDesignPreview();
        setSummary(sample ? USAGE_SAMPLE_SUMMARY : null);
        setTrends(sample ? usageSampleTrends() : []);
        setModels(sample ? USAGE_SAMPLE_MODELS : []);
        setProviders(sample ? USAGE_SAMPLE_PROVIDERS : null);
        setSessionFiles(sample ? USAGE_SAMPLE_SESSION_FILES : null);
        if (sample) {
          setLoadedRange("30d");
          setLoadedAt(Date.now());
        }
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

  const preview = !runningInTauri && isUsageDesignPreview();
  const busy = syncing || rangeLoading || rebuilding;
  const total = summary?.realTotalTokens ?? 0;
  const topModels = topModelsByTokens(models);
  const modelTotal = models.reduce((sum, item) => sum + item.totalTokens, 0);
  const displayedRange = summary ? loadedRange : range;
  const hasData = summary !== null && summary.totalRequests > 0;
  const showSkeleton = !summary && busy && runningInTauri;
  // A failed first load shows its error banner, not an "empty" verdict.
  const showEmpty = !hasData && (summary !== null || !runningInTauri);
  const activeBuckets = trends
    .filter((day) => day.requestCount > 0 || totalDailyTokens(day) > 0)
    .reverse();
  const dense = trends.length > DENSE_BUCKETS;
  const axis = axisScale(Math.max(...trends.map(totalDailyTokens), 0));
  const todayKey = (() => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  })();
  const failures = summary
    ? Math.max(
        0,
        Math.round((summary.totalRequests * (100 - summary.successRate)) / 100),
      )
    : 0;
  const providerRows = providers
    ? [...providers]
        .filter((row) => row.totalTokens > 0)
        .sort((a, b) => b.totalTokens - a.totalTokens)
    : [];
  const providerTotal = providerRows.reduce(
    (sum, row) => sum + row.totalTokens,
    0,
  );
  const shownProviders = allProvidersOpen
    ? providerRows
    : providerRows.slice(0, USAGE_TOP_PROVIDER_COUNT);
  const providerMax = providerRows[0]?.totalTokens ?? 0;
  const modelMax = topModels[0]?.totalTokens ?? 0;
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

  const filesNote = !runningInTauri
    ? "浏览器预览不读取"
    : syncing
      ? "正在同步…"
      : syncFailure
        ? "同步失败"
        : sessionFiles !== null
          ? `已读取 ${n(sessionFiles)} 个`
          : "等待同步";

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
        : syncFailure
          ? summary
            ? "本机会话同步失败，显示已导入的记录"
            : "本机会话同步失败"
          : summary
            ? `统计加载完成，${usageRangeTitles[loadedRange]}共 ${compactTokens(total)} 词元`
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

  const rangeLocked = rebuilding || preview;
  const chartTitle = loadedHourly ? "每小时词元" : "每日词元";
  const tableName = loadedHourly ? "按小时词元汇总" : "按日词元汇总";
  const totals: {
    label: string;
    value: string;
    title?: string;
    note?: string;
    bad?: boolean;
  }[] = [
    {
      label: "输入",
      value: summary ? compactTokens(summary.totalInputTokens) : "—",
      title: summary ? exact(summary.totalInputTokens) : undefined,
    },
    {
      label: "输出",
      value: summary ? compactTokens(summary.totalOutputTokens) : "—",
      title: summary ? exact(summary.totalOutputTokens) : undefined,
    },
    {
      label: "缓存读",
      value: summary ? compactTokens(summary.totalCacheReadTokens) : "—",
      title: summary ? exact(summary.totalCacheReadTokens) : undefined,
      note: hasData
        ? `缓存命中 ${(summary.cacheHitRate * 100).toFixed(0)}%`
        : "缓存命中 —",
    },
    {
      label: "成本",
      value: summary ? usd(summary.totalCost) : "—",
      title: summary ? "按本机计价表估算；未计价的模型不计入" : undefined,
      note: summary ? "按本机计价表估算" : undefined,
    },
    {
      label: "请求",
      value: summary ? n(summary.totalRequests) : "—",
      note: summary ? `失败 ${n(failures)} 次` : undefined,
      bad: failures > 0,
    },
  ];

  return (
    <section className="usage-design-view" aria-label="Codex 用量">
      <header className="usage-design-heading">
        <div className="usage-heading-text">
          <h1>用量</h1>
          <p className="usage-status-period">
            {usageRangeTitles[displayedRange]} · 数据来自本地代理日志与会话文件
            {runningInTauri && (
              <span className="usage-files-note">
                · 会话文件 <span>{filesNote}</span>
              </span>
            )}
            <HelpTip
              title="用量说明"
              align="start"
              className="usage-status-help"
            >
              统计 Codex
              本机会话记录和经过本地代理的请求；词元含缓存，按本地时间分日。
            </HelpTip>
          </p>
        </div>
        <div className="usage-heading-actions">
          <div className="usage-range-seg" role="group" aria-label="时间范围">
            {RANGE_OPTIONS.map((id) => (
              <button
                type="button"
                key={id}
                aria-pressed={range === id}
                onClick={() => setRange(id)}
                disabled={rangeLocked}
                title={preview ? "设计示例不切换范围" : undefined}
              >
                {usageRangeTitles[id]}
              </button>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="usage-icon-button"
                aria-label="更多统计操作"
                disabled={busy || preview}
              >
                <MoreHorizontal size={16} aria-hidden="true" />
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
          <button
            type="button"
            className="usage-secondary-button"
            onClick={exportUsage}
            disabled={!hasData || preview}
            aria-label="导出 CSV"
            title={
              preview
                ? "设计示例不导出"
                : hasData
                  ? "导出所选范围的每日用量（CSV）"
                  : "没有可导出的用量"
            }
          >
            导出
          </button>
          <button
            type="button"
            className="usage-primary-icon"
            onClick={() => void loadUsage(range, true)}
            disabled={!runningInTauri || busy}
            aria-label="刷新用量"
            title={
              runningInTauri
                ? "同步本机会话记录并刷新"
                : "浏览器预览不读取本机数据"
            }
          >
            <RefreshCw
              size={15}
              className={busy ? "spin" : ""}
              aria-hidden="true"
            />
          </button>
        </div>
      </header>

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

      <section
        className={`usage-totals${rangeStatus ? " is-stale" : ""}`}
        aria-label="用量总览"
      >
        <header className="usage-card-head">
          <strong>总量</strong>
          <span>
            合计{" "}
            <b
              className="usage-mono"
              title={summary ? exact(total) : undefined}
            >
              {summary ? compactTokens(total) : "—"}
            </b>{" "}
            词元 · 含缓存
            {loadedAt && (
              <span
                title={`统计读取于 ${formatUsageDateTime(loadedAt / 1000)}`}
              >
                {" "}
                · {clock(loadedAt)} 读取
              </span>
            )}
          </span>
        </header>
        <dl className="usage-totals-grid">
          {totals.map((cell) => (
            <div className="usage-total" key={cell.label}>
              <dt>{cell.label}</dt>
              <dd>
                {showSkeleton ? (
                  <Skeleton width={72} height={20} radius={6} />
                ) : (
                  <strong className="usage-mono" title={cell.title}>
                    {cell.value}
                  </strong>
                )}
                {cell.note && (
                  <small className={cell.bad ? "is-bad" : undefined}>
                    {cell.note}
                  </small>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {showSkeleton && (
        <section
          className="usage-chart-card usage-skeleton"
          aria-label="正在读取用量"
        >
          <header className="usage-card-head">
            <strong>{chartTitle}</strong>
          </header>
          <div className="usage-skeleton-rows">
            {SKELETON_ROWS.map((row) => (
              <Skeleton key={row} height={row === 0 ? 14 : 10} radius={6} />
            ))}
          </div>
        </section>
      )}

      {showEmpty && (
        <section className="usage-empty-card" aria-label={emptyTitle}>
          <EmptyState
            icon={<History size={20} />}
            title={emptyTitle}
            description={emptyText}
            action={
              runningInTauri ? (
                <button
                  type="button"
                  className="usage-primary-button"
                  onClick={() => void loadUsage(range, true)}
                  disabled={busy}
                >
                  刷新
                </button>
              ) : undefined
            }
          />
        </section>
      )}

      {hasData && summary && (
        <section
          className={[
            "usage-chart-card",
            tableMode && "is-table",
            rangeStatus && "is-stale",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-busy={rangeStatus ? true : undefined}
          aria-labelledby="usage-chart-title"
        >
          <header className="usage-card-head is-tall">
            <div>
              <strong id="usage-chart-title">{chartTitle}</strong>
              <p>
                {rangeStatus ? (
                  <span className="usage-range-status" role="status">
                    {rangeStatus}
                  </span>
                ) : (
                  <>
                    <span>
                      {usageRangeTitles[loadedRange]}合计 {compactTokens(total)}
                    </span>
                    {peak && (
                      <>
                        {" · "}
                        <span>
                          峰值 {usageBucketLabel(peak.date, loadedHourly)} ·{" "}
                          {compactTokens(totalDailyTokens(peak))}
                        </span>
                      </>
                    )}
                  </>
                )}
              </p>
            </div>
            <div className="usage-view-seg" role="group" aria-label="显示方式">
              <button
                type="button"
                aria-pressed={!tableMode}
                onClick={() => setTableMode(false)}
              >
                图表
              </button>
              <button
                type="button"
                aria-pressed={tableMode}
                onClick={() => setTableMode(true)}
              >
                表格
              </button>
            </div>
          </header>
          {tableMode ? (
            <div
              className="usage-summary-scroll"
              tabIndex={0}
              role="region"
              aria-label={`${tableName}表格`}
            >
              <table className="usage-summary-table">
                <caption className="sr-only">{tableName}</caption>
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
                          day.totalCacheCreationTokens +
                            day.totalCacheReadTokens,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="usage-plot">
              <ol className="usage-y-axis" aria-hidden="true">
                {[...axis.ticks].reverse().map((tick) => (
                  <li key={tick}>{axisLabel(tick, axis.top)}</li>
                ))}
              </ol>
              <div
                className={`usage-bars${dense ? " is-dense" : ""}`}
                role="img"
                aria-label={`${usageRangeTitles[loadedRange]}${loadedHourly ? "每小时" : "每日"}词元柱状图${
                  peak
                    ? `，峰值 ${usageBucketLabel(peak.date, loadedHourly)} ${compactTokens(totalDailyTokens(peak))}`
                    : ""
                }`}
              >
                {trends.map((day, index) => {
                  const value = totalDailyTokens(day);
                  const height = value
                    ? Math.max(1.5, (value / axis.top) * 100)
                    : 0;
                  const label = usageBucketLabel(day.date, loadedHourly);
                  const current = index === trends.length - 1;
                  const isToday =
                    !loadedHourly && current && day.date.startsWith(todayKey);
                  const cache =
                    day.totalCacheCreationTokens + day.totalCacheReadTokens;
                  return (
                    <div
                      className={`usage-bar-column${current ? " is-current" : ""}`}
                      key={day.date}
                    >
                      {!dense && (
                        <strong aria-hidden="true">
                          {value ? compactTokens(value) : ""}
                        </strong>
                      )}
                      <div
                        className="usage-bar"
                        style={{ height: `${height}%` }}
                        title={`${label} · ${exact(value)}（输入 ${n(day.totalInputTokens)} · 输出 ${n(day.totalOutputTokens)} · 缓存 ${n(cache)}）`}
                      />
                      <small>
                        {axisLabels.has(day.date)
                          ? isToday
                            ? "今天"
                            : label
                          : ""}
                      </small>
                    </div>
                  );
                })}
                {!peak && (
                  <div className="usage-chart-empty">
                    {usageRangeTitles[loadedRange]}没有词元用量
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {hasData && summary && (
        <div
          className={`usage-analysis-grid usage-breakdown${providerRows.length ? "" : " is-single"}`}
        >
          {providerRows.length > 0 && (
            <section
              className="usage-rank-card usage-provider-card"
              aria-labelledby="usage-provider-title"
            >
              <header className="usage-card-head is-tall">
                <div>
                  <strong id="usage-provider-title">按线路</strong>
                  <p>按词元总量 · {providerRows.length} 条线路</p>
                </div>
              </header>
              <ul className="usage-provider-rank">
                {shownProviders.map((row) => (
                  <li key={row.providerId}>
                    <i className="usage-line-bar" aria-hidden="true" />
                    <span className="usage-rank-name" title={row.providerName}>
                      {row.providerName}
                    </span>
                    <b className="usage-mono" title={exact(row.totalTokens)}>
                      {listTokens(row.totalTokens, providerMax)}
                    </b>
                    <span className="usage-share-track" aria-hidden="true">
                      <span
                        style={{
                          width: `${providerTotal ? (row.totalTokens / providerTotal) * 100 : 0}%`,
                        }}
                      />
                    </span>
                    <em className="usage-mono">
                      {share(row.totalTokens, providerTotal)}
                    </em>
                  </li>
                ))}
              </ul>
              {providerRows.length > USAGE_TOP_PROVIDER_COUNT && (
                <button
                  type="button"
                  className="usage-view-all"
                  aria-expanded={allProvidersOpen}
                  onClick={() => setAllProvidersOpen((open) => !open)}
                >
                  {allProvidersOpen
                    ? `只看前 ${USAGE_TOP_PROVIDER_COUNT} 条`
                    : `查看全部 ${providerRows.length} 条线路`}
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              )}
            </section>
          )}
          <aside
            className="usage-rank-card usage-model-card"
            aria-label="按模型排行"
          >
            <header className="usage-card-head is-tall">
              <div>
                <strong>按模型</strong>
                <p>
                  前 {Math.min(models.length, USAGE_TOP_MODEL_COUNT)} 个模型 ·
                  按词元排序
                </p>
              </div>
            </header>
            {topModels.length ? (
              <ul className="usage-model-rank">
                {topModels.map((model) => (
                  <li className="usage-model-item" key={model.model}>
                    <strong title={model.model}>{model.model}</strong>
                    <span
                      className="usage-mono"
                      title={`${exact(model.totalTokens)} · ${n(model.requestCount)} 次请求`}
                    >
                      {listTokens(model.totalTokens, modelMax)}
                    </span>
                    <em className="usage-mono">
                      {share(model.totalTokens, modelTotal)}
                    </em>
                    <span className="usage-share-track" aria-hidden="true">
                      <span
                        style={{
                          width: `${modelTotal ? (model.totalTokens / modelTotal) * 100 : 0}%`,
                        }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
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
        </div>
      )}

      {hasData && conversationsAvailable && (
        <ConversationUsageSection
          report={conversations}
          loading={conversationsLoading}
          query={conversationQuery}
          onQueryChange={setConversationQuery}
        />
      )}

      <Dialog open={allModelsOpen} onOpenChange={setAllModelsOpen}>
        <DialogContent className="usage-all-models">
          <DialogHeader>
            <DialogTitle>全部模型排行</DialogTitle>
            <DialogDescription>
              共 {models.length} 个模型 · 按{usageRangeTitles[loadedRange]}
              的词元总量排序。
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
                <span>{compactTokens(model.totalTokens)}</span>
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
          className="usage-advanced-toggle"
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
