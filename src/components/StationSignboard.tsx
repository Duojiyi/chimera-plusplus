import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Gauge,
  History,
  Pencil,
  Users,
} from "lucide-react";
import type { Provider } from "@/types";
import type { CANONICAL_STATION } from "@/data/canonicalData";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
} from "@/utils/providerConfigUtils";
import {
  codexProviderRouting,
  type CodexRoutingReason,
} from "@/utils/codexRouting";
import { isOfficialLine } from "@/utils/lineBadge";
import { DisabledReason, HelpTip } from "@/components/ui/help-tip";
import { LineBadge, lineIdentityColor } from "@/components/LineBadge";
import { routingExplanation } from "@/components/ProviderLineTable";
import "./StationSignboard.css";

interface StationSignboardProps {
  currentProvider: Provider | null;
  /** The name shown in the line list; defaults to the saved name. */
  lineName?: string;
  /** Shown as an empty plate when no line is current. */
  emptyState?: { title: string; detail: string; lineNote?: string };
  designSample?: typeof CANONICAL_STATION;
  latencyMs?: number | null;
  testingLatency?: boolean;
  /** Message of the last failed connection test of this line. */
  connectionError?: string | null;
  onTestSpeed?: () => void;
  /** Why testing is unavailable, when it is. */
  testSpeedUnavailable?: string;
  onEdit?: () => void;
  /** Official lines are managed on the 官方账号 page instead of edited here. */
  onManageAccount?: () => void;
  undoReceipt?: {
    fromName: string;
    toName: string;
    backupId: string;
    timestamp: string;
    onUndo: () => void;
  } | null;
  runtimeLabel?: string;
  runtimeHint?: string;
  onOpenCodex?: () => void;
  openCodexLabel?: string;
  openCodexDisabled?: boolean;
}

// The main reason in a few words; the help card lists all of them.
const ROUTE_NOTES: Record<CodexRoutingReason, string> = {
  chat: "转换为 Chat",
  anthropic: "转换为 Anthropic",
  "model-routing": "按模型分流",
  "full-url": "完整 API 地址",
  "user-agent": "自定义 User-Agent",
  "request-overrides": "自定义请求头",
  "auto-review-model": "改写审批模型",
  "managed-auth": "托管登录",
  "auto-detect": "自动识别协议",
};

const SLOW_LATENCY_MS = 1000;

type Tone = "ok" | "warn" | "error" | "muted";

interface Stop {
  key: string;
  name: React.ReactNode;
  note: React.ReactNode;
  noteTitle?: string;
  mono?: boolean;
  tone?: Tone;
  /** The segment leading to this stop failed. */
  broken?: boolean;
  pending?: boolean;
}

function RouteBar({ stops, label }: { stops: Stop[]; label: string }) {
  return (
    <ol className="station-route" aria-label={label}>
      {stops.map((stop, index) => (
        <li
          key={stop.key}
          className="station-stop"
          data-last={index === stops.length - 1 || undefined}
          data-pending={stop.pending || undefined}
          data-break-next={stops[index + 1]?.broken || undefined}
          data-tone={stop.tone}
        >
          <span className="station-track" aria-hidden="true">
            <i className="station-dot" />
            {index < stops.length - 1 && <i className="station-rail" />}
          </span>
          <span className={`station-stop-name${stop.mono ? " is-mono" : ""}`}>
            {stop.name}
          </span>
          <span className="station-stop-note" title={stop.noteTitle}>
            {stop.note}
          </span>
        </li>
      ))}
    </ol>
  );
}

