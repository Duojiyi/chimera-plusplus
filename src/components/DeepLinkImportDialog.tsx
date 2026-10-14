import { useState, useEffect, useId, useMemo, useRef } from "react";
import {
  DeepLinkImportPreview,
  DeepLinkImportRequest,
  deeplinkApi,
} from "@/lib/api/deeplink";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { PromptConfirmation } from "./deeplink/PromptConfirmation";
import { McpConfirmation } from "./deeplink/McpConfirmation";
import { SkillConfirmation } from "./deeplink/SkillConfirmation";
import { ProviderIcon } from "./ProviderIcon";
import { classifyEndpoint, maskValue, riskI18nKey } from "@/utils/deeplinkRisk";
import "./DeepLinkImportDialog.css";

function safeDisplayUrl(value?: string): string {
  if (!value) return "—";

  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Never render a raw malformed URL: it may contain credentials or a token
    // in a query-like suffix.
    return "[invalid URL]";
  }
}

/** `host` or `host:port`, the part a non-expert can check at a glance. */
function hostOf(value: string): string | null {
  try {
    return new URL(value.trim()).host || null;
  } catch {
    return null;
  }
}

const TOOL_NAMES: Record<string, string> = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  claude_desktop: "Claude Desktop",
  codex: "Codex",
  gemini: "Gemini CLI",
  grokbuild: "Grok Build",
  opencode: "OpenCode",
  pi: "Pi",
};

/** Tools that enable several lines at once instead of switching one. */
const ADDITIVE_TOOLS = new Set(["opencode", "pi"]);

/** How many ignored setting names are listed before "等 N 项". */
const IGNORED_SHOWN = 12;

/** Backend error text without the generic "无效输入: " prefix. */
function errorReason(error: unknown): string {
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  return text.replace(/^无效输入:\s*/, "").trim();
}

/**
 * Env values a Claude / Gemini link config carries, for display next to the
 * backend's verdicts. Quiet on purpose: the input may hold secrets, so a
 * malformed config is never logged.
 */
function configEnvValues(
  request: DeepLinkImportRequest,
): Record<string, string> {
  if (!request.config) return {};
  if (request.configFormat && request.configFormat !== "json") return {};
  try {
    let normalized = request.config
      .trim()
      .replace(/ /g, "+")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    if (normalized.length % 4 !== 0) {
      normalized += "=".repeat(4 - (normalized.length % 4));
    }
    const bytes = Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object") return {};
    const source =
      request.app === "gemini"
        ? parsed
        : (parsed as Record<string, unknown>).env;
    if (!source || typeof source !== "object") return {};
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string" || typeof value === "number") {
        values[key] = String(value);
      }
    }
    return values;
  } catch {
    return {};
  }
}

