import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
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
  ArrowUp,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleAlert,
  Command,
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
  Play,
  Plus,
  RefreshCw,
  Route,
  Search,
  Settings2,
  Trash2,
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
import { providersApi } from "@/lib/api/providers";
import { settingsApi } from "@/lib/api/settings";
import { configApi } from "@/lib/api";
import { vscodeApi } from "@/lib/api/vscode";
import { getCurrentVersion } from "@/lib/updater";
import { WindowControls } from "@/components/WindowControls";
import { useUpdate } from "@/contexts/UpdateContext";
import type { Settings } from "@/types";
import {
  detectCodexApiFormats,
  fetchModelsForConfig,
  type DetectedCodexApiFormat,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import { getChimeraHubTemplate } from "@/config/codexTemplates";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
  isCodexGoalModeEnabled,
  isCodexRemoteCompactionEnabled,
  setCodexBaseUrl,
  setCodexGoalMode,
  setCodexModelName,
  setCodexRemoteCompaction,
  setCodexWireApi,
} from "@/utils/providerConfigUtils";
import { generateUUID } from "@/utils/uuid";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  activityStorageKey,
  buildCodexModelCatalog,
  codexApprovalPolicyWarning,
  codexProbeModels,
  describeCodexDetectionFailure,
  extractCodexMappingRows,
  findCodexCatalogModelsWithoutProtocol,
  loadOperationRecords,
  persistedCodexModelApiFormats,
  pickDefaultFetchedModel,
  previousCatalogAsFetched,
  resolveCurrentProvider,
  saveOperationRecords,
  setCodexProviderApiKey,
  type ConnectionState,
  type OperationRecord,
} from "./chimeraUtils";
import { Empty } from "@/components/Empty";
import routeGateIcon from "@/assets/icons/chimera-dragon-mark.png";
import RouteGlobe from "@/components/RouteGlobe";
import "./chimera.css";

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
const AppearanceView = lazy(() => import("./views/AppearanceView"));
const SessionManagerPage = lazy(() =>
  import("./components/sessions/SessionManagerPage").then(
    ({ SessionManagerPage: page }) => ({
      default: page,
    }),
  ),
);

type View =
  "providers" | "runtime" | "usage" | "appearance" | "sessions" | "settings";
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
type CodexProcessStatus = {
  supported: boolean;
  installed: boolean;
  running: boolean;
  installMode?: string | null;
  officialLoginAvailable: boolean;
};
type CodexRendererUnlockProbe = {
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
type Capability = { id: string; enabledByDefault: boolean };
type ProductCapabilities = { capabilities: Capability[] };
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
  ["runtime", "更新", Package],
  ["usage", "词元", BarChart3],
  ["appearance", "外观", Paintbrush],
  ["sessions", "会话", MessagesSquare],
  ["settings", "设置", Settings2],
];

const viewLabels: Record<View, string> = Object.fromEntries(
  nav.map(([id, label]) => [id, label]),
) as Record<View, string>;

const runtimeText = (mode?: string | null) =>
  mode === "standard" ? "标准安装" : "免安装版";

const runtimeChannelText = (source?: string | null) =>
  source === "mirror" ? "镜像通道" : "稳定通道";

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

function codexApiFormatLabel(format: CodexApiFormat): string {
  if (format === "openai_responses") return "Responses";
  if (format === "openai_chat") return "Chat Completions";
  return "Anthropic Messages";
}

