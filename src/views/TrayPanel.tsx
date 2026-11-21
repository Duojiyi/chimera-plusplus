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
import { LineBadge } from "@/components/LineBadge";
import {
  Root as Tabs,
  Content as TabsContent,
  List as TabsList,
  Trigger as TabsTrigger,
} from "@radix-ui/react-tabs";
import { trayPanelCopy, type TrayLanguage } from "@/i18n/trayPanel";
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
  const text = trayPanelCopy(language);
  const number = new Intl.NumberFormat(language);
  const compactTokens = new Intl.NumberFormat(language, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const pct = new Intl.NumberFormat(language, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const [range, setRange] = useState<UsageRange>("today");
  const [data, setData] = useState<{
    range: UsageRange;
    summary: UsageSummary;
    hourly: boolean;
    trend: DailyStats[];
  }>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
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
  const hourly = snapshot?.hourly ?? false;
  const firstBucket = trend[0];
  const lastBucket = trend.at(-1);
  const totalCost = summary?.totalCost.trim() ? Number(summary.totalCost) : NaN;
  const metrics = [
    [text.cost, Number.isFinite(totalCost) ? cost.format(totalCost) : "—"],
    [text.requests, summary ? number.format(summary.totalRequests) : "—"],
    [
      text.tokens,
      summary
        ? language === "zh"
          ? formatUsageTokens(summary.realTotalTokens)
          : compactTokens.format(summary.realTotalTokens)
        : "—",
    ],
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
          <span>{text.ranges[range]}</span>
        </div>
        {summary && trend.some((bucket) => totalDailyTokens(bucket) > 0) ? (
          <>
            <div
              className="tray-bars"
              role="img"
              aria-label={text.peak(number.format(maxTokens))}
            >
              {trend.map((bucket) => (
                <span
                  key={bucket.date}
                  title={`${usageBucketLabel(bucket.date, hourly)} · ${text.tokenCount(number.format(totalDailyTokens(bucket)))}`}
                  aria-hidden="true"
                  style={{
                    height: `${(totalDailyTokens(bucket) / maxTokens) * 100}%`,
                  }}
                />
              ))}
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
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const [projectResults, setProjectResults] = useState<
    ReadonlyMap<ProfileScope, ProjectChange>
  >(() => new Map());
  const [pending, setPending] = useState(false);
  const activeOperation = useRef(false);
  const firstTab = useRef<HTMLButtonElement>(null);
  const language = snapshot?.language ?? "zh";
  const text = trayPanelCopy(language);

  useEffect(() => {
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
    const refresh = () => setRevision((value) => value + 1);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        void invoke("tray_panel_action", { action: "hide" }).catch(() => {});
      }
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("keydown", escape);
    firstTab.current?.focus();
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("keydown", escape);
    };
  }, []);

  useEffect(() => {
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
  }, [revision]);

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
  return (
    <main className="tray-panel" lang={language} aria-label={text.panel}>
      <header className="tray-header">
        <span className="tray-brand">
          <span aria-hidden="true">C</span>Chimera++
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
          <TabsTrigger ref={firstTab} value="lines">
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
                open={tools.length === 1 ? true : undefined}
              >
                <summary>
                  <span>
                    <strong>{tool.name}</strong>
                    <small title={current?.name}>
                      {current?.name ?? text.noCurrent}
                    </small>
                    {tool.currentUsageSummary && (
                      <small title={tool.currentUsageSummary}>
                        {tool.currentUsageSummary}
                      </small>
                    )}
                  </span>
                  {tool.autoFailover && <small>{text.automatic}</small>}
                  <ChevronDown size={15} aria-hidden="true" />
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
                            <LineBadge line={identity} size="sm" />
                            <span className="tray-line-info">
                              <span title={line.name}>{line.name}</span>
                              {line.blockedByTakeover && (
                                <small>{text.blocked}</small>
                              )}
                              {canPin && <small>{text.pin}</small>}
                            </span>
                            {active && (
                              <Check size={15} aria-label={text.current} />
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
            disabled={pending}
            onClick={() => action("openMain")}
          >
            <ArrowUpRight size={15} aria-hidden="true" />
            {text.open}
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
