import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowUpRight,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  Feather,
  FolderOpen,
  Power,
  RefreshCw,
  Route,
  X,
} from "lucide-react";
import { AppGlyph, RouteGlyph } from "@/components/AppGlyph";
import appIcon from "@/assets/icons/app-icon.png";
import {
  Root as Tabs,
  Content as TabsContent,
  List as TabsList,
  Trigger as TabsTrigger,
} from "@radix-ui/react-tabs";
import {
  normalizeTrayLanguage,
  trayPanelCopy,
  type TrayLanguage,
} from "@/i18n/trayPanel";
import type { ProfileScope } from "@/lib/api/profiles";
import { usageApi } from "@/lib/api/usage";
import type { DailyStats, UsageSummary } from "@/types/usage";
import { extractErrorMessage } from "@/utils/errorUtils";
import {
  formatUsageTokens,
  totalDailyTokens,
  usageBucketLabel,
  usageTrendsAreHourly,
  usageWindow,
  type UsageRange,
} from "@/utils/usageMetrics";
import { version as APP_VERSION } from "../../package.json";
import "./TrayPanel.css";

interface TrayLine {
  id: string;
  name: string;
  category: string | null;
  iconColor: string | null;
  badgeText: string | null;
  blockedByTakeover: boolean;
}

interface TrayTool {
  id: string;
  name: string;
  currentId: string | null;
  autoFailover: boolean;
  currentUsageSummary: string | null;
  lines: TrayLine[];
}

interface Snapshot {
  language: TrayLanguage;
  tools: TrayTool[];
  hasProjects: boolean;
  lightweight: boolean;
}

type PanelAction =
  "hide" | "openMain" | "toggleLightweight" | "projects" | "quit";
type ProjectResult =
  | { status: "warning" | "partial"; warnings: string[] }
  | { status: "error"; message: string };
interface ProjectChange {
  operation: number;
  scope: ProfileScope;
  result: ProjectResult | { status: "cleared" };
}
type Feedback = {
  tone?: "error" | "warning";
  message: string;
  details?: string[];
};
const ranges: UsageRange[] = ["today", "7d", "30d"];

