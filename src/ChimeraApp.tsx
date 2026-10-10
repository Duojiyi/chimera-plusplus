import { RetainedToolPage } from "@/components/RetainedToolPage";
import { ToolVisibilityView } from "./views/ToolVisibilityView";
import { isProductToolVisible } from "@/lib/productCapabilities";
import { WindowControls } from "@/components/WindowControls";
import { isMac } from "@/lib/platform";
import {
  useLightweightClose,
  useLightweightCloseBlocker,
} from "@/hooks/useLightweightClose";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openNativeFileDialog } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleCheck,
  CircleAlert,
  type Command,
  Cpu,
  Download,
  Eye,
  EyeOff,
  FileText,
  LoaderCircle,
  FolderOpen,
  MessagesSquare,
  Package,
  Paintbrush,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Search,
  Settings2,
  Trash2,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ClaudeApiKeyField,
  CodexApiFormat,
  CodexApiFormatSelection,
  CodexCatalogModel,
  Provider,
} from "@/types";
import type { AppId } from "@/lib/api/types";
import { providersApi } from "@/lib/api/providers";
import { settingsApi } from "@/lib/api/settings";
import { configApi } from "@/lib/api";
import { vscodeApi } from "@/lib/api/vscode";
import { useUpdate } from "@/contexts/UpdateContext";
import type { Settings } from "@/types";
import {
  fetchModelsForConfig,
  type DetectedCodexApiFormat,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import { getChimeraHubTemplate } from "@/config/codexTemplates";
import { CodexContextWindowField } from "@/components/providers/CodexContextWindowField";
import { CodexPresetStart } from "@/components/providers/CodexPresetStart";
import type { PresetDraftSeed } from "@/utils/codexPresetDraft";
import {
  extractCodexBaseUrl,
  extractCodexExperimentalBearerToken,
  extractCodexModelName,
  isCodexGoalModeEnabled,
  isCodexRemoteCompactionEnabled,
  setCodexBaseUrl,
  setCodexGoalMode,
  setCodexModelName,
  setCodexRemoteCompaction,
  setCodexWireApi,
  codexApiFormatForModel,
  codexRemoteCompactionAllowed,
} from "@/utils/providerConfigUtils";
import { subscriptionApi, type BalanceResult } from "@/lib/api/subscription";
import { useQuery } from "@tanstack/react-query";
import { generateUUID } from "@/utils/uuid";
import { openDialogCount, useDialogFocus } from "@/hooks/useDialogFocus";
import {
  activityStorageKey,
  buildCodexModelCatalog,
  codexApiKeyCleared,
  codexApprovalPolicyWarning,
  codexProbeModels,
  describeCodexDetectionFailure,
  extractCodexMappingRows,
  loadOperationRecords,
  persistedCodexModelApiFormats,
  pickDefaultFetchedModel,
  previousCatalogAsFetched,
  saveOperationRecords,
  setCodexProviderApiKey,
  type ConnectionState,
  type OperationRecord,
} from "./chimeraUtils";
import { Empty } from "@/components/Empty";
import {
  isNativeToolAppId,
  nativeToolNames,
  toolProviderFields,
  updateToolProviderConfig,
} from "@/utils/toolProviderConfig";
import { useSettingsQuery } from "@/lib/query/queries";
import routeGateIcon from "@/assets/icons/chimera-dragon-mark.png";
import "./chimera.css";
import "./components/ProviderEditorPage.css";

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const browserPreviewCapabilities: ProductCapability[] = [
  { id: "mcp", available: true, enabledByDefault: true },
  { id: "skills", available: true, enabledByDefault: true },
  { id: "prompts", available: true, enabledByDefault: true },
  { id: "config_health", available: true, enabledByDefault: true },
  { id: "codex_themes", available: true, enabledByDefault: true },
  { id: "official_accounts", available: true, enabledByDefault: true },
  { id: "multi_tool", available: true, enabledByDefault: true },
  { id: "live_backups", available: true, enabledByDefault: true },
  { id: "cc_switch_import", available: true, enabledByDefault: true },
  { id: "context_1m", available: true, enabledByDefault: true },
];

// Explicitly opt in to fixtures only in the browser development renderer.
const designPreview =
  import.meta.env.DEV &&
  !runningInTauri &&
  new URLSearchParams(window.location.search).get("preview") === "design";

// Canonical Codex reasoning-effort levels in ascending depth order. Mirrors
// CODEX_REASONING_LEVELS in CodexFormFields.tsx (the backend drops unknown
// values, so the UI only offers canonical ones).
const CODEX_REASONING_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

const UsageView = lazy(() =>
  import("./views/UsageView").then(({ UsageView: view }) => ({
    default: view,
  })),
);
import {
  CANONICAL_LINES,
  CANONICAL_PROVIDERS,
  CANONICAL_STATION,
} from "@/data/canonicalData";
import { ProviderLineTable } from "@/components/ProviderLineTable";
import { StationSignboard } from "@/components/StationSignboard";
import { CommandPalette } from "@/components/CommandPalette";
const OfficialAccountsView = lazy(() =>
  import("./views/OfficialAccountsView").then(({ OfficialAccountsView }) => ({
    default: OfficialAccountsView,
  })),
);
const PromptsView = lazy(() =>
  import("./views/PromptsView").then(({ PromptsView }) => ({
    default: PromptsView,
  })),
);
const SkillsMcpView = lazy(() =>
  import("./views/SkillsMcpView").then(({ SkillsMcpView }) => ({
    default: SkillsMcpView,
  })),
);
const ConfigHealthView = lazy(() =>
  import("./views/ConfigHealthView").then(({ ConfigHealthView }) => ({
    default: ConfigHealthView,
  })),
);
const SessionManagerPage = lazy(() =>
  import("./components/sessions/SessionManagerPage").then(
    ({ SessionManagerPage }) => ({ default: SessionManagerPage }),
  ),
);
const NewSettingsView = lazy(() =>
  import("./views/NewSettingsView").then(({ NewSettingsView }) => ({
    default: NewSettingsView,
  })),
);

const OmpView = lazy(() => import("./views/OmpView"));
const AppearanceView = lazy(() => import("./views/AppearanceView"));
const ToolView = lazy(() =>
  import("./views/ToolView").then(({ ToolView }) => ({
    default: ToolView,
  })),
);
import {
  canOpenProductView,
  hasEnabledCapability,
  type ProductCapability,
} from "@/lib/productCapabilities";

type View =
  | "providers"
  | "official-accounts"
  | "prompts"
  | "skills-mcp"
  | "sessions"
  | "usage"
  | "runtime"
  | "appearance"
  | "health"
  | "settings"
  | "tool-claude"
  | "tool-gemini"
  | "tool-opencode"
  | "tool-pi"
  | "tool-omp"
  | "tool-claude-desktop"
  | "tool-grokbuild"
  | "tool-settings";
type RuntimeStatus = {
  supported: boolean;
  installed: boolean;
  version?: string | null;
  installMode?: string | null;
  installPath?: string | null;
  canRepair: boolean;
  canRollback: boolean;
  canUninstall: boolean;
};
export type CodexProcessStatus = {
  supported: boolean;
  installed: boolean;
  running: boolean;
  installMode?: string | null;
  officialLoginAvailable: boolean;
};
export type CodexRendererUnlockProbe = {
  attachable: boolean;
  injected: boolean;
  modelCount: number;
  error?: string | null;
};
type CodexModelCatalogStatus = {
  valid: boolean;
  defaultModel: string;
  catalogPath?: string | null;
  modelCount: number;
  /** Codex 运行时是否确认了目录；false 表示文件已写对但探针未能验证。 */
  runtimeVerified: boolean;
  runtimeMessage?: string | null;
};
type CodexLaunchResult = {
  wasRunning: boolean;
  running: boolean;
  action: "launched" | "opened" | "restarted";
  modelUnlockAttempted: boolean;
  modelUnlockInjected: boolean;
  modelUnlockModelCount: number;
  modelUnlockError?: string | null;
};
type ReleaseStatus = {
  currentVersion?: string | null;
  latestVersion: string;
  updateAvailable: boolean;
  installMode: string;
  sizeBytes: number;
  source: string;
};
type ProductCapabilities = { capabilities: ProductCapability[] };
type Diagnostic = { name: string; result: string };
type DownloadProgress = {
  downloaded: number;
  total: number;
  stage?: "downloading" | "installing";
};
type RuntimeAction = "update" | "repair" | "rollback" | "uninstall";
type RuntimeUpdatePreferences = {
  source: "auto" | "mirror";
  installMode: "standard" | "portable";
};
type PendingRuntimeAction = {
  action: RuntimeAction;
  preferences?: RuntimeUpdatePreferences;
};
type RuntimeOperation = {
  action: RuntimeAction;
  stage: "preparing" | "downloading" | "installing";
};
// v2.5.0 M3：历史版本 / 离线安装 / 安装事务恢复
type CodexRuntimeReleaseItem = {
  tag: string;
  name?: string | null;
  publishedAt?: string | null;
  prerelease: boolean;
  installable: boolean;
};
type CodexRuntimeReleasePlan = {
  version: string;
  packageVersion: string;
  packageMoniker: string;
  packageUrl: string;
  sha256: string;
  sizeBytes: number;
  releasedAt?: string | null;
};
type CodexOfflineInspection = {
  fileName: string;
  sizeBytes: number;
  sha256: string;
  signatureValid: boolean;
  packageName: string;
  publisher: string;
  packageVersion: string;
  architecture: string;
  architectureMatches: boolean;
  identityValid: boolean;
};
type CodexInstallRecoveryEntry = {
  id: string;
  startedAt: number;
  version: string;
  installMode: string;
  source: string;
  state: string;
  detail?: string | null;
  backupPath?: string | null;
};
const nav: Array<[View, string, typeof Command]> = [
  ["providers", "供应商", Route],
  ["official-accounts", "官方账号", Users],
  ["prompts", "提示词", FileText],
  ["skills-mcp", "Skills 与 MCP", Cpu],
  ["sessions", "会话", MessagesSquare],
  ["usage", "词元", BarChart3],
  ["runtime", "Codex 管理", Package],
  ["appearance", "外观", Paintbrush],
  ["health", "配置体检", Activity],
  ["settings", "设置", Settings2],
  ["tool-claude", "Claude Code", Route],
  ["tool-claude-desktop", "Claude Desktop", Route],
  ["tool-gemini", "Gemini CLI", Route],
  ["tool-opencode", "OpenCode", Route],
  ["tool-pi", "Pi", Route],
  ["tool-omp", "oh-my-pi", Route],
  ["tool-grokbuild", "Grok Build", Route],

  ["tool-settings", "管理工具", Settings2],
];

const viewLabels: Record<View, string> = Object.fromEntries(
  nav.map(([id, label]) => [id, label]),
) as Record<View, string>;

const runtimeText = (mode?: string | null) =>
  mode === "standard"
    ? "标准安装"
    : mode === "portable"
      ? "免安装版"
      : "未识别安装方式";

const runtimeChannelText = (source?: string | null) =>
  source === "mirror" ? "GitHub 镜像" : "自动（镜像）";

// UTC slicing (`publishedAt.slice(0, 10)`) shows the wrong calendar day in
// timezones ahead of UTC (e.g. UTC+8 late-evening releases). Format in the
// viewer's local timezone instead, and fall back gracefully for
// missing/unparseable timestamps rather than throwing or showing 1970-01-01
// (`new Date(null)` resolves to the epoch, not an invalid date).
const formatReleaseDate = (publishedAt?: string | null): string => {
  if (!publishedAt) return "发布时间未知";
  const parsed = new Date(publishedAt);
  if (Number.isNaN(parsed.getTime())) return "发布时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
};

type CodexEndpointInput = {
  baseUrl: string;
  apiKey: string;
  isFullUrl: boolean;
  modelsUrl: string;
  customUserAgent: string;
};

// Protocol probe results for one upstream identity. `formats` may cover more
// models than the current probe set; whatever is missing is probed on save.
type CodexApiFormatDetection = {
  identity: string;
  formats: Record<string, DetectedCodexApiFormat>;
  failures: Record<string, string>;
};

function codexEndpointIdentity(input: CodexEndpointInput): string {
  return JSON.stringify([
    input.baseUrl.trim(),
    input.apiKey,
    input.isFullUrl,
    input.modelsUrl.trim(),
    input.customUserAgent.trim(),
  ]);
}

// The fields a protocol probe actually depends on. `modelsUrl` only affects
// model discovery, so changing it must not throw detection results away.
function codexProtocolIdentity(input: CodexEndpointInput): string {
  return JSON.stringify([
    input.baseUrl.trim(),
    input.apiKey,
    input.isFullUrl,
    input.customUserAgent.trim(),
  ]);
}

function isEditorDraftDirty(
  draft: ReturnType<typeof providerDraft>,
  baseline: string | null,
): boolean {
  return baseline !== null && editorDraftSignature(draft) !== baseline;
}

function editorDraftSignature(draft: ReturnType<typeof providerDraft>): string {
  const { original: _original, ...rest } = draft;
  return JSON.stringify(rest);
}

/**
 * Neutral balance hint when no balance can be shown; `null` means show the
 * result. Driven by the backend's typed status, never by its message text.
 */
export function providerBalanceNotice(
  hasCredentials: boolean,
  result: BalanceResult | undefined,
): string | null {
  if (!hasCredentials || result?.status === "missing_credentials") {
    return "填写请求地址和 API Key 后可查询余额";
  }
  if (result?.status === "unsupported") return "此线路暂不支持余额查询";
  return null;
}

function codexApiFormatLabel(format: CodexApiFormat): string {
  if (format === "openai_responses") return "Responses";
  if (format === "openai_chat") return "Chat Completions";
  return "Anthropic Messages";
}

export function providerDraft(
  provider?: Provider | null,
  suggestedName?: string,
  appId: AppId = "codex",
) {
  const native = isNativeToolAppId(appId)
    ? toolProviderFields(appId, provider)
    : null;
  const template = native
    ? { name: "新线路", websiteUrl: "", config: "", auth: {} }
    : getChimeraHubTemplate();
  const config = native
    ? ""
    : String(provider?.settingsConfig?.config ?? template.config);
  const auth = (provider?.settingsConfig?.auth ?? template.auth) as Record<
    string,
    unknown
  >;
  const meta = provider?.meta ?? {};
  const persistedApiFormat: CodexApiFormat | undefined =
    meta.apiFormat === "openai_chat" ||
    meta.apiFormat === "anthropic" ||
    meta.apiFormat === "openai_responses"
      ? meta.apiFormat
      : undefined;
  const apiFormat: CodexApiFormatSelection =
    meta.apiFormatAutoDetected === true || !persistedApiFormat
      ? "auto"
      : persistedApiFormat;
  const anthropicAuthField: ClaudeApiKeyField =
    meta.apiKeyField === "ANTHROPIC_API_KEY"
      ? "ANTHROPIC_API_KEY"
      : "ANTHROPIC_AUTH_TOKEN";
  return {
    id: provider?.id ?? generateUUID(),
    name: provider?.name ?? suggestedName ?? template.name,
    websiteUrl: provider?.websiteUrl ?? template.websiteUrl,
    notes: provider?.notes ?? "",
    iconColor: provider?.iconColor,
    baseUrl: extractCodexBaseUrl(config) ?? "",
    apiKey: String(
      auth.OPENAI_API_KEY ?? auth[anthropicAuthField] ?? auth.api_key ?? "",
    ),
    model: extractCodexModelName(config) ?? "",
    config,
    auth,
    apiFormat,
    anthropicAuthField,
    impersonateClaudeCode: meta.impersonateClaudeCode === true,
    maxOutputTokens:
      typeof meta.maxOutputTokens === "number" && meta.maxOutputTokens > 0
        ? String(meta.maxOutputTokens)
        : "",
    isFullUrl: meta.isFullUrl === true,
    modelsUrl: typeof meta.modelsUrl === "string" ? meta.modelsUrl : "",
    customUserAgent:
      typeof meta.customUserAgent === "string" ? meta.customUserAgent : "",
    promptCacheRouting: meta.promptCacheRouting ?? "auto",
    codexChatReasoning: meta.codexChatReasoning ?? {},
    goalModeEnabled: isCodexGoalModeEnabled(config),
    remoteCompactionEnabled: isCodexRemoteCompactionEnabled(config),
    commonConfigEnabled: meta.commonConfigEnabled === true,
    // The user's mapping rows only. The generated Codex catalog (default +
    // rows + fetched models) is rebuilt on save and never read back here.
    catalogModels: extractCodexMappingRows(provider),
    original: provider ?? null,
    nativeProtocol: "",
    ...native,
    ...(!provider && native
      ? { baseUrl: getChimeraHubTemplate().baseUrl }
      : {}),
  };
}

/** A new-line draft seeded from a preset. Starts from a clean draft so nothing
 * of the previous starting point survives, and reads the config-derived flags
 * from the preset's own config rather than the template's. */
export function providerDraftFromSeed(seed: PresetDraftSeed, id: string) {
  return {
    ...providerDraft(null, seed.name),
    ...seed,
    goalModeEnabled: isCodexGoalModeEnabled(seed.config),
    remoteCompactionEnabled: isCodexRemoteCompactionEnabled(seed.config),
    id,
  };
}

// Detection results saved with a provider, keyed to the draft's protocol
// identity so a re-opened editor saves without re-probing until the endpoint,
// key, full-URL flag or User-Agent changes.
function detectionFromProvider(
  provider: Provider | null | undefined,
  draft: ReturnType<typeof providerDraft>,
): CodexApiFormatDetection | null {
  if (!provider || draft.apiFormat !== "auto") return null;
  const formats = persistedCodexModelApiFormats(provider.meta);
  if (!Object.keys(formats).length) return null;
  return { identity: codexProtocolIdentity(draft), formats, failures: {} };
}

export default function ChimeraApp({
  providerRefreshVersion = 0,
}: { providerRefreshVersion?: number } = {}) {
  const [requestedView, setRequestedView] = useState<View>("providers");
  const editorOpenSeqRef = useRef(0);
  const [skillsAppId, setSkillsAppId] = useState<AppId>("codex");
  const [capabilities, setCapabilities] = useState<ProductCapability[]>(
    runningInTauri ? [] : browserPreviewCapabilities,
  );
  const { data: toolSettings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
    enabled: runningInTauri,
  });
  const canNavigate = useCallback(
    (target: string) =>
      canOpenProductView(target, capabilities) &&
      (!runningInTauri ||
        isProductToolVisible(target, toolSettings?.visibleApps)),
    [capabilities, toolSettings?.visibleApps],
  );
  const setView = (target: View) => {
    if (canNavigate(target)) {
      editorOpenSeqRef.current += 1;
      setRequestedView(target);
    }
  };
  const view = canNavigate(requestedView) ? requestedView : "providers";
  // Also revoke pending opens on policy-driven navigation and unmount.
  useLayoutEffect(
    () => () => {
      editorOpenSeqRef.current += 1;
    },
    [view],
  );
  const manageToolResources = canNavigate("skills-mcp")
    ? (appId: AppId) => {
        setSkillsAppId(appId);
        setView("skills-mcp");
      }
    : undefined;
  const multiToolEnabled = hasEnabledCapability(capabilities, "multi_tool");
  const skinEnabled = hasEnabledCapability(capabilities, "codex_themes");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [currentSource, setCurrentSource] = useState<
    "live" | "stored" | "external" | "none"
  >("none");
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const activeProvider = useMemo(
    () =>
      currentSource === "external" || currentSource === "none"
        ? null
        : (providers.find((p) => p.id === currentId) ?? null),
    [providers, currentId, currentSource],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [codexProcess, setCodexProcess] = useState<CodexProcessStatus | null>(
    null,
  );
  // Mirrors `codexProcess` so a transient probe failure can fall back to the
  // last known-good status synchronously (loadCodexProcess is a stable
  // useCallback with an empty dep array, so the closed-over `codexProcess`
  // state variable itself is always stale).
  const codexProcessRef = useRef<CodexProcessStatus | null>(null);
  const [launchingCodex, setLaunchingCodex] = useState(false);
  const [codexRestartRequired, setCodexRestartRequired] = useState(false);
  const [rendererUnlock, setRendererUnlock] =
    useState<CodexRendererUnlockProbe | null>(null);
  const rendererUnlockSeqRef = useRef(0);
  const [release, setRelease] = useState<ReleaseStatus | null>(null);
  const [editor, setEditor] = useState<ReturnType<typeof providerDraft> | null>(
    null,
  );
  const [editorAppId, setEditorAppId] = useState<AppId>("codex");
  const [models, setModels] = useState<FetchedModel[] | null>(null);
  const [modelFetchIdentity, setModelFetchIdentity] = useState<string | null>(
    null,
  );
  const [apiFormatDetection, setApiFormatDetection] =
    useState<CodexApiFormatDetection | null>(null);
  const [apiFormatDetectionError, setApiFormatDetectionError] = useState<
    string | null
  >(null);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);
  const [commonConfigSnippet, setCommonConfigSnippet] = useState("");
  const [commonConfigLoading, setCommonConfigLoading] = useState(false);
  const [commonConfigLoaded, setCommonConfigLoaded] = useState(false);
  const [commonConfigDirty, setCommonConfigDirty] = useState(false);
  const commonConfigBaselineRef = useRef("");
  const [fetchingModels, setFetchingModels] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [pendingAction, setPendingAction] =
    useState<PendingRuntimeAction | null>(null);
  const [runtimeOperation, setRuntimeOperation] =
    useState<RuntimeOperation | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [activity, setActivity] = useState<OperationRecord[]>([]);
  const activityKeyRef = useRef<string | null>(null);
  const startupProviderCheckRef = useRef(false);
  const startupRuntimeCheckRef = useRef(false);
  const fetchModelsSeqRef = useRef(0);
  const providerLoadSeqRef = useRef(0);
  const protocolProbeSeqRef = useRef(0);
  const runtimeCheckSeqRef = useRef(0);
  const testConnectionSeqRef = useRef(0);
  const draftTestSeqRef = useRef(0);
  const providerSaveInFlightRef = useRef(false);
  const editorRef = useRef(editor);
  const [connection, setConnection] = useState<ConnectionState>({
    kind: "unknown",
    message: "尚未验证连接",
  });
  const [diagnostics, setDiagnostics] = useState<Diagnostic[] | null>(null);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgress | null>(null);
  const [deletingProviderId, setDeletingProviderId] = useState<string | null>(
    null,
  );
  const providerDeleteInFlightRef = useRef(false);
  const [pendingProviderDelete, setPendingProviderDelete] =
    useState<Provider | null>(null);
  const [pendingModelReload, setPendingModelReload] = useState<string | null>(
    null,
  );
  const [pendingSkinAction, setPendingSkinAction] = useState<{
    label: string;
    execute: () => void;
  } | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [pendingEditorDiscard, setPendingEditorDiscard] = useState(false);
  // Editor-local connection test result: the home banner reflects the active
  // line only and must never change because a draft was tested.
  const [draftConnection, setDraftConnection] = useState<ConnectionState>({
    kind: "unknown",
    message: "尚未测试",
  });
  const editorBaselineRef = useRef<string | null>(null);
  const codexProcessSeqRef = useRef(0);

  const currentEndpoint = activeProvider
    ? extractCodexBaseUrl(String(activeProvider.settingsConfig?.config ?? ""))
    : null;
  useLayoutEffect(() => {
    testConnectionSeqRef.current += 1;
    setConnection({ kind: "unknown", message: "尚未测试" });
    return () => {
      testConnectionSeqRef.current += 1;
    };
  }, [activeProvider?.id, currentEndpoint]);

  const activeEndpointIdentity = editor ? codexEndpointIdentity(editor) : null;
  const activeProtocolIdentity = editor ? codexProtocolIdentity(editor) : null;

  useLayoutEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useLayoutEffect(() => {
    fetchModelsSeqRef.current += 1;
    // IPC cannot abort its network request, but it no longer owns the editor.
    setFetchingModels(false);
    setModels(null);
    setModelFetchIdentity(null);
    setModelFetchError(null);
    setModelPickerOpen(false);
    return () => {
      fetchModelsSeqRef.current += 1;
    };
  }, [activeEndpointIdentity, editor?.id]);

  useEffect(() => {
    protocolProbeSeqRef.current += 1;
    setApiFormatDetection((current) =>
      current && current.identity === activeProtocolIdentity ? current : null,
    );
    setApiFormatDetectionError(null);
  }, [activeProtocolIdentity, editor?.id]);

  useEffect(() => {
    setShowKey(false);
    setPendingEditorDiscard(false);
    setDraftConnection({ kind: "unknown", message: "尚未测试" });
    draftTestSeqRef.current += 1;
  }, [editor?.id]);

  const editorReturnFocusRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [view]);
  const [editorSaveError, setEditorSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (editor || !editorReturnFocusRef.current) return;
    const target = editorReturnFocusRef.current;
    editorReturnFocusRef.current = null;
    (target.isConnected
      ? target
      : (contentRef.current?.querySelector<HTMLElement>(
          '[aria-label="管理线路"]',
        ) ?? contentRef.current)
    )?.focus({
      preventScroll: true,
    });
  }, [Boolean(editor)]);

  void runtime;
  void apiFormatDetection;
  void apiFormatDetectionError;
  void modelFetchError;
  void commonConfigLoading;
  void fetchingModels;
  void showKey;
  void draftConnection;
  void editorSaveError;

  const openEditor = (
    draft: ReturnType<typeof providerDraft>,
    appId: AppId = "codex",
  ) => {
    editorOpenSeqRef.current += 1;
    editorRef.current = draft;
    editorReturnFocusRef.current = document.activeElement as HTMLElement | null;
    setEditorSaveError(null);
    setModels(null);
    setModelFetchError(null);
    editorBaselineRef.current = editorDraftSignature(draft);
    setEditorAppId(appId);
    setEditor(draft);
    setApiFormatDetection(detectionFromProvider(draft.original, draft));
  };

  const openToolEditor = async (lineId: string, appId: AppId) => {
    if (editorRef.current) {
      toast.info("请先保存或关闭当前正在编辑的线路");
      return;
    }
    if (!isNativeToolAppId(appId)) {
      toast.error("此工具尚未提供线路编辑器");
      return;
    }
    const request = ++editorOpenSeqRef.current;
    const ownsOpen = () =>
      request === editorOpenSeqRef.current && !editorRef.current;
    if (lineId === "new") {
      openEditor(providerDraft(null, "新线路", appId), appId);
      return;
    }
    try {
      const all = await providersApi.getAll(appId);
      if (!ownsOpen()) return;
      const provider = all[lineId];
      if (!provider) throw new Error("线路不存在或已被删除");
      openEditor(providerDraft(provider, undefined, appId), appId);
    } catch (error) {
      if (ownsOpen())
        toast.error("无法打开线路", { description: String(error) });
    }
  };

  const closeEditor = () => {
    editorOpenSeqRef.current += 1;
    editorRef.current = null;
    editorBaselineRef.current = null;
    setPendingEditorDiscard(false);
    setEditor(null);
  };

  // Page return, Cancel and Escape share the unsaved-input guard.
  const requestCloseEditor = () => {
    const draft = editorRef.current;
    if (!draft || providerSaveInFlightRef.current) return;
    if (
      isEditorDraftDirty(draft, editorBaselineRef.current) ||
      commonConfigDirty
    ) {
      setPendingEditorDiscard(true);
      return;
    }
    closeEditor();
  };
  const [onboardingDeferred, setOnboardingDeferred] = useState(false);
  void activity;

  // Titlebar update affordance: one click checks, so the user never has to walk
  // into 设置 just to find out whether a release is waiting.
  const {
    hasUpdate: titlebarHasUpdate,
    updateInfo: titlebarUpdateInfo,
    isChecking: _titlebarChecking,
    isInstalling: titlebarInstalling,
    isStaging: titlebarStaging,
    checkUpdate: titlebarCheckUpdate,
    installUpdate: titlebarInstallUpdate,
    resetDismiss: titlebarResetDismiss,
  } = useUpdate();

  useLightweightClose(
    Boolean(
      editor ||
      commonConfigDirty ||
      savingProvider ||
      deletingProviderId ||
      runtimeOperation ||
      downloadProgress ||
      pendingAction ||
      launchingCodex ||
      diagnosing ||
      titlebarInstalling ||
      titlebarStaging ||
      loading,
    ),
  );

  const runTitlebarUpdateCheck = useCallback(async () => {
    if (!runningInTauri) {
      toast.info("预览模式无法检查更新");
      return;
    }
    if (titlebarHasUpdate) {
      try {
        const installed = await titlebarInstallUpdate();
        if (!installed) {
          toast.info("该更新已不可用", {
            description: "已重新检查更新。",
          });
        }
      } catch (error) {
        toast.error("应用更新失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    try {
      const available = await titlebarCheckUpdate();
      if (available) {
        // Re-show the banner even if this version was dismissed earlier: an
        // explicit click is a request to see it again.
        titlebarResetDismiss();
        toast.success("发现新版本", {
          description: "再次点击标题栏更新按钮即可下载并安装。",
        });
      } else {
        toast.success("已是最新版本");
      }
    } catch (error) {
      toast.error("检查更新失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    titlebarCheckUpdate,
    titlebarHasUpdate,
    titlebarInstallUpdate,
    titlebarResetDismiss,
  ]);

  const handleTitlebarMouseDown = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.detail !== 1) {
        return;
      }

      const target = event.target as HTMLElement;
      if (
        target.closest(
          'button, input, textarea, select, a, [role="button"], [data-tauri-no-drag]',
        )
      ) {
        return;
      }

      // Use an explicit drag call instead of Tauri's native drag-region
      // attribute. Native drag regions let the window manager interpret a
      // double-click as maximize/restore, even for a fixed-size window.
      void getCurrentWindow().startDragging();
    },
    [],
  );

  const preventTitlebarDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  const loadProviders = useCallback(async () => {
    const seq = ++providerLoadSeqRef.current;
    if (!runningInTauri) {
      if (designPreview) {
        if (seq !== providerLoadSeqRef.current) return;
        setProviders(CANONICAL_PROVIDERS);
        setCurrentId(CANONICAL_LINES.find((line) => line.isCurrent)?.id ?? "");
        setCurrentSource("stored");
        setLoading(false);
        return;
      }
      setProviders([]);
      setCurrentId("");
      setCurrentSource("none");
      setLoading(false);
      return;
    }
    try {
      // Rows arrive without OAuth material, so the current line is matched
      // against live config in the backend, which still sees raw values.
      const [all, resolution] = await Promise.all([
        providersApi.getAll("codex"),
        providersApi.getCodexCurrentResolution(),
      ]);
      if (seq !== providerLoadSeqRef.current) return;
      const sorted = Object.values(all).sort(
        (a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0),
      );
      setProviders(sorted);
      setCurrentId(resolution.id ?? "");
      setCurrentSource(resolution.source);
      setLoadError(null);
    } catch (error) {
      if (seq !== providerLoadSeqRef.current) return;
      setLoadError(String(error));
      toast.error("无法读取 Codex 供应商", { description: String(error) });
    } finally {
      if (seq === providerLoadSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    if (runningInTauri) {
      void providersApi
        .onSwitched((event) => {
          if (active && event.appType === "codex") void loadProviders();
        })
        .then((unlisten) => {
          if (!active) {
            unlisten();
            return;
          }
          dispose = unlisten;
          // Subscribe before reading: a tray/profile switch during startup must
          // not fall into the gap between the initial snapshot and the listener.
          void loadProviders();
        })
        .catch(() => {
          if (!active) return;
          toast.error("无法订阅线路切换，请重新加载应用");
          void loadProviders();
        });
    } else {
      void loadProviders();
    }
    return () => {
      active = false;
      providerLoadSeqRef.current += 1;
      dispose?.();
    };
  }, [loadProviders]);

  useEffect(() => {
    if (providerRefreshVersion > 0) void loadProviders();
  }, [providerRefreshVersion, loadProviders]);

  const retryLoadProviders = async () => {
    setLoading(true);
    await loadProviders();
  };

  const loadRuntime = async () => {
    if (!runningInTauri) {
      setRuntime(null);
      return;
    }
    try {
      const status = await invoke<RuntimeStatus>("get_codex_runtime_status");
      setRuntime(status);
    } catch (error) {
      setRuntime(null);
      if (view === "runtime")
        toast.error("无法读取 Codex 更新状态", {
          description: String(error),
        });
    }
  };

  const refreshRendererUnlock = useCallback(async () => {
    const seq = ++rendererUnlockSeqRef.current;
    if (!runningInTauri || !codexProcessRef.current?.running) {
      setRendererUnlock(null);
      return;
    }
    try {
      const probe = await invoke<CodexRendererUnlockProbe>(
        "probe_codex_renderer_unlock",
      );
      if (seq === rendererUnlockSeqRef.current) setRendererUnlock(probe);
    } catch {
      if (seq === rendererUnlockSeqRef.current) setRendererUnlock(null);
    }
  }, []);

  const loadCodexProcess = useCallback(async () => {
    if (!runningInTauri) {
      codexProcessRef.current = null;
      setCodexProcess(null);
      setRendererUnlock(null);
      return null;
    }
    // Polls, focus events and launch/switch flows all call this; a slow older
    // probe resolving after a newer one must not roll the status backwards.
    const seq = ++codexProcessSeqRef.current;
    try {
      const status = await invoke<CodexProcessStatus>(
        "get_codex_process_status",
      );
      if (seq !== codexProcessSeqRef.current) {
        return codexProcessRef.current ?? status;
      }
      codexProcessRef.current = status;
      setCodexProcess(status);
      void refreshRendererUnlock();
      return status;
    } catch {
      // A rejected probe is usually transient IPC jitter (a dropped tick,
      // a busy backend), not a real uninstall. Keep whatever status we
      // last observed and let the next 4s poll (see the `view ===
      // "providers"` effect below) self-heal; only fall back to the "not
      // installed" placeholder if we never had a successful read yet.
      const status: CodexProcessStatus = codexProcessRef.current ?? {
        supported: true,
        installed: false,
        running: false,
        installMode: null,
        officialLoginAvailable: false,
      };
      if (seq !== codexProcessSeqRef.current) return status;
      codexProcessRef.current = status;
      setCodexProcess(status);
      ++rendererUnlockSeqRef.current;
      setRendererUnlock(null);
      return status;
    }
  }, []);

  const openCodex = async () => {
    if (designPreview) return;
    if (
      launchingCodex ||
      codexProcess?.supported === false ||
      codexProcess?.installed === false
    )
      return;
    setLaunchingCodex(true);
    try {
      if (!runningInTauri) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        setCodexProcess((current) => ({
          supported: true,
          installed: true,
          running: true,
          installMode: current?.installMode ?? "standard",
          officialLoginAvailable: current?.officialLoginAvailable ?? false,
        }));
        setCodexRestartRequired(false);
        toast.success("Codex 已启动");
        return;
      }
      // Runtime policy belongs to the backend: it independently detects
      // whether Codex is running — the source of truth, not this
      // component's polled `codexProcess`, which can be stale (refreshed
      // only every few seconds, and only while the window is visible). A
      // pre-emptive confirm here gated on that stale read could skip
      // asking the user even though the backend's live check finds Codex
      // running. So always attempt without confirmation first; only if the
      // backend rejects with its `CONFIRM_RESTART_REQUIRED:` sentinel
      // (meaning it just found Codex running for real) do we ask the user
      // and retry with `confirmRestart: true` — "open" used to silently
      // force-close (30s grace, then a hard kill) and relaunch Codex with
      // no warning that whatever the user was doing would be interrupted.
      let result: CodexLaunchResult;
      try {
        result = await invoke<CodexLaunchResult>("open_codex_runtime", {
          confirmRestart: false,
        });
      } catch (error) {
        if (String(error).startsWith("CONFIRM_RESTART_REQUIRED:")) {
          if (
            !window.confirm(
              "Codex 正在运行，继续将关闭并重新启动它以应用最新配置，期间的任何未完成操作都会中断。是否继续？",
            )
          ) {
            return;
          }
          result = await invoke<CodexLaunchResult>("open_codex_runtime", {
            confirmRestart: true,
          });
        } else {
          throw error;
        }
      }
      await loadCodexProcess();
      await refreshRendererUnlock();
      setCodexRestartRequired(false);
      toast.success(
        result.action === "restarted"
          ? "Codex 已重启"
          : result.wasRunning
            ? "已打开 Codex"
            : "Codex 已启动",
      );
      if (result.modelUnlockError) {
        toast.warning("模型目录已保存；桌面端模型选择器增强未连接", {
          description: result.modelUnlockError,
        });
      }
    } catch (error) {
      toast.error("无法启动 Codex", { description: String(error) });
      await loadCodexProcess();
    } finally {
      setLaunchingCodex(false);
    }
  };

  useEffect(() => {
    if (!runningInTauri) {
      void loadRuntime();
      void loadCodexProcess();
      return;
    }
    let active = true;
    void settingsApi
      .getAppConfigPath()
      .then((path) => {
        if (!active) return;
        const key = activityStorageKey(path);
        activityKeyRef.current = key;
        setActivity(loadOperationRecords(window.localStorage, key));
      })
      .catch(() => {
        // Activity history is optional; never fall back to a global profile.
        activityKeyRef.current = null;
      });
    void loadRuntime();
    void loadCodexProcess();
    void invoke<ProductCapabilities>("get_product_capabilities")
      .then((value) => {
        if (active) setCapabilities(value.capabilities ?? []);
      })
      .catch(() => {
        if (active) setCapabilities([]);
      });
    const unlisten = listen<DownloadProgress>(
      "codex-runtime-download-progress",
      (event) => {
        const payload = event.payload;
        setDownloadProgress({
          ...payload,
          stage:
            payload.total > 0 && payload.downloaded >= payload.total
              ? "installing"
              : "downloading",
        });
        setRuntimeOperation((current) =>
          current
            ? {
                ...current,
                stage:
                  payload.total > 0 && payload.downloaded >= payload.total
                    ? "installing"
                    : "downloading",
              }
            : current,
        );
      },
    );
    return () => {
      active = false;
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (view !== "providers") return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadCodexProcess();
    };
    const interval = window.setInterval(refreshWhenVisible, 4000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [loadCodexProcess, view]);

  const note = (
    action: string,
    result: OperationRecord["result"] = "success",
    detail?: string,
    provider = "Codex",
    durationMs?: number,
  ) => {
    setActivity((items) => {
      const records = [
        {
          id: generateUUID(),
          timestamp: Date.now(),
          provider,
          action,
          result,
          detail,
          durationMs,
        },
        ...items,
      ];
      const key = activityKeyRef.current;
      return key
        ? saveOperationRecords(records, window.localStorage, key)
        : records;
    });
  };

  const switchProvider = async (id: string) => {
    if (designPreview) return false;
    const started = performance.now();
    const selectedProvider = providers.find((item) => item.id === id);
    const isOfficial =
      selectedProvider?.id === "codex-official" ||
      selectedProvider?.category === "official";
    try {
      await providersApi.switch(id, "codex");
      setCurrentId(id);
      const [, latestProcess] = await Promise.all([
        loadProviders(),
        loadCodexProcess(),
      ]);
      setCodexRestartRequired(true);
      const selectedModel = extractCodexModelName(
        String(selectedProvider?.settingsConfig?.config ?? ""),
      );
      if (latestProcess?.running && !isOfficial && selectedModel) {
        setPendingModelReload(selectedModel);
      }
      note(
        "切换线路",
        "success",
        isOfficial
          ? "已切回官方账户模式，保留 Codex 登录状态"
          : "配置已写入 Codex",
        selectedProvider?.name ?? id,
        performance.now() - started,
      );
      toast.success(isOfficial ? "已切回官方账户" : "已应用到 Codex", {
        description: isOfficial
          ? latestProcess?.running
            ? "请重启 Codex 以载入官方登录配置"
            : "启动 Codex 即可继续使用 ChatGPT 官方账户"
          : latestProcess?.running
            ? "请重启 Codex 以载入新线路"
            : undefined,
      });
      return true;
    } catch (error) {
      note(
        "切换线路",
        "error",
        String(error),
        selectedProvider?.name ?? id,
        performance.now() - started,
      );
      toast.error("切换失败", { description: String(error) });
      return false;
    }
  };

  const testConnection = async (
    baseUrl: string,
    providerName = "Codex",
    target: "home" | "draft" = "home",
  ) => {
    if (designPreview) return false;
    const started = performance.now();
    const seqRef = target === "draft" ? draftTestSeqRef : testConnectionSeqRef;
    const setState = target === "draft" ? setDraftConnection : setConnection;
    const seq = ++seqRef.current;
    setState({ kind: "checking", message: "正在测试 API 地址" });
    try {
      const [result] = await vscodeApi.testApiEndpoints([baseUrl], {
        timeoutSecs: 12,
      });
      // A newer test started while this one was in flight; let that one own
      // the connection banner and skip this stale response entirely.
      if (seq !== seqRef.current) return false;
      if (!result || result.latency == null)
        throw new Error(result?.error || "服务未响应");
      setState({
        kind: "connected",
        message: `${result.latency}ms`,
        modelCount: models?.length ?? 0,
        latencyMs: result.latency,
      });
      note(
        "连接测试",
        "success",
        `${result.latency}ms`,
        providerName,
        performance.now() - started,
      );
      toast.success("地址可达", {
        description: `响应时间 ${result.latency} ms · 未验证密钥或模型`,
      });
      return true;
    } catch (error) {
      if (seq !== seqRef.current) return false;
      setState({ kind: "error", message: String(error) });
      note(
        "连接测试",
        "error",
        String(error),
        providerName,
        performance.now() - started,
      );
      toast.error("连接测试失败", { description: String(error) });
      return false;
    }
  };

  useEffect(() => {
    if (!runningInTauri || loading || startupProviderCheckRef.current) return;
    const current = activeProvider;
    if (!current) return;
    startupProviderCheckRef.current = true;
    const seq = testConnectionSeqRef.current;
    void settingsApi
      .get()
      .then((settings) => {
        if (
          settings.checkProviderStatusOnStart === false ||
          seq !== testConnectionSeqRef.current
        )
          return;
        const endpoint = extractCodexBaseUrl(
          String(current.settingsConfig?.config ?? ""),
        );
        if (endpoint) void testConnection(endpoint, current.name);
      })
      .catch(() => {
        // Startup validation is optional and must never block the main window.
      });
  }, [activeProvider, loading]);

  // `formatOverride` backs the "按 Chat / Responses / Anthropic 保存" quick
  // actions shown when detection fails: the choice is applied to the draft and
  // saved in one step, so a failed probe never strands the user.
  const saveProvider = async (formatOverride?: CodexApiFormat) => {
    if (designPreview) return;
    if (!editor) return;
    const draft =
      formatOverride && formatOverride !== editor.apiFormat
        ? { ...editor, apiFormat: formatOverride }
        : editor;
    if (draft !== editor) {
      editorRef.current = draft;
      setEditor(draft);
      setApiFormatDetectionError(null);
    }
    if (
      !draft.name.trim() ||
      !draft.baseUrl.trim() ||
      (editorAppId === "codex" && !draft.apiKey.trim()) ||
      (editorAppId !== "claude" &&
        editorAppId !== "gemini" &&
        !draft.model.trim())
    ) {
      toast.error(
        editorAppId === "codex"
          ? "请填写线路名称、API 请求地址、API Key 和默认模型"
          : "请填写标有 * 的必填项",
      );
      return;
    }

    if (providerSaveInFlightRef.current) return;
    setEditorSaveError(null);
    providerSaveInFlightRef.current = true;
    setSavingProvider(true);
    setModelPickerOpen(false);

    try {
      if (isNativeToolAppId(editorAppId)) {
        const provider: Provider = {
          ...draft.original,
          id: draft.id,
          name: draft.name.trim(),
          websiteUrl: draft.websiteUrl.trim(),
          notes: draft.notes,
          iconColor: draft.iconColor,
          settingsConfig: updateToolProviderConfig(
            editorAppId,
            draft.original,
            draft,
          ),
        };
        try {
          if (draft.original) {
            await providersApi.updateAndActivate(
              provider,
              editorAppId,
              draft.original.id,
            );
          } else {
            await providersApi.addAndActivate(provider, editorAppId, false);
          }
          window.dispatchEvent(
            new CustomEvent("chimera-provider-mutated", {
              detail: { appId: editorAppId },
            }),
          );
          toast.success(`${nativeToolNames[editorAppId]} 线路已保存并应用`);
          closeEditor();
        } catch (error) {
          setEditorSaveError(`保存失败，编辑内容已保留：${String(error)}`);
          toast.error("保存失败", { description: String(error) });
        }
        return;
      }
      if (editorAppId !== "codex") {
        setEditorSaveError("此工具尚未提供线路编辑器");
        return;
      }
      if (commonConfigLoaded && commonConfigDirty) {
        try {
          await configApi.validateCommonConfigSnippet(
            editorAppId,
            commonConfigSnippet,
          );
        } catch (error) {
          setEditorSaveError(`通用配置无效，线路尚未保存：${String(error)}`);
          toast.error("通用配置无效，线路尚未保存", {
            description: String(error),
          });
          return;
        }
      }
      const endpointIdentity = codexEndpointIdentity(draft);
      let fetchedForSave =
        models !== null && modelFetchIdentity === endpointIdentity
          ? models
          : [];
      let automaticFetchFailed = false;
      if (models === null || modelFetchIdentity !== endpointIdentity) {
        const seq = ++fetchModelsSeqRef.current;
        setFetchingModels(true);
        try {
          fetchedForSave = await fetchModelsForConfig(
            draft.baseUrl,
            draft.apiKey,
            draft.isFullUrl,
            draft.modelsUrl.trim() || undefined,
            draft.customUserAgent.trim() || undefined,
          );
          if (
            seq !== fetchModelsSeqRef.current ||
            !editorRef.current ||
            codexEndpointIdentity(editorRef.current) !== endpointIdentity
          ) {
            toast.info("线路配置已变化，请重新保存");
            return;
          }
          setModels(fetchedForSave);
          setModelFetchIdentity(endpointIdentity);
          setModelFetchError(null);
        } catch {
          if (seq !== fetchModelsSeqRef.current) return;
          automaticFetchFailed = true;
          fetchedForSave = [];
        } finally {
          if (seq === fetchModelsSeqRef.current) setFetchingModels(false);
        }
      }

      // Without a fresh list the catalog keeps what it already held, so an
      // edit made offline never shrinks the model picker in Codex.
      if (!fetchedForSave.length) {
        fetchedForSave = previousCatalogAsFetched(draft.original);
      }

      let resolvedApiFormat: CodexApiFormat =
        draft.apiFormat === "auto" ? "openai_responses" : draft.apiFormat;
      let resolvedAnthropicAuthField = draft.anthropicAuthField;
      // Only the default model and the user's mapping rows are probed. The
      // generated catalog still carries every fetched model; those follow the
      // provider protocol and the router's lazy probe at request time.
      const probeModels = codexProbeModels(draft.model, draft.catalogModels);
      let detectedFormats: Record<string, DetectedCodexApiFormat> = {};
      const catalogModels = buildCodexModelCatalog(
        draft.model,
        draft.catalogModels,
        fetchedForSave,
      );
      if (draft.apiFormat === "auto") {
        detectedFormats = Object.fromEntries(
          probeModels.map((model) => [
            model,
            { apiFormat: codexApiFormatForModel(model) },
          ]),
        );
        resolvedApiFormat = codexApiFormatForModel(draft.model);
        resolvedAnthropicAuthField = draft.anthropicAuthField;
        setApiFormatDetectionError(null);
      }

      if (editorRef.current !== draft) {
        toast.info("线路配置已变化，请重新保存");
        return;
      }

      let config = setCodexModelName(
        setCodexBaseUrl(draft.config, draft.baseUrl),
        draft.model,
      );
      // Codex itself always speaks Responses. Chat Completions and Anthropic
      // are upstream formats converted by the local router, never Codex wire
      // formats. Normalize stale/imported TOML before routing is evaluated.
      config = setCodexWireApi(config, "responses");
      config = setCodexGoalMode(config, draft.goalModeEnabled);
      // A conversion route can never answer Codex's remote compaction, so
      // the switch is forced off there (the backend rejects it too).
      config = setCodexRemoteCompaction(
        config,
        draft.remoteCompactionEnabled &&
          codexRemoteCompactionAllowed(draft.apiFormat, probeModels) &&
          resolvedApiFormat === "openai_responses",
        draft.name.trim(),
      );
      const auth = setCodexProviderApiKey(draft.auth, draft.apiKey);
      const provider: Provider = {
        // Carry over every top-level field on the existing provider
        // (createdAt, sortIndex, icon, iconColor, isPartner, …) so an edit
        // only ever touches the fields this form actually presents. Without
        // this spread, the fields below were the only ones sent to the
        // backend's UPDATE, silently NULL-ing out everything else. Fields
        // this form edits are overridden explicitly afterwards.
        ...draft.original,
        id: draft.id,
        name: draft.name.trim(),
        websiteUrl: draft.websiteUrl.trim() || undefined,
        notes: draft.notes.trim() || undefined,
        iconColor: draft.iconColor,
        // New providers default to "custom"; editing an existing provider
        // must never change its category out from under it.
        category: draft.original?.category ?? "custom",
        meta: {
          ...draft.original?.meta,
          apiFormat: resolvedApiFormat,
          apiFormatAutoDetected: draft.apiFormat === "auto" ? true : undefined,
          codexModelApiFormats:
            draft.apiFormat === "auto"
              ? Object.fromEntries(
                  probeModels
                    .filter((model) => detectedFormats[model])
                    .map((model) => [model, detectedFormats[model].apiFormat]),
                )
              : undefined,
          apiKeyField:
            resolvedApiFormat === "anthropic"
              ? resolvedAnthropicAuthField
              : undefined,
          impersonateClaudeCode:
            resolvedApiFormat === "anthropic" && draft.impersonateClaudeCode
              ? true
              : undefined,
          maxOutputTokens:
            resolvedApiFormat === "anthropic" &&
            Number(draft.maxOutputTokens) > 0
              ? Number(draft.maxOutputTokens)
              : undefined,
          isFullUrl: draft.isFullUrl || undefined,
          modelsUrl: draft.modelsUrl.trim() || undefined,
          customUserAgent: draft.customUserAgent.trim() || undefined,
          promptCacheRouting:
            resolvedApiFormat === "openai_chat" &&
            draft.promptCacheRouting !== "auto"
              ? draft.promptCacheRouting
              : undefined,
          codexChatReasoning:
            resolvedApiFormat === "openai_chat" &&
            (draft.codexChatReasoning.supportsThinking ||
              draft.codexChatReasoning.supportsEffort)
              ? draft.codexChatReasoning
              : undefined,
          commonConfigEnabled: draft.commonConfigEnabled,
        },
        settingsConfig: {
          ...draft.original?.settingsConfig,
          auth,
          config,
          modelCatalog: { models: catalogModels },
          // The user's rows live apart from the generated catalog so the
          // mapping table never re-reads the whole fetched list on reopen.
          modelMappings: {
            models: draft.catalogModels
              .filter((row) => row.model.trim())
              .map((row) => ({ ...row, model: row.model.trim() })),
          },
        },
      };
      let providerCommitted = false;
      try {
        if (draft.original) {
          // "保存并应用" must not leave an edited inactive provider behind if
          // its activation fails. The backend updates, switches and compensates
          // under one transaction using its own current pointer.
          await providersApi.updateAndActivate(
            provider,
            editorAppId,
            draft.original.id,
            { clearApiKey: codexApiKeyCleared(draft.original, draft.apiKey) },
          );
        } else {
          await providersApi.addAndActivate(provider, editorAppId, false);
        }
        providerCommitted = true;
        if (editorAppId === "codex") setCodexRestartRequired(true);
        // A later failure must retry an update, not add the same route again.
        const savedDraft = { ...draft, original: provider };
        editorRef.current = savedDraft;
        setEditor(savedDraft);
        if (commonConfigLoaded && commonConfigDirty) {
          await configApi.setCommonConfigSnippet(
            editorAppId,
            commonConfigSnippet,
          );
          commonConfigBaselineRef.current = commonConfigSnippet;
          setCommonConfigDirty(false);
        }
        // 文件级校验失败才算真错（目录没写对）；运行时交叉验证跑不起来只是
        // 环境限制（如 macOS 图形进程 PATH 里没有 node），不该报成保存失败。
        let catalogStatus: CodexModelCatalogStatus | null = null;
        try {
          if (editorAppId === "codex") {
            catalogStatus = await invoke<CodexModelCatalogStatus>(
              "verify_codex_model_catalog",
              {
                expectedModel: draft.model.trim(),
                expectedModels: catalogModels.map((item) => ({
                  model: item.model.trim(),
                  displayName: item.displayName?.trim() || item.model.trim(),
                })),
              },
            );
          }
        } catch (error) {
          await loadProviders();
          setEditorSaveError(
            `线路已保存并应用，但模型目录未正确应用。编辑内容已保留，可重试保存。${String(error)}`,
          );
          note("应用模型目录", "error", String(error), provider.name);
          toast.error("线路已保存，但模型目录未正确应用", {
            description: String(error),
          });
          return;
        }
        await loadProviders();
        window.dispatchEvent(
          new CustomEvent("chimera-provider-mutated", {
            detail: { appId: editorAppId },
          }),
        );
        closeEditor();
        setPendingModelReload(draft.model.trim());
        const writtenSummary = automaticFetchFailed
          ? "供应商未返回模型列表，已确保默认模型可用。"
          : `已写入 ${catalogModels.length} 个模型，重启 Codex 后生效。`;
        if (catalogStatus && !catalogStatus.runtimeVerified) {
          note(
            "保存并应用线路",
            "success",
            catalogStatus.runtimeMessage ?? undefined,
            provider.name,
          );
          toast.warning("线路与模型目录已保存，但未能自动验证实际模型列表", {
            description: [writtenSummary, catalogStatus.runtimeMessage]
              .filter(Boolean)
              .join(" "),
          });
        } else {
          note("保存并应用线路", "success", undefined, provider.name);
          toast.success("线路与模型目录已保存", {
            description: writtenSummary,
          });
        }
      } catch (error) {
        if (providerCommitted) {
          await loadProviders();
          setEditorSaveError(
            `线路已保存并应用，但后续配置未完成。编辑内容已保留，可重试保存。${String(error)}`,
          );
          toast.error("线路已保存并应用，但后续配置未完成", {
            description: `编辑内容已保留，可重试保存。${String(error)}`,
          });
        } else {
          setEditorSaveError(`保存失败，编辑内容已保留：${String(error)}`);
          toast.error("保存失败", { description: String(error) });
        }
      }
    } finally {
      providerSaveInFlightRef.current = false;
      setSavingProvider(false);
    }
  };

  useEffect(() => {
    if (!editor) {
      setCommonConfigSnippet("");
      setCommonConfigLoaded(false);
      setCommonConfigDirty(false);
      return;
    }
    let active = true;
    setCommonConfigLoading(true);
    setCommonConfigLoaded(false);
    setCommonConfigDirty(false);
    if (
      editorAppId !== "claude" &&
      editorAppId !== "codex" &&
      editorAppId !== "gemini"
    ) {
      setCommonConfigLoading(false);
      return;
    }
    void configApi
      .getCommonConfigSnippet(editorAppId)
      .then((snippet) => {
        if (!active) return;
        commonConfigBaselineRef.current = snippet ?? "";
        setCommonConfigSnippet(snippet ?? "");
        setCommonConfigLoaded(true);
      })
      .catch(() => {
        if (active) setCommonConfigSnippet("");
      })
      .finally(() => {
        if (active) setCommonConfigLoading(false);
      });
    return () => {
      active = false;
    };
  }, [editor?.id, editorAppId]);

  const deleteProvider = async (
    provider: Provider,
    appId: AppId,
  ): Promise<boolean> => {
    if (designPreview) return false;
    if (providerDeleteInFlightRef.current) return false;
    providerDeleteInFlightRef.current = true;
    setDeletingProviderId(provider.id);
    try {
      const deleted = await providersApi.delete(provider.id, appId);
      if (!deleted) throw new Error("线路未删除，请重试");
      await loadProviders();
      window.dispatchEvent(
        new CustomEvent("chimera-provider-mutated", {
          detail: { appId },
        }),
      );
      toast.success(`线路“${provider.name}”已删除`);
      return true;
    } catch (error) {
      toast.error("删除失败", { description: String(error) });
      return false;
    } finally {
      providerDeleteInFlightRef.current = false;
      setDeletingProviderId(null);
    }
  };

  const fetchModels = async () => {
    if (!editor?.baseUrl.trim() || !editor.apiKey.trim()) {
      toast.error("请先填写 API 请求地址和 API Key");
      return;
    }

    const draft = editor;
    const endpointIdentity = codexEndpointIdentity(draft);
    const fetchSeq = ++fetchModelsSeqRef.current;
    setFetchingModels(true);
    setModelFetchError(null);
    setApiFormatDetectionError(null);
    try {
      const result = await fetchModelsForConfig(
        draft.baseUrl,
        draft.apiKey,
        draft.isFullUrl,
        draft.modelsUrl.trim() || undefined,
        draft.customUserAgent.trim() || undefined,
      );
      const latest = editorRef.current;
      if (
        fetchSeq !== fetchModelsSeqRef.current ||
        !latest ||
        latest.id !== draft.id ||
        codexEndpointIdentity(latest) !== endpointIdentity
      ) {
        return;
      }

      setModels(result);
      setModelFetchIdentity(endpointIdentity);
      setModelFetchError(
        result.length
          ? null
          : "供应商没有返回可选模型，可保留手动填写的模型名称。",
      );
      setModelPickerOpen(result.length > 0);
      note(
        "获取模型",
        "success",
        `获取到 ${result.length} 个模型`,
        latest.name || "未命名供应商",
      );

      // An empty default model gets a suggestion (first fetched entry that is
      // not an embedding / rerank / speech / image model) but no probe: the
      // protocol is detected once the user has confirmed a model, on save.
      if (!latest.model.trim()) {
        const suggested = pickDefaultFetchedModel(result);
        if (suggested) {
          setEditor((currentEditor) =>
            currentEditor &&
            currentEditor.id === latest.id &&
            !currentEditor.model.trim()
              ? { ...currentEditor, model: suggested }
              : currentEditor,
          );
        }
        toast.success(`已获取 ${result.length} 个模型`, {
          description: suggested
            ? `已填入建议的默认模型 ${suggested}，保存时会自动识别协议。`
            : "请选择默认模型，保存时会自动识别协议。",
        });
        return;
      }

      toast.success(`已获取 ${result.length} 个模型`, {
        description:
          "模型列表不代表模型可用性；自动模式将在保存时尝试识别协议。",
      });
    } catch (error) {
      if (fetchSeq !== fetchModelsSeqRef.current) return;
      note("获取模型", "error", String(error), draft.name || "未命名供应商");
      toast.error("获取模型失败，可手动输入模型名称", {
        description: String(error),
      });
      setModels([]);
      setModelFetchIdentity(endpointIdentity);
      setApiFormatDetection(null);
      setModelFetchError(
        "未能获取模型列表，请确认地址、密钥与供应商权限后重试。",
      );
    } finally {
      if (fetchSeq === fetchModelsSeqRef.current) setFetchingModels(false);
    }
  };
  void fetchModels;

  const checkRuntime = async (
    preferences?: RuntimeUpdatePreferences,
    options: { announce?: boolean } = {},
  ): Promise<ReleaseStatus | null> => {
    const checkSeq = ++runtimeCheckSeqRef.current;
    const announce = options.announce !== false;
    try {
      const result = await invoke<ReleaseStatus>("check_codex_runtime_update", {
        source: preferences?.source ?? null,
        installMode: preferences?.installMode ?? null,
      });
      // An installation-triggered refresh must not be overwritten by an older
      // manual/startup check that happened to finish later.
      if (checkSeq !== runtimeCheckSeqRef.current) return null;
      setRelease(result);
      note(
        "检查 Codex 更新",
        "success",
        result.updateAvailable
          ? `发现 ${result.latestVersion}`
          : "已是最新版本",
      );
      if (announce) {
        toast.success(
          result.updateAvailable ? "发现新版本" : "Codex 已是最新版本",
        );
      }
      return result;
    } catch (error) {
      if (checkSeq !== runtimeCheckSeqRef.current) return null;
      if (announce) {
        toast.error("检查更新失败", { description: String(error) });
      }
      return null;
    }
  };

  // "启动时检查 Codex 更新" is a real switch: one silent check after the
  // first load, skipped entirely when the user turned it off.
  useEffect(() => {
    if (!runningInTauri || loading || startupRuntimeCheckRef.current) return;
    startupRuntimeCheckRef.current = true;
    void settingsApi
      .get()
      .then((settings) => {
        if (settings.checkCodexUpdatesOnStart === false) return;
        void checkRuntime(undefined, { announce: false });
      })
      .catch(() => {
        // Startup checks are optional and must never block the main window.
      });
  }, [loading]);

  // The update page always shows the current install, not the snapshot taken
  // when the window opened.
  useEffect(() => {
    if (view !== "runtime") return;
    void loadRuntime();
  }, [view]);

  const refreshRuntimeAfterInstall = async (
    preferences?: RuntimeUpdatePreferences,
  ) => {
    // Do not leave the just-consumed update offer visible while the two
    // authoritative backend queries refresh runtime and release state.
    setRelease(null);
    const [, refreshedRelease] = await Promise.all([
      loadRuntime(),
      checkRuntime(preferences, { announce: false }),
    ]);
    if (!refreshedRelease) {
      toast.warning("Codex 已安装，但更新状态刷新失败", {
        description: "可稍后重新检查；已安装的版本不受影响。",
      });
    }
  };

  const diagnose = async () => {
    setDiagnosing(true);
    try {
      const result = await invoke<Diagnostic[]>("diagnose_codex_runtime");
      setDiagnostics(result);
      note("运行诊断", "success", `${result.length} 项`);
    } catch (error) {
      note("运行诊断", "error", String(error));
      toast.error("诊断失败", { description: String(error) });
    } finally {
      setDiagnosing(false);
    }
  };
  void diagnose;

  const runRuntimeAction = async () => {
    if (!pendingAction) return;
    const { action, preferences } = pendingAction;
    const started = performance.now();
    // Close the confirmation immediately. Keeping it mounted allows a second
    // click to enter the backend lock and produces a misleading duplicate-app
    // error while the first operation is still running.
    setPendingAction(null);
    setRuntimeOperation({
      action,
      stage:
        action === "update" || action === "repair"
          ? "downloading"
          : "preparing",
    });
    setDownloadProgress(
      action === "update" || action === "repair"
        ? {
            downloaded: 0,
            total: release?.sizeBytes ?? 0,
            stage: "downloading",
          }
        : null,
    );
    try {
      if (action === "update") {
        await invoke("apply_codex_runtime_update", {
          expectedVersion: release?.latestVersion ?? null,
          source: preferences?.source ?? null,
          installMode: preferences?.installMode ?? null,
          confirm: true,
        });
      } else if (action === "repair") {
        await invoke("repair_codex_runtime", {
          source: null,
          installMode: null,
          confirm: true,
        });
      } else if (action === "rollback") {
        await invoke("rollback_codex_runtime", { confirm: true });
      } else {
        await invoke("uninstall_codex_runtime", { confirm: true });
      }
      note(
        `Codex ${action === "update" ? "更新" : action === "repair" ? "修复" : action === "rollback" ? "回滚" : "卸载"}`,
        "success",
        undefined,
        "Codex",
        performance.now() - started,
      );
      toast.success("操作已完成");
      if (action === "update" || action === "repair") {
        await refreshRuntimeAfterInstall(preferences);
      } else {
        runtimeCheckSeqRef.current += 1;
        setRelease(null);
        await loadRuntime();
      }
    } catch (error) {
      note(
        `Codex ${action}`,
        "error",
        String(error),
        "Codex",
        performance.now() - started,
      );
      toast.error("操作失败", { description: String(error) });
    } finally {
      setRuntimeOperation(null);
      setDownloadProgress(null);
    }
  };

  // A failed read leaves the list empty too, so without this guard a database
  // or permission error is indistinguishable from a fresh install and the user
  // gets an onboarding screen with no way back.
  if (
    runningInTauri &&
    !loading &&
    !loadError &&
    !providers.length &&
    !editor &&
    !onboardingDeferred
  ) {
    return (
      <StandaloneOnboarding
        onAdd={() => openEditor(providerDraft(null, "默认线路"))}
        onSkip={() => setOnboardingDeferred(true)}
      />
    );
  }

  return (
    <div className="chimera-shell">
      {/* 216px Sidebar (Frame 01 HdG9j; full visual acceptance pending) */}
      {!editor && (
        <aside
          data-pencil-name="侧栏"
          className="box-border w-[216px] shrink-0 h-full flex flex-col gap-[2px] p-[0px_8px_12px_8px] justify-start items-start bg-[#13181C] select-none z-10"
        >
          {/* 字标区 */}
          <div
            data-pencil-name="字标区"
            className="box-border w-full h-[40px] shrink-0 flex flex-row gap-0 p-[0px_8px] justify-start items-center"
            data-tauri-drag-region
          >
            {isMac() && <WindowControls closeDisabled={Boolean(editor)} />}
            <div
              data-pencil-name="字标"
              className="text-[14px]/[20px] box-border text-[#EEF0F3] font-bold text-left whitespace-nowrap"
            >
              Chimera++
            </div>
          </div>

          <nav className="chimera-navigation" aria-label="工具与功能">
            {/* 干线 (Codex 主干轨道) */}
            <div
              data-pencil-name="干线"
              className="box-border w-full h-fit shrink-0 flex flex-col gap-0 justify-start items-start"
            >
              {/* 宿主行 · Codex */}
              <div
                data-pencil-name="工具 · Codex"
                className="box-border w-full h-[36px] shrink-0 flex flex-row gap-[10px] p-[0px_8px_0px_10px] justify-start items-center rounded-[4px] relative"
              >
                <div
                  data-pencil-name="徽标"
                  className="box-border w-[24px] shrink-0 h-[24px] flex flex-row gap-0 justify-center items-center bg-transparent border border-[#8D9398] rounded-[4px] relative z-10"
                >
                  <div
                    data-pencil-name="简称"
                    className="text-[12px]/[17px] box-border text-[#BABEC3] font-bold text-left whitespace-nowrap"
                  >
                    Cx
                  </div>
                </div>
                <div
                  data-pencil-name="名称"
                  className="text-[14px]/[20px] box-border flex-1 text-[#EEF0F3] font-normal text-left relative z-10"
                >
                  Codex
                </div>
                <div
                  data-pencil-name="尾部"
                  className="box-border w-fit shrink-0 h-fit flex flex-row gap-[4px] justify-start items-center relative z-10"
                >
                  <div
                    data-pencil-name="当前线路"
                    className="box-border w-[20px] shrink-0 h-[20px] flex flex-row gap-0 justify-center items-center overflow-hidden rounded-[4px]"
                    title={activeProvider?.name ?? "未选择线路"}
                    style={{
                      backgroundColor:
                        activeProvider?.category === "official"
                          ? "#1A1E24"
                          : activeProvider?.iconColor || "#7B9BC3",
                      border:
                        activeProvider?.category === "official"
                          ? "1px solid #6F757B"
                          : "none",
                    }}
                  >
                    <div
                      data-pencil-name="简称"
                      className="text-[12px]/[17px] box-border font-bold text-left whitespace-nowrap"
                      style={{
                        color:
                          activeProvider?.category === "official"
                            ? "#EEF0F3"
                            : "#12161C",
                      }}
                    >
                      {activeProvider
                        ? activeProvider.category === "official"
                          ? "官"
                          : activeProvider.name.includes("DeepSeek")
                            ? "DS"
                            : /[\u3400-\u9fff]/.test(
                                  activeProvider.name[0] ?? "",
                                )
                              ? activeProvider.name[0]
                              : activeProvider.name.slice(0, 2).toUpperCase()
                        : "—"}
                    </div>
                  </div>
                </div>
                {/* 干线起点向下的引线 */}
                <div
                  data-pencil-name="干线起点"
                  className="box-border w-[2px] h-[6px] absolute left-[21px] top-[30px] bg-[#7B9BC3] z-0"
                />
              </div>

              {/* 8 个站点能力项 */}
              {[
                { id: "providers", label: "线路" },
                { id: "official-accounts", label: "官方账号" },
                { id: "prompts", label: "提示词" },
                { id: "skills-mcp", label: "Skills 与 MCP" },
                { id: "usage", label: "用量" },
                { id: "runtime", label: "Codex 管理" },
                { id: "appearance", label: "外观" },
                { id: "health", label: "配置体检" },
              ].map((item, index, arr) => {
                const available = canNavigate(item.id);
                const active = view === item.id;
                const isLast = index === arr.length - 1;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setView(item.id as View)}
                    disabled={!available}
                    title={
                      available
                        ? undefined
                        : `${item.label}：当前产品策略尚未开放`
                    }
                    data-pencil-name={`能力 · ${item.label}`}
                    className={`box-border w-full h-[32px] shrink-0 flex flex-row gap-[16px] p-[0px_8px_0px_16px] justify-start items-center rounded-[4px] cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 border-0 transition-colors text-left ${
                      active
                        ? "bg-[#23282D]"
                        : "bg-transparent hover:bg-[#1A1E24]"
                    }`}
                  >
                    {/* 站点轴线 */}
                    <div
                      data-pencil-name="站"
                      className="box-border w-[12px] shrink-0 h-fit flex flex-col gap-0 justify-start items-center"
                    >
                      <div
                        data-pencil-name="上"
                        className="box-border w-[2px] h-[12px] shrink-0 bg-[#7B9BC3]"
                      />
                      <div
                        data-pencil-name="点"
                        className={`box-border w-[8px] h-[8px] shrink-0 border-2 border-[#7B9BC3] rounded-full ${
                          active ? "bg-[#7B9BC3]" : "bg-[#13181C]"
                        }`}
                      />
                      <div
                        data-pencil-name="下"
                        className={`box-border w-[2px] h-[12px] shrink-0 bg-[#7B9BC3] ${
                          isLast ? "opacity-0" : ""
                        }`}
                      />
                    </div>
                    {/* 文字 */}
                    <div
                      data-pencil-name="文字"
                      className={`text-[14px]/[20px] box-border flex-1 text-left ${
                        active
                          ? "text-[#EEF0F3] font-bold"
                          : "text-[#BABEC3] font-normal"
                      }`}
                    >
                      {item.label}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="w-full h-[40px] shrink-0 px-[10px] pt-[16px] pb-[6px] text-[13px]/[18px] text-[#8D9398]">
              其他工具
            </div>
            {(
              [
                ["tool-claude", "Claude Code", "CC"],
                ["tool-claude-desktop", "Claude Desktop", "CD"],
                ["tool-gemini", "Gemini CLI", "Gm"],
                ["tool-opencode", "OpenCode", "OC"],
                ["tool-pi", "Pi", "Pi"],
                ["tool-omp", "oh-my-pi", "OMP"],
                ["tool-grokbuild", "Grok Build", "Gk"],
              ] as const
            )
              .filter(
                ([id]) =>
                  !runningInTauri ||
                  isProductToolVisible(id, toolSettings?.visibleApps),
              )
              .map(([id, label, badge]) => (
                <button
                  key={id}
                  type="button"
                  disabled={!canNavigate(id)}
                  title={
                    canNavigate(id)
                      ? undefined
                      : `${label}：当前产品策略尚未开放`
                  }
                  onClick={() => setView(id)}
                  aria-label={label}
                  data-pencil-name={`工具 · ${label}`}
                  className={`w-full h-[36px] shrink-0 flex gap-[10px] items-center px-[10px] rounded-[4px] border-0 text-left disabled:cursor-not-allowed disabled:opacity-50 ${view === id ? "bg-[#23282D] text-[#EEF0F3]" : "bg-transparent text-[#BABEC3] enabled:hover:bg-[#1A1E24]"}`}
                >
                  <span className="w-[24px] h-[24px] shrink-0 flex items-center justify-center border border-[#8D9398] rounded-[4px] text-[12px] font-bold">
                    {badge}
                  </span>
                  <span className="flex-1 text-[14px]">{label}</span>
                  {!canNavigate(id) && (
                    <span aria-hidden="true" className="text-[11px]">
                      未开放
                    </span>
                  )}
                </button>
              ))}
            <button
              type="button"
              onClick={() => {
                setView("tool-settings");
              }}
              title="管理工具显示偏好"
              disabled={!canNavigate("tool-settings")}
              data-pencil-name="添加工具"
              className="w-full h-[36px] shrink-0 flex gap-[10px] items-center px-[10px] rounded-[4px] bg-transparent border-0 text-left text-[#BABEC3] cursor-pointer hover:bg-[#1A1E24]"
            >
              <span className="w-[24px] h-[24px] flex items-center justify-center border border-[#8D9398] rounded-[4px]">
                <Plus size={14} />
              </span>
              <span className="text-[14px]">管理工具</span>
            </button>
          </nav>

          {/* 分隔线 */}
          <div
            data-pencil-name="分隔"
            className="box-border w-full h-[1px] shrink-0 bg-[#23282D] my-1"
          />

          {/* 会话 */}
          <button
            type="button"
            onClick={() => setView("sessions")}
            data-pencil-name="会话"
            className={`box-border w-full h-[32px] shrink-0 flex flex-row gap-[12px] p-[0px_8px_0px_12px] justify-start items-center rounded-[4px] cursor-pointer border-0 transition-colors text-left ${
              view === "sessions"
                ? "bg-[#23282D]"
                : "bg-transparent hover:bg-[#1A1E24]"
            }`}
          >
            <MessagesSquare
              size={16}
              className={
                view === "sessions" ? "text-[#EEF0F3]" : "text-[#BABEC3]"
              }
            />
            <div
              data-pencil-name="文字"
              className={`text-[14px]/[20px] box-border flex-1 text-left ${
                view === "sessions"
                  ? "text-[#EEF0F3] font-bold"
                  : "text-[#BABEC3] font-normal"
              }`}
            >
              会话
            </div>
          </button>

          {/* 设置 */}
          <button
            type="button"
            onClick={() => setView("settings")}
            data-pencil-name="设置"
            className={`box-border w-full h-[32px] shrink-0 flex flex-row gap-[12px] p-[0px_8px_0px_12px] justify-start items-center rounded-[4px] cursor-pointer border-0 transition-colors text-left ${
              view === "settings"
                ? "bg-[#23282D]"
                : "bg-transparent hover:bg-[#1A1E24]"
            }`}
          >
            <Settings2
              size={16}
              className={
                view === "settings" ? "text-[#EEF0F3]" : "text-[#BABEC3]"
              }
            />
            <div
              data-pencil-name="文字"
              className={`text-[14px]/[20px] box-border flex-1 text-left ${
                view === "settings"
                  ? "text-[#EEF0F3] font-bold"
                  : "text-[#BABEC3] font-normal"
              }`}
            >
              设置
            </div>
          </button>
        </aside>
      )}

      <main
        className={`chimera-main${view === "usage" ? " is-usage-view" : ""}${editor ? " is-editing-provider" : ""}`}
      >
        {/* Pencil wnYKj: fixed search and window controls, flexible left drag area. */}
        <header
          data-pencil-name="标题栏"
          className="box-border w-full h-[40px] shrink-0 flex flex-row gap-0 justify-start items-center bg-[#FDFDFE] dark:bg-[#1A1E24] border-b border-[#DDE0E3] dark:border-[#31363D] select-none z-10"
          onMouseDown={handleTitlebarMouseDown}
          onDoubleClick={preventTitlebarDoubleClick}
        >
          {/* 左侧站牌与拖拽区 (Frame 01 1:1) */}
          <div
            data-pencil-name="左"
            className="box-border flex-1 min-w-0 h-[40px] flex flex-row p-[0px_12px] justify-start items-center gap-2"
            data-tauri-drag-region
          >
            {isMac() && editor && (
              <WindowControls closeDisabled={Boolean(editor)} />
            )}
            {!runningInTauri && (
              <span
                className="text-[12px] text-[#646970] dark:text-[#8D9398] truncate"
                title={
                  designPreview
                    ? "设计示例 · 非本机数据 · 写入及测速已禁用"
                    : "浏览器预览 · 未连接本机，不读取或修改本机配置"
                }
              >
                {designPreview
                  ? "设计示例 · 非本机数据 · 写入及测速已禁用"
                  : "浏览器预览 · 未连接本机"}
              </span>
            )}
          </div>

          {/* 搜索入口随窗口宽度收缩，始终保留窗口控制。 */}
          <button
            type="button"
            aria-label="搜索线路、页面或命令"
            data-pencil-name="搜索"
            onClick={() => setCmdPaletteOpen(true)}
            className="box-border w-[360px] max-w-[42%] min-w-0 shrink h-[28px] flex flex-row gap-[8px] px-2.5 justify-start items-center bg-[#F2F4F6] dark:bg-[#23282D] rounded-[4px] border-0 cursor-pointer hover:bg-[var(--bg-selected)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)] transition"
            data-tauri-no-drag
          >
            <Search size={14} className="text-[#646970] dark:text-[#8D9398]" />
            <span
              data-pencil-name="占位"
              className="text-[13px]/[18px] box-border flex-1 text-[#646970] dark:text-[#8D9398] font-normal text-left truncate"
            >
              搜索线路、页面或命令
            </span>
            <div
              data-pencil-name="键帽"
              className="box-border w-fit shrink-0 h-[20px] flex flex-row gap-0 px-1.5 justify-start items-center bg-[#FDFDFE] dark:bg-[#1A1E24] border border-[#DDE0E3] dark:border-[#31363D] rounded-[4px]"
            >
              <span
                data-pencil-name="值"
                className="text-[12px]/[17px] box-border text-[#646970] dark:text-[#8D9398] font-mono whitespace-nowrap"
              >
                {isMac() ? "⌘ K" : "Ctrl K"}
              </span>
            </div>
          </button>

          {/* 右侧窗口控制三键 */}
          <div
            data-pencil-name="右"
            className="box-border shrink-0 h-[40px] flex flex-row justify-end items-center"
          >
            <div className="flex items-center" data-tauri-no-drag>
              <button
                type="button"
                aria-label="检查更新"
                onClick={() => void runTitlebarUpdateCheck()}
                className="sr-only"
              >
                检查更新
              </button>
              {titlebarHasUpdate && (
                <button
                  type="button"
                  onClick={() => void runTitlebarUpdateCheck()}
                  title={`发现新版本 ${titlebarUpdateInfo?.availableVersion ?? ""}，点击更新`}
                  className="h-[26px] px-2 mr-2 flex items-center gap-1.5 rounded text-[12px] font-medium bg-[#006AA0] text-white hover:bg-[#005a88] transition cursor-pointer border-0"
                >
                  <Download size={13} />
                  <span>更新</span>
                </button>
              )}
              {!isMac() && <WindowControls closeDisabled={Boolean(editor)} />}
            </div>
          </div>
        </header>

        {view === "providers" && (
          <h1 className="sr-only">
            {editor
              ? editor.original
                ? "编辑线路"
                : "添加线路"
              : viewLabels[view]}
          </h1>
        )}
        <section
          ref={contentRef}
          tabIndex={-1}
          hidden={Boolean(editor)}
          className={`chimera-content${view === "providers" ? " is-provider-view" : ""}`}
        >
          {view === "providers" && loadError && (
            <section className="route-load-error" role="alert">
              <CircleAlert size={26} />
              <h2>无法读取线路列表</h2>
              <p>{loadError}</p>
              <div>
                <button
                  className="primary"
                  onClick={() => void retryLoadProviders()}
                  disabled={loading}
                  data-autofocus
                >
                  {loading ? (
                    <>
                      <LoaderCircle className="spin" size={15} /> 正在重试…
                    </>
                  ) : (
                    <>
                      <RefreshCw size={15} /> 重试
                    </>
                  )}
                </button>
              </div>
            </section>
          )}
          {view === "providers" && !loadError && (
            <NewProvidersView
              providers={providers}
              currentId={currentId}
              currentSource={currentSource}
              connection={connection}
              loading={loading}
              codexProcess={codexProcess}
              rendererUnlock={rendererUnlock}
              launchingCodex={launchingCodex}
              restartRequired={codexRestartRequired}
              onOpenCodex={openCodex}
              onSwitch={switchProvider}
              onEdit={(provider) => openEditor(providerDraft(provider))}
              onDelete={(provider) => {
                setEditorAppId("codex");
                setPendingProviderDelete(provider);
              }}
              deletingProviderId={deletingProviderId}
              onAdd={() =>
                openEditor(
                  providerDraft(null, providers.length ? "新线路" : "默认线路"),
                )
              }
              onTestSpeed={testConnection}
            />
          )}
          {view === "runtime" && (
            <NewRuntimeView
              runtime={runtime}
              release={release}
              progress={downloadProgress}
              operation={runtimeOperation}
              onCheck={checkRuntime}
              onDiagnose={diagnose}
              diagnosing={diagnosing}
              onAction={(action, preferences) =>
                setPendingAction({ action, preferences })
              }
              onRuntimeChanged={refreshRuntimeAfterInstall}
              onOperationFinished={() => setDownloadProgress(null)}
            />
          )}
          <Suspense
            fallback={
              <div className="route-loading" role="status">
                正在加载模块…
              </div>
            }
          >
            {view === "usage" && <UsageView />}
            {view === "appearance" && (
              <AppearanceView
                enabled={skinEnabled}
                onRequestSkinAction={setPendingSkinAction}
              />
            )}
            {view === "sessions" && (
              <div className="chimera-sessions-host">
                <SessionManagerPage
                  appId={multiToolEnabled ? "all" : "codex"}
                />
              </div>
            )}
            {view === "official-accounts" && (
              <OfficialAccountsView
                onAccountSwitched={() => void loadProviders()}
              />
            )}
            {view === "prompts" && (
              <PromptsView refreshVersion={providerRefreshVersion} />
            )}
            {view === "skills-mcp" && (
              <SkillsMcpView
                initialApp={skillsAppId}
                refreshVersion={providerRefreshVersion}
              />
            )}
            {view === "health" && <ConfigHealthView />}
            {view === "settings" && (
              <NewSettingsView
                onImported={() => void loadProviders()}
                liveBackupsEnabled={hasEnabledCapability(
                  capabilities,
                  "live_backups",
                )}
              />
            )}
            {view === "tool-settings" && (
              <ToolVisibilityView native={runningInTauri} />
            )}
            {view === "tool-claude-desktop" && (
              <ToolView
                toolId="claude-desktop"
                native={runningInTauri}
                refreshVersion={providerRefreshVersion}
              />
            )}
            {view === "tool-grokbuild" && (
              <ToolView
                toolId="grokbuild"
                onManageResources={manageToolResources}
                native={runningInTauri}
                refreshVersion={providerRefreshVersion}
              />
            )}

            {view === "tool-claude" && (
              <ToolView
                refreshVersion={providerRefreshVersion}
                toolId="claude-code"
                onEditLine={openToolEditor}
                native={runningInTauri}
                onManageResources={manageToolResources}
              />
            )}
            {view === "tool-gemini" && (
              <ToolView
                refreshVersion={providerRefreshVersion}
                toolId="gemini-cli"
                onEditLine={openToolEditor}
                native={runningInTauri}
                onManageResources={manageToolResources}
              />
            )}
            {view === "tool-opencode" && (
              <ToolView
                refreshVersion={providerRefreshVersion}
                toolId="opencode"
                onEditLine={openToolEditor}
                native={runningInTauri}
                onManageResources={manageToolResources}
              />
            )}
          </Suspense>
          <RetainedToolPage active={view === "tool-omp"}>
            <OmpView native={runningInTauri} />
          </RetainedToolPage>
          <RetainedToolPage active={view === "tool-pi"}>
            <ToolView
              refreshVersion={providerRefreshVersion}
              toolId="pi"
              onEditLine={openToolEditor}
              native={runningInTauri}
            />
          </RetainedToolPage>
        </section>
        {editor && (
          <div className="provider-editor-page">
            <ProviderEditor
              appId={editorAppId}
              editor={editor}
              setEditor={(value) => {
                if (!savingProvider) setEditor(value);
              }}
              showKey={showKey}
              setShowKey={setShowKey}
              fetchingModels={fetchingModels}
              savingProvider={savingProvider}
              dirty={
                isEditorDraftDirty(editor, editorBaselineRef.current) ||
                commonConfigDirty
              }
              saveError={editorSaveError}
              modelFetchError={modelFetchError}
              apiFormatDetection={apiFormatDetection}
              apiFormatDetectionError={apiFormatDetectionError}
              commonConfigSnippet={commonConfigSnippet}
              commonConfigLoading={commonConfigLoading}
              commonConfigLoaded={commonConfigLoaded}
              onCommonConfigChange={(value) => {
                if (savingProvider) return;
                setCommonConfigSnippet(value);
                setCommonConfigDirty(value !== commonConfigBaselineRef.current);
              }}
              onFetchModels={fetchModels}
              connection={draftConnection}
              onTest={() =>
                void testConnection(
                  editor.baseUrl,
                  editor.name || "Codex",
                  "draft",
                )
              }
              // Keep React's click event out of saveProvider's optional
              // protocol-override argument. Passing saveProvider directly
              // makes the MouseEvent become apiFormat and breaks IPC JSON
              // serialization through its circular DOM/React references.
              onSave={() => void saveProvider()}
              onDelete={() => {
                if (editor.original) setPendingProviderDelete(editor.original);
              }}
              onRequestClose={requestCloseEditor}
              context1mEnabled={hasEnabledCapability(
                capabilities,
                "context_1m",
              )}
              escapeDisabled={
                Boolean(pendingProviderDelete) ||
                savingProvider ||
                pendingEditorDiscard ||
                modelPickerOpen
              }
            />
          </div>
        )}
      </main>
      <CommandPalette
        isOpen={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        providers={providers}
        currentProviderId={currentId}
        onSwitchProvider={(id) => void switchProvider(id)}
        canNavigate={canNavigate}
        onNavigate={(targetView) => setView(targetView as View)}
        onAddProvider={() => {
          if (editor) {
            toast.info("请先保存或关闭当前正在编辑的线路");
            return;
          }
          openEditor(
            providerDraft(null, providers.length ? "新线路" : "默认线路"),
          );
        }}
        onSpeedTestAll={async () => {
          toast.info("正在对所有线路进行测速…");
          for (const p of providers) {
            const configStr = String(p.settingsConfig?.config ?? "");
            const endpoint =
              extractCodexBaseUrl(configStr) ||
              (p.category === "official" || p.id === "codex-official"
                ? "https://api.openai.com/v1"
                : "http://127.0.0.1:4000");
            await testConnection(endpoint, p.name);
          }
        }}
        onCheckHealth={() => setView("health")}
        onOpenCodex={openCodex}
        onRefresh={loadProviders}
        onEditProvider={(id) => {
          if (editor) {
            toast.info("请先保存或关闭当前正在编辑的线路");
            return;
          }
          const provider = providers.find((item) => item.id === id);
          if (provider) openEditor(providerDraft(provider));
        }}
      />
      {editor && models && modelPickerOpen && (
        <ModelPickerDialog
          models={models}
          selected={editor.model}
          onPick={(model) => {
            setEditor({ ...editor, model });
            setModelPickerOpen(false);
          }}
          onClose={() => setModelPickerOpen(false)}
        />
      )}
      {pendingEditorDiscard && (
        <ConfirmDiscardEditor
          onCancel={() => setPendingEditorDiscard(false)}
          onConfirm={closeEditor}
        />
      )}
      {pendingProviderDelete && (
        <ConfirmProviderDelete
          provider={pendingProviderDelete}
          onCancel={() => setPendingProviderDelete(null)}
          onConfirm={async () => {
            if (await deleteProvider(pendingProviderDelete, editorAppId)) {
              setPendingProviderDelete(null);
              closeEditor();
            }
          }}
        />
      )}
      {pendingModelReload && (
        <ConfirmModelReload
          model={pendingModelReload}
          onCancel={() => {
            setPendingModelReload(null);
            toast.info("请稍后彻底退出并重新打开 Codex");
          }}
          onConfirm={async () => {
            try {
              const result = await invoke<CodexLaunchResult>(
                "restart_codex_for_model_catalog",
                { confirm: true },
              );
              await loadCodexProcess();
              await refreshRendererUnlock();
              setPendingModelReload(null);
              setCodexRestartRequired(false);
              toast.success("Codex 已重新加载模型列表");
              if (result.modelUnlockError) {
                toast.warning("模型目录已保存；桌面端模型选择器增强未连接", {
                  description: result.modelUnlockError,
                });
              }
            } catch (error) {
              toast.error("无法自动重启 Codex", {
                description: `${String(error)}。请彻底退出并重新打开 Codex。`,
              });
            }
          }}
        />
      )}
      {pendingSkinAction && (
        <ConfirmSkinOperation
          label={pendingSkinAction.label}
          onCancel={() => setPendingSkinAction(null)}
          onConfirm={() => {
            const action = pendingSkinAction;
            setPendingSkinAction(null);
            action.execute();
          }}
        />
      )}
      {pendingAction && (
        <ConfirmOperation
          action={pendingAction.action}
          onCancel={() => setPendingAction(null)}
          onConfirm={runRuntimeAction}
        />
      )}
      {diagnostics && (
        <DiagnosticsDialog
          diagnostics={diagnostics}
          onClose={() => setDiagnostics(null)}
        />
      )}
    </div>
  );
}

// Writes survive navigation; remounted views must wait before reading preferences.
let runtimePreferenceSaveQueue = Promise.resolve();

export function NewRuntimeView({
  runtime,
  release,
  progress,
  operation,
  onCheck,
  onDiagnose,
  diagnosing,
  onAction,
  onRuntimeChanged,
  onOperationFinished,
}: {
  runtime: RuntimeStatus | null;
  release: ReleaseStatus | null;
  progress: DownloadProgress | null;
  operation: RuntimeOperation | null;
  onCheck: (preferences?: RuntimeUpdatePreferences) => void;
  onDiagnose: () => void;
  diagnosing: boolean;
  onAction: (
    value: RuntimeAction,
    preferences?: RuntimeUpdatePreferences,
  ) => void;
  onOperationFinished?: () => void;
  onRuntimeChanged?: (
    preferences?: RuntimeUpdatePreferences,
  ) => void | Promise<void>;
}) {
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [preferences, setPreferences] = useState<Pick<
    Settings,
    "codexInstallMode" | "codexUpdateSource" | "checkCodexUpdatesOnStart"
  > | null>(runningInTauri ? null : {});
  const [preferencesError, setPreferencesError] = useState(false);
  const [preferencesRetry, setPreferencesRetry] = useState(0);
  const [pendingPreferenceKeys, setPendingPreferenceKeys] = useState<
    Set<string>
  >(new Set());
  const preferencesMounted = useRef(false);
  useEffect(() => {
    preferencesMounted.current = true;
    return () => {
      preferencesMounted.current = false;
    };
  }, []);
  const installMode = preferences?.codexInstallMode ?? "standard";
  const updateSource = preferences?.codexUpdateSource ?? "auto";
  const preferencesBusy = !preferences || pendingPreferenceKeys.size > 0;

  useEffect(() => {
    if (!runningInTauri) return;
    let cancelled = false;
    setPreferencesError(false);
    void runtimePreferenceSaveQueue
      .then(() => settingsApi.get())
      .then(
        (saved) => {
          if (!cancelled) setPreferences(saved);
        },
        (reason) => {
          if (cancelled) return;
          setPreferencesError(true);
          toast.error("读取更新偏好失败", { description: String(reason) });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [preferencesRetry]);
  // v2.5.0 M3：历史版本 / 离线导入 / 安装事务恢复
  const [recovery, setRecovery] = useState<CodexInstallRecoveryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyReleases, setHistoryReleases] = useState<
    CodexRuntimeReleaseItem[]
  >([]);
  const [pendingPlan, setPendingPlan] =
    useState<CodexRuntimeReleasePlan | null>(null);
  const [planningTag, setPlanningTag] = useState<string | null>(null);
  const [installingHistory, setInstallingHistory] = useState(false);
  const [offlineInspection, setOfflineInspection] = useState<
    (CodexOfflineInspection & { filePath: string }) | null
  >(null);
  const [inspectingOffline, setInspectingOffline] = useState(false);
  const [installingOffline, setInstallingOffline] = useState(false);
  useLightweightCloseBlocker(
    preferencesBusy ||
      installingHistory ||
      installingOffline ||
      inspectingOffline ||
      Boolean(planningTag),
  );

  const maintenanceDialogRef = useDialogFocus<HTMLElement>(
    () => setMaintenanceOpen(false),
    maintenanceOpen,
  );
  const historyDialogRef = useDialogFocus<HTMLElement>(
    () => setHistoryOpen(false),
    historyOpen,
  );
  const offlineDialogRef = useDialogFocus<HTMLElement>(
    () => setOfflineInspection(null),
    Boolean(offlineInspection),
  );

  const loadRecovery = useCallback(async () => {
    if (!runningInTauri) return;
    try {
      const entries = await invoke<CodexInstallRecoveryEntry[]>(
        "get_codex_install_recovery",
      );
      setRecovery(entries);
    } catch {
      // 恢复记录是提示性信息，读取失败不打扰用户
    }
  }, []);

  useEffect(() => {
    void loadRecovery();
  }, [loadRecovery]);

  const acknowledgeRecovery = async (id: string) => {
    try {
      await invoke("acknowledge_codex_install_recovery", { id });
      await loadRecovery();
    } catch (reason) {
      toast.error("更新恢复记录失败", { description: String(reason) });
    }
  };

  const loadHistoryReleases = useCallback(async (page: number) => {
    setHistoryLoading(true);
    try {
      const items = await invoke<CodexRuntimeReleaseItem[]>(
        "list_codex_runtime_releases",
        { page },
      );
      setHistoryReleases(items);
      setHistoryPage(page);
    } catch (reason) {
      toast.error("获取历史版本失败", { description: String(reason) });
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const openHistory = () => {
    setMaintenanceOpen(false);
    setHistoryOpen(true);
    setPendingPlan(null);
    if (!historyReleases.length) void loadHistoryReleases(1);
  };

  const planHistoryRelease = async (tag: string) => {
    setPlanningTag(tag);
    try {
      const plan = await invoke<CodexRuntimeReleasePlan>(
        "plan_codex_runtime_release",
        { tag },
      );
      setPendingPlan(plan);
    } catch (reason) {
      toast.error("解析该版本失败", { description: String(reason) });
    } finally {
      setPlanningTag(null);
    }
  };

  const installHistoryRelease = async () => {
    if (!pendingPlan || preferencesBusy) return;
    setInstallingHistory(true);
    try {
      // 确认对象原样传回：版本、资产、SHA-256 与下载地址全部锁定，
      // 目录刷新不会改变本次安装的目标。
      await invoke("install_codex_runtime_release", {
        plan: pendingPlan,
        installMode,
        confirm: true,
      });
      toast.success(`Codex ${pendingPlan.version} 安装完成`);
      setPendingPlan(null);
      setHistoryOpen(false);
      await onRuntimeChanged?.({ source: updateSource, installMode });
      await loadRecovery();
    } catch (reason) {
      toast.error("安装所选版本失败", { description: String(reason) });
    } finally {
      setInstallingHistory(false);
      onOperationFinished?.();
    }
  };

  const pickOfflinePackage = async () => {
    setMaintenanceOpen(false);
    let filePath: string | null = null;
    try {
      const selected = await openNativeFileDialog({
        multiple: false,
        filters: [{ name: "Codex 安装包", extensions: ["msix", "Msix"] }],
      });
      filePath = typeof selected === "string" ? selected : null;
    } catch (reason) {
      toast.error("选择安装包失败", { description: String(reason) });
      return;
    }
    if (!filePath) return;
    setInspectingOffline(true);
    try {
      const inspection = await invoke<CodexOfflineInspection>(
        "inspect_codex_runtime_package",
        { filePath },
      );
      setOfflineInspection({ ...inspection, filePath });
    } catch (reason) {
      toast.error("检查离线安装包失败", { description: String(reason) });
    } finally {
      setInspectingOffline(false);
    }
  };

  const installOfflinePackage = async () => {
    if (!offlineInspection) return;
    setInstallingOffline(true);
    try {
      await invoke("install_codex_runtime_offline", {
        filePath: offlineInspection.filePath,
        expectedSha256: offlineInspection.sha256,
        confirm: true,
      });
      toast.success(`Codex ${offlineInspection.packageVersion} 离线安装完成`);
      setOfflineInspection(null);
      await onRuntimeChanged?.({ source: updateSource, installMode });
      await loadRecovery();
    } catch (reason) {
      toast.error("离线安装失败", { description: String(reason) });
    } finally {
      setInstallingOffline(false);
      onOperationFinished?.();
    }
  };
  const version = runtime?.version ?? "等待识别";
  const runtimeSupported = runtime?.supported !== false;
  const updateAvailable = release?.updateAvailable === true;
  const selectedInstallLabel = runtimeText(installMode);
  const updateActionLabel = updateAvailable
    ? `下载并安装 ${selectedInstallLabel}`
    : "检查更新";
  const percent = progress?.total
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : 0;
  const startAction = (
    action: RuntimeAction,
    preferences?: RuntimeUpdatePreferences,
  ) => {
    if (!runningInTauri || !runtimeSupported || preferencesBusy || operation)
      return;
    setMaintenanceOpen(false);
    onAction(action, preferences);
  };
  const selectedPreferences: RuntimeUpdatePreferences = {
    source: updateSource,
    installMode,
  };
  const checkSelectedRuntime = () => {
    if (runningInTauri && runtimeSupported && !preferencesBusy && !operation)
      onCheck(selectedPreferences);
  };
  const runDiagnostics = () => {
    setMaintenanceOpen(false);
    onDiagnose();
  };
  const operationLabel = progress
    ? progress.stage === "installing"
      ? "正在校验并安装，请勿关闭窗口"
      : progress.total > 0
        ? `正在下载 ${percent}%`
        : "正在下载，等待获取文件大小"
    : operation?.action === "uninstall"
      ? "正在卸载 Codex，请稍候"
      : operation?.action === "rollback"
        ? "正在恢复上一版本，请稍候"
        : operation
          ? "正在准备操作，请稍候"
          : null;
  const saveRuntimePreference = (
    patch: Partial<Pick<Settings, "codexInstallMode" | "codexUpdateSource">>,
  ) => {
    if (!preferences) return;
    if (!runningInTauri) {
      setPreferences((current) => current && { ...current, ...patch });
      return;
    }
    const keys = Object.keys(patch);
    setPendingPreferenceKeys((current) => new Set([...current, ...keys]));
    // Patch only the selected fields; serialize replies so an older save cannot
    // overwrite a newer selection. Failed saves leave the confirmed values intact.
    runtimePreferenceSaveQueue = runtimePreferenceSaveQueue.then(async () => {
      try {
        const saved = await settingsApi.patchPreferences(patch);
        if (preferencesMounted.current) {
          setPreferences(saved);
          toast.success("更新偏好已保存");
        }
      } catch (reason) {
        toast.error("保存更新偏好失败", { description: String(reason) });
      } finally {
        if (preferencesMounted.current) {
          setPendingPreferenceKeys((current) => {
            const next = new Set(current);
            keys.forEach((key) => next.delete(key));
            return next;
          });
        }
      }
    });
  };
  const openInstallDirectory = async () => {
    if (!runningInTauri) return;
    try {
      await invoke("open_codex_runtime_directory");
    } catch (reason) {
      toast.error("无法打开安装目录", { description: String(reason) });
    }
  };
  return (
    <>
      <section className="runtime-reference-view" aria-label="Codex 管理">
        <header className="runtime-page-heading">
          <div>
            <h1>Codex 管理</h1>
            <p>Codex 的安装、升级、修复、回滚与卸载 · 只改动本机</p>
          </div>
          <button
            className="secondary"
            onClick={checkSelectedRuntime}
            disabled={
              !runningInTauri ||
              !runtimeSupported ||
              Boolean(operation) ||
              preferencesBusy
            }
          >
            <RefreshCw size={14} />
            {updateAvailable ? "重新检查" : "检查更新"}
          </button>
        </header>
        {operationLabel && (
          <section
            className="runtime-task-card"
            aria-label="当前安装任务"
            aria-busy="true"
          >
            <div className="runtime-task-heading">
              <span className="runtime-task-icon">
                <LoaderCircle size={28} aria-hidden="true" />
              </span>
              <div>
                <span className="runtime-task-eyebrow">CODEX · 正在处理</span>
                <h2 role="status">{operationLabel}</h2>
                <p>请保持 Chimera++ 运行。完成后会自动刷新本机安装状态。</p>
              </div>
              {progress?.stage !== "installing" &&
                progress &&
                progress.total > 0 && (
                  <strong>
                    {percent}
                    <small>%</small>
                  </strong>
                )}
            </div>
            <div className="runtime-reference-progress">
              <i
                role="progressbar"
                aria-label="安装进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  progress &&
                  progress.total > 0 &&
                  progress.stage !== "installing"
                    ? percent
                    : undefined
                }
                aria-valuetext={operationLabel}
              >
                <u
                  className={
                    !progress ||
                    !progress.total ||
                    progress.stage === "installing"
                      ? "is-indeterminate"
                      : ""
                  }
                  style={{
                    width:
                      progress && progress.total > 0 ? `${percent}%` : "38%",
                  }}
                />
              </i>
            </div>
            <div className="runtime-task-detail">
              <span>
                {progress && progress.stage !== "installing"
                  ? `${(progress.downloaded / 1024 / 1024).toFixed(1)} MB${progress.total > 0 ? ` / ${(progress.total / 1024 / 1024).toFixed(1)} MB` : " 已接收"}`
                  : "本机操作进行中，请勿关闭窗口"}
              </span>
              <span>
                {progress?.stage === "installing"
                  ? "下载完成 · 校验并安装"
                  : "完成后自动检查"}
              </span>
            </div>
          </section>
        )}
        <div className="runtime-status-board">
          <div className="runtime-installed">
            <h2>
              {!runningInTauri
                ? "浏览器预览 · 未检测本机"
                : runtimeSupported
                  ? !runtime
                    ? "正在识别本机 Codex"
                    : runtime.installed
                      ? "已安装"
                      : "尚未安装 Codex"
                  : "Codex 更新管理仅支持 Windows"}
            </h2>
            <code>
              {!runningInTauri ? "未检测" : runtime?.installed ? version : "—"}
            </code>
            <small>
              {!runningInTauri
                ? "请在桌面应用中查看安装状态"
                : runtime?.installed
                  ? runtimeText(runtime.installMode)
                  : "安装状态以本机检测为准"}
            </small>
          </div>
          <div className="runtime-info-strip">
            <div>
              <FolderOpen size={14} />
              <span>
                安装位置
                <b
                  title={
                    runningInTauri
                      ? runtime?.installPath || undefined
                      : undefined
                  }
                >
                  {!runningInTauri
                    ? "未访问本机文件"
                    : !runtimeSupported
                      ? "不适用"
                      : runtime?.installed
                        ? runtime.installPath || "路径未识别"
                        : runtime
                          ? "未检测到"
                          : "正在识别"}
                </b>
              </span>
            </div>
            <div>
              <Download size={14} />
              <span>
                更新源
                <b title="GitHub · Duojiyi/codex-app-mirror">
                  {!runningInTauri
                    ? "未读取"
                    : preferences
                      ? runtimeChannelText(updateSource)
                      : preferencesError
                        ? "读取失败"
                        : "读取中"}
                </b>
              </span>
            </div>
            <div>
              <Activity size={14} />
              <span>
                启动时检查
                <b>
                  {!runningInTauri
                    ? "未读取"
                    : preferences
                      ? preferences.checkCodexUpdatesOnStart === false
                        ? "已关闭"
                        : "已开启"
                      : preferencesError
                        ? "读取失败"
                        : "读取中"}
                </b>
              </span>
            </div>
          </div>
          <button
            className="runtime-folder"
            aria-label="打开安装目录"
            title="打开安装目录"
            onClick={() => void openInstallDirectory()}
            disabled={
              !runningInTauri ||
              !runtimeSupported ||
              !runtime?.installed ||
              Boolean(operation)
            }
          >
            <FolderOpen size={16} />
          </button>
        </div>
        {preferencesError && (
          <div role="alert">
            读取更新偏好失败，重试前无法检查或安装更新。
            <button
              onClick={() => setPreferencesRetry((current) => current + 1)}
            >
              重试读取更新偏好
            </button>
          </div>
        )}
        {pendingPreferenceKeys.size > 0 && (
          <p role="status">正在保存更新偏好…</p>
        )}
        {recovery.length > 0 &&
          !operationLabel &&
          !installingHistory &&
          !installingOffline && (
            <div className="runtime-update-ready" role="alert">
              <CircleAlert size={16} aria-hidden="true" />
              <span>
                <b>检测到 {recovery.length} 个未完成的安装事务</b>
                <small>
                  上次安装（{recovery[0].version} · {recovery[0].source}
                  ）未正常结束。
                  {recovery[0].backupPath
                    ? "备份目录仍在，可通过「安装方式与更新源 → 回滚」恢复上一版本，"
                    : "如 Codex 工作正常可直接忽略，"}
                  处理后点击“我已处理”。
                </small>
              </span>
              <button
                type="button"
                className="runtime-update-recheck"
                onClick={() => void acknowledgeRecovery(recovery[0].id)}
              >
                我已处理
              </button>
            </div>
          )}
        <div
          className="runtime-release-card"
          role={updateAvailable && runningInTauri ? "status" : undefined}
        >
          <strong>
            {!runningInTauri
              ? "更新状态待检测"
              : updateAvailable && release
                ? `Codex ${release.latestVersion} 可用`
                : release
                  ? "未发现可用更新"
                  : "尚未检查更新"}
          </strong>
          <p>
            {!runningInTauri
              ? "浏览器预览不读取本机安装，也不执行下载、修复或卸载。"
              : updateAvailable && release
                ? `${selectedInstallLabel}${
                    release.sizeBytes > 0
                      ? ` · ${(release.sizeBytes / 1024 / 1024).toFixed(1)} MB`
                      : ""
                  } · 确认后下载并安装。`
                : "检查所选更新源，版本与安装包信息以检测结果为准。"}
          </p>
          <small>安装或维护可能中断正在运行的 Codex，请先保存工作。</small>
          <div className="runtime-reference-actions">
            {updateAvailable && runningInTauri && (
              <button
                className="primary"
                onClick={() => startAction("update", selectedPreferences)}
                disabled={
                  !runtimeSupported || Boolean(operation) || preferencesBusy
                }
              >
                <Download size={14} />
                {updateActionLabel}
              </button>
            )}
            <button
              className="secondary"
              onClick={() => setMaintenanceOpen(true)}
              disabled={
                !runtimeSupported || Boolean(operation) || preferencesBusy
              }
            >
              <Settings2 size={14} />
              安装方式与更新源
            </button>
          </div>
        </div>
        <section className="runtime-maintenance-rows" aria-label="维护">
          <h2>维护</h2>
          <div>
            <Wrench size={18} />
            <span>
              <strong>修复安装</strong>
              <small>修复损坏的 Codex 安装文件；操作前会再次确认。</small>
            </span>
            <button
              className="secondary"
              onClick={() => startAction("repair")}
              disabled={
                !runningInTauri ||
                !runtimeSupported ||
                !runtime?.canRepair ||
                Boolean(operation) ||
                preferencesBusy
              }
            >
              修复
            </button>
          </div>
          <div>
            <RefreshCw size={18} />
            <span>
              <strong>回滚</strong>
              <small>
                {runningInTauri && runtime?.canRollback
                  ? "恢复上一个可用版本，具体备份以本机检测为准。"
                  : "尚未确认本机存在可恢复版本。"}
              </small>
            </span>
            <button
              className="secondary"
              onClick={() => startAction("rollback")}
              disabled={
                !runningInTauri ||
                !runtimeSupported ||
                !runtime?.canRollback ||
                Boolean(operation) ||
                preferencesBusy
              }
            >
              回滚
            </button>
          </div>
          <div>
            <Trash2 size={18} />
            <span>
              <strong>卸载</strong>
              <small>移除本机 Codex，卸载范围与风险会在确认时显示。</small>
            </span>
            <button
              className="secondary danger"
              onClick={() => startAction("uninstall")}
              disabled={
                !runningInTauri ||
                !runtimeSupported ||
                !runtime?.canUninstall ||
                Boolean(operation) ||
                preferencesBusy
              }
            >
              卸载…
            </button>
          </div>
        </section>
        <section className="runtime-local-records" aria-label="本机版本记录">
          <h2>本机版本记录</h2>
          {runningInTauri && runtime?.installed ? (
            <div>
              <code>{version}</code>
              <span>当前检测版本</span>
              <small>安装时间与历史缓存记录尚未提供</small>
            </div>
          ) : (
            <p>
              {runningInTauri
                ? "尚无已确认的本机版本记录。"
                : "连接本机后显示实际版本和安装时间。"}
            </p>
          )}
        </section>
      </section>
      {maintenanceOpen && (
        <div
          className="runtime-maintenance-page"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMaintenanceOpen(false);
          }}
        >
          <section
            ref={maintenanceDialogRef}
            className="runtime-maintenance-workspace"
            role="dialog"
            aria-modal="true"
            aria-label="安装与维护"
            tabIndex={-1}
          >
            <header>
              <div>
                <h2>安装与维护</h2>
                <p>分别选择安装方式与下载更新源</p>
              </div>
              <button
                aria-label="关闭安装与维护"
                onClick={() => setMaintenanceOpen(false)}
              >
                <ChevronLeft size={18} /> 返回 Codex 管理
              </button>
            </header>
            <div className="runtime-maintenance-content">
              <b>安装方式</b>
              <button
                className={`runtime-mode-card ${installMode === "standard" ? "is-active" : ""}`}
                disabled={
                  !preferences || pendingPreferenceKeys.has("codexInstallMode")
                }
                aria-pressed={installMode === "standard"}
                onClick={() =>
                  saveRuntimePreference({ codexInstallMode: "standard" })
                }
              >
                <span>
                  <Download size={18} />
                </span>
                <span>
                  <strong>标准安装</strong>
                  <small>自动集成到 Windows，适合大多数用户</small>
                </span>
                {installMode === "standard" && <Check size={16} />}
              </button>
              <button
                className={`runtime-mode-card ${installMode === "portable" ? "is-active" : ""}`}
                disabled={
                  !preferences || pendingPreferenceKeys.has("codexInstallMode")
                }
                aria-pressed={installMode === "portable"}
                onClick={() =>
                  saveRuntimePreference({ codexInstallMode: "portable" })
                }
              >
                <span>
                  <Package size={18} />
                </span>
                <span>
                  <strong>免安装版</strong>
                  <small>便携运行，可放在任意目录</small>
                </span>
                {installMode === "portable" && <Check size={16} />}
              </button>
              <b>更新源</b>
              <div className="runtime-source-segment">
                <button
                  className={updateSource === "auto" ? "is-active" : ""}
                  disabled={
                    !preferences ||
                    pendingPreferenceKeys.has("codexUpdateSource")
                  }
                  aria-pressed={updateSource === "auto"}
                  onClick={() =>
                    saveRuntimePreference({ codexUpdateSource: "auto" })
                  }
                >
                  自动选择
                </button>
                <button
                  className={updateSource === "mirror" ? "is-active" : ""}
                  disabled={
                    !preferences ||
                    pendingPreferenceKeys.has("codexUpdateSource")
                  }
                  aria-pressed={updateSource === "mirror"}
                  onClick={() =>
                    saveRuntimePreference({ codexUpdateSource: "mirror" })
                  }
                >
                  镜像安装
                </button>
              </div>
              <p className="runtime-source-note">
                当前安装包来自 GitHub 镜像：
                <code>Duojiyi/codex-app-mirror</code>，非 OpenAI 官方下载站。
              </p>
              <b>维护</b>
              <div className="runtime-maintenance-list">
                <button onClick={runDiagnostics} disabled={diagnosing}>
                  <Activity size={16} />
                  <span>
                    <strong>{diagnosing ? "正在诊断" : "诊断"}</strong>
                    <small>只检查，不修改本机文件</small>
                  </span>
                  <ChevronDown size={15} />
                </button>
                <button
                  onClick={() => startAction("repair")}
                  disabled={!runtime?.canRepair || preferencesBusy}
                >
                  <Wrench size={16} />
                  <span>
                    <strong>修复</strong>
                    <small>修复损坏的 Codex 安装文件</small>
                  </span>
                  <ChevronDown size={15} />
                </button>
                <button
                  onClick={() => startAction("rollback")}
                  disabled={!runtime?.canRollback || preferencesBusy}
                >
                  <RefreshCw size={16} />
                  <span>
                    <strong>回滚</strong>
                    <small>恢复上一个可用版本</small>
                  </span>
                  <ChevronDown size={15} />
                </button>
                <button
                  onClick={openHistory}
                  disabled={Boolean(operation) || preferencesBusy}
                >
                  <Activity size={16} />
                  <span>
                    <strong>安装历史版本</strong>
                    <small>从镜像发布目录选择并锁定指定版本</small>
                  </span>
                  <ChevronDown size={15} />
                </button>
                <button
                  onClick={() => void pickOfflinePackage()}
                  disabled={
                    Boolean(operation) || preferencesBusy || inspectingOffline
                  }
                >
                  <Package size={16} />
                  <span>
                    <strong>
                      {inspectingOffline ? "正在检查安装包…" : "离线导入安装包"}
                    </strong>
                    <small>
                      校验本地 .Msix 的哈希与 OpenAI 签名后安装（免安装版）
                    </small>
                  </span>
                  <ChevronDown size={15} />
                </button>
                <button
                  className="danger"
                  onClick={() => startAction("uninstall")}
                  disabled={!runtime?.canUninstall || preferencesBusy}
                >
                  <Trash2 size={16} />
                  <span>
                    <strong>卸载 Codex</strong>
                    <small>保留 Chimera++ 与供应商配置</small>
                  </span>
                  <ChevronDown size={15} />
                </button>
              </div>
            </div>
            <button
              className="primary runtime-maintenance-primary"
              onClick={() => startAction("update", selectedPreferences)}
              disabled={Boolean(operation) || preferencesBusy}
            >
              <Download size={15} />
              下载并安装 {selectedInstallLabel}
            </button>
          </section>
        </div>
      )}
      {historyOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !installingHistory)
              setHistoryOpen(false);
          }}
        >
          <section
            ref={historyDialogRef}
            className="history-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="runtime-history-title"
            tabIndex={-1}
          >
            <header>
              <div>
                <h2 id="runtime-history-title">安装历史版本</h2>
                <p>
                  版本来自 Chimera 镜像发布目录；选定后版本、安装包与 SHA-256
                  即被锁定。
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="关闭历史版本"
                onClick={() => setHistoryOpen(false)}
                disabled={installingHistory}
              >
                <X size={16} />
              </button>
            </header>
            {pendingPlan ? (
              <div className="history-dialog-body">
                <div className="history-confirm-meta">
                  <strong>
                    Codex {pendingPlan.version}
                    {pendingPlan.packageVersion
                      ? `（包版本 ${pendingPlan.packageVersion}）`
                      : ""}
                    {pendingPlan.sizeBytes > 0
                      ? ` · ${(pendingPlan.sizeBytes / 1024 / 1024).toFixed(1)} MB`
                      : ""}
                  </strong>
                  <small>
                    SHA-256：<code>{pendingPlan.sha256}</code>
                  </small>
                  <small>
                    安装方式：{runtimeText(installMode)}
                    ；历史版本降级不会被后台更新静默覆盖，安装前后都会复核哈希与
                    OpenAI 签名。
                  </small>
                </div>
              </div>
            ) : (
              <div className="history-dialog-body">
                {historyLoading && <p>正在加载版本目录…</p>}
                {!historyLoading && !historyReleases.length && (
                  <p>该页没有可安装的版本。</p>
                )}
                <div className="history-version-list">
                  {historyReleases.map((item) => (
                    <button
                      key={item.tag}
                      onClick={() => void planHistoryRelease(item.tag)}
                      disabled={!item.installable || planningTag !== null}
                    >
                      <Download size={16} />
                      <span>
                        <strong>
                          {item.name || item.tag}
                          {item.prerelease ? "（预发布）" : ""}
                        </strong>
                        <small>
                          {item.installable
                            ? formatReleaseDate(item.publishedAt)
                            : "缺少 Windows 安装资产"}
                          {planningTag === item.tag ? " · 正在解析…" : ""}
                        </small>
                      </span>
                      <ChevronDown size={15} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            <footer>
              {pendingPlan ? (
                <>
                  <button
                    onClick={() => setPendingPlan(null)}
                    disabled={installingHistory}
                  >
                    返回列表
                  </button>
                  <button
                    className="primary"
                    onClick={() => void installHistoryRelease()}
                    disabled={installingHistory}
                  >
                    {installingHistory ? "正在安装…" : "确认安装此版本"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => void loadHistoryReleases(historyPage - 1)}
                    disabled={historyLoading || historyPage <= 1}
                  >
                    上一页
                  </button>
                  <button
                    onClick={() => void loadHistoryReleases(historyPage + 1)}
                    disabled={historyLoading || historyReleases.length < 10}
                  >
                    下一页
                  </button>
                </>
              )}
            </footer>
          </section>
        </div>
      )}
      {offlineInspection && (
        <div className="modal-backdrop">
          <section
            ref={offlineDialogRef}
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="runtime-offline-title"
            tabIndex={-1}
          >
            {offlineInspection.signatureValid &&
            offlineInspection.identityValid &&
            offlineInspection.architectureMatches ? (
              <CircleCheck size={26} />
            ) : (
              <CircleAlert size={26} />
            )}
            <h2 id="runtime-offline-title">确认离线安装？</h2>
            <p>
              {offlineInspection.fileName} · Codex{" "}
              {offlineInspection.packageVersion} ·{" "}
              {offlineInspection.architecture} ·{" "}
              {(offlineInspection.sizeBytes / 1024 / 1024).toFixed(1)} MB
            </p>
            <p>
              <small>
                SHA-256：<code>{offlineInspection.sha256}</code>
              </small>
            </p>
            <p>
              <small>
                OpenAI 发行者签名：
                {offlineInspection.signatureValid ? "已通过" : "未通过"} ·
                包身份：
                {offlineInspection.identityValid
                  ? "Codex"
                  : offlineInspection.packageName}{" "}
                · 架构
                {offlineInspection.architectureMatches ? "匹配" : "不匹配"}
                。安装走免安装版，安装前会再次复核哈希。
              </small>
            </p>
            <footer>
              <button
                onClick={() => setOfflineInspection(null)}
                disabled={installingOffline}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => void installOfflinePackage()}
                disabled={
                  installingOffline ||
                  !offlineInspection.signatureValid ||
                  !offlineInspection.identityValid ||
                  !offlineInspection.architectureMatches
                }
              >
                {installingOffline ? "正在安装…" : "确认安装"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

export function NewProvidersView({
  providers,
  currentId,
  currentSource,
  connection,
  loading,
  codexProcess,
  rendererUnlock,
  launchingCodex,
  restartRequired,
  onOpenCodex,
  onSwitch,
  onEdit,
  onDelete,
  deletingProviderId,
  onAdd,
  onTestSpeed,
}: {
  providers: Provider[];
  currentId: string;
  currentSource: "live" | "stored" | "external" | "none";
  connection: ConnectionState;
  loading: boolean;
  codexProcess: CodexProcessStatus | null;
  rendererUnlock?: CodexRendererUnlockProbe | null;
  launchingCodex: boolean;
  restartRequired: boolean;
  onOpenCodex: () => Promise<void>;
  onSwitch: (id: string) => Promise<boolean | void>;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void | Promise<boolean>;
  deletingProviderId: string | null;
  onAdd: () => void;
  onTestSpeed?: (baseUrl: string, providerName?: string) => Promise<boolean>;
}) {
  const {
    hasUpdate,
    updateInfo,
    isDismissed,
    dismissUpdate,
    stagedVersion,
    isInstalling,
    downloadProgress,
    installUpdate,
  } = useUpdate();
  const [managerOpen, setManagerOpen] = useState(false);
  const [toolbarContainer, setToolbarContainer] =
    useState<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [undoReceipt, setUndoReceipt] = useState<{
    fromName: string;
    toName: string;
    backupId: string;
    timestamp: string;
    onUndo: () => void;
  } | null>(null);
  const undoTimerRef = useRef<NodeJS.Timeout | null>(null);
  const managerTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    },
    [],
  );
  const managerRef = useDialogFocus<HTMLElement>(
    () => setManagerOpen(false),
    managerOpen,
    managerTriggerRef,
  );
  const { data: appSettings } = useSettingsQuery();
  const showProviderBalance = appSettings?.showProviderBalance ?? false;
  // Naming a line requires parsing its config.toml, and disambiguating the
  // generic Chimera names requires parsing every other line's too. Computed
  // per render that is quadratic in the number of lines and re-runs on every
  // keystroke in the search box, so derive it once per provider list.
  const lineLabels = useMemo(() => {
    const isOfficial = (provider: Provider) =>
      provider.id === "codex-official" || provider.category === "official";
    const isChimera = (provider: Provider) => {
      const endpoint =
        extractCodexBaseUrl(String(provider.settingsConfig?.config ?? "")) ??
        "";
      let host = endpoint;
      try {
        host = new URL(endpoint).hostname;
      } catch {
        // Not a parseable URL; match against the raw value instead.
      }
      return /(^|\.)chimerahub\.org$/i.test(host);
    };
    const chimeraIds = providers.filter(isChimera).map((item) => item.id);
    const labels = new Map<
      string,
      { name: string; source: string; mark: string; official: boolean }
    >();
    for (const provider of providers) {
      const official = isOfficial(provider);
      const chimera = !official && isChimera(provider);
      const normalized = provider.name.trim().toLowerCase().replace(/\s+/g, "");
      const generic = ["chimerahub", "chimera中转站", "default"].includes(
        normalized,
      );
      let name: string;
      if (official) {
        name = provider.name.trim() || "官方账户";
      } else if (!generic) {
        name = provider.name || "未命名线路";
      } else if (chimera) {
        const index = chimeraIds.indexOf(provider.id);
        name =
          index <= 0
            ? "默认线路"
            : index === 1
              ? "备用线路"
              : `线路 ${index + 1}`;
      } else {
        name = "默认线路";
      }
      labels.set(provider.id, {
        name,
        source: official
          ? "ChatGPT 官方登录"
          : chimera
            ? "Chimera 中转站"
            : "自定义线路",
        mark: official
          ? "O"
          : chimera
            ? "C"
            : provider.name.trim().slice(0, 1).toUpperCase() || "线",
        official,
      });
    }
    return labels;
  }, [providers]);
  const current =
    currentSource === "external" || currentSource === "none"
      ? null
      : (providers.find((provider) => provider.id === currentId) ?? null);
  const currentConfig = current?.settingsConfig?.config ?? "";
  const currentAuth = (current?.settingsConfig?.auth ?? {}) as Record<
    string,
    unknown
  >;
  const currentIsOfficial =
    current != null &&
    (current.id === "codex-official" || current.category === "official");
  // ── 首页余额显示（仅非官方线路 + 开关开启时查询）──
  // hooks 必须在任何 early return 之前调用；enabled 控制是否真正下发请求
  const balanceBaseUrl = extractCodexBaseUrl(String(currentConfig));
  // 与 ProviderCard 一致的权威取 key 逻辑：中继站 key 存于
  // settingsConfig.auth.OPENAI_API_KEY（而非 env.CODEX_API_KEY），
  // fallback 到实验性 bearer token（在 config TOML 中）。
  const rawApiKey = currentAuth?.OPENAI_API_KEY as string | undefined;
  const rawBearerToken = extractCodexExperimentalBearerToken(
    String(currentConfig),
  );
  const balanceApiKey =
    typeof rawApiKey === "string" && rawApiKey.trim() !== ""
      ? rawApiKey
      : typeof rawBearerToken === "string" && rawBearerToken.trim() !== ""
        ? rawBearerToken
        : "";
  const balanceEnabled =
    showProviderBalance &&
    !currentIsOfficial &&
    !!balanceBaseUrl &&
    !!balanceApiKey;
  const balanceQuery = useQuery({
    queryKey: ["provider-balance", current?.id ?? "none"],
    queryFn: () =>
      subscriptionApi.getBalance(
        balanceBaseUrl as string,
        balanceApiKey as string,
      ),
    enabled: balanceEnabled,
    refetchInterval: balanceEnabled ? 60 * 1000 : false,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 1,
    retryDelay: 1500,
  });
  const balanceData = balanceQuery.data?.data?.[0];
  const balanceExtra = balanceData?.extra ?? "";
  const balanceUnlimited = balanceExtra.includes("unlimited_quota=true");
  const hasAccountBalance = balanceExtra.includes("account_balance_points=");
  const balanceErrorText =
    balanceQuery.data && !balanceQuery.data.success
      ? balanceQuery.data.error
      : balanceQuery.error
        ? String(balanceQuery.error)
        : undefined;
  const balanceNotice = providerBalanceNotice(
    !!balanceBaseUrl && !!balanceApiKey,
    balanceQuery.data,
  );
  const balanceLabel = balanceQuery.isLoading
    ? "余额查询中…"
    : balanceNotice
      ? balanceNotice
      : balanceErrorText
        ? `查询失败：${balanceErrorText}`
        : balanceData
          ? hasAccountBalance
            ? `${Number(balanceData.remaining ?? 0).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}${balanceData.unit ?? ""}`
            : balanceUnlimited
              ? "不限量"
              : `${
                  balanceData.remaining ?? balanceData.total ?? 0
                }${balanceData.unit ?? ""}`
          : "暂无余额数据";
  if (loading) return <Empty label="正在读取线路…" />;
  if (!providers.length) return <Onboarding onAdd={onAdd} />;
  const officialLoginRequired =
    currentIsOfficial && codexProcess?.officialLoginAvailable === false;
  const isOfficialLine = (provider: Provider) =>
    lineLabels.get(provider.id)?.official ?? false;
  const lineName = (provider: Provider) =>
    lineLabels.get(provider.id)?.name ?? provider.name ?? "未命名线路";
  const lineSource = (provider: Provider) =>
    lineLabels.get(provider.id)?.source ?? "自定义线路";
  const lineMark = (provider: Provider) =>
    lineLabels.get(provider.id)?.mark ??
    (provider.name.trim().slice(0, 1).toUpperCase() || "线");
  const visibleLines = providers.filter((provider) => {
    const haystack =
      `${lineName(provider)} ${lineSource(provider)} ${provider.name} ${extractCodexModelName(String(provider.settingsConfig?.config ?? ""))}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const activateLine = async (provider: Provider) => {
    if (provider.id === current?.id || switchingId || deletingProviderId)
      return;
    const previous = current;
    setSwitchingId(provider.id);
    try {
      const switched = await onSwitch(provider.id);
      if (switched === false) return;
      if (previous && previous.id !== provider.id) {
        if (undoTimerRef.current) {
          clearTimeout(undoTimerRef.current);
        }
        setUndoReceipt({
          fromName: lineName(previous),
          toName: lineName(provider),
          backupId: `sw-${Date.now()}`,
          timestamp: "刚刚",
          onUndo: () => {
            if (undoTimerRef.current) {
              clearTimeout(undoTimerRef.current);
              undoTimerRef.current = null;
            }
            void onSwitch(previous.id);
            setUndoReceipt(null);
          },
        });
        undoTimerRef.current = setTimeout(() => {
          setUndoReceipt(null);
          undoTimerRef.current = null;
        }, 8000);
      }
    } finally {
      setSwitchingId(null);
    }
  };

  const rendererUnlockPending =
    codexProcess?.running === true &&
    rendererUnlock != null &&
    rendererUnlock.attachable === false;
  const codexStatusLabel =
    codexProcess === null
      ? "正在检测 Codex"
      : codexProcess.supported
        ? codexProcess.installed
          ? officialLoginRequired
            ? "官方账户需要登录"
            : codexProcess.running
              ? restartRequired
                ? "Codex 运行中 · 线路待重新加载"
                : rendererUnlockPending
                  ? "Codex 运行中 · 解锁状态未确认"
                  : rendererUnlock?.attachable === true &&
                      rendererUnlock.injected === false
                    ? "Codex 运行中 · 调试连接可用，模型解锁未确认"
                    : "Codex 正在运行"
              : "Codex 已就绪"
          : "未检测到 Codex"
        : "macOS 暂不支持快速启动";
  const codexButtonLabel = launchingCodex
    ? "正在启动…"
    : codexProcess === null
      ? "正在检测…"
      : codexProcess?.supported === false
        ? "仅 Windows 支持"
        : codexProcess?.installed === false
          ? "尚未安装"
          : codexProcess?.running &&
              (restartRequired ||
                (rendererUnlock?.attachable &&
                  rendererUnlock.injected === false &&
                  Boolean(rendererUnlock.error)))
            ? officialLoginRequired
              ? "重启并登录"
              : "重启 Codex"
            : officialLoginRequired
              ? "启动并登录"
              : codexProcess?.running
                ? "打开 Codex"
                : "启动 Codex";

  return (
    <section className="provider-page">
      {hasUpdate && !isDismissed && updateInfo && (
        <div className="route-update-banner" role="status" aria-live="polite">
          <i aria-hidden="true" />
          <div className="route-update-banner-copy">
            <b>Chimera++ {updateInfo.availableVersion} 可用</b>
            <small>
              {isInstalling
                ? downloadProgress?.total
                  ? `正在下载 ${Math.min(
                      100,
                      Math.round(
                        (downloadProgress.downloaded / downloadProgress.total) *
                          100,
                      ),
                    )}%，完成后将自动安装并重启。`
                  : "正在准备更新，完成后将自动安装并重启。"
                : stagedVersion === updateInfo.availableVersion
                  ? "安装包已下载并通过验证，点击即可安装并重启。"
                  : "发现新版本，下载并验证后安装。"}
            </small>
          </div>
          <div className="route-update-banner-actions">
            <button type="button" onClick={dismissUpdate}>
              稍后
            </button>
            <button
              type="button"
              className="primary"
              disabled={isInstalling}
              onClick={() =>
                void installUpdate().catch((reason) =>
                  toast.error("应用更新失败", {
                    description: String(reason),
                  }),
                )
              }
            >
              {isInstalling
                ? "正在更新…"
                : stagedVersion === updateInfo.availableVersion
                  ? "安装并重启"
                  : "下载并安装"}
            </button>
          </div>
        </div>
      )}
      <header className="provider-page-heading">
        <div>
          <h2>线路</h2>
          <p>Codex 同一时间只走一条线路 · 共 {providers.length} 条</p>
        </div>
        <div className="provider-page-heading-actions">
          <div
            className="provider-page-heading-tools"
            ref={setToolbarContainer}
          />
          <button
            type="button"
            className="provider-add"
            onClick={onAdd}
            disabled={designPreview}
          >
            <Plus size={16} />
            添加线路
          </button>
        </div>
      </header>
      <div className="provider-page-signboard" aria-label="当前 Codex 线路站牌">
        {!current && (
          <div className="provider-current-unresolved" role="status">
            <strong>
              {currentSource === "external"
                ? "正在使用外部配置"
                : "尚未确认当前线路"}
            </strong>
            <p>请从下方选择线路；不会自动将第一条线路设为当前。</p>
          </div>
        )}
        <StationSignboard
          currentProvider={current}
          designSample={designPreview ? CANONICAL_STATION : undefined}
          runtimeLabel={
            designPreview ? "设计预览 · 未检测本机" : codexStatusLabel
          }
          runtimeHint={
            restartRequired && codexProcess?.running
              ? "线路配置已保存，当前 Codex 窗口可能仍显示上一条线路的模型。请完整重启后使用。"
              : rendererUnlockPending
                ? "暂时无法确认模型列表解锁状态，正在重新检测。"
                : rendererUnlock?.attachable &&
                    rendererUnlock.injected === false
                  ? rendererUnlock.error ||
                    "调试连接可用，模型解锁未确认/未安装。"
                  : undefined
          }
          onOpenCodex={() => void onOpenCodex()}
          openCodexLabel={codexButtonLabel}
          openCodexDisabled={
            designPreview ||
            launchingCodex ||
            codexProcess === null ||
            !codexProcess.supported ||
            !codexProcess.installed
          }
          latencyMs={
            connection.kind === "connected"
              ? (connection.latencyMs ?? null)
              : null
          }
          testingLatency={connection.kind === "checking"}
          onTestSpeed={
            !designPreview && onTestSpeed && balanceBaseUrl && current
              ? () => {
                  void onTestSpeed(balanceBaseUrl, current.name);
                }
              : undefined
          }
          onEdit={!designPreview && current ? () => onEdit(current) : undefined}
          undoReceipt={undoReceipt}
        />
      </div>
      {balanceEnabled && !balanceNotice && (
        <div className="route-balance-bar">
          <span className="route-balance-bar-label">线路余额</span>
          <span
            className={`route-balance-value${balanceNotice || !balanceData ? " is-muted" : ""}`}
            role="status"
          >
            {balanceLabel}
          </span>
          <button
            type="button"
            className="route-balance-refresh"
            aria-label="刷新余额"
            disabled={balanceQuery.isFetching}
            onClick={() => void balanceQuery.refetch()}
          >
            <RefreshCw
              size={14}
              className={balanceQuery.isFetching ? "animate-spin" : undefined}
            />
            <span>刷新</span>
          </button>
        </div>
      )}
      <ProviderLineTable
        readOnly={designPreview}
        designSamples={designPreview ? CANONICAL_LINES : undefined}
        toolbarContainer={toolbarContainer}
        onManage={designPreview ? undefined : () => setManagerOpen(true)}
        managerTriggerRef={managerTriggerRef}
        providers={providers}
        currentId={current?.id ?? ""}
        switchingId={switchingId}
        deletingProviderId={deletingProviderId}
        labels={lineLabels}
        onSwitch={activateLine}
        onEdit={onEdit}
        onDelete={onDelete}
      />
      {managerOpen && (
        <div
          className="route-line-manager-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setManagerOpen(false);
          }}
        >
          <section
            ref={managerRef}
            className="route-line-manager"
            role="dialog"
            aria-modal="true"
            aria-labelledby="route-line-manager-title"
            tabIndex={-1}
          >
            <header>
              <div>
                <h2 id="route-line-manager-title">管理线路</h2>
                <p>切换、编辑、删除或添加 Codex 线路</p>
              </div>
              <button
                type="button"
                aria-label="关闭线路管理"
                onClick={() => setManagerOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <label className="route-line-search">
              <Search size={15} aria-hidden="true" />
              <input
                name="line-search"
                aria-label="搜索线路"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索线路名称或来源…"
                autoFocus
              />
            </label>
            <div className="route-line-manager-list">
              {visibleLines.map((provider) => {
                const active = provider.id === current?.id;
                const switching = switchingId === provider.id;
                return (
                  <article
                    key={provider.id}
                    className={active ? "is-active" : ""}
                  >
                    <button
                      type="button"
                      className="route-line-manager-main"
                      aria-label={`切换到${lineName(provider)}`}
                      onClick={() => void activateLine(provider)}
                    >
                      <span className="route-line-mark" aria-hidden="true">
                        {switching ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          lineMark(provider)
                        )}
                      </span>
                      <span>
                        <b>{lineName(provider)}</b>
                        <small>{lineSource(provider)}</small>
                      </span>
                      {active && <Check size={16} aria-label="当前线路" />}
                    </button>
                    {isOfficialLine(provider) ? (
                      <span className="route-line-official-note">
                        由 Codex 管理
                      </span>
                    ) : (
                      <div className="route-line-actions">
                        <button
                          type="button"
                          className="route-line-edit"
                          aria-label={`编辑${lineName(provider)}`}
                          title="编辑线路"
                          disabled={
                            Boolean(deletingProviderId) || Boolean(switchingId)
                          }
                          onClick={() => {
                            setManagerOpen(false);
                            onEdit(provider);
                          }}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          className="route-line-edit route-line-delete"
                          aria-label={`删除${lineName(provider)}`}
                          title={
                            active
                              ? "当前线路正在使用，请先切换到其他线路"
                              : "删除线路"
                          }
                          disabled={
                            active ||
                            Boolean(deletingProviderId) ||
                            Boolean(switchingId)
                          }
                          onClick={() => void onDelete(provider)}
                        >
                          {deletingProviderId === provider.id ? (
                            <LoaderCircle className="spin" size={15} />
                          ) : (
                            <Trash2 size={15} />
                          )}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
              {!visibleLines.length && (
                <p className="route-line-empty">没有匹配的线路。</p>
              )}
            </div>
            <button
              type="button"
              className="primary route-line-manager-add"
              onClick={() => {
                setManagerOpen(false);
                onAdd();
              }}
            >
              <Plus size={15} /> 添加线路
            </button>
          </section>
        </div>
      )}
    </section>
  );
}

const lineColors = [
  ["#537197", "钴蓝"],
  ["#776894", "紫罗兰"],
  ["#8F607A", "品红"],
  ["#357B7F", "青绿"],
  ["#61774B", "苔绿"],
  ["#8F6446", "赭石"],
] as const;

export function ProviderEditor({
  appId = "codex",
  editor,
  setEditor,
  showKey,
  setShowKey,
  fetchingModels,
  savingProvider,
  dirty = false,
  saveError = null,
  modelFetchError,
  apiFormatDetection,
  apiFormatDetectionError,
  commonConfigSnippet,
  commonConfigLoading,
  commonConfigLoaded,
  onCommonConfigChange,
  onFetchModels,
  connection,
  onTest,
  onSave,
  onDelete,
  onRequestClose,
  escapeDisabled,
  context1mEnabled = false,
}: {
  appId?: AppId;
  editor: ReturnType<typeof providerDraft>;
  setEditor: (value: ReturnType<typeof providerDraft> | null) => void;
  showKey: boolean;
  setShowKey: (value: boolean) => void;
  fetchingModels: boolean;
  savingProvider: boolean;
  dirty?: boolean;
  saveError?: string | null;
  modelFetchError: string | null;
  apiFormatDetection: CodexApiFormatDetection | null;
  apiFormatDetectionError: string | null;
  commonConfigSnippet: string;
  commonConfigLoading: boolean;
  commonConfigLoaded: boolean;
  onCommonConfigChange: (value: string) => void;
  onFetchModels: () => void;
  connection: ConnectionState;
  onTest: () => void;
  onSave: () => void;
  onDelete: () => void;
  onRequestClose: () => void;
  escapeDisabled: boolean;
  /** The `context_1m` capability: shows the 1M context switch. */
  context1mEnabled?: boolean;
}) {
  const isCodex = appId === "codex";
  const toolName = isNativeToolAppId(appId) ? nativeToolNames[appId] : "Codex";
  const needsModel = appId !== "claude" && appId !== "gemini";
  const nativeProtocolOptions =
    appId === "opencode"
      ? [
          ["@ai-sdk/openai-compatible", "Chat Completions"],
          ["@ai-sdk/openai", "Responses"],
          ["@ai-sdk/anthropic", "Anthropic Messages"],
          ["@ai-sdk/google", "Gemini"],
        ]
      : [
          ["openai-completions", "Chat Completions"],
          ["openai-responses", "Responses"],
          ["anthropic-messages", "Anthropic Messages"],
          ["google-generative-ai", "Gemini"],
        ];
  const [commonConfigOpen, setCommonConfigOpen] = useState(false);
  const [openReasoningRow, setOpenReasoningRow] = useState<number | null>(null);
  const [openInstructionsRow, setOpenInstructionsRow] = useState<number | null>(
    null,
  );
  const pageRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [restorePending, setRestorePending] = useState(false);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        escapeDisabled ||
        savingProvider ||
        restorePending ||
        openDialogCount() > 0
      )
        return;
      event.preventDefault();
      onRequestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onRequestClose, escapeDisabled, savingProvider, restorePending]);
  useEffect(() => {
    if (apiFormatDetectionError && advancedRef.current)
      advancedRef.current.open = true;
    if (saveError?.startsWith("通用配置无效")) {
      if (advancedRef.current) advancedRef.current.open = true;
      setCommonConfigOpen(true);
    }
  }, [apiFormatDetectionError, saveError]);
  useEffect(() => {
    if (
      commonConfigOpen &&
      saveError?.startsWith("通用配置无效") &&
      !savingProvider
    ) {
      pageRef.current
        ?.querySelector<HTMLTextAreaElement>(
          "[name=provider-common-config-snippet]",
        )
        ?.focus();
    }
  }, [commonConfigOpen, saveError, savingProvider]);
  const restoreTemplate = () => {
    setOpenReasoningRow(null);
    setOpenInstructionsRow(null);
    setValidationAttempted(false);
    setEditor({
      ...providerDraft(null, editor.name || "新线路"),
      id: editor.id,
    });
    setRestorePending(false);
  };
  const submit = () => {
    setValidationAttempted(true);
    const missing = [
      [editor.name, "provider-name"],
      [editor.baseUrl, "provider-base-url"],
      [editor.apiKey, "provider-api-key"],
      [editor.model, "provider-model"],
    ].find(
      ([value, field]) =>
        !value.trim() &&
        (field !== "provider-api-key" || isCodex) &&
        (field !== "provider-model" || needsModel),
    );
    const missingModel = !isCodex
      ? -1
      : editor.catalogModels.findIndex((item) => !item.model.trim());
    if (missing || missingModel !== -1) {
      const selector = missing
        ? `[name="${missing[1]}"]`
        : `#mapping-model-${missingModel}`;
      const input = pageRef.current?.querySelector<HTMLInputElement>(selector);
      input?.focus();
      input?.scrollIntoView?.({ block: "center" });
      return;
    }
    void onSave();
  };
  const patch = (key: string, value: string) =>
    setEditor({ ...editor, [key]: value });
  const detectedDefaultFormat =
    apiFormatDetection?.formats[editor.model.trim()] ?? null;
  let previewOrigin = "尚未填写有效地址";
  try {
    const url = new URL(editor.baseUrl);
    if (["http:", "https:"].includes(url.protocol)) previewOrigin = url.origin;
  } catch {
    /* Invalid drafts never echo potential credentials into the preview. */
  }
  const remoteCompactionAvailable = codexRemoteCompactionAllowed(
    editor.apiFormat,
    codexProbeModels(editor.model, editor.catalogModels),
  );
  // Only the models this line actually probes are worth explaining; a fetched
  // catalog entry that failed is corrected by the router at request time.
  const detectionFailures = useMemo(() => {
    if (!apiFormatDetection) return [];
    return codexProbeModels(editor.model, editor.catalogModels)
      .filter(
        (model) =>
          !apiFormatDetection.formats[model] &&
          Object.hasOwn(apiFormatDetection.failures, model),
      )
      .map((model) => ({
        model,
        ...describeCodexDetectionFailure(apiFormatDetection.failures[model]),
      }));
  }, [apiFormatDetection, editor.model, editor.catalogModels]);
  const commonConfigWarning = useMemo(
    () => codexApprovalPolicyWarning(commonConfigSnippet),
    [commonConfigSnippet],
  );
  return (
    <section
      ref={pageRef}
      className="provider-editor"
      role="region"
      aria-labelledby="provider-editor-title"
      tabIndex={-1}
    >
      <header className="editor-page-header">
        <button
          type="button"
          className="secondary editor-back"
          aria-label="返回线路"
          onClick={onRequestClose}
          disabled={savingProvider}
        >
          <ChevronLeft size={16} /> 线路
        </button>
        <div className="editor-heading">
          <h2
            id="provider-editor-title"
            ref={headingRef}
            tabIndex={-1}
            aria-label={editor.original ? "编辑线路" : "新建线路"}
          >
            {editor.name.trim() || "未命名线路"}
          </h2>
          <span>
            {toolName} · {editor.original ? "编辑线路" : "新建线路"}
          </span>
        </div>
        <span className="editor-draft-status" role="status">
          {savingProvider ? "正在保存…" : dirty ? "未保存修改" : ""}
        </span>
        {editor.original && (
          <button
            className="danger"
            onClick={onDelete}
            disabled={savingProvider}
          >
            <Trash2 size={15} /> 删除线路
          </button>
        )}
      </header>
      <div className="editor-scroll">
        <fieldset className="editor-form" disabled={savingProvider}>
          <legend className="sr-only">线路配置</legend>
          {saveError && (
            <p className="editor-feedback" role="alert">
              {saveError}
            </p>
          )}
          {validationAttempted &&
            (!editor.name.trim() ||
              !editor.baseUrl.trim() ||
              (isCodex && !editor.apiKey.trim()) ||
              (needsModel && !editor.model.trim())) && (
              <p className="editor-feedback" role="alert">
                {isCodex
                  ? "请填写线路名称、API 请求地址、API Key 和默认模型。"
                  : "请填写标有 * 的必填项。"}
              </p>
            )}
          {isCodex && !editor.original && (
            <CodexPresetStart onRestore={() => setRestorePending(true)} />
          )}
          <section
            className="editor-basic"
            aria-labelledby="editor-basic-title"
          >
            <h3 id="editor-basic-title">基础</h3>
            <div className="editor-basic-grid">
              <div className="editor-name-row">
                <Field
                  label="线路名称 *"
                  name="provider-name"
                  value={editor.name}
                  onChange={(value) => patch("name", value)}
                  placeholder="例如 默认线路或备用线路"
                />
                <details className="editor-appearance">
                  <summary
                    aria-label="修改线路外观"
                    aria-disabled={savingProvider}
                    onClick={(event) => {
                      if (savingProvider) event.preventDefault();
                    }}
                  >
                    外观
                    <span
                      className="provider-row-badge"
                      aria-hidden="true"
                      style={{ background: editor.iconColor || "#537197" }}
                    >
                      {editor.name.trim().slice(0, 1) || "未"}
                    </span>
                    <span>
                      {lineColors.find(
                        ([color]) =>
                          color.toLowerCase() ===
                          editor.iconColor?.toLowerCase(),
                      )?.[1] ?? (editor.iconColor ? "自定义" : "默认")}{" "}
                      · 自动生成
                    </span>
                    修改 <ChevronDown size={14} />
                  </summary>
                  <label>
                    线路颜色
                    <select
                      aria-label="线路颜色"
                      value={editor.iconColor ?? ""}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          iconColor: event.target.value || undefined,
                        })
                      }
                    >
                      <option value="">默认（钴蓝）</option>
                      {editor.iconColor &&
                        !lineColors.some(
                          ([color]) => color === editor.iconColor,
                        ) && (
                          <option value={editor.iconColor}>
                            当前自定义颜色
                          </option>
                        )}
                      {lineColors.map(([color, name]) => (
                        <option key={color} value={color}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                </details>
              </div>

              <Field
                label="API 请求地址 *"
                name="provider-base-url"
                value={editor.baseUrl}
                onChange={(value) => patch("baseUrl", value)}
                placeholder={
                  appId === "claude" || appId === "gemini"
                    ? "https://api.example.com"
                    : "https://api.example.com/v1"
                }
                hint={
                  isCodex
                    ? "本地路由可自动补 /v1；直连请填写完整基础地址。"
                    : `按服务商文档填写 ${toolName} 的完整基础地址，不自动追加路径。`
                }
              />
              <label>
                {isCodex ? "API Key *" : "API Key"}
                <div className="password-field">
                  <input
                    name="provider-api-key"
                    autoComplete="off"
                    spellCheck={false}
                    type={showKey ? "text" : "password"}
                    value={editor.apiKey}
                    onChange={(event) => patch("apiKey", event.target.value)}
                    placeholder="粘贴 API Key"
                  />
                  <button
                    aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <small>
                  {isCodex
                    ? "密钥仅用于此线路，不会显示在保存详情中。"
                    : "需要密钥的服务请填写 API Key；仅本地免认证服务或工具已有有效认证时可留空。"}
                </small>
              </label>
            </div>
          </section>
          <section
            className="editor-protocol"
            aria-labelledby="editor-protocol-title"
          >
            <h3 id="editor-protocol-title">协议与模型</h3>
            {isCodex && (
              <div className="editor-format">
                <span>协议</span>
                <div className="editor-format-line">
                  <div
                    className="editor-format-options"
                    role="radiogroup"
                    aria-label="上游格式"
                  >
                    {(
                      [
                        ["auto", "自动"],
                        ["openai_responses", "Responses"],
                        ["openai_chat", "Chat Completions"],
                        ["anthropic", "Anthropic Messages"],
                      ] as const
                    ).map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="provider-api-format"
                          value={value}
                          checked={editor.apiFormat === value}
                          onChange={() => patch("apiFormat", value)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                  <small title="自动按模型族选择；保存时不探测上游，网关协议不一致时请明确指定。">
                    自动按模型族选择协议
                  </small>
                </div>
                {editor.apiFormat === "auto" && detectedDefaultFormat && (
                  <small>
                    已识别：
                    {codexApiFormatLabel(detectedDefaultFormat.apiFormat)}
                    {detectedDefaultFormat.apiFormat === "openai_responses"
                      ? "（可直连；若启用代理专属功能仍会自动开启路由）"
                      : "（保存后自动开启路由）"}
                  </small>
                )}
                {editor.apiFormat === "auto" && apiFormatDetectionError && (
                  <small className="error-text">
                    {apiFormatDetectionError}
                  </small>
                )}
                {editor.apiFormat === "auto" &&
                  detectionFailures.length > 0 && (
                    <div className="detection-failures">
                      <ul>
                        {detectionFailures.map(({ model, status, excerpt }) => (
                          <li key={model}>
                            <code>{model}</code>
                            <b>{status}</b>
                            {excerpt && <span title={excerpt}>{excerpt}</span>}
                          </li>
                        ))}
                      </ul>
                      <div className="detection-failure-actions">
                        <span>也可以直接指定协议保存：</span>
                        {(
                          [
                            "openai_responses",
                            "openai_chat",
                            "anthropic",
                          ] as const
                        ).map((format) => (
                          <button
                            key={format}
                            type="button"
                            className="secondary"
                            disabled={savingProvider}
                            onClick={() => patch("apiFormat", format)}
                          >
                            按 {codexApiFormatLabel(format)} 保存
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            )}
            {(appId === "opencode" || appId === "pi") && (
              <label>
                接口类型
                <select
                  aria-label="接口类型"
                  value={editor.nativeProtocol}
                  onChange={(event) =>
                    patch("nativeProtocol", event.target.value)
                  }
                >
                  {!nativeProtocolOptions.some(
                    ([value]) => value === editor.nativeProtocol,
                  ) && (
                    <option value={editor.nativeProtocol}>
                      {editor.nativeProtocol}
                    </option>
                  )}
                  {nativeProtocolOptions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {appId === "claude" && (
              <label>
                认证方式
                <select
                  aria-label="认证方式"
                  value={editor.anthropicAuthField}
                  onChange={(event) =>
                    patch("anthropicAuthField", event.target.value)
                  }
                >
                  <option value="ANTHROPIC_AUTH_TOKEN">Bearer Token</option>
                  <option value="ANTHROPIC_API_KEY">API Key (x-api-key)</option>
                </select>
              </label>
            )}
            <label className="editor-default-model">
              {isCodex
                ? "默认模型 *"
                : needsModel
                  ? "模型 ID *"
                  : "默认模型（可选）"}
              <div className="model-input">
                <input
                  name="provider-model"
                  autoComplete="off"
                  spellCheck={false}
                  value={editor.model}
                  onChange={(event) => patch("model", event.target.value)}
                  placeholder={
                    isCodex
                      ? "先获取模型列表，或手动输入"
                      : "填写服务商提供的模型 ID"
                  }
                />
                {isCodex && (
                  <button
                    onClick={onFetchModels}
                    disabled={fetchingModels || savingProvider}
                  >
                    {fetchingModels ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Download size={15} />
                    )}{" "}
                    获取模型
                  </button>
                )}
              </div>
            </label>
          </section>
          {isCodex && (
            <>
              <div className="advanced-group model-mapping">
                <div className="advanced-section-heading">
                  <div>
                    <b title="未添加映射时使用默认模型；显示名可选，留空使用模型 ID。">
                      模型映射
                    </b>{" "}
                    <span aria-label="映射数量">
                      {editor.catalogModels.length}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="secondary compact"
                    onClick={() => {
                      // A row's index shifts whenever the array grows, so any
                      // panel expanded by index must collapse first or it can
                      // end up rendered against the wrong row.
                      setOpenReasoningRow(null);
                      setOpenInstructionsRow(null);
                      setEditor({
                        ...editor,
                        catalogModels: [
                          ...editor.catalogModels,
                          { model: "", displayName: "", contextWindow: "" },
                        ],
                      });
                    }}
                  >
                    添加模型
                  </button>
                </div>
                <div className="mapping-head">
                  <span>菜单显示名（可选）</span>
                  <span>实际请求模型</span>
                  <span title="上下文 / tokens">上下文</span>
                  <span>思考等级</span>
                  <span>操作</span>
                </div>
                {!editor.catalogModels.length && (
                  <p className="mapping-empty">
                    尚未添加自定义映射。可直接使用默认模型，或添加一条映射。
                  </p>
                )}
                {editor.catalogModels.map((item, index) => (
                  // Rows are only ever appended or removed, never reordered
                  // (no drag-and-drop here), so the positional index is a
                  // stable key. Keying on `item.model` instead broke the
                  // "实际请求模型" input: every keystroke changed the key,
                  // which made React remount the row and drop input focus.
                  <div className="mapping-row" key={index}>
                    <label className="mapping-field">
                      <span>菜单显示名（可选）</span>
                      <input
                        aria-label={`模型 ${index + 1} 显示名`}
                        value={item.displayName ?? ""}
                        onChange={(event) => {
                          const catalogModels = [...editor.catalogModels];
                          catalogModels[index] = {
                            ...item,
                            displayName: event.target.value,
                          };
                          setEditor({ ...editor, catalogModels });
                        }}
                        placeholder="菜单显示名"
                      />
                    </label>
                    <label className="mapping-field">
                      <span>实际请求模型</span>
                      <input
                        id={`mapping-model-${index}`}
                        aria-label={`模型 ${index + 1} 实际请求模型`}
                        aria-invalid={validationAttempted && !item.model.trim()}
                        aria-describedby={
                          validationAttempted && !item.model.trim()
                            ? `mapping-error-${index}`
                            : undefined
                        }
                        value={item.model}
                        onChange={(event) => {
                          const catalogModels = [...editor.catalogModels];
                          catalogModels[index] = {
                            ...item,
                            model: event.target.value,
                          };
                          setEditor({ ...editor, catalogModels });
                        }}
                        placeholder="实际请求模型"
                      />
                    </label>
                    <label className="mapping-field">
                      <span>上下文 / tokens（可选）</span>
                      <input
                        aria-label={`模型 ${index + 1} 上下文窗口`}
                        type="number"
                        min="1"
                        inputMode="numeric"
                        value={item.contextWindow ?? ""}
                        onChange={(event) => {
                          const catalogModels = [...editor.catalogModels];
                          catalogModels[index] = {
                            ...item,
                            contextWindow: event.target.value.replace(
                              /[^\d]/g,
                              "",
                            ),
                          };
                          setEditor({ ...editor, catalogModels });
                        }}
                        placeholder="上下文"
                      />
                    </label>
                    <div className="mapping-field">
                      <span>思考等级</span>
                      <button
                        type="button"
                        className="reasoning-trigger"
                        aria-label={`模型 ${index + 1} 思考等级`}
                        aria-controls={`reasoning-panel-${index}`}
                        aria-expanded={openReasoningRow === index}
                        onClick={() =>
                          setOpenReasoningRow(
                            openReasoningRow === index ? null : index,
                          )
                        }
                      >
                        <span
                          className={
                            (item.reasoningLevels?.length ?? 0) === 0
                              ? "reasoning-trigger-placeholder"
                              : undefined
                          }
                        >
                          {(item.reasoningLevels?.length ?? 0) > 0
                            ? `${item.reasoningLevels!.length} 档${
                                item.defaultReasoningLevel
                                  ? ` · ${item.defaultReasoningLevel}`
                                  : ""
                              }`
                            : "自动"}
                        </span>
                        <ChevronDown
                          size={14}
                          style={{
                            transform:
                              openReasoningRow === index
                                ? "rotate(180deg)"
                                : "rotate(0deg)",
                            transition: "transform 0.15s ease",
                          }}
                        />
                      </button>
                    </div>
                    <div className="mapping-actions">
                      <button
                        type="button"
                        className={
                          "instructions-trigger" +
                          (item.baseInstructions?.trim() ? " has-value" : "")
                        }
                        aria-label={`模型 ${index + 1} 系统提示词`}
                        aria-expanded={openInstructionsRow === index}
                        aria-controls={`instructions-panel-${index}`}
                        title="系统提示词 / Base Instructions"
                        onClick={() =>
                          setOpenInstructionsRow(
                            openInstructionsRow === index ? null : index,
                          )
                        }
                      >
                        <FileText size={15} />
                        <span>
                          {item.baseInstructions?.trim() ? "已设置" : "指令"}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`删除模型 ${index + 1} 映射`}
                        onClick={() => {
                          // See the "添加模型" handler above: collapse any
                          // index-addressed panel before the array shifts.
                          setOpenReasoningRow(null);
                          setOpenInstructionsRow(null);
                          setEditor({
                            ...editor,
                            catalogModels: editor.catalogModels.filter(
                              (_, i) => i !== index,
                            ),
                          });
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    {validationAttempted && !item.model.trim() && (
                      <p
                        className="mapping-error"
                        id={`mapping-error-${index}`}
                        role="alert"
                      >
                        请填写实际请求模型，或删除此行。
                      </p>
                    )}
                    {openReasoningRow === index && (
                      <div
                        className="reasoning-panel"
                        id={`reasoning-panel-${index}`}
                      >
                        <div className="reasoning-panel-head">
                          支持等级（可多选）
                        </div>
                        <div className="reasoning-checkboxes">
                          {CODEX_REASONING_LEVELS.map((level) => {
                            const checked = (
                              item.reasoningLevels ?? []
                            ).includes(level);
                            return (
                              <label
                                key={level}
                                className="reasoning-level-option"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    const current = new Set(
                                      item.reasoningLevels ?? [],
                                    );
                                    if (current.has(level)) {
                                      current.delete(level);
                                    } else {
                                      current.add(level);
                                    }
                                    const nextLevels = (
                                      CODEX_REASONING_LEVELS as readonly string[]
                                    ).filter((l) => current.has(l));
                                    const catalogModels = [
                                      ...editor.catalogModels,
                                    ];
                                    const next: CodexCatalogModel = { ...item };
                                    if (nextLevels.length > 0) {
                                      next.reasoningLevels = nextLevels;
                                      if (
                                        next.defaultReasoningLevel &&
                                        !nextLevels.includes(
                                          next.defaultReasoningLevel,
                                        )
                                      ) {
                                        delete next.defaultReasoningLevel;
                                      }
                                    } else {
                                      delete next.reasoningLevels;
                                      delete next.defaultReasoningLevel;
                                    }
                                    catalogModels[index] = next;
                                    setEditor({ ...editor, catalogModels });
                                  }}
                                />
                                <span>{level}</span>
                              </label>
                            );
                          })}
                        </div>
                        {(item.reasoningLevels?.length ?? 0) > 0 && (
                          <div className="reasoning-panel-default">
                            <span>默认等级</span>
                            <select
                              aria-label={`模型 ${index + 1} 默认思考等级`}
                              value={item.defaultReasoningLevel ?? ""}
                              onChange={(event) => {
                                const catalogModels = [...editor.catalogModels];
                                const next: CodexCatalogModel = { ...item };
                                if (event.target.value) {
                                  next.defaultReasoningLevel =
                                    event.target.value;
                                } else {
                                  delete next.defaultReasoningLevel;
                                }
                                catalogModels[index] = next;
                                setEditor({ ...editor, catalogModels });
                              }}
                            >
                              <option value="">自动</option>
                              {item.reasoningLevels!.map((level) => (
                                <option key={level} value={level}>
                                  {level}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    )}
                    {openInstructionsRow === index && (
                      <div
                        className="instructions-panel"
                        id={`instructions-panel-${index}`}
                      >
                        <div className="instructions-panel-head">
                          系统提示词 / Base Instructions（可选）
                        </div>
                        <textarea
                          aria-label="系统提示词"
                          value={item.baseInstructions ?? ""}
                          onChange={(event) => {
                            const catalogModels = [...editor.catalogModels];
                            const next: CodexCatalogModel = { ...item };
                            if (event.target.value) {
                              next.baseInstructions = event.target.value;
                            } else {
                              delete next.baseInstructions;
                            }
                            catalogModels[index] = next;
                            setEditor({ ...editor, catalogModels });
                          }}
                          placeholder="留空则使用默认模板"
                        />
                        <small>
                          覆盖该模型的身份说明/系统前言；留空则使用默认模板。
                        </small>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <details className="advanced-options" ref={advancedRef}>
                <summary>
                  <span className="advanced-summary-copy">
                    <b>高级配置</b>
                    <small>Codex 功能 · 通用配置 · 兼容性</small>
                  </span>
                  <span className="advanced-summary-action">
                    <span className="when-collapsed">展开</span>
                    <span className="when-expanded">收起</span>
                    <ChevronDown size={18} aria-hidden="true" />
                  </span>
                </summary>
                <div className="advanced-options-body">
                  <Field
                    label="官网链接（可选）"
                    name="provider-website"
                    value={editor.websiteUrl}
                    onChange={(value) => patch("websiteUrl", value)}
                    placeholder="https://example.com"
                  />
                  <p className="advanced-intro">
                    按需调整此线路功能与协议。共享通用配置的修改会影响启用它的线路。
                  </p>
                  <div className="advanced-group codex-feature-options">
                    <div className="advanced-section-heading">
                      <div>
                        <b>Codex 功能</b>
                        <small>
                          每条线路独立保存，未开启的功能不会写入配置。
                        </small>
                      </div>
                    </div>
                    <label className="toggle-field">
                      <span>
                        <b>目标模式</b>
                        <small>在 Codex 中开启目标规划能力。</small>
                      </span>
                      <input
                        name="provider-goal-mode"
                        type="checkbox"
                        checked={editor.goalModeEnabled}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            goalModeEnabled: event.target.checked,
                          })
                        }
                      />
                    </label>
                    {context1mEnabled && (
                      <CodexContextWindowField
                        value={editor.config}
                        onChange={(config) => setEditor({ ...editor, config })}
                        disabled={savingProvider}
                      />
                    )}
                    <label className="toggle-field">
                      <span>
                        <b>
                          远程上下文压缩
                          <em className="experimental-tag">实验性</em>
                        </b>
                        <small>
                          {remoteCompactionAvailable
                            ? "仅原生 Responses 上游可用，由上游压缩长对话，默认关闭。"
                            : "经 Chat 或 Anthropic 转换的线路不支持远程压缩。"}
                        </small>
                      </span>
                      <input
                        name="provider-remote-compaction"
                        type="checkbox"
                        checked={
                          editor.remoteCompactionEnabled &&
                          remoteCompactionAvailable
                        }
                        disabled={!remoteCompactionAvailable}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            remoteCompactionEnabled: event.target.checked,
                          })
                        }
                      />
                    </label>
                    <label className="toggle-field">
                      <span>
                        <b>应用通用配置</b>
                        <small>切换到这条线路时合并共享的 Codex 配置。</small>
                      </span>
                      <input
                        name="provider-common-config"
                        type="checkbox"
                        checked={editor.commonConfigEnabled}
                        disabled={commonConfigLoading || !commonConfigLoaded}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            commonConfigEnabled: event.target.checked,
                          })
                        }
                      />
                    </label>
                    <div className="common-config-actions">
                      <span>
                        {commonConfigLoading
                          ? "正在读取通用配置…"
                          : commonConfigLoaded
                            ? commonConfigSnippet.trim()
                              ? "已设置通用配置"
                              : "尚未设置通用配置"
                            : "通用配置暂时不可用"}
                      </span>
                      <button
                        type="button"
                        className="link-button"
                        aria-expanded={commonConfigOpen}
                        disabled={!commonConfigLoaded}
                        onClick={() => setCommonConfigOpen(!commonConfigOpen)}
                      >
                        {commonConfigOpen ? "收起编辑器" : "编辑通用配置"}
                      </button>
                    </div>
                    {commonConfigOpen && (
                      <label className="common-config-editor">
                        通用 config.toml
                        <textarea
                          name="provider-common-config-snippet"
                          spellCheck={false}
                          value={commonConfigSnippet}
                          onChange={(event) =>
                            onCommonConfigChange(event.target.value)
                          }
                          placeholder="例如 [features] 下需要在多条线路间共享的配置"
                        />
                        <small>
                          共享内容影响启用通用配置的线路；供应商地址、密钥、模型和模型目录不会共享。
                        </small>
                        {commonConfigWarning && (
                          <small className="error-text">
                            {commonConfigWarning}
                          </small>
                        )}
                      </label>
                    )}
                  </div>

                  <div className="advanced-group">
                    <label className="toggle-field">
                      <span>
                        <b>完整 API 地址</b>
                        <small>
                          地址已含完整请求路径时开启，不再自动补全路径。
                        </small>
                      </span>
                      <input
                        name="provider-full-url"
                        type="checkbox"
                        checked={editor.isFullUrl}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            isFullUrl: event.target.checked,
                          })
                        }
                      />
                    </label>
                    <label>
                      模型列表地址（可选）
                      <input
                        name="provider-models-url"
                        type="url"
                        autoComplete="url"
                        spellCheck={false}
                        value={editor.modelsUrl}
                        onChange={(event) =>
                          patch("modelsUrl", event.target.value)
                        }
                        placeholder="https://api.example.com/v1/models"
                      />
                      <small>上游的模型接口不同于主接口时填写。</small>
                    </label>
                    <label>
                      自定义 User-Agent（可选）
                      <input
                        name="provider-user-agent"
                        autoComplete="off"
                        spellCheck={false}
                        value={editor.customUserAgent}
                        onChange={(event) =>
                          patch("customUserAgent", event.target.value)
                        }
                        placeholder="留空使用默认请求标识"
                      />
                    </label>
                  </div>
                  {editor.apiFormat === "anthropic" && (
                    <div className="advanced-group">
                      <label>
                        Anthropic 认证字段
                        <select
                          name="provider-anthropic-auth"
                          value={editor.anthropicAuthField}
                          onChange={(event) =>
                            patch("anthropicAuthField", event.target.value)
                          }
                        >
                          <option value="ANTHROPIC_AUTH_TOKEN">
                            Authorization: Bearer
                          </option>
                          <option value="ANTHROPIC_API_KEY">x-api-key</option>
                        </select>
                      </label>
                      <label>
                        最大输出 tokens（可选）
                        <input
                          name="provider-max-output-tokens"
                          type="number"
                          min="1"
                          inputMode="numeric"
                          value={editor.maxOutputTokens}
                          onChange={(event) =>
                            patch(
                              "maxOutputTokens",
                              event.target.value.replace(/[^\d]/g, ""),
                            )
                          }
                          placeholder="默认 8192"
                        />
                      </label>
                      <label className="toggle-field">
                        <span>
                          <b>模拟 Claude Code 客户端</b>
                          <small>
                            仅当上游明确要求 Claude Code 请求特征时开启。
                          </small>
                        </span>
                        <input
                          name="provider-impersonate-claude-code"
                          type="checkbox"
                          checked={editor.impersonateClaudeCode}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              impersonateClaudeCode: event.target.checked,
                            })
                          }
                        />
                      </label>
                    </div>
                  )}
                  {editor.apiFormat === "openai_chat" && (
                    <div className="advanced-group">
                      <label>
                        提示词缓存路由
                        <select
                          name="provider-prompt-cache-routing"
                          value={editor.promptCacheRouting}
                          onChange={(event) =>
                            patch("promptCacheRouting", event.target.value)
                          }
                        >
                          <option value="auto">自动（推荐）</option>
                          <option value="enabled">开启</option>
                          <option value="disabled">关闭</option>
                        </select>
                        <small>严格网关遇到未知缓存字段时可选择关闭。</small>
                      </label>
                      <label className="toggle-field">
                        <span>
                          <b>支持思考模式</b>
                          <small>将 Codex 思考开关转换为上游 Chat 参数。</small>
                        </span>
                        <input
                          name="provider-supports-thinking"
                          type="checkbox"
                          checked={
                            editor.codexChatReasoning.supportsThinking === true
                          }
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              codexChatReasoning: {
                                ...editor.codexChatReasoning,
                                supportsThinking: event.target.checked,
                                supportsEffort: event.target.checked
                                  ? editor.codexChatReasoning.supportsEffort
                                  : false,
                              },
                            })
                          }
                        />
                      </label>
                      <label className="toggle-field">
                        <span>
                          <b>支持思考等级</b>
                          <small>支持 low、high、max 等推理强度时开启。</small>
                        </span>
                        <input
                          name="provider-supports-effort"
                          type="checkbox"
                          checked={
                            editor.codexChatReasoning.supportsEffort === true
                          }
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              codexChatReasoning: {
                                ...editor.codexChatReasoning,
                                supportsThinking: event.target.checked
                                  ? true
                                  : editor.codexChatReasoning.supportsThinking,
                                supportsEffort: event.target.checked,
                                effortParam: event.target.checked
                                  ? (editor.codexChatReasoning.effortParam ??
                                    "reasoning_effort")
                                  : "none",
                              },
                            })
                          }
                        />
                      </label>
                    </div>
                  )}
                </div>
              </details>
            </>
          )}
          {!isCodex && (
            <p className="editor-test-scope">
              {appId === "opencode" || appId === "pi"
                ? "配置此线路的首个模型；已有的其他模型与高级设置会保留。保存后仍需在工具中选择默认模型。"
                : "使用工具原生协议。模型留空时由工具选择，未填写密钥时沿用工具自身的登录方式。"}
            </p>
          )}
          {modelFetchError && (
            <p className="editor-model-error" role="status">
              <CircleAlert size={15} /> {modelFetchError}
            </p>
          )}
          {(appId === "pi" || appId === "opencode") && (
            <p className="editor-test-scope">
              启用此线路不会停用其他线路，也不会切换工具的默认模型。
            </p>
          )}
          <p className="editor-test-scope">
            仅测试地址连通性，不验证密钥或模型。
          </p>
          {connection.kind === "error" && (
            <p className="editor-feedback" role="alert">
              {connection.message}
            </p>
          )}
        </fieldset>
        <details className="editor-preview" aria-label="线路草稿预览">
          <summary>保存详情</summary>
          <dl className="editor-save-summary">
            <dt>线路</dt>
            <dd>{editor.name.trim() || "未命名线路"}</dd>
            <dt>地址</dt>
            <dd>{previewOrigin}</dd>
            <dt>模型</dt>
            <dd>{editor.model.trim() || "由客户端选择"}</dd>
            <dt>协议</dt>
            <dd>
              {!isCodex
                ? editor.nativeProtocol || `${toolName} 原生协议`
                : editor.apiFormat === "auto"
                  ? "自动"
                  : codexApiFormatLabel(editor.apiFormat)}
            </dd>
          </dl>
          <p>
            {appId === "opencode" || appId === "pi"
              ? `保存并启用，不影响其他 ${toolName} 线路。`
              : `保存后设为当前 ${toolName} 线路。`}
            {isCodex && "运行中的 Codex 可能需要重启。"}
          </p>
        </details>
      </div>
      <div className="editor-bottom">
        <footer>
          <div className="editor-test-actions">
            <button
              className="secondary"
              onClick={onTest}
              disabled={savingProvider || connection.kind === "checking"}
            >
              测试地址连通性
            </button>
            <small
              className={`editor-connection is-${connection.kind}`}
              role="status"
            >
              {connection.kind === "error"
                ? "连接失败，详见正文"
                : connection.message}
            </small>
          </div>
          <div className="editor-save-actions">
            <button
              type="button"
              className="secondary"
              onClick={onRequestClose}
              disabled={savingProvider}
            >
              取消
            </button>
            <button
              className="primary"
              onClick={submit}
              disabled={savingProvider || fetchingModels}
            >
              {savingProvider ? (
                <>
                  <LoaderCircle className="spin" size={15} /> 正在保存…
                </>
              ) : appId === "pi" || appId === "opencode" ? (
                "保存并启用"
              ) : (
                "保存并切换"
              )}
            </button>
          </div>
        </footer>
      </div>
      {restorePending && (
        <ConfirmRestoreTemplate
          onCancel={() => setRestorePending(false)}
          onConfirm={restoreTemplate}
        />
      )}
    </section>
  );
}

function ConfirmRestoreTemplate({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useDialogFocus<HTMLElement>(onCancel);
  return (
    <div className="modal-backdrop">
      <section
        ref={ref}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="restore-template-title"
        tabIndex={-1}
      >
        <h2 id="restore-template-title">恢复默认模板？</h2>
        <p>
          这会重置当前线路的地址、密钥、模型映射和高级设置。线路名称与共享通用配置保持不变。
        </p>
        <footer>
          <button onClick={onCancel} data-autofocus>
            继续编辑
          </button>
          <button className="danger" onClick={onConfirm}>
            恢复模板
          </button>
        </footer>
      </section>
    </div>
  );
}

function ModelPickerDialog({
  models,
  selected,
  onPick,
  onClose,
}: {
  models: FetchedModel[];
  selected: string;
  onPick: (model: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="model-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-picker-title"
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id="model-picker-title">选择默认模型</h2>
            <p>列表来自当前线路的模型接口。</p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭模型列表"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="model-picker-list">
          {models.map((model) => (
            <button
              key={model.id}
              className={selected === model.id ? "picked" : ""}
              onClick={() => onPick(model.id)}
            >
              <span>{model.id}</span>
              {selected === model.id && <Check size={16} />}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ConfirmOperation({
  action,
  onCancel,
  onConfirm,
}: {
  action: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLElement>(onCancel);
  const label =
    action === "update"
      ? "下载并安装更新"
      : action === "repair"
        ? "重新安装并修复 Codex"
        : action === "rollback"
          ? "回滚上一版本"
          : "卸载 Codex";
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="runtime-confirm-title"
        tabIndex={-1}
      >
        <CircleAlert size={26} />
        <h2 id="runtime-confirm-title">确认{label}？</h2>
        <p>
          该操作会修改 Codex 安装文件。供应商配置和 `~/.codex`
          用户数据不会被删除。
        </p>
        <footer>
          <button onClick={onCancel}>取消</button>
          <button className="primary" onClick={onConfirm}>
            确认继续
          </button>
        </footer>
      </section>
    </div>
  );
}

function ConfirmDiscardEditor({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLElement>(onCancel);
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="editor-discard-title"
        tabIndex={-1}
      >
        <CircleAlert size={26} />
        <h2 id="editor-discard-title">放弃未保存的修改？</h2>
        <p>离开后，本次未保存的线路设置与通用配置修改将丢失。</p>
        <footer>
          <button onClick={onCancel} data-autofocus>
            继续编辑
          </button>
          <button className="danger" onClick={onConfirm}>
            放弃修改
          </button>
        </footer>
      </section>
    </div>
  );
}

function ConfirmSkinOperation({
  label,
  onCancel,
  onConfirm,
}: {
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLElement>(onCancel);
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="skin-confirm-title"
        tabIndex={-1}
      >
        <Paintbrush size={26} />
        <h2 id="skin-confirm-title">确认{label}？</h2>
        <p>该操作会关闭并重新启动 Codex。供应商配置和用户数据不会被修改。</p>
        <footer>
          <button onClick={onCancel}>取消</button>
          <button className="primary" onClick={onConfirm}>
            确认继续
          </button>
        </footer>
      </section>
    </div>
  );
}

function ConfirmProviderDelete({
  provider,
  onCancel,
  onConfirm,
}: {
  provider: Provider;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLElement>(onCancel);
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="provider-delete-title"
        tabIndex={-1}
      >
        <CircleAlert size={26} />
        <h2 id="provider-delete-title">确认删除“{provider.name}”？</h2>
        <p>该线路会从 Chimera++ 中移除。当前 Codex 用户数据不会被删除。</p>
        <footer>
          <button onClick={onCancel}>取消</button>
          <button className="danger" onClick={onConfirm}>
            删除线路
          </button>
        </footer>
      </section>
    </div>
  );
}

function ConfirmModelReload({
  model,
  onCancel,
  onConfirm,
}: {
  model: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  // Closing and relaunching Codex takes tens of seconds. Without an in-flight
  // guard a second click started a second restart, which then collided with
  // the first one's runtime lock and surfaced as "another Chimera++ operation
  // is in progress" even though only one window was open.
  const [restarting, setRestarting] = useState(false);
  const dialogRef = useDialogFocus<HTMLElement>(onCancel, !restarting);
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="model-reload-title"
        tabIndex={-1}
      >
        <RefreshCw size={26} />
        <h2 id="model-reload-title">重新加载模型列表？</h2>
        <p>
          默认模型“{model}”已写入。Codex
          只在启动时读取模型目录，当前窗口可能仍显示上一条线路的模型。完整重启会中断正在进行的任务，请确认后继续。
        </p>
        <footer>
          <button onClick={onCancel} disabled={restarting}>
            稍后重启
          </button>
          <button
            className="primary"
            disabled={restarting}
            onClick={() => {
              setRestarting(true);
              void onConfirm().finally(() => setRestarting(false));
            }}
          >
            {restarting ? (
              <>
                <LoaderCircle className="spin" size={15} /> 正在重启 Codex…
              </>
            ) : (
              "立即重启 Codex"
            )}
          </button>
        </footer>
      </section>
    </div>
  );
}

function DiagnosticsDialog({
  diagnostics,
  onClose,
}: {
  diagnostics: Diagnostic[];
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  const diagnosticNames: Record<string, string> = {
    installation: "安装状态",
    executable: "程序文件",
    "package integrity": "安装包完整性",
    "package registration": "系统注册",
    dependencies: "运行依赖",
    launch: "启动检查",
    "package signature": "安装包签名",
    ownership: "安装目录权限",
  };
  const describeDiagnostic = (item: Diagnostic) => {
    if (item.name === "installation" && item.result === "fail") {
      return {
        status: "未检测到安装",
        detail: "没有找到可维护的 Codex 标准版或免安装版。",
      };
    }
    if (item.name === "package signature" && item.result === "warn") {
      return {
        status: "已在安装前验证",
        detail: "免安装版提取后不再携带可独立验证的安装包签名。",
      };
    }
    if (item.result === "pass") {
      return { status: "正常", detail: "本项检查已通过。" };
    }
    if (item.result === "warn") {
      return { status: "需要留意", detail: "该项目不影响当前基本使用。" };
    }
    return { status: "检查失败", detail: "建议先修复安装后再次诊断。" };
  };
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="diagnostics-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagnostics-title"
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id="diagnostics-title">Codex 诊断结果</h2>
            <p>检测结果来自当前系统的 Codex 安装状态。</p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭诊断结果"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="diagnostics-list">
          {diagnostics.map((item) => {
            const presentation = describeDiagnostic(item);
            return (
              <article key={item.name} className={`is-${item.result}`}>
                <span aria-hidden="true">
                  {item.result === "pass" ? (
                    <CircleCheck size={18} />
                  ) : (
                    <CircleAlert size={18} />
                  )}
                </span>
                <div>
                  <b>{diagnosticNames[item.name] ?? item.name}</b>
                  <p>{presentation.detail}</p>
                </div>
                <strong>{presentation.status}</strong>
              </article>
            );
          })}
        </div>
        <footer>
          <button className="primary" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}
function Onboarding({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="onboarding">
      <div className="onboarding-brand">
        <img src={routeGateIcon} alt="" /> Chimera++
      </div>
      <h2>开始配置你的 Codex</h2>
      <p>
        已预填 Chimera 请求地址。填写密钥和模型，确认保存并切换后才会写入 Codex
        配置。
      </p>
      <ol>
        <li>
          <b>1</b>
          <div>
            <strong>添加线路</strong>
            <span>默认使用 Chimera 中转站，也支持自定义上游</span>
          </div>
        </li>
        <li>
          <b>2</b>
          <div>
            <strong>获取模型</strong>
            <span>从当前线路读取模型，也可手动填写</span>
          </div>
        </li>
        <li>
          <b>3</b>
          <div>
            <strong>保存并应用</strong>
            <span>立即切换到新的 Codex 线路</span>
          </div>
        </li>
      </ol>
      <button className="primary" onClick={onAdd}>
        开始配置
      </button>
    </section>
  );
}

function StandaloneOnboarding({
  onAdd,
  onSkip,
}: {
  onAdd: () => void;
  onSkip: () => void;
}) {
  return (
    <main className="onboarding-screen">
      <section className="onboarding onboarding-card">
        <div className="onboarding-brand">
          <img src={routeGateIcon} alt="" /> Chimera++
        </div>
        <h1>开始配置你的 Codex</h1>
        <p>
          只需填写一次 Chimera 中转站密钥，之后可在首页快速切换线路。Chimera++
          会自动识别本机 Codex 安装方式并同步模型列表。
        </p>
        <ol>
          <li>
            <b>1</b>
            <div>
              <strong>添加线路</strong>
              <span>默认使用 Chimera 中转站模板</span>
            </div>
          </li>
          <li>
            <b>2</b>
            <div>
              <strong>检测 Codex</strong>
              <span>识别标准安装或免安装版本</span>
            </div>
          </li>
          <li>
            <b>3</b>
            <div>
              <strong>完成设置</strong>
              <span>保存后即可快速切换</span>
            </div>
          </li>
        </ol>
        <footer>
          <button className="secondary" onClick={onSkip}>
            稍后配置
          </button>
          <button className="primary" onClick={onAdd}>
            开始配置
          </button>
        </footer>
        <small>Chimera++ 2.0 · 数据仅保存在本机</small>
      </section>
    </main>
  );
}
function Field({
  label,
  name,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        aria-describedby={hint ? `${name}-hint` : undefined}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {hint && <small id={`${name}-hint`}>{hint}</small>}
    </label>
  );
}
