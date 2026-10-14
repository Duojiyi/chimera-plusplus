import type { Provider } from "@/types";
import {
  extractCodexBaseUrl,
  extractCodexWireApi,
  isCodexAnthropicWireApi,
  isCodexChatWireApi,
} from "@/utils/providerConfigUtils";

/**
 * Why a saved Codex line is sent through Chimera++'s local router instead of
 * letting Codex call the upstream directly.
 *
 * This mirrors the backend's `provider_requires_automatic_routing`
 * (src-tauri/src/commands/provider.rs). Both implementations assert the same
 * cases in tests/fixtures/codex-routing-vectors.json, so a change on one side
 * fails the other side's tests until both agree.
 */
export type CodexRoutingReason =
  | "chat"
  | "anthropic"
  | "model-routing"
  | "full-url"
  | "user-agent"
  | "request-overrides"
  | "managed-auth"
  | "auto-detect";

export const codexRoutingReasonLabels: Record<CodexRoutingReason, string> = {
  chat: "转换为 Chat Completions",
  anthropic: "转换为 Anthropic Messages",
  "model-routing": "按模型分流",
  "full-url": "完整 API 地址",
  "user-agent": "自定义 User-Agent",
  "request-overrides": "自定义请求头",
  "managed-auth": "托管登录",
  "auto-detect": "自动识别协议",
};

export interface CodexRouting {
  routed: boolean;
  reasons: CodexRoutingReason[];
}

const MANAGED_PROVIDER_TYPES = new Set([
  "github_copilot",
  "codex_oauth",
  "xai_oauth",
]);

const NATIVE_RESPONSES_WIRE_APIS = new Set([
  "responses",
  "openai_responses",
  "openai-responses",
]);

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const nonEmpty = (value: unknown): boolean =>
  typeof value === "string" && value.trim() !== "";

const isChatCompletionsUrl = (value: string): boolean =>
  value.replace(/\/+$/, "").toLowerCase().endsWith("/chat/completions");

// meta.apiFormat wins, then the legacy settings-level fields, exactly as the
// backend's `codex_provider_uses_chat_completions` / `_uses_anthropic` read them.
function declaredFormat(provider: Provider): string | undefined {
  const settings = provider.settingsConfig ?? {};
  return (
    stringField(provider.meta?.apiFormat) ??
    stringField(settings.api_format) ??
    stringField(settings.apiFormat)
  );
}

function configWireApi(provider: Provider): string | undefined {
  const config = stringField(provider.settingsConfig?.config);
  return config === undefined ? undefined : extractCodexWireApi(config);
}

function usesChat(provider: Provider): boolean {
  const format = declaredFormat(provider);
  if (format !== undefined) return isCodexChatWireApi(format);
  const wireApi = configWireApi(provider);
  if (wireApi !== undefined) return isCodexChatWireApi(wireApi);
  const settings = provider.settingsConfig ?? {};
  const baseUrl =
    stringField(settings.base_url) ?? stringField(settings.baseURL);
  if (baseUrl !== undefined) return isChatCompletionsUrl(baseUrl);
  const config = stringField(settings.config);
  const configBaseUrl =
    config === undefined ? undefined : extractCodexBaseUrl(config);
  return configBaseUrl !== undefined && isChatCompletionsUrl(configBaseUrl);
}

function usesAnthropic(provider: Provider): boolean {
  const format = declaredFormat(provider);
  if (format !== undefined) return isCodexAnthropicWireApi(format);
  const wireApi = configWireApi(provider);
  return wireApi !== undefined && isCodexAnthropicWireApi(wireApi);
}

function hasModelLevelRouting(provider: Provider): boolean {
  const meta = provider.meta;
  const formats = Object.values(meta?.codexModelApiFormats ?? {});
  if (
    formats.some(
      (format) => isCodexChatWireApi(format) || isCodexAnthropicWireApi(format),
    )
  ) {
    return true;
  }
  // Only routes that change the upstream target need per-model forwarding.
  return Object.values(meta?.codexModelRoutes ?? {}).some(
    (route) =>
      route.enabled !== false &&
      (nonEmpty(route.baseUrl) || nonEmpty(route.apiKey)),
  );
}

function usesManagedAuth(provider: Provider): boolean {
  if (MANAGED_PROVIDER_TYPES.has(provider.meta?.providerType ?? "")) {
    return true;
  }
  const claudeBaseUrl = stringField(
    provider.settingsConfig?.env?.ANTHROPIC_BASE_URL,
  );
  return (
    claudeBaseUrl !== undefined &&
    (claudeBaseUrl.includes("githubcopilot.com") ||
      claudeBaseUrl.includes("chatgpt.com/backend-api/codex"))
  );
}

function hasRequestOverrides(provider: Provider): boolean {
  const overrides = provider.meta?.localProxyRequestOverrides;
  if (!overrides) return false;
  return (
    Object.keys(overrides.headers ?? {}).length > 0 ||
    (overrides.body !== undefined && overrides.body !== null)
  );
}

// An "auto" line without a persisted protocol is routed so the router can
// detect Responses versus Chat at request time, unless its config already
// declares native Responses.
function isAutoDetectCandidate(provider: Provider): boolean {
  if (provider.meta?.apiFormat != null) return false;
  const wireApi = configWireApi(provider);
  if (
    wireApi !== undefined &&
    NATIVE_RESPONSES_WIRE_APIS.has(wireApi.trim().toLowerCase())
  ) {
    return false;
  }
  return !usesChat(provider) && !usesAnthropic(provider);
}

/** Routing state of a saved Codex line, in display order of its reasons. */
export function codexProviderRouting(provider: Provider): CodexRouting {
  if (provider.category === "official") return { routed: false, reasons: [] };
  const reasons: CodexRoutingReason[] = [];
  if (usesChat(provider)) reasons.push("chat");
  if (usesAnthropic(provider)) reasons.push("anthropic");
  if (hasModelLevelRouting(provider)) reasons.push("model-routing");
  if (provider.meta?.isFullUrl === true) reasons.push("full-url");
  if (nonEmpty(provider.meta?.customUserAgent)) reasons.push("user-agent");
  if (hasRequestOverrides(provider)) reasons.push("request-overrides");
  if (usesManagedAuth(provider)) reasons.push("managed-auth");
  if (isAutoDetectCandidate(provider)) reasons.push("auto-detect");
  return { routed: reasons.length > 0, reasons };
}

/** "经本地路由（转换为 Chat Completions、完整 API 地址）" or "直连上游". */
export function describeCodexRouting(routing: CodexRouting): string {
  if (!routing.routed) return "直连上游";
  return `经本地路由（${routing.reasons
    .map((reason) => codexRoutingReasonLabels[reason])
    .join("、")}）`;
}
