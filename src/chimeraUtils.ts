import type { CodexCatalogModel, Provider } from "@/types";
import type { FetchedModel } from "@/lib/api/model-fetch";
import {
  extractCodexBaseUrl,
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

  const exact = providers.find((provider) => {
    const candidate = String(provider.settingsConfig?.config ?? "");
    const endpoint = normalizeEndpoint(extractCodexBaseUrl(candidate));
    const model = extractCodexModelName(candidate) ?? "";
    return (
      endpoint === liveEndpoint && (!liveModel || !model || model === liveModel)
    );
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

/** Catalog models with no detected upstream protocol after auto-detection.
 * The backend probe returns partial success; every model missing from the map
 * would fail closed at request time (400), so callers must surface these at
 * save time instead of persisting a half-detected catalog. */
export function findCodexCatalogModelsWithoutProtocol(
  catalogModels: CodexCatalogModel[],
  detectedFormats: Record<string, unknown>,
): string[] {
  const undetected: string[] = [];
  for (const entry of catalogModels) {
    const model = entry.model.trim();
    if (!model || detectedFormats[model]) continue;
    undetected.push(model);
  }
  return Array.from(new Set(undetected));
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
