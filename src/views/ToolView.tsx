import { isHermesReadOnlyProvider } from "@/config/hermesProviderPresets";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, Edit2, Loader2, Minus, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { providerPresets } from "@/config/claudeProviderPresets";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";
import { Button } from "@/components/ui/button";
import "./ToolView.css";
import type { Provider } from "@/types";
import type { AppId } from "@/lib/api/types";
import { providersApi } from "@/lib/api/providers";
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
  openclaw: ["openclaw"],
  hermes: ["hermes"],
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
  mcode: {
    appId: "mcode",
    name: "MiniMax Code",
    shortName: "MM",
    category: "accumulate",
    categoryLabel: "累加类",
    description: "使用原生配置管理线路；配置状态不代表已安装或已登录。",
    color: "#2563EB",
  },

  hermes: {
    appId: "hermes",
    name: "Hermes",
    shortName: "He",
    category: "accumulate",
    categoryLabel: "累加类",
    description: "使用原生配置管理线路；配置状态不代表已安装或已登录。",
    color: "#2563EB",
  },

  openclaw: {
    appId: "openclaw",
    name: "OpenClaw",
    shortName: "Cl",
    category: "accumulate",
    categoryLabel: "累加类",
    description: "使用原生配置管理线路；配置状态不代表已安装或已登录。",
    color: "#2563EB",
  },

  grokbuild: {
    appId: "grokbuild",
    name: "Grok Build",
    shortName: "Gk",
    category: "switch",
    categoryLabel: "切换类",
    description: "使用原生配置管理线路；配置状态不代表已安装或已登录。",
    color: "#2563EB",
  },

  "claude-desktop": {
    appId: "claude-desktop",
    name: "Claude Desktop",
    shortName: "CD",
    category: "switch",
    categoryLabel: "切换类",
    description: "使用原生配置管理线路；配置状态不代表已安装或已登录。",
    color: "#2563EB",
  },

  "claude-code": {
    appId: "claude",
    name: "Claude Code",
    shortName: "CC",
    category: "switch",
    categoryLabel: "切换类",
    description: "同一时间使用一条线路，保存后写入 Claude Code 的本机设置。",
    color: "#D97706",
  },
  "gemini-cli": {
    appId: "gemini",
    name: "Gemini CLI",
    shortName: "Gm",
    category: "switch",
    categoryLabel: "切换类",
    description: "同一时间使用一条线路，保存后写入 Gemini CLI 的本机设置。",
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

  useEffect(() => {
    setEditing(null);
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
    void load();
    return () => {
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
  const visibleProviders =
    officialProvider && !providers.some((p) => p.id === officialProvider.id)
      ? [officialProvider, ...providers]
      : providers;

  const changeProvider = async (provider: Provider) => {
    if (busyId || !canMutate) return;
    setBusyId(provider.id);
    try {
      if (providers.some((item) => item.id === provider.id)) {
        const result = await providersApi.switch(provider.id, tool.appId);
        result.warnings?.forEach((warning) => toast.warning(warning));
      } else {
        await providersApi.addAndActivate(provider, tool.appId);
      }
      toast.success("已切换至「" + provider.name + "」", {
        description: "已打开的 " + tool.name + " 需重新启动后使用新线路。",
      });
      await load();
    } catch (cause) {
      toast.error("配置未更新", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      if (activeApp.current === tool.appId) setBusyId(null);
    }
  };

  const toggleProvider = async (provider: Provider) => {
    if (busyId || !canMutate) return;
    setBusyId(provider.id);
    try {
      const enabled = provider.meta?.liveConfigManaged !== false;
      if (enabled) {
        await providersApi.removeFromLiveConfig(provider.id, tool.appId);
        toast.success(`已停用「${provider.name}」`);
      } else {
        await providersApi.switch(provider.id, tool.appId);
        toast.success(`已启用「${provider.name}」`);
      }
      await load();
    } catch (cause) {
      toast.error("配置未更新", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      if (activeApp.current === tool.appId) setBusyId(null);
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
      {tool.appId === "claude-desktop" && (
        <Suspense fallback={<p role="status">正在读取 Desktop 状态…</p>}>
          <DesktopStatusPanel
            native={native}
            refreshVersion={refreshVersion + statusRefresh}
            onChanged={load}
            onSupported={setDesktopSupported}
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
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            void load();
          }}
          disabled={refreshing || loading}
          className="h-[32px] px-[10px] flex items-center gap-[6px] rounded-[4px] border border-[var(--border-control)] bg-transparent cursor-pointer disabled:opacity-50"
        >
          <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
          刷新
        </button>
        <button
          type="button"
          disabled={!canMutate}
          onClick={() => editLine("new")}
          className="h-[32px] px-[12px] flex items-center gap-[6px] rounded-[4px] border-0 bg-[#006AA0] text-white cursor-pointer"
        >
          <Plus size={16} />
          添加线路
        </button>
      </header>

      <section
        className="w-full shrink-0"
        aria-label={`${tool.name} 安装与资源管理`}
      >
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
              : tool.appId === "claude-desktop"
                ? "Desktop 安装探测结果见配置状态面板；暂无安装、升级或重启管理。"
                : `${tool.name} 的安装检测与托管升级尚未接入，线路配置不代表已安装。`}
          </p>
        )}
        {[
          "claude",
          "gemini",
          "opencode",
          "grokbuild",
          "openclaw",
          "hermes",
        ].includes(tool.appId) ? (
          <Button
            variant="outline"
            disabled={!onManageResources}
            onClick={() => onManageResources?.(tool.appId)}
          >
            管理 {tool.name} 的{" "}
            {tool.appId === "openclaw"
              ? "Skills（MCP 暂不管理）"
              : "Skills 与 MCP"}
          </Button>
        ) : (
          <p className="text-[13px] text-[var(--text-3)]">
            {tool.appId === "claude-desktop"
              ? "Desktop 3P 不支持原生 MCP/扩展与 Skills 受管同步；Claude Code 共享资源不等于 Desktop 原生资源。"
              : tool.appId === "pi"
                ? "Pi 暂不支持 Skills 同步；Pi 没有原生 MCP 注册表。"
                : "MiniMax Code 的 Skills 与 MCP 当前未管理；此处仅管理工具线路。"}
          </p>
        )}
      </section>

      <div className="w-full flex items-center gap-[20px] px-[12px] py-[9px] rounded-[6px] bg-[var(--bg-subtle)] text-[12px] text-[var(--text-3)]">
        <span className="flex items-center gap-[4px] text-[var(--success-fg)]">
          <Check size={14} />
          {error
            ? "未连接本机配置"
            : loading
              ? "正在读取本机配置"
              : "本机线路配置"}
        </span>
        <span>{visibleProviders.length} 条线路</span>
        {tool.category === "accumulate" && <span>{activeCount} 条已启用</span>}
        <span className="flex items-center gap-[4px]">
          <Minus size={14} />
          此工具暂不支持线路测速
        </span>
      </div>

      {officialPreset && officialProvider && !loading && !error && (
        <section className="tool-official-guide" aria-label="官方账号登录">
          <div>
            <strong>
              {tool.appId === "claude" ? "Claude 官方账号" : "Google 官方账号"}
            </strong>
            <p>
              官方线路无需填写 API 密钥。先切换到官方线路，再在 {tool.name}{" "}
              中完成登录。
            </p>
            <p>
              {tool.appId === "claude" ? (
                <>
                  运行 <code>claude</code>，输入 <code>/login</code> 完成授权。
                </>
              ) : (
                <>
                  运行 <code>gemini</code>，选择 <code>Login with Google</code>{" "}
                  完成授权。
                </>
              )}{" "}
              登录状态由工具管理，此处不代表已登录。
            </p>
          </div>
          {currentId === officialProvider.id && (
            <Button
              variant="outline"
              disabled={Boolean(busyId)}
              onClick={async () => {
                setBusyId(officialProvider.id);
                try {
                  await providersApi.openTerminal(
                    officialProvider.id,
                    tool.appId,
                  );
                } catch (cause) {
                  toast.error("无法打开终端", { description: String(cause) });
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
            <div className="w-[130px] text-right">操作</div>
          </div>
          {visibleProviders.map((provider) => {
            const enabled = provider.meta?.liveConfigManaged !== false;
            const current = provider.id === currentId;
            const busy = busyId === provider.id;
            const readOnly =
              tool.appId === "hermes" &&
              isHermesReadOnlyProvider(provider.settingsConfig);
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
                      disabled={Boolean(busyId) || readOnly}
                      title={
                        readOnly ? "此条目由 Hermes Web UI 管理" : undefined
                      }
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
                  {toolProviderSummary(tool.appId, provider).baseUrl ||
                    (provider.category === "official" ? "官方默认端点" : "—")}
                </div>
                <div className="w-[160px] truncate font-mono text-[12px] text-[var(--text-2)]">
                  {toolProviderSummary(tool.appId, provider).model || "—"}
                </div>
                <div className="w-[130px] flex justify-end items-center gap-[5px]">
                  {tool.category === "switch" && (
                    <button
                      type="button"
                      onClick={() => void changeProvider(provider)}
                      disabled={!canMutate || current || Boolean(busyId)}
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
                      disabled={!canMutate || readOnly}
                      title={
                        readOnly ? "此条目由 Hermes Web UI 管理" : undefined
                      }
                      onClick={() => editLine(provider.id)}
                      className="w-[27px] h-[27px] flex items-center justify-center border-0 bg-transparent cursor-pointer text-[var(--text-3)]"
                    >
                      <Edit2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ToolView;
