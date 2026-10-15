import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeftRight, Check, Info } from "lucide-react";
import {
  type DeepLinkImportPreview,
  type DeepLinkImportRequest,
  deeplinkApi,
} from "@/lib/api/deeplink";
import { settingsApi } from "@/lib/api/settings";
import type { VisibleApps } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { LineBadge } from "./LineBadge";
import { CodeBlock } from "./deeplink/CodeBlock";
import { McpConfirmation } from "./deeplink/McpConfirmation";
import { PromptConfirmation } from "./deeplink/PromptConfirmation";
import { SkillConfirmation } from "./deeplink/SkillConfirmation";
import { isAdditiveTool, toolName } from "./deeplink/tools";
import {
  classifyEndpoint,
  isSensitiveKey,
  maskScriptSecrets,
  maskSecret,
  maskStoredValue,
  maskValue,
  riskI18nKey,
} from "@/utils/deeplinkRisk";
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

const VISIBLE_APP_KEYS: ReadonlyArray<keyof VisibleApps> = [
  "claude",
  "claude-desktop",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "pi",
];

function visibleAppKey(app?: string): keyof VisibleApps | null {
  const id = app === "claude_desktop" ? "claude-desktop" : app;
  return VISIBLE_APP_KEYS.find((key) => key === id) ?? null;
}

/** "链接没有提供 API Key 和请求地址，无法导入。": a space only next to Latin. */
function missingMessage(items: string[]): string {
  const startsLatin = (text: string) => /^[A-Za-z]/.test(text);
  const joined = items.reduce(
    (text, item, index) =>
      index === 0
        ? item
        : `${text}${/[A-Za-z]$/.test(text) ? " " : ""}和${startsLatin(item) ? " " : ""}${item}`,
    "",
  );
  return `链接没有提供${startsLatin(joined) ? " " : ""}${joined}，无法导入。`;
}

const lineCount = (text: string) =>
  text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;

/**
 * The preview content as the user should review it: what will be stored,
 * with credentials masked in place. Env keys the backend refuses, and keys
 * that need confirmation but are not ticked, are left out exactly as the
 * import leaves them out (`deeplink/env_allowlist.rs`); every app keeps them
 * under `env` in the preview (`deeplink/preview.rs`). Content that is not
 * JSON is returned as is.
 */
function contentForReview(
  content: string,
  excludedEnvKeys: ReadonlySet<string>,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const env = (parsed as Record<string, unknown>).env;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      for (const key of excludedEnvKeys) {
        delete (env as Record<string, unknown>)[key];
      }
    }
  }
  return JSON.stringify(maskStoredValue(parsed), null, 2);
}

/**
 * A host or model id with a break opportunity after each separator, so a
 * long value wraps at `.`, `/`, `-` or `_` instead of mid-word. Copy is
 * unaffected: <wbr> adds no characters.
 */
function breakable(value: string) {
  const parts = value.match(/[^./_:-]*[./_:-]?/g)?.filter(Boolean) ?? [value];
  return parts.flatMap((part, index) =>
    index === 0 ? [part] : [<wbr key={index} />, part],
  );
}

/**
 * The stored content as blocks. A config.toml the backend keeps as one JSON
 * string (Codex, Grok Build) gets its own block, so it reads as TOML instead
 * of one long line of `\n` escapes; the remaining fields stay JSON.
 */
