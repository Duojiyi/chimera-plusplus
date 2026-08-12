import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  LoaderCircle,
  FolderOpen,
  MessagesSquare,
  MoreHorizontal,
  Package,
  Paintbrush,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Route,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
  Zap,
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
import type { RequestLog } from "@/types/usage";
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
import {
  activityStorageKey,
  buildCodexModelCatalog,
  findCodexCatalogModelsWithoutProtocol,
  formatDuration,
  formatVersion,
  loadOperationRecords,
  resolveCurrentProvider,
  saveOperationRecords,
  setCodexProviderApiKey,
  type ConnectionState,
  type OperationRecord,
} from "./chimeraUtils";
import routeGateIcon from "@/assets/icons/chimera-dragon-mark.png";
import RouteGlobe from "@/components/RouteGlobe";
import "./chimera.css";

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const UsageView = lazy(() =>
  import("./views/UsageView").then(({ UsageView: view }) => ({
    default: view,
  })),
);
const SessionManagerPage = lazy(() =>
  import("./components/sessions/SessionManagerPage").then(
    ({ SessionManagerPage: page }) => ({
      default: page,
    }),
  ),
);

function useDialogFocus<T extends HTMLElement>(
  onClose: () => void,
  enabled = true,
  returnFocusRef?: { current: HTMLElement | null },
) {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!enabled) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusableSelector =
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => {
      const preferred = dialog.querySelector<HTMLElement>("[data-autofocus]");
      const first = dialog.querySelector<HTMLElement>(focusableSelector);
      (preferred ?? first ?? dialog).focus();
    };
    const focusFrame = requestAnimationFrame(focusFirst);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      const returnTarget = returnFocusRef?.current ?? previousFocus;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [enabled, returnFocusRef]);
  return dialogRef;
}

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
type CatalogSkin = {
  id: string;
  name: string;
  description?: string;
  version: string;
  author?: string;
  appearance?: "dark" | "light" | "dual" | string | null;
  preview: string;
  installed: boolean;
  applied: boolean;
};

function skinToneClass(skin: CatalogSkin) {
  const identity = `${skin.id} ${skin.name}`.toLowerCase();
  if (identity.includes("oled") || identity.includes("mono")) {
    return "skin-tone-oled";
  }
  if (identity.includes("sakura") || identity.includes("pink")) {
    return "skin-tone-sakura";
  }
  return "skin-tone-nerv";
}

function skinPreviewUrl(preview: string) {
  return preview.startsWith("/")
    ? preview
    : `https://skins.agentsmirror.com/${preview.replace(/^\/+/, "")}`;
}

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

type CodexEndpointInput = {
  baseUrl: string;
  apiKey: string;
  isFullUrl: boolean;
  modelsUrl: string;
  customUserAgent: string;
};

type CodexApiFormatDetection = {
  identity: string;
  result: DetectedCodexApiFormat;
  formats: Record<string, DetectedCodexApiFormat>;
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

function codexDetectionIdentity(
  input: CodexEndpointInput,
  probeModel: string,
): string {
  return JSON.stringify([codexEndpointIdentity(input), probeModel.trim()]);
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
  const catalogModels = Array.isArray(
    provider?.settingsConfig?.modelCatalog?.models,
  )
    ? provider.settingsConfig.modelCatalog.models
    : [];
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
    catalogModels: catalogModels as CodexCatalogModel[],
    original: provider ?? null,
  };
}

