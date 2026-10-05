import React, { useState } from "react";
import {
  Share2 as Export,
  Plus,
  ShieldCheck,
  HelpCircle as Question,
  Edit3 as NotePencil,
  MoreHorizontal as DotsThree,
  X,
  Trash2 as Trash,
  Edit2 as PencilSimple,
  FileArchive,
  GitBranch,
  Plug,
  Puzzle,
} from "lucide-react";
import { toast } from "sonner";
import "./SkillsMcpView.css";
import {
  skillsApi,
  type InstalledSkill,
  type DiscoverableSkill,
  type SkillRepo,
  type UnmanagedSkill,
  type SkillBackupEntry,
  type SkillUpdateInfo,
} from "@/lib/api/skills";
import { mcpApi } from "@/lib/api/mcp";
import { officialAccountsApi } from "@/lib/api/officialAccounts";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { McpServer } from "@/types";
import type { AppId } from "@/lib/api";
import { lazy, Suspense, useCallback, useEffect, useRef } from "react";
const RepoManagerPanel = lazy(() =>
  import("@/components/skills/RepoManagerPanel").then((module) => ({
    default: module.RepoManagerPanel,
  })),
);
const McpFormModal = lazy(() => import("@/components/mcp/McpFormModal"));
const MCP_EXPORT_NOTICE =
  "环境变量与请求头已脱敏；分享前请检查地址、启动参数和备注";

const RESOURCE_TOOLS = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude Code" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "grokbuild", name: "Grok Build" },
  { id: "opencode", name: "OpenCode" },
  { id: "openclaw", name: "OpenClaw" },
  { id: "hermes", name: "Hermes" },
] as const;
type ResourceApp = (typeof RESOURCE_TOOLS)[number]["id"];
const MCP_APPS = RESOURCE_TOOLS.filter((tool) => tool.id !== "openclaw").map(
  (tool) => tool.id,
);

