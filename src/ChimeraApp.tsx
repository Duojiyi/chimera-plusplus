import { RetainedToolPage } from "@/components/RetainedToolPage";
import { ToolVisibilityView } from "./views/ToolVisibilityView";
import { isProductToolVisible } from "@/lib/productCapabilities";
import { WindowControls } from "@/components/WindowControls";
import { DRAG_REGION_ATTR, isMac } from "@/lib/platform";
import { useLightweightClose } from "@/hooks/useLightweightClose";
import {
  Fragment,
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
import {
  Activity,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronsUpDown,
  CircleCheck,
  CircleAlert,
  type Command,
  Cpu,
  Download,
  Eye,
  EyeOff,
  FileText,
  ListChecks,
  LoaderCircle,
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
  TriangleAlert,
  Users,
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
import {
  classifyModelFetchError,
  fetchModelsForConfig,
  type DetectedCodexApiFormat,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import { getChimeraHubTemplate } from "@/config/codexTemplates";
import { CodexContextWindowField } from "@/components/providers/CodexContextWindowField";
import type { PresetDraftSeed } from "@/utils/codexPresetDraft";
import {
  extractCodexBaseUrl,
  extractCodexExperimentalBearerToken,
  extractCodexModelName,
  isCodexGoalModeEnabled,
  isCodexRemoteCompactionEnabled,
  removeCodexTopLevelKey,
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
  codexDraftRouting,
  codexGlobalReasoningEffort,
  codexProbeModels,
  extractCodexMappingRows,
  loadOperationRecords,
  pickDefaultFetchedModel,
  previousCatalogAsFetched,
  saveOperationRecords,
  setCodexProviderApiKey,
  type ConnectionState,
  type OperationRecord,
} from "./chimeraUtils";
import { DisabledReason, HelpTip } from "@/components/ui/help-tip";
import { CodexModelPicker } from "@/components/providers/CodexModelPicker";
import {
  ANTHROPIC_AUTH_HELP,
  ANTHROPIC_AUTH_OPTIONS,
  EditorAdvanced,
  EditorChoice,
  EditorField,
  EditorInUseNotice,
  EditorLabel,
  EditorSaveActions,
  EditorSaveSummary,
  EditorSelect,
  EditorTemplateCard,
  EditorTestAction,
  EditorToggle,
  Field,
  ModelFetchNotice,
  NEW_LINE_NAME,
  OneMCheck,
  PROMPT_CACHE_OPTIONS,
  ROUTED_PROTOCOL_NOTE,
  previewOrigin as addressOrigin,
  SaveLabel,
  SectionStatus,
  type EditorChoiceOption,
  type ModelFetchAction,
  type ModelFetchIssue,
} from "@/components/providers/ProviderEditorFields";
import { autoLineBadgeText } from "@/utils/lineBadge";
import { describeCodexRouting } from "@/utils/codexRouting";
import { readContextWindowState } from "@/utils/codexContextWindow";
import { Empty } from "@/components/Empty";
import { type ReceiptTone } from "@/components/OperationReceipt";
import {
  CODEX_CLOSE_SCOPE,
  CODEX_RESTART_SCOPE,
  conclusionLine,
  describeNotes,
  errorText,
  isPlainChinese,
  parseOperationError,
  suggestNextSteps,
  type ReceiptNextStep,
} from "@/lib/operationReceipt";
import {
  CLAUDE_TIER_ROWS,
  CLAUDE_TIERS_FOLLOWING_DEFAULT,
  claudeModelFieldLabel,
  claudeModelOneM,
  claudeModelValue,
  claudeTierLabel,
  emptyClaudeTiers,
  isNativeToolAppId,
  nativeToolNames,
  toolProviderFields,
  updateToolProviderConfig,
  withClaudeModel,
  withClaudeOneM,
  type ClaudeModelField,
} from "@/utils/toolProviderConfig";
import { useSettingsQuery } from "@/lib/query/queries";
import routeGateIcon from "@/assets/icons/chimera-dragon-mark.png";
import "./chimera.css";
import "./components/ProviderEditorPage.css";
import "@/theme/v3/shell.css";
import { TOOL_SECTIONS, TOOLS_WITH_ACCOUNTS } from "./views/ToolSectionNav";
import { version as APP_VERSION } from "../package.json";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
// Codex 管理 loads on demand like the other pages, with its stylesheets.
const NewRuntimeView = lazy(() =>
  import("./views/CodexRuntimeView").then(({ NewRuntimeView }) => ({
    default: NewRuntimeView,
  })),
);

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
/** 切换线路后撤销条的保留时长（用户定调：10 分钟）。 */
const LINE_UNDO_WINDOW_MS = 10 * 60 * 1000;

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
import { LineBadge } from "@/components/LineBadge";
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
export type RuntimeStatus = {
  supported: boolean;
  installed: boolean;
  version?: string | null;
  installMode?: string | null;
  installPath?: string | null;
  canRepair: boolean;
  canRollback: boolean;
  canUninstall: boolean;
  /** The current install, then the version a rollback restores (`previous`). */
  history?: Array<{ version: string; state: string }>;
  /** `flat` | `nested` | `interrupted` for the portable root. */
  portableLayout?: string | null;
  /** One Chinese sentence about the portable layout, when relevant. */
  layoutNotice?: string | null;
  /** A registered MSIX next to the managed portable install. */
  unmanagedStandardVersion?: string | null;
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
  /** Running, but no stable main window within 30 s: launched, not failed. */
  startupSlow?: boolean;
  startupNotice?: string | null;
  layoutMigration?: { state: string; message: string } | null;
};

/**
 * Layout warnings already shown in this window, by state and message. A
 * deferred migration (Codex still running) is retried on every launch; the
 * user is told once per app session, not on every open.
 */
const shownLayoutWarnings = new Set<string>();

/** Startup and layout follow-ups of a launch, shown after its success toast. */
export function notifyLaunchFollowUps(result: CodexLaunchResult) {
  if (result.startupSlow && result.startupNotice) {
    toast.warning("Codex 启动较慢", { description: result.startupNotice });
  }
  const migration = result.layoutMigration;
  if (migration?.state === "migrated" || migration?.state === "recovered") {
    shownLayoutWarnings.clear();
    toast.info("免安装版目录结构已更新", { description: migration.message });
  } else if (migration && migration.state !== "not-needed") {
    const key = `${migration.state}\n${migration.message}`;
    if (shownLayoutWarnings.has(key)) return;
    shownLayoutWarnings.add(key);
    toast.warning("免安装版目录结构未升级", { description: migration.message });
  }
}
export type ReleaseStatus = {
  currentVersion?: string | null;
  latestVersion: string;
  updateAvailable: boolean;
  installMode: string;
  sizeBytes: number;
  source: string;
  releasedAt?: string | null;
};
type ProductCapabilities = { capabilities: ProductCapability[] };
type Diagnostic = {
  name: string;
  result: string;
  /** Stable reason code for a failed or warning item. */
  kind?: string | null;
  /** One plain-Chinese sentence: the specific reason and the next step. */
  detail?: string | null;
};
export type DownloadProgress = {
  downloaded: number;
  total: number;
  stage?: "downloading" | "installing";
  /** Times the download started over after a dropped connection. */
  retries?: number;
};
export type RuntimeAction = "update" | "repair" | "rollback" | "uninstall";
export type RuntimeUpdatePreferences = {
  source: "auto" | "mirror";
  installMode: "standard" | "portable";
};
type PendingRuntimeAction = {
  action: RuntimeAction;
  preferences?: RuntimeUpdatePreferences;
};
export type RuntimeOperation = {
  action: RuntimeAction;
  stage: "preparing" | "downloading" | "installing";
};
/** What a runtime mutation reports; older builds may return nothing. */
export type RuntimeOperationResult = {
  version: string;
  requestedMode: string;
  actualMode: string;
  affectedPath?: string | null;
  backupPath?: string | null;
  message: string;
  notes: string[];
};
export type RuntimeReceiptKind =
  RuntimeAction | "install" | "check" | "diagnose" | "history" | "offline";
/** The persistent "最近一次操作" record on the Codex 管理 page. */
export type RuntimeReceipt = {
  id: number;
  kind: RuntimeReceiptKind;
  tone: ReceiptTone;
  at: number;
  title: string;
  lines: string[];
  notes: string[];
  detail: string | null;
  steps: ReceiptNextStep[];
  preferences?: RuntimeUpdatePreferences;
};
// v2.5.0 M3：历史版本 / 离线安装 / 安装事务恢复
export type CodexRuntimeReleaseItem = {
  tag: string;
  name?: string | null;
  publishedAt?: string | null;
  prerelease: boolean;
  installable: boolean;
};
export type CodexRuntimeReleasePlan = {
  version: string;
  packageVersion: string;
  packageMoniker: string;
  packageUrl: string;
  sha256: string;
  sizeBytes: number;
  releasedAt?: string | null;
};
export type CodexOfflineInspection = {
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
export type CodexInstallRecoveryEntry = {
  id: string;
  startedAt: number;
  version: string;
  installMode: string;
  source: string;
  state: string;
  detail?: string | null;
  backupPath?: string | null;
};
// The one list of page names, in sidebar order. The sidebar, the screen-reader
// page heading and the command palette all read their labels from here.
const nav: Array<[View, string, typeof Command]> = [
  ["providers", "线路", Route],
  ["official-accounts", "官方账号", Users],
  ["prompts", "提示词", FileText],
  ["skills-mcp", "Skills 与 MCP", Cpu],
  ["usage", "用量", BarChart3],
  ["runtime", "Codex 管理", Package],
  ["appearance", "外观", Paintbrush],
  ["health", "配置体检", Activity],
  ["tool-claude", "Claude Code", Route],
  ["tool-claude-desktop", "Claude Desktop", Route],
  ["tool-gemini", "Gemini CLI", Route],
  ["tool-opencode", "OpenCode", Route],
  ["tool-pi", "Pi", Route],
  ["tool-omp", "oh-my-pi", Route],
  ["tool-grokbuild", "Grok Build", Route],
  ["tool-settings", "管理工具", Settings2],
  ["sessions", "会话", MessagesSquare],
  ["settings", "设置", Settings2],
];

const viewLabels: Record<View, string> = Object.fromEntries(
  nav.map(([id, label]) => [id, label]),
) as Record<View, string>;

// Other tools carry an outlined two-character tool mark.
const toolViews: Array<[View, string]> = [
  ["tool-claude", "CC"],
  ["tool-claude-desktop", "CD"],
  ["tool-gemini", "Gm"],
  ["tool-opencode", "OC"],
  ["tool-pi", "Pi"],
  ["tool-omp", "Om"],
  ["tool-grokbuild", "Gk"],
];

/**
 * v3 sidebar groups. The sidebar shows one tool at a time (the tool switcher
 * above the nav picks it); these two groups are the Codex workspace, which is
 * the tool the app opens on.
 */
const workspaceViews: View[] = [
  // 官方账号 is the second tab of 线路 (LinesAccountsTabs), not its own item.
  "providers",
  "prompts",
  "skills-mcp",
  "usage",
];
const localViews: View[] = ["runtime", "appearance", "health"];

const navIconFor = (id: View): typeof Command => {
  switch (id) {
    case "providers":
      return Route;
    case "official-accounts":
      return Users;
    case "prompts":
      return FileText;
    case "skills-mcp":
      return Cpu;
    case "usage":
      return BarChart3;
    case "runtime":
      return Package;
    case "appearance":
      return Paintbrush;
    case "health":
      return Activity;
    default:
      return FileText;
  }
};

/** Sidebar tool identity: one line-coloured bar per tool, like a transit line. */
const toolKeyFor = (id: View): string =>
  id === "tool-claude"
    ? "claude"
    : id === "tool-claude-desktop"
      ? "claude-desktop"
      : id === "tool-gemini"
        ? "gemini"
        : id === "tool-opencode"
          ? "opencode"
          : id === "tool-pi"
            ? "pi"
            : id === "tool-omp"
              ? "omp"
              : id === "tool-grokbuild"
                ? "grokbuild"
                : "codex";

/** The ToolView / TOOL_SECTIONS id of each tool view. */
const toolPageIdFor: Partial<Record<View, string>> = {
  "tool-claude": "claude-code",
  "tool-claude-desktop": "claude-desktop",
  "tool-gemini": "gemini-cli",
  "tool-opencode": "opencode",
  "tool-pi": "pi",
  "tool-omp": "omp",
  "tool-grokbuild": "grokbuild",
};
/** The 提示词 target of each tool whose prompt file this app manages. */
const toolPromptsAppFor: Partial<Record<View, AppId | "omp">> = {
  "tool-claude": "claude",
  "tool-gemini": "gemini",
  "tool-opencode": "opencode",
  "tool-grokbuild": "grokbuild",
  "tool-pi": "pi",
  "tool-omp": "omp",
};
/** The Skills 与 MCP target of each tool that has managed resources. */
const toolResourcesAppFor: Partial<Record<View, AppId>> = {
  "tool-claude": "claude",
  "tool-gemini": "gemini",
  "tool-opencode": "opencode",
  "tool-grokbuild": "grokbuild",
};

export const runtimeText = (mode?: string | null) =>
  mode === "standard"
    ? "标准安装"
    : mode === "portable"
      ? "免安装版"
      : "未识别安装方式";

export const formatMegabytes = (bytes: number) =>
  `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const RUNTIME_RECEIPT_ACTIONS: Record<RuntimeReceiptKind, string> = {
  update: "更新",
  install: "安装",
  repair: "修复",
  rollback: "回滚",
  uninstall: "卸载",
  check: "检查更新",
  diagnose: "运行诊断",
  history: "安装所选版本",
  offline: "离线安装",
};

export const ensureStop = (text: string) =>
  /[。.!?！？]$/.test(text) ? text : `${text}。`;

let runtimeReceiptSeq = 0;

export function runtimeFailureReceipt(
  kind: RuntimeReceiptKind,
  error: unknown,
  preferences?: RuntimeUpdatePreferences,
): RuntimeReceipt {
  const parsed = parseOperationError(error);
  const conclusion = conclusionLine(parsed);
  return {
    id: ++runtimeReceiptSeq,
    kind,
    tone: "error",
    at: Date.now(),
    title: `${RUNTIME_RECEIPT_ACTIONS[kind]}失败`,
    lines: conclusion
      ? [conclusion, parsed.network, parsed.advice].filter(
          (line): line is string => Boolean(line),
        )
      : ["没有收到可以直接显示的原因，可展开技术详情查看。"],
    notes: [],
    detail: parsed.raw || null,
    steps: suggestNextSteps(parsed, {
      downloads: ["update", "install", "repair", "check", "history"].includes(
        kind,
      ),
    }),
    preferences,
  };
}

export function runtimeSuccessReceipt(
  kind: RuntimeReceiptKind,
  result: RuntimeOperationResult | null | undefined,
  fallbackVersion?: string | null,
  preferences?: RuntimeUpdatePreferences,
): RuntimeReceipt {
  const version = result?.version || fallbackVersion || "";
  const named = version ? `Codex ${version}` : "Codex";
  const title =
    kind === "update"
      ? `已更新到 ${named}`
      : kind === "repair"
        ? `已修复 ${named}`
        : kind === "rollback"
          ? `已回滚到 ${named}`
          : kind === "uninstall"
            ? `已卸载 ${named}`
            : `已安装 ${named}`;
  const notes = describeNotes(result?.notes);
  const fellBack =
    result?.actualMode === "portable_fallback" ||
    (kind !== "uninstall" &&
      result?.requestedMode === "standard" &&
      result?.actualMode === "portable");
  const lines: string[] = [];
  if (fellBack) lines.push("标准安装不可用，已改为安装免安装版。");
  if (result?.message && isPlainChinese(result.message))
    lines.push(ensureStop(result.message));
  else if (result && !fellBack && kind !== "uninstall")
    lines.push(`安装方式：${runtimeText(result.actualMode)}。`);
  if (kind === "uninstall")
    lines.push("线路配置和 ~/.codex 中的会话与设置已保留，可以随时重新安装。");
  const detail = result
    ? [
        `版本：${result.version}`,
        `安装方式：${result.requestedMode} → ${result.actualMode}`,
        result.affectedPath ? `位置：${result.affectedPath}` : "",
        result.backupPath ? `备份：${result.backupPath}` : "",
        result.message ? `消息：${result.message}` : "",
        ...notes.technical.map((note) => `提示：${note}`),
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  return {
    id: ++runtimeReceiptSeq,
    kind,
    tone: fellBack ? "warning" : "success",
    at: Date.now(),
    title,
    lines,
    notes: notes.visible.filter((note) => !lines.includes(note)),
    detail: detail || null,
    steps: [],
    preferences,
  };
}

export const withReceiptLine = (
  receipt: RuntimeReceipt,
  line: string,
): RuntimeReceipt => ({ ...receipt, lines: [...receipt.lines, line] });

type CodexEndpointInput = {
  baseUrl: string;
  apiKey: string;
  isFullUrl: boolean;
  modelsUrl: string;
  customUserAgent: string;
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

/**
 * ChimeraHub's address for a new native-tool line. Claude Code and Gemini CLI
 * append their own API path (`/v1/messages`, `/v1beta/…`), so they get the
 * origin; OpenCode and Pi take the OpenAI-compatible `/v1` base as it is.
 */
function chimeraHubBaseUrlFor(appId: AppId): string {
  const baseUrl = getChimeraHubTemplate().baseUrl;
  return appId === "claude" || appId === "gemini"
    ? baseUrl.replace(/\/v1\/?$/, "")
    : baseUrl;
}

export function providerDraft(
  provider?: Provider | null,
  suggestedName?: string,
  appId: AppId = "codex",
) {
  const native = isNativeToolAppId(appId)
    ? toolProviderFields(appId, provider)
    : null;
  // Only a brand-new line starts from the template; an existing line keeps its
  // own values, and a missing one stays empty instead of becoming ChimeraHub's.
  const template = native
    ? { name: NEW_LINE_NAME, websiteUrl: "", config: "", auth: {} }
    : provider
      ? { name: provider.name, websiteUrl: "", config: "", auth: {} }
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
    badgeText: typeof meta.badgeText === "string" ? meta.badgeText : "",
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
    codexAutoReviewModel:
      typeof meta.codexAutoReviewModel === "string"
        ? meta.codexAutoReviewModel
        : "",
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
    claudeTiers: emptyClaudeTiers(),
    subagentModel: "",
    ...native,
    ...(!provider && native ? { baseUrl: chimeraHubBaseUrlFor(appId) } : {}),
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
      setResourcesTool(null);
      setPromptsTool(null);
      setFootTool(null);
      // Skills 与 MCP opened any other way than from a tool is Codex's.
      setSkillsAppId("codex");
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
  // Section of each tool page shown in its sidebar (design system §4.1).
  const [toolSections, setToolSections] = useState<Record<string, string>>({});
  const [toolSwitcherOpen, setToolSwitcherOpen] = useState(false);
  // Skills 与 MCP opened from a tool keeps that tool's sidebar.
  const [resourcesTool, setResourcesTool] = useState<View | null>(null);
  // 会话 and 设置 opened from a tool keep that tool's sidebar.
  const [footTool, setFootTool] = useState<View | null>(null);
  const manageToolResources = canNavigate("skills-mcp")
    ? (appId: AppId) => {
        const owner =
          (Object.entries(toolResourcesAppFor).find(
            ([, app]) => app === appId,
          )?.[0] as View | undefined) ?? null;
        setView("skills-mcp");
        setSkillsAppId(appId);
        setResourcesTool(owner);
      }
    : undefined;
  // 提示词 opened from a tool keeps that tool's sidebar, like Skills 与 MCP.
  const [promptsTool, setPromptsTool] = useState<View | null>(null);
  const [promptsAppId, setPromptsAppId] = useState<AppId | "omp">("codex");
  const openToolPrompts = (tool: View) => {
    const app = toolPromptsAppFor[tool];
    if (!app || !canNavigate("prompts")) return;
    setPromptsAppId(app);
    setView("prompts");
    setPromptsTool(tool);
  };
  const multiToolEnabled = hasEnabledCapability(capabilities, "multi_tool");
  const skinEnabled = hasEnabledCapability(capabilities, "codex_themes");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [currentSource, setCurrentSource] = useState<
    "live" | "stored" | "external" | "none"
  >("none");
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  // The palette's bulk speed test runs in the line table, so each result
  // lands on its own row instead of on the current line's signboard.
  const [speedTestRequested, setSpeedTestRequested] = useState(false);
  const activeProvider = useMemo(
    () =>
      currentSource === "external" || currentSource === "none"
        ? null
        : (providers.find((p) => p.id === currentId) ?? null),
    [providers, currentId, currentSource],
  );
  const lineLabels = useMemo(() => codexLineLabels(providers), [providers]);
  const lineName = useCallback(
    (provider: Provider) =>
      lineLabels.get(provider.id)?.name ?? (provider.name || "未命名线路"),
    [lineLabels],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Never stack the palette over a confirmation or another dialog.
        setCmdPaletteOpen((prev) => (prev ? false : openDialogCount() === 0));
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
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeReceipt, setRuntimeReceipt] = useState<RuntimeReceipt | null>(
    null,
  );
  const runtimeStatusSeqRef = useRef(0);
  const [editor, setEditor] = useState<ReturnType<typeof providerDraft> | null>(
    null,
  );
  const [editorAppId, setEditorAppId] = useState<AppId>("codex");
  const [editorInUse, setEditorInUse] = useState(false);
  const [models, setModels] = useState<FetchedModel[] | null>(null);
  const [modelFetchIdentity, setModelFetchIdentity] = useState<string | null>(
    null,
  );
  const [modelFetchError, setModelFetchError] =
    useState<ModelFetchIssue | null>(null);
  // Default model filled in from the latest list because the field was empty.
  const [suggestedModel, setSuggestedModel] = useState<string | null>(null);
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
    detail?: string;
    execute: () => void;
  } | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // The Claude Code field the model list fills when it opens.
  const [modelPickTarget, setModelPickTarget] =
    useState<ClaudeModelField>("default");
  const [pendingEditorDiscard, setPendingEditorDiscard] = useState(false);
  // The discard question was raised by the window's close button, so a
  // confirmed discard also closes the window.
  const [closeWindowAfterDiscard, setCloseWindowAfterDiscard] = useState(false);
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
  void modelFetchError;
  void commonConfigLoading;
  void fetchingModels;
  void showKey;
  void draftConnection;
  void editorSaveError;

  const openEditor = (
    draft: ReturnType<typeof providerDraft>,
    appId: AppId = "codex",
    // Codex knows its own current line; other tools pass theirs in.
    inUse = appId === "codex" &&
      Boolean(draft.original) &&
      draft.original?.id === activeProvider?.id,
  ) => {
    editorOpenSeqRef.current += 1;
    editorRef.current = draft;
    editorReturnFocusRef.current = document.activeElement as HTMLElement | null;
    setEditorSaveError(null);
    setModels(null);
    setModelFetchError(null);
    editorBaselineRef.current = editorDraftSignature(draft);
    setEditorAppId(appId);
    setEditorInUse(inUse);
    setEditor(draft);
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
      openEditor(providerDraft(null, NEW_LINE_NAME, appId), appId);
      return;
    }
    try {
      const additive = appId === "opencode" || appId === "pi";
      const [all, current] = await Promise.all([
        providersApi.getAll(appId),
        // Additive tools have no current line; an enabled one is in use. The
        // current line only decides a notice, so failing to read it is no
        // reason to keep the editor shut.
        additive
          ? Promise.resolve("")
          : providersApi.getCurrent(appId).catch(() => ""),
      ]);
      if (!ownsOpen()) return;
      const provider = all[lineId];
      if (!provider) throw new Error("线路不存在或已被删除");
      openEditor(
        providerDraft(provider, undefined, appId),
        appId,
        additive
          ? provider.meta?.liveConfigManaged !== false
          : current === provider.id,
      );
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
  // The window's close button while a line is being edited: nothing typed means
  // it closes as usual; unsaved input is asked about first, as for 取消.
  const guardWindowClose = () => {
    const draft = editorRef.current;
    if (!draft) return false;
    if (providerSaveInFlightRef.current) return true;
    if (
      isEditorDraftDirty(draft, editorBaselineRef.current) ||
      commonConfigDirty
    ) {
      setCloseWindowAfterDiscard(true);
      setPendingEditorDiscard(true);
      return true;
    }
    return false;
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

      // A drag region is handled by Tauri's own drag script (drag.js), which
      // also turns a double-click there into maximize; starting a second drag
      // from here would race it.
      const target = event.target as HTMLElement;
      if (
        target.closest(
          'button, input, textarea, select, a, [role="button"], [data-tauri-no-drag], [data-tauri-drag-region]',
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
      toast.error("无法读取线路列表", { description: String(error) });
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

  const loadRuntime = async (): Promise<RuntimeStatus | null> => {
    if (!runningInTauri) {
      setRuntime(null);
      return null;
    }
    // Page entry, focus refreshes and post-install reloads overlap; only the
    // newest read may update the page. A failure stays on the page as an
    // error state instead of a toast that disappears.
    const seq = ++runtimeStatusSeqRef.current;
    try {
      const status = await invoke<RuntimeStatus>("get_codex_runtime_status");
      if (seq !== runtimeStatusSeqRef.current) return null;
      setRuntime(status);
      setRuntimeError(null);
      return status;
    } catch (error) {
      if (seq !== runtimeStatusSeqRef.current) return null;
      setRuntime(null);
      setRuntimeError(errorText(error) || "读取失败");
      return null;
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
              `Codex 正在运行，重启后才会使用最新配置。${CODEX_RESTART_SCOPE}是否继续？`,
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
      notifyLaunchFollowUps(result);
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
        // An automatic retry starts over from zero; count it so the page can
        // say the download restarted instead of showing a bar going backwards.
        setDownloadProgress((current) => ({
          downloaded: payload.downloaded,
          total: payload.total,
          retries:
            (current?.retries ?? 0) +
            (current && payload.downloaded < current.downloaded ? 1 : 0),
          stage:
            payload.total > 0 && payload.downloaded >= payload.total
              ? "installing"
              : "downloading",
        }));
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
    // The automatic check after startup reports success on the station sign
    // only; a toast for it would cover whatever the user opened meanwhile.
    { quietSuccess = false }: { quietSuccess?: boolean } = {},
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
      if (!quietSuccess) {
        toast.success("地址可达", {
          description: `响应时间 ${result.latency} ms · 未验证密钥或模型`,
        });
      }
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
        if (endpoint)
          void testConnection(endpoint, current.name, "home", {
            quietSuccess: true,
          });
      })
      .catch(() => {
        // Startup validation is optional and must never block the main window.
      });
  }, [activeProvider, loading]);

  // `formatOverride` backs the "按 Chat / Responses / Anthropic 保存" quick
  // actions shown when detection fails: the choice is applied to the draft and
  // saved in one step, so a failed probe never strands the user.
  // `activate` false saves the line without making it the tool's current one:
  // editing a spare line must not rewrite the live config or restart Codex.
  const saveProvider = async (
    formatOverride?: CodexApiFormat,
    activate = true,
  ) => {
    if (designPreview) return;
    if (!editor) return;
    const draft =
      formatOverride && formatOverride !== editor.apiFormat
        ? { ...editor, apiFormat: formatOverride }
        : editor;
    if (draft !== editor) {
      editorRef.current = draft;
      setEditor(draft);
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
            if (activate) {
              await providersApi.updateAndActivate(
                provider,
                editorAppId,
                draft.original.id,
              );
            } else {
              await providersApi.update(
                provider,
                editorAppId,
                draft.original.id,
              );
            }
          } else if (activate) {
            await providersApi.addAndActivate(provider, editorAppId, false);
          } else {
            await providersApi.add(provider, editorAppId, false);
          }
          window.dispatchEvent(
            new CustomEvent("chimera-provider-mutated", {
              detail: { appId: editorAppId },
            }),
          );
          toast.success(
            activate
              ? `${nativeToolNames[editorAppId]} 线路已保存并应用`
              : `${nativeToolNames[editorAppId]} 线路已保存，当前线路不变`,
          );
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
          // Empty means unset: the key is left out, never saved as "".
          codexAutoReviewModel: draft.codexAutoReviewModel.trim() || undefined,
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
      const commonConfigDraft =
        editorAppId === "codex" && commonConfigLoaded && commonConfigDirty
          ? commonConfigSnippet
          : undefined;
      let providerCommitted = false;
      try {
        if (!activate) {
          // The shared common config is applied to the live file, so a change
          // to it cannot be saved without making this line current.
          if (commonConfigDraft !== undefined) {
            setEditorSaveError(
              "通用配置有改动，需要用「保存并切换」才能写入 Codex。",
            );
            return;
          }
          if (draft.original) {
            await providersApi.update(
              provider,
              editorAppId,
              draft.original.id,
              { clearApiKey: codexApiKeyCleared(draft.original, draft.apiKey) },
            );
          } else {
            await providersApi.add(provider, editorAppId, false);
          }
          await loadProviders();
          window.dispatchEvent(
            new CustomEvent("chimera-provider-mutated", {
              detail: { appId: editorAppId },
            }),
          );
          closeEditor();
          note("保存线路", "success", undefined, provider.name);
          toast.success("线路已保存", {
            description: "没有切换线路，Codex 仍使用当前线路。",
          });
          return;
        }
        if (draft.original) {
          // "保存并应用" must not leave an edited inactive provider behind if
          // its activation fails. The backend updates, switches and compensates
          // under one transaction using its own current pointer.
          await providersApi.updateAndActivate(
            provider,
            editorAppId,
            draft.original.id,
            {
              clearApiKey: codexApiKeyCleared(draft.original, draft.apiKey),
              commonConfigSnippet: commonConfigDraft,
            },
          );
        } else {
          await providersApi.addAndActivate(
            provider,
            editorAppId,
            false,
            commonConfigDraft,
          );
        }
        providerCommitted = true;
        if (editorAppId === "codex") setCodexRestartRequired(true);
        // A later failure must retry an update, not add the same route again.
        const savedDraft = { ...draft, original: provider };
        editorRef.current = savedDraft;
        setEditor(savedDraft);
        if (commonConfigDraft !== undefined) {
          commonConfigBaselineRef.current = commonConfigDraft;
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
            `线路已保存并应用，但模型目录未正确应用。编辑内容已保留，请根据错误说明处理后重新保存。${String(error)}`,
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

  const fetchModels = async (options: { refetch?: boolean } = {}) => {
    if (!editor?.baseUrl.trim() || !editor.apiKey.trim()) {
      toast.error("请先填写 API 请求地址和 API Key");
      return;
    }

    const draft = editor;
    const endpointIdentity = codexEndpointIdentity(draft);
    // A list already fetched for this endpoint reopens without another request;
    // the picker's own 重新获取 forces a refresh.
    if (
      !options.refetch &&
      models !== null &&
      models.length > 0 &&
      modelFetchIdentity === endpointIdentity
    ) {
      setModelPickerOpen(true);
      return;
    }
    const fetchSeq = ++fetchModelsSeqRef.current;
    setFetchingModels(true);
    setModelFetchError(null);
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
      setModelFetchError(result.length ? null : { kind: "empty" });
      note(
        "获取模型",
        "success",
        `获取到 ${result.length} 个模型`,
        latest.name || "未命名供应商",
      );

      // An empty default model gets a suggestion (the first fetched entry that
      // is not an embedding / rerank / speech / image model). The picker that
      // opens next shows the count and the suggestion, so no toast repeats it.
      // Claude Code leaves an empty default model to the tool itself.
      let suggested: string | null = null;
      if (editorAppId === "codex" && !latest.model.trim()) {
        suggested = pickDefaultFetchedModel(result) ?? null;
        if (suggested) {
          const value = suggested;
          setEditor((currentEditor) =>
            currentEditor &&
            currentEditor.id === latest.id &&
            !currentEditor.model.trim()
              ? { ...currentEditor, model: value }
              : currentEditor,
          );
        }
      }
      setSuggestedModel(suggested);
      setModelPickerOpen(result.length > 0);
    } catch (error) {
      if (fetchSeq !== fetchModelsSeqRef.current) return;
      // The raw error stays in the activity log; the editor shows the reason
      // and the one action that addresses it.
      note("获取模型", "error", String(error), draft.name || "未命名供应商");
      setModels([]);
      setModelFetchIdentity(endpointIdentity);
      setModelFetchError({
        kind: "error",
        code: classifyModelFetchError(error),
      });
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
        // A successful check supersedes the receipt of a failed one.
        setRuntimeReceipt((current) =>
          current?.kind === "check" ? null : current,
        );
        toast.success(
          result.updateAvailable ? "发现新版本" : "Codex 已是最新版本",
        );
      }
      return result;
    } catch (error) {
      if (checkSeq !== runtimeCheckSeqRef.current) return null;
      if (announce) {
        setRuntimeReceipt(runtimeFailureReceipt("check", error, preferences));
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
  const runtimeViewActiveRef = useRef(view === "runtime");
  useEffect(() => {
    runtimeViewActiveRef.current = view === "runtime";
    if (view !== "runtime") return;
    void loadRuntime();
  }, [view]);

  // An update offer is computed against the Codex detected at check time. If
  // a later read finds another version (updated outside Chimera++ while the
  // window was in the background), the offer is stale: drop it instead of
  // offering to "update" to what is already installed.
  useEffect(() => {
    if (!runtime || !release) return;
    const detected = runtime.installed ? (runtime.version ?? null) : null;
    if ((release.currentVersion ?? null) === detected) return;
    runtimeCheckSeqRef.current += 1;
    setRelease(null);
  }, [runtime]);

  /** Resolves false when the update status could not be refreshed. */
  const refreshRuntimeAfterInstall = async (
    preferences?: RuntimeUpdatePreferences,
  ): Promise<boolean> => {
    // Do not leave the just-consumed update offer visible while the two
    // authoritative backend queries refresh runtime and release state.
    setRelease(null);
    const [, refreshedRelease] = await Promise.all([
      loadRuntime(),
      checkRuntime(preferences, { announce: false }),
    ]);
    return Boolean(refreshedRelease);
  };

  // 设置页挂载后才监听 hashchange，等“代理与故障转移”分区出现再跳过去。
  const openProxySettings = () => {
    setView("settings");
    const deadline = Date.now() + 3000;
    const jump = () => {
      if (document.getElementById("settings-connections")) {
        window.setTimeout(() => {
          window.location.hash = "settings-connections";
        }, 50);
      } else if (Date.now() < deadline) {
        window.setTimeout(jump, 50);
      }
    };
    window.setTimeout(jump, 50);
  };

  const diagnose = async () => {
    setDiagnosing(true);
    try {
      const result = await invoke<Diagnostic[]>("diagnose_codex_runtime");
      setDiagnostics(result);
      setRuntimeReceipt((current) =>
        current?.kind === "diagnose" ? null : current,
      );
      note("运行诊断", "success", `${result.length} 项`);
    } catch (error) {
      note("运行诊断", "error", errorText(error));
      setRuntimeReceipt(runtimeFailureReceipt("diagnose", error));
      if (!runtimeViewActiveRef.current)
        toast.error("Codex 诊断失败", {
          description: "原因见“Codex 管理”页。",
        });
    } finally {
      setDiagnosing(false);
    }
  };
  void diagnose;

  const runRuntimeAction = async () => {
    if (!pendingAction) return;
    const { action, preferences } = pendingAction;
    const kind: RuntimeReceiptKind =
      action === "update" && runtime?.installed === false ? "install" : action;
    const label = RUNTIME_RECEIPT_ACTIONS[kind];
    const expectedVersion = release?.latestVersion ?? null;
    const started = performance.now();
    // Close the confirmation immediately. Keeping it mounted allows a second
    // click to enter the backend lock and produces a misleading duplicate-app
    // error while the first operation is still running.
    setPendingAction(null);
    setRuntimeReceipt(null);
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
      let result: RuntimeOperationResult | null;
      if (action === "update") {
        result = await invoke<RuntimeOperationResult | null>(
          "apply_codex_runtime_update",
          {
            expectedVersion,
            source: preferences?.source ?? null,
            installMode: preferences?.installMode ?? null,
            confirm: true,
          },
        );
      } else if (action === "repair") {
        result = await invoke<RuntimeOperationResult | null>(
          "repair_codex_runtime",
          {
            source: null,
            installMode: null,
            confirm: true,
          },
        );
      } else if (action === "rollback") {
        result = await invoke<RuntimeOperationResult | null>(
          "rollback_codex_runtime",
          { confirm: true },
        );
      } else {
        result = await invoke<RuntimeOperationResult | null>(
          "uninstall_codex_runtime",
          { confirm: true },
        );
      }
      note(
        `Codex ${label}`,
        "success",
        undefined,
        "Codex",
        performance.now() - started,
      );
      let receipt = runtimeSuccessReceipt(
        kind,
        result,
        action === "rollback" || action === "uninstall"
          ? null
          : expectedVersion,
        preferences,
      );
      if (action === "update" || action === "repair") {
        if (!(await refreshRuntimeAfterInstall(preferences)))
          receipt = withReceiptLine(
            receipt,
            "更新状态没有刷新成功，可以稍后重新检查；已安装的版本不受影响。",
          );
      } else {
        runtimeCheckSeqRef.current += 1;
        setRelease(null);
        await loadRuntime();
      }
      setRuntimeReceipt(receipt);
      if (!runtimeViewActiveRef.current) toast.success(receipt.title);
    } catch (error) {
      note(
        `Codex ${label}`,
        "error",
        errorText(error),
        "Codex",
        performance.now() - started,
      );
      setRuntimeReceipt(runtimeFailureReceipt(kind, error, preferences));
      if (!runtimeViewActiveRef.current)
        toast.error(`Codex ${label}失败`, {
          description: "原因与下一步见“Codex 管理”页。",
        });
      // A failed run can still have changed the installation; show what is
      // actually there now.
      void loadRuntime();
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

  // --- v3 sidebar: one tool at a time, three groups, one nav-item shape ---
  // Tool views and the tool's Skills 与 MCP page show that tool's sidebar;
  // everything else is the Codex workspace.
  const toolView: View | null =
    view.startsWith("tool-") && view !== "tool-settings"
      ? view
      : view === "skills-mcp" && resourcesTool && canNavigate(resourcesTool)
        ? resourcesTool
        : view === "prompts" && promptsTool && canNavigate(promptsTool)
          ? promptsTool
          : (view === "sessions" || view === "settings") &&
              footTool &&
              canNavigate(footTool)
            ? footTool
            : null;
  const currentToolKey = toolView ? toolKeyFor(toolView) : "codex";
  const currentToolName = toolView ? viewLabels[toolView] : "Codex";
  const toolPageId = toolView ? toolPageIdFor[toolView] : undefined;
  const toolSectionList = toolPageId ? TOOL_SECTIONS[toolPageId] : undefined;
  const defaultToolSection =
    toolView === "tool-pi" || toolView === "tool-omp" ? "routes" : "lines";
  const toolHasAccounts = Boolean(
    toolPageId && TOOLS_WITH_ACCOUNTS.has(toolPageId),
  );
  const currentToolSection =
    toolView === view && toolPageId
      ? (toolHasAccounts && toolSections[toolPageId] === "accounts") ||
        toolSectionList?.some((item) => item.id === toolSections[toolPageId])
        ? toolSections[toolPageId]
        : defaultToolSection
      : view === "skills-mcp"
        ? "resources"
        : view === "prompts"
          ? "prompts"
          : "";
  const sectionChangeFor = (pageId: string) => (id: string) =>
    setToolSections((current) =>
      current[pageId] === id ? current : { ...current, [pageId]: id },
    );
  const openToolSection = (tool: View, id: string) => {
    const pageId = toolPageIdFor[tool];
    if (!pageId) return;
    if (id === "resources") {
      const app = toolResourcesAppFor[tool];
      if (app) manageToolResources?.(app);
      return;
    }
    if (id === "prompts") {
      openToolPrompts(tool);
      return;
    }
    setToolSections((current) => ({ ...current, [pageId]: id }));
    setView(tool);
  };
  const crumbPage = toolView
    ? currentToolSection === "accounts"
      ? "官方账号"
      : (toolSectionList?.find((item) => item.id === currentToolSection)
          ?.label ?? viewLabels[view])
    : viewLabels[view];
  const switchTool = (target: View) => {
    setToolSwitcherOpen(false);
    setView(target);
  };

  /** `sub`: shown as part of the item above it (官方账号 under 线路). */
  const renderNavItem = (id: View, sub = false) => {
    const label = viewLabels[id];
    const Icon = navIconFor(id);
    const active = view === id;
    const available = canNavigate(id);
    return (
      <button
        key={id}
        type="button"
        onClick={() => setView(id)}
        disabled={!available}
        aria-current={active ? "page" : undefined}
        title={available ? undefined : `${label}：此版本未开放`}
        data-pencil-name={`能力 · ${label}`}
        className={sub ? "v3-nav-item is-sub" : "v3-nav-item"}
      >
        <Icon size={15} aria-hidden="true" className="v3-nav-icon" />
        <span className="v3-nav-text">{label}</span>
        {!available && (
          <span aria-hidden="true" className="v3-nav-hint">
            未开放
          </span>
        )}
      </button>
    );
  };

  const renderToolSectionItem = (item: {
    id: string;
    label: string;
    icon: typeof Command;
  }) => {
    if (!toolView) return null;
    const Icon = item.icon;
    const resources = item.id === "resources";
    const available = resources
      ? Boolean(manageToolResources)
      : item.id === "prompts"
        ? canNavigate("prompts")
        : true;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => openToolSection(toolView, item.id)}
        disabled={!available}
        aria-current={currentToolSection === item.id ? "page" : undefined}
        aria-label={
          resources ? `管理 ${currentToolName} 的 Skills 与 MCP` : undefined
        }
        data-pencil-name={`分区 · ${item.label}`}
        className={
          item.id === "accounts" ? "v3-nav-item is-sub" : "v3-nav-item"
        }
      >
        <Icon size={15} aria-hidden="true" className="v3-nav-icon" />
        <span className="v3-nav-text">{item.label}</span>
      </button>
    );
  };

  const renderFootItem = (id: View, Icon: typeof Command) => {
    const label = viewLabels[id];
    const active = view === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => {
          const from = toolView;
          setView(id);
          setFootTool(from);
        }}
        aria-current={active ? "page" : undefined}
        data-pencil-name={label}
        className="v3-nav-item"
      >
        <Icon size={15} aria-hidden="true" className="v3-nav-icon" />
        <span className="v3-nav-text">{label}</span>
      </button>
    );
  };
  return (
    <div className="chimera-shell">
      {/* The sidebar alone is eighteen tab stops; this jumps past it. */}
      <a
        className="skip-link"
        href="#chimera-content"
        onClick={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
      >
        跳到主要内容
      </a>
      {/* 216px Sidebar (Frame 01 HdG9j). The graphite chrome is dark in both
          themes, so its tokens resolve as dark (designer-notes §31). */}
      {!editor && (
        <aside data-pencil-name="侧栏" className="chimera-sidebar">
          {/* 字标区 */}
          <div
            data-pencil-name="字标区"
            className="v3-sidebar-brand"
            {...DRAG_REGION_ATTR}
          >
            {isMac() && <WindowControls onBeforeClose={guardWindowClose} />}
            <span aria-hidden="true" className="v3-sidebar-logo">
              C
            </span>
            <span className="v3-sidebar-brandtext">
              <span data-pencil-name="字标" className="v3-sidebar-wordmark">
                Chimera++
              </span>
              <span className="v3-sidebar-version">{APP_VERSION}</span>
            </span>
          </div>

          {/* 工具切换器：当前工具 + 线路色竖条，点开是工具列表。 */}
          <Popover open={toolSwitcherOpen} onOpenChange={setToolSwitcherOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-pencil-name="工具切换器"
                aria-label={`切换工具，当前：${currentToolName}`}
                className="v3-tool-switch"
              >
                <span
                  aria-hidden="true"
                  className="v3-tool-bar"
                  data-tool={currentToolKey}
                />
                <span className="v3-tool-switch-text">
                  <span className="v3-tool-switch-name">{currentToolName}</span>
                  <span className="v3-tool-switch-sub">当前工具</span>
                </span>
                <ChevronsUpDown size={14} aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              className="v3-tool-menu"
              aria-label="切换工具"
            >
              <div className="v3-tool-menu-list" role="group" aria-label="工具">
                <button
                  type="button"
                  className="v3-tool-menu-item"
                  aria-current={!toolView ? "true" : undefined}
                  aria-label="Codex"
                  onClick={() => switchTool("providers")}
                >
                  <span
                    aria-hidden="true"
                    className="v3-tool-bar"
                    data-tool="codex"
                  />
                  <span className="v3-tool-menu-name">Codex</span>
                  <span className="v3-tool-menu-kind">切换型</span>
                  {!toolView && <Check size={13} aria-hidden="true" />}
                </button>
                {/* Tools hidden in 管理工具 are left out; tools this build or
                    policy has not opened stay listed, disabled. */}
                {toolViews
                  .filter(
                    ([id]) =>
                      !runningInTauri ||
                      isProductToolVisible(id, toolSettings?.visibleApps),
                  )
                  .map(([id]) => (
                    <button
                      key={id}
                      type="button"
                      className="v3-tool-menu-item"
                      aria-current={toolView === id ? "true" : undefined}
                      aria-label={viewLabels[id]}
                      disabled={!canNavigate(id)}
                      title={
                        canNavigate(id)
                          ? undefined
                          : `${viewLabels[id]}：此版本未开放`
                      }
                      onClick={() => switchTool(id)}
                    >
                      <span
                        aria-hidden="true"
                        className="v3-tool-bar"
                        data-tool={toolKeyFor(id)}
                      />
                      <span className="v3-tool-menu-name">
                        {viewLabels[id]}
                      </span>
                      <span className="v3-tool-menu-kind">
                        {id === "tool-opencode" || id === "tool-pi"
                          ? "累加型"
                          : id === "tool-omp"
                            ? "独立配置"
                            : "切换型"}
                      </span>
                      {toolView === id && (
                        <Check size={13} aria-hidden="true" />
                      )}
                    </button>
                  ))}
              </div>
              {canNavigate("tool-settings") && (
                <button
                  type="button"
                  className="v3-tool-menu-manage"
                  onClick={() => switchTool("tool-settings")}
                >
                  <Plus size={14} aria-hidden="true" />
                  管理工具
                </button>
              )}
            </PopoverContent>
          </Popover>

          <nav className="chimera-navigation" aria-label="工具与功能">
            {toolSectionList ? (
              <div className="v3-nav-group">
                <div className="v3-nav-group-label">工作区</div>
                {/* 提示词 sits right after the tool's lines, as in Codex. */}
                {/* 官方账号 is part of 线路: a sub-item right under it. */}
                {toolSectionList
                  .flatMap((item, index) =>
                    index === 0
                      ? [
                          item,
                          ...(toolHasAccounts
                            ? [
                                {
                                  id: "accounts",
                                  label: "官方账号",
                                  icon: Users,
                                },
                              ]
                            : []),
                          ...(toolView && toolPromptsAppFor[toolView]
                            ? [
                                {
                                  id: "prompts",
                                  label: "提示词",
                                  icon: FileText,
                                },
                              ]
                            : []),
                        ]
                      : [item],
                  )
                  .map(renderToolSectionItem)}
              </div>
            ) : (
              <>
                <div className="v3-nav-group">
                  <div className="v3-nav-group-label">工作区</div>
                  {workspaceViews.flatMap((id) =>
                    id === "providers"
                      ? [
                          renderNavItem(id),
                          renderNavItem("official-accounts", true),
                        ]
                      : [renderNavItem(id)],
                  )}
                </div>

                <div className="v3-nav-group">
                  <div className="v3-nav-group-label">本机</div>
                  {localViews.map((id) => renderNavItem(id))}
                </div>
              </>
            )}
          </nav>

          <div className="v3-sidebar-foot">
            {renderFootItem("sessions", MessagesSquare)}
            {renderFootItem("settings", Settings2)}
          </div>
        </aside>
      )}

      <main
        className={`chimera-main${view === "usage" ? " is-usage-view" : ""}${editor ? " is-editing-provider" : ""}`}
      >
        {/* 标题栏 52px：左面包屑，右搜索胶囊与窗口按钮。 */}
        <header
          data-pencil-name="标题栏"
          className="chimera-titlebar"
          onMouseDown={handleTitlebarMouseDown}
          onDoubleClick={preventTitlebarDoubleClick}
        >
          <div className="v3-crumb" {...DRAG_REGION_ATTR}>
            {isMac() && editor && (
              <WindowControls onBeforeClose={guardWindowClose} />
            )}
            <span className="v3-crumb-tool">{currentToolName}</span>
            <span aria-hidden="true" className="v3-crumb-sep">
              /
            </span>
            <span className="v3-crumb-page">
              {editor ? (editor.original ? "编辑线路" : "添加线路") : crumbPage}
            </span>
            {!runningInTauri && (
              <span
                className="v3-preview-chip"
                title={
                  designPreview
                    ? "设计示例 · 非本机数据 · 写入及测速已禁用"
                    : "浏览器预览 · 未连接本机，不读取或修改本机配置"
                }
              >
                {designPreview ? "设计示例" : "浏览器预览 · 未连接本机"}
              </span>
            )}
          </div>

          <button
            type="button"
            aria-label="搜索线路、页面或命令"
            data-pencil-name="搜索"
            onClick={() => setCmdPaletteOpen(true)}
            className="v3-search"
            data-tauri-no-drag
          >
            <Search size={14} aria-hidden="true" />
            <span className="v3-search-placeholder">搜索线路、页面或命令</span>
            <span aria-hidden="true" className="v3-kbd">
              {isMac() ? "⌘ K" : "Ctrl K"}
            </span>
          </button>

          <div className="v3-window-controls" data-tauri-no-drag>
            {titlebarHasUpdate && (
              <button
                type="button"
                onClick={() => void runTitlebarUpdateCheck()}
                title={`发现新版本 ${titlebarUpdateInfo?.availableVersion ?? ""}，点击更新`}
                className="v3-update-chip"
              >
                <Download size={13} aria-hidden="true" />
                <span>更新</span>
              </button>
            )}
            {!isMac() && <WindowControls onBeforeClose={guardWindowClose} />}
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
          id="chimera-content"
          tabIndex={-1}
          hidden={Boolean(editor)}
          className={`chimera-content${view === "providers" ? " is-provider-view" : ""}`}
        >
          {view === "providers" && loadError && (
            <section className="provider-page">
              <header className="provider-page-heading">
                <div>
                  <h2>线路</h2>
                  <p>Codex 同一时间只走一条线路</p>
                </div>
              </header>
              <div className="route-load-error" role="alert">
                <div className="route-load-error-head">
                  <strong>
                    <CircleAlert size={16} aria-hidden="true" />
                    无法读取线路列表
                  </strong>
                  <button
                    type="button"
                    onClick={() => void retryLoadProviders()}
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <LoaderCircle
                          className="spin"
                          size={14}
                          aria-hidden="true"
                        />
                        正在重试…
                      </>
                    ) : (
                      <>
                        <RefreshCw size={14} aria-hidden="true" />
                        重试
                      </>
                    )}
                  </button>
                </div>
                <p>请稍后重试；读取失败不会修改任何配置。</p>
                <pre>{loadError}</pre>
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
                  providerDraft(
                    null,
                    providers.length ? NEW_LINE_NAME : "默认线路",
                  ),
                )
              }
              onTestSpeed={testConnection}
              testAllRequested={speedTestRequested}
              onTestAllHandled={() => setSpeedTestRequested(false)}
            />
          )}
          {view === "runtime" && (
            <Suspense
              fallback={
                <div className="route-loading" role="status">
                  正在加载模块…
                </div>
              }
            >
              <NewRuntimeView
                runtime={runtime}
                runtimeError={runtimeError}
                release={release}
                progress={downloadProgress}
                operation={runtimeOperation}
                receipt={runtimeReceipt}
                onCheck={checkRuntime}
                onDiagnose={diagnose}
                diagnosing={diagnosing}
                onAction={(action, preferences) =>
                  setPendingAction({ action, preferences })
                }
                onRuntimeChanged={refreshRuntimeAfterInstall}
                onOperationFinished={() => setDownloadProgress(null)}
                onRetryRuntime={() => void loadRuntime()}
                onRefreshStatus={loadRuntime}
                onReceipt={setRuntimeReceipt}
                onOpenProxySettings={openProxySettings}
              />
            </Suspense>
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
              <PromptsView
                key={promptsTool ? promptsAppId : "codex"}
                initialApp={promptsTool ? promptsAppId : "codex"}
                refreshVersion={providerRefreshVersion}
                visibleApps={toolSettings?.visibleApps ?? {}}
              />
            )}
            {view === "skills-mcp" && (
              <SkillsMcpView
                key={skillsAppId}
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
                section={toolSections["claude-desktop"]}
                onSectionChange={sectionChangeFor("claude-desktop")}
                native={runningInTauri}
                refreshVersion={providerRefreshVersion}
              />
            )}
            {view === "tool-grokbuild" && (
              <ToolView
                toolId="grokbuild"
                section={toolSections["grokbuild"]}
                onSectionChange={sectionChangeFor("grokbuild")}
                onManageResources={manageToolResources}
                native={runningInTauri}
                refreshVersion={providerRefreshVersion}
              />
            )}

            {view === "tool-claude" && (
              <ToolView
                refreshVersion={providerRefreshVersion}
                toolId="claude-code"
                section={toolSections["claude-code"]}
                onSectionChange={sectionChangeFor("claude-code")}
                onEditLine={openToolEditor}
                native={runningInTauri}
                onManageResources={manageToolResources}
              />
            )}
            {view === "tool-gemini" && (
              <ToolView
                refreshVersion={providerRefreshVersion}
                toolId="gemini-cli"
                section={toolSections["gemini-cli"]}
                onSectionChange={sectionChangeFor("gemini-cli")}
                onEditLine={openToolEditor}
                native={runningInTauri}
                onManageResources={manageToolResources}
              />
            )}
            {view === "tool-opencode" && (
              <ToolView
                refreshVersion={providerRefreshVersion}
                toolId="opencode"
                section={toolSections["opencode"]}
                onSectionChange={sectionChangeFor("opencode")}
                onEditLine={openToolEditor}
                native={runningInTauri}
                onManageResources={manageToolResources}
              />
            )}
          </Suspense>
          <RetainedToolPage active={view === "tool-omp"}>
            <OmpView
              native={runningInTauri}
              section={toolSections.omp}
              onSectionChange={sectionChangeFor("omp")}
            />
          </RetainedToolPage>
          <RetainedToolPage active={view === "tool-pi"}>
            <ToolView
              refreshVersion={providerRefreshVersion}
              toolId="pi"
              section={toolSections.pi}
              onSectionChange={sectionChangeFor("pi")}
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
              modelsFetched={
                models !== null &&
                models.length > 0 &&
                modelFetchIdentity === codexEndpointIdentity(editor)
              }
              commonConfigSnippet={commonConfigSnippet}
              commonConfigLoading={commonConfigLoading}
              commonConfigLoaded={commonConfigLoaded}
              onCommonConfigChange={(value) => {
                if (savingProvider) return;
                setCommonConfigSnippet(value);
                setCommonConfigDirty(value !== commonConfigBaselineRef.current);
              }}
              onFetchModels={(target = "default") => {
                setModelPickTarget(target);
                void fetchModels();
              }}
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
              onSave={(activate) => void saveProvider(undefined, activate)}
              onDelete={() => {
                if (editor.original) setPendingProviderDelete(editor.original);
              }}
              onRequestClose={requestCloseEditor}
              context1mEnabled={hasEnabledCapability(
                capabilities,
                "context_1m",
              )}
              inUse={editorInUse}
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
        lineName={lineName}
        pages={nav
          .filter(([id]) => canNavigate(id))
          .map(([id, label, icon]) => ({ id, label, icon }))}
        onSwitchProvider={(id) => void switchProvider(id)}
        onNavigate={(targetView) => setView(targetView as View)}
        onAddProvider={() => {
          if (editor) {
            toast.info("请先保存或关闭当前正在编辑的线路");
            return;
          }
          openEditor(
            providerDraft(null, providers.length ? NEW_LINE_NAME : "默认线路"),
          );
        }}
        onSpeedTestAll={() => {
          if (editor) {
            toast.info("请先保存或关闭当前正在编辑的线路");
            return;
          }
          setView("providers");
          setSpeedTestRequested(true);
        }}
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
      {/* The other tools fill one field from the list; Codex also edits its
          mapping rows there. The 当前 tag compares IDs without a 1M marker. */}
      {editor && models && modelPickerOpen && editorAppId !== "codex" && (
        <CodexModelPicker
          models={models}
          defaultModel={claudeModelValue(editor, modelPickTarget)}
          target={claudeModelFieldLabel(modelPickTarget)}
          refetching={fetchingModels}
          onPick={(model) => {
            setEditor(
              editorAppId === "claude"
                ? withClaudeModel(editor, modelPickTarget, model)
                : { ...editor, model },
            );
            setModelPickerOpen(false);
          }}
          onRefetch={() => void fetchModels({ refetch: true })}
          onClose={() => setModelPickerOpen(false)}
        />
      )}
      {editor && models && modelPickerOpen && editorAppId === "codex" && (
        <CodexModelPicker
          models={models}
          defaultModel={editor.model}
          rows={editor.catalogModels}
          suggestedModel={suggestedModel}
          refetching={fetchingModels}
          onPick={(model, rows) => {
            setEditor({ ...editor, model, catalogModels: rows });
            setModelPickerOpen(false);
          }}
          onApply={(rows) => {
            setEditor({ ...editor, catalogModels: rows });
            setModelPickerOpen(false);
          }}
          onRefetch={() => void fetchModels({ refetch: true })}
          onClose={() => setModelPickerOpen(false)}
        />
      )}
      {pendingEditorDiscard && (
        <ConfirmDiscardEditor
          onCancel={() => {
            setPendingEditorDiscard(false);
            setCloseWindowAfterDiscard(false);
          }}
          onConfirm={() => {
            const closeWindow = closeWindowAfterDiscard;
            setCloseWindowAfterDiscard(false);
            closeEditor();
            if (closeWindow)
              void getCurrentWindow()
                .close()
                .catch(() => {});
          }}
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
              notifyLaunchFollowUps(result);
              if (result.modelUnlockError) {
                toast.warning("模型目录已保存；桌面端模型选择器增强未连接", {
                  description: result.modelUnlockError,
                });
              }
            } catch (error) {
              // Stays until dismissed: the reason is needed to fix it.
              toast.error("无法自动重启 Codex", {
                description: `${String(error)}。请彻底退出并重新打开 Codex。`,
                duration: Infinity,
              });
            }
          }}
        />
      )}
      {pendingSkinAction && (
        <ConfirmSkinOperation
          label={pendingSkinAction.label}
          detail={pendingSkinAction.detail}
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
          installed={runtime?.installed !== false}
          currentVersion={runtime?.installed ? runtime.version : null}
          targetVersion={
            pendingAction.action === "update"
              ? release?.latestVersion
              : pendingAction.action === "rollback"
                ? runtime?.history?.find((item) => item.state === "previous")
                    ?.version
                : null
          }
          installMode={
            pendingAction.action === "update"
              ? (pendingAction.preferences?.installMode ?? release?.installMode)
              : runtime?.installMode
          }
          sizeBytes={
            pendingAction.action === "update" ? release?.sizeBytes : undefined
          }
          onCancel={() => setPendingAction(null)}
          onConfirm={runRuntimeAction}
        />
      )}
      {diagnostics && (
        <DiagnosticsDialog
          diagnostics={diagnostics}
          runtime={runtime}
          onClose={() => setDiagnostics(null)}
          onRepair={
            runtime?.canRepair
              ? () => {
                  setDiagnostics(null);
                  setPendingAction({ action: "repair" });
                }
              : undefined
          }
          onInstall={
            runtime && !runtime.installed && runtime.supported
              ? () => {
                  setDiagnostics(null);
                  setPendingAction({ action: "update" });
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

type CodexLineLabel = { name: string; source: string; official: boolean };

/**
 * The name and source each Codex line has on screen. Template lines saved
 * under a generic name read as 默认线路 / 备用线路. The line list, the
 * signboard and the command palette all use these labels.
 *
 * Disambiguating the generic names parses every line's config.toml, so callers
 * derive the map once per provider list rather than per render.
 */
function codexLineLabels(providers: Provider[]): Map<string, CodexLineLabel> {
  const isChimera = (provider: Provider) => {
    const endpoint =
      extractCodexBaseUrl(String(provider.settingsConfig?.config ?? "")) ?? "";
    let host = endpoint;
    try {
      host = new URL(endpoint).hostname;
    } catch {
      // Not a parseable URL; match against the raw value instead.
    }
    return /(^|\.)chimerahub\.org$/i.test(host);
  };
  const chimeraIds = providers.filter(isChimera).map((item) => item.id);
  const labels = new Map<string, CodexLineLabel>();
  for (const provider of providers) {
    const official =
      provider.id === "codex-official" || provider.category === "official";
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
      official,
    });
  }
  return labels;
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
  testAllRequested = false,
  onTestAllHandled,
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
  /** Set by the command palette's 全部测速; forwarded to the line table. */
  testAllRequested?: boolean;
  onTestAllHandled?: () => void;
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
    /** Epoch ms of the switch; the bar shows the elapsed time from it. */
    switchedAt?: number;
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
  const lineLabels = useMemo(() => codexLineLabels(providers), [providers]);
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
  if (!providers.length)
    return (
      <section className="provider-page">
        <header className="provider-page-heading">
          <div>
            <h2>线路</h2>
            <p>Codex 同一时间只走一条线路 · 尚未添加线路</p>
          </div>
        </header>
        <Onboarding onAdd={onAdd} />
      </section>
    );
  const officialLoginRequired =
    currentIsOfficial && codexProcess?.officialLoginAvailable === false;
  const isOfficialLine = (provider: Provider) =>
    lineLabels.get(provider.id)?.official ?? false;
  const lineName = (provider: Provider) =>
    lineLabels.get(provider.id)?.name ?? provider.name ?? "未命名线路";
  const lineSource = (provider: Provider) =>
    lineLabels.get(provider.id)?.source ?? "自定义线路";
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
          switchedAt: Date.now(),
          onUndo: () => {
            if (undoTimerRef.current) {
              clearTimeout(undoTimerRef.current);
              undoTimerRef.current = null;
            }
            void onSwitch(previous.id);
            setUndoReceipt(null);
          },
        });
        // 用户定调：切线路不弹确认框，靠撤销条兜底，撤销窗口 10 分钟。
        undoTimerRef.current = setTimeout(() => {
          setUndoReceipt(null);
          undoTimerRef.current = null;
        }, LINE_UNDO_WINDOW_MS);
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
  // The design sample never starts a process, so the detection branch would
  // show "正在检测…" forever; the sample mirrors a running CLI instead.
  const codexButtonLabel = designPreview
    ? "打开 Codex"
    : launchingCodex
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
          onRestartCodex={
            !designPreview && codexProcess?.running && restartRequired
              ? () => void onOpenCodex()
              : undefined
          }
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
        currentConnection={connection}
        switchingId={switchingId}
        deletingProviderId={deletingProviderId}
        labels={lineLabels}
        testAllRequested={testAllRequested}
        onTestAllHandled={onTestAllHandled}
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
                      aria-current={active ? "true" : undefined}
                      onClick={() => void activateLine(provider)}
                    >
                      <span className="route-line-mark" aria-hidden="true">
                        {switching ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <LineBadge line={provider} />
                        )}
                      </span>
                      <span>
                        <b>{lineName(provider)}</b>
                        <small>{lineSource(provider)}</small>
                      </span>
                      {active && (
                        <span className="route-line-current">当前</span>
                      )}
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

/** A colour option: its swatch, then its name. */
const lineColorOption = (color: string, name: string) => (
  <>
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        marginRight: 8,
        borderRadius: 3,
        background: color,
      }}
    />
    {name}
  </>
);

const CODEX_FORMAT_OPTIONS: EditorChoiceOption<CodexApiFormatSelection>[] = [
  ["auto", "自动", "按默认模型的名称推断"],
  ["openai_responses", "Responses", "上游原生支持，可直连"],
  ["openai_chat", "Chat Completions", ROUTED_PROTOCOL_NOTE],
  ["anthropic", "Anthropic Messages", ROUTED_PROTOCOL_NOTE],
];

// Adapted from farion1231/cc-switch 8d7a7415
/** ChatGPT subscription window most relays serve GPT models from. */
const GPT_SUBSCRIPTION_WINDOW = 272_000;

/** A GPT mapping row whose typed window exceeds the subscription window:
 * kept as typed, but the form says what a relay usually serves. */
function gptWindowAboveSubscription(item: {
  model: string;
  contextWindow?: string | number;
}): boolean {
  const model = item.model.trim().toLowerCase().split("/").pop() ?? "";
  const tokens = Number(item.contextWindow);
  return (
    /^gpt-/.test(model) &&
    Number.isFinite(tokens) &&
    tokens > GPT_SUBSCRIPTION_WINDOW
  );
}

/** A mapping row's 思考等级 button text: the level count and default. */
function reasoningSummary(item: {
  reasoningLevels?: readonly string[];
  defaultReasoningLevel?: string;
}): string {
  const count = item.reasoningLevels?.length ?? 0;
  if (!count) return "自动";
  return item.defaultReasoningLevel
    ? `${count} 档 · ${item.defaultReasoningLevel}`
    : `${count} 档`;
}

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
  modelFetchError = null,
  modelsFetched = false,
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
  preserveOfficialLogin = null,
  deleteBlockedReason = null,
  inUse = false,
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
  /** Why the last model-list request gave nothing to pick from. */
  modelFetchError?: ModelFetchIssue | null;
  /** A model list for the current endpoint is loaded and can be reopened. */
  modelsFetched?: boolean;
  commonConfigSnippet: string;
  commonConfigLoading: boolean;
  commonConfigLoaded: boolean;
  onCommonConfigChange: (value: string) => void;
  /** Opens the loaded model list, or fetches it first; for Claude Code, the
   * field the list fills (the default model unless a tier is named). */
  onFetchModels: (target?: ClaudeModelField) => void;
  connection: ConnectionState;
  onTest: () => void;
  onSave: (activate: boolean) => void;
  onDelete: () => void;
  onRequestClose: () => void;
  escapeDisabled: boolean;
  /** The `context_1m` capability: shows the 1M context switch. */
  context1mEnabled?: boolean;
  /** `preserveCodexOfficialAuthOnSwitch`; null while settings are unknown. */
  preserveOfficialLogin?: boolean | null;
  /** Why the line cannot be deleted right now; null when it can. */
  deleteBlockedReason?: string | null;
  /** The line being edited is the one the tool uses (or, for OpenCode and
   * Pi, is enabled), so saving rewrites the tool's live config. */
  inUse?: boolean;
}) {
  const isCodex = appId === "codex";
  const isClaude = appId === "claude";
  const toolName = isNativeToolAppId(appId) ? nativeToolNames[appId] : "Codex";
  const needsModel = appId !== "claude" && appId !== "gemini";
  const nativeProtocolOptions: EditorChoiceOption<string>[] =
    appId === "opencode"
      ? [
          ["@ai-sdk/openai", "Responses"],
          ["@ai-sdk/openai-compatible", "Chat Completions"],
          ["@ai-sdk/anthropic", "Anthropic Messages"],
          ["@ai-sdk/google", "Gemini"],
        ]
      : [
          ["openai-responses", "Responses"],
          ["openai-completions", "Chat Completions"],
          ["anthropic-messages", "Anthropic Messages"],
          ["google-generative-ai", "Gemini"],
        ];
  // A protocol this editor has no name for stays selectable as itself.
  if (
    editor.nativeProtocol &&
    !nativeProtocolOptions.some(([value]) => value === editor.nativeProtocol)
  )
    nativeProtocolOptions.push([editor.nativeProtocol, editor.nativeProtocol]);
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
  // Claude Code's model fields as the editor opened them: the empty-tier
  // warning of a new line waits for the first change to any of them.
  const modelSignature = JSON.stringify([
    editor.model,
    editor.subagentModel,
    editor.claudeTiers,
  ]);
  const [initialModelSignature] = useState(modelSignature);
  const [modelsTouched, setModelsTouched] = useState(false);
  useEffect(() => {
    if (modelSignature !== initialModelSignature) setModelsTouched(true);
  }, [modelSignature, initialModelSignature]);
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
    if (saveError?.startsWith("通用配置无效")) {
      if (advancedRef.current) advancedRef.current.open = true;
      setCommonConfigOpen(true);
    }
  }, [saveError]);
  // The model picker can remove rows, which shifts every later index, so a
  // panel opened by index must not survive a change in the row count.
  const mappingRowCount = editor.catalogModels.length;
  useEffect(() => {
    setOpenReasoningRow(null);
    setOpenInstructionsRow(null);
  }, [mappingRowCount]);
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
      ...providerDraft(null, editor.name || NEW_LINE_NAME, appId),
      id: editor.id,
    });
    setRestorePending(false);
  };
  const submit = (activate: boolean) => {
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
    void onSave(activate);
  };
  const patch = (key: string, value: string) =>
    setEditor({ ...editor, [key]: value });
  const focusField = (name: string) => {
    const field = pageRef.current?.querySelector<HTMLElement>(
      `[name="${name}"]`,
    );
    field?.focus();
    field?.scrollIntoView?.({ block: "center" });
  };
  const onModelFetchAction = (action: ModelFetchAction) => {
    if (action === "retry") {
      onFetchModels();
      return;
    }
    if (action === "models-url" && advancedRef.current)
      advancedRef.current.open = true;
    focusField(
      action === "api-key" ? "provider-api-key" : "provider-models-url",
    );
  };
  const addMappingRow = () =>
    setEditor({
      ...editor,
      catalogModels: [
        ...editor.catalogModels,
        { model: "", displayName: "", contextWindow: "" },
      ],
    });
  const previewOrigin = addressOrigin(editor.baseUrl);
  const remoteCompactionAvailable = codexRemoteCompactionAllowed(
    editor.apiFormat,
    codexProbeModels(editor.model, editor.catalogModels),
  );
  const commonConfigWarning = useMemo(
    () => codexApprovalPolicyWarning(commonConfigSnippet),
    [commonConfigSnippet],
  );
  // Hints describe what saving will do: the protocol "auto" resolves to and
  // whether the saved line is sent directly or through the local router.
  const modelEntered = Boolean(editor.model.trim());
  const inferredFormat = codexApiFormatForModel(editor.model);
  const lineFormat =
    editor.apiFormat !== "auto"
      ? editor.apiFormat
      : modelEntered
        ? inferredFormat
        : null;
  const routing = isCodex && lineFormat ? codexDraftRouting(editor) : null;
  const addressHint = isClaude
    ? "Chimera++ 不改写这个地址；Claude Code 会在后面拼接 /v1/messages。"
    : !isCodex
      ? `按服务商文档填写 ${toolName} 的完整基础地址，Chimera++ 不改写这个地址。`
      : editor.isFullUrl
        ? "已开启完整 API 地址：按原样请求此地址，不补全路径。"
        : !routing
          ? "直连时填写完整基础地址；经本地路由时只填域名也可以。"
          : routing.routed
            ? "经本地路由：只填域名时会自动补 /v1。"
            : "直连上游：请填写完整基础地址，通常以 /v1 结尾。";
  const addressHelp = isCodex
    ? "Codex 在这个地址后拼接请求路径：直连时拼接 /responses；经本地路由时按协议拼接，只填域名会先补 /v1。"
    : isClaude
      ? "Claude Code 在这个地址后拼接 /v1/messages 发送请求。"
      : appId === "gemini"
        ? "Gemini CLI 在这个地址后拼接 /v1beta/models/… 等请求路径。"
        : `${toolName} 在这个地址后拼接所选协议的请求路径，例如 Chat Completions 拼接 /chat/completions。`;
  const protocolSummary = !isCodex
    ? (nativeProtocolOptions.find(
        ([value]) => value === editor.nativeProtocol,
      )?.[1] ?? `${toolName} 原生协议`)
    : editor.apiFormat !== "auto"
      ? codexApiFormatLabel(editor.apiFormat)
      : lineFormat
        ? `自动（${codexApiFormatLabel(lineFormat)}）`
        : "自动";
  const additive = appId === "opencode" || appId === "pi";
  // Editing a spare line only saves it; a new line is added and switched to,
  // with a plain save offered beside it. The line in use is rewritten live.
  const existing = Boolean(editor.original);
  const primarySave = additive
    ? { label: "保存并启用", activate: true }
    : !existing
      ? { label: "保存并切换", activate: true }
      : { label: "保存", activate: inUse };
  const secondarySave =
    additive || (existing && inUse)
      ? null
      : existing
        ? { label: "保存并切换", activate: true }
        : { label: "仅保存", activate: false };
  // Claude Code keeps a `[1M]` suffix on the stored model; the input shows
  // the bare ID and the 1M box shows the suffix.
  const defaultModelInput = isClaude
    ? claudeModelValue(editor, "default")
    : editor.model;
  const defaultModelId = defaultModelInput.trim();
  const defaultModelLabel = `${defaultModelId}${
    isClaude && claudeModelOneM(editor, "default") ? " · 1M" : ""
  }`;
  // An empty tier without a default model makes Claude Code ask for the
  // original Claude model name, which a third-party service may reject. A
  // blank new line waits until its models were touched or saving was tried.
  const unsetTiers =
    isClaude &&
    !defaultModelId &&
    editor.original?.category !== "official" &&
    (editor.original || modelsTouched || validationAttempted)
      ? CLAUDE_TIER_ROWS.filter(
          (tier) => !editor.claudeTiers[tier].model.trim(),
        ).map((tier) => claudeTierLabel(tier))
      : [];
  const basicMissing = [
    editor.name,
    editor.baseUrl,
    ...(isCodex ? [editor.apiKey] : []),
  ].filter((value) => !value.trim()).length;
  const protocolMissing = needsModel && !modelEntered ? 1 : 0;
  const globalReasoningEffort = isCodex
    ? codexGlobalReasoningEffort(editor.config)
    : null;
  const effortOverridesRows =
    globalReasoningEffort !== null &&
    editor.catalogModels.some((row) => Boolean(row.defaultReasoningLevel));
  const advancedActive = [
    editor.goalModeEnabled && "目标模式",
    context1mEnabled &&
      readContextWindowState(editor.config).enabled &&
      "1M 上下文",
    editor.remoteCompactionEnabled &&
      remoteCompactionAvailable &&
      "远程上下文压缩",
    editor.commonConfigEnabled && "应用通用配置",
    editor.isFullUrl && "完整 API 地址",
    editor.modelsUrl.trim() && "模型列表地址",
    editor.customUserAgent.trim() && "自定义 User-Agent",
    editor.codexAutoReviewModel.trim() && "自动审批模型",
    lineFormat === "anthropic" && editor.maxOutputTokens && "最大输出 tokens",
    lineFormat === "anthropic" &&
      editor.impersonateClaudeCode &&
      "模拟 Claude Code",
    lineFormat === "openai_chat" &&
      editor.promptCacheRouting !== "auto" &&
      "提示词缓存路由",
    lineFormat === "openai_chat" &&
      editor.codexChatReasoning.supportsThinking &&
      "思考模式",
  ].filter((item): item is string => Boolean(item));
  const badgeSource = {
    id: editor.original?.id,
    name: editor.name,
    category: editor.original?.category,
    meta: { badgeText: editor.badgeText },
  };
  const officialLoginNote =
    isCodex &&
    editor.original?.category !== "official" &&
    typeof preserveOfficialLogin === "boolean";
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
          <DisabledReason reason={deleteBlockedReason ?? undefined} align="end">
            <button
              type="button"
              className="danger"
              onClick={onDelete}
              disabled={savingProvider}
            >
              <Trash2 size={15} /> 删除线路
            </button>
          </DisabledReason>
        )}
      </header>
      <div className="editor-scroll">
        <fieldset className="editor-form" disabled={savingProvider}>
          <legend className="sr-only">线路配置</legend>
          {inUse && <EditorInUseNotice appId={appId} toolName={toolName} />}
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
          {!editor.original && (
            <EditorTemplateCard
              name={getChimeraHubTemplate().name}
              onRestore={() => setRestorePending(true)}
            />
          )}
          <section
            className="editor-basic"
            aria-labelledby="editor-basic-title"
          >
            <div className="editor-section-head">
              <h3 id="editor-basic-title">基础</h3>
              <SectionStatus missing={basicMissing} />
            </div>
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
                    <LineBadge
                      line={{ ...badgeSource, iconColor: editor.iconColor }}
                      size="sm"
                    />
                    <span>
                      {lineColors.find(
                        ([color]) =>
                          color.toLowerCase() ===
                          editor.iconColor?.toLowerCase(),
                      )?.[1] ?? (editor.iconColor ? "自定义" : "默认")}
                      {editor.badgeText.trim()
                        ? " · 自定义简称"
                        : " · 自动简称"}
                    </span>
                    修改 <ChevronDown size={14} />
                  </summary>
                  <div className="editor-appearance-panel">
                    <EditorField
                      label="简称"
                      htmlFor="provider-badge-text-input"
                      hint="最多 2 个汉字或 3 个字母，留空则按名称生成。"
                      hintId="provider-badge-text-hint"
                    >
                      <input
                        id="provider-badge-text-input"
                        name="provider-badge-text"
                        autoComplete="off"
                        spellCheck={false}
                        aria-describedby="provider-badge-text-hint"
                        value={editor.badgeText}
                        onChange={(event) =>
                          patch("badgeText", event.target.value)
                        }
                        placeholder={autoLineBadgeText(badgeSource)}
                      />
                    </EditorField>
                    <EditorField
                      label="线路颜色"
                      htmlFor="provider-line-color-input"
                    >
                      <EditorSelect
                        id="provider-line-color-input"
                        value={editor.iconColor ?? ""}
                        disabled={savingProvider}
                        onChange={(value) =>
                          setEditor({
                            ...editor,
                            iconColor: value || undefined,
                          })
                        }
                        options={[
                          [
                            "",
                            lineColorOption(lineColors[0][0], "默认（钴蓝）"),
                          ],
                          ...(editor.iconColor &&
                          !lineColors.some(
                            ([color]) => color === editor.iconColor,
                          )
                            ? [
                                [
                                  editor.iconColor,
                                  lineColorOption(
                                    editor.iconColor,
                                    "当前自定义颜色",
                                  ),
                                ] as const,
                              ]
                            : []),
                          ...lineColors.map(
                            ([color, name]) =>
                              [color, lineColorOption(color, name)] as const,
                          ),
                        ]}
                      />
                    </EditorField>
                  </div>
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
                hint={addressHint}
                help={addressHelp}
              />
              <EditorField
                label={isCodex ? "API Key *" : "API Key"}
                htmlFor="provider-api-key-input"
                help={
                  isCodex
                    ? "密钥只保存在本机，只用于这条线路的请求，不会出现在保存详情里。"
                    : "需要密钥的服务请填写；本地免认证服务，或工具自己已有有效登录时可以留空。"
                }
              >
                <div className="password-field">
                  <input
                    id="provider-api-key-input"
                    name="provider-api-key"
                    autoComplete="off"
                    spellCheck={false}
                    type={showKey ? "text" : "password"}
                    value={editor.apiKey}
                    onChange={(event) => patch("apiKey", event.target.value)}
                    placeholder="粘贴 API Key"
                  />
                  <button
                    type="button"
                    aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </EditorField>
              {officialLoginNote && (
                <p
                  className={
                    preserveOfficialLogin
                      ? "editor-official-login"
                      : "editor-official-login is-warning"
                  }
                >
                  {preserveOfficialLogin ? (
                    <CircleCheck size={15} aria-hidden="true" />
                  ) : (
                    <CircleAlert size={15} aria-hidden="true" />
                  )}
                  {preserveOfficialLogin
                    ? "ChatGPT 官方登录会保留：这条线路只负责 API 请求，切回官方线路无需重新登录。"
                    : "切换到这条线路会移除 ChatGPT 官方登录，之后切回官方线路需要重新登录。"}
                </p>
              )}
              <details className="chimera-disclosure is-inline editor-more-info">
                <summary>更多信息 · 备注、官网</summary>
                <div className="chimera-disclosure-body">
                  <Field
                    label="备注"
                    name="provider-notes"
                    value={editor.notes}
                    onChange={(value) => patch("notes", value)}
                    placeholder="例如：公司专用账号"
                  />
                  <Field
                    label="官网链接"
                    name="provider-website"
                    value={editor.websiteUrl}
                    onChange={(value) => patch("websiteUrl", value)}
                    placeholder="https://example.com"
                  />
                </div>
              </details>
            </div>
          </section>
          <section
            className="editor-protocol"
            aria-labelledby="editor-protocol-title"
          >
            <div className="editor-section-head">
              <h3 id="editor-protocol-title">协议与模型</h3>
              <SectionStatus missing={protocolMissing} />
            </div>
            {isCodex && (
              <EditorChoice
                name="provider-api-format"
                label="协议"
                help="自动：按默认模型的名称选择，GPT 系用 Responses，Claude 系用 Anthropic Messages，其余用 Chat Completions；保存时不探测上游。网关的实际协议不同时请手动指定。"
                value={editor.apiFormat}
                options={CODEX_FORMAT_OPTIONS}
                onChange={(value) => patch("apiFormat", value)}
              >
                <p className="editor-routing">
                  {editor.apiFormat === "auto" && (
                    <span>
                      {lineFormat
                        ? `按模型族推断为 ${codexApiFormatLabel(lineFormat)}`
                        : "填写默认模型后按模型族推断协议"}
                    </span>
                  )}
                  {routing && (
                    <span>保存后{describeCodexRouting(routing)}</span>
                  )}
                </p>
              </EditorChoice>
            )}
            {additive && (
              <EditorChoice
                name="provider-native-protocol"
                label="协议"
                help={`${toolName} 按这个协议请求上游；服务商通常在文档里写明支持的协议。`}
                value={editor.nativeProtocol}
                options={nativeProtocolOptions}
                onChange={(value) => patch("nativeProtocol", value)}
              />
            )}
            <EditorField
              className="editor-default-model"
              label={isCodex || needsModel ? "默认模型 *" : "默认模型（可选）"}
              htmlFor="provider-model-input"
            >
              <div className="editor-model-line">
                <div className="model-input">
                  <input
                    id="provider-model-input"
                    name="provider-model"
                    autoComplete="off"
                    spellCheck={false}
                    value={isClaude ? defaultModelInput : editor.model}
                    onChange={(event) =>
                      setEditor(
                        isClaude
                          ? withClaudeModel(
                              editor,
                              "default",
                              event.target.value,
                            )
                          : { ...editor, model: event.target.value },
                      )
                    }
                    placeholder={
                      isCodex
                        ? "先获取模型列表，或手动输入"
                        : needsModel
                          ? "填写服务商提供的模型 ID，或获取模型列表"
                          : "留空由工具决定，可获取模型列表或手动输入"
                    }
                  />
                  <button
                    type="button"
                    onClick={() => onFetchModels()}
                    disabled={fetchingModels || savingProvider}
                  >
                    {fetchingModels ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : modelsFetched ? (
                      <ListChecks size={15} />
                    ) : (
                      <Download size={15} />
                    )}{" "}
                    {modelsFetched ? "选择模型" : "获取模型"}
                  </button>
                </div>
                {isClaude && (
                  <OneMCheck
                    label="默认模型"
                    checked={claudeModelOneM(editor, "default")}
                    disabled={!defaultModelId}
                    onChange={(on) =>
                      setEditor(withClaudeOneM(editor, "default", on))
                    }
                  />
                )}
              </div>
              {modelFetchError && (
                <ModelFetchNotice
                  issue={modelFetchError}
                  onAction={onModelFetchAction}
                  canSetModelsUrl={isCodex}
                />
              )}
            </EditorField>
          </section>
          {isClaude && (
            <div className="advanced-group model-mapping">
              <div className="advanced-section-heading">
                <span className="editor-field-label">
                  <b>模型映射</b>
                  <HelpTip title="模型映射说明">
                    Claude Code 按 Sonnet、Opus、Fable、Haiku
                    档位请求模型，这里填写每档对应的上游实际模型。Sonnet、Opus、Haiku
                    留空时跟随默认模型；Fable 留空时，经本地路由会沿用
                    Opus。显示名是 Claude Code 模型菜单里看到的名字。勾选 1M
                    会在模型名后加 [1M]，告诉 Claude Code 这个模型支持 1M
                    上下文；只在服务商确实支持时勾选。
                  </HelpTip>
                </span>
              </div>
              <div className="mapping-head is-tiers" aria-hidden="true">
                <span>档位</span>
                <span>菜单显示名（可选）</span>
                <span>实际请求模型</span>
                <span>声明支持 1M</span>
              </div>
              {CLAUDE_TIER_ROWS.map((tier) => {
                const label = claudeTierLabel(tier);
                const slot = editor.claudeTiers[tier];
                const hasModel = Boolean(slot.model.trim());
                const followsDefault =
                  CLAUDE_TIERS_FOLLOWING_DEFAULT.includes(tier) &&
                  defaultModelId !== "";
                return (
                  <div className="mapping-row is-tiers" key={tier}>
                    <span className="mapping-role">{label}</span>
                    <input
                      aria-label={`${label} 菜单显示名`}
                      autoComplete="off"
                      spellCheck={false}
                      value={slot.name}
                      disabled={!hasModel}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          claudeTiers: {
                            ...editor.claudeTiers,
                            [tier]: { ...slot, name: event.target.value },
                          },
                        })
                      }
                      placeholder={hasModel ? "显示名" : "先填写模型"}
                    />
                    <div className="model-input">
                      <input
                        name={`provider-claude-${tier}-model`}
                        aria-label={`${label} 实际请求模型`}
                        autoComplete="off"
                        spellCheck={false}
                        value={claudeModelValue(editor, tier)}
                        onChange={(event) =>
                          setEditor(
                            withClaudeModel(editor, tier, event.target.value),
                          )
                        }
                        placeholder={
                          followsDefault
                            ? `跟随默认模型（${defaultModelLabel}）`
                            : "未设置"
                        }
                      />
                      <button
                        type="button"
                        aria-label={`从模型列表选择 ${label} 模型`}
                        onClick={() => onFetchModels(tier)}
                        disabled={fetchingModels || savingProvider}
                      >
                        <ListChecks size={14} aria-hidden="true" />
                        选择
                      </button>
                    </div>
                    <OneMCheck
                      label={label}
                      checked={claudeModelOneM(editor, tier)}
                      disabled={!hasModel}
                      onChange={(on) =>
                        setEditor(withClaudeOneM(editor, tier, on))
                      }
                    />
                  </div>
                );
              })}
              <div className="mapping-row is-tiers">
                <span className="mapping-role">子代理</span>
                <span className="mapping-note">子任务使用，不进模型菜单</span>
                <div className="model-input">
                  <input
                    name="provider-claude-subagent-model"
                    aria-label="子代理实际请求模型"
                    autoComplete="off"
                    spellCheck={false}
                    value={claudeModelValue(editor, "subagent")}
                    onChange={(event) =>
                      setEditor(
                        withClaudeModel(editor, "subagent", event.target.value),
                      )
                    }
                    placeholder="未设置"
                  />
                  <button
                    type="button"
                    aria-label="从模型列表选择子代理模型"
                    onClick={() => onFetchModels("subagent")}
                    disabled={fetchingModels || savingProvider}
                  >
                    <ListChecks size={14} aria-hidden="true" />
                    选择
                  </button>
                </div>
                <OneMCheck
                  label="子代理"
                  checked={claudeModelOneM(editor, "subagent")}
                  disabled={!editor.subagentModel.trim()}
                  onChange={(on) =>
                    setEditor(withClaudeOneM(editor, "subagent", on))
                  }
                />
              </div>
              {unsetTiers.length > 0 && (
                <p className="editor-model-notice is-warning" role="status">
                  <TriangleAlert size={15} aria-hidden="true" />
                  <span>
                    {`${unsetTiers.join("、")} 未设置，也没有默认模型：Claude Code 会用原始 Claude 模型名请求，第三方服务可能拒绝。`}
                  </span>
                </p>
              )}
            </div>
          )}
          {isCodex && (
            <>
              <div className="advanced-group model-mapping">
                <div className="advanced-section-heading">
                  <span className="editor-field-label">
                    <b>模型映射</b>
                    <HelpTip title="模型映射说明">
                      每行把 Codex
                      模型菜单里的一项对应到上游的实际模型。显示名留空时显示模型
                      ID；没有映射时只使用默认模型。
                    </HelpTip>
                    <span className="mapping-count" aria-label="映射数量">
                      {editor.catalogModels.length}
                    </span>
                  </span>
                  <span className="mapping-heading-actions">
                    <button
                      type="button"
                      className="secondary compact"
                      onClick={() => onFetchModels()}
                      disabled={fetchingModels}
                    >
                      {fetchingModels ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : modelsFetched ? (
                        <ListChecks size={14} aria-hidden="true" />
                      ) : (
                        <Download size={14} aria-hidden="true" />
                      )}
                      {modelsFetched ? "从列表选择" : "获取模型列表"}
                    </button>
                    <button
                      type="button"
                      className="secondary compact"
                      onClick={addMappingRow}
                    >
                      <Plus size={14} aria-hidden="true" />
                      添加模型
                    </button>
                  </span>
                </div>
                {effortOverridesRows && (
                  <p className="mapping-effort-notice">
                    <span>
                      此线路的全局推理强度为 {globalReasoningEffort}
                      ，会覆盖各行的默认等级。
                    </span>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() =>
                        setEditor({
                          ...editor,
                          config: removeCodexTopLevelKey(
                            editor.config,
                            "model_reasoning_effort",
                          ),
                        })
                      }
                    >
                      改为按模型默认
                    </button>
                  </p>
                )}
                <div className="mapping-head">
                  <span>菜单显示名（可选）</span>
                  <span>实际请求模型</span>
                  <span className="editor-field-label">
                    上下文
                    <HelpTip title="上下文说明">
                      模型一次能处理的最大长度，单位
                      tokens。留空时使用默认窗口。
                    </HelpTip>
                  </span>
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
                        aria-describedby={
                          gptWindowAboveSubscription(item)
                            ? `mapping-window-note-${index}`
                            : undefined
                        }
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
                        title={reasoningSummary(item)}
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
                          {reasoningSummary(item)}
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
                        aria-label={`模型 ${index + 1} 系统提示词${
                          item.baseInstructions?.trim() ? "（已设置）" : ""
                        }`}
                        aria-expanded={openInstructionsRow === index}
                        aria-controls={`instructions-panel-${index}`}
                        onClick={() =>
                          setOpenInstructionsRow(
                            openInstructionsRow === index ? null : index,
                          )
                        }
                      >
                        <FileText size={15} aria-hidden="true" />
                        <span>提示词</span>
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
                    {gptWindowAboveSubscription(item) && (
                      <p
                        className="mapping-window-note"
                        id={`mapping-window-note-${index}`}
                        role="note"
                      >
                        中转站的 GPT 多来自 ChatGPT 订阅，窗口只有
                        272K。窗口填大了不会提前压缩，等上游拒收时这一轮会失败；确认这家支持更大窗口再这样填。
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
                            <EditorSelect
                              label={`模型 ${index + 1} 默认思考等级`}
                              value={item.defaultReasoningLevel ?? ""}
                              onChange={(value) => {
                                const catalogModels = [...editor.catalogModels];
                                const next: CodexCatalogModel = { ...item };
                                if (value) {
                                  next.defaultReasoningLevel = value;
                                } else {
                                  delete next.defaultReasoningLevel;
                                }
                                catalogModels[index] = next;
                                setEditor({ ...editor, catalogModels });
                              }}
                              options={[
                                ["", "自动"],
                                ...item.reasoningLevels!.map(
                                  (level) => [level, level] as const,
                                ),
                              ]}
                            />
                          </div>
                        )}
                      </div>
                    )}
                    {openInstructionsRow === index && (
                      <div
                        className="instructions-panel"
                        id={`instructions-panel-${index}`}
                      >
                        <div className="instructions-panel-head editor-field-label">
                          系统提示词（可选）
                          <HelpTip title="系统提示词说明">
                            替换这个模型的身份说明和系统前言（Base
                            Instructions）。留空时使用默认模板。
                          </HelpTip>
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
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <EditorAdvanced
                ref={advancedRef}
                summary={
                  advancedActive.length
                    ? `已启用：${advancedActive.join("、")}`
                    : "Codex 功能 · 通用配置 · 兼容性"
                }
              >
                <div className="advanced-group codex-feature-options">
                  <div className="advanced-section-heading">
                    <span className="editor-field-label">
                      <b>Codex 功能</b>
                      <HelpTip title="Codex 功能说明">
                        每条线路单独保存这些开关；未开启的功能不会写入配置。
                      </HelpTip>
                    </span>
                  </div>
                  <div className="toggle-list">
                    <EditorToggle
                      name="provider-goal-mode"
                      label="目标模式"
                      help="让 Codex 先列出目标，再逐步完成。"
                      checked={editor.goalModeEnabled}
                      onChange={(goalModeEnabled) =>
                        setEditor({ ...editor, goalModeEnabled })
                      }
                    />
                    {context1mEnabled && (
                      <CodexContextWindowField
                        value={editor.config}
                        onChange={(config) => setEditor({ ...editor, config })}
                        disabled={savingProvider}
                      />
                    )}
                    <EditorToggle
                      name="provider-remote-compaction"
                      label="远程上下文压缩"
                      tag={<em className="experimental-tag">实验性</em>}
                      note={
                        remoteCompactionAvailable
                          ? "只有原生 Responses 上游可用：长对话由上游压缩。"
                          : "经 Chat 或 Anthropic 转换的线路不支持远程压缩。"
                      }
                      checked={
                        editor.remoteCompactionEnabled &&
                        remoteCompactionAvailable
                      }
                      disabled={!remoteCompactionAvailable}
                      onChange={(remoteCompactionEnabled) =>
                        setEditor({ ...editor, remoteCompactionEnabled })
                      }
                    />
                    <EditorToggle
                      name="provider-common-config"
                      label="应用通用配置"
                      help="切换到这条线路时，把共享的 Codex 配置合并进来。"
                      checked={editor.commonConfigEnabled}
                      disabled={commonConfigLoading || !commonConfigLoaded}
                      onChange={(commonConfigEnabled) =>
                        setEditor({ ...editor, commonConfigEnabled })
                      }
                    />
                  </div>
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
                    <div className="common-config-editor">
                      <EditorLabel
                        htmlFor="provider-common-config-input"
                        label="通用 config.toml"
                      />
                      <textarea
                        id="provider-common-config-input"
                        name="provider-common-config-snippet"
                        spellCheck={false}
                        value={commonConfigSnippet}
                        onChange={(event) =>
                          onCommonConfigChange(event.target.value)
                        }
                        placeholder="例如 [features] 下需要在多条线路间共享的配置"
                      />
                      <small>
                        共享内容会影响所有启用通用配置的线路；地址、密钥、模型和模型目录不会共享。
                      </small>
                      {commonConfigWarning && (
                        <small className="error-text">
                          {commonConfigWarning}
                        </small>
                      )}
                    </div>
                  )}
                </div>

                <div className="advanced-group">
                  <div className="advanced-section-heading">
                    <b>兼容性</b>
                  </div>
                  <div className="toggle-list">
                    <EditorToggle
                      name="provider-full-url"
                      label="完整 API 地址"
                      help="地址已经包含完整的请求路径时开启，请求不再补全路径。"
                      note="开启后，这条线路经本地路由发送请求。"
                      checked={editor.isFullUrl}
                      onChange={(isFullUrl) =>
                        setEditor({ ...editor, isFullUrl })
                      }
                    />
                  </div>
                  <EditorField
                    label="模型列表地址（可选）"
                    htmlFor="provider-models-url-input"
                    help="上游的模型列表接口和请求地址不在一起时填写，只用于获取模型。"
                  >
                    <input
                      id="provider-models-url-input"
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
                  </EditorField>
                  <EditorField
                    label="自定义 User-Agent（可选）"
                    htmlFor="provider-user-agent-input"
                    help="部分上游只接受特定客户端标识的请求。"
                    hint="填写后，这条线路经本地路由发送请求。"
                    hintId="provider-user-agent-hint"
                  >
                    <input
                      id="provider-user-agent-input"
                      name="provider-user-agent"
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby="provider-user-agent-hint"
                      value={editor.customUserAgent}
                      onChange={(event) =>
                        patch("customUserAgent", event.target.value)
                      }
                      placeholder="留空使用默认请求标识"
                    />
                  </EditorField>
                  <EditorField
                    label="自动审批模型（可选）"
                    htmlFor="provider-auto-review-model-input"
                    help="Codex「替我审批」固定请求 codex-auto-review；上游不认识这个模型时，在这里填实际要用的模型。"
                    hint="填写后这条线路会经本地路由。"
                    hintId="provider-auto-review-model-hint"
                  >
                    <input
                      id="provider-auto-review-model-input"
                      name="provider-auto-review-model"
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby="provider-auto-review-model-hint"
                      value={editor.codexAutoReviewModel}
                      onChange={(event) =>
                        patch("codexAutoReviewModel", event.target.value)
                      }
                      placeholder="留空则请求 codex-auto-review"
                    />
                  </EditorField>
                </div>
                {lineFormat === "anthropic" && (
                  <div className="advanced-group">
                    <div className="advanced-section-heading">
                      <b>Anthropic Messages</b>
                    </div>
                    <EditorChoice
                      name="provider-anthropic-auth"
                      label="认证方式"
                      help={ANTHROPIC_AUTH_HELP}
                      value={editor.anthropicAuthField}
                      options={ANTHROPIC_AUTH_OPTIONS}
                      onChange={(value) => patch("anthropicAuthField", value)}
                    />
                    <EditorField
                      label="最大输出 tokens（可选）"
                      htmlFor="provider-max-output-tokens-input"
                      help="单次回复最多输出的 tokens，留空时为 8192。"
                    >
                      <input
                        id="provider-max-output-tokens-input"
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
                    </EditorField>
                    <div className="toggle-list">
                      <EditorToggle
                        name="provider-impersonate-claude-code"
                        label="模拟 Claude Code 客户端"
                        help="只在上游明确要求 Claude Code 的请求特征时开启。"
                        checked={editor.impersonateClaudeCode}
                        onChange={(impersonateClaudeCode) =>
                          setEditor({ ...editor, impersonateClaudeCode })
                        }
                      />
                    </div>
                  </div>
                )}
                {lineFormat === "openai_chat" && (
                  <div className="advanced-group">
                    <div className="advanced-section-heading">
                      <b>Chat Completions</b>
                      {editor.apiFormat === "auto" && (
                        <small>只对按 Chat 转换的模型生效。</small>
                      )}
                    </div>
                    <EditorChoice
                      name="provider-prompt-cache-routing"
                      label="提示词缓存路由"
                      help="严格的网关遇到不认识的缓存字段会拒绝请求，这时选择关闭。"
                      value={editor.promptCacheRouting}
                      options={PROMPT_CACHE_OPTIONS}
                      onChange={(value) => patch("promptCacheRouting", value)}
                    />
                    <div className="toggle-list">
                      <EditorToggle
                        name="provider-supports-thinking"
                        label="支持思考模式"
                        help="把 Codex 的思考开关转换为上游 Chat 接口的参数。"
                        checked={
                          editor.codexChatReasoning.supportsThinking === true
                        }
                        onChange={(supportsThinking) =>
                          setEditor({
                            ...editor,
                            codexChatReasoning: {
                              ...editor.codexChatReasoning,
                              supportsThinking,
                              supportsEffort: supportsThinking
                                ? editor.codexChatReasoning.supportsEffort
                                : false,
                            },
                          })
                        }
                      />
                      <EditorToggle
                        name="provider-supports-effort"
                        label="支持思考等级"
                        help="上游支持 low、high、max 等推理强度时开启。"
                        checked={
                          editor.codexChatReasoning.supportsEffort === true
                        }
                        onChange={(supportsEffort) =>
                          setEditor({
                            ...editor,
                            codexChatReasoning: {
                              ...editor.codexChatReasoning,
                              supportsThinking: supportsEffort
                                ? true
                                : editor.codexChatReasoning.supportsThinking,
                              supportsEffort,
                              effortParam: supportsEffort
                                ? (editor.codexChatReasoning.effortParam ??
                                  "reasoning_effort")
                                : "none",
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                )}
              </EditorAdvanced>
            </>
          )}
          {isClaude && (
            <EditorAdvanced
              summary={`认证方式：${
                ANTHROPIC_AUTH_OPTIONS.find(
                  ([value]) => value === editor.anthropicAuthField,
                )?.[1] ?? "Authorization: Bearer"
              }`}
            >
              <EditorChoice
                name="provider-claude-auth"
                label="认证方式"
                help={ANTHROPIC_AUTH_HELP}
                value={editor.anthropicAuthField}
                options={ANTHROPIC_AUTH_OPTIONS}
                onChange={(value) => patch("anthropicAuthField", value)}
              />
            </EditorAdvanced>
          )}
          {connection.kind === "error" && (
            <p className="editor-feedback" role="alert">
              {connection.message}
            </p>
          )}
        </fieldset>
        <EditorSaveSummary
          rows={[
            ["线路", editor.name.trim() || "未命名线路"],
            ["地址", previewOrigin],
            ["模型", defaultModelLabel || "由客户端选择"],
            ["协议", protocolSummary],
            ...(routing
              ? [["连接", describeCodexRouting(routing)] as const]
              : []),
          ]}
        >
          <p>
            {additive
              ? `保存并启用，不影响其他 ${toolName} 线路，也不切换 ${toolName} 的默认模型。只改这条线路的首个模型，它已有的其他模型与高级设置会保留。`
              : existing && !inUse
                ? `保存只更新这条线路，${toolName} 当前使用的线路不变。需要立刻使用它时点「保存并切换」。`
                : isCodex
                  ? "保存后设为当前 Codex 线路。运行中的 Codex 可能需要重启。"
                  : `保存后设为当前 ${toolName} 线路。模型留空时由 ${toolName} 选择，未填写密钥时沿用它自己的登录方式。`}
          </p>
        </EditorSaveSummary>
      </div>
      <div className="editor-bottom">
        <footer>
          <EditorTestAction
            connection={connection}
            onTest={onTest}
            disabled={savingProvider}
          />
          <EditorSaveActions
            onCancel={onRequestClose}
            disabled={savingProvider}
          >
            {secondarySave && (
              <button
                type="button"
                className="secondary"
                onClick={() => submit(secondarySave.activate)}
                disabled={savingProvider || fetchingModels}
              >
                {secondarySave.label}
              </button>
            )}
            <button
              className="primary"
              onClick={() => submit(primarySave.activate)}
              disabled={savingProvider || fetchingModels}
            >
              <SaveLabel busy={savingProvider} label={primarySave.label} />
            </button>
          </EditorSaveActions>
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

function ConfirmOperation({
  action,
  installed,
  currentVersion,
  targetVersion,
  installMode,
  sizeBytes,
  onCancel,
  onConfirm,
}: {
  action: string;
  installed?: boolean;
  currentVersion?: string | null;
  targetVersion?: string | null;
  installMode?: string | null;
  sizeBytes?: number;
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
  // Name the exact consequence: which version replaces which, how it will be
  // installed, and how much will be downloaded.
  const facts: string[] = [];
  if (currentVersion) facts.push(`当前版本 ${currentVersion}`);
  if (targetVersion) {
    facts.push(
      action === "rollback"
        ? `回滚到 ${targetVersion}`
        : `更新到 ${targetVersion}`,
    );
  }
  if (installMode) facts.push(runtimeText(installMode));
  if (sizeBytes && sizeBytes > 0)
    facts.push(`需下载 ${formatMegabytes(sizeBytes)}`);
  const consequence =
    installed === false
      ? "该操作会安装 Codex 程序文件。供应商配置与 ~/.codex 用户数据不会被修改。"
      : `${CODEX_CLOSE_SCOPE}${
          action === "uninstall"
            ? "Codex 安装文件会被删除，"
            : "Codex 安装文件会被替换，"
        }供应商配置与 ~/.codex 用户数据不会被删除。`;
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
        {facts.length > 0 && (
          <p className="confirm-facts">
            {facts.map((fact, index) => (
              <Fragment key={fact}>
                {index > 0 && " · "}
                {/* A fact never breaks inside: "788.0 MB" stays whole. */}
                <span className="runtime-confirm-fact">{fact}</span>
              </Fragment>
            ))}
          </p>
        )}
        <p>{consequence}</p>
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
  detail,
  onCancel,
  onConfirm,
}: {
  label: string;
  detail?: string;
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
        {detail && <p className="confirm-facts">{detail}</p>}
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
  runtime,
  onClose,
  onRepair,
  onInstall,
}: {
  diagnostics: Diagnostic[];
  runtime?: RuntimeStatus | null;
  onClose: () => void;
  onRepair?: () => void;
  onInstall?: () => void;
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
    // The backend explains a failure in one sentence (reason + next step);
    // only fall back to the generic advice when it sent none.
    const detail = item.detail?.trim();
    if (item.result === "warn") {
      return {
        status: "需要留意",
        detail: detail || "该项目不影响当前基本使用。",
      };
    }
    return {
      status: "检查失败",
      detail: detail || "建议先修复安装后再次诊断。",
    };
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
          {/* A failed check is actionable: offer the repair or install the
              backend says is available, instead of only closing the dialog. */}
          {onInstall && runtime?.installed === false && (
            <button onClick={onInstall}>安装 Codex</button>
          )}
          {onRepair && <button onClick={onRepair}>修复安装</button>}
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
    <main className="chimera-shell onboarding-screen">
      <div className="onboarding-titlebar" {...DRAG_REGION_ATTR}>
        <WindowControls />
      </div>
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
        <small>数据仅保存在本机</small>
      </section>
    </main>
  );
}