export function DeepLinkImportDialog({
  request: incomingRequest,
  onHandled,
  onProviderImported,
  onImported,
}: {
  request: DeepLinkImportRequest;
  onHandled: () => Promise<void>;
  onImported?: () => void;
  onProviderImported?: (app?: DeepLinkImportRequest["app"]) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const ids = useId();
  const [request, setRequest] = useState(incomingRequest);
  const [isImporting, setIsImporting] = useState(false);
  const [isPreparing, setIsPreparing] = useState(
    !!(incomingRequest.config || incomingRequest.configUrl),
  );
  const [mergeError, setMergeError] = useState<string | null>(null);
  // MH-4: what the backend will store and write; import waits for it.
  const [preview, setPreview] = useState<DeepLinkImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmedEnvKeys, setConfirmedEnvKeys] = useState<string[]>([]);
  // Both switches start off whatever the link asks for: switching lines and
  // running a script are the user's decisions, not the link's.
  const [activate, setActivate] = useState(false);
  const [usageEnabled, setUsageEnabled] = useState(false);
  const [imported, setImported] = useState(false);
  const inFlightRef = useRef(false);
  const importedRef = useRef(false);

  // 容错判断：MCP 导入结果可能缺少 type 字段
  const isMcpImportResult = (
    value: unknown,
  ): value is {
    importedCount: number;
    importedIds: string[];
    failed: Array<{ id: string; error: string }>;
    type?: "mcp";
  } => {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    return (
      typeof v.importedCount === "number" &&
      Array.isArray(v.importedIds) &&
      Array.isArray(v.failed)
    );
  };

  useEffect(() => {
    let active = true;
    if (incomingRequest.config || incomingRequest.configUrl) {
      setIsPreparing(true);
      void deeplinkApi
        .mergeDeeplinkConfig(incomingRequest)
        .then((merged) => {
          if (active) setRequest(merged);
        })
        .catch((error: unknown) => {
          if (active) setMergeError(errorReason(error));
        })
        .finally(() => {
          if (active) setIsPreparing(false);
        });
    }
    return () => {
      active = false;
    };
  }, [incomingRequest]);

  useEffect(() => {
    let active = true;
    void deeplinkApi
      .previewDeeplinkImport(incomingRequest)
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch((error: unknown) => {
        if (active) setPreviewError(errorReason(error));
      });
    return () => {
      active = false;
    };
  }, [incomingRequest]);

  const isProvider = request.resource === "provider" || !request.resource;
  const tool = TOOL_NAMES[request.app ?? ""] ?? request.app ?? "该工具";
  const additive = ADDITIVE_TOOLS.has(request.app ?? "");
  const endpoints = useMemo(
    () =>
      (request.endpoint ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    [request.endpoint],
  );
  const primaryEndpoint = endpoints[0];
  const primaryHost = primaryEndpoint ? hostOf(primaryEndpoint) : null;
  const primaryRisk = primaryEndpoint
    ? classifyEndpoint(primaryEndpoint)
    : null;
  const mayActivate = isProvider && preview?.mayActivate === true;
  const activateNow = mayActivate && activate;
  const usage = isProvider ? (preview?.usage ?? null) : null;
  const ignored = preview?.ignored ?? [];
  const deniedEnvKeys = useMemo(
    () =>
      new Set(
        (preview?.env ?? [])
          .filter((entry) => entry.status === "denied")
          .map((entry) => entry.key),
      ),
    [preview],
  );
  const envValues = useMemo(() => configEnvValues(request), [request]);
  const flaggedEnv = (preview?.env ?? []).filter(
    (entry) => entry.status !== "allowed",
  );
  const allowedEnvKeys = (preview?.env ?? [])
    .filter((entry) => entry.status === "allowed")
    .map((entry) => entry.key);

  // Import would fail on these anyway; say so before the user confirms.
  const missing = isProvider
    ? [
        !request.apiKey?.trim() ? "API Key" : null,
        !primaryEndpoint ? "请求地址" : null,
      ].filter((item): item is string => item !== null)
    : [];
  const blockingError = previewError ?? mergeError;
  const blocked =
    isPreparing || blockingError !== null || !preview || missing.length > 0;

  const toggleEnvKey = (key: string, confirmed: boolean) =>
    setConfirmedEnvKeys((current) =>
      confirmed
        ? [...current.filter((k) => k !== key), key]
        : current.filter((k) => k !== key),
    );

  const handleImport = async () => {
    if (inFlightRef.current || (blocked && !importedRef.current)) return;
    inFlightRef.current = true;
    setIsImporting(true);

    try {
      // A failed acknowledgement/cache refresh must never repeat a successful import.
      if (importedRef.current) {
        await onHandled();
        return;
      }
      const result = await deeplinkApi.importFromDeeplink({
        ...request,
        confirmedEnvKeys,
        // The dialog's switches are the user's decisions; the link's own
        // `enabled` / `usageEnabled` were only shown as requests.
        ...(isProvider
          ? {
              enabled: activateNow,
              confirmedUsageEnabled: usage ? usageEnabled : undefined,
            }
          : {}),
      });
      importedRef.current = true;
      setImported(true);
      onImported?.();
      if (typeof result === "string" || result.type === "provider") {
        onProviderImported?.(request.app);
      }
      const refreshMcp = async (summary: {
        importedCount: number;
        importedIds: string[];
        failed: Array<{ id: string; error: string }>;
      }) => {
        // 强制刷新 MCP 相关缓存，确保管理页重新从数据库加载
        await queryClient.invalidateQueries({
          queryKey: ["mcp", "all"],
          refetchType: "all",
        });
        await queryClient.refetchQueries({
          queryKey: ["mcp", "all"],
          type: "all",
        });

        if (summary.failed.length > 0) {
          toast.warning(t("deeplink.mcpPartialSuccess"), {
            description: t("deeplink.mcpPartialSuccessDescription", {
              success: summary.importedCount,
              failed: summary.failed.length,
            }),
          });
        } else {
          toast.success(t("deeplink.mcpImportSuccess"), {
            description: t("deeplink.mcpImportSuccessDescription", {
              count: summary.importedCount,
            }),
            closeButton: true,
          });
        }
      };

      // Handle different result types
      if (typeof result === "object" && "type" in result) {
        if (result.type === "provider") {
          await queryClient.invalidateQueries({
            queryKey: ["providers", request.app],
          });
          toast.success(t("deeplink.importSuccess"), {
            description: t("deeplink.importSuccessDescription", {
              name: request.name,
            }),
            closeButton: true,
          });
        } else if (result.type === "prompt") {
          // Prompts don't use React Query, trigger a custom event for refresh
          window.dispatchEvent(
            new CustomEvent("prompt-imported", {
              detail: { app: request.app },
            }),
          );
          toast.success(t("deeplink.promptImportSuccess"), {
            description: t("deeplink.promptImportSuccessDescription", {
              name: request.name,
            }),
            closeButton: true,
          });
        } else if (result.type === "mcp") {
          await refreshMcp(result);
        } else if (result.type === "skill") {
          // Refresh Skills with aggressive strategy
          queryClient.invalidateQueries({
            queryKey: ["skills"],
            refetchType: "all",
          });
          await queryClient.refetchQueries({
            queryKey: ["skills"],
            type: "all",
          });
          toast.success(t("deeplink.skillImportSuccess"), {
            description: t("deeplink.skillImportSuccessDescription", {
              repo: request.repo,
            }),
            closeButton: true,
          });
        }
      } else if (isMcpImportResult(result)) {
        // 兜底处理：旧版本后端可能未返回 type 字段
        await refreshMcp(result);
      } else {
        // Legacy return type (string ID) - assume provider
        await queryClient.invalidateQueries({
          queryKey: ["providers", request.app],
        });
        toast.success(t("deeplink.importSuccess"), {
          description: t("deeplink.importSuccessDescription", {
            name: request.name,
          }),
          closeButton: true,
        });
      }

      // Close dialog after all refreshes complete
      await onHandled();
    } catch (error) {
      console.error("Failed to finish deep link import");
      if (importedRef.current) {
        toast.error(
          t("deeplink.importFinalizeError", {
            defaultValue:
              "导入已完成，但刷新或确认清理失败。请点击“完成”重试，不会重复导入。",
          }),
        );
      } else {
        toast.error(t("deeplink.importError"), {
          description: errorReason(error),
        });
      }
    } finally {
      inFlightRef.current = false;
      setIsImporting(false);
    }
  };

  const handleCancel = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsImporting(true);
    try {
      await onHandled();
    } catch {
      toast.error(t("deeplink.importError"));
    } finally {
      inFlightRef.current = false;
      setIsImporting(false);
    }
  };

  const apiKey = request.apiKey?.trim() ?? "";
  const apiKeyText = !apiKey
    ? "未提供"
    : apiKey.length > 8
      ? `已提供（末 4 位 ${apiKey.slice(-4)}）`
      : "已提供";

  const getTitle = () => {
    switch (request.resource) {
      case "prompt":
        return t("deeplink.importPrompt");
      case "mcp":
        return t("deeplink.importMcp");
      case "skill":
        return t("deeplink.importSkill");
      default:
        return "确认导入线路";
    }
  };

  const getDescription = () => {
    switch (request.resource) {
      case "prompt":
        return t("deeplink.importPromptDescription");
      case "mcp":
        return t("deeplink.importMcpDescription");
      case "skill":
        return t("deeplink.importSkillDescription");
      default:
        return "这条线路来自导入链接。确认之前不会保存或修改任何内容。";
    }
  };

  const activateId = `${ids}-activate`;
  const usageId = `${ids}-usage`;
  const writtenFiles = preview?.targetPaths ?? [];
  const usageLines = usage ? usage.code.split("\n").length : 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void handleCancel();
      }}
    >
      <DialogContent className="sm:max-w-[600px]" zIndex="top">
        {/* 标题显式左对齐，避免默认居中样式影响 */}
        <DialogHeader className="text-left sm:text-left">
          <DialogTitle>{getTitle()}</DialogTitle>
          <DialogDescription>{getDescription()}</DialogDescription>
        </DialogHeader>

        <div className="dl-body">
          {request.resource === "prompt" && (
            <PromptConfirmation request={request} />
          )}
          {request.resource === "mcp" && (
            <McpConfirmation request={request} deniedEnvKeys={deniedEnvKeys} />
          )}
          {request.resource === "skill" && (
            <SkillConfirmation request={request} />
          )}

          {isProvider && (
            <>
              {/* Who and what */}
              <section className="dl-summary" aria-label="要导入的线路">
                {request.icon && (
                  <ProviderIcon
                    icon={request.icon}
                    name={request.name || request.icon}
                    size={40}
                  />
                )}
                <div className="dl-summary-text">
                  <strong className="dl-summary-name">{request.name}</strong>
                  <span className="dl-summary-tool">用于 {tool}</span>
                </div>
              </section>

              {/* Where requests go */}
              <section
                className="dl-host"
                aria-labelledby={`${ids}-host-title`}
              >
                <h3 id={`${ids}-host-title`} className="dl-host-label">
                  请求将发往
                </h3>
                <p className="dl-host-name">{primaryHost ?? "—"}</p>
                {primaryEndpoint && (
                  <p className="dl-host-url">
                    {safeDisplayUrl(primaryEndpoint)}
                  </p>
                )}
                {primaryRisk && (
                  <p className="dl-host-risk">{t(riskI18nKey(primaryRisk))}</p>
                )}
                {endpoints.length > 1 && (
                  <div className="dl-host-spares">
                    <span>备用地址</span>
                    <ul className="dl-paths">
                      {endpoints.slice(1).map((endpoint, index) => (
                        <li key={index}>{safeDisplayUrl(endpoint)}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>

              {/* Details */}
              <dl className="dl-fields">
                <dt>API Key</dt>
                <dd className={apiKey.length > 8 ? "dl-mono" : undefined}>
                  {apiKeyText}
                </dd>
                {request.model && (
                  <>
                    <dt>{request.app === "claude" ? "主模型" : "模型"}</dt>
                    <dd className="dl-mono">{request.model}</dd>
                  </>
                )}
                {request.app === "claude" && request.haikuModel && (
                  <>
                    <dt>Haiku 模型</dt>
                    <dd className="dl-mono">{request.haikuModel}</dd>
                  </>
                )}
                {request.app === "claude" && request.sonnetModel && (
                  <>
                    <dt>Sonnet 模型</dt>
                    <dd className="dl-mono">{request.sonnetModel}</dd>
                  </>
                )}
                {request.app === "claude" && request.opusModel && (
                  <>
                    <dt>Opus 模型</dt>
                    <dd className="dl-mono">{request.opusModel}</dd>
                  </>
                )}
                {request.homepage && (
                  <>
                    <dt>主页</dt>
                    <dd>{safeDisplayUrl(request.homepage)}</dd>
                  </>
                )}
                {request.notes && (
                  <>
                    <dt>备注</dt>
                    <dd>{request.notes}</dd>
                  </>
                )}
              </dl>

              {/* What confirming does */}
              <section
                className="dl-section"
                aria-labelledby={`${ids}-outcome-title`}
              >
                <h3 id={`${ids}-outcome-title`} className="dl-section-title">
                  确认后
                </h3>
                <p className="dl-note">
                  这条线路会保存到 Chimera++，之后可以随时编辑或删除。
                </p>
                {mayActivate && (
                  <div className="dl-toggle">
                    <div className="dl-toggle-text">
                      <label htmlFor={activateId}>导入后切换到此线路</label>
                      <p id={`${activateId}-note`} className="dl-note">
                        {activateNow
                          ? `确认后立即切换，并写入下列文件；${tool} 之后的请求会发往 ${primaryHost ?? "上面的地址"}。`
                          : "默认关闭。"}
                      </p>
                    </div>
                    <Switch
                      id={activateId}
                      checked={activate}
                      onCheckedChange={setActivate}
                      aria-describedby={`${activateId}-note`}
                      disabled={isImporting || imported}
                    />
                  </div>
                )}
                {request.enabled && !activateNow && (
                  <p className="dl-note">
                    {mayActivate
                      ? "链接希望导入后立即切换；是否切换由你决定。"
                      : `链接希望导入后立即启用；通过链接导入的 ${tool} 线路只会保存，不会自动启用。`}
                  </p>
                )}
                {!activateNow && (
                  <p className="dl-statement">
                    {additive
                      ? `不会启用这条线路，${tool} 的配置文件保持不变。以后可以在 ${tool} 页面手动启用。`
                      : `不会切换当前线路，${tool} 的配置文件保持不变。以后可以在线路列表中手动切换。`}
                  </p>
                )}
                {writtenFiles.length > 0 && (
                  <div className="dl-files">
                    <span className="dl-note">
                      {activateNow
                        ? "将立即写入："
                        : additive
                          ? "启用这条线路时才会写入："
                          : "切换到这条线路时才会写入："}
                    </span>
                    <ul className="dl-paths">
                      {writtenFiles.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>

              {/* Usage query script */}
              {usage && (
                <section
                  className="dl-section dl-usage"
                  aria-labelledby={`${ids}-usage-title`}
                >
                  <h3 id={`${ids}-usage-title`} className="dl-section-title">
                    用量查询脚本
                  </h3>
                  <p className="dl-note">
                    链接附带了一段查询余额和用量的脚本。启用后，Chimera++
                    会在本机定期运行它；脚本只能访问下面的地址，并可能使用这条线路的
                    API Key。
                  </p>
                  <dl className="dl-fields">
                    <dt>会访问</dt>
                    <dd>
                      {usage.hosts.length > 0 ? (
                        <ul className="dl-paths">
                          {usage.hosts.map((host) => (
                            <li key={host} className="dl-usage-host">
                              {host}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        "无法确定"
                      )}
                    </dd>
                    {usage.autoIntervalMinutes ? (
                      <>
                        <dt>自动查询</dt>
                        <dd>每 {usage.autoIntervalMinutes} 分钟</dd>
                      </>
                    ) : null}
                  </dl>
                  <details className="dl-details">
                    <summary>查看脚本内容（{usageLines} 行）</summary>
                    <pre className="dl-code" tabIndex={0}>
                      {usage.code}
                    </pre>
                  </details>
                  {usage.linkRequestsEnabled && (
                    <p className="dl-note">
                      链接希望导入后启用用量查询；是否启用由你决定。
                    </p>
                  )}
                  <div className="dl-toggle">
                    <div className="dl-toggle-text">
                      <label htmlFor={usageId}>导入后启用用量查询</label>
                      <p id={`${usageId}-note`} className="dl-note">
                        {usageEnabled
                          ? "确认后会按上面的设置定期运行这段脚本。"
                          : "默认关闭。关闭时只保存脚本，不会运行。"}
                      </p>
                    </div>
                    <Switch
                      id={usageId}
                      checked={usageEnabled}
                      onCheckedChange={setUsageEnabled}
                      aria-describedby={`${usageId}-note`}
                      disabled={isImporting || imported}
                    />
                  </div>
                </section>
              )}

              {/* Environment variables the line would export */}
              {flaggedEnv.length > 0 && (
                <section
                  className="dl-section"
                  aria-labelledby={`${ids}-env-title`}
                >
                  <h3 id={`${ids}-env-title`} className="dl-section-title">
                    环境变量
                  </h3>
                  <ul className="dl-env">
                    {flaggedEnv.map(({ key, status }) => (
                      <li key={key} className="dl-env-row">
                        <span className="dl-mono">
                          {key}
                          {envValues[key] !== undefined && (
                            <span className="dl-env-value">
                              {" = "}
                              {maskValue(key, envValues[key])}
                            </span>
                          )}
                        </span>
                        {status === "denied" ? (
                          <span className="dl-env-denied">
                            {t("deeplink.envDenied", {
                              defaultValue: "出于安全原因，此变量不会导入",
                            })}
                          </span>
                        ) : (
                          <label className="dl-env-confirm">
                            <input
                              type="checkbox"
                              checked={confirmedEnvKeys.includes(key)}
                              onChange={(event) =>
                                toggleEnvKey(key, event.target.checked)
                              }
                              disabled={isImporting || imported}
                            />
                            {t("deeplink.envConfirm", {
                              defaultValue:
                                "此变量不在该工具的允许清单中，勾选后才会导入",
                            })}
                          </label>
                        )}
                      </li>
                    ))}
                  </ul>
                  {allowedEnvKeys.length > 0 && (
                    <p className="dl-note">
                      常用变量会照常导入：
                      <span className="dl-mono">
                        {allowedEnvKeys.join("、")}
                      </span>
                    </p>
                  )}
                </section>
              )}

              {/* Settings the import leaves out */}
              {ignored.length > 0 && (
                <section
                  className="dl-section"
                  aria-labelledby={`${ids}-ignored-title`}
                >
                  <h3 id={`${ids}-ignored-title`} className="dl-section-title">
                    不会导入的设置
                  </h3>
                  <p className="dl-note">
                    链接里的以下设置不属于这条线路，导入时会忽略：
                  </p>
                  <ul className="dl-chips">
                    {ignored.slice(0, IGNORED_SHOWN).map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                    {ignored.length > IGNORED_SHOWN && (
                      <li className="dl-chips-more">等 {ignored.length} 项</li>
                    )}
                  </ul>
                </section>
              )}
            </>
          )}

          {/* MH-4: exactly what will be stored. */}
          {preview && (
            <details className="dl-details">
              <summary>
                {isProvider
                  ? "查看将保存的完整内容（包含 API Key）"
                  : t("deeplink.fullContent", { defaultValue: "完整内容" })}
              </summary>
              <pre className="dl-code dl-code-wrap" tabIndex={0}>
                {preview.content}
              </pre>
            </details>
          )}
          {!isProvider && preview && (
            <div className="dl-files">
              {preview.targetPaths.length > 0 && (
                <>
                  <span className="dl-note">
                    {t("deeplink.targetPaths", { defaultValue: "目标文件" })}
                  </span>
                  <ul className="dl-paths">
                    {preview.targetPaths.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </>
              )}
              <p className="dl-note">
                {preview.writesLive
                  ? t("deeplink.writesLive", {
                      defaultValue: "确认后会立即写入上述文件。",
                    })
                  : t("deeplink.importOnly", {
                      defaultValue:
                        "仅导入：确认后不会写入任何配置文件，需要时再手动启用。",
                    })}
              </p>
            </div>
          )}

          {isProvider && <p className="dl-footnote">{t("deeplink.warning")}</p>}
        </div>

        {isPreparing && (
          <p role="status" className="dl-status">
            {t("common.loading", { defaultValue: "正在读取配置…" })}
          </p>
        )}
        {(blockingError !== null || missing.length > 0) && (
          <p role="alert" className="dl-alert">
            {blockingError !== null
              ? `无法导入：${blockingError || "链接内容无法识别。"}`
              : `链接没有提供${missing.join("和")}，无法导入。`}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={isImporting}
          >
            {imported
              ? t("common.close", { defaultValue: "关闭" })
              : t("common.cancel")}
          </Button>
          <Button
            onClick={handleImport}
            disabled={isImporting || (blocked && !imported)}
          >
            {isImporting
              ? t("deeplink.importing")
              : imported
                ? t("common.done", { defaultValue: "完成" })
                : t("deeplink.import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