export default function ChimeraApp() {
  const [view, setView] = useState<View>("providers");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [currentSource, setCurrentSource] = useState<
    "live" | "stored" | "external" | "none"
  >("none");
  const [loading, setLoading] = useState(true);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [codexProcess, setCodexProcess] = useState<CodexProcessStatus | null>(
    null,
  );
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
  const fetchModelsSeqRef = useRef(0);
  const protocolProbeSeqRef = useRef(0);
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

  const activeEndpointIdentity = editor ? codexEndpointIdentity(editor) : null;

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    fetchModelsSeqRef.current += 1;
    protocolProbeSeqRef.current += 1;
    setModels(null);
    setModelFetchIdentity(null);
    setModelFetchError(null);
    setApiFormatDetectionError(null);
    setModelPickerOpen(false);

    setApiFormatDetection(null);
  }, [activeEndpointIdentity, editor?.id]);

  useEffect(() => {
    protocolProbeSeqRef.current += 1;
    if (!editor?.model.trim()) return;
    const expectedIdentity = codexDetectionIdentity(editor, editor.model);
    setApiFormatDetection((current) =>
      current?.identity === expectedIdentity ? current : null,
    );
    setApiFormatDetectionError(null);
  }, [activeEndpointIdentity, editor?.model]);
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
    } catch (error) {
      toast.error("无法读取 Codex 供应商", { description: String(error) });
    } finally {
      setLoading(false);
    }
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
      setCodexProcess(status);
      setRendererUnlock(null);
      return status;
    }
    try {
      const status = await invoke<CodexProcessStatus>(
        "get_codex_process_status",
      );
      setCodexProcess(status);
      void refreshRendererUnlock();
      return status;
    } catch {
      // Unsupported platforms return a structured status. A rejected probe
      // therefore means a supported installation could not be detected.
      const status: CodexProcessStatus = {
        supported: true,
        installed: false,
        running: false,
        installMode: null,
        officialLoginAvailable: false,
      };
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
      // Runtime policy belongs to the backend: it detects and safely replaces
      // an existing path-pinned Codex instance before launching a new one.
      const result = await invoke<CodexLaunchResult>("open_codex_runtime");
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

  const testConnection = async (baseUrl: string, providerName = "Codex") => {
    const started = performance.now();
    setConnection({ kind: "checking", message: "正在测试 API 地址" });
    try {
      const [result] = await vscodeApi.testApiEndpoints([baseUrl], {
        timeoutSecs: 12,
      });
      if (!result || result.latency == null)
        throw new Error(result?.error || "服务未响应");
      setConnection({
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
      setConnection({ kind: "error", message: String(error) });
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

  const saveProvider = async () => {
    if (!editor) return;
    const draft = editor;
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

      let resolvedApiFormat: CodexApiFormat =
        draft.apiFormat === "auto" ? "openai_responses" : draft.apiFormat;
      let resolvedAnthropicAuthField = draft.anthropicAuthField;
      let detectedModelFormats: Record<string, DetectedCodexApiFormat> = {};
      // The saved catalog is the union of the default model, user-mapped rows,
      // and fetched /models entries. Detection must cover exactly this set so a
      // later addition to the mapping table can never be saved undetected.
      const catalogModels = buildCodexModelCatalog(
        draft.model,
        draft.catalogModels,
        fetchedForSave,
      );
      if (draft.apiFormat === "auto") {
        const detectionIdentity = codexDetectionIdentity(draft, draft.model);
        const cachedDetection =
          apiFormatDetection?.identity === detectionIdentity
            ? apiFormatDetection.result
            : null;
        if (cachedDetection) {
          resolvedApiFormat = cachedDetection.apiFormat;
          resolvedAnthropicAuthField =
            cachedDetection.anthropicAuthField ?? draft.anthropicAuthField;
          detectedModelFormats =
            apiFormatDetection?.formats ??
            (draft.model.trim()
              ? { [draft.model.trim()]: cachedDetection }
              : {});
        } else {
          const seq = ++protocolProbeSeqRef.current;
          setFetchingModels(true);
          setApiFormatDetectionError(null);
          try {
            const detectionModels = catalogModels
              .map((model) => model.model.trim())
              .filter(Boolean);
            const detectedFormats = await detectCodexApiFormats(
              draft.baseUrl,
              draft.apiKey,
              detectionModels,
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
            detectedModelFormats = detectedFormats;
            const defaultDetection = detectedFormats[draft.model.trim()];
            if (!defaultDetection) {
              throw new Error("默认模型未能识别上游协议，请手动选择协议后重试");
            }
            resolvedApiFormat = defaultDetection.apiFormat;
            resolvedAnthropicAuthField =
              defaultDetection.anthropicAuthField ?? draft.anthropicAuthField;
            setApiFormatDetection({
              identity: detectionIdentity,
              result: defaultDetection,
              formats: detectedFormats,
            });
            toast.success(
              `已识别 ${Object.keys(detectedFormats).length} 个模型的上游协议`,
            );
          } catch (error) {
            const message = String(error);
            setApiFormatDetectionError(
              "无法自动识别上游协议，请重试或手动选择协议。",
            );
            toast.error("无法自动识别上游 API 协议", {
              description: message,
            });
            return;
          } finally {
            if (seq === protocolProbeSeqRef.current) setFetchingModels(false);
          }
        }
        // Also covers the cached path: a mapping row added without changing the
        // detection identity would otherwise be saved undetected and fail closed
        // (HTTP 400) on the first request. Models routed to a dedicated upstream
        // with an explicit protocol are exempt (the request follows the route).
        const undetectedCatalogModels = findCodexCatalogModelsWithoutProtocol(
          catalogModels,
          detectedModelFormats,
          draft.original?.meta?.codexModelRoutes,
        );
        if (undetectedCatalogModels.length > 0) {
          setApiFormatDetectionError(
            "无法自动识别上游协议，请重试或手动选择协议。",
          );
          toast.error("无法自动识别上游 API 协议", {
            description: `无法确认以下模型的上游协议：${undetectedCatalogModels.join(
              "、",
            )}。请重试自动识别、移除这些模型，或在高级设置中手动选择协议。`,
          });
          return;
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
        id: draft.id,
        name: draft.name.trim(),
        websiteUrl: draft.websiteUrl.trim() || undefined,
        notes: draft.notes.trim() || undefined,
        category: "custom",
        meta: {
          ...draft.original?.meta,
          apiFormat: resolvedApiFormat,
          apiFormatAutoDetected: draft.apiFormat === "auto" ? true : undefined,
          codexModelApiFormats:
            draft.apiFormat === "auto"
              ? Object.fromEntries(
                  Object.entries(detectedModelFormats).map(
                    ([model, detected]) => [model, detected.apiFormat],
                  ),
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
          setEditor(null);
          note("应用模型目录", "error", String(error), provider.name);
          toast.error("线路已保存，但模型目录未正确应用", {
            description: String(error),
          });
          return;
        }
        await loadProviders();
        setEditor(null);
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

      if (latest.apiFormat !== "auto") {
        toast.success(`已获取 ${result.length} 个模型`);
        return;
      }

      const probeModel = latest.model.trim() || result[0]?.id?.trim();
      if (!probeModel) {
        setApiFormatDetection(null);
        setApiFormatDetectionError(
          "没有可用于安全探测的模型，请手动填写默认模型后重试。",
        );
        toast.warning(`已获取 ${result.length} 个模型，但暂时无法探测协议`);
        return;
      }

      const probeIdentity = codexDetectionIdentity(latest, probeModel);
      const probeSeq = ++protocolProbeSeqRef.current;
      try {
        const detectedFormats = await detectCodexApiFormats(
          latest.baseUrl,
          latest.apiKey,
          [probeModel, ...result.map((model) => model.id.trim())],
          latest.isFullUrl,
          latest.customUserAgent.trim() || undefined,
        );
        const current = editorRef.current;
        if (
          probeSeq !== protocolProbeSeqRef.current ||
          !current ||
          current.id !== latest.id ||
          current.apiFormat !== "auto" ||
          codexDetectionIdentity(
            current,
            current.model.trim() || probeModel,
          ) !== probeIdentity
        ) {
          return;
        }
        const detected = detectedFormats[probeModel];
        if (!detected) {
          throw new Error("默认模型未能识别上游协议");
        }
        setApiFormatDetection({
          identity: probeIdentity,
          result: detected,
          formats: detectedFormats,
        });
        setApiFormatDetectionError(null);
        if (detected.anthropicAuthField) {
          setEditor((currentEditor) =>
            currentEditor &&
            currentEditor.id === latest.id &&
            currentEditor.apiFormat === "auto" &&
            codexEndpointIdentity(currentEditor) === endpointIdentity
              ? {
                  ...currentEditor,
                  anthropicAuthField: detected.anthropicAuthField!,
                }
              : currentEditor,
          );
        }
        toast.success(
          `已获取 ${result.length} 个模型，并识别 ${Object.keys(detectedFormats).length} 个模型的上游协议`,
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

  const checkRuntime = async (preferences?: RuntimeUpdatePreferences) => {
    try {
      const result = await invoke<ReleaseStatus>("check_codex_runtime_update", {
        source: preferences?.source ?? null,
        installMode: preferences?.installMode ?? null,
      });
      setRelease(result);
      note(
        "检查 Codex 更新",
        "success",
        result.updateAvailable
          ? `发现 ${result.latestVersion}`
          : "已是最新版本",
      );
      toast.success(
        result.updateAvailable ? "发现新版本" : "Codex 已是最新版本",
      );
    } catch (error) {
      toast.error("检查更新失败", { description: String(error) });
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
      await loadRuntime();
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

  if (!loading && !providers.length && !editor && !onboardingDeferred) {
    return (
      <StandaloneOnboarding
        onAdd={() => setEditor(providerDraft(null, "默认线路"))}
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
          {view === "providers" && (
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
              onEdit={(provider) => {
                setModels(null);
                setModelFetchError(null);
                setEditor(providerDraft(provider));
              }}
              onAdd={() => {
                setModels(null);
                setModelFetchError(null);
                setEditor(
                  providerDraft(null, providers.length ? "新线路" : "默认线路"),
                );
              }}
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
            onMouseDown={(event) =>
              !savingProvider &&
              event.target === event.currentTarget &&
              setEditor(null)
            }
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
              onTest={() =>
                void testConnection(editor.baseUrl, editor.name || "Codex")
              }
              onSave={saveProvider}
              onDelete={() => {
                if (editor.original) setPendingProviderDelete(editor.original);
              }}
              escapeDisabled={Boolean(pendingProviderDelete) || savingProvider}
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
      {pendingProviderDelete && (
        <ConfirmProviderDelete
          provider={pendingProviderDelete}
          onCancel={() => setPendingProviderDelete(null)}
          onConfirm={async () => {
            try {
              await providersApi.delete(pendingProviderDelete.id, "codex");
              await loadProviders();
              setPendingProviderDelete(null);
              setEditor(null);
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

function ProvidersView({
  providers,
  currentId,
  currentSource,
  connection,
  loading,
  runtime,
  activity,
  onSwitch,
  onEdit,
  onAdd,
  onTest,
  onCheckRuntime,
  onDiagnose,
}: {
  providers: Provider[];
  currentId: string;
  currentSource: "live" | "stored" | "external" | "none";
  connection: ConnectionState;
  loading: boolean;
  runtime: RuntimeStatus | null;
  activity: OperationRecord[];
  onSwitch: (id: string) => void;
  onEdit: (provider: Provider) => void;
  onAdd: () => void;
  onTest: (url: string, name?: string) => Promise<boolean>;
  onCheckRuntime: () => void;
  onDiagnose: () => void;
}) {
  if (loading) return <Empty label="正在读取供应商…" />;
  if (!providers.length) return <Onboarding onAdd={onAdd} />;
  const current =
    providers.find((provider) => provider.id === currentId) ?? null;
  if (!current)
    return (
      <section className="provider-console">
        <div className="connection-banner is-warning">
          <CircleAlert size={18} />
          <div>
            <b>检测到外部 Codex 配置</b>
            <span>
              当前配置不属于 Chimera++
              中已保存的供应商；请选择一个供应商应用，或添加现有配置。
            </span>
          </div>
          <em>未接管</em>
        </div>
        <div className="console-heading">
          <h2>已保存的供应商</h2>
          <button className="primary" onClick={onAdd}>
            <Plus size={15} /> 添加供应商
          </button>
        </div>
        <div className="provider-list">
          {providers.map((provider) => (
            <article className="provider-card" key={provider.id}>
              <span className="provider-monogram">
                {provider.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="provider-copy">
                <b>{provider.name}</b>
                <code>
                  {extractCodexBaseUrl(
                    String(provider.settingsConfig?.config ?? ""),
                  ) || "未配置 URL"}
                </code>
              </div>
              <div className="provider-actions">
                <button onClick={() => onEdit(provider)}>编辑</button>
                <button className="dark" onClick={() => onSwitch(provider.id)}>
                  应用
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  const endpoint =
    extractCodexBaseUrl(String(current.settingsConfig?.config ?? "")) ||
    "未配置请求地址";
  const model =
    extractCodexModelName(String(current.settingsConfig?.config ?? "")) ||
    "未设置";
  const cards = providers.slice(0, 3);
  const connectionLabel =
    connection.kind === "connected"
      ? `已验证 · ${connection.message}`
      : connection.kind === "checking"
        ? "验证中"
        : connection.kind === "error"
          ? "验证失败"
          : currentSource === "live"
            ? "配置已识别"
            : "等待验证";
  return (
    <section className="provider-console">
      <div
        className={`connection-banner ${connection.kind === "error" ? "is-warning" : ""}`}
      >
        <Zap size={18} />
        <div>
          <b>当前正在使用 {current.name}</b>
          <span>
            {currentSource === "live"
              ? "已从 Codex 实时配置识别"
              : "根据 Chimera++ 保存记录识别"}
          </span>
        </div>
        <em>{connectionLabel}</em>
      </div>
      <div className="console-layout">
        <div className="console-main">
          <div className="console-heading">
            <h2>快速切换</h2>
            <button className="link-button" onClick={() => onEdit(current)}>
              管理供应商 <span>→</span>
            </button>
          </div>
          <div className="quick-provider-grid">
            {cards.map((provider) => {
              const active = provider.id === current.id;
              return (
                <button
                  key={provider.id}
                  className={`quick-provider ${active ? "selected" : ""}`}
                  onClick={() => !active && onSwitch(provider.id)}
                >
                  <span className="quick-provider-mark">
                    {provider.name.slice(0, 1).toUpperCase()}
                  </span>
                  <b title={provider.name}>{provider.name}</b>
                  <em>{active ? "当前" : "可切换"}</em>
                  <small
                    title={
                      extractCodexModelName(
                        String(provider.settingsConfig?.config ?? ""),
                      ) || "未配置模型"
                    }
                  >
                    {extractCodexModelName(
                      String(provider.settingsConfig?.config ?? ""),
                    ) || "未配置模型"}
                  </small>
                </button>
              );
            })}
            <button className="quick-provider add-provider" onClick={onAdd}>
              <Plus size={16} /> 添加供应商
            </button>
          </div>
          <article className="provider-workbench">
            <header>
              <div>
                <h2>{current.name}</h2>
                <p>Codex 兼容接口 · 模型由供应商 API 获取</p>
              </div>
              <button className="preset-badge" onClick={() => onEdit(current)}>
                编辑
              </button>
            </header>
            <label>
              接口地址
              <input value={endpoint} readOnly title={endpoint} />
            </label>
            <label>
              API 密钥
              <div className="readonly-secret">
                <input value="••••••••••••••••••" readOnly />
                <button onClick={() => onEdit(current)}>编辑</button>
              </div>
            </label>
            <label>
              默认模型
              <div className="readonly-model">
                <input value={model} readOnly title={model} />
                <button onClick={() => onEdit(current)}>获取模型</button>
              </div>
            </label>
            <footer>
              <button
                className="secondary"
                onClick={() => void onTest(endpoint, current.name)}
                disabled={!endpoint}
              >
                测试连接
              </button>
              <button className="primary" onClick={() => onEdit(current)}>
                编辑配置
              </button>
            </footer>
          </article>
        </div>
        <aside className="codex-summary">
          <div className="summary-title">
            <h2>Codex 更新检测</h2>
            <button aria-label="更新诊断" onClick={onDiagnose}>
              <MoreHorizontal size={18} />
            </button>
          </div>
          <div className="runtime-version">
            <b title={runtime?.version ?? undefined}>
              {formatVersion(runtime?.version)}
            </b>
            <em>{runtime?.installed ? "已安装" : "未安装"}</em>
            <span>
              {runtime?.installed
                ? `${runtimeText(runtime.installMode)} · 路径已识别`
                : "未检测到可用安装"}
            </span>
          </div>
          <ul className="runtime-facts">
            <li>
              <ShieldCheck size={16} />
              <span>
                <b>更新检测</b>
                <small>
                  {runtime?.installed
                    ? "已识别当前 Codex 安装"
                    : "等待安装或重新检测"}
                </small>
              </span>
            </li>
            <li>
              <Check size={16} />
              <span>
                <b>安装位置</b>
                <small title={runtime?.installPath ?? undefined}>
                  {runtime?.installPath || "未检测到"}
                </small>
              </span>
            </li>
            <li>
              <Activity size={16} />
              <span>
                <b>回滚点</b>
                <small>
                  {runtime?.canRollback ? "可用" : "当前安装方式无可用副本"}
                </small>
              </span>
            </li>
          </ul>
          <div className="summary-actions">
            <button className="dark" onClick={onCheckRuntime}>
              <RefreshCw size={15} /> 检查更新
            </button>
            <button onClick={onDiagnose}>
              <Wrench size={15} /> 查看诊断
            </button>
          </div>
          <div className="summary-activity">
            <b>最近活动</b>
            {activity.slice(0, 2).map((item) => (
              <span key={item.id}>
                {new Date(item.timestamp).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                · {item.action}
              </span>
            ))}
            {!activity.length && <span>暂无操作记录</span>}
          </div>
        </aside>
      </div>
    </section>
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
}) {
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [installMode, setInstallMode] = useState<"standard" | "portable">(
    "standard",
  );
  const [updateSource, setUpdateSource] = useState<"auto" | "mirror">("auto");
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
    provider.id === "codex-official" || provider.category === "official";
  const isChimeraLine = (provider: Provider) => {
    const endpoint =
      extractCodexBaseUrl(String(provider.settingsConfig?.config ?? "")) ?? "";
    return /(^|\.)chimerahub\.org$/i.test(
      (() => {
        try {
          return new URL(endpoint).hostname;
        } catch {
          return endpoint;
        }
      })(),
    );
  };
  const lineName = (provider: Provider) => {
    if (isOfficialLine(provider)) return "官方账户";
    const normalized = provider.name.trim().toLowerCase().replace(/\s+/g, "");
    const generic = ["chimerahub", "chimera中转站", "default"].includes(
      normalized,
    );
    if (!generic) return provider.name || "未命名线路";
    if (!isChimeraLine(provider)) return "默认线路";
    const chimeraLines = providers.filter(isChimeraLine);
    const index = chimeraLines.findIndex((item) => item.id === provider.id);
    if (index <= 0) return "默认线路";
    if (index === 1) return "备用线路";
    return `线路 ${index + 1}`;
  };
  const lineSource = (provider: Provider) =>
    isOfficialLine(provider)
      ? "ChatGPT 官方登录"
      : isChimeraLine(provider)
        ? "Chimera 中转站"
        : "自定义线路";
  const lineMark = (provider: Provider) =>
    isOfficialLine(provider)
      ? "O"
      : isChimeraLine(provider)
        ? "C"
        : provider.name.trim().slice(0, 1).toUpperCase() || "线";
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
  onTest,
  onSave,
  onDelete,
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
  onTest: () => void;
  onSave: () => void;
  onDelete: () => void;
  escapeDisabled: boolean;
}) {
  const [commonConfigOpen, setCommonConfigOpen] = useState(false);
  const dialogRef = useDialogFocus<HTMLElement>(
    () => setEditor(null),
    !escapeDisabled,
  );
  const patch = (key: string, value: string) =>
    setEditor({ ...editor, [key]: value });
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
              onClick={() =>
                setEditor(providerDraft(null, editor.name || "新线路"))
              }
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
              {editor.apiFormat === "auto" && apiFormatDetection && (
                <small>
                  已识别：
                  {codexApiFormatLabel(apiFormatDetection.result.apiFormat)}
                  {apiFormatDetection.result.apiFormat === "openai_responses"
                    ? "（可直连；若启用代理专属功能仍会自动开启路由）"
                    : "（保存后自动开启路由）"}
                </small>
              )}
              {editor.apiFormat === "auto" && apiFormatDetectionError && (
                <small className="error-text">{apiFormatDetectionError}</small>
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
                  onClick={() =>
                    setEditor({
                      ...editor,
                      catalogModels: [
                        ...editor.catalogModels,
                        { model: "", displayName: "", contextWindow: "" },
                      ],
                    })
                  }
                >
                  添加模型
                </button>
              </div>
              {editor.catalogModels.map((item, index) => (
                <div className="mapping-row" key={`${item.model}-${index}`}>
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
                    className="icon-button"
                    aria-label="删除模型映射"
                    onClick={() =>
                      setEditor({
                        ...editor,
                        catalogModels: editor.catalogModels.filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
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
          disabled={savingProvider}
        >
          测试连接
        </button>
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
            onClick={onSave}
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

function RuntimeView({
  runtime,
  release,
  progress,
  onCheck,
  onDiagnose,
  onAction,
}: {
  runtime: RuntimeStatus | null;
  release: ReleaseStatus | null;
  progress: DownloadProgress | null;
  onCheck: () => void;
  onDiagnose: () => void;
  onAction: (value: "update" | "repair" | "rollback" | "uninstall") => void;
}) {
  const target = release?.latestVersion ?? runtime?.version ?? "等待检查";
  const percent = progress?.total
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : 0;
  return (
    <section className="runtime-update-layout">
      <article className="runtime-update-card">
        <h2>{release?.updateAvailable ? "发现可用更新" : "Codex 更新检测"}</h2>
        <div className="version-compare">
          <div>
            <span>当前版本</span>
            <b title={runtime?.version ?? undefined}>
              {formatVersion(runtime?.version)}
            </b>
          </div>
          <div
            className={
              release?.updateAvailable
                ? "target-version available"
                : "target-version"
            }
          >
            <span>目标版本</span>
            <b title={target}>{target}</b>
          </div>
        </div>
        <dl className="update-details">
          <div>
            <dt>更新通道</dt>
            <dd>
              <Check size={15} />{" "}
              {release?.source === "mirror" ? "镜像" : "自动"}
            </dd>
          </div>
          <div>
            <dt>安装方式</dt>
            <dd>
              <Check size={15} />{" "}
              {release
                ? runtimeText(release.installMode)
                : runtimeText(runtime?.installMode)}
            </dd>
          </div>
          <div>
            <dt>安装状态</dt>
            <dd>
              {runtime?.installed ? (
                <>
                  <Check size={15} /> 已检测
                </>
              ) : (
                "未安装"
              )}
            </dd>
          </div>
          <div>
            <dt>下载大小</dt>
            <dd>
              {release?.sizeBytes
                ? `${(release.sizeBytes / 1024 / 1024).toFixed(1)} MB`
                : "检查后显示"}
            </dd>
          </div>
        </dl>
        <div className="update-progress" aria-live="polite">
          <span>
            {progress
              ? `正在下载 ${percent}%`
              : release?.updateAvailable
                ? "新版本可以下载安装"
                : release
                  ? "当前通道没有更高版本"
                  : "检查更新以获取最新版本"}
          </span>
          <i>
            <u style={{ width: `${percent}%` }} />
          </i>
        </div>
        <footer>
          <button onClick={onCheck} disabled={Boolean(progress)}>
            重新检查
          </button>
          {release?.updateAvailable && (
            <button
              className="primary"
              onClick={() => onAction("update")}
              disabled={Boolean(progress)}
            >
              下载并安装
            </button>
          )}
        </footer>
      </article>
      <aside className="runtime-diagnostics">
        <h2>修复与诊断</h2>
        <p>操作前会二次确认，并会保留 `~/.codex` 用户数据。</p>
        <button onClick={onDiagnose}>
          查看诊断结果 <span>↗</span>
          <small>安装目录、版本、进程和启动状态</small>
        </button>
        <button
          onClick={() => onAction("rollback")}
          disabled={!runtime?.canRollback}
        >
          回滚上一版本 <span>↗</span>
          <small>仅免安装版且存在回滚点时可用</small>
        </button>
        <button
          onClick={() => onAction("repair")}
          disabled={!runtime?.canRepair}
        >
          重新安装并修复 <span>↗</span>
          <small>使用当前安装方式</small>
        </button>
        <button
          className="danger-line"
          onClick={() => onAction("uninstall")}
          disabled={!runtime?.canUninstall}
        >
          卸载 Codex
        </button>
      </aside>
    </section>
  );
}

function ActivityView({
  entries,
  requests,
}: {
  entries: OperationRecord[];
  requests: RequestLog[];
}) {
  const requestErrors = requests.filter(
    (item) => item.statusCode >= 400,
  ).length;
  const success = entries.filter((item) => item.result === "success").length;
  const errors =
    entries.filter((item) => item.result === "error").length + requestErrors;
  return (
    <section className="activity-dashboard">
      <div className="activity-metrics">
        <Metric
          label="API 请求"
          value={String(requests.length)}
          detail="本机路由请求记录"
        />
        <Metric
          label="本机操作"
          value={String(entries.length)}
          detail={`${success} 项成功`}
          success
        />
        <Metric label="异常记录" value={String(errors)} detail="需要处理" />
      </div>
      <article className="activity-table">
        <div className="activity-table-head">
          <span>时间</span>
          <span>供应商</span>
          <span>操作 / 模型</span>
          <span>结果</span>
        </div>
        {requests.map((entry) => (
          <div
            className="activity-table-row"
            key={entry.requestId}
            title={entry.errorMessage}
          >
            <span>
              {new Date(entry.createdAt).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <span>{entry.providerName || entry.providerId}</span>
            <span>
              {entry.model} ·{" "}
              {formatDuration(entry.durationMs ?? entry.latencyMs)}
            </span>
            <span className={entry.statusCode < 400 ? "ok" : "error-text"}>
              {entry.statusCode}
            </span>
          </div>
        ))}
        {entries.map((entry) => (
          <div
            className="activity-table-row"
            key={entry.id}
            title={entry.detail}
          >
            <span>
              {new Date(entry.timestamp).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <span>{entry.provider}</span>
            <span>
              {entry.action}
              {entry.durationMs != null
                ? ` · ${formatDuration(entry.durationMs)}`
                : ""}
            </span>
            <span className={entry.result === "success" ? "ok" : "error-text"}>
              {entry.result === "success"
                ? "成功"
                : entry.result === "error"
                  ? "失败"
                  : "已跳过"}
            </span>
          </div>
        ))}
        {!entries.length && !requests.length && (
          <Empty label="暂无记录。代理请求和 Chimera++ 操作会显示在这里。" />
        )}
      </article>
    </section>
  );
}

function AppearanceView({
  enabled,
  onRequestSkinAction,
}: {
  enabled: boolean;
  onRequestSkinAction: (action: { label: string; execute: () => void }) => void;
}) {
  const [skins, setSkins] = useState<CatalogSkin[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<
    "featured" | "installed" | "dark" | "light"
  >("featured");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = async () => {
    if (!runningInTauri) {
      setSkins([]);
      setSelectedId("");
      setError("");
      return;
    }
    try {
      setError("");
      const result = await invoke<CatalogSkin[]>("list_skin_catalog");
      setSkins(result);
      setSelectedId((id) =>
        id && result.some((item) => item.id === id)
          ? id
          : (result[0]?.id ?? ""),
      );
    } catch (reason) {
      setError(String(reason));
    }
  };
  useEffect(() => {
    if (enabled) void load();
  }, [enabled]);
  const visibleSkins = skins.filter((skin) => {
    if (filter === "installed") return skin.installed;
    if (filter === "dark") {
      return skin.appearance === "dark" || skin.appearance === "dual";
    }
    if (filter === "light") {
      return skin.appearance === "light" || skin.appearance === "dual";
    }
    return true;
  });
  const selected =
    visibleSkins.find((item) => item.id === selectedId) ??
    visibleSkins[0] ??
    null;
  const run = async (
    label: string,
    command: string,
    args?: Record<string, unknown>,
  ) => {
    try {
      setBusy(label);
      await invoke(command, args);
      toast.success(`${label}完成`);
      await load();
    } catch (reason) {
      toast.error(`${label}失败`, { description: String(reason) });
    } finally {
      setBusy(null);
    }
  };
  const importLocal = async () => {
    const path = await settingsApi.openFileDialog();
    if (path) await run("导入皮肤", "import_skin_package", { path });
  };
  if (!enabled) return <Empty label="当前产品策略未启用 Codex 皮肤能力。" />;
  return (
    <section className="skin-market-reference">
      <header className="skin-market-heading">
        <div>
          <span className="eyebrow">CODEX 外观</span>
          <h1>皮肤市场</h1>
          <p>浏览、预览并安装 Codex 客户端皮肤。</p>
        </div>
        <div className="skin-filter-tabs">
          {(
            [
              ["featured", "精选"],
              ["installed", "已安装"],
              ["dark", "深色"],
              ["light", "浅色"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={filter === id ? "is-active" : ""}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
          <button
            className="skin-import"
            onClick={() => void importLocal()}
            disabled={Boolean(busy)}
          >
            导入本地
          </button>
        </div>
      </header>
      <div className="skin-layout">
        <aside className="skin-list">
          {visibleSkins.map((skin) => (
            <button
              key={skin.id}
              className={skin.id === selected?.id ? "active" : ""}
              onClick={() => setSelectedId(skin.id)}
            >
              <span
                className={`skin-card-preview ${skinToneClass(skin)}`}
                aria-hidden="true"
              >
                {skin.preview === routeGateIcon ? (
                  <span className="skin-card-miniature">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <img
                    src={skinPreviewUrl(skin.preview)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                )}
              </span>
              <span>
                <b>{skin.name}</b>
                <small>{skin.description || `皮肤包 · ${skin.version}`}</small>
                <code>v{skin.version}</code>
                {skin.installed && (
                  <em>{skin.applied ? "已安装" : "已下载"}</em>
                )}
              </span>
            </button>
          ))}
          {!skins.length && !error && (
            <Empty
              label={
                runningInTauri
                  ? "正在读取皮肤目录…"
                  : "浏览器预览不读取皮肤目录，请在桌面应用中查看真实皮肤。"
              }
            />
          )}
          {Boolean(skins.length) && !visibleSkins.length && (
            <Empty label="当前分类暂无皮肤。" />
          )}
          {error && (
            <Empty
              label={`皮肤目录读取失败：${error}`}
              action="重试"
              onAction={() => void load()}
            />
          )}
        </aside>
        <article className="skin-detail">
          {selected ? (
            <>
              <div
                key={selected.id}
                className={`skin-preview skin-preview-image ${skinToneClass(selected)} ${
                  selected.preview === routeGateIcon
                    ? "is-fallback"
                    : "has-catalog-image"
                }`}
              >
                {selected.preview === routeGateIcon ? (
                  <div className="skin-preview-fallback">
                    <aside>
                      <b>CODEX</b>
                      <span>新对话</span>
                      <span>Codex</span>
                      <span>设置</span>
                    </aside>
                    <main>
                      <code>{selected.name} // CODEX ROUTE</code>
                      <div>
                        <b>ChimeraHub 已连接</b>
                        <small>gpt-5.6-sol · 420 ms</small>
                      </div>
                      <footer>
                        给 Codex 发送消息 <i>↑</i>
                      </footer>
                    </main>
                  </div>
                ) : (
                  <img
                    className="skin-catalog-preview-art"
                    src={skinPreviewUrl(selected.preview)}
                    alt={`${selected.name} 预览`}
                    decoding="async"
                  />
                )}
              </div>
              <div className="skin-detail-footer">
                <div>
                  <h2>
                    {selected.name} {selected.description}
                  </h2>
                  <p>
                    {selected.installed
                      ? `已安装 · v${selected.version} · 适配当前 Codex`
                      : `v${selected.version} · 可下载安装`}
                  </p>
                </div>
                <div className="skin-actions">
                  {!selected.installed && (
                    <button
                      className="primary skin-install-action"
                      onClick={() =>
                        void run("下载安装", "install_catalog_skin", {
                          skinId: selected.id,
                        })
                      }
                      disabled={Boolean(busy)}
                    >
                      <Download size={14} aria-hidden="true" />
                      {busy === "下载安装" ? "正在下载…" : "下载并安装"}
                    </button>
                  )}
                  {selected.installed && (
                    <button
                      className="primary"
                      onClick={() =>
                        onRequestSkinAction({
                          label: selected.applied ? "重新应用皮肤" : "应用皮肤",
                          execute: () =>
                            void run("应用皮肤", "apply_skin_package", {
                              skinId: selected.id,
                              confirm: true,
                            }),
                        })
                      }
                      disabled={Boolean(busy)}
                    >
                      {selected.applied ? "重新应用" : "应用"}
                    </button>
                  )}
                  {selected.installed && !selected.applied && (
                    <button
                      className="secondary"
                      onClick={() =>
                        onRequestSkinAction({
                          label: "试穿皮肤",
                          execute: () =>
                            void run("试穿", "try_skin_package", {
                              skinId: selected.id,
                              confirm: true,
                            }),
                        })
                      }
                      disabled={Boolean(busy) || !selected.installed}
                    >
                      试穿
                    </button>
                  )}
                  <button
                    className="secondary"
                    onClick={() =>
                      onRequestSkinAction({
                        label: "恢复默认外观",
                        execute: () =>
                          void run("恢复默认", "restore_skin_package", {
                            confirm: true,
                          }),
                      })
                    }
                    disabled={Boolean(busy)}
                  >
                    恢复默认
                  </button>
                </div>
              </div>
              <p className="integrity">
                <ShieldCheck size={16} /> 皮肤包经过 SHA256 完整性校验。
              </p>
            </>
          ) : (
            <Empty label="选择一个皮肤查看预览。" />
          )}
        </article>
      </div>
    </section>
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
    const next = { ...settings, ...patch };
    if (!runningInTauri) {
      setSettings(next);
      return;
    }
    try {
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

function SettingsView({ onCheck }: { onCheck: () => void }) {
  const [section, setSection] = useState<
    "general" | "runtime" | "data" | "advanced"
  >("general");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  const [configPath, setConfigPath] = useState("");
  useEffect(() => {
    void Promise.all([
      settingsApi.get(),
      settingsApi.getAutoLaunchStatus(),
      settingsApi.getAppConfigPath(),
    ])
      .then(([value, launch, path]) => {
        setSettings(value);
        setAutoLaunch(launch);
        setConfigPath(path);
      })
      .catch((reason) =>
        toast.error("无法读取设置", { description: String(reason) }),
      );
  }, []);
  const save = async (patch: Partial<Settings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    try {
      await settingsApi.save(next);
      setSettings(next);
      toast.success("设置已保存");
    } catch (reason) {
      toast.error("设置保存失败", { description: String(reason) });
    }
  };
  const toggleAutoLaunch = async () => {
    try {
      const value = await settingsApi.setAutoLaunch(!(autoLaunch ?? false));
      setAutoLaunch(value);
      toast.success(value ? "已开启开机启动" : "已关闭开机启动");
    } catch (reason) {
      toast.error("设置失败", { description: String(reason) });
    }
  };
  const pickPortable = async () => {
    const path = await settingsApi.pickDirectory(settings?.codexPortableRoot);
    if (path) await save({ codexPortableRoot: path });
  };
  const pickData = async () => {
    const path = await settingsApi.pickDirectory(configPath);
    if (!path) return;
    try {
      await settingsApi.setAppConfigDirOverride(path);
      setConfigPath(path);
      toast.success("数据目录已更新，重启后生效");
    } catch (reason) {
      toast.error("目录设置失败", { description: String(reason) });
    }
  };
  return (
    <section className="settings-layout">
      <aside>
        {[
          ["general", "常规"],
          ["data", "数据与隐私"],
          ["runtime", "更新策略"],
          ["advanced", "高级"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={section === id ? "active" : ""}
            onClick={() => setSection(id as typeof section)}
          >
            {label}
          </button>
        ))}
      </aside>
      <article className="panel settings-panel">
        {section === "general" && (
          <>
            <h2>常规</h2>
            <button
              className="setting-row"
              onClick={() => void toggleAutoLaunch()}
            >
              <div>
                <b>开机启动 Chimera++</b>
                <p>登录 Windows 后自动运行</p>
              </div>
              <span>
                {autoLaunch === null ? "读取中" : autoLaunch ? "开启" : "关闭"}
                <ChevronDown size={14} />
              </span>
            </button>
            <div className="setting-row">
              <div>
                <b>语言</b>
                <p>当前版本的客户界面语言</p>
              </div>
              <span>简体中文</span>
            </div>
          </>
        )}
        {section === "runtime" && (
          <>
            <h2>Codex 更新策略</h2>
            <div className="setting-control">
              <div>
                <b>更新来源</b>
                <p>自动选择官方通道，或使用稳定镜像</p>
              </div>
              <div className="segmented">
                <button
                  className={
                    settings?.codexUpdateSource !== "mirror" ? "active" : ""
                  }
                  onClick={() => void save({ codexUpdateSource: "auto" })}
                >
                  自动
                </button>
                <button
                  className={
                    settings?.codexUpdateSource === "mirror" ? "active" : ""
                  }
                  onClick={() => void save({ codexUpdateSource: "mirror" })}
                >
                  镜像
                </button>
              </div>
            </div>
            <div className="setting-control">
              <div>
                <b>安装方式</b>
                <p>标准安装由 Windows 管理；免安装版由 Chimera++ 管理</p>
              </div>
              <div className="segmented">
                <button
                  className={
                    settings?.codexInstallMode !== "portable" ? "active" : ""
                  }
                  onClick={() => void save({ codexInstallMode: "standard" })}
                >
                  稳定版
                </button>
                <button
                  className={
                    settings?.codexInstallMode === "portable" ? "active" : ""
                  }
                  onClick={() => void save({ codexInstallMode: "portable" })}
                >
                  免安装版
                </button>
              </div>
            </div>
            <button
              className="setting-row"
              onClick={() =>
                void save({
                  checkCodexUpdatesOnStart: !settings?.checkCodexUpdatesOnStart,
                })
              }
            >
              <div>
                <b>启动时检查 Codex 更新</b>
                <p>仅检查，不会静默安装</p>
              </div>
              <span>
                {settings?.checkCodexUpdatesOnStart ? "开启" : "关闭"}
                <ChevronDown size={14} />
              </span>
            </button>
            {settings?.codexInstallMode === "portable" && (
              <button
                className="setting-row"
                onClick={() => void pickPortable()}
              >
                <div>
                  <b>免安装版目录</b>
                  <p title={settings.codexPortableRoot}>
                    {settings.codexPortableRoot || "使用 Chimera++ 默认目录"}
                  </p>
                </div>
                <FolderOpen size={16} />
              </button>
            )}
            <div className="settings-actions">
              <button onClick={onCheck}>
                <RefreshCw size={15} /> 立即检查 Codex 更新
              </button>
            </div>
          </>
        )}
        {section === "data" && (
          <>
            <h2>数据与隐私</h2>
            <button className="setting-row" onClick={() => void pickData()}>
              <div>
                <b>Chimera++ 数据目录</b>
                <p title={configPath}>{configPath || "读取中"}</p>
              </div>
              <FolderOpen size={16} />
            </button>
            <button
              className="setting-row"
              onClick={() => void settingsApi.openAppConfigFolder()}
            >
              <div>
                <b>打开数据目录</b>
                <p>查看配置、日志和本机备份</p>
              </div>
              <span>
                打开 <ChevronDown size={14} />
              </span>
            </button>
          </>
        )}
        {section === "advanced" && (
          <>
            <h2>高级</h2>
            <div className="setting-row">
              <div>
                <b>Codex 免安装版目录</b>
                <p title={settings?.codexPortableRoot || undefined}>
                  {settings?.codexPortableRoot || "自动识别默认安装目录"}
                </p>
              </div>
              <span>只在免安装模式下使用</span>
            </div>
            <div className="setting-row">
              <div>
                <b>更新与维护操作保护</b>
                <p>升级、修复、回滚、卸载和皮肤应用均要求二次确认</p>
              </div>
              <span>已启用</span>
            </div>
            <div className="settings-actions">
              <button onClick={onCheck}>
                <RefreshCw size={15} /> 检查 Codex 更新
              </button>
            </div>
          </>
        )}
      </article>
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
          <button onClick={onCancel}>稍后重启</button>
          <button className="primary" onClick={onConfirm}>
            立即重启 Codex
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
function Empty({
  label,
  action,
  onAction,
}: {
  label: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty">
      <p>{label}</p>
      {action && (
        <button className="primary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  detail,
  success = false,
}: {
  label: string;
  value: string;
  detail: string;
  success?: boolean;
}) {
  return (
    <article>
      <span>{label}</span>
      <b className={success ? "ok" : ""}>{value}</b>
      <small>{detail}</small>
    </article>
  );
}
void ProvidersView;
void ActivityView;
void RuntimeView;
void SettingsView;
