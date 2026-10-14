import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Gauge,
  AlertTriangle,
  CircleX,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { openDialogCount } from "@/hooks/useDialogFocus";
import type { Provider } from "@/types";
import type { ConnectionState } from "@/chimeraUtils";
import type { CanonicalLine } from "@/data/canonicalData";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
  extractCodexWireApi,
} from "@/utils/providerConfigUtils";
import {
  codexProviderRouting,
  codexRoutingReasonLabels,
  type CodexRouting,
} from "@/utils/codexRouting";
import { vscodeApi, type EndpointLatencyResult } from "@/lib/api/vscode";
import { HelpTip } from "@/components/ui/help-tip";
import { LineBadge } from "@/components/LineBadge";
import "./ProviderLineTable.css";

const PROTOCOL_LABELS: Record<string, string> = {
  responses: "Responses",
  chat: "Chat",
  openai_responses: "Responses",
  openai_chat: "Chat",
  anthropic: "Anthropic",
  gemini_native: "Gemini",
};

// Official lines talk to the ChatGPT backend through Codex itself.
const DIRECT: CodexRouting = { routed: false, reasons: [] };

/** Matches the latency readout used on the station signboard. */
const SLOW_LATENCY_MS = 1000;

const lineConfig = (provider: Provider) =>
  String(provider.settingsConfig?.config ?? "");

function protocolLabel(provider: Provider, official: boolean): string {
  const raw =
    provider.meta?.apiFormat || extractCodexWireApi(lineConfig(provider)) || "";
  const label = PROTOCOL_LABELS[raw];
  if (!label) return official ? "Responses" : "自动";
  // Design 01: a detected protocol reads "自动 · Chat", a chosen one "Chat".
  return provider.meta?.apiFormatAutoDetected ? `自动 · ${label}` : label;
}

/** The sentence behind the "本地路由" marker. */
export function routingExplanation(routing: CodexRouting): string {
  const reasons = routing.reasons
    .map((reason) => codexRoutingReasonLabels[reason])
    .join("、");
  return `经 Chimera++ 本地路由转发（${reasons}），需保持 Chimera++ 运行。`;
}

type Reading =
  | { kind: "none" }
  | { kind: "checking" }
  | { kind: "ok"; latencyMs: number }
  | { kind: "error"; message: string };

