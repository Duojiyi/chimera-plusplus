import type {
  CodexCatalogModel,
  CodexModelRoute,
  Provider,
  ProviderMeta,
} from "@/types";
import type {
  DetectedCodexApiFormat,
  FetchedModel,
} from "@/lib/api/model-fetch";
import {
  extractCodexBaseUrl,
  extractCodexExperimentalBearerToken,
  extractCodexModelName,
} from "@/utils/providerConfigUtils";

export type ConnectionState =
  | { kind: "unknown"; message: string }
  | { kind: "checking"; message: string }
  | { kind: "connected"; message: string; modelCount: number }
  | { kind: "error"; message: string };

export interface OperationRecord {
  id: string;
  timestamp: number;
  provider: string;
  action: string;
  result: "success" | "error" | "skipped";
  durationMs?: number;
  detail?: string;
}

export interface CurrentProviderResolution {
  provider: Provider | null;
  source: "live" | "stored" | "external" | "none";
}

const ACTIVITY_KEY_PREFIX = "chimera-plus-plus:activity:v3";
const MAX_ACTIVITY_RECORDS = 200;

/**
 * Keep WebView activity records scoped to the backend's app-data directory.
 * This prevents portable and isolated test profiles from sharing one browser
 * localStorage history merely because they are opened by the same WebView.
 */