function getTrayPreviewMode(): "normal" | "notice" | null {
  if (
    !import.meta.env.DEV ||
    typeof window === "undefined" ||
    "__TAURI_INTERNALS__" in window
  ) {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  if (params.get("preview") !== "tray") return null;
  return params.get("state") === "notice" ? "notice" : "normal";
}

const TRAY_PREVIEW_SNAPSHOT: Snapshot = {
  language: "zh",
  hasProjects: true,
  lightweight: true,
  tools: [
    {
      id: "codex",
      name: "Codex",
      currentId: "chimerahub",
      autoFailover: true,
      currentUsageSummary: "5h 24% · 7d 41%",
      lines: [
        {
          id: "chimerahub",
          name: "ChimeraHub 官方高速",
          category: null,
          iconColor: "#0e6470",
          badgeText: "C",
          blockedByTakeover: false,
        },
        {
          id: "openai-official",
          name: "OpenAI Official",
          category: "official",
          iconColor: "#16181d",
          badgeText: "O",
          blockedByTakeover: false,
        },
        {
          id: "deepseek-relay",
          name: "DeepSeek Relay",
          category: null,
          iconColor: "#537197",
          badgeText: "D",
          blockedByTakeover: false,
        },
      ],
    },
    {
      id: "claude",
      name: "Claude",
      currentId: "anthropic-pro",
      autoFailover: true,
      currentUsageSummary: "5h 12%",
      lines: [
        {
          id: "anthropic-pro",
          name: "Anthropic Pro",
          category: "official",
          iconColor: "#2c7175",
          badgeText: "A",
          blockedByTakeover: false,
        },
      ],
    },
    {
      id: "gemini",
      name: "Gemini",
      currentId: "google-ai",
      autoFailover: false,
      currentUsageSummary: null,
      lines: [
        {
          id: "google-ai",
          name: "Google AI Studio",
          category: "official",
          iconColor: "#357b7f",
          badgeText: "G",
          blockedByTakeover: false,
        },
      ],
    },
  ],
};

const TRAY_PREVIEW_USAGE: { summary: UsageSummary; trend: DailyStats[] } = {
  summary: {
    totalRequests: 1428,
    totalCost: "34.60",
    totalInputTokens: 9_820_000,
    totalOutputTokens: 2_660_000,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 6_400_000,
    realTotalTokens: 12_480_000,
    successRate: 99.6,
    cacheHitRate: 0.684,
  },
  trend: [
    {
      date: "2026-11-17",
      requestCount: 160,
      totalCost: "3.90",
      totalTokens: 1_520_000,
      totalInputTokens: 1_120_000,
      totalOutputTokens: 400_000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    },
    {
      date: "2026-11-18",
      requestCount: 142,
      totalCost: "3.10",
      totalTokens: 1_240_000,
      totalInputTokens: 920_000,
      totalOutputTokens: 320_000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    },
    {
      date: "2026-11-19",
      requestCount: 224,
      totalCost: "5.20",
      totalTokens: 1_960_000,
      totalInputTokens: 1_510_000,
      totalOutputTokens: 450_000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    },
    {
      date: "2026-11-20",
      requestCount: 196,
      totalCost: "4.60",
      totalTokens: 1_710_000,
      totalInputTokens: 1_310_000,
      totalOutputTokens: 400_000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    },
    {
      date: "2026-11-21",
      requestCount: 312,
      totalCost: "7.80",
      totalTokens: 2_640_000,
      totalInputTokens: 2_040_000,
      totalOutputTokens: 600_000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    },
    {
      date: "2026-11-22",
      requestCount: 215,
      totalCost: "5.40",
      totalTokens: 1_850_000,
      totalInputTokens: 1_450_000,
      totalOutputTokens: 400_000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    },
    {
      date: "2026-11-23",
      requestCount: 179,
      totalCost: "4.60",
      totalTokens: 1_560_000,
      totalInputTokens: 1_200_000,
      totalOutputTokens: 360_000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    },
  ],
};
const projectScopeNames: Record<ProfileScope, string> = {
  claude: "Claude",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
};
const cost = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function TrayUsage({
  revision,
  language,
}: {
  revision: number;
  language: TrayLanguage;
}) {
  const safeLanguage = normalizeTrayLanguage(language);
  const text = trayPanelCopy(safeLanguage);
  const number = new Intl.NumberFormat(safeLanguage);
  const compactTokens = new Intl.NumberFormat(safeLanguage, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const pct = new Intl.NumberFormat(safeLanguage, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const previewMode = getTrayPreviewMode();
  const [range, setRange] = useState<UsageRange>(previewMode ? "7d" : "today");
  const [data, setData] = useState<
    | {
        range: UsageRange;
        summary: UsageSummary;
        hourly: boolean;
        trend: DailyStats[];
      }
    | undefined
  >(() =>
    previewMode
      ? {
          range: "7d",
          summary: TRAY_PREVIEW_USAGE.summary,
          trend: TRAY_PREVIEW_USAGE.trend,
          hourly: false,
        }
      : undefined,
  );
  const [loading, setLoading] = useState(!previewMode);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (previewMode) {
      setData({
        range,
        summary: TRAY_PREVIEW_USAGE.summary,
        trend: TRAY_PREVIEW_USAGE.trend,
        hourly: false,
      });
      setLoading(false);
      setFailed(false);
      return;
    }
    let active = true;
    const { start, end } = usageWindow(range);
    setLoading(true);
    setFailed(false);
    void Promise.all([
      usageApi.getUsageSummary(start, end, "codex"),
      usageApi.getUsageTrends(start, end, "codex"),
    ])
      .then(([summary, trend]) => {
        if (active)
          setData({
            range,
            summary,
            trend,
            hourly: usageTrendsAreHourly(start, end),
          });
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [range, refresh, revision]);
  const snapshot = data?.range === range ? data : undefined;
  const summary = snapshot?.summary;
  const trend = snapshot?.trend ?? [];
  const maxTokens = Math.max(1, ...trend.map(totalDailyTokens));
  const hasTrendData =
    Boolean(summary) && trend.some((bucket) => totalDailyTokens(bucket) > 0);
  const peakBucket = hasTrendData
    ? trend.find((bucket) => totalDailyTokens(bucket) === maxTokens)
    : undefined;
  const formatCompactTokens = (value: number) =>
    safeLanguage === "zh"
      ? formatUsageTokens(value)
      : compactTokens.format(value);
  const hourly = snapshot?.hourly ?? false;
  const firstBucket = trend[0];
  const lastBucket = trend.at(-1);
  const totalCost = summary?.totalCost.trim() ? Number(summary.totalCost) : NaN;
  const metrics = [
    [text.cost, Number.isFinite(totalCost) ? cost.format(totalCost) : "—"],
    [text.requests, summary ? number.format(summary.totalRequests) : "—"],
    [text.tokens, summary ? formatCompactTokens(summary.realTotalTokens) : "—"],
    [text.hitRate, summary ? pct.format(summary.cacheHitRate) : "—"],
  ];
  return (
    <section
      className="tray-usage"
      aria-label={text.usageLabel}
      aria-busy={loading}
    >
      <div className="tray-usage-tools">
        <div className="tray-ranges" role="group" aria-label={text.rangeLabel}>
          {ranges.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={range === item}
              onClick={() => setRange(item)}
            >
              {text.ranges[item]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="tray-icon-button"
          title={text.refresh}
          aria-label={text.refresh}
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </div>
      <dl className="tray-metrics">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="tray-plot">
        <div className="tray-plot-title">
          <strong>{text.trend}</strong>
          <span>
            {peakBucket
              ? `${usageBucketLabel(peakBucket.date, hourly)} · ${formatCompactTokens(maxTokens)}`
              : text.ranges[range]}
          </span>
        </div>
        {hasTrendData ? (
          <>
            <div
              className="tray-bars"
              role="img"
              aria-label={text.peak(number.format(maxTokens))}
            >
              {trend.map((bucket) => {
                const tokens = totalDailyTokens(bucket);
                return (
                  <span
                    key={bucket.date}
                    data-peak={
                      tokens > 0 && tokens === maxTokens ? "true" : undefined
                    }
                    title={`${usageBucketLabel(bucket.date, hourly)} · ${text.tokenCount(number.format(tokens))}`}
                    aria-hidden="true"
                    style={{
                      height: `${(tokens / maxTokens) * 100}%`,
                    }}
                  />
                );
              })}
            </div>
            {firstBucket && lastBucket && (
              <div className="tray-plot-axis" aria-hidden="true">
                <span>{usageBucketLabel(firstBucket.date, hourly)}</span>
                {firstBucket !== lastBucket && (
                  <span>{usageBucketLabel(lastBucket.date, hourly)}</span>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="tray-empty-plot" role="status">
            {loading
              ? text.loadingUsage
              : failed
                ? text.usageError
                : text.usageEmpty}
          </p>
        )}
      </div>
      <p className="tray-caption" role="status">
        {failed && snapshot ? text.staleUsage : text.usageCaption}
      </p>
    </section>
  );
}

export function TrayPanel() {
  const previewMode = getTrayPreviewMode();
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(() => {
    if (!previewMode) return undefined;
    if (previewMode === "notice") {
      return {
        ...TRAY_PREVIEW_SNAPSHOT,
        tools: TRAY_PREVIEW_SNAPSHOT.tools.map((tool) =>
          tool.id === "codex"
            ? {
                ...tool,
                lines: tool.lines.map((line) =>
                  line.id === "openai-official"
                    ? { ...line, blockedByTakeover: true }
                    : line,
                ),
              }
            : tool,
        ),
      };
    }
    return TRAY_PREVIEW_SNAPSHOT;
  });
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(!previewMode);
  const [loadError, setLoadError] = useState(previewMode === "notice");
  const [feedback, setFeedback] = useState<Feedback>();
  const [projectResults, setProjectResults] = useState<
    ReadonlyMap<ProfileScope, ProjectChange>
  >(() =>
    previewMode === "notice"
      ? new Map([
          [
            "codex",
            {
              operation: 1,
              scope: "codex",
              result: {
                status: "partial",
                warnings: ["Codex 已切换，Claude Desktop 未检测到运行目录"],
              },
            },
          ],
        ])
      : new Map(),
  );
  const [pending, setPending] = useState(false);
  const [openTools, setOpenTools] = useState<ReadonlySet<string> | null>(null);
  const activeOperation = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const language = normalizeTrayLanguage(snapshot?.language);
  const text = trayPanelCopy(language);

  useEffect(() => {
    if (previewMode) return;
    let disposed = false;
    const refresh = () => {
      if (!disposed) setRevision((value) => value + 1);
    };
    const registrations = [
      listen("profile-applied", refresh),
      listen("provider-switched", refresh),
      listen("proxy-flags-changed", refresh),
      listen("usage-cache-updated", refresh),
      listen<ProjectChange>(
        "tray-project-result",
        ({ payload }) => {
          if (disposed) return;
          setProjectResults((previous) => {
            const last = previous.get(payload.scope);
            if (last && payload.operation <= last.operation) return previous;
            return new Map(previous).set(payload.scope, payload);
          });
          refresh();
        },
        { target: "tray-panel" },
      ),
    ];
    for (const registration of registrations) {
      void registration.catch((error) => {
        if (!disposed)
          console.error("Could not subscribe to tray updates", error);
      });
    }
    return () => {
      disposed = true;
      for (const registration of registrations) {
        void registration.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    const refresh = () => {
      setFeedback(undefined);
      setRevision((value) => value + 1);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        void invoke("tray_panel_action", { action: "hide" }).catch(() => {});
      }
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("keydown", escape);
    // Focus the panel container (outline: none) so Escape works immediately
    // without painting a focus ring around the "线路" tab on mouse open.
    panelRef.current?.focus();
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("keydown", escape);
    };
  }, []);

  useEffect(() => {
    if (previewMode) return;
    let active = true;
    setLoading(true);
    setLoadError(false);
    void invoke<Snapshot>("get_tray_panel")
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [previewMode, revision]);

  async function perform(operation: () => Promise<void>) {
    if (activeOperation.current) return;
    activeOperation.current = true;
    setPending(true);
    setFeedback(undefined);
    try {
      await operation();
    } catch (error) {
      setFeedback({
        tone: "error",
        message: extractErrorMessage(error) || text.actionError,
      });
    } finally {
      activeOperation.current = false;
      setPending(false);
      setRevision((value) => value + 1);
    }
  }

  function action(value: PanelAction) {
    void perform(() => invoke("tray_panel_action", { action: value }));
  }

  function switchLine(tool: TrayTool, line: TrayLine) {
    void perform(async () => {
      await invoke("switch_tray_line", { tool: tool.id, id: line.id });
      const pinned = tool.autoFailover && tool.currentId === line.id;
      const switched = tool.id === "codex" ? text.codexSwitched : text.switched;
      setFeedback({ message: pinned ? text.pinned : switched });
    });
  }

  const notices: (Feedback & { key: string; scope?: ProfileScope })[] = feedback
    ? [{ key: "action", ...feedback }]
    : [];
  for (const { scope, result } of [...projectResults.values()].sort(
    (a, b) => b.operation - a.operation,
  )) {
    if (result.status === "cleared") continue;
    const error = result.status === "error";
    notices.push({
      key: scope,
      scope,
      tone: error ? "error" : "warning",
      message: error
        ? text.projectError
        : result.status === "partial"
          ? text.projectPartial
          : text.projectWarning,
      details: error ? [result.message].filter(Boolean) : result.warnings,
    });
  }
  const tools = snapshot?.tools ?? [];
  const defaultOpenId =
    tools.find((tool) => tool.id === "codex")?.id ?? tools[0]?.id;
  const effectiveOpenTools =
    openTools ?? (defaultOpenId ? new Set([defaultOpenId]) : new Set<string>());
  function toggleTool(toolId: string, isOpen: boolean) {
    setOpenTools(isOpen ? new Set([toolId]) : new Set());
  }
  return (
    <main
      ref={panelRef}
      tabIndex={-1}
      className="tray-panel"
      lang={language}
      aria-label={text.panel}
    >
      <header className="tray-header">
        <span className="tray-brand">
          <span aria-hidden="true" className="tray-brand-logo">
            <img src={appIcon} alt="" />
          </span>
          Chimera++
          <small className="tray-version">v{APP_VERSION}</small>
        </span>
        <button
          type="button"
          className="tray-icon-button"
          aria-label={text.close}
          title={`${text.close} (Esc)`}
          onClick={() => action("hide")}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <Tabs defaultValue="lines" className="tray-tabs">
        <TabsList className="tray-tablist" aria-label={text.views}>
          <TabsTrigger value="lines">
            <Route size={15} aria-hidden="true" />
            {text.lines}
          </TabsTrigger>
          <TabsTrigger value="usage">
            <ChartNoAxesColumn size={15} aria-hidden="true" />
            {text.usage}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="lines" className="tray-content" aria-busy={loading}>
          {loadError && (
            <p className="tray-feedback is-error" role="status">
              {snapshot ? text.staleLines : text.lineError}{" "}
              <button
                type="button"
                onClick={() => setRevision((value) => value + 1)}
              >
                {text.retry}
              </button>
            </p>
          )}
          {loading && !snapshot && (
            <p className="tray-empty-plot" role="status">
              {text.loadingLines}
            </p>
          )}
          {!loading && !loadError && tools.length === 0 && (
            <p className="tray-empty-plot" role="status">
              {text.noTools}
            </p>
          )}
          {tools.map((tool) => {
            const current = tool.lines.find(
              (line) => line.id === tool.currentId,
            );
            return (
              <details
                key={tool.id}
                className="tray-tool"
                open={effectiveOpenTools.has(tool.id)}
                onToggle={(event) => {
                  const nextOpen = event.currentTarget.open;
                  if (nextOpen !== effectiveOpenTools.has(tool.id)) {
                    toggleTool(tool.id, nextOpen);
                  }
                }}
              >
                <summary>
                  <AppGlyph
                    app={tool.id}
                    size={18}
                    plated
                    plateSize={32}
                    className="tray-tool-glyph"
                  />
                  <span className="tray-tool-meta">
                    <span className="tray-tool-head">
                      <strong>{tool.name}</strong>
                      {tool.autoFailover && (
                        <small className="tray-auto-chip">
                          {text.automatic}
                        </small>
                      )}
                      {tool.currentUsageSummary && (
                        <small
                          className="tray-quota-chip"
                          title={tool.currentUsageSummary}
                        >
                          {tool.currentUsageSummary}
                        </small>
                      )}
                    </span>
                    <small className="tray-tool-current" title={current?.name}>
                      {current?.name ?? text.noCurrent}
                    </small>
                  </span>
                  <ChevronDown
                    size={15}
                    className="tray-tool-chevron"
                    aria-hidden="true"
                  />
                </summary>
                {tool.lines.length ? (
                  <ul aria-label={text.lineList(tool.name)}>
                    {tool.lines.map((line) => {
                      const active = line.id === tool.currentId;
                      const canPin =
                        active && tool.autoFailover && !line.blockedByTakeover;
                      const identity = {
                        ...line,
                        meta: line.badgeText
                          ? { badgeText: line.badgeText }
                          : undefined,
                      };
                      return (
                        <li key={line.id}>
                          <button
                            type="button"
                            className="tray-line"
                            aria-current={active || undefined}
                            disabled={
                              pending ||
                              loading ||
                              loadError ||
                              line.blockedByTakeover ||
                              (active && !canPin)
                            }
                            onClick={() => switchLine(tool, line)}
                          >
                            <RouteGlyph
                              appId={tool.id}
                              line={identity}
                              size={24}
                            />
                            <span className="tray-line-info">
                              <span title={line.name}>{line.name}</span>
                              {line.blockedByTakeover && (
                                <small>{text.blocked}</small>
                              )}
                              {canPin && <small>{text.pin}</small>}
                            </span>
                            {active && (
                              <Check
                                size={15}
                                className="tray-line-check"
                                aria-label={text.current}
                              />
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="tray-empty-plot">{text.addLine}</p>
                )}
              </details>
            );
          })}
        </TabsContent>
        <TabsContent value="usage" className="tray-content">
          <TrayUsage revision={revision} language={language} />
        </TabsContent>
      </Tabs>
      {notices.length > 0 && (
        <div
          className="tray-notices"
          role="status"
          tabIndex={
            notices.length > 1 || notices.some((item) => item.details?.length)
              ? 0
              : undefined
          }
        >
          {notices.map(({ key, scope, tone, message, details }) => (
            <div
              key={key}
              className={`tray-feedback${tone ? ` is-${tone}` : ""}`}
            >
              {scope && <strong>{projectScopeNames[scope]} </strong>}
              {message}
              {!!details?.length && (
                <ul>
                  {[...new Set(details)].map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      <footer className="tray-footer">
        <button
          type="button"
          role="switch"
          aria-checked={snapshot?.lightweight ?? false}
          disabled={!snapshot || pending || loading || loadError}
          onClick={() => action("toggleLightweight")}
        >
          <Feather size={15} aria-hidden="true" />
          <span>{text.lightweight}</span>
          <span className="tray-switch" aria-hidden="true" />
        </button>
        <div className="tray-footer-actions">
          {snapshot?.hasProjects && (
            <button
              type="button"
              disabled={pending || loading || loadError}
              onClick={() => action("projects")}
            >
              <FolderOpen size={15} aria-hidden="true" />
              {text.projects}
            </button>
          )}
          <button
            type="button"
            className="tray-action-primary"
            disabled={pending}
            onClick={() => action("openMain")}
          >
            {text.open}
            <ArrowUpRight size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => action("quit")}
          >
            <Power size={15} aria-hidden="true" />
            {text.quit}
          </button>
        </div>
      </footer>
    </main>
  );
}