export const SkillsMcpView: React.FC<{
  initialApp?: AppId;
  refreshVersion?: number;
}> = ({ initialApp = "codex", refreshVersion = 0 }) => {
  const [targetApp, setTargetApp] = useState<ResourceApp>(
    () => RESOURCE_TOOLS.find((tool) => tool.id === initialApp)?.id || "codex",
  );
  const targetName = RESOURCE_TOOLS.find((tool) => tool.id === targetApp)!.name;
  const supportsMcp = targetApp !== "openclaw";
  const [tab, setTab] = useState<"skills" | "mcp">("skills");
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [skillNotes, setSkillNotes] = useState<Record<string, string>>({});
  const [mcpNotes, setMcpNotes] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installDrawerOpen, setInstallDrawerOpen] = useState(false);
  const installPanelRef = useRef<HTMLDivElement>(null);
  // null until the configured repositories have been read, so an empty read
  // can say so instead of leaving the panel silently blank.
  const [available, setAvailable] = useState<DiscoverableSkill[] | null>(null);
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [loading, setLoading] = useState(true);
  // True only while the rows on screen come from a successful read; counts,
  // the summary card and empty states never speak for data we do not have.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repos, setRepos] = useState<SkillRepo[]>([]);
  const [unmanaged, setUnmanaged] = useState<UnmanagedSkill[] | null>(null);
  const [selectedImports, setSelectedImports] = useState<string[]>([]);
  const [backups, setBackups] = useState<SkillBackupEntry[] | null>(null);
  const [updates, setUpdates] = useState<SkillUpdateInfo[] | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    action: () => Promise<unknown>;
  } | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const [nextSkills, nextServers, sn, mn] = await Promise.all([
        skillsApi.getInstalled(),
        mcpApi.getAllServers(),
        officialAccountsApi.getNotes("skills"),
        officialAccountsApi.getNotes("mcp_servers"),
      ]);
      if (request !== generation.current) return;
      setInstalled(nextSkills);
      setServers(Object.values(nextServers));
      setSkillNotes(sn);
      setMcpNotes(mn);
      setLoaded(true);
    } catch {
      if (request === generation.current) {
        // Rows from an earlier read may no longer be true; show only the error.
        setInstalled([]);
        setServers([]);
        setLoaded(false);
        setError("Skills 与 MCP 读取失败，请检查后重试。");
      }
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload, refreshVersion]);
  useEffect(() => {
    // In the narrow layout the panel opens below the fold; moving focus into
    // it also scrolls it into view, so the click visibly does something.
    if (installDrawerOpen) installPanelRef.current?.focus();
  }, [installDrawerOpen]);
  const run = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setOperationError(null);
    try {
      await action();
      await reload();
      return true;
    } catch {
      setOperationError(
        "操作失败，可能部分完成。请重新读取列表并检查目标工具后重试。",
      );
      toast.error("操作失败，请重试。未确认配置已更新。");
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const skills = installed.map((s) => ({
    ...s,
    enabled: Boolean(s.apps[targetApp]),
    source:
      s.repoOwner && s.repoName ? `${s.repoOwner}/${s.repoName}` : "本地安装",
    note: skillNotes[s.id] || "",
  }));
  const mcps = servers.map((s) => ({
    ...s,
    // server.enabled is Codex soft-disable intent, not a shared app switch.
    enabled:
      Boolean(s.apps[targetApp]) &&
      (targetApp !== "codex" || s.server.enabled !== false),
    sourceCommand: s.server.type || (s.server.url ? "http" : "stdio"),
    remote:
      Boolean(s.server.url) ||
      ["http", "sse", "streamable-http"].includes(s.server.type || ""),
    note: mcpNotes[s.id] || "",
    envMasked: Object.keys(s.server.env || {}).length
      ? {
          key: Object.keys(s.server.env || {}).join(", "),
          maskedValue: "[已设置]",
        }
      : null,
  }));
  const selectedMcp = mcps.find((s) => s.id === selectedId) || null;
  const setSelectedMcp = (server: { id: string } | null) =>
    setSelectedId(server?.id || null);
  const handleToggleSkill = (id: string) => {
    const skill = skills.find((s) => s.id === id);
    if (skill)
      void run(async () => {
        if (!(await skillsApi.toggleApp(id, targetApp, !skill.enabled)))
          throw new Error("toggle rejected");
      });
  };
  const handleToggleMcp = (id: string) => {
    const server = mcps.find((s) => s.id === id);
    if (server && supportsMcp)
      void run(() => mcpApi.toggleApp(id, targetApp, !server.enabled));
  };
  const handleStartEditNote = (id: string, note: string) => {
    setEditingNoteId(id);
    setNoteText(note);
  };
  const handleSaveNote = (id: string, isSkill: boolean) =>
    void run(async () => {
      await officialAccountsApi.setNotes(
        isSkill ? "skills" : "mcp_servers",
        id,
        noteText,
      );
      setEditingNoteId(null);
    });
  const enabledSkillsCount = skills.filter((s) => s.enabled).length;
  const enabledMcpCount = mcps.filter((s) => s.enabled).length;
  const hasCurrentRows =
    loaded && (tab === "skills" ? skills.length > 0 : mcps.length > 0);
  // The backend only checks Skills that were installed from a repository.
  const hasRepoSkills = installed.some(
    (skill) => skill.repoOwner && skill.repoName,
  );
  const installFromZip = () =>
    void run(async () => {
      const path = await skillsApi.openZipFileDialog();
      if (path) await skillsApi.installFromZip(path, targetApp);
    });
  const exportSafeConfiguration = () => {
    const maskValues = (values?: Record<string, string>) =>
      values
        ? Object.fromEntries(
            Object.keys(values).map((key) => [key, "[已设置]"]),
          )
        : undefined;
    const safeServers = servers.map(({ server, ...entry }) => ({
      ...entry,
      server: {
        ...server,
        env: maskValues(server.env),
        headers: maskValues(server.headers),
        http_headers: maskValues(server.http_headers),
      },
    }));
    const payload = JSON.stringify(
      { skills: installed, mcpServers: safeServers },
      null,
      2,
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([payload], { type: "application/json;charset=utf-8" }),
    );
    link.download = "chimera-skills-mcp.json";
    link.click();
    URL.revokeObjectURL(link.href);
    toast.success(`已导出配置。${MCP_EXPORT_NOTICE}`);
  };
  return (
    <div className="connected-page text-[var(--text-1)] min-h-full box-border w-full flex flex-col gap-[12px] p-[12px_24px] justify-start items-start bg-[var(--bg-surface)] min-h-0">
      {/* 页头 */}
      <div
        data-pencil-name="页头"
        className="box-border w-full h-[56px] shrink-0 flex flex-row gap-[12px] justify-start items-center"
      >
        <div className="box-border [flex:1_1_0] h-fit flex flex-col gap-[2px] justify-start items-start">
          <div className="box-border w-fit h-fit shrink-0 flex flex-row gap-[10px] justify-start items-center">
            <h1 className="text-[28px]/[36px] box-border text-[var(--text-1)] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-left whitespace-nowrap m-0">
              Skills 与 MCP
            </h1>
          </div>
          <div className="text-[13px]/[18px] box-border text-[var(--text-3)] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap">
            共享资源库 · 启用开关仅作用于 {targetName}，不改变其他工具
          </div>
        </div>
        <div className="box-border w-fit shrink-0 h-fit flex flex-row gap-[8px] justify-start items-center">
          <button
            type="button"
            disabled={loading || !loaded}
            onClick={exportSafeConfiguration}
            aria-describedby="mcp-export-scope"
            className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[var(--bg-surface)] outline outline-1 outline-[var(--border-control)] -outline-offset-[0.5px] rounded-[4px] border-none cursor-pointer text-[var(--text-1)] hover:bg-[var(--bg-subtle)] transition-colors"
          >
            <Export size={16} />
            <span className="text-[14px]/[20px] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal whitespace-nowrap">
              导出
            </span>
          </button>
          {/* The empty state carries the add action itself; one primary is enough. */}
          {hasCurrentRows && (
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => {
                if (tab === "skills") setInstallDrawerOpen(true);
                else setEditing("new");
              }}
              className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[#006AA0] hover:bg-[#005a88] active:bg-[#004e76] transition-colors rounded-[4px] border-none cursor-pointer text-[#FDFDFE]"
            >
              <Plus size={16} strokeWidth={2.5} />
              <span className="text-[14px]/[20px] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal whitespace-nowrap">
                {tab === "skills" ? "安装" : "添加 MCP"}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* 标签栏 (双 Tab 1:1) */}
      <label className="flex items-center gap-[8px] text-[13px]">
        目标工具
        <select
          aria-label="目标工具"
          value={targetApp}
          disabled={
            busy ||
            confirmation !== null ||
            repoOpen ||
            editing !== null ||
            removing !== null
          }
          onChange={(event) => {
            const next = RESOURCE_TOOLS.find(
              (tool) => tool.id === event.target.value,
            );
            if (!next || busyRef.current) return;
            setTargetApp(next.id);
            setSelectedId(null);
            setEditingNoteId(null);
            setInstallDrawerOpen(false);
            if (next.id === "openclaw") setTab("skills");
          }}
          className="bg-[var(--bg-surface)] text-[var(--text-1)] rounded-[4px]"
        >
          {RESOURCE_TOOLS.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.name}
            </option>
          ))}
        </select>
      </label>
      {!supportsMcp && (
        <p role="status" className="skills-mcp-status">
          OpenClaw 支持 Skills 同步，暂不支持受管 MCP 配置。
        </p>
      )}

      <div className="box-border w-full min-h-[36px] shrink-0 flex flex-row gap-[24px] justify-start items-end border-b border-solid border-[var(--border-subtle)]">
        <button
          type="button"
          disabled={busy || confirmation !== null || repoOpen}
          onClick={() => {
            if (tab !== "skills") setEditingNoteId(null);
            setTab("skills");
          }}
          className={`box-border h-[35px] flex flex-row gap-[6px] px-[2px] justify-start items-center border-none bg-transparent cursor-pointer ${
            tab === "skills"
              ? "border-b-2 border-solid border-[#006AA0] text-[var(--text-1)] font-bold"
              : "text-[var(--text-2)] font-normal hover:text-[var(--text-1)]"
          }`}
        >
          <span className="text-[14px]/[20px] font-[Overpass,system-ui,sans-serif] whitespace-nowrap">
            Skills
          </span>
          {loaded && (
            <span className="text-[13px]/[18px] text-[var(--text-3)] font-[Overpass,system-ui,sans-serif] whitespace-nowrap">
              {skills.length}
            </span>
          )}
        </button>

        <button
          type="button"
          disabled={busy || !supportsMcp}
          onClick={() => {
            if (!supportsMcp) return;
            if (tab !== "mcp") setEditingNoteId(null);
            setTab("mcp");
          }}
          className={`box-border h-[35px] flex flex-row gap-[6px] px-[2px] justify-start items-center border-none bg-transparent cursor-pointer ${
            tab === "mcp"
              ? "border-b-2 border-solid border-[#006AA0] text-[var(--text-1)] font-bold"
              : "text-[var(--text-2)] font-normal hover:text-[var(--text-1)]"
          }`}
        >
          <span className="text-[14px]/[20px] font-[Overpass,system-ui,sans-serif] whitespace-nowrap">
            MCP
          </span>
          {loaded && (
            <span className="text-[13px]/[18px] text-[var(--text-3)] font-[Overpass,system-ui,sans-serif] whitespace-nowrap">
              {mcps.length}
            </span>
          )}
        </button>

        <div className="[flex:1_1_0]" />

        {/* 常驻导出范围说明 */}
        <div className="box-border min-w-0 max-w-[520px] py-[4px] flex flex-row gap-[6px] justify-start items-center">
          <ShieldCheck size={14} className="shrink-0 text-[var(--text-3)]" />
          <span
            id="mcp-export-scope"
            className="text-[13px]/[18px] text-[var(--text-3)] font-['Noto_Sans_SC',system-ui,sans-serif]"
          >
            导出全部工具的共享资源与启用状态。{MCP_EXPORT_NOTICE}
          </span>
        </div>
      </div>

      {loading && !loaded && (
        <p role="status" className="skills-mcp-status">
          正在读取 Skills 与 MCP…
        </p>
      )}
      {error && (
        <div role="alert" className="skills-mcp-notice">
          <span>{error}</span>
          <button
            type="button"
            className="skills-mcp-notice-action"
            onClick={() => void reload()}
          >
            重试
          </button>
        </div>
      )}
      {operationError && (
        <div role="alert" className="skills-mcp-notice">
          <span>{operationError}</span>
          <button
            type="button"
            className="skills-mcp-notice-action"
            disabled={busy || loading}
            onClick={() => {
              setOperationError(null);
              void reload();
            }}
          >
            重新读取
          </button>
        </div>
      )}

      {/* 状态头 (深色石墨灯箱 1:1)：只在有真实条目时出现，空列表不画一条全是 0 的链路。 */}
      {hasCurrentRows && (
        <div
          data-pencil-name="状态头"
          className="box-border w-full min-h-[97px] shrink-0 flex flex-row gap-[24px] p-[16px_16px_16px_24px] justify-start items-center bg-[#1A1E24] outline outline-1 outline-[#1A1E24] -outline-offset-[0.5px] rounded-[8px] overflow-hidden text-[#F5F7F9]"
        >
          {/* 标题区 */}
          <div className="box-border w-[200px] shrink-0 h-fit flex flex-col gap-[2px] justify-start items-start">
            <div className="text-[13px]/[18px] box-border text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap">
              {tab === "skills" ? "已启用 Skills" : "已启用 MCP"}
            </div>
            <div className="text-[22px]/[25px] box-border text-[#F5F7F9] font-[Overpass,system-ui,sans-serif] font-bold text-left whitespace-nowrap">
              {tab === "skills"
                ? `${enabledSkillsCount} / ${skills.length}`
                : `${enabledMcpCount} / ${mcps.length}`}
            </div>
            {(tab === "mcp" || supportsMcp) && (
              <div className="text-[13px]/[18px] box-border text-[#B4B8BC] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap">
                {tab === "skills"
                  ? `MCP 另有 ${mcps.length} 个`
                  : `Skills 另有 ${skills.length} 个`}
              </div>
            )}
          </div>

          {/* 3 节点路径条 */}
          <div className="box-border [flex:1_1_0] h-fit flex flex-row gap-0 justify-start items-start">
            {/* 站 1 */}
            <div className="box-border [flex:1_1_0] h-fit flex flex-col gap-[10px] justify-start items-start">
              <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                <div className="box-border w-[12px] shrink-0 h-[12px] bg-[#1A1E24] border-2 border-solid border-[#B4B8BC] rounded-full" />
                <div className="box-border [flex:1_1_0] h-[2px] bg-[#94999E]" />
              </div>
              <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                <div className="text-[13px]/[18px] text-[#F5F7F9] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold whitespace-nowrap">
                  {tab === "skills" ? "仓库与 ZIP" : "MCP 配置"}
                </div>
                <div className="text-[13px]/[18px] w-full text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif]">
                  {tab === "skills"
                    ? `${new Set(skills.map((s) => s.source)).size} 个来源`
                    : `${mcps.length} 个服务`}
                </div>
              </div>
            </div>

            {/* 站 2 */}
            <div className="box-border [flex:1_1_0] h-fit flex flex-col gap-[10px] justify-start items-start">
              <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                <div className="box-border w-[12px] shrink-0 h-[12px] bg-[#1A1E24] border-2 border-solid border-[#B4B8BC] rounded-full" />
                <div className="box-border [flex:1_1_0] h-[2px] bg-[#94999E]" />
              </div>
              <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                <div className="text-[13px]/[18px] text-[#F5F7F9] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold whitespace-nowrap">
                  {tab === "skills" ? "skills 目录" : "工具配置"}
                </div>
                <div className="text-[13px]/[18px] w-full text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif]">
                  {tab === "skills"
                    ? `${skills.length} 个 Skill · 独立目录`
                    : `${enabledMcpCount} 个已启用服务`}
                </div>
              </div>
            </div>

            {/* 站 3 */}
            <div className="box-border [flex:1_1_0] h-fit flex flex-col gap-[10px] justify-start items-start">
              <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                <div className="box-border w-[12px] shrink-0 h-[12px] bg-[#F5F7F9] border-2 border-solid border-[#F5F7F9] rounded-full" />
              </div>
              <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                <div className="text-[13px]/[18px] text-[#F5F7F9] font-[Overpass,system-ui,sans-serif] font-bold whitespace-nowrap">
                  {targetName}
                </div>
                <div className="text-[13px]/[18px] w-full text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif]">
                  {tab === "skills"
                    ? `新会话加载已启用的 ${enabledSkillsCount} 个`
                    : `新会话启动已启用的 ${enabledMcpCount} 个`}
                </div>
              </div>
            </div>
          </div>

          {/* 帮助图标 */}
          <button
            aria-label="了解 Skills 与 MCP 配置范围"
            type="button"
            onClick={() =>
              toast.info(
                tab === "skills"
                  ? "Skills 存放于本地独立文件夹"
                  : `MCP 服务同步到 ${targetName} 的配置，使用该工具的实际配置目录`,
              )
            }
            className="box-border w-[28px] shrink-0 h-[28px] flex justify-center items-center outline outline-1 outline-[#6F757B] -outline-offset-[0.5px] rounded-[4px] bg-transparent text-[#B4B8BC] hover:text-white cursor-pointer"
          >
            <Question size={16} />
          </button>
        </div>
      )}

      {repoOpen && (
        <Suspense fallback={<p role="status">正在加载仓库管理…</p>}>
          <RepoManagerPanel
            repos={repos}
            skills={available ?? []}
            onClose={() => {
              if (!busyRef.current) setRepoOpen(false);
            }}
            onAdd={async (repo) => {
              const saved = await run(async () => {
                if (!(await skillsApi.addRepo(repo)))
                  throw new Error("add rejected");
                setRepos(await skillsApi.getRepos());
                setAvailable(null);
              });
              if (!saved) throw new Error("仓库保存失败，请重试。");
            }}
            onRemove={async (owner, name) => {
              setConfirmation({
                title: "移除 Skill 仓库",
                message: `移除 ${owner}/${name} 的发现来源？已安装的 Skills 不会卸载。`,
                action: async () => {
                  if (!(await skillsApi.removeRepo(owner, name)))
                    throw new Error("remove rejected");
                  setRepos(await skillsApi.getRepos());
                  setAvailable(null);
                },
              });
            }}
          />
        </Suspense>
      )}
      <ConfirmDialog
        isOpen={confirmation !== null}
        busy={busy}
        title={confirmation?.title ?? "确认操作"}
        message={confirmation?.message ?? ""}
        confirmText="确认执行"
        cancelText="取消"
        onCancel={() => {
          if (!busyRef.current) setConfirmation(null);
        }}
        onConfirm={() => {
          if (confirmation)
            void run(confirmation.action).then((saved) => {
              if (saved) setConfirmation(null);
            });
        }}
      />
      {/* 两栏主区域 */}
      <fieldset
        data-pencil-name="两栏"
        disabled={busy || loading || !!error}
        aria-busy={busy}
        className="skills-mcp-workspace box-border w-full min-w-0 m-0 p-0 border-0 [flex:1_1_0] flex flex-row gap-[24px] justify-start items-start"
      >
        {/* 左侧：列表 */}
        <div className="skills-mcp-list box-border min-w-0 [flex:1_1_0] h-fit flex flex-col gap-0 justify-start items-start">
          {loaded && tab === "skills" && skills.length === 0 && (
            <section
              className="resource-empty"
              aria-labelledby="skills-empty-title"
            >
              <span className="resource-empty-icon" aria-hidden="true">
                <Puzzle size={22} strokeWidth={1.6} />
              </span>
              <h2 id="skills-empty-title">还没有安装 Skills</h2>
              <p>
                Skill 是打包好的任务说明和脚本，启用后 {targetName}
                会在新会话中按需使用。
              </p>
              <div className="resource-empty-paths">
                <button
                  type="button"
                  className="resource-path"
                  aria-expanded={installDrawerOpen}
                  aria-controls={
                    installDrawerOpen ? "skills-install-panel" : undefined
                  }
                  onClick={() => setInstallDrawerOpen(true)}
                >
                  <GitBranch size={18} aria-hidden="true" />
                  <span>
                    <strong>从仓库安装</strong>
                    <small>从已添加的 Git 仓库中挑选</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="resource-path"
                  onClick={installFromZip}
                >
                  <FileArchive size={18} aria-hidden="true" />
                  <span>
                    <strong>导入 ZIP</strong>
                    <small>选择本机的 Skill 压缩包</small>
                  </span>
                </button>
              </div>
            </section>
          )}
          {loaded && tab === "mcp" && mcps.length === 0 && (
            <section
              className="resource-empty"
              aria-labelledby="mcp-empty-title"
            >
              <span className="resource-empty-icon" aria-hidden="true">
                <Plug size={22} strokeWidth={1.6} />
              </span>
              <h2 id="mcp-empty-title">还没有 MCP 服务</h2>
              <p>
                MCP 服务为 {targetName}
                接入额外的工具和数据，比如读写本地文件、查询文档。
              </p>
              <button
                type="button"
                className="resource-empty-primary"
                onClick={() => setEditing("new")}
              >
                <Plus size={16} strokeWidth={2.5} aria-hidden="true" />
                添加 MCP
              </button>
            </section>
          )}
          {loaded && tab === "skills" && (
            <section className="skills-lifecycle" aria-label="Skills 维护">
              <fieldset
                disabled={
                  busy ||
                  loading ||
                  !!error ||
                  confirmation !== null ||
                  repoOpen
                }
              >
                <div className="skills-maintenance">
                  <span className="skills-maintenance-label">
                    {skills.length === 0 ? "也可以" : "维护"}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        setRepos(await skillsApi.getRepos());
                        setRepoOpen(true);
                      })
                    }
                  >
                    管理仓库
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        setUnmanaged(null);
                        setSelectedImports([]);
                        setUnmanaged(await skillsApi.scanUnmanaged());
                      })
                    }
                  >
                    扫描未纳管 Skills
                  </button>
                  {hasRepoSkills && (
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          setUpdates(null);
                          setUpdates(await skillsApi.checkUpdates());
                        })
                      }
                    >
                      检查 Skills 更新
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        setBackups(null);
                        setBackups(await skillsApi.getBackups());
                      })
                    }
                  >
                    查看可恢复备份
                  </button>
                </div>
                {unmanaged !== null && (
                  <div className="skills-lifecycle-panel">
                    <h2>扫描结果</h2>
                    <p>
                      仅纳管所选项目并启用到 {targetName}
                      ，其他目标不勾选。同目录名的多个来源不支持在此消歧，请先整理来源。
                    </p>
                    {unmanaged.length === 0 && <p>未发现未纳管的 Skills。</p>}
                    {unmanaged.map((skill, index) => (
                      <label
                        className="skills-lifecycle-row"
                        key={`${skill.directory}-${index}`}
                      >
                        <input
                          type="checkbox"
                          aria-label={`纳管 ${skill.name}`}
                          checked={selectedImports.includes(skill.directory)}
                          disabled={
                            unmanaged.filter(
                              (item) => item.directory === skill.directory,
                            ).length !== 1
                          }
                          onChange={(event) =>
                            setSelectedImports((previous) =>
                              event.target.checked
                                ? [...previous, skill.directory]
                                : previous.filter(
                                    (item) => item !== skill.directory,
                                  ),
                            )
                          }
                        />
                        <span>
                          {skill.name} · {skill.path} ·{" "}
                          {skill.foundIn.join(", ")}
                        </span>
                      </label>
                    ))}
                    <button
                      type="button"
                      disabled={selectedImports.length === 0}
                      onClick={() => {
                        const imports = selectedImports.map((directory) => ({
                          directory,
                          apps: {
                            claude: false,
                            codex: false,
                            gemini: false,
                            grokbuild: false,
                            opencode: false,
                            openclaw: false,
                            hermes: false,
                            [targetApp]: true,
                          },
                        }));
                        setConfirmation({
                          title: "确认纳管 Skills",
                          message: `将复制所选 ${imports.length} 个 Skill 到受管目录，并同步到 ${targetName}。请先备份同名目录；失败可能部分完成。`,
                          action: async () => {
                            await skillsApi.importFromApps(imports);
                            setSelectedImports([]);
                            setUnmanaged(await skillsApi.scanUnmanaged());
                          },
                        });
                      }}
                    >
                      纳管所选 Skills
                    </button>
                  </div>
                )}
                {updates !== null && (
                  <div className="skills-lifecycle-panel">
                    <h2>更新检查结果</h2>
                    <p role="note">
                      更新前会备份当前版本，并按原仓库路径匹配来源；来源不明确时不会更新。检查结果不代表所有仓库都已成功访问。
                    </p>
                    {updates.length === 0 ? (
                      <p>未报告可更新项目。</p>
                    ) : (
                      updates.map((update) => (
                        <div key={update.id} className="skills-lifecycle-row">
                          <span>{update.name} · 检测到更新</span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              setConfirmation({
                                title: "确认更新 Skill",
                                message: `更新 ${update.name} 将覆盖受管版本并同步到已启用的工具。当前版本会先备份，请确认已保存本地改动。`,
                                action: async () => {
                                  await skillsApi.updateSkill(update.id);
                                  setUpdates(
                                    (current) =>
                                      current?.filter(
                                        (item) => item.id !== update.id,
                                      ) ?? null,
                                  );
                                },
                              })
                            }
                          >
                            更新 {update.name}
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
                {backups !== null && (
                  <div className="skills-lifecycle-panel">
                    <h2>可恢复备份</h2>
                    {backups.length === 0 && <p>暂无可恢复备份。</p>}
                    {backups.map((backup) => (
                      <div
                        className="skills-lifecycle-row"
                        key={backup.backupId}
                      >
                        <span>
                          {backup.skill.name} ·{" "}
                          {new Date(backup.createdAt * 1000).toLocaleString()}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmation({
                              title: "恢复 Skill",
                              message: `恢复「${backup.skill.name}」并启用到 ${targetName}。请检查目标目录，避免与手工安装内容冲突。`,
                              action: async () => {
                                await skillsApi.restoreBackup(
                                  backup.backupId,
                                  targetApp,
                                );
                                setBackups(await skillsApi.getBackups());
                              },
                            })
                          }
                        >
                          恢复 {backup.skill.name}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmation({
                              title: "删除 Skill 备份",
                              message: `永久删除「${backup.skill.name}」的此份备份？删除后不能用它恢复。`,
                              action: async () => {
                                if (
                                  !(await skillsApi.deleteBackup(
                                    backup.backupId,
                                  ))
                                )
                                  throw new Error("delete rejected");
                                setBackups(await skillsApi.getBackups());
                              },
                            })
                          }
                        >
                          删除备份 {backup.skill.name}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {skills.length > 0 && (
                  <details className="skills-lifecycle-panel">
                    <summary>卸载已安装 Skill</summary>
                    <p>
                      卸载会影响所有已启用的工具；备份可从上方恢复入口查看。
                    </p>
                    {skills.map((skill) => (
                      <button
                        type="button"
                        key={skill.id}
                        onClick={() =>
                          setConfirmation({
                            title: "卸载 Skill",
                            message: `卸载「${skill.name}」，并从所有已启用它的工具中移除？此操作不限于 ${targetName}。`,
                            action: async () => {
                              await skillsApi.uninstallUnified(skill.id);
                              setBackups(await skillsApi.getBackups());
                            },
                          })
                        }
                      >
                        卸载 {skill.name}
                      </button>
                    ))}
                  </details>
                )}
              </fieldset>
            </section>
          )}
          {tab === "skills"
            ? /* Skills 列表 */
              skills.map((skill) => (
                <div
                  key={skill.id}
                  className="box-border w-full h-[52px] shrink-0 flex flex-row gap-[12px] px-[12px] justify-start items-center rounded-[4px] hover:bg-[var(--bg-subtle)] transition-colors"
                >
                  {/* 拨动开关 */}
                  <button
                    type="button"
                    role="switch"
                    aria-label={`启用 Skill ${skill.name}`}
                    aria-checked={skill.enabled}
                    onClick={() => handleToggleSkill(skill.id)}
                    className={`box-border w-[36px] shrink-0 h-[20px] flex items-center p-[4px] rounded-full border-none cursor-pointer transition-colors ${
                      skill.enabled
                        ? "bg-[var(--switch-on-bg)] justify-end"
                        : "bg-[var(--switch-off-bg)] ring-1 ring-inset ring-[var(--switch-off-border)] justify-start"
                    }`}
                  >
                    <div
                      className={`w-[12px] h-[12px] rounded-full ${skill.enabled ? "bg-[var(--switch-thumb-on)]" : "bg-[var(--switch-thumb-off)]"}`}
                    />
                  </button>

                  {/* 名称与来源 */}
                  <div className="box-border w-[184px] shrink-0 h-fit flex flex-col gap-[2px] justify-start items-start overflow-hidden">
                    <div className="text-[13px]/[18px] text-[var(--text-1)] font-['Overpass_Mono',system-ui,sans-serif] font-normal truncate">
                      {skill.name}
                    </div>
                    <div className="text-[13px]/[18px] text-[var(--text-3)] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal truncate">
                      {skill.source}
                    </div>
                  </div>

                  {/* 备注区（支持内联编辑） */}
                  <div className="box-border [flex:1_1_0] h-[28px] flex flex-row gap-[6px] px-[4px] justify-start items-center rounded-[4px] overflow-hidden">
                    {editingNoteId === skill.id ? (
                      <div className="flex items-center gap-2 w-full">
                        <input
                          aria-label="备注"
                          maxLength={1000}
                          type="text"
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          onKeyDown={(e) =>
                            e.key === "Enter" && handleSaveNote(skill.id, true)
                          }
                          className="box-border [flex:1_1_0] h-[28px] px-2 text-[13px]/[18px] border border-solid border-[#006AA0] rounded outline-none"
                          autoFocus
                        />
                        <button
                          type="button"
                          aria-label="保存备注"
                          onClick={() => handleSaveNote(skill.id, true)}
                          className="px-2 py-0.5 text-xs bg-[#006AA0] text-white rounded border-none cursor-pointer"
                        >
                          保存
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          handleStartEditNote(skill.id, skill.note || "")
                        }
                        className="flex items-center gap-[6px] border-none bg-transparent cursor-pointer p-0 text-left hover:text-[#006AA0]"
                      >
                        <NotePencil
                          size={14}
                          className="text-[var(--text-3)]"
                        />
                        <span className="text-[13px]/[18px] text-[var(--text-2)] font-['Noto_Sans_SC',system-ui,sans-serif] truncate">
                          {skill.note || "添加备注"}
                        </span>
                      </button>
                    )}
                  </div>

                  {/* 更多按钮 */}
                  <button
                    type="button"
                    aria-label={`查看 Skill ${skill.name} 的安装位置`}
                    onClick={() => toast.info(skill.directory)}
                    className="box-border w-[28px] shrink-0 h-[28px] flex justify-center items-center rounded-[4px] border-none bg-transparent hover:bg-[var(--bg-selected)] text-[var(--text-2)] cursor-pointer"
                  >
                    <DotsThree size={18} />
                  </button>
                </div>
              ))
            : /* MCP 列表 */
              mcps.map((mcp) => {
                const isSelected = selectedMcp?.id === mcp.id;

                return (
                  <div
                    key={mcp.id}
                    className={`box-border w-full h-[52px] shrink-0 flex flex-row gap-[12px] px-[12px] justify-start items-center rounded-[4px] transition-colors cursor-pointer ${
                      isSelected
                        ? "bg-[var(--bg-selected)] border-l-[3px] border-solid border-[var(--brand)]"
                        : "hover:bg-[var(--bg-subtle)]"
                    }`}
                  >
                    {/* 开关 */}
                    <button
                      type="button"
                      role="switch"
                      aria-label={`启用 MCP ${mcp.name}`}
                      aria-checked={mcp.enabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleMcp(mcp.id);
                      }}
                      className={`box-border w-[36px] shrink-0 h-[20px] flex items-center p-[4px] rounded-full border-none cursor-pointer transition-colors ${
                        mcp.enabled
                          ? "bg-[var(--switch-on-bg)] justify-end"
                          : "bg-[var(--switch-off-bg)] ring-1 ring-inset ring-[var(--switch-off-border)] justify-start"
                      }`}
                    >
                      <div
                        className={`w-[12px] h-[12px] rounded-full ${mcp.enabled ? "bg-[var(--switch-thumb-on)]" : "bg-[var(--switch-thumb-off)]"}`}
                      />
                    </button>

                    {/* 名称区：键盘也可打开详情 */}
                    <button
                      type="button"
                      aria-label={`查看 MCP ${mcp.name}`}
                      aria-expanded={isSelected}
                      aria-controls={isSelected ? "mcp-details" : undefined}
                      onClick={() => setSelectedMcp(mcp)}
                      className="box-border w-[184px] shrink-0 h-fit flex flex-col gap-[2px] justify-start items-start overflow-hidden border-0 bg-transparent p-0 text-left"
                    >
                      <div className="text-[13px]/[18px] text-[var(--text-1)] font-['Overpass_Mono',system-ui,sans-serif] font-normal truncate">
                        {mcp.name}
                      </div>
                      <div className="text-[13px]/[18px] text-[var(--text-3)] font-['Overpass_Mono',system-ui,sans-serif] font-normal truncate">
                        {mcp.sourceCommand}
                      </div>
                    </button>

                    {/* 备注区 */}
                    <div className="box-border [flex:1_1_0] h-[28px] flex flex-row gap-[6px] px-[4px] justify-start items-center rounded-[4px] overflow-hidden">
                      {editingNoteId === mcp.id ? (
                        <div
                          className="flex items-center gap-2 w-full"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            aria-label="备注"
                            maxLength={1000}
                            type="text"
                            value={noteText}
                            onChange={(e) => setNoteText(e.target.value)}
                            onKeyDown={(e) =>
                              e.key === "Enter" && handleSaveNote(mcp.id, false)
                            }
                            className="box-border [flex:1_1_0] h-[28px] px-2 text-[13px]/[18px] border border-solid border-[#006AA0] rounded outline-none"
                            autoFocus
                          />
                          <button
                            type="button"
                            aria-label="保存备注"
                            onClick={() => handleSaveNote(mcp.id, false)}
                            className="px-2 py-0.5 text-xs bg-[#006AA0] text-white rounded border-none cursor-pointer"
                          >
                            保存
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartEditNote(mcp.id, mcp.note || "");
                          }}
                          className="flex items-center gap-[6px] border-none bg-transparent cursor-pointer p-0 text-left hover:text-[#006AA0]"
                        >
                          <NotePencil
                            size={14}
                            className="text-[var(--text-3)]"
                          />
                          <span className="text-[13px]/[18px] text-[var(--text-2)] font-['Noto_Sans_SC',system-ui,sans-serif] truncate">
                            {mcp.note || "添加备注"}
                          </span>
                        </button>
                      )}
                    </div>

                    {/* 更多 */}
                    <button
                      type="button"
                      aria-label={`MCP ${mcp.name} 的详情和操作`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedMcp(mcp);
                      }}
                      className="box-border w-[28px] shrink-0 h-[28px] flex justify-center items-center rounded-[4px] border-none bg-transparent hover:bg-[var(--bg-selected)] text-[var(--text-2)] cursor-pointer"
                    >
                      <DotsThree size={18} />
                    </button>
                  </div>
                );
              })}
        </div>

        {/* 右侧面板：根据 Tab 展现安装抽屉或 MCP 详情抽屉 */}
        {tab === "skills"
          ? installDrawerOpen && (
              <div
                ref={installPanelRef}
                id="skills-install-panel"
                tabIndex={-1}
                role="region"
                aria-label="安装 Skill"
                className="skills-mcp-panel skills-install-panel box-border w-[380px] min-h-full shrink-0 flex flex-col gap-[12px] pl-[24px] border-l border-solid border-[var(--border-subtle)]"
              >
                <div className="flex justify-between items-center w-full">
                  <strong>安装 Skill</strong>
                  <button
                    type="button"
                    aria-label="关闭安装"
                    className="skills-install-close"
                    onClick={() => setInstallDrawerOpen(false)}
                  >
                    <X size={14} />
                  </button>
                </div>
                <p>安装后启用到 {targetName}，其他工具不受影响。</p>
                <div className="skills-install-section">
                  <h3>从仓库</h3>
                  <p>读取「管理仓库」中添加的 Git 仓库，列出可安装的 Skill。</p>
                  <button
                    type="button"
                    className="skills-install-action"
                    onClick={() =>
                      void run(async () =>
                        setAvailable(await skillsApi.discoverAvailable()),
                      )
                    }
                  >
                    读取已配置仓库
                  </button>
                  {available?.length === 0 && (
                    <p role="status">
                      没有读取到可安装的
                      Skill。请先在「管理仓库」中添加仓库，再重新读取。
                    </p>
                  )}
                  {available?.map((skill) => (
                    <div key={skill.key} className="skills-install-result">
                      <span>{skill.name}</span>
                      <button
                        type="button"
                        className="skills-install-action"
                        onClick={() =>
                          void run(() =>
                            skillsApi.installUnified(skill, targetApp),
                          )
                        }
                      >
                        安装 {skill.name}
                      </button>
                    </div>
                  ))}
                </div>
                <div className="skills-install-section">
                  <h3>从 ZIP 文件</h3>
                  <button
                    type="button"
                    className="skills-install-action"
                    onClick={installFromZip}
                  >
                    从 ZIP 安装…
                  </button>
                </div>
              </div>
            )
          : /* MCP 详情面板 (1:1 落地) */
            selectedMcp && (
              <div
                id="mcp-details"
                role="region"
                aria-label="MCP 详情"
                className="skills-mcp-panel box-border w-[380px] min-h-full shrink-0 flex flex-col gap-[16px] pl-[24px] justify-start items-start border-l border-solid border-[var(--border-subtle)]"
              >
                {/* 标题 */}
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] justify-start items-start">
                  <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[8px] justify-start items-center">
                    <div className="text-[15px]/[21px] [flex:1_1_0] text-[var(--text-1)] font-['Overpass_Mono',system-ui,sans-serif] font-bold text-left">
                      {selectedMcp.name}
                    </div>
                    <button
                      type="button"
                      aria-label="关闭 MCP 详情"
                      onClick={() => setSelectedMcp(null)}
                      className="box-border w-[28px] shrink-0 h-[28px] flex justify-center items-center rounded-[4px] border-none bg-transparent hover:bg-[var(--bg-selected)] text-[var(--text-2)] cursor-pointer"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div className="text-[13px]/[18px] text-[var(--text-3)] font-['Noto_Sans_SC',system-ui,sans-serif]">
                    {selectedMcp.enabled ? "已启用" : "未启用"} ·{" "}
                    {selectedMcp.sourceCommand} · 新会话加载
                  </div>
                </div>

                {/* 启动命令 */}
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] justify-start items-start">
                  <div className="text-[13px]/[18px] text-[var(--text-2)] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                    {selectedMcp.remote ? "远程连接" : "启动命令"}
                  </div>
                  <div className="box-border w-full h-fit flex flex-row gap-[8px] justify-start items-start text-[13px]/[18px]">
                    <div className="w-[64px] shrink-0 text-[var(--text-3)] font-['Overpass_Mono',system-ui,sans-serif]">
                      {selectedMcp.remote ? "url" : "command"}
                    </div>
                    <div className="[flex:1_1_0] text-[var(--text-1)] font-['Overpass_Mono',system-ui,sans-serif]">
                      在编辑器中查看
                    </div>
                  </div>
                  <div className="box-border w-full h-fit flex flex-row gap-[8px] justify-start items-start text-[13px]/[18px]">
                    <div className="w-[64px] shrink-0 text-[var(--text-3)] font-['Overpass_Mono',system-ui,sans-serif]">
                      {selectedMcp.remote ? "headers" : "args"}
                    </div>
                    <div className="[flex:1_1_0] flex flex-col gap-[2px] text-[var(--text-1)] font-['Overpass_Mono',system-ui,sans-serif]">
                      {selectedMcp.remote
                        ? "连接地址与请求头可能包含凭据；请通过编辑器查看。"
                        : "参数不在此显示，避免泄露命令行中的凭据；请通过编辑器查看。"}
                    </div>
                  </div>
                </div>

                {/* 环境变量（脱敏） */}
                {selectedMcp.envMasked && (
                  <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] justify-start items-start">
                    <div className="text-[13px]/[18px] text-[var(--text-2)] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                      环境变量 ·{" "}
                      {Object.keys(selectedMcp.server.env || {}).length} 个
                    </div>
                    <div className="text-[13px]/[18px] text-[var(--text-2)] font-['Overpass_Mono',system-ui,sans-serif]">
                      {selectedMcp.envMasked.key}
                    </div>
                    <div className="box-border w-full h-fit flex flex-row gap-[8px] justify-start items-center">
                      <div className="box-border [flex:1_1_0] h-[32px] flex items-center px-[10px] bg-[var(--bg-selected)] rounded-[4px] text-[13px]/[18px] text-[var(--text-1)] font-['Overpass_Mono',system-ui,sans-serif]">
                        {selectedMcp.envMasked.maskedValue}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setEditing(
                            servers.find((s) => s.id === selectedMcp.id) ||
                              null,
                          )
                        }
                        className="box-border w-fit shrink-0 h-[28px] px-[12px] flex justify-center items-center bg-[var(--bg-surface)] outline outline-1 outline-[var(--border-control)] -outline-offset-[0.5px] rounded-[4px] border-none cursor-pointer text-[var(--text-1)] text-[13px]/[18px] hover:bg-[var(--bg-subtle)]"
                      >
                        替换…
                      </button>
                    </div>
                    <div className="text-[13px]/[18px] text-[var(--text-3)] font-['Noto_Sans_SC',system-ui,sans-serif]">
                      环境变量值不在此详情面板显示
                    </div>
                  </div>
                )}

                {/* 备注 */}
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] justify-start items-start">
                  <div className="text-[13px]/[18px] text-[var(--text-2)] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                    备注
                  </div>
                  <div className="box-border w-full h-fit flex flex-row gap-[6px] justify-start items-center text-[13px]/[18px] text-[var(--text-2)]">
                    <NotePencil size={14} className="text-[var(--text-3)]" />
                    <span>{selectedMcp.note}</span>
                  </div>
                </div>

                {/* 写入预告 */}
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] justify-start items-start">
                  <div className="text-[13px]/[18px] text-[var(--text-2)] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                    写入预告
                  </div>
                  <div className="box-border w-full h-fit flex flex-row gap-[8px] justify-start items-start text-[13px]/[18px]">
                    <div className="w-[64px] shrink-0 text-[var(--text-3)] font-['Noto_Sans_SC',system-ui,sans-serif]">
                      写入
                    </div>
                    <div className="[flex:1_1_0] flex flex-col gap-[2px] text-[var(--text-1)] font-['Overpass_Mono',system-ui,sans-serif]">
                      <div>{targetName} 的 MCP 配置</div>
                      <div>{selectedMcp.id}</div>
                    </div>
                  </div>
                  <div className="text-[13px]/[18px] text-[var(--text-3)] font-['Noto_Sans_SC',system-ui,sans-serif]">
                    按目标工具的实际配置目录同步；保留非本应用管理的服务
                  </div>
                </div>

                <div className="[flex:1_1_0]" />

                {/* 底部操作 */}
                <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[8px] justify-end items-center pt-[12px]">
                  <button
                    type="button"
                    onClick={() => setRemoving(selectedMcp)}
                    className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center rounded-[4px] border-none bg-transparent hover:bg-[var(--bg-subtle)] cursor-pointer text-[var(--text-1)] text-[14px]/[20px]"
                  >
                    <Trash size={16} />
                    <span>移除…</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setEditing(
                        servers.find((s) => s.id === selectedMcp.id) || null,
                      )
                    }
                    className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[var(--bg-surface)] outline outline-1 outline-[var(--border-control)] -outline-offset-[0.5px] rounded-[4px] border-none cursor-pointer text-[var(--text-1)] text-[14px]/[20px] hover:bg-[var(--bg-subtle)]"
                  >
                    <PencilSimple size={16} />
                    <span>编辑</span>
                  </button>
                </div>
              </div>
            )}
      </fieldset>
      <ConfirmDialog
        isOpen={removing !== null}
        title="移除 MCP"
        message={`移除 MCP「${removing?.name || ""}」？此操作会同步其已启用的工具。`}
        confirmText="确认移除"
        cancelText="取消"
        onCancel={() => {
          if (!busyRef.current) setRemoving(null);
        }}
        onConfirm={() => {
          if (!removing) return;
          void run(async () => {
            if (!(await mcpApi.deleteUnifiedServer(removing.id)))
              throw new Error("not found");
            setRemoving(null);
            setSelectedId(null);
          });
        }}
      />
      {editing && (
        <Suspense fallback={<p role="status">正在加载编辑器…</p>}>
          <McpFormModal
            editingId={editing === "new" ? undefined : editing.id}
            initialData={editing === "new" ? undefined : editing}
            existingIds={servers.map((s) => s.id)}
            defaultFormat={
              targetApp === "codex" || targetApp === "grokbuild"
                ? "toml"
                : "json"
            }
            defaultEnabledApps={[targetApp]}
            visibleApps={MCP_APPS}
            onClose={() => setEditing(null)}
            onSave={async () => {
              setEditing(null);
              await reload();
            }}
          />
        </Suspense>
      )}
    </div>
  );
};
