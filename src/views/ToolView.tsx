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
} from "react";
import { Check, Edit2, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { providerPresets } from "@/config/claudeProviderPresets";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
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

const TOOL_META: Record<string, ToolMeta> = {
  grokbuild: {
    appId: "grokbuild",
    name: "Grok Build",
    shortName: "Gk",
    category: "switch",
    categoryLabel: "切换类",
    description: "管理本机线路，配置不代表已安装或登录。",
    color: "#2563EB",
  },

  "claude-desktop": {
    appId: "claude-desktop",
    name: "Claude Desktop",
    shortName: "CD",
    category: "switch",
    categoryLabel: "桌面客户端",
    description: "连接官方客户端，安装、线路与登录独立管理。",
    color: "#C46D50",
  },

  "claude-code": {
    appId: "claude",
    name: "Claude Code",
    shortName: "CC",
    category: "switch",
    categoryLabel: "切换类",
    description: "只读发现本机配置，按需导入或切换线路。",
    color: "#D97706",
  },
  "gemini-cli": {
    appId: "gemini",
    name: "Gemini CLI",
    shortName: "Gm",
    category: "switch",
    categoryLabel: "切换类",
    description: "只读发现本机配置，按需导入或切换线路。",
    color: "#2563EB",
  },
  opencode: {
    appId: "opencode",
    name: "OpenCode",
    shortName: "OC",
    category: "accumulate",
    categoryLabel: "累加类",
    description: "可以同时启用多条线路，停用后仍保留已保存的配置。",
    color: "#10B981",
  },
  pi: {
    appId: "pi",
    name: "Pi",
    shortName: "Pi",
    category: "accumulate",
    categoryLabel: "累加类",
    description: "可以同时启用多条线路，默认模型仍在 Pi 中选择。",
    color: "#8B5CF6",
  },
};

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
  const canImport = Boolean(liveConfigImporters[tool.appId]);

  useEffect(() => {
    setEditing(null);
    setRemoving(null);
    setDeleting(false);
    setDesktopSupported(false);
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
    if (tool.category === "switch" && removing.id === currentId) return;
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

  return (
    <div className="tool-view text-[var(--text-1)] box-border w-full h-full flex flex-col gap-[12px] p-[12px_24px] bg-[var(--bg-surface)] overflow-y-auto">
      {editing && !isNativeToolAppId(tool.appId) && (
        <Suspense fallback={<p role="status">正在加载原生表单…</p>}>
          <ToolProviderEditor
            appId={tool.appId}
            provider={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => void load()}
          />
        </Suspense>
      )}
      <header className="w-full flex items-center gap-[12px]">
        <div
          className="w-[40px] h-[40px] shrink-0 flex items-center justify-center rounded-[8px] text-white font-bold"
          style={{ backgroundColor: tool.color }}
        >
          {tool.shortName}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-[10px]">
            <h1 className="m-0 text-[28px]/[36px] text-[var(--text-1)] font-bold">
              {tool.name}
            </h1>
            <span className="px-[8px] py-[2px] rounded-full border border-[var(--border-subtle)] text-[12px] text-[var(--text-2)]">
              {tool.categoryLabel}
            </span>
          </div>
          <p className="m-0 text-[13px] text-[var(--text-3)]">
            {tool.description}
          </p>
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
            <Button
              variant="outline"
              disabled={!onManageResources}
              onClick={() => onManageResources?.(tool.appId)}
            >
              管理 {tool.name} 的 {"Skills 与 MCP"}
            </Button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              void load();
              void scan();
            }}
            disabled={refreshing || loading || importing}
            className="h-[32px] px-[10px] flex items-center gap-[6px] rounded-[4px] border border-[var(--border-control)] bg-transparent cursor-pointer disabled:opacity-50"
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
            刷新线路
          </button>
          <button
            type="button"
            disabled={!canMutate || importing}
            onClick={() => editLine("new")}
            className="h-[32px] px-[12px] flex items-center gap-[6px] rounded-[4px] border-0 bg-[#006AA0] text-white cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={16} />
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
          <Suspense fallback={<p role="status">正在读取 Desktop 状态…</p>}>
            <DesktopStatusPanel
              native={native}
              refreshVersion={refreshVersion + statusRefresh}
              onChanged={load}
              onSupported={setDesktopSupported}
            />
          </Suspense>
        ) : null}

        <div className="w-full flex flex-wrap items-center gap-[20px] px-[12px] py-[9px] rounded-[6px] bg-[var(--bg-subtle)] text-[12px] text-[var(--text-3)]">
          <span
            className={`flex items-center gap-[4px] ${!error && !loading ? "text-[var(--success-fg)]" : ""}`}
          >
            {!error && !loading && <Check size={14} />}
            {error
              ? "未连接本机配置"
              : loading
                ? "正在读取本机配置"
                : tool.appId === "pi"
                  ? "原生配置线路"
                  : "Chimera 已保存线路"}
          </span>
          <span>{providers.length} 条线路</span>
          {hasBuiltInEntry && <span>另有 1 个内置官方入口</span>}
          {tool.category === "accumulate" && (
            <span>{activeCount} 条已启用</span>
          )}
        </div>

        {canImport && !loading && !error && (
          <section className="tool-discovery" aria-label="本机配置导入">
            <div>
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
              <p>自动检测只读，不覆盖或切换现有配置。</p>
              {confirmImport && (
                <p id="tool-import-warning">
                  {tool.category === "accumulate"
                    ? "确认保存到 Chimera？同名线路会按本机配置更新，工具配置文件保持不变。"
                    : "确认保存到 Chimera？已有自定义线路时会跳过，工具配置文件保持不变。"}
                </p>
              )}
            </div>
            <div className="tool-discovery-actions">
              {confirmImport && (
                <Button variant="ghost" onClick={() => setConfirmImport(false)}>
                  取消
                </Button>
              )}
              <Button
                variant="outline"
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
                    ? "Claude 官方账号"
                    : "Google 官方账号"}
                  {hasBuiltInEntry && "（可选入口）"}
                </strong>
                {hasBuiltInEntry && (
                  <p>这是内置入口，不是本机配置或登录状态的检测结果。</p>
                )}
                <p>
                  官方线路无需填写 API 密钥。先切换到官方线路，再在 {tool.name}{" "}
                  中完成登录。
                </p>
                <p>
                  {tool.appId === "claude" ? (
                    <>
                      运行 <code>claude</code>，输入 <code>/login</code>{" "}
                      完成授权。
                    </>
                  ) : (
                    <>
                      运行 <code>gemini</code>，选择{" "}
                      <code>Login with Google</code> 完成授权。
                    </>
                  )}{" "}
                  登录状态由工具管理，此处不代表已登录。
                </p>
              </div>
              {currentId === officialProvider.id && (
                <Button
                  variant="outline"
                  disabled={Boolean(busyId) || importing}
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
          <div
            className="w-full rounded-[6px] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-[16px] py-[12px] text-[13px] text-[var(--danger-fg)]"
            role="alert"
          >
            读取 {tool.name} 配置失败：{error}
          </div>
        )}
        {loading && (
          <div
            className="w-full py-[28px] text-center text-[13px] text-[var(--text-3)]"
            role="status"
          >
            <Loader2 size={16} className="inline animate-spin mr-[6px]" />
            正在读取本机配置…
          </div>
        )}
        {!loading && !error && visibleProviders.length === 0 && (
          <div className="w-full rounded-[6px] border border-dashed border-[var(--border-control)] px-[16px] py-[28px] text-center text-[13px] text-[var(--text-3)]">
            还没有 {tool.name} 线路。点击“添加线路”开始配置。
          </div>
        )}

        {!loading && !error && visibleProviders.length > 0 && (
          <div className="tool-provider-table w-full border border-[var(--border-subtle)] rounded-[6px] overflow-x-auto">
            <div className="h-[34px] px-[12px] flex items-center gap-[12px] bg-[var(--bg-subtle)] text-[12px] text-[var(--text-3)] font-bold">
              <div className="w-[42px]">状态</div>
              <div className="w-[180px]">名称</div>
              <div className="flex-1">端点地址</div>
              <div className="w-[160px]">默认模型</div>
              <div className="w-[190px] text-right">操作</div>
            </div>
            {visibleProviders.map((provider) => {
              const enabled = provider.meta?.liveConfigManaged !== false;
              const current = provider.id === currentId;
              const busy = busyId === provider.id;
              const builtIn =
                hasBuiltInEntry && provider.id === officialProvider?.id;
              return (
                <div
                  key={provider.id}
                  className="min-h-[52px] px-[12px] flex items-center gap-[12px] border-t border-[var(--border-subtle)] hover:bg-[var(--bg-subtle)]"
                >
                  <div className="w-[42px]">
                    {tool.category === "accumulate" ? (
                      <button
                        type="button"
                        aria-label={`${enabled ? "停用" : "启用"}${provider.name}`}
                        onClick={() => void toggleProvider(provider)}
                        disabled={Boolean(busyId) || importing}
                        className={`w-[28px] h-[16px] p-[2px] flex rounded-full border-0 cursor-pointer ${enabled ? "justify-end bg-[#05773B]" : "justify-start bg-[#81878D]"}`}
                      >
                        <span className="w-[12px] h-[12px] rounded-full bg-white" />
                      </button>
                    ) : (
                      <span
                        className={`block w-[9px] h-[9px] rounded-full ${current ? "bg-[#05773B]" : "bg-[#C9CDD1]"}`}
                      />
                    )}
                  </div>
                  <div className="w-[180px] flex items-center gap-[8px] min-w-0">
                    <span className="w-[22px] h-[22px] rounded flex items-center justify-center bg-[#1A1E24] text-white text-[11px] font-bold">
                      {provider.name.trim().slice(0, 1) || "线"}
                    </span>
                    <span className="truncate text-[13px] font-bold">
                      {provider.name}
                    </span>
                  </div>
                  <div className="flex-1 truncate font-mono text-[12px] text-[var(--text-2)]">
                    {builtIn
                      ? "内置官方入口（未启用）"
                      : toolProviderSummary(tool.appId, provider).baseUrl ||
                        (provider.category === "official"
                          ? "官方默认端点"
                          : "—")}
                  </div>
                  <div className="w-[160px] truncate font-mono text-[12px] text-[var(--text-2)]">
                    {toolProviderSummary(tool.appId, provider).model || "—"}
                  </div>
                  <div className="w-[190px] flex justify-end items-center gap-[5px]">
                    {tool.category === "switch" && (
                      <button
                        type="button"
                        onClick={() => void changeProvider(provider)}
                        disabled={
                          !canMutate || current || Boolean(busyId) || importing
                        }
                        className={`h-[27px] px-[8px] rounded border-0 text-[12px] cursor-pointer ${current ? "bg-transparent text-[var(--success-fg)] font-bold" : "bg-[#006AA0] text-white"}`}
                      >
                        {busy ? "处理中…" : current ? "当前线路" : "切换"}
                      </button>
                    )}
                    {busy && (
                      <Loader2
                        size={14}
                        className="animate-spin text-[var(--text-3)]"
                      />
                    )}
                    {providers.some((item) => item.id === provider.id) && (
                      <button
                        type="button"
                        aria-label={`编辑${provider.name}`}
                        disabled={!canMutate || Boolean(busyId) || importing}
                        onClick={() => editLine(provider.id)}
                        className="w-[27px] h-[27px] flex items-center justify-center border-0 bg-transparent cursor-pointer text-[var(--text-3)]"
                      >
                        <Edit2 size={14} />
                      </button>
                    )}
                    {!builtIn && (
                      <button
                        type="button"
                        className="tool-provider-delete"
                        aria-label={`删除${provider.name}`}
                        title={
                          tool.category === "switch" && current
                            ? "请先切换到其他线路后再删除"
                            : "删除线路"
                        }
                        disabled={
                          !native ||
                          !canMutate ||
                          Boolean(busyId) ||
                          importing ||
                          (tool.category === "switch" && current)
                        }
                        onClick={() => setRemoving(provider)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        删除
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div hidden={tool.appId === "pi" && piSection !== "install"}>
        {tool.appId !== "claude-desktop" && (
          <details
            key={toolId}
            className="tool-installation"
            open={tool.appId === "pi" ? true : undefined}
          >
            <summary>
              安装与环境检查
              <span className="tool-installation-hint">版本与更新</span>
            </summary>
            <div className="tool-installation-content">
              {native && lifecycleTools[toolId] ? (
                <Suspense fallback={<p role="status">正在加载安装检测…</p>}>
                  <AboutSection
                    key={toolId}
                    isPortable={false}
                    toolsOnly
                    tools={lifecycleTools[toolId]}
                  />
                </Suspense>
              ) : (
                <p className="text-[13px] text-[var(--text-3)]">
                  {!native
                    ? "浏览器预览未检测安装状态，请在桌面应用中检测、安装或升级。"
                    : `${tool.name} 的安装检测与托管升级尚未接入，线路配置不代表已安装。`}
                </p>
              )}
              {tool.appId === "pi" && (
                <p className="text-[13px] text-[var(--text-3)]">
                  Pi 支持原生 MCP 和扩展包，可在「默认模型与
                  MCP」管理全局配置；统一 Skills 同步暂未接入。
                </p>
              )}
            </div>
          </details>
        )}
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

export default ToolView;