function storedParts(
  content: string,
): Array<{ key: string; caption: string; text: string }> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { config, ...rest } = parsed as Record<string, unknown>;
      if (typeof config === "string" && config.includes("\n")) {
        const parts = [{ key: "toml", caption: "config · TOML", text: config }];
        if (Object.keys(rest).length > 0) {
          parts.push({
            key: "json",
            caption: "其余字段 · JSON",
            text: JSON.stringify(rest, null, 2),
          });
        }
        return parts;
      }
    }
    return [{ key: "json", caption: "JSON", text: content }];
  } catch {
    return [{ key: "text", caption: "文本", text: content }];
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
  const cancelRef = useRef<HTMLButtonElement>(null);
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
  const [showAllIgnored, setShowAllIgnored] = useState(false);
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
  const tool = toolName(request.app);
  const additive = isAdditiveTool(request.app);
  // Where the tool's lines are listed: Codex on 线路, the others on their page.
  const linePage = request.app === "codex" ? "线路" : tool;
  const claudeFamily =
    request.app === "claude" ||
    request.app === "claude-desktop" ||
    request.app === "claude_desktop";
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
  const confirmEnv = (preview?.env ?? []).filter(
    (entry) => entry.status === "needsConfirmation",
  );
  const deniedEnv = (preview?.env ?? []).filter(
    (entry) => entry.status === "denied",
  );
  const allowedEnvKeys = (preview?.env ?? [])
    .filter((entry) => entry.status === "allowed")
    .map((entry) => entry.key);

  // The tool's lines are listed only once the tool is in the sidebar; say
  // where to find the imported line when it is not.
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
    enabled: isProvider,
    staleTime: 30_000,
  });
  const appKey = visibleAppKey(request.app);
  const toolHidden =
    isProvider &&
    appKey !== null &&
    appKey !== "codex" &&
    settingsQuery.data?.visibleApps?.[appKey] === false;

  // Import would fail on these anyway; say so before the user confirms. A
  // link with a config fills them in while merging, so wait for that.
  const missing =
    isProvider && !isPreparing
      ? [
          !request.apiKey?.trim() ? "API Key" : null,
          !primaryEndpoint ? "请求地址" : null,
        ].filter((item): item is string => item !== null)
      : [];
  const blockingError = previewError ?? mergeError;
  const blocked =
    isPreparing || blockingError !== null || !preview || missing.length > 0;
  // What confirming would do is only described for a link that can be
  // imported; a refused one shows why instead.
  const reviewable = blockingError === null && missing.length === 0;
  const loadState: "loading" | "ready" | "failed" =
    blockingError !== null ? "failed" : preview ? "ready" : "loading";

  // A usage script is opaque code, so its credentials can only be masked by
  // value: the link's own key and token, and its credential env values.
  const scriptSecrets = useMemo(
    () => [
      request.apiKey,
      request.usageApiKey,
      request.usageAccessToken,
      ...Object.entries(envValues)
        .filter(([key]) => isSensitiveKey(key))
        .map(([, value]) => value),
    ],
    [request.apiKey, request.usageApiKey, request.usageAccessToken, envValues],
  );
  // The full-content view shows what will be stored, so env keys the backend
  // refuses, and keys that need confirmation but are not ticked, are left
  // out of it, exactly as the import does (`deeplink/env_allowlist.rs`).
  const excludedEnvKeys = useMemo(
    () =>
      new Set(
        (preview?.env ?? [])
          .filter(
            (entry) =>
              entry.status === "denied" ||
              (entry.status === "needsConfirmation" &&
                !confirmedEnvKeys.includes(entry.key)),
          )
          .map((entry) => entry.key),
      ),
    [preview, confirmedEnvKeys],
  );
  // Credentials show their last 4 only, like the API Key line above it.
  const contentParts = useMemo(
    () =>
      preview
        ? storedParts(contentForReview(preview.content, excludedEnvKeys))
        : [],
    [preview, excludedEnvKeys],
  );
  const usageCode = useMemo(
    () => (usage ? maskScriptSecrets(usage.code, scriptSecrets) : ""),
    [usage, scriptSecrets],
  );

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
      const providerToast = () =>
        toast.success(t("deeplink.importSuccess"), {
          description: activateNow
            ? t("deeplink.importSuccessActivated", {
                name: request.name,
                defaultValue: "已切换到线路“{{name}}”。",
              })
            : t("deeplink.importSuccessDescription", {
                name: request.name,
                page: linePage,
              }),
          closeButton: true,
        });
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

        if (summary.failed.length > 0 && summary.importedCount === 0) {
          // The backend checks every server first and imports none of them
          // when one is invalid.
          toast.error(
            t("deeplink.mcpImportNone", { defaultValue: "MCP 服务器未导入" }),
            {
              description: t("deeplink.mcpImportNoneDescription", {
                ids: summary.failed.map((item) => item.id).join("、"),
                defaultValue:
                  "{{ids}} 的配置无效。为避免只导入一部分，这次没有导入任何服务器。",
              }),
            },
          );
        } else if (summary.failed.length > 0) {
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
          providerToast();
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
        providerToast();
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

  const title =
    request.resource === "prompt"
      ? t("deeplink.importPrompt")
      : request.resource === "mcp"
        ? t("deeplink.importMcp")
        : request.resource === "skill"
          ? t("deeplink.importSkill")
          : "确认导入线路";

  const activateId = `${ids}-activate`;
  const usageId = `${ids}-usage`;
  const writtenFiles = preview?.targetPaths ?? [];
  const usageLines = usage ? lineCount(usage.code) : 0;
  const spareEndpoints = endpoints.slice(1);
  const shownIgnored = showAllIgnored
    ? ignored
    : ignored.slice(0, IGNORED_SHOWN);
  const showContent =
    preview !== null &&
    reviewable &&
    (isProvider || request.resource === "mcp");
  const switchVerb = additive ? "启用" : "切换";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void handleCancel();
      }}
    >
      <DialogContent
        className="dl-dialog"
        overlayClassName="bg-[var(--scrim)] backdrop-blur-none"
        zIndex="top"
        // A risky import starts on the safe action: Enter cancels until the
        // user moves to 导入 on purpose.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        onKeyDown={(event) => {
          // A held Enter (from the field the link was pasted into) must not
          // reach a button of this dialog.
          if (event.key === "Enter" && event.repeat) event.preventDefault();
        }}
      >
        <header className="dl-header">
          <DialogTitle className="dl-title">{title}</DialogTitle>
          <DialogDescription className="dl-description">
            {t("deeplink.confirmImportDescription", {
              defaultValue:
                "来自导入链接。确认前，Chimera++ 不会保存或改动任何内容。",
            })}
          </DialogDescription>
        </header>

        <div className="dl-body">
          {request.resource === "prompt" && (
            <PromptConfirmation
              request={request}
              state={loadState}
              content={preview?.content ?? ""}
              targetPath={preview?.targetPaths[0]}
            />
          )}
          {request.resource === "mcp" && (
            <McpConfirmation
              request={request}
              state={loadState}
              content={preview?.content ?? ""}
              deniedEnvKeys={deniedEnvKeys}
            />
          )}
          {request.resource === "skill" && (
            <SkillConfirmation request={request} state={loadState} />
          )}

          {isProvider && (
            <>
              {/* The line, previewed as its signboard: tool -> address -> model. */}
              <section className="dl-plate" aria-labelledby={`${ids}-name`}>
                <span className="dl-plate-band" aria-hidden="true" />
                <div className="dl-plate-body">
                  <div className="dl-plate-top">
                    <LineBadge line={{ name: request.name ?? "" }} size="lg" />
                    <div className="dl-plate-title">
                      <span className="dl-plate-eyebrow">新线路</span>
                      <strong id={`${ids}-name`} className="dl-plate-name">
                        {request.name || "未命名线路"}
                      </strong>
                    </div>
                  </div>
                  <ol className="dl-route" aria-label="请求路径">
                    <li className="dl-stop">
                      <span className="dl-track" aria-hidden="true">
                        <span className="dl-dot" />
                        <span className="dl-rail" />
                      </span>
                      <span className="dl-stop-name">{tool}</span>
                      <span className="dl-stop-note">工具</span>
                    </li>
                    <li
                      className="dl-stop is-host"
                      data-tone={primaryRisk ? "warn" : undefined}
                      data-last={request.model ? undefined : true}
                    >
                      <span className="dl-track" aria-hidden="true">
                        <span className="dl-dot" />
                        <span className="dl-rail" />
                      </span>
                      {primaryHost ? (
                        <span className="dl-stop-name dl-mono">
                          {breakable(primaryHost)}
                        </span>
                      ) : (
                        <span className="dl-stop-name">
                          {isPreparing
                            ? "正在读取…"
                            : blockingError !== null
                              ? "无法读取"
                              : "未提供"}
                        </span>
                      )}
                      <span className="dl-stop-note">
                        {primaryRisk ? "本机或局域网地址" : "请求将发往"}
                      </span>
                    </li>
                    {request.model && (
                      <li className="dl-stop" data-last>
                        <span className="dl-track" aria-hidden="true">
                          <span className="dl-dot" />
                        </span>
                        <span className="dl-stop-name dl-mono">
                          {breakable(request.model)}
                        </span>
                        <span className="dl-stop-note">
                          {claudeFamily ? "主模型" : "默认模型"}
                        </span>
                      </li>
                    )}
                  </ol>
                  {primaryEndpoint && (
                    <dl className="dl-plate-urls">
                      <dt>完整地址</dt>
                      <dd className="dl-mono">
                        {safeDisplayUrl(primaryEndpoint)}
                      </dd>
                      {spareEndpoints.length > 0 && (
                        <>
                          <dt>备用地址</dt>
                          <dd>
                            <ul className="dl-plate-list">
                              {spareEndpoints.map((endpoint, index) => (
                                <li key={index} className="dl-mono">
                                  {safeDisplayUrl(endpoint)}
                                </li>
                              ))}
                            </ul>
                          </dd>
                        </>
                      )}
                    </dl>
                  )}
                </div>
              </section>

              {primaryRisk && (
                <p className="dl-callout" data-tone="warning">
                  <AlertTriangle size={15} aria-hidden="true" />
                  <span>{t(riskI18nKey(primaryRisk))}</span>
                </p>
              )}

              {/* Details */}
              <dl className="dl-facts">
                <dt>API Key</dt>
                <dd>
                  {!apiKey ? (
                    <span className="dl-muted">
                      {isPreparing ? "正在读取…" : "未提供"}
                    </span>
                  ) : apiKey.length > 8 ? (
                    <>
                      已提供，末 4 位{" "}
                      <code className="dl-mono dl-key-tail">
                        {apiKey.slice(-4)}
                      </code>
                    </>
                  ) : (
                    "已提供"
                  )}
                </dd>
                {claudeFamily && request.haikuModel && (
                  <>
                    <dt>Haiku 模型</dt>
                    <dd className="dl-mono">{request.haikuModel}</dd>
                  </>
                )}
                {claudeFamily && request.sonnetModel && (
                  <>
                    <dt>Sonnet 模型</dt>
                    <dd className="dl-mono">{request.sonnetModel}</dd>
                  </>
                )}
                {claudeFamily && request.opusModel && (
                  <>
                    <dt>Opus 模型</dt>
                    <dd className="dl-mono">{request.opusModel}</dd>
                  </>
                )}
                {request.homepage && (
                  <>
                    <dt>主页</dt>
                    <dd className="dl-mono">
                      {safeDisplayUrl(request.homepage)}
                    </dd>
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
              {reviewable && (
                <section
                  className="dl-section"
                  aria-labelledby={`${ids}-outcome-title`}
                >
                  <h3 id={`${ids}-outcome-title`} className="dl-section-title">
                    确认后
                  </h3>
                  <div className="dl-card">
                    {mayActivate && (
                      <div className="dl-toggle">
                        <div className="dl-toggle-text">
                          <label htmlFor={activateId}>
                            导入后立即切换到这条线路
                          </label>
                          <p id={`${activateId}-note`} className="dl-note">
                            {activateNow
                              ? `确认后立即切换，${tool} 之后的请求会发往 ${primaryHost ?? "上面的地址"}。`
                              : request.enabled
                                ? "链接请求导入后立即切换；是否切换由你决定。"
                                : "关闭时只保存，不切换。"}
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
                    <ul className="dl-outcome">
                      <li>
                        <Check size={14} aria-hidden="true" />
                        <span>
                          保存为 {tool} 的一条线路，之后可以随时编辑或删除。
                        </span>
                      </li>
                      {activateNow ? (
                        <li data-tone="active">
                          <ArrowLeftRight size={14} aria-hidden="true" />
                          <span>立即切换到这条线路，并写入下列文件。</span>
                        </li>
                      ) : (
                        <li>
                          <Check size={14} aria-hidden="true" />
                          <span>
                            {additive
                              ? `不会启用这条线路，${tool} 的配置文件保持不变。`
                              : `不会切换当前线路，${tool} 的配置文件保持不变。`}
                          </span>
                        </li>
                      )}
                    </ul>
                    {request.enabled && !mayActivate && (
                      <p className="dl-card-note">
                        链接请求导入后立即{switchVerb}；从链接导入的 {tool}{" "}
                        线路只会保存，需要时在「{linePage}」页面手动{switchVerb}
                        。
                      </p>
                    )}
                    {writtenFiles.length > 0 && (
                      <div className="dl-files">
                        <span className="dl-note">
                          {activateNow
                            ? "确认后立即写入："
                            : `${switchVerb === "启用" ? "启用" : "切换到"}这条线路时才会写入：`}
                        </span>
                        <ul className="dl-paths">
                          {writtenFiles.map((path) => (
                            <li key={path} className="dl-mono">
                              {path}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  {toolHidden && (
                    <p className="dl-callout" data-tone="info">
                      <Info size={15} aria-hidden="true" />
                      <span>
                        {tool} 目前没有显示在侧栏。导入后，在「管理工具」中打开{" "}
                        {tool}，就能看到这条线路。
                      </span>
                    </p>
                  )}
                </section>
              )}

              {/* Usage query script */}
              {reviewable && usage && (
                <section
                  className="dl-section"
                  aria-labelledby={`${ids}-usage-title`}
                >
                  <h3 id={`${ids}-usage-title`} className="dl-section-title">
                    用量查询脚本
                  </h3>
                  <div className="dl-card">
                    <div className="dl-card-body">
                      <p className="dl-note">
                        链接附带一段查询余额和用量的脚本。启用后，Chimera++
                        会在本机定期运行它；脚本只能访问下面的地址，并可能使用这条线路的
                        API Key。
                      </p>
                      <dl className="dl-facts is-compact">
                        <dt>会访问</dt>
                        <dd>
                          {usage.hosts.length > 0 ? (
                            usage.hosts.map((host, index) => (
                              <Fragment key={host}>
                                {index > 0 && "、"}
                                <span className="dl-mono dl-strong">
                                  {host}
                                </span>
                              </Fragment>
                            ))
                          ) : (
                            <span className="dl-muted">无法确定</span>
                          )}
                        </dd>
                        {usage.autoIntervalMinutes ? (
                          <>
                            <dt>自动查询</dt>
                            <dd>每 {usage.autoIntervalMinutes} 分钟</dd>
                          </>
                        ) : null}
                        {/* Stored with the line (meta.usage_script), not in
                            the configuration below. */}
                        {request.usageApiKey?.trim() ? (
                          <>
                            <dt>查询用 Key</dt>
                            <dd className="dl-mono">
                              {maskSecret(request.usageApiKey)}
                            </dd>
                          </>
                        ) : null}
                        {request.usageAccessToken?.trim() ? (
                          <>
                            <dt>访问令牌</dt>
                            <dd className="dl-mono">
                              {maskSecret(request.usageAccessToken)}
                            </dd>
                          </>
                        ) : null}
                        {request.usageUserId?.trim() ? (
                          <>
                            <dt>用户 ID</dt>
                            <dd className="dl-mono">{request.usageUserId}</dd>
                          </>
                        ) : null}
                      </dl>
                      <CodeBlock
                        code={usageCode}
                        caption={`JavaScript · ${usageLines} 行`}
                        meta="启用后在本机运行"
                        label="用量查询脚本代码"
                      />
                    </div>
                    <div className="dl-toggle is-footer">
                      <div className="dl-toggle-text">
                        <label htmlFor={usageId}>导入后启用用量查询</label>
                        <p id={`${usageId}-note`} className="dl-note">
                          {usageEnabled
                            ? "确认后会按上面的设置定期运行这段脚本。"
                            : usage.linkRequestsEnabled
                              ? "链接请求启用；是否启用由你决定。关闭时只保存脚本，不会运行。"
                              : "关闭时只保存脚本，不会运行。"}
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
                  </div>
                </section>
              )}

              {/* Environment variables the line would export */}
              {reviewable &&
                (confirmEnv.length > 0 || deniedEnv.length > 0) && (
                  <section
                    className="dl-section"
                    aria-labelledby={`${ids}-env-title`}
                  >
                    <h3 id={`${ids}-env-title`} className="dl-section-title">
                      环境变量
                    </h3>
                    {confirmEnv.length > 0 && (
                      <div className="dl-env-group">
                        <p id={`${ids}-env-confirm`} className="dl-note">
                          {t("deeplink.envConfirm", {
                            tool,
                            defaultValue:
                              "下面的变量不在 {{tool}} 的常用变量清单里，勾选的才会导入。",
                          })}
                        </p>
                        <ul className="dl-env">
                          {confirmEnv.map(({ key }) => (
                            <li key={key} className="dl-env-row">
                              <label className="dl-env-check">
                                <input
                                  type="checkbox"
                                  checked={confirmedEnvKeys.includes(key)}
                                  onChange={(event) =>
                                    toggleEnvKey(key, event.target.checked)
                                  }
                                  aria-describedby={`${ids}-env-confirm`}
                                  disabled={isImporting || imported}
                                />
                                <span className="dl-mono">
                                  {key}
                                  {envValues[key] !== undefined && (
                                    <span className="dl-env-value">
                                      {" = "}
                                      {maskValue(key, envValues[key])}
                                    </span>
                                  )}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {deniedEnv.length > 0 && (
                      <div className="dl-env-group">
                        <p className="dl-note">
                          {t("deeplink.envDenied", {
                            defaultValue:
                              "下面的变量会改变网络代理、证书或程序的加载方式，出于安全原因不会导入。",
                          })}
                        </p>
                        <ul className="dl-env">
                          {deniedEnv.map(({ key }) => (
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
                              <span className="dl-tag">不会导入</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {allowedEnvKeys.length > 0 && (
                      <p className="dl-note">
                        常用变量照常导入：
                        {allowedEnvKeys.map((key, index) => (
                          <Fragment key={key}>
                            {index > 0 && "、"}
                            <span className="dl-mono">{key}</span>
                          </Fragment>
                        ))}
                      </p>
                    )}
                  </section>
                )}

              {/* Settings the import leaves out */}
              {reviewable && ignored.length > 0 && (
                <section
                  className="dl-section"
                  aria-labelledby={`${ids}-ignored-title`}
                >
                  <h3 id={`${ids}-ignored-title`} className="dl-section-title">
                    不会导入的设置
                  </h3>
                  <p className="dl-note">
                    链接里的这些设置不属于线路配置，导入时会忽略：
                  </p>
                  <ul className="dl-chips" id={`${ids}-ignored-list`}>
                    {shownIgnored.map((name, index) => (
                      <li key={`${name}-${index}`}>{name}</li>
                    ))}
                    {ignored.length > IGNORED_SHOWN && (
                      <li className="dl-chips-more">
                        <button
                          type="button"
                          aria-expanded={showAllIgnored}
                          aria-controls={`${ids}-ignored-list`}
                          onClick={() => setShowAllIgnored((value) => !value)}
                        >
                          {showAllIgnored
                            ? "收起"
                            : `等 ${ignored.length} 项，全部显示`}
                        </button>
                      </li>
                    )}
                  </ul>
                </section>
              )}
            </>
          )}

          {/* MH-4: the configuration that will be stored (credentials show their
              last 4). The usage query key and token are listed above. */}
          {showContent && (
            <details className="chimera-disclosure is-inline dl-content">
              <summary>
                {isProvider
                  ? "查看将保存的配置"
                  : t("deeplink.fullContent", { defaultValue: "查看完整配置" })}
                <span className="dl-summary-hint">
                  {isProvider ? "API Key 只显示末 4 位" : "凭据只显示末 4 位"}
                </span>
              </summary>
              <div className="chimera-disclosure-body">
                {contentParts.map((part) => (
                  <CodeBlock
                    key={part.key}
                    code={part.text}
                    caption={part.caption}
                    meta={`${lineCount(part.text)} 行`}
                    label={`将保存的内容：${part.caption}`}
                    wrap
                  />
                ))}
              </div>
            </details>
          )}
        </div>

        <div className="dl-bottom">
          {(isPreparing || (!preview && blockingError === null)) && (
            <p role="status" className="dl-status">
              {isPreparing ? "正在读取链接里的配置…" : "正在生成预览…"}
            </p>
          )}
          {(blockingError !== null || missing.length > 0) && (
            <p role="alert" className="dl-alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>
                {blockingError !== null
                  ? `无法导入：${blockingError || "链接内容无法识别。"}`
                  : missingMessage(missing)}
              </span>
            </p>
          )}
          <footer className="dl-footer">
            <p className="dl-trust">{t("deeplink.warning")}</p>
            <Button
              ref={cancelRef}
              variant="outline"
              className="dl-cancel"
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
                  : activateNow
                    ? "导入并切换"
                    : t("deeplink.import")}
            </Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