function providerDraft(provider?: Provider | null, suggestedName?: string) {
  const template = getChimeraHubTemplate();
  const config = String(provider?.settingsConfig?.config ?? template.config);
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

export default function ChimeraApp() {
  const [view, setView] = useState<View>("providers");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [currentSource, setCurrentSource] = useState<
    "live" | "stored" | "external" | "none"
  >("none");
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
  const [release, setRelease] = useState<ReleaseStatus | null>(null);
  const [editor, setEditor] = useState<ReturnType<typeof providerDraft> | null>(
    null,
  );
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
  const [fetchingModels, setFetchingModels] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [pendingAction, setPendingAction] =
    useState<PendingRuntimeAction | null>(null);
  const [runtimeOperation, setRuntimeOperation] =
    useState<RuntimeOperation | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [skinEnabled, setSkinEnabled] = useState(false);
  const [activity, setActivity] = useState<OperationRecord[]>([]);
  const activityKeyRef = useRef<string | null>(null);
  const startupProviderCheckRef = useRef(false);
  const startupRuntimeCheckRef = useRef(false);
  const fetchModelsSeqRef = useRef(0);
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

  const activeEndpointIdentity = editor ? codexEndpointIdentity(editor) : null;
  const activeProtocolIdentity = editor ? codexProtocolIdentity(editor) : null;

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    fetchModelsSeqRef.current += 1;
    setModels(null);
    setModelFetchIdentity(null);
    setModelFetchError(null);
    setModelPickerOpen(false);
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

  const openEditor = (draft: ReturnType<typeof providerDraft>) => {
    setModels(null);
    setModelFetchError(null);
    editorBaselineRef.current = editorDraftSignature(draft);
    setEditor(draft);
    setApiFormatDetection(detectionFromProvider(draft.original, draft));
  };

  const closeEditor = () => {
    editorBaselineRef.current = null;
    setPendingEditorDiscard(false);
    setEditor(null);
  };

  // Escape and backdrop clicks ask first when the draft has unsaved input.
  const requestCloseEditor = () => {
    const draft = editorRef.current;
    if (!draft) return;
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
    isChecking: titlebarChecking,
    isInstalling: titlebarInstalling,
    checkUpdate: titlebarCheckUpdate,
    installUpdate: titlebarInstallUpdate,
    resetDismiss: titlebarResetDismiss,
  } = useUpdate();

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

  const loadProviders = async () => {
    if (!runningInTauri) {
      const template = getChimeraHubTemplate();
      const previewProvider: Provider = {
        id: "preview-chimerahub",
        name: template.name,
        websiteUrl: template.websiteUrl,
        category: "custom",
        settingsConfig: { auth: template.auth, config: template.config },
      };
      setProviders([previewProvider]);
      setCurrentId(previewProvider.id);
      setCurrentSource("live");
      setLoading(false);
      return;
    }
    try {
      const [all, stored] = await Promise.all([
        providersApi.getAll("codex"),
        providersApi.getCurrent("codex"),
      ]);
      const sorted = Object.values(all).sort(
        (a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0),
      );
      let live: unknown = null;
      let liveReadSucceeded = false;
      try {
        live = await vscodeApi.getLiveProviderSettings("codex");
        liveReadSucceeded = true;
      } catch {
        // The stored selection remains useful when Codex has not created its config yet.
      }
      const resolution = resolveCurrentProvider(
        sorted,
        stored,
        live,
        liveReadSucceeded,
      );
      setProviders(sorted);
      setCurrentId(resolution.provider?.id ?? "");
      setCurrentSource(resolution.source);
      setLoadError(null);
    } catch (error) {
      setLoadError(String(error));
      toast.error("无法读取 Codex 供应商", { description: String(error) });
    } finally {
      setLoading(false);
    }
  };

  const retryLoadProviders = async () => {
    setLoading(true);
    await loadProviders();
  };

  const loadRuntime = async () => {
    if (!runningInTauri) {
      setRuntime({
        supported: true,
        installed: true,
        version: "26.721.41059",
        installMode: "standard",
        installPath: "预览模式 · 未访问本机文件",
        canRepair: true,
        canRollback: true,
        canUninstall: true,
      });
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
    if (!runningInTauri) {
      setRendererUnlock(null);
      return;
    }
    try {
      const probe = await invoke<CodexRendererUnlockProbe>(
        "probe_codex_renderer_unlock",
      );
      setRendererUnlock(probe);
    } catch {
      setRendererUnlock(null);
    }
  }, []);

  const loadCodexProcess = useCallback(async () => {
    if (!runningInTauri) {
      const status: CodexProcessStatus = {
        supported: true,
        installed: true,
        running: false,
        installMode: "standard",
        officialLoginAvailable: false,
      };
      codexProcessRef.current = status;
      setCodexProcess(status);
      setRendererUnlock(null);
      return status;
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
      setRendererUnlock(null);
      return status;
    }
  }, []);

  const openCodex = async () => {
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
      setSkinEnabled(true);
      void loadProviders();
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
    void loadProviders();
    void loadRuntime();
    void loadCodexProcess();
    void invoke<ProductCapabilities>("get_product_capabilities")
      .then((value) =>
        setSkinEnabled(
          value.capabilities.some(
            (item) => item.id === "codex_themes" && item.enabledByDefault,
          ),
        ),
      )
      .catch(() => setSkinEnabled(false));
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
          ? latestProcess.running
            ? "请重启 Codex 以载入官方登录配置"
            : "启动 Codex 即可继续使用 ChatGPT 官方账户"
          : latestProcess.running
            ? "请重启 Codex 以载入新线路"
            : undefined,
      });
    } catch (error) {
      note(
        "切换线路",
        "error",
        String(error),
        selectedProvider?.name ?? id,
        performance.now() - started,
      );
      toast.error("切换失败", { description: String(error) });
    }
  };

  const testConnection = async (
    baseUrl: string,
    providerName = "Codex",
    target: "home" | "draft" = "home",
  ) => {
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
      });
      note(
        "连接测试",
        "success",
        `${result.latency}ms`,
        providerName,
        performance.now() - started,
      );
      toast.success("连接可用", {
        description: `响应时间 ${result.latency}ms`,
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
    const current = providers.find((provider) => provider.id === currentId);
    if (!current) return;
    startupProviderCheckRef.current = true;
    void settingsApi
      .get()
      .then((settings) => {
        if (settings.checkProviderStatusOnStart === false) return;
        const endpoint = extractCodexBaseUrl(
          String(current.settingsConfig?.config ?? ""),
        );
        if (endpoint) void testConnection(endpoint, current.name);
      })
      .catch(() => {
        // Startup validation is optional and must never block the main window.
      });
  }, [currentId, loading, providers]);

  // `formatOverride` backs the "按 Chat / Responses / Anthropic 保存" quick
  // actions shown when detection fails: the choice is applied to the draft and
  // saved in one step, so a failed probe never strands the user.
  const saveProvider = async (formatOverride?: CodexApiFormat) => {
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
      !draft.apiKey.trim() ||
      !draft.model.trim()
    ) {
      toast.error("请填写线路名称、API 请求地址、API Key 和默认模型");
      return;
    }

    if (providerSaveInFlightRef.current) return;
    providerSaveInFlightRef.current = true;
    setSavingProvider(true);
    setModelPickerOpen(false);

    try {
      const endpointIdentity = codexEndpointIdentity(draft);
      const protocolIdentity = codexProtocolIdentity(draft);
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
      const probeRows = probeModels.map((model) => ({ model }));
      const modelRoutes = draft.original?.meta?.codexModelRoutes;
      let detectedFormats: Record<string, DetectedCodexApiFormat> = {};
      const catalogModels = buildCodexModelCatalog(
        draft.model,
        draft.catalogModels,
        fetchedForSave,
      );
      if (draft.apiFormat === "auto") {
        const cached =
          apiFormatDetection?.identity === protocolIdentity
            ? apiFormatDetection
            : null;
        detectedFormats = { ...cached?.formats };
        let failures: Record<string, string> = { ...cached?.failures };
        // Results persisted with the provider or produced by an earlier probe
        // are reused; only models still unknown for this identity are probed.
        const pendingModels = findCodexCatalogModelsWithoutProtocol(
          probeRows,
          detectedFormats,
          modelRoutes,
        );
        if (pendingModels.length > 0) {
          const seq = ++protocolProbeSeqRef.current;
          setFetchingModels(true);
          setApiFormatDetectionError(null);
          try {
            const report = await detectCodexApiFormats(
              draft.baseUrl,
              draft.apiKey,
              pendingModels,
              draft.isFullUrl,
              draft.customUserAgent.trim() || undefined,
            );
            if (
              seq !== protocolProbeSeqRef.current ||
              editorRef.current !== draft
            ) {
              toast.info("线路配置已变化，请重新保存");
              return;
            }
            detectedFormats = { ...detectedFormats, ...report.detected };
            failures = { ...failures, ...report.failures };
            for (const model of Object.keys(report.detected)) {
              delete failures[model];
            }
          } catch (error) {
            if (
              seq !== protocolProbeSeqRef.current ||
              editorRef.current !== draft
            ) {
              toast.info("线路配置已变化，请重新保存");
              return;
            }
            const reason = String(error);
            for (const model of pendingModels) failures[model] = reason;
          } finally {
            if (seq === protocolProbeSeqRef.current) setFetchingModels(false);
          }
          setApiFormatDetection({
            identity: protocolIdentity,
            formats: detectedFormats,
            failures,
          });
        }
        const defaultDetection = detectedFormats[draft.model.trim()];
        if (!defaultDetection) {
          setApiFormatDetectionError(
            "未能识别默认模型的上游协议。可查看下方原因后重试，或直接按指定协议保存。",
          );
          toast.error("无法自动识别上游 API 协议", {
            description:
              failures[draft.model.trim()] ??
              "请查看编辑器中的失败原因，或按 Chat / Responses / Anthropic 保存。",
          });
          return;
        }
        resolvedApiFormat = defaultDetection.apiFormat;
        resolvedAnthropicAuthField =
          defaultDetection.anthropicAuthField ?? draft.anthropicAuthField;
        setApiFormatDetectionError(null);
        // Mapping rows that stayed undetected no longer block the save: they
        // follow the default protocol and are listed so the user can fix them.
        const undetectedMappedModels = findCodexCatalogModelsWithoutProtocol(
          probeRows,
          detectedFormats,
          modelRoutes,
        );
        if (undetectedMappedModels.length > 0) {
          toast.warning(
            `${undetectedMappedModels.length} 个映射模型未识别协议，将沿用 ${codexApiFormatLabel(resolvedApiFormat)}`,
            { description: undetectedMappedModels.join("、") },
          );
        }
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
      config = setCodexRemoteCompaction(
        config,
        draft.remoteCompactionEnabled,
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
      try {
        if (draft.original) {
          // "保存并应用" must not leave an edited inactive provider behind if
          // its activation fails. The backend updates, switches and compensates
          // under one transaction using its own current pointer.
          await providersApi.updateAndActivate(
            provider,
            "codex",
            draft.original.id,
          );
        } else {
          await providersApi.addAndActivate(provider, "codex", false);
        }
        if (commonConfigLoaded && commonConfigDirty) {
          await configApi.setCommonConfigSnippet("codex", commonConfigSnippet);
        }
        // 文件级校验失败才算真错（目录没写对）；运行时交叉验证跑不起来只是
        // 环境限制（如 macOS 图形进程 PATH 里没有 node），不该报成保存失败。
        let catalogStatus: CodexModelCatalogStatus | null = null;
        try {
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
        } catch (error) {
          await loadProviders();
          closeEditor();
          note("应用模型目录", "error", String(error), provider.name);
          toast.error("线路已保存，但模型目录未正确应用", {
            description: String(error),
          });
          return;
        }
        await loadProviders();
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
        toast.error("保存失败", { description: String(error) });
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
    setCommonConfigLoading(true);
    setCommonConfigLoaded(false);
    setCommonConfigDirty(false);
    void configApi
      .getCommonConfigSnippet("codex")
      .then((snippet) => {
        setCommonConfigSnippet(snippet ?? "");
        setCommonConfigLoaded(true);
      })
      .catch(() => setCommonConfigSnippet(""))
      .finally(() => setCommonConfigLoading(false));
  }, [editor?.id]);

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

      if (latest.apiFormat !== "auto") {
        toast.success(`已获取 ${result.length} 个模型`);
        return;
      }

      // Probe the default model plus the mapping rows only — never the whole
      // fetched list, which on aggregators always contains models that fail.
      const probeModels = codexProbeModels(latest.model, latest.catalogModels);
      const probeModel = probeModels[0];
      const probeIdentity = codexProtocolIdentity(latest);
      const probeSeq = ++protocolProbeSeqRef.current;
      try {
        const report = await detectCodexApiFormats(
          latest.baseUrl,
          latest.apiKey,
          probeModels,
          latest.isFullUrl,
          latest.customUserAgent.trim() || undefined,
        );
        const current = editorRef.current;
        if (
          probeSeq !== protocolProbeSeqRef.current ||
          !current ||
          current.id !== latest.id ||
          current.apiFormat !== "auto" ||
          codexProtocolIdentity(current) !== probeIdentity
        ) {
          return;
        }
        const detectedFormats = report.detected;
        setApiFormatDetection({
          identity: probeIdentity,
          formats: detectedFormats,
          failures: report.failures,
        });
        const detected = detectedFormats[probeModel];
        if (!detected) {
          setApiFormatDetectionError(
            "模型已获取，但未能识别默认模型的上游协议。可查看下方原因后重试，或直接按指定协议保存。",
          );
          toast.warning(`已获取 ${result.length} 个模型，但协议识别失败`, {
            description: report.failures[probeModel],
          });
          return;
        }
        setApiFormatDetectionError(null);
        if (detected.anthropicAuthField) {
          setEditor((currentEditor) =>
            currentEditor &&
            currentEditor.id === latest.id &&
            currentEditor.apiFormat === "auto" &&
            codexProtocolIdentity(currentEditor) === probeIdentity
              ? {
                  ...currentEditor,
                  anthropicAuthField: detected.anthropicAuthField!,
                }
              : currentEditor,
          );
        }
        const failedCount = Object.keys(report.failures).length;
        toast.success(
          `已获取 ${result.length} 个模型，并识别 ${Object.keys(detectedFormats).length} 个模型的上游协议`,
          failedCount
            ? {
                description: `${failedCount} 个映射模型未识别，保存时沿用默认协议。`,
              }
            : undefined,
        );
      } catch (error) {
        if (probeSeq !== protocolProbeSeqRef.current) return;
        console.warn("[CODEX_API_FORMAT_AUTO_DETECT_FAILED]", error);
        setApiFormatDetection(null);
        setApiFormatDetectionError(
          "模型已获取，但无法自动识别协议。请重试或手动选择协议。",
        );
        toast.warning(`已获取 ${result.length} 个模型，但协议识别失败`, {
          description: String(error),
        });
      }
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
      <main className="chimera-main">
        <header
          className="chimera-titlebar"
          onMouseDown={handleTitlebarMouseDown}
          onDoubleClick={preventTitlebarDoubleClick}
        >
          <div className="route-brand">
            <span className="route-brand-mark">
              <img src={routeGateIcon} alt="" />
            </span>
            <strong>Chimera++</strong>
          </div>
          <div className="route-page-label">
            <span className="status-dot" />
            {viewLabels[view]}
          </div>
          <div className="route-window-tools" data-tauri-no-drag>
            <button
              className={`titlebar-update${titlebarHasUpdate ? " is-available" : ""}`}
              aria-label={
                titlebarInstalling
                  ? "正在安装更新"
                  : titlebarChecking
                    ? "正在检查更新"
                    : titlebarHasUpdate
                      ? `下载并安装 Chimera++ ${titlebarUpdateInfo?.availableVersion ?? "更新"}`
                      : "检查更新"
              }
              title={
                titlebarInstalling
                  ? "正在安装更新…"
                  : titlebarChecking
                    ? "正在检查更新…"
                    : titlebarHasUpdate
                      ? `下载并安装 Chimera++ ${titlebarUpdateInfo?.availableVersion ?? "更新"}`
                      : "检查更新"
              }
              disabled={titlebarChecking || titlebarInstalling}
              onClick={() => void runTitlebarUpdateCheck()}
            >
              {titlebarChecking || titlebarInstalling ? (
                <LoaderCircle size={16} className="spin" />
              ) : titlebarHasUpdate ? (
                <Download size={16} />
              ) : (
                <ArrowUp size={16} />
              )}
            </button>
            <WindowControls />
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
              onAdd={() =>
                openEditor(
                  providerDraft(null, providers.length ? "新线路" : "默认线路"),
                )
              }
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
                <SessionManagerPage appId="all" />
              </div>
            )}
            {view === "settings" && <NewSettingsView />}
          </Suspense>
        </section>
        <nav className="route-bottom-nav" aria-label="主导航">
          {nav.map(([id, label, Icon]) => (
            <button
              key={id}
              className={view === id ? "is-active" : ""}
              aria-current={view === id ? "page" : undefined}
              onClick={() => setView(id)}
            >
              <span>
                <Icon size={16} />
              </span>
              <small>{label}</small>
            </button>
          ))}
        </nav>
        {editor && (
          <div
            className="provider-sheet-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (savingProvider) return;
              if (event.target === event.currentTarget) requestCloseEditor();
            }}
          >
            <ProviderEditor
              editor={editor}
              setEditor={(value) => {
                if (!savingProvider) setEditor(value);
              }}
              showKey={showKey}
              setShowKey={setShowKey}
              fetchingModels={fetchingModels}
              savingProvider={savingProvider}
              modelFetchError={modelFetchError}
              apiFormatDetection={apiFormatDetection}
              apiFormatDetectionError={apiFormatDetectionError}
              commonConfigSnippet={commonConfigSnippet}
              commonConfigLoading={commonConfigLoading}
              commonConfigLoaded={commonConfigLoaded}
              onCommonConfigChange={(value) => {
                if (savingProvider) return;
                setCommonConfigSnippet(value);
                setCommonConfigDirty(true);
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
            try {
              await providersApi.delete(pendingProviderDelete.id, "codex");
              await loadProviders();
              setPendingProviderDelete(null);
              closeEditor();
              toast.success("线路已删除");
            } catch (error) {
              toast.error("删除失败", { description: String(error) });
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
              setPendingModelReload(null);
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
  onRuntimeChanged?: (
    preferences?: RuntimeUpdatePreferences,
  ) => void | Promise<void>;
}) {
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [installMode, setInstallMode] = useState<"standard" | "portable">(
    "standard",
  );
  const [updateSource, setUpdateSource] = useState<"auto" | "mirror">("auto");
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
    if (!pendingPlan) return;
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
    setMaintenanceOpen(false);
    onAction(action, preferences);
  };
  const selectedPreferences: RuntimeUpdatePreferences = {
    source: updateSource,
    installMode,
  };
  const checkSelectedRuntime = () => onCheck(selectedPreferences);
  const runDiagnostics = () => {
    setMaintenanceOpen(false);
    onDiagnose();
  };
  const operationLabel = progress
    ? progress.stage === "installing"
      ? "正在校验并安装，请勿关闭窗口"
      : `正在下载 ${percent}%`
    : operation?.action === "uninstall"
      ? "正在卸载 Codex，请稍候"
      : operation?.action === "rollback"
        ? "正在恢复上一版本，请稍候"
        : operation
          ? "正在准备操作，请稍候"
          : null;
  useEffect(() => {
    setInstallMode(
      runtime?.installMode === "portable" ? "portable" : "standard",
    );
    setUpdateSource(release?.source === "mirror" ? "mirror" : "auto");
  }, [runtime?.installMode, release?.source]);
  const saveRuntimePreference = async (patch: Partial<Settings>) => {
    if (!runningInTauri) return;
    try {
      const current = await settingsApi.get();
      await settingsApi.save({ ...current, ...patch });
      toast.success("更新偏好已保存");
    } catch (reason) {
      toast.error("保存更新偏好失败", { description: String(reason) });
    }
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
      <section className="runtime-reference-view">
        <span className="eyebrow">CODEX 更新</span>
        <h1>
          {runtimeSupported
            ? "本机 Codex 已准备就绪"
            : "Codex 更新管理仅支持 Windows"}
        </h1>
        <div className="runtime-ring">
          <div>
            <CircleCheck size={28} />
            <code>{version}</code>
            <small>
              {!runtimeSupported
                ? "macOS 可正常切换官方账户与中转线路"
                : runtime?.installed
                  ? `${runtimeText(runtime.installMode)} · ${runtimeChannelText(release?.source)}`
                  : "未检测到安装"}
            </small>
          </div>
        </div>
        <div className="runtime-info-strip">
          <div>
            <FolderOpen size={16} />
            <span>
              安装位置
              <b>
                {!runtimeSupported
                  ? "不适用"
                  : runtime?.installed
                    ? "已识别"
                    : "未检测到"}
              </b>
            </span>
          </div>
          <div>
            <Download size={16} />
            <span>
              更新通道
              <b>{runtimeChannelText(release?.source)}</b>
            </span>
          </div>
          <div>
            <Activity size={16} />
            <span>
              自动检查<b>已开启</b>
            </span>
          </div>
        </div>
        {recovery.length > 0 && (
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
        <div className="runtime-reference-actions">
          <button
            className={updateAvailable ? "primary" : "secondary"}
            onClick={() =>
              updateAvailable
                ? startAction("update", selectedPreferences)
                : checkSelectedRuntime()
            }
            disabled={!runtimeSupported || Boolean(operation)}
          >
            {updateAvailable ? <Download size={14} /> : <RefreshCw size={14} />}
            {updateActionLabel}
          </button>
          <button
            className="secondary"
            onClick={() => void openInstallDirectory()}
            disabled={
              !runtimeSupported || !runtime?.installed || Boolean(operation)
            }
          >
            <FolderOpen size={14} />
            打开安装目录
          </button>
          <button
            className="secondary"
            onClick={() => setMaintenanceOpen(true)}
            disabled={!runtimeSupported || Boolean(operation)}
          >
            <Settings2 size={14} />
            安装方式与更新源
          </button>
        </div>
        {updateAvailable && release && (
          <div
            className="runtime-update-ready"
            role="status"
            aria-live="polite"
          >
            <CircleCheck size={16} aria-hidden="true" />
            <span>
              <b>Codex {release.latestVersion} 可用</b>
              <small>
                {selectedInstallLabel}
                {release.sizeBytes > 0
                  ? ` · ${(release.sizeBytes / 1024 / 1024).toFixed(1)} MB`
                  : ""}
                {" · 点击上方按钮后确认下载并安装"}
              </small>
            </span>
            <button
              type="button"
              className="runtime-update-recheck"
              onClick={checkSelectedRuntime}
              disabled={Boolean(operation)}
            >
              重新检查
            </button>
          </div>
        )}
        {operationLabel && (
          <div className="runtime-reference-progress">
            <span>{operationLabel}</span>
            <i>
              <u
                className={
                  !progress || progress.stage === "installing"
                    ? "is-indeterminate"
                    : ""
                }
                style={{ width: progress ? `${percent}%` : "38%" }}
              />
            </i>
          </div>
        )}
      </section>
      {maintenanceOpen && (
        <div
          className="provider-sheet-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMaintenanceOpen(false);
          }}
        >
          <section
            className="runtime-maintenance-drawer"
            aria-label="安装与维护"
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
                <X size={18} />
              </button>
            </header>
            <div className="runtime-maintenance-content">
              <b>安装方式</b>
              <button
                className={`runtime-mode-card ${installMode === "standard" ? "is-active" : ""}`}
                onClick={() => {
                  setInstallMode("standard");
                  void saveRuntimePreference({ codexInstallMode: "standard" });
                }}
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
                onClick={() => {
                  setInstallMode("portable");
                  void saveRuntimePreference({ codexInstallMode: "portable" });
                }}
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
                  onClick={() => {
                    setUpdateSource("auto");
                    void saveRuntimePreference({ codexUpdateSource: "auto" });
                  }}
                >
                  自动选择
                </button>
                <button
                  className={updateSource === "mirror" ? "is-active" : ""}
                  onClick={() => {
                    setUpdateSource("mirror");
                    void saveRuntimePreference({ codexUpdateSource: "mirror" });
                  }}
                >
                  镜像安装
                </button>
              </div>
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
                  disabled={!runtime?.canRepair}
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
                  disabled={!runtime?.canRollback}
                >
                  <RefreshCw size={16} />
                  <span>
                    <strong>回滚</strong>
                    <small>恢复上一个可用版本</small>
                  </span>
                  <ChevronDown size={15} />
                </button>
                <button onClick={openHistory} disabled={Boolean(operation)}>
                  <Activity size={16} />
                  <span>
                    <strong>安装历史版本</strong>
                    <small>从镜像发布目录选择并锁定指定版本</small>
                  </span>
                  <ChevronDown size={15} />
                </button>
                <button
                  onClick={() => void pickOfflinePackage()}
                  disabled={Boolean(operation) || inspectingOffline}
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
                  disabled={!runtime?.canUninstall}
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
              disabled={Boolean(operation)}
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
  onAdd,
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
  onSwitch: (id: string) => Promise<void>;
  onEdit: (provider: Provider) => void;
  onAdd: () => void;
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
  const [query, setQuery] = useState("");
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const managerTriggerRef = useRef<HTMLButtonElement>(null);
  const routeLineScrollRef = useRef<HTMLDivElement>(null);
  const [routeLineScrollState, setRouteLineScrollState] = useState({
    previous: false,
    next: false,
  });
  const syncRouteLineScrollControls = useCallback(() => {
    const element = routeLineScrollRef.current;
    const nextState = element
      ? {
          previous: element.scrollLeft > 1,
          next:
            element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
        }
      : { previous: false, next: false };
    setRouteLineScrollState((currentState) =>
      currentState.previous === nextState.previous &&
      currentState.next === nextState.next
        ? currentState
        : nextState,
    );
  }, []);
  const scrollRouteLines = useCallback((direction: -1 | 1) => {
    const element = routeLineScrollRef.current;
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(200, element.clientWidth * 0.7),
      behavior: "smooth",
    });
  }, []);
  useEffect(() => {
    const element = routeLineScrollRef.current;
    if (!element) return;
    syncRouteLineScrollControls();
    element.addEventListener("scroll", syncRouteLineScrollControls, {
      passive: true,
    });
    const observer = new ResizeObserver(syncRouteLineScrollControls);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", syncRouteLineScrollControls);
      observer.disconnect();
    };
  }, [providers.length, syncRouteLineScrollControls]);
  const managerRef = useDialogFocus<HTMLElement>(
    () => setManagerOpen(false),
    managerOpen,
    managerTriggerRef,
  );
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
        name = "官方账户";
      } else if (!generic) {
        name = provider.name || "未命名线路";
      } else if (!chimera) {
        name = "默认线路";
      } else {
        const index = chimeraIds.indexOf(provider.id);
        name =
          index <= 0
            ? "默认线路"
            : index === 1
              ? "备用线路"
              : `线路 ${index + 1}`;
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
  if (loading) return <Empty label="正在读取线路…" />;
  if (!providers.length) return <Onboarding onAdd={onAdd} />;
  const current =
    providers.find((provider) => provider.id === currentId) ?? providers[0];
  const currentIsOfficial =
    current.id === "codex-official" || current.category === "official";
  const officialLoginRequired =
    currentIsOfficial && codexProcess?.officialLoginAvailable === false;
  const model =
    extractCodexModelName(String(current.settingsConfig?.config ?? "")) ||
    "未设置";
  const connectionLabel =
    connection.kind === "connected"
      ? `已连接 · ${connection.message}`
      : connection.kind === "checking"
        ? "测试中"
        : connection.kind === "error"
          ? "连接失败"
          : currentSource === "live"
            ? "配置已识别"
            : "等待测试";
  const isOfficialLine = (provider: Provider) =>
    lineLabels.get(provider.id)?.official ??
    (provider.id === "codex-official" || provider.category === "official");
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
  const railLines = [...providers].sort((a, b) => {
    if (isOfficialLine(a) !== isOfficialLine(b)) {
      return isOfficialLine(a) ? -1 : 1;
    }
    return 0;
  });
  const activateLine = async (provider: Provider) => {
    if (provider.id === current.id || switchingId) return;
    setSwitchingId(provider.id);
    try {
      await onSwitch(provider.id);
    } finally {
      setSwitchingId(null);
    }
  };
  const globeStageLabel =
    connection.kind === "connected"
      ? "连接稳定"
      : connection.kind === "checking"
        ? "正在检测"
        : connection.kind === "error"
          ? "连接异常"
          : "等待检测";
  const rendererUnlockPending =
    codexProcess?.running === true &&
    rendererUnlock != null &&
    rendererUnlock.attachable === false;
  const codexStatusLabel =
    codexProcess === null
      ? "正在检测 Codex"
      : !codexProcess.supported
        ? "macOS 暂不支持快速启动"
        : !codexProcess.installed
          ? "未检测到 Codex"
          : officialLoginRequired
            ? "官方账户需要登录"
            : codexProcess.running
              ? rendererUnlockPending
                ? "Codex 运行中 · 模型列表未解锁"
                : rendererUnlock?.attachable === true &&
                    rendererUnlock.injected === false
                  ? "Codex 运行中 · 模型列表待刷新"
                  : "Codex 正在运行"
              : "Codex 已就绪";
  const codexButtonLabel = launchingCodex
    ? "正在启动…"
    : codexProcess === null
      ? "正在检测…"
      : codexProcess?.supported === false
        ? "仅 Windows 支持"
        : codexProcess?.installed === false
          ? "尚未安装"
          : restartRequired && codexProcess?.running
            ? officialLoginRequired
              ? "重启并登录"
              : "重启 Codex"
            : officialLoginRequired
              ? "启动并登录"
              : codexProcess?.running
                ? rendererUnlockPending || !rendererUnlock
                  ? "重启解锁"
                  : "打开 Codex"
                : "启动 Codex";
  return (
    <section className="route-gate-view route-gate-reference">
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
                  ? "安装包已在后台下载完毕，点击即可安装并重启。"
                  : "已通过签名验证，更新后将自动重启。"}
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
      <div className="route-map" aria-label="当前 Codex 连接状态">
        <code className="route-stage-label">{globeStageLabel}</code>
        <div className="route-globe-stage">
          <RouteGlobe className="route-globe-art" />
          <div
            className={`route-codex-launch${codexProcess?.running ? " is-running" : ""}${codexProcess?.supported === false || codexProcess?.installed === false ? " is-missing" : ""}`}
            aria-live="polite"
          >
            <div className="route-codex-launch-status">
              <i aria-hidden="true" />
              <span>
                <b>{codexStatusLabel}</b>
                <code title={model}>当前模型 · {model}</code>
              </span>
            </div>
            {rendererUnlockPending && (
              <p className="route-codex-unlock-hint">
                当前 Codex 为手动启动，模型列表未解锁。点击「重启解锁」通过
                Chimera++ 重新启动，即可在桌面端模型选择器显示全部自定义模型。
              </p>
            )}
            {codexProcess?.running === true &&
              rendererUnlock?.attachable === true &&
              rendererUnlock.injected === false && (
                <p className="route-codex-unlock-hint">
                  模型解锁已附加，正在等待 Codex 刷新模型列表…
                </p>
              )}
            <button
              type="button"
              onClick={() => void onOpenCodex()}
              disabled={
                launchingCodex ||
                codexProcess === null ||
                codexProcess?.supported === false ||
                codexProcess?.installed === false
              }
            >
              {launchingCodex ? (
                <LoaderCircle className="spin" size={16} aria-hidden="true" />
              ) : (
                <Play size={16} fill="currentColor" aria-hidden="true" />
              )}
              <span>{codexButtonLabel}</span>
            </button>
          </div>
        </div>
        <div className="route-line-switcher">
          <header className="route-line-heading">
            <div>
              <b>线路切换</b>
              <span>{providers.length} 条可用</span>
            </div>
            <button
              ref={managerTriggerRef}
              type="button"
              aria-label="管理线路"
              onClick={() => setManagerOpen(true)}
            >
              管理线路 <span aria-hidden="true">→</span>
            </button>
          </header>
          <div className="route-line-rail">
            <div className="route-line-scroll-shell">
              <button
                type="button"
                className="route-line-scroll-arrow is-previous"
                aria-label="显示上一条线路"
                disabled={!routeLineScrollState.previous}
                onClick={() => scrollRouteLines(-1)}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <div
                ref={routeLineScrollRef}
                className="route-line-scroll"
                role="list"
                aria-label="线路"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    scrollRouteLines(-1);
                  } else if (event.key === "ArrowRight") {
                    event.preventDefault();
                    scrollRouteLines(1);
                  }
                }}
              >
                {railLines.map((provider) => {
                  const active = provider.id === current.id;
                  const switching = switchingId === provider.id;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      className={`route-line-card${active ? " is-active" : ""}`}
                      aria-pressed={active}
                      aria-label={`${lineName(provider)}，${lineSource(provider)}${active ? "，当前线路" : ""}`}
                      onClick={() => void activateLine(provider)}
                    >
                      <span className="route-line-mark" aria-hidden="true">
                        {switching ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          lineMark(provider)
                        )}
                      </span>
                      <span className="route-line-copy">
                        <b>
                          {active && <i aria-hidden="true" />}
                          {lineName(provider)}
                        </b>
                        <small>{lineSource(provider)}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="route-line-scroll-arrow is-next"
                aria-label="显示下一条线路"
                disabled={!routeLineScrollState.next}
                onClick={() => scrollRouteLines(1)}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
            <button type="button" className="route-line-add" onClick={onAdd}>
              <span aria-hidden="true">
                <Plus size={18} />
              </span>
              添加线路
            </button>
          </div>
        </div>
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
                  <p>切换、编辑或添加 Codex 线路</p>
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
                  const active = provider.id === current.id;
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
                        <button
                          type="button"
                          className="route-line-edit"
                          aria-label={`编辑${lineName(provider)}`}
                          onClick={() => {
                            setManagerOpen(false);
                            onEdit(provider);
                          }}
                        >
                          <Pencil size={15} />
                        </button>
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
      </div>
      <div className="route-meta">
        <span>
          当前模型：<code>{model}</code>
        </span>
        <span>
          连接状态：
          <b className={connection.kind === "error" ? "error" : "ok"}>
            {connectionLabel}
          </b>
        </span>
      </div>
    </section>
  );
}