export const StationSignboard: React.FC<StationSignboardProps> = ({
  currentProvider,
  lineName: displayName,
  emptyState,
  designSample,
  latencyMs = null,
  testingLatency = false,
  connectionError = null,
  onTestSpeed,
  testSpeedUnavailable,
  onEdit,
  onManageAccount,
  undoReceipt,
  runtimeLabel = "运行状态见 Codex 管理页",
  runtimeHint,
  onOpenCodex,
  openCodexLabel,
  openCodexDisabled,
}) => {
  const [undoCountdown, setUndoCountdown] = useState(8);
  const [undoing, setUndoing] = useState(false);

  useEffect(() => {
    if (!undoReceipt) {
      setUndoCountdown(8);
      setUndoing(false);
      return;
    }
    setUndoCountdown(8);
    setUndoing(false);
    const interval = setInterval(() => {
      setUndoCountdown((c) => (c > 1 ? c - 1 : 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [undoReceipt?.backupId]);

  if (!currentProvider) {
    if (!emptyState) return null;
    return (
      <section className="station-signboard" data-signboard>
        <div className="station-plate is-empty">
          <div className="station-body">
            <div className="station-top">
              <span className="station-empty-mark" aria-hidden="true">
                <CircleDashed size={20} />
              </span>
              <div className="station-title">
                <span className="station-eyebrow">当前线路</span>
                <p className="station-empty-title">{emptyState.title}</p>
                <p className="station-empty-detail">{emptyState.detail}</p>
              </div>
            </div>
            <RouteBar
              label="请求路径"
              stops={[
                {
                  key: "codex",
                  name: "Codex",
                  note: runtimeLabel,
                  noteTitle: runtimeHint,
                },
                {
                  key: "line",
                  name: "线路",
                  note: emptyState.lineNote ?? "等待选择",
                  pending: true,
                },
                {
                  key: "model",
                  name: "模型",
                  note: "随线路确定",
                  pending: true,
                },
              ]}
            />
          </div>
        </div>
      </section>
    );
  }

  const official = isOfficialLine(currentProvider);
  const lineName = displayName || currentProvider.name || "未命名线路";
  const configStr = String(currentProvider.settingsConfig?.config ?? "");
  const baseUrl = extractCodexBaseUrl(configStr);
  const host = baseUrl?.replace(/^https?:\/\//, "").split("/")[0];
  const model = extractCodexModelName(configStr);
  const routing = official
    ? { routed: false, reasons: [] }
    : codexProviderRouting(currentProvider);
  // Samples are opt-in, browser-development only, and tied to the fixture provider.
  const sample =
    import.meta.env.DEV &&
    !("__TAURI_INTERNALS__" in window) &&
    designSample?.providerId === currentProvider.id
      ? designSample
      : undefined;
  const isTesting = !sample && testingLatency;
  const failed = !sample && !isTesting && Boolean(connectionError);
  const displayLatency = sample?.latencyMs ?? latencyMs;
  const measured =
    !isTesting &&
    !failed &&
    displayLatency != null &&
    Number.isFinite(displayLatency) &&
    displayLatency >= 0;
  const slow = measured && (displayLatency ?? 0) >= SLOW_LATENCY_MS;
  const tone: Tone = failed
    ? "error"
    : slow
      ? "warn"
      : measured
        ? "ok"
        : "muted";
  const StateIcon =
    tone === "error"
      ? CircleX
      : tone === "warn"
        ? AlertTriangle
        : tone === "ok"
          ? CircleCheck
          : CircleDashed;
  const stateText =
    sample?.status ??
    (isTesting
      ? "测速中"
      : failed
        ? "连接失败"
        : slow
          ? "响应较慢"
          : measured
            ? "地址可达"
            : "未测速");
  const addressState = isTesting
    ? "测速中"
    : failed
      ? "无法连接"
      : measured
        ? "地址可达"
        : "未测速";

  const stops: Stop[] = [
    {
      key: "codex",
      name: "Codex",
      note: (
        <>
          {sample?.runtimeLabel ?? runtimeLabel}
          {runtimeHint && !sample && (
            <span className="sr-only">{runtimeHint}</span>
          )}
        </>
      ),
      noteTitle: sample ? undefined : runtimeHint,
    },
  ];
  if (sample || routing.routed) {
    const main = routing.reasons[0];
    stops.push({
      key: "route",
      name: sample ? (
        sample.hopName
      ) : (
        <>
          本地路由
          <HelpTip title="本地路由">{routingExplanation(routing)}</HelpTip>
        </>
      ),
      note: sample?.hopHint ?? (main ? ROUTE_NOTES[main] : ""),
    });
  }
  stops.push({
    key: "address",
    name: official ? "ChatGPT 官方" : (host ?? "未设置请求地址"),
    mono: !official && Boolean(host),
    note:
      sample?.endpointHint ??
      (official
        ? "直连 · 官方登录"
        : routing.routed
          ? addressState
          : `直连 · ${addressState}`),
    noteTitle: failed ? (connectionError ?? undefined) : undefined,
    tone: failed ? "error" : undefined,
    broken: failed,
  });
  stops.push({
    key: "model",
    name: model || (official ? "Codex 默认模型" : "未设置模型"),
    mono: Boolean(model),
    note: sample?.modelHint ?? "默认模型",
  });

  const handleUndoClick = () => {
    if (sample || undoing) return;
    if (undoReceipt) {
      setUndoing(true);
      undoReceipt.onUndo();
    }
  };

  const testButton = (
    <button
      type="button"
      className="station-action"
      onClick={sample ? undefined : onTestSpeed}
      disabled={Boolean(sample) || isTesting || !onTestSpeed}
    >
      <Gauge size={16} aria-hidden="true" />
      <span>测速</span>
    </button>
  );

  return (
    <section
      aria-label={sample ? "设计示例站牌，非本机运行状态" : undefined}
      className="station-signboard"
      data-signboard
    >
      <div
        className="station-plate"
        style={
          {
            "--line-color": official
              ? "var(--plate-fg-3)"
              : lineIdentityColor(currentProvider),
          } as React.CSSProperties
        }
      >
        <span className="station-band" aria-hidden="true" />
        <div className="station-body">
          <div className="station-top">
            <LineBadge line={currentProvider} size="lg" onPlate />
            <div className="station-title">
              <span className="station-eyebrow">当前线路</span>
              <div className="station-name-row">
                <p className="station-name" title={lineName}>
                  {lineName}
                </p>
                <span className="station-kind">
                  {official ? "官方 · ChatGPT 登录" : "第三方 · API 密钥"}
                </span>
              </div>
            </div>
            <div className="station-reading">
              <span className="station-latency">
                {isTesting
                  ? "测速中…"
                  : measured
                    ? `${displayLatency} ms`
                    : "— ms"}
              </span>
              <span
                className="station-state"
                data-tone={tone}
                title={failed ? (connectionError ?? undefined) : undefined}
              >
                <StateIcon size={14} aria-hidden="true" />
                {stateText}
                {sample?.testedAt && (
                  <span className="station-state-time">{sample.testedAt}</span>
                )}
              </span>
            </div>
            <div className="station-actions">
              {onOpenCodex && !sample && (
                <button
                  type="button"
                  className="station-action"
                  onClick={onOpenCodex}
                  disabled={openCodexDisabled}
                >
                  {openCodexLabel}
                </button>
              )}
              {!sample && !onTestSpeed && testSpeedUnavailable ? (
                <DisabledReason reason={testSpeedUnavailable} align="end">
                  {testButton}
                </DisabledReason>
              ) : (
                testButton
              )}
              {official && onManageAccount && !sample ? (
                <button
                  type="button"
                  className="station-action"
                  onClick={onManageAccount}
                >
                  <Users size={16} aria-hidden="true" />
                  <span>管理账号</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="station-action"
                  onClick={sample ? undefined : onEdit}
                  disabled={Boolean(sample) || !onEdit}
                >
                  <Pencil size={16} aria-hidden="true" />
                  <span>编辑</span>
                </button>
              )}
            </div>
          </div>
          <RouteBar
            stops={stops}
            label={
              routing.routed
                ? "请求路径：经 Chimera++ 本地路由"
                : "请求路径：直连"
            }
          />
        </div>
      </div>

      {(sample?.receipt || undoReceipt) && (
        <div aria-live="polite" className="station-receipt">
          <History size={14} aria-hidden="true" />
          <span className="station-receipt-text">
            {sample?.receipt ??
              (undoReceipt
                ? `${undoReceipt.timestamp} 从 ${undoReceipt.fromName} 切换到 ${undoReceipt.toName}`
                : "")}
          </span>
          <button
            type="button"
            disabled={Boolean(sample) || !undoReceipt || undoing}
            title={
              sample ? "设计示例，不执行撤销" : "切回上一线路，不恢复配置快照"
            }
            onClick={handleUndoClick}
          >
            {sample
              ? "撤销"
              : undoing
                ? "切回中…"
                : undoReceipt
                  ? `切回 (${undoCountdown}s)`
                  : "切回"}
          </button>
        </div>
      )}
    </section>
  );
};