export function ProviderLineTable({
  readOnly = false,
  designSamples,
  toolbarContainer,
  onManage,
  managerTriggerRef,
  providers,
  currentId,
  currentConnection,
  switchingId,
  deletingProviderId,
  labels,
  testAllRequested = false,
  onTestAllHandled,
  onSwitch,
  onEdit,
  onDelete,
}: {
  readOnly?: boolean;
  designSamples?: readonly CanonicalLine[];
  toolbarContainer?: HTMLDivElement | null;
  onManage?: () => void;
  managerTriggerRef?: RefObject<HTMLButtonElement>;
  providers: Provider[];
  currentId: string;
  /** The current line's own connection test, shown on its row too. */
  currentConnection?: ConnectionState;
  switchingId: string | null;
  deletingProviderId: string | null;
  labels: Map<string, { name: string; source: string; official: boolean }>;
  /** Set by the command palette; the table runs one bulk test and clears it. */
  testAllRequested?: boolean;
  onTestAllHandled?: () => void;
  onSwitch: (provider: Provider) => Promise<void>;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, EndpointLatencyResult>>(
    {},
  );
  const [testing, setTesting] = useState(false);
  const generation = useRef(0);
  const search = useRef<HTMLInputElement>(null);
  const routing = useMemo(
    () =>
      new Map(
        providers.map((provider) => [
          provider.id,
          codexProviderRouting(provider),
        ]),
      ),
    [providers],
  );
  useEffect(() => {
    generation.current++;
    setTesting(false);
    setResults({});
    return () => {
      generation.current++;
    };
  }, [providers]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (openDialogCount() > 0 || event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const endpoints = providers
    .map((p) => extractCodexBaseUrl(lineConfig(p)))
    .filter((url): url is string => Boolean(url));
  const testAll = async () => {
    if (readOnly || testing || !endpoints.length) return;
    const token = ++generation.current;
    setTesting(true);
    try {
      const measured = await vscodeApi.testApiEndpoints(
        [...new Set(endpoints)],
        { timeoutSecs: 12 },
      );
      if (generation.current === token)
        setResults(Object.fromEntries(measured.map((r) => [r.url, r])));
    } catch (error) {
      if (generation.current === token)
        setResults(
          Object.fromEntries(
            endpoints.map((url) => [
              url,
              { url, latency: null, error: String(error) },
            ]),
          ),
        );
    } finally {
      if (generation.current === token) setTesting(false);
    }
  };
  // One run per request, also when React replays effects in development.
  const requestRunning = useRef(false);
  useEffect(() => {
    if (!testAllRequested || requestRunning.current) return;
    requestRunning.current = true;
    onTestAllHandled?.();
    void testAll().finally(() => {
      requestRunning.current = false;
    });
  }, [testAllRequested]);
  const current = providers.find((p) => p.id === currentId);
  const currentEndpoint = current
    ? extractCodexBaseUrl(lineConfig(current))
    : undefined;
  const readingFor = (endpoint: string | undefined): Reading => {
    if (!endpoint) return { kind: "none" };
    if (testing) return { kind: "checking" };
    const result = results[endpoint];
    if (result) {
      if (result.error) return { kind: "error", message: result.error };
      return result.latency != null
        ? { kind: "ok", latencyMs: result.latency }
        : { kind: "none" };
    }
    // Latency belongs to the address: rows sharing the current line's address
    // show the signboard's measurement as well.
    if (endpoint !== currentEndpoint || !currentConnection)
      return { kind: "none" };
    if (currentConnection.kind === "checking") return { kind: "checking" };
    if (currentConnection.kind === "error")
      return { kind: "error", message: currentConnection.message };
    if (
      currentConnection.kind === "connected" &&
      currentConnection.latencyMs != null
    )
      return { kind: "ok", latencyMs: currentConnection.latencyMs };
    return { kind: "none" };
  };
  const filtered = providers.filter((p) => {
    const label = labels.get(p.id);
    const config = lineConfig(p);
    return `${label?.name} ${p.name} ${extractCodexBaseUrl(config)} ${extractCodexModelName(config)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  });
  const toolbar = (
    <div className="provider-table-tools">
      <label className="provider-table-search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选线路"
          aria-label="筛选线路"
        />
        <kbd>Ctrl F</kbd>
      </label>
      <button
        type="button"
        onClick={() => void testAll()}
        disabled={readOnly || testing || !endpoints.length}
        title={endpoints.length ? undefined : "没有填写请求地址的线路可测速"}
      >
        {testing ? (
          <RefreshCw size={14} className="spin" aria-hidden="true" />
        ) : (
          <Gauge size={14} aria-hidden="true" />
        )}
        {testing ? "测速中…" : "全部测速"}
      </button>
    </div>
  );

  return (
    <>
      {toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbar}
      {(onManage || readOnly) && filtered.length === 0 && (
        <button
          type="button"
          className="provider-group-manage"
          ref={managerTriggerRef}
          onClick={readOnly ? undefined : onManage}
          disabled={readOnly}
        >
          管理线路
        </button>
      )}
      <div className="provider-table" role="table" aria-label="线路切换">
        <div className="provider-table-row provider-table-head" role="row">
          <span role="columnheader" aria-label="状态" />
          <span role="columnheader" aria-label="标识" />
          <span role="columnheader">线路</span>
          <span role="columnheader">认证</span>
          <span role="columnheader">协议</span>
          <span role="columnheader">模型</span>
          <span role="columnheader">延迟</span>
          <span role="columnheader">操作</span>
        </div>
        {[true, false].map((official) => {
          const group = filtered.filter(
            (p) => labels.get(p.id)?.official === official,
          );
          if (!group.length) return null;
          return (
            <div role="rowgroup" key={String(official)}>
              <div role="row">
                <div
                  role="cell"
                  aria-colspan={8}
                  className="provider-table-group"
                >
                  {official ? "官方账号" : "第三方线路"}
                  <span>{group.length}</span>
                  {(onManage || readOnly) &&
                    official ===
                      filtered.some(
                        (provider) => labels.get(provider.id)?.official,
                      ) && (
                      <button
                        type="button"
                        ref={managerTriggerRef}
                        onClick={readOnly ? undefined : onManage}
                        disabled={readOnly}
                        className="provider-group-manage"
                        aria-label="管理线路"
                      >
                        管理线路 <span aria-hidden="true">→</span>
                      </button>
                    )}
                </div>
              </div>
              {group.map((p) => {
                const label = labels.get(p.id)!;
                const sample = readOnly
                  ? designSamples?.find((line) => line.id === p.id)
                  : undefined;
                const config = lineConfig(p);
                const endpoint = extractCodexBaseUrl(config);
                const reading = readingFor(endpoint);
                const active = p.id === currentId;
                const protocol = sample?.protocol ?? protocolLabel(p, official);
                const route = official ? DIRECT : (routing.get(p.id) ?? DIRECT);
                const model =
                  extractCodexModelName(config) ||
                  (official ? "Codex 默认" : "未设置");
                const busy =
                  readOnly || Boolean(switchingId || deletingProviderId);
                return (
                  <div
                    className={`provider-table-row${active ? " is-current" : ""}${official ? " is-official" : ""}`}
                    role="row"
                    key={p.id}
                  >
                    <span role="cell" className="provider-row-indicator" />
                    <span role="cell" className="provider-row-badge">
                      <LineBadge line={p} />
                    </span>
                    <span role="cell">
                      <button
                        type="button"
                        className="provider-row-name"
                        aria-label={`${label.name}，${label.source}${active ? "，当前线路" : ""}`}
                        onClick={() => void onSwitch(p)}
                        disabled={busy || active}
                      >
                        <b title={label.name}>{label.name}</b>
                        <small
                          className={
                            sample?.expired
                              ? "is-expired"
                              : sample?.timeout
                                ? "is-timeout"
                                : official
                                  ? "is-account"
                                  : undefined
                          }
                          title={sample?.sub ?? endpoint ?? label.source}
                        >
                          {sample?.sub ??
                            (endpoint?.replace(/^https?:\/\//, "") ||
                              label.source)}
                        </small>
                      </button>
                    </span>
                    <span role="cell">
                      {official ? "ChatGPT 登录" : "API 密钥"}
                    </span>
                    <span role="cell" className="provider-row-protocol">
                      <span
                        className={
                          /^[A-Za-z]+$/.test(protocol)
                            ? "provider-direct-protocol"
                            : undefined
                        }
                        title={protocol}
                      >
                        {protocol}
                      </span>
                      {route.routed && (
                        <span className="provider-route-mark">
                          本地路由
                          <HelpTip title="本地路由">
                            {routingExplanation(route)}
                          </HelpTip>
                        </span>
                      )}
                    </span>
                    <code role="cell" title={model}>
                      {model}
                    </code>
                    <span
                      role="cell"
                      className="provider-row-latency"
                      title={
                        reading.kind === "error" ? reading.message : undefined
                      }
                    >
                      {sample ? (
                        sample.expired ? null : (
                          <span
                            className={`provider-sample-latency ${sample.timeout ? "is-timeout" : ""}`}
                          >
                            {sample.isSlow && (
                              <AlertTriangle size={12} className="is-slow" />
                            )}
                            {sample.timeout ? (
                              <CircleX size={12} />
                            ) : (
                              `${sample.latencyMs} ms`
                            )}
                            <strong
                              className={
                                sample.latencyGrade === "快"
                                  ? "is-fast"
                                  : sample.latencyGrade === "慢"
                                    ? "is-slow"
                                    : ""
                              }
                            >
                              {sample.latencyGrade}
                            </strong>
                            {sample.timeout && <RefreshCw size={12} />}
                          </span>
                        )
                      ) : reading.kind === "checking" ? (
                        <span className="provider-latency-muted">测速中</span>
                      ) : reading.kind === "error" ? (
                        <span className="is-timeout">失败</span>
                      ) : reading.kind === "ok" ? (
                        <>
                          <span>{`${reading.latencyMs} ms`}</span>
                          {reading.latencyMs >= SLOW_LATENCY_MS && (
                            <strong className="is-slow"> 慢</strong>
                          )}
                        </>
                      ) : (
                        <span className="provider-latency-muted">—</span>
                      )}
                    </span>
                    <span role="cell" className="provider-row-actions">
                      {active ? (
                        <span className="provider-current-tag">当前</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void onSwitch(p)}
                          disabled={busy}
                          aria-label={
                            sample?.expired
                              ? `重新登录${label.name}`
                              : `切换到${label.name}`
                          }
                        >
                          {switchingId === p.id ? (
                            <LoaderCircle size={14} className="spin" />
                          ) : sample?.expired ? (
                            "重新登录"
                          ) : (
                            "切换"
                          )}
                        </button>
                      )}
                      {(!official || (readOnly && sample)) && (
                        <>
                          <button
                            type="button"
                            onClick={() => onEdit(p)}
                            disabled={busy}
                            aria-label={`编辑${label.name}`}
                            title="编辑线路"
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            type="button"
                            className="provider-row-delete"
                            onClick={() => onDelete(p)}
                            disabled={busy || active}
                            aria-label={`删除${label.name}`}
                            title={
                              active
                                ? "当前线路正在使用，请先切换到其他线路"
                                : "删除线路"
                            }
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
        {!filtered.length && (
          <div className="provider-table-empty">
            <p>没有匹配的线路。</p>
            <button type="button" onClick={() => setQuery("")}>
              清除筛选
            </button>
          </div>
        )}
      </div>
    </>
  );
}
