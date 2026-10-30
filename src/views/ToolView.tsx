import { PiPluginMarket } from "./PiPluginMarket";
import { PiManagement } from "./PiManagement";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { providerPresets } from "@/config/claudeProviderPresets";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { LineBadge } from "@/components/LineBadge";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/help-tip";
import "./ToolView.css";
import type { Provider } from "@/types";
import type { AppId } from "@/lib/api/types";
import { providersApi } from "@/lib/api/providers";
import { vscodeApi } from "@/lib/api/vscode";
import type { ToolName } from "@/components/settings/AboutSection";
import {
  toolProviderSummary,
  isNativeToolAppId,
} from "@/utils/toolProviderConfig";

export interface ToolViewProps {
  toolId: string;
  refreshVersion?: number;
  onEditLine?: (lineId: string, appId: AppId) => void;
  native?: boolean;
  onManageResources?: (appId: AppId) => void;
}

const AboutSection = lazy(() =>
  import("@/components/settings/AboutSection").then((module) => ({
    default: module.AboutSection,
  })),
);
const lifecycleTools: Record<string, readonly ToolName[]> = {
  "claude-code": ["claude"],
  "gemini-cli": ["gemini"],
  opencode: ["opencode"],
  grokbuild: ["grok"],

  pi: ["pi"],
};

// Discovery only reads live settings; importing requires confirmation.
// Pi read native configuration in getAll; Desktop uses its status API.
const liveConfigImporters: Partial<
  Record<AppId, () => Promise<boolean | number>>
> = {
  claude: () => providersApi.importDefault("claude"),
  gemini: () => providersApi.importDefault("gemini"),
  grokbuild: () => providersApi.importDefault("grokbuild"),
  opencode: () => providersApi.importOpenCodeFromLive(),
};

type ToolMeta = {
  appId: Exclude<AppId, "codex">;
  name: string;
  shortName: string;
  category: "switch" | "accumulate";
  categoryLabel: string;
  description: string;
  color: string;
};

const ToolProviderEditor = lazy(() => import("./ToolViewEditor"));
const DesktopStatusPanel = lazy(() => import("./ToolViewDesktop"));

// A product name inside running text never breaks across lines ("Claude /
// Code"); the line can still break at the spaces around it.
const keepTogether = (name: string) => name.replace(/ /g, "\u00a0");

const TOOL_META: Record<string, ToolMeta> = {
  grokbuild: {
    appId: "grokbuild",
    name: "Grok Build",
    shortName: "Gk",
    category: "switch",
    categoryLabel: "单线路",
    description: "同一时间使用一条线路；配置不代表已安装或登录。",
    color: "#2563EB",
  },

  "claude-desktop": {
    appId: "claude-desktop",
    name: "Claude Desktop",
    shortName: "CD",
    category: "switch",
    categoryLabel: "桌面客户端",
    description: "连接官方客户端，安装、线路与登录分开管理。",
    color: "#C46D50",
  },

  "claude-code": {
    appId: "claude",
    name: "Claude Code",
    shortName: "CC",
    category: "switch",
    categoryLabel: "单线路",
    description: `同一时间使用一条线路；切换后重新打开 ${keepTogether("Claude Code")} 生效。`,
    color: "#D97706",
  },
  "gemini-cli": {
    appId: "gemini",
    name: "Gemini CLI",
    shortName: "Gm",
    category: "switch",
    categoryLabel: "单线路",
    description: `同一时间使用一条线路；切换后重新打开 ${keepTogether("Gemini CLI")} 生效。`,
    color: "#2563EB",
  },
  opencode: {
    appId: "opencode",
    name: "OpenCode",
    shortName: "OC",
    category: "accumulate",
    categoryLabel: "多线路",
    description: "可以同时启用多条线路，停用后仍保留已保存的配置。",
    color: "#10B981",
  },
  pi: {
    appId: "pi",
    name: "Pi",
    shortName: "Pi",
    category: "accumulate",
    categoryLabel: "多线路",
    description: "可以同时启用多条线路，默认模型仍在 Pi 中选择。",
    color: "#8B5CF6",
  },
};

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// Presets may store non-colour values such as "currentColor" as the icon
// colour; the badge only takes real identity colours.
const lineIdentity = (provider: Provider) => ({
  ...provider,
  iconColor:
    provider.iconColor && HEX_COLOR.test(provider.iconColor)
      ? provider.iconColor
      : undefined,
});