export function activityStorageKey(appConfigPath: string): string {
  let hash = 2166136261;
  const normalized = appConfigPath.trim().replace(/\\/g, "/").toLowerCase();
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${ACTIVITY_KEY_PREFIX}:${(hash >>> 0).toString(36)}`;
}

function normalizeEndpoint(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "").toLocaleLowerCase("en-US");
}

function liveConfigText(live: unknown): string {
  if (!live || typeof live !== "object") return "";
  const config = (live as Record<string, unknown>).config;
  return typeof config === "string" ? config : "";
}

function liveAuthObject(live: unknown): Record<string, unknown> {
  if (!live || typeof live !== "object") return {};
  const auth = (live as Record<string, unknown>).auth;
  return auth && typeof auth === "object"
    ? (auth as Record<string, unknown>)
    : {};
}

function authCredential(auth: Record<string, unknown>): string {
  for (const field of [
    "OPENAI_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "api_key",
  ] as const) {
    const value = auth[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function storedCredential(settings: unknown): string {
  if (!settings || typeof settings !== "object") return "";
  const record = settings as Record<string, unknown>;
  const configToken = extractCodexExperimentalBearerToken(
    typeof record.config === "string" ? record.config : "",
  );
  if (configToken) return configToken;
  const auth =
    record.auth && typeof record.auth === "object"
      ? (record.auth as Record<string, unknown>)
      : {};
  return authCredential(auth);
}

function liveCredential(settings: unknown): string {
  const config = liveConfigText(settings);
  return (
    extractCodexExperimentalBearerToken(config) ||
    authCredential(liveAuthObject(settings))
  );
}

export function resolveCurrentProvider(
  providers: Provider[],
  storedId: string,
  live: unknown,
  liveReadSucceeded: boolean,
): CurrentProviderResolution {
  if (!providers.length) return { provider: null, source: "none" };

  const stored = providers.find((provider) => provider.id === storedId) ?? null;
  if (!liveReadSucceeded) {
    return stored
      ? { provider: stored, source: "stored" }
      : { provider: null, source: "external" };
  }

  const config = liveConfigText(live);
  const liveEndpoint = normalizeEndpoint(extractCodexBaseUrl(config));
  const liveModel = extractCodexModelName(config) ?? "";

  // When Chimera has taken proxy takeover, the live endpoint is 127.0.0.1:PORT.
  // No saved provider will ever match that address, so fall back to the stored
  // selection rather than returning { provider: null, source: "external" }.
  // The endpoint may carry a protocol prefix (e.g. "http://127.0.0.1:12345")
  // so we check both the bare-host and URL forms.
  const isLocalProxy =
    liveEndpoint.startsWith("127.0.0.1") ||
    liveEndpoint.startsWith("localhost") ||
    liveEndpoint.includes("://127.0.0.1") ||
    liveEndpoint.includes("://localhost");
  if (isLocalProxy && stored) {
    return { provider: stored, source: "stored" };
  }

  const liveKey = liveCredential(live);
  const exact = providers.find((provider) => {
    const candidate = String(provider.settingsConfig?.config ?? "");
    const endpoint = normalizeEndpoint(extractCodexBaseUrl(candidate));
    const model = extractCodexModelName(candidate) ?? "";
    if (endpoint !== liveEndpoint) return false;
    if (liveModel && model && liveModel !== model) return false;
    return !liveKey || storedCredential(provider.settingsConfig) === liveKey;
  });
  if (exact) return { provider: exact, source: "live" };

  if (!liveEndpoint && stored) {
    const storedEndpoint = normalizeEndpoint(
      extractCodexBaseUrl(String(stored.settingsConfig?.config ?? "")),
    );
    if (!storedEndpoint) return { provider: stored, source: "stored" };
  }

  return { provider: null, source: "external" };
}

function isOperationRecord(value: unknown): value is OperationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<OperationRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.timestamp === "number" &&
    typeof record.provider === "string" &&
    typeof record.action === "string" &&
    (record.result === "success" ||
      record.result === "error" ||
      record.result === "skipped")
  );
}

export function loadOperationRecords(
  storage: Pick<Storage, "getItem"> = window.localStorage,
  key = ACTIVITY_KEY_PREFIX,
): OperationRecord[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(isOperationRecord).slice(0, MAX_ACTIVITY_RECORDS)
      : [];
  } catch {
    return [];
  }
}

export function saveOperationRecords(
  records: OperationRecord[],
  storage: Pick<Storage, "setItem"> = window.localStorage,
  key = ACTIVITY_KEY_PREFIX,
): OperationRecord[] {
  const normalized = records
    .filter(isOperationRecord)
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, MAX_ACTIVITY_RECORDS);
  storage.setItem(key, JSON.stringify(normalized));
  return normalized;
}

export function formatDuration(durationMs?: number): string {
  if (durationMs == null || durationMs < 0) return "-";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function formatVersion(value: string | null | undefined): string {
  return value?.trim() || "未检测到";
}

/** Keeps Codex credentials in the auth.json field used by the runtime adapter. */
export function setCodexProviderApiKey(
  existing: Record<string, unknown>,
  apiKey: string,
): Record<string, unknown> {
  const auth = { ...existing };
  delete auth.ANTHROPIC_AUTH_TOKEN;
  delete auth.ANTHROPIC_API_KEY;
  auth.OPENAI_API_KEY = apiKey.trim();
  return auth;
}

/** Build the catalog row's `input_modalities` list from the image-input toggle.
 * Text-only is the safe default: an unknown custom model must never be declared
 * image-capable without an explicit user choice, or the upstream rejects images
 * with a confusing client-side error. */
export function catalogInputModalities(supportsImage: boolean): string[] {
  return supportsImage ? ["text", "image"] : ["text"];
}

/** Whether a catalog model row explicitly declares image-input support. */
export function catalogRowSupportsImage(model: CodexCatalogModel): boolean {
  return (model.inputModalities ?? []).some(
    (modality) => String(modality).trim().toLowerCase() === "image",
  );
}

/** Models whose upstream protocol is probed before a save: the default model
 * plus every user-entered mapping row, in that order, trimmed and de-duplicated.
 * Fetched catalog entries are deliberately excluded — they follow the provider
 * protocol and the router's lazy probe, so an aggregator's embedding or image
 * models can never block saving a line. */
export function codexProbeModels(
  defaultModel: string,
  mappedModels: CodexCatalogModel[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of [
    defaultModel,
    ...mappedModels.map((entry) => entry.model),
  ]) {
    const model = candidate.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }
  return result;
}

const NON_CHAT_MODEL_PATTERN =
  /(?<![a-z])(?:embedding|embed|rerank|tts|whisper|image|vision-only|bge|flux|wan|moderation)(?![a-z])/i;

/** Whether a model id looks like a non-chat model (embeddings, rerankers,
 * speech, image/video generation, moderation). Used only to pick a sensible
 * default from a fetched list, never to hide models from the catalog. */
export function isLikelyNonChatModel(modelId: string): boolean {
  return NON_CHAT_MODEL_PATTERN.test(modelId.trim());
}

/** First fetched model that can plausibly serve as the default chat model. */
export function pickDefaultFetchedModel(
  models: FetchedModel[],
): string | undefined {
  for (const entry of models) {
    const id = entry.id?.trim();
    if (id && !isLikelyNonChatModel(id)) return id;
  }
  return undefined;
}

/** Detection results persisted on a provider, restored as the same shape the
 * probe returns so a re-opened editor can reuse them without re-probing. */
export function persistedCodexModelApiFormats(
  meta: ProviderMeta | undefined | null,
): Record<string, DetectedCodexApiFormat> {
  const stored = meta?.codexModelApiFormats;
  if (!stored || typeof stored !== "object") return {};
  const anthropicAuthField =
    meta?.apiKeyField === "ANTHROPIC_API_KEY"
      ? "ANTHROPIC_API_KEY"
      : "ANTHROPIC_AUTH_TOKEN";
  const result: Record<string, DetectedCodexApiFormat> = {};
  for (const [rawModel, format] of Object.entries(stored)) {
    const model = rawModel.trim();
    if (!model) continue;
    if (format === "anthropic") {
      result[model] = { apiFormat: format, anthropicAuthField };
    } else if (format === "openai_chat" || format === "openai_responses") {
      result[model] = { apiFormat: format };
    }
  }
  return result;
}

export interface CodexDetectionFailureDescription {
  /** `HTTP 400 (generic_validation)` — status and classification only. */
  status: string;
  /** Upstream excerpt after the status, possibly empty. */
  excerpt: string;
}

const DETECTION_FAILURE_PATTERN = /^(HTTP\s+\d{3}(?:\s*\([^)]*\))?)\s*(.*)$/s;

/** Split a backend failure reason (`HTTP 400 (generic_validation) <excerpt>`)
 * into the part worth showing prominently and the raw upstream excerpt. */
export function describeCodexDetectionFailure(
  reason: string | undefined | null,
): CodexDetectionFailureDescription {
  const text = (reason ?? "").trim();
  if (!text) return { status: "未返回原因", excerpt: "" };
  const match = text.match(DETECTION_FAILURE_PATTERN);
  if (!match) return { status: text, excerpt: "" };
  return { status: match[1].trim(), excerpt: match[2].trim() };
}

function isCatalogRow(value: unknown): value is CodexCatalogModel {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as CodexCatalogModel).model === "string"
  );
}

/** A catalog row carries user intent (rename, context window, reasoning
 * levels, instructions, image input) rather than being a plain mirror of a
 * fetched `/models` entry. */
export function isCustomizedCatalogRow(row: CodexCatalogModel): boolean {
  const model = row.model.trim();
  const displayName = row.displayName?.trim();
  if (displayName && displayName !== model) return true;
  if (row.contextWindow != null && String(row.contextWindow).trim() !== "")
    return true;
  if (row.reasoningLevels?.length) return true;
  if (row.defaultReasoningLevel) return true;
  if (row.baseInstructions?.trim()) return true;
  if (catalogRowSupportsImage(row)) return true;
  if (row.supportsParallelToolCalls !== undefined) return true;
  return false;
}

/** The user's mapping rows for the editor table. Stored separately from the
 * generated catalog under `settingsConfig.modelMappings`; providers saved
 * before that key existed fall back to the customized rows of their catalog so
 * the table never re-reads hundreds of fetched entries. */
export function extractCodexMappingRows(
  provider: Provider | null | undefined,
): CodexCatalogModel[] {
  const stored = provider?.settingsConfig?.modelMappings?.models;
  if (Array.isArray(stored)) {
    return stored.filter(isCatalogRow).map((row) => ({ ...row }));
  }
  const catalog = provider?.settingsConfig?.modelCatalog?.models;
  if (!Array.isArray(catalog)) return [];
  return catalog
    .filter(isCatalogRow)
    .filter(isCustomizedCatalogRow)
    .map((row) => ({ ...row }));
}

/** Catalog rows previously written for a provider, as fetched-model stand-ins,
 * so a save without a fresh `/models` fetch keeps the Codex catalog intact. */
export function previousCatalogAsFetched(
  provider: Provider | null | undefined,
): FetchedModel[] {
  const catalog = provider?.settingsConfig?.modelCatalog?.models;
  if (!Array.isArray(catalog)) return [];
  return catalog
    .filter(isCatalogRow)
    .map((row) => row.model.trim())
    .filter(Boolean)
    .map((id) => ({ id, ownedBy: null }));
}

/** Simple `approval_policy` values Codex 0.153+ accepts. Granular is a data
 * carrying variant and must use the table form; `untrusted` was removed and
 * makes Codex reject the whole config file. */
export const CODEX_APPROVAL_POLICIES = [
  "on-request",
  "on-failure",
  "never",
] as const;

const APPROVAL_POLICY_LINE =
  /^\s*approval_policy\s*=\s*(?:(?:"([^"]*)"|'([^']*)')|\{\s*granular\s*\}|\{\s*granular\s*=)/;

/** Every `approval_policy` value assigned anywhere in a TOML snippet. */
export function extractCodexApprovalPolicies(
  configText: string | undefined | null,
): string[] {
  const text = typeof configText === "string" ? configText : "";
  const values: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(APPROVAL_POLICY_LINE);
    if (!match) continue;
    if (match[1] !== undefined || match[2] !== undefined) {
      values.push((match[1] ?? match[2]).trim());
    } else if (!/\{\s*granular\s*=/.test(match[0])) {
      values.push("invalid-table");
    }
  }
  return values;
}

/** Short hint when a snippet sets an `approval_policy` Codex no longer loads. */
export function codexApprovalPolicyWarning(
  configText: string | undefined | null,
): string | null {
  const unsupported = extractCodexApprovalPolicies(configText).filter(
    (value) => !(CODEX_APPROVAL_POLICIES as readonly string[]).includes(value),
  );
  if (!unsupported.length) return null;
  const first = unsupported[0];
  if (first === "untrusted") {
    return 'approval_policy = "untrusted" 已被 Codex 停用，会导致整份配置无法加载；请改为 on-request，或使用表形态 granular = { ... }。';
  }
  return `approval_policy = "${first}" 不是 Codex 认识的值，可选：${CODEX_APPROVAL_POLICIES.join("、")}。`;
}

/** Probe-set models with no detected upstream protocol. Since v2.7.0 only the
 * default model and the user's mapping rows are probed; a miss here no longer
 * blocks saving — callers show the per-model failure and let the user pick a
 * protocol. Models whose enabled per-model route declares a protocol are exempt
 * (the request follows the route, mirroring the backend
 * `codex_model_protocol_mapping_is_missing` guard). */
export function findCodexCatalogModelsWithoutProtocol(
  catalogModels: CodexCatalogModel[],
  detectedFormats: Record<string, unknown>,
  modelRoutes?: Record<string, CodexModelRoute>,
): string[] {
  const undetected: string[] = [];
  for (const entry of catalogModels) {
    const model = entry.model.trim();
    if (!model || detectedFormats[model]) continue;
    const route = modelRoutes?.[model];
    if (route && route.enabled !== false && route.apiFormat) continue;
    undetected.push(model);
  }
  return Array.from(new Set(undetected));
}

/** Normalize per-model upstream routes for persistence: trim values, drop
 * rows without any meaningful override, and return undefined when nothing
 * remains so the meta key is omitted entirely. */
export function sanitizeCodexModelRoutesForSave(
  routes: Record<string, CodexModelRoute>,
): Record<string, CodexModelRoute> | undefined {
  const entries: Array<[string, CodexModelRoute]> = [];
  for (const [model, route] of Object.entries(routes)) {
    const trimmedModel = model.trim();
    if (!trimmedModel || !route) continue;
    const sanitized: CodexModelRoute = {};
    const baseUrl = route.baseUrl?.trim();
    if (baseUrl) sanitized.baseUrl = baseUrl;
    const apiKey = route.apiKey?.trim();
    if (apiKey) sanitized.apiKey = apiKey;
    if (route.apiFormat) sanitized.apiFormat = route.apiFormat;
    if (route.isFullUrl === true) sanitized.isFullUrl = true;
    if (route.enabled === false) sanitized.enabled = false;
    if (Object.keys(sanitized).length === 0) continue;
    entries.push([trimmedModel, sanitized]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Build a stable Codex catalog from fetched, manually mapped, and default models. */
export function buildCodexModelCatalog(
  defaultModel: string,
  mappedModels: CodexCatalogModel[],
  fetchedModels: FetchedModel[] = [],
): CodexCatalogModel[] {
  const bySlug = new Map<string, CodexCatalogModel>();
  const add = (entry: CodexCatalogModel, replace: boolean) => {
    const model = entry.model.trim();
    if (!model) return;
    const key = model.toLocaleLowerCase("en-US");
    if (!replace && bySlug.has(key)) return;
    bySlug.set(key, {
      ...entry,
      model,
      displayName: entry.displayName?.trim() || model,
    });
  };

  fetchedModels.forEach((entry) =>
    add({ model: entry.id, displayName: entry.id }, false),
  );
  mappedModels.forEach((entry) => add(entry, true));

  const normalizedDefault = defaultModel.trim();
  if (normalizedDefault) {
    add({ model: normalizedDefault, displayName: normalizedDefault }, false);
  }
  return Array.from(bySlug.values());
}