function ProviderEditor({
  editor,
  setEditor,
  showKey,
  setShowKey,
  fetchingModels,
  savingProvider,
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
}: {
  editor: ReturnType<typeof providerDraft>;
  setEditor: (value: ReturnType<typeof providerDraft> | null) => void;
  showKey: boolean;
  setShowKey: (value: boolean) => void;
  fetchingModels: boolean;
  savingProvider: boolean;
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
}) {
  const [commonConfigOpen, setCommonConfigOpen] = useState(false);
  const [openReasoningRow, setOpenReasoningRow] = useState<number | null>(null);
  const [openInstructionsRow, setOpenInstructionsRow] = useState<number | null>(
    null,
  );
  const dialogRef = useDialogFocus<HTMLElement>(
    onRequestClose,
    !escapeDisabled,
  );
  const patch = (key: string, value: string) =>
    setEditor({ ...editor, [key]: value });
  const detectedDefaultFormat =
    apiFormatDetection?.formats[editor.model.trim()] ?? null;
  // Only the models this line actually probes are worth explaining; a fetched
  // catalog entry that failed is corrected by the router at request time.
  const detectionFailures = useMemo(() => {
    if (!apiFormatDetection) return [];
    return codexProbeModels(editor.model, editor.catalogModels)
      .filter((model) => !apiFormatDetection.formats[model])
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
      ref={dialogRef}
      className="provider-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="provider-editor-title"
      tabIndex={-1}
    >
      <header>
        <span className="provider-editor-mark">
          {(editor.name || "C").slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h2 id="provider-editor-title">
            {editor.name || (editor.original ? "线路" : "新线路")}
          </h2>
          <p>保存后会写入 Codex，并成为一条可快速切换的线路。</p>
        </div>
      </header>
      <div className="editor-form">
        {!editor.original && (
          <div className="provider-template" role="status">
            <div>
              <b>Chimera 中转站默认模板</b>
              <small>已填入 Responses 地址和默认模型；只需粘贴 API Key。</small>
            </div>
            <button
              type="button"
              className="secondary compact"
              onClick={() => {
                // Restoring the template replaces catalogModels wholesale;
                // collapse any index-addressed panel for the same reason
                // add/delete do above.
                setOpenReasoningRow(null);
                setOpenInstructionsRow(null);
                setEditor(providerDraft(null, editor.name || "新线路"));
              }}
            >
              恢复模板
            </button>
          </div>
        )}
        <Field
          label="线路名称"
          name="provider-name"
          value={editor.name}
          onChange={(value) => patch("name", value)}
          placeholder="例如 默认线路或备用线路"
        />
        <Field
          label="官网链接"
          name="provider-website"
          value={editor.websiteUrl}
          onChange={(value) => patch("websiteUrl", value)}
          placeholder="https://example.com"
        />
        <Field
          label="API 请求地址"
          name="provider-base-url"
          value={editor.baseUrl}
          onChange={(value) => patch("baseUrl", value)}
          placeholder="https://api.example.com/v1"
          hint="Chimera 中转站和自定义线路都可编辑 URL。"
        />
        <label>
          API Key
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
        </label>
        <label>
          默认模型
          <div className="model-input">
            <input
              name="provider-model"
              autoComplete="off"
              spellCheck={false}
              value={editor.model}
              onChange={(event) => patch("model", event.target.value)}
              placeholder="先获取模型列表，或手动输入"
            />
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
          </div>
        </label>
        <details className="advanced-options">
          <summary>高级选项</summary>
          <div className="advanced-options-body">
            <p className="advanced-intro">
              按需开启 Codex 功能或调整兼容参数。保存后只对这条线路生效。
            </p>
            <div className="advanced-group codex-feature-options">
              <div className="advanced-section-heading">
                <div>
                  <b>Codex 功能</b>
                  <small>每条线路独立保存，未开启的功能不会写入配置。</small>
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
              <label className="toggle-field">
                <span>
                  <b>
                    远程上下文压缩
                    <em className="experimental-tag">实验性</em>
                  </b>
                  <small>让兼容线路尝试由上游压缩长对话，默认关闭。</small>
                </span>
                <input
                  name="provider-remote-compaction"
                  type="checkbox"
                  checked={editor.remoteCompactionEnabled}
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
                    供应商地址、密钥、模型和模型目录不会作为通用配置共享。
                  </small>
                  {commonConfigWarning && (
                    <small className="error-text">{commonConfigWarning}</small>
                  )}
                </label>
              )}
            </div>
            <label>
              上游格式
              <select
                name="provider-api-format"
                value={editor.apiFormat}
                onChange={(event) =>
                  patch(
                    "apiFormat",
                    event.target.value as CodexApiFormatSelection,
                  )
                }
              >
                <option value="auto">自动检测（获取模型后识别）</option>
                <option value="openai_responses">Responses（明确指定）</option>
                <option value="openai_chat">
                  Chat Completions（明确指定，需路由接管）
                </option>
                <option value="anthropic">
                  Anthropic Messages（明确指定，需路由接管）
                </option>
              </select>
              <small>
                自动模式会在获取模型后或保存前主动识别协议，再据此决定是否开启本地路由；不会把首次真实请求当作常规探测。
              </small>
              {editor.apiFormat === "auto" && detectedDefaultFormat && (
                <small>
                  已识别：{codexApiFormatLabel(detectedDefaultFormat.apiFormat)}
                  {detectedDefaultFormat.apiFormat === "openai_responses"
                    ? "（可直连；若启用代理专属功能仍会自动开启路由）"
                    : "（保存后自动开启路由）"}
                </small>
              )}
              {editor.apiFormat === "auto" && apiFormatDetectionError && (
                <small className="error-text">{apiFormatDetectionError}</small>
              )}
              {editor.apiFormat === "auto" && detectionFailures.length > 0 && (
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
                      ["openai_responses", "openai_chat", "anthropic"] as const
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
            </label>
            <div className="advanced-group">
              <label className="toggle-field">
                <span>
                  <b>完整 API 地址</b>
                  <small>地址已含完整请求路径时开启，不再自动补全路径。</small>
                </span>
                <input
                  name="provider-full-url"
                  type="checkbox"
                  checked={editor.isFullUrl}
                  onChange={(event) =>
                    setEditor({ ...editor, isFullUrl: event.target.checked })
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
                  onChange={(event) => patch("modelsUrl", event.target.value)}
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
                    <small>仅当上游明确要求 Claude Code 请求特征时开启。</small>
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
                    checked={editor.codexChatReasoning.supportsEffort === true}
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
            <div className="advanced-group model-mapping">
              <div className="advanced-section-heading">
                <div>
                  <b>模型映射</b>
                  <small>
                    菜单显示名与实际请求模型可不同；留空则直接使用默认模型。
                  </small>
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
                <span>菜单显示名</span>
                <span>实际请求模型</span>
                <span>上下文</span>
                <span>思考等级</span>
                <span aria-hidden="true" />
                <span aria-hidden="true" />
              </div>
              {editor.catalogModels.map((item, index) => (
                // Rows are only ever appended or removed, never reordered
                // (no drag-and-drop here), so the positional index is a
                // stable key. Keying on `item.model` instead broke the
                // "实际请求模型" input: every keystroke changed the key,
                // which made React remount the row and drop input focus.
                <div className="mapping-row" key={index}>
                  <input
                    aria-label="模型显示名"
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
                  <input
                    aria-label="实际请求模型"
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
                  <input
                    aria-label="上下文窗口"
                    type="number"
                    min="1"
                    inputMode="numeric"
                    value={item.contextWindow ?? ""}
                    onChange={(event) => {
                      const catalogModels = [...editor.catalogModels];
                      catalogModels[index] = {
                        ...item,
                        contextWindow: event.target.value.replace(/[^\d]/g, ""),
                      };
                      setEditor({ ...editor, catalogModels });
                    }}
                    placeholder="上下文"
                  />
                  <button
                    type="button"
                    className="reasoning-trigger"
                    aria-label="思考等级"
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
                        : "留空"}
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
                  <button
                    type="button"
                    className={
                      "instructions-trigger" +
                      (item.baseInstructions?.trim() ? " has-value" : "")
                    }
                    aria-label="系统提示词"
                    aria-expanded={openInstructionsRow === index}
                    title="系统提示词 / Base Instructions"
                    onClick={() =>
                      setOpenInstructionsRow(
                        openInstructionsRow === index ? null : index,
                      )
                    }
                  >
                    <FileText size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="删除模型映射"
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
                  {openReasoningRow === index && (
                    <div className="reasoning-panel">
                      <div className="reasoning-panel-head">
                        支持等级（可多选）
                      </div>
                      <div className="reasoning-checkboxes">
                        {CODEX_REASONING_LEVELS.map((level) => {
                          const checked = (item.reasoningLevels ?? []).includes(
                            level,
                          );
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
                            value={item.defaultReasoningLevel ?? ""}
                            onChange={(event) => {
                              const catalogModels = [...editor.catalogModels];
                              const next: CodexCatalogModel = { ...item };
                              if (event.target.value) {
                                next.defaultReasoningLevel = event.target.value;
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
                    <div className="instructions-panel">
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
          </div>
        </details>
        {modelFetchError && (
          <p className="editor-model-error" role="status">
            <CircleAlert size={15} /> {modelFetchError}
          </p>
        )}
      </div>
      <footer>
        <button
          className="secondary"
          onClick={onTest}
          disabled={savingProvider || connection.kind === "checking"}
        >
          测试连接
        </button>
        <small
          className={`editor-connection is-${connection.kind}`}
          role="status"
        >
          {connection.message}
        </small>
        <div>
          {editor.original && (
            <button
              className="danger"
              onClick={onDelete}
              disabled={savingProvider}
            >
              <Trash2 size={15} /> 删除
            </button>
          )}
          <button
            className="primary"
            onClick={() => void onSave()}
            disabled={savingProvider || fetchingModels}
          >
            {savingProvider ? (
              <>
                <LoaderCircle className="spin" size={15} /> 正在保存…
              </>
            ) : (
              "保存并应用"
            )}
          </button>
        </div>
      </footer>
    </section>
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

export function NewSettingsView() {
  const {
    hasUpdate,
    updateInfo,
    isChecking,
    isInstalling: installingAppUpdate,
    error: updateError,
    errorOperation: updateErrorOperation,
    lastCheckedAt,
    downloadProgress: appUpdateProgress,
    stagedVersion,
    isStaging,
    checkUpdate,
    installUpdate,
  } = useUpdate();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [appVersion, setAppVersion] = useState("正在读取版本");

  useEffect(() => {
    if (!runningInTauri) {
      setSettings({
        codexUpdateSource: "auto",
        codexInstallMode: "standard",
      } as Settings);
      setAppVersion("开发预览");
      return;
    }
    void getCurrentVersion().then((version) =>
      setAppVersion(version || "未知版本"),
    );
    void settingsApi
      .get()
      .then(setSettings)
      .catch((reason) =>
        toast.error("无法读取设置", { description: String(reason) }),
      );
  }, []);
  const save = async (patch: Partial<Settings>) => {
    if (!settings) return;
    if (!runningInTauri) {
      setSettings({ ...settings, ...patch });
      return;
    }
    try {
      // Re-read the latest persisted settings immediately before merging,
      // rather than the value captured in state at mount time. The tray
      // menu and failover monitor can write fields like
      // currentProviderCodex concurrently; merging onto a stale snapshot
      // would silently revert whichever of those writes happened first.
      const current = await settingsApi.get();
      const next = { ...current, ...patch };
      await settingsApi.save(next);
      setSettings(next);
      toast.success("设置已保存");
    } catch (reason) {
      toast.error("设置保存失败", { description: String(reason) });
    }
  };
  const updateChecks = settings?.checkCodexUpdatesOnStart ?? true;
  const providerChecks = settings?.checkProviderStatusOnStart ?? true;
  const minimizeToTray = settings?.minimizeToTrayOnClose ?? false;
  const openDataFolder = async () => {
    if (!runningInTauri) return;
    try {
      await settingsApi.openAppConfigFolder();
    } catch (reason) {
      toast.error("无法打开数据目录", { description: String(reason) });
    }
  };
  const checkAppUpdate = async () => {
    try {
      await checkUpdate();
    } catch (reason) {
      toast.error("检查应用更新失败", { description: String(reason) });
    }
  };
  const installAppUpdate = async () => {
    try {
      const installed = await installUpdate();
      if (!installed) {
        toast.info("该更新已不可用", { description: "已重新检查更新" });
      }
    } catch (reason) {
      toast.error("应用更新失败", { description: String(reason) });
    }
  };
  const lastCheckedLabel = lastCheckedAt
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(lastCheckedAt)
    : null;
  const appUpdatePercent =
    appUpdateProgress?.total && appUpdateProgress.total > 0
      ? Math.min(
          100,
          Math.round(
            (appUpdateProgress.downloaded / appUpdateProgress.total) * 100,
          ),
        )
      : null;
  const appUpdateTitle = installingAppUpdate
    ? "正在更新 Chimera++"
    : isChecking
      ? "正在检查更新"
      : hasUpdate && updateInfo
        ? updateErrorOperation === "install"
          ? "更新未完成，可以重试"
          : `发现 Chimera++ ${updateInfo.availableVersion}`
        : updateError
          ? "检查更新失败"
          : lastCheckedAt
            ? "已是最新版本"
            : `Chimera++ ${appVersion}`;
  const appUpdateDescription = installingAppUpdate
    ? appUpdatePercent !== null
      ? appUpdatePercent >= 100
        ? "正在安装更新，完成后应用将自动重启"
        : `正在下载更新 ${appUpdatePercent}%`
      : "正在准备更新，完成后应用将自动重启"
    : isChecking
      ? "正在连接稳定版更新源"
      : hasUpdate
        ? updateErrorOperation === "install"
          ? `${updateError ?? "安装失败"}。旧版本未被替换，可再次尝试。`
          : updateErrorOperation === "stage"
            ? "后台预下载未完成，点击后会重新下载、验证并安装"
            : stagedVersion === updateInfo?.availableVersion
              ? "更新包已下载并通过验证，安装后应用将自动重启"
              : isStaging
                ? "正在后台下载更新包，点击后将下载完成并安装"
                : "新版本已通过签名验证，点击即可下载并安装"
        : updateError
          ? updateError
          : lastCheckedLabel
            ? `Chimera++ ${appVersion} · 上次检查 ${lastCheckedLabel}`
            : "自动检测已开启，也可以随时手动检查";
  return (
    <section className="new-settings-view">
      <h1>设置</h1>
      <div className="settings-reference-list">
        <button
          className="settings-reference-row"
          role="switch"
          aria-checked={updateChecks}
          onClick={() => void save({ checkCodexUpdatesOnStart: !updateChecks })}
        >
          <span>
            <b>启动时检查 Codex 更新</b>
            <small>仅提醒，不会静默替换当前版本</small>
          </span>
          <i className={`settings-switch ${updateChecks ? "is-on" : ""}`}>
            <u />
          </i>
        </button>
        <button
          className="settings-reference-row"
          role="switch"
          aria-checked={providerChecks}
          onClick={() =>
            void save({ checkProviderStatusOnStart: !providerChecks })
          }
        >
          <span>
            <b>自动检查供应商状态</b>
            <small>启动后轻量验证当前路由</small>
          </span>
          <i className={`settings-switch ${providerChecks ? "is-on" : ""}`}>
            <u />
          </i>
        </button>
        <button
          className="settings-reference-row"
          role="switch"
          aria-checked={minimizeToTray}
          onClick={() => void save({ minimizeToTrayOnClose: !minimizeToTray })}
        >
          <span>
            <b>关闭窗口后最小化到托盘</b>
            <small>保留快速切换能力</small>
          </span>
          <i className={`settings-switch ${minimizeToTray ? "is-on" : ""}`}>
            <u />
          </i>
        </button>
        <div className="settings-reference-row settings-segment-row">
          <span>
            <b>Codex 更新源</b>
            <small>安装方式请在“更新”页的“安装方式与更新源”中选择</small>
          </span>
          <div className="settings-segment">
            <button
              className={
                settings?.codexUpdateSource !== "mirror" ? "is-active" : ""
              }
              aria-pressed={settings?.codexUpdateSource !== "mirror"}
              onClick={() => void save({ codexUpdateSource: "auto" })}
            >
              自动选择
            </button>
            <button
              className={
                settings?.codexUpdateSource === "mirror" ? "is-active" : ""
              }
              aria-pressed={settings?.codexUpdateSource === "mirror"}
              onClick={() => void save({ codexUpdateSource: "mirror" })}
            >
              镜像安装
            </button>
          </div>
        </div>
        <button
          className="settings-reference-row settings-link-row"
          onClick={() => void openDataFolder()}
        >
          <span>
            <b>数据与日志</b>
            <small>配置保存在本机</small>
          </span>
          <FolderOpen size={16} aria-hidden="true" />
        </button>
        <div
          className={`settings-app-update${hasUpdate ? " is-available" : ""}${updateError ? " is-error" : ""}`}
          aria-live="polite"
        >
          <div className="settings-app-update-row">
            <span className="settings-app-update-icon" aria-hidden="true">
              {installingAppUpdate || isChecking ? (
                <LoaderCircle className="spin" size={15} />
              ) : hasUpdate ? (
                <Download size={15} />
              ) : lastCheckedAt && !updateError ? (
                <CircleCheck size={15} />
              ) : updateError ? (
                <CircleAlert size={15} />
              ) : (
                <RefreshCw size={15} />
              )}
            </span>
            <span className="settings-app-update-copy">
              <b>{appUpdateTitle}</b>
              <small>{appUpdateDescription}</small>
            </span>
            <button
              className={hasUpdate ? "primary" : "secondary"}
              disabled={isChecking || installingAppUpdate}
              onClick={() => {
                if (hasUpdate) {
                  void installAppUpdate();
                } else {
                  void checkAppUpdate();
                }
              }}
            >
              {installingAppUpdate || isChecking ? (
                <LoaderCircle className="spin" size={14} />
              ) : hasUpdate ? (
                <Download size={14} />
              ) : (
                <RefreshCw size={14} />
              )}
              {installingAppUpdate
                ? "正在更新…"
                : isChecking
                  ? "正在检查…"
                  : hasUpdate
                    ? stagedVersion === updateInfo?.availableVersion
                      ? "安装并重启"
                      : "下载并安装"
                    : lastCheckedAt
                      ? "重新检查"
                      : "检查更新"}
            </button>
          </div>
          {hasUpdate && updateInfo && (
            <div className="settings-app-update-details">
              <span>
                <b>
                  {updateInfo.currentVersion} → {updateInfo.availableVersion}
                </b>
                <small>
                  {updateInfo.notes?.trim() ||
                    "安装期间 Chimera++ 将重新启动，正在运行的 Codex 任务不会被关闭。"}
                </small>
              </span>
            </div>
          )}
          {installingAppUpdate && (
            <div className="settings-app-update-progress">
              <span>
                {appUpdatePercent !== null
                  ? appUpdatePercent >= 100
                    ? "正在安装"
                    : `${appUpdatePercent}%`
                  : "正在准备下载"}
              </span>
              <i
                role="progressbar"
                aria-label="应用更新下载进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={appUpdatePercent ?? undefined}
              >
                <u
                  className={
                    appUpdatePercent === null ? "is-indeterminate" : undefined
                  }
                  style={
                    appUpdatePercent !== null
                      ? { width: `${appUpdatePercent}%` }
                      : undefined
                  }
                />
              </i>
            </div>
          )}
        </div>
      </div>
      <footer className="settings-reference-footer">
        <code>Chimera++ {appVersion}</code>
        <button
          className="secondary"
          onClick={() =>
            void save({
              codexUpdateSource: "auto",
              codexInstallMode: "standard",
              checkCodexUpdatesOnStart: true,
              checkProviderStatusOnStart: true,
              minimizeToTrayOnClose: false,
            })
          }
        >
          恢复默认设置
        </button>
      </footer>
    </section>
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
        <p>这条线路还有没保存的改动，关闭后会丢失。</p>
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
          只在启动时读取模型目录，需要完整重启后才会显示。
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
        粘贴 Chimera 中转站密钥，Chimera++ 会获取模型列表并写入 Codex 配置。
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
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}
