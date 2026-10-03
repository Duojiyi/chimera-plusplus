import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Gauge,
  AlertTriangle,
  CircleX,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { openDialogCount } from "@/hooks/useDialogFocus";
import type { Provider } from "@/types";
import type { CanonicalLine } from "@/data/canonicalData";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
  extractCodexWireApi,
} from "@/utils/providerConfigUtils";
import { vscodeApi, type EndpointLatencyResult } from "@/lib/api/vscode";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import "./ProviderLineTable.css";

export function ProviderLineTable({
  readOnly = false,
  designSamples,
  toolbarContainer,
  onManage,
  managerTriggerRef,
  providers,
  currentId,
  switchingId,
  deletingProviderId,
  labels,
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
  switchingId: string | null;
  deletingProviderId: string | null;
  labels: Map<
    string,
    { name: string; source: string; mark: string; official: boolean }
  >;
  onSwitch: (provider: Provider) => Promise<void>;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, EndpointLatencyResult>>(
    {},
  );
  const [testing, setTesting] = useState(false);
  const generation = useRef(0);
  const search = useRef<HTMLInputElement>(null);
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
  const testAll = async () => {
    if (readOnly || testing) return;
    const token = ++generation.current;
    setTesting(true);
    const endpoints = providers
      .map((p) => extractCodexBaseUrl(String(p.settingsConfig?.config ?? "")))
      .filter((url): url is string => Boolean(url));
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
  const filtered = providers.filter((p) => {
    const label = labels.get(p.id);
    const config = String(p.settingsConfig?.config ?? "");
    return `${label?.name} ${p.name} ${extractCodexBaseUrl(config)} ${extractCodexModelName(config)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  });
  const toolbar = (
    <div className="provider-table-tools">
      <label className="provider-table-search">
        <Search size={14} />
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
        disabled={
          readOnly ||
          testing ||
          !providers.some((p) =>
            extractCodexBaseUrl(String(p.settingsConfig?.config ?? "")),
          )
        }
      >
        {testing ? (
          <RefreshCw size={14} className="spin" />
        ) : (
          <Gauge size={14} />
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
                const config = String(p.settingsConfig?.config ?? "");
                const endpoint = extractCodexBaseUrl(config);
                const result = endpoint ? results[endpoint] : undefined;
                const active = p.id === currentId;
                const protocol =
                  sample?.protocol ??
                  ((
                    {
                      responses: "Responses",
                      chat: "Chat",
                      openai_responses: "Responses",
                      openai_chat: "Chat",
                      anthropic: "Anthropic",
                    } as Record<string, string>
                  )[p.meta?.apiFormat || extractCodexWireApi(config) || ""] ||
                    "自动");
                const busy =
                  readOnly || Boolean(switchingId || deletingProviderId);
                return (
                  <div
                    className={`provider-table-row${active ? " is-current" : ""}${official ? " is-official" : ""}`}
                    role="row"
                    key={p.id}
                  >
                    <span role="cell" className="provider-row-indicator" />
                    <span
                      role="cell"
                      className={`provider-row-badge${official ? " is-official" : ""}`}
                      style={{
                        backgroundColor:
                          p.iconColor || (official ? "#1A1E24" : "#537197"),
                      }}
                    >
                      {sample?.mark ?? label.mark}
                    </span>
                    <span role="cell">
                      <button
                        type="button"
                        className="provider-row-name"
                        aria-label={`${label.name}，${label.source}${active ? "，当前线路" : ""}`}
                        onClick={() => void onSwitch(p)}
                        disabled={busy || active}
                      >
                        <b>{label.name}</b>
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
                    <span
                      role="cell"
                      className={
                        /^[A-Za-z]+$/.test(protocol)
                          ? "provider-direct-protocol"
                          : undefined
                      }
                    >
                      {protocol}
                    </span>
                    <code
                      role="cell"
                      title={extractCodexModelName(config) || "未设置"}
                    >
                      {extractCodexModelName(config) || "未设置"}
                    </code>
                    <span
                      role="cell"
                      className="provider-row-latency"
                      title={result?.error}
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
                      ) : testing && endpoint ? (
                        "测速中"
                      ) : result?.error ? (
                        "失败"
                      ) : result?.latency != null ? (
                        `${result.latency} ms`
                      ) : (
                        "—"
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
                          >
                            <Pencil size={16} />
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                disabled={busy}
                                aria-label={`更多${label.name}操作`}
                              >
                                <MoreHorizontal size={18} />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onSelect={() => void onDelete(p)}
                                disabled={busy || active}
                                aria-label={`删除${label.name}`}
                                title={
                                  active
                                    ? "当前线路正在使用，请先切换到其他线路"
                                    : undefined
                                }
                              >
                                <Trash2 size={14} />
                                删除线路
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
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
          <p className="provider-table-empty">没有匹配的线路。</p>
        )}
      </div>
    </>
  );
}