export function ToolView(props: ToolViewProps) {
  if (!Object.hasOwn(TOOL_META, props.toolId))
    return <p role="alert">不支持的工具：{props.toolId}</p>;
  return <KnownToolView {...props} />;
}

function KnownToolView({
  toolId,
  refreshVersion = 0,
  onEditLine,
  native = false,
  onManageResources,
}: ToolViewProps) {
  const tool = TOOL_META[toolId];
  const [statusRefresh, setStatusRefresh] = useState(0);
  const [desktopSupported, setDesktopSupported] = useState(false);
  const canMutate = tool.appId !== "claude-desktop" || desktopSupported;
  const [piSection, setPiSection] = useState("routes");
  const [removing, setRemoving] = useState<Provider | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const editLine = (id: string) => {
    if (isNativeToolAppId(tool.appId)) onEditLine?.(id, tool.appId);
    else
      setEditing(
        id === "new" ? "new" : (providers.find((p) => p.id === id) ?? null),
      );
  };
  const [providers, setProviders] = useState<Provider[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);
  const importRequest = useRef<symbol | null>(null);
  const mutationRequest = useRef<symbol | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);
  const [discovery, setDiscovery] = useState<
    "scanning" | "found" | "empty" | "unavailable"
  >("scanning");
  const scanGeneration = useRef(0);
  const scan = useCallback(async () => {
    if (!native || !liveConfigImporters[tool.appId]) return;
    const request = ++scanGeneration.current;
    setDiscovery("scanning");
    try {
      const config = await vscodeApi.getLiveProviderSettings(tool.appId);
      if (request !== scanGeneration.current) return;
      const fields = config as Record<string, unknown> | null;
      const content =
        tool.appId === "gemini" && config
          ? [fields?.env, fields?.config].some(
              (value) =>
                value &&
                typeof value === "object" &&
                Object.keys(value).length > 0,
            )
          : config &&
            typeof config === "object" &&
            Object.keys(config).length > 0;
      setDiscovery(content ? "found" : "empty");
    } catch {
      // Missing files and invalid files share an error channel. Do not claim
      // absence or expose parser errors that might contain credentials.
      if (request === scanGeneration.current) setDiscovery("unavailable");
    }
  }, [native, tool.appId]);

  useEffect(() => {
    setConfirmImport(false);
    void scan();
    return () => {
      scanGeneration.current++;
    };
  }, [scan, refreshVersion]);

  useEffect(() => {
    setEditing(null);
    setRemoving(null);
    setDeleting(false);
    setDesktopSupported(false);
    // Load the editor chunk early so the first edit opens without a loading line.
    if (!isNativeToolAppId(tool.appId)) void import("./ToolViewEditor");
  }, [tool.appId]);

  const loadGeneration = useRef(0);
  const activeApp = useRef<AppId | null>(tool.appId);

  const load = useCallback(async () => {
    if (activeApp.current !== tool.appId) return;
    const generation = ++loadGeneration.current;
    try {
      setError(null);
      const [all, current] = await Promise.all([
        providersApi.getAll(tool.appId),
        providersApi.getCurrent(tool.appId),
      ]);
      if (generation !== loadGeneration.current) return;
      setProviders(
        Object.values(all).sort(
          (a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0),
        ),
      );
      setCurrentId(current || "");
      setStatusRefresh((value) => value + 1);
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      setProviders([]);
      setCurrentId("");
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        message.includes("undefined") && message.includes("invoke")
          ? "尚未连接本机服务，请在桌面应用中重试"
          : message,
      );
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [tool.appId]);

  useEffect(() => {
    activeApp.current = tool.appId;
    setLoading(true);
    setProviders([]);
    setCurrentId("");
    setBusyId(null);
    setImporting(false);
    void load();
    return () => {
      importRequest.current = null;
      mutationRequest.current = null;
      activeApp.current = null;
      loadGeneration.current++;
    };
  }, [load]);

  const lastRefreshVersion = useRef(refreshVersion);
  useEffect(() => {
    if (lastRefreshVersion.current === refreshVersion) return;
    lastRefreshVersion.current = refreshVersion;
    void load();
  }, [load, refreshVersion]);

  useEffect(() => {
    const handleMutation = (event: Event) => {
      const appId = (event as CustomEvent<{ appId?: string }>).detail?.appId;
      if (appId === tool.appId) void load();
    };
    window.addEventListener("chimera-provider-mutated", handleMutation);
    return () =>
      window.removeEventListener("chimera-provider-mutated", handleMutation);
  }, [load, tool.appId]);

  useEffect(() => {
    if (!native) return;
    let active = true;
    let dispose: (() => void) | undefined;
    const subscribe = async () => {
      try {
        const unlisten = await providersApi.onSwitched((event) => {
          if (active && event.appType === tool.appId) void load();
        });
        if (!active) {
          unlisten();
          return;
        }
        dispose = unlisten;
        // Close the gap between the initial read and the async subscription.
        void load();
      } catch {
        if (active) toast.error("无法订阅线路切换，请手动刷新或重新加载应用");
      }
    };
    void subscribe();
    return () => {
      active = false;
      dispose?.();
    };
  }, [load, native, tool.appId]);

  const activeCount = useMemo(
    () =>
      providers.filter((provider) => provider.meta?.liveConfigManaged !== false)
        .length,
    [providers],
  );

  const refresh = () => {
    setRefreshing(true);
    void load();
    void scan();
  };

  const officialPreset =
    tool.appId === "claude"
      ? providerPresets.find((preset) => preset.isOfficial)
      : tool.appId === "gemini"
        ? geminiProviderPresets.find((preset) => preset.category === "official")
        : undefined;
  // Built-in entry is visible even in older databases. Only an explicit switch
  // persists it; rendering this page never writes credentials or live config.
  let officialId = tool.appId + "-official";
  for (let suffix = 1; providers.some((p) => p.id === officialId); suffix++) {
    officialId = tool.appId + "-official-" + suffix;
  }
  const officialProvider: Provider | undefined =
    providers.find((provider) => provider.category === "official") ??
    (officialPreset
      ? {
          id: officialId,
          name: officialPreset.name,
          category: "official",
          settingsConfig: officialPreset.settingsConfig,
          websiteUrl: officialPreset.websiteUrl,
        }
      : undefined);
  const hasBuiltInEntry =
    Boolean(officialProvider) &&
    !providers.some((p) => p.id === officialProvider?.id);
  const visibleProviders =
    officialProvider && hasBuiltInEntry
      ? [officialProvider, ...providers]
      : providers;
  const currentProvider = providers.find((p) => p.id === currentId);
  // A single-line tool imports its live config only while it has no saved
  // custom line (the backend skips it otherwise), so the offer would be a no-op.
  const importApplies =
    tool.category === "accumulate" ||
    !providers.some((provider) => provider.category !== "official");

  const importLocalConfig = async () => {
    const importConfig = liveConfigImporters[tool.appId];
    if (!native || !importConfig || loading || busyId || importRequest.current)
      return;
    setConfirmImport(false);
    const request = Symbol();
    importRequest.current = request;
    setImporting(true);
    try {
      const result = await importConfig();
      if (importRequest.current !== request) return;
      if (result === false) {
        toast.warning("未导入本机配置", {
          description:
            "已有自定义线路，首次导入不会覆盖已保存的配置。请在现有线路中编辑。",
        });
      } else if (result === 0) {
        toast.warning("没有需要导入的配置", {
          description: "本机未发现线路，或配置与已保存的线路一致。",
        });
      } else {
        toast.success("已导入本机配置", {
          description: "已登记到 Chimera，工具的配置文件保持不变。",
        });
      }
      await load();
    } catch {
      if (importRequest.current !== request) return;
      toast.error("导入本机配置失败", {
        description: "请检查本机配置格式和文件权限后重试。",
      });
    } finally {
      if (importRequest.current === request) {
        importRequest.current = null;
        setImporting(false);
      }
    }
  };

  const changeProvider = async (provider: Provider) => {
    if (busyId || importing || mutationRequest.current || !canMutate) return;
    const request = Symbol();
    mutationRequest.current = request;
    setBusyId(provider.id);
    try {
      if (providers.some((item) => item.id === provider.id)) {
        const result = await providersApi.switch(provider.id, tool.appId);
        if (mutationRequest.current !== request) return;
        result.warnings?.forEach((warning) => toast.warning(warning));
      } else {
        await providersApi.addAndActivate(provider, tool.appId);
      }
      if (mutationRequest.current !== request) return;
      toast.success("已切换至「" + provider.name + "」", {
        description: "已打开的 " + tool.name + " 需重新启动后使用新线路。",
      });
      await load();
    } catch {
      if (mutationRequest.current !== request) return;
      toast.error(`${tool.name} 配置未更新`, {
        description: "请检查本机配置和文件权限后重试。",
      });
    } finally {
      if (mutationRequest.current === request) {
        mutationRequest.current = null;
        setBusyId(null);
      }
    }
  };

  const toggleProvider = async (provider: Provider) => {
    if (busyId || importing || mutationRequest.current || !canMutate) return;
    const request = Symbol();
    mutationRequest.current = request;
    setBusyId(provider.id);
    try {
      const enabled = provider.meta?.liveConfigManaged !== false;
      if (enabled) {
        await providersApi.removeFromLiveConfig(provider.id, tool.appId);
        if (mutationRequest.current !== request) return;
        toast.success(`已停用「${provider.name}」`);
      } else {
        await providersApi.switch(provider.id, tool.appId);
        if (mutationRequest.current !== request) return;
        toast.success(`已启用「${provider.name}」`);
      }
      await load();
    } catch {
      if (mutationRequest.current !== request) return;
      toast.error(`${tool.name} 配置未更新`, {
        description: "请检查本机配置和文件权限后重试。",
      });
    } finally {
      if (mutationRequest.current === request) {
        mutationRequest.current = null;
        setBusyId(null);
      }
    }
  };

  // The current line of a switch tool cannot be deleted: the list row and
  // the line editor's header give the same reason.
  const deleteBlockedReason = (provider: Provider) =>
    tool.category === "switch" && provider.id === currentId
      ? "当前线路正在使用，请先切换到其他线路再删除。"
      : null;

  const deleteProvider = async () => {
    if (
      !removing ||
      !native ||
      !canMutate ||
      busyId ||
      importing ||
      mutationRequest.current
    )
      return;
    if (deleteBlockedReason(removing)) return;
    const provider = removing;
    const request = Symbol();
    mutationRequest.current = request;
    setBusyId(provider.id);
    setDeleting(true);
    try {
      const deleted = await providersApi.delete(provider.id, tool.appId);
      if (mutationRequest.current !== request) return;
      if (!deleted) throw new Error("线路未删除，请刷新后重试");
      setRemoving(null);
      // Deleted from its own editor: the editor has nothing left to edit.
      setEditing((open) =>
        open !== "new" && open?.id === provider.id ? null : open,
      );
      toast.success(`已删除「${provider.name}」`);
      window.dispatchEvent(
        new CustomEvent("chimera-provider-mutated", {
          detail: { appId: tool.appId },
        }),
      );
      await load();
    } catch {
      if (mutationRequest.current !== request) return;
      toast.error("删除线路失败", {
        description: "线路可能正在使用，或配置已发生变化。请刷新列表后重试。",
      });
    } finally {
      if (mutationRequest.current === request) {
        mutationRequest.current = null;
        setBusyId(null);
        setDeleting(false);
      }
    }
  };

  const busy = Boolean(busyId) || importing;
  const loginCommand =
    tool.appId === "claude" ? (
      <>
        运行 <code>claude</code>，输入 <code>/login</code> 完成授权。
      </>
    ) : (
      <>
        运行 <code>gemini</code>，选择 <code>Login with Google</code> 完成授权。
      </>
    );

  return (
    <div
      className="tool-view text-[var(--text-1)] box-border w-full h-full flex flex-col gap-[12px] p-[12px_24px] bg-[var(--bg-surface)] overflow-y-auto"
      data-kind={tool.category}
    >
      {editing && !isNativeToolAppId(tool.appId) && (
        <Suspense fallback={<p role="status">正在打开编辑器…</p>}>
          <ToolProviderEditor
            appId={tool.appId}
            provider={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => void load()}
            onDelete={
              editing !== "new" && native && canMutate
                ? () => setRemoving(editing)
                : undefined
            }
            deleteBlockedReason={
              editing === "new" ? null : deleteBlockedReason(editing)
            }
          />
        </Suspense>
      )}
      <header className="tool-header">
        <div
          className="tool-mark"
          style={{ "--tool-color": tool.color } as CSSProperties}
          aria-hidden="true"
        >
          {tool.shortName}
        </div>
        <div className="tool-title">
          <div className="tool-title-row">
            <h1>{tool.name}</h1>
            <span className="tool-kind">{tool.categoryLabel}</span>
          </div>
          <p>{tool.description}</p>
        </div>
        <div
          className="tool-actions"
          hidden={tool.appId === "pi" && piSection !== "routes"}
          role="group"
          aria-label={`${tool.name} 工具操作`}
        >
          {["claude", "gemini", "opencode", "grokbuild"].includes(
            tool.appId,
          ) ? (
            <button
              type="button"
              className="tool-btn"
              aria-label={`管理 ${tool.name} 的 Skills 与 MCP`}
              disabled={!onManageResources}
              onClick={() => onManageResources?.(tool.appId)}
            >
              Skills 与 MCP
            </button>
          ) : null}
          <button
            type="button"
            className="tool-btn"
            onClick={refresh}
            disabled={refreshing || loading || importing}
          >
            <RefreshCw
              size={14}
              aria-hidden="true"
              className={refreshing ? "animate-spin" : ""}
            />
            刷新线路
          </button>
          <button
            type="button"
            className="tool-btn is-primary"
            disabled={!canMutate || importing}
            onClick={() => editLine("new")}
          >
            <Plus size={15} aria-hidden="true" />
            添加线路
          </button>
        </div>
      </header>

      {tool.appId === "pi" && (
        <nav className="tool-section-nav" aria-label="Pi 管理分区">
          {[
            ["routes", "模型线路"],
            ["settings", "默认模型与 MCP"],
            ["plugins", "插件市场"],
            ["install", "安装与更新"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={piSection === id ? "page" : undefined}
              onClick={() => setPiSection(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      <div
        className="tool-section-content"
        hidden={tool.appId === "pi" && piSection !== "routes"}
      >
        {tool.appId === "claude-desktop" ? (
          <Suspense
            fallback={<p role="status">正在读取 Claude Desktop 状态…</p>}
          >
            <DesktopStatusPanel
              native={native}
              refreshVersion={refreshVersion + statusRefresh}
              onChanged={load}
              onSupported={setDesktopSupported}
            />
          </Suspense>
        ) : null}

        {canImport(tool.appId) && importApplies && !loading && !error && (
          <section className="tool-discovery" aria-label="本机配置导入">
            <div className="tool-discovery-text">
              <div className="tool-discovery-heading">
                <strong>本机配置</strong>
                <span
                  className="tool-discovery-badge"
                  data-found={native && discovery === "found"}
                  role="status"
                >
                  {!native
                    ? "桌面端可检测"
                    : discovery === "scanning"
                      ? "正在扫描…"
                      : discovery === "found"
                        ? "已发现配置"
                        : discovery === "empty"
                          ? "未发现配置内容"
                          : "未找到或无法读取"}
                </span>
              </div>
              {confirmImport ? (
                <p id="tool-import-warning">
                  {tool.category === "accumulate"
                    ? "确认保存到 Chimera？同名线路会按本机配置更新，工具配置文件保持不变。"
                    : "确认保存到 Chimera？已有自定义线路时会跳过，工具配置文件保持不变。"}
                </p>
              ) : (
                <p>只读检测，不会覆盖或切换现有配置。</p>
              )}
            </div>
            <div className="tool-discovery-actions">
              {confirmImport && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="tool-discovery-button"
                  onClick={() => setConfirmImport(false)}
                >
                  取消
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="tool-discovery-button"
                disabled={!native || importing || Boolean(busyId)}
                aria-describedby={
                  confirmImport ? "tool-import-warning" : undefined
                }
                onClick={() =>
                  confirmImport
                    ? void importLocalConfig()
                    : setConfirmImport(true)
                }
              >
                {importing
                  ? "正在导入…"
                  : confirmImport
                    ? "确认保存导入"
                    : "导入本机配置"}
              </Button>
            </div>
          </section>
        )}

        {officialPreset &&
          officialProvider &&
          !loading &&
          !error &&
          (!currentId || currentId === officialProvider.id) && (
            <section className="tool-official-guide" aria-label="官方账号登录">
              <div>
                <strong>
                  {tool.appId === "claude"
                    ? "使用 Claude 官方账号"
                    : "使用 Google 官方账号"}
                </strong>
                <p>官方线路无需 API 密钥。切换到官方线路后，{loginCommand}</p>
                <p className="tool-official-note">
                  登录状态由 {tool.name} 管理，此处不代表已登录。
                </p>
              </div>
              {currentId === officialProvider.id && (
                <Button
                  variant="outline"
                  size="sm"
                  className="tool-discovery-button"
                  disabled={busy}
                  onClick={async () => {
                    setBusyId(officialProvider.id);
                    try {
                      await providersApi.openTerminal(
                        officialProvider.id,
                        tool.appId,
                      );
                    } catch (cause) {
                      toast.error("无法打开终端", {
                        description: String(cause),
                      });
                    } finally {
                      if (activeApp.current === tool.appId) setBusyId(null);
                    }
                  }}
                >
                  打开登录终端
                </Button>
              )}
            </section>
          )}

        {error && !loading && (
          <div className="tool-load-error" role="alert">
            <div className="tool-load-error-head">
              <strong>读取 {tool.name} 配置失败</strong>
              <button
                type="button"
                className="tool-btn"
                onClick={refresh}
                disabled={refreshing}
              >
                <RefreshCw
                  size={14}
                  aria-hidden="true"
                  className={refreshing ? "animate-spin" : ""}
                />
                重试
              </button>
            </div>
            <p>
              请按下方提示修正配置文件或稍后重试；读取失败不会修改任何配置。
            </p>
            <pre>{error}</pre>
          </div>
        )}
        {loading && (
          <div className="tool-loading" role="status">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            正在读取本机配置…
          </div>
        )}
        {!loading && !error && visibleProviders.length === 0 && (
          <div className="tool-empty">
            <p>
              还没有 {keepTogether(tool.name)}{" "}
              线路。添加服务商的地址和密钥后即可在这里切换。
            </p>
            <button
              type="button"
              className="tool-btn is-primary"
              disabled={!canMutate || importing}
              onClick={() => editLine("new")}
            >
              <Plus size={15} aria-hidden="true" />
              添加第一条线路
            </button>
          </div>
        )}

        {!loading && !error && visibleProviders.length > 0 && (
          <>
            <div className="tool-lines-caption">
              {tool.category === "switch" ? (
                <span
                  className="tool-lines-current"
                  data-active={Boolean(currentProvider) || undefined}
                >
                  {currentProvider
                    ? `当前线路：${currentProvider.name}`
                    : "尚未切换到已保存的线路"}
                </span>
              ) : (
                <span
                  className="tool-lines-current"
                  data-active={activeCount > 0 || undefined}
                >
                  已启用 {activeCount} 条
                </span>
              )}
              <span>{providers.length} 条线路</span>
              {hasBuiltInEntry && <span>另有 1 个内置官方入口</span>}
              <span className="tool-lines-source">
                {tool.appId === "pi" ? "来自 Pi 配置文件" : "保存在 Chimera++"}
              </span>
            </div>
            <div
              className="tool-lines"
              role="table"
              aria-label={`${tool.name} 线路`}
            >
              <div className="tool-line-row tool-line-head" role="row">
                <span role="columnheader">状态</span>
                <span role="columnheader">线路</span>
                <span role="columnheader">请求地址</span>
                <span role="columnheader">
                  {tool.appId === "claude" || tool.appId === "gemini"
                    ? "默认模型"
                    : "模型"}
                </span>
                <span role="columnheader" className="tool-line-actions">
                  操作
                </span>
              </div>
              {visibleProviders.map((provider) => {
                const enabled = provider.meta?.liveConfigManaged !== false;
                const current = provider.id === currentId;
                const rowBusy = busyId === provider.id;
                const builtIn =
                  hasBuiltInEntry && provider.id === officialProvider?.id;
                const summary = toolProviderSummary(tool.appId, provider);
                const endpoint = builtIn
                  ? "内置官方入口（未启用）"
                  : summary.baseUrl ||
                    (provider.category === "official" ? "官方默认端点" : "—");
                const model = summary.model || "—";
                const protectedCurrent = Boolean(deleteBlockedReason(provider));
                const deleteButton = (
                  <button
                    type="button"
                    className="tool-provider-delete"
                    aria-label={`删除${provider.name}`}
                    title={protectedCurrent ? undefined : "删除线路"}
                    disabled={!native || !canMutate || busy}
                    onClick={() => setRemoving(provider)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                );
                return (
                  <div
                    key={provider.id}
                    className="tool-line-row"
                    role="row"
                    data-current={
                      (tool.category === "switch" ? current : enabled) ||
                      undefined
                    }
                  >
                    <span role="cell" className="tool-line-status">
                      {tool.category === "accumulate" ? (
                        <button
                          type="button"
                          className="tool-line-toggle"
                          aria-label={`${enabled ? "停用" : "启用"}${provider.name}`}
                          aria-pressed={enabled}
                          onClick={() => void toggleProvider(provider)}
                          disabled={busy}
                        >
                          <span aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="tool-line-dot" aria-hidden="true" />
                      )}
                    </span>
                    <span role="cell" className="tool-line-name">
                      <LineBadge line={lineIdentity(provider)} />
                      <span title={provider.name}>{provider.name}</span>
                    </span>
                    <span
                      role="cell"
                      className={
                        !builtIn && summary.baseUrl
                          ? "tool-line-mono"
                          : "tool-line-muted"
                      }
                      title={endpoint}
                    >
                      {endpoint}
                    </span>
                    <span
                      role="cell"
                      className={
                        summary.model ? "tool-line-mono" : "tool-line-muted"
                      }
                      title={model}
                    >
                      {model}
                    </span>
                    <span role="cell" className="tool-line-actions">
                      {tool.category === "switch" &&
                        (current ? (
                          <button
                            type="button"
                            className="tool-line-current"
                            disabled
                          >
                            当前线路
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="tool-line-switch"
                            onClick={() => void changeProvider(provider)}
                            disabled={!canMutate || busy}
                            aria-busy={rowBusy || undefined}
                          >
                            {rowBusy ? (
                              <Loader2
                                size={14}
                                className="animate-spin"
                                aria-label="处理中"
                              />
                            ) : (
                              "切换"
                            )}
                          </button>
                        ))}
                      {tool.category === "accumulate" && rowBusy && (
                        <Loader2
                          size={14}
                          className="animate-spin tool-line-spinner"
                          aria-label="处理中"
                        />
                      )}
                      {providers.some((item) => item.id === provider.id) && (
                        <button
                          type="button"
                          className="tool-line-icon"
                          aria-label={`编辑${provider.name}`}
                          title="编辑线路"
                          disabled={!canMutate || busy}
                          onClick={() => editLine(provider.id)}
                        >
                          <Pencil size={15} aria-hidden="true" />
                        </button>
                      )}
                      {!builtIn &&
                        (protectedCurrent && native ? (
                          <DisabledReason
                            reason={deleteBlockedReason(provider) ?? undefined}
                          >
                            {deleteButton}
                          </DisabledReason>
                        ) : (
                          deleteButton
                        ))}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      <div hidden={tool.appId === "pi" && piSection !== "install"}>
        {tool.appId === "pi" ? (
          <section className="tool-install-panel" aria-labelledby="pi-install">
            <h2 id="pi-install">安装与环境检查</h2>
            <InstallChecks toolId={toolId} name={tool.name} native={native} />
            <p className="tool-install-note">
              Pi 支持原生 MCP 和扩展包，可在「默认模型与 MCP」管理全局配置；统一
              Skills 同步暂未接入。
            </p>
          </section>
        ) : tool.appId !== "claude-desktop" ? (
          <details
            key={toolId}
            className="tool-installation chimera-disclosure"
          >
            <summary>
              安装与环境检查
              <span className="tool-installation-hint">版本与更新</span>
            </summary>
            <div className="chimera-disclosure-body">
              <InstallChecks toolId={toolId} name={tool.name} native={native} />
            </div>
          </details>
        ) : null}
      </div>
      <ConfirmDialog
        isOpen={removing !== null}
        busy={deleting}
        title={`删除「${removing?.name ?? ""}」？`}
        message={
          tool.category === "accumulate"
            ? `将删除这条 ${tool.name} 线路及对应的本机供应商配置。如只想暂时停用，请取消并使用停用开关。此操作不可撤销。`
            : `将从 Chimera++ 删除这条 ${tool.name} 线路，不删除客户端或会话数据。当前使用中的线路不能删除。此操作不可撤销。`
        }
        confirmText="确认删除"
        cancelText="取消"
        variant="destructive"
        onCancel={() => {
          if (!deleting) setRemoving(null);
        }}
        onConfirm={() => void deleteProvider()}
      />
      {tool.appId === "pi" && (
        <>
          <div hidden={piSection !== "plugins"}>
            <PiPluginMarket native={native} />
          </div>
          <div hidden={piSection !== "settings"}>
            <PiManagement native={native} />
          </div>
        </>
      )}
    </div>
  );
}

function canImport(appId: AppId) {
  return Boolean(liveConfigImporters[appId]);
}

function InstallChecks({
  toolId,
  name,
  native,
}: {
  toolId: string;
  name: string;
  native: boolean;
}) {
  if (native && lifecycleTools[toolId])
    return (
      <Suspense fallback={<p role="status">正在加载安装检测…</p>}>
        <AboutSection
          key={toolId}
          isPortable={false}
          toolsOnly
          tools={lifecycleTools[toolId]}
        />
      </Suspense>
    );
  return (
    <p className="tool-install-note">
      {!native
        ? "浏览器预览未检测安装状态，请在桌面应用中检测、安装或升级。"
        : `${name} 的安装检测与托管升级尚未接入，线路配置不代表已安装。`}
    </p>
  );
}

export default ToolView;
