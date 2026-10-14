import React, { useState } from "react";
import {
  Share2 as Export,
  Plus,
  ShieldCheck,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HelpTip } from "@/components/ui/help-tip";
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
] as const;
type ResourceApp = (typeof RESOURCE_TOOLS)[number]["id"];
const MCP_APPS = RESOURCE_TOOLS.map((tool) => tool.id);

/** Where the local scan found a Skill, in words a user recognises. */
const SOURCE_LABELS: Record<string, string> = {
  ...Object.fromEntries(RESOURCE_TOOLS.map((tool) => [tool.id, tool.name])),
  "claude-desktop": "Claude Desktop",
  pi: "Pi",
  agents: "通用目录 .agents",
  "cc-switch": "Chimera++ 共享目录",
};
const sourceLabel = (id: string) => SOURCE_LABELS[id] ?? id;

/** Names of the tools a resource is currently registered with. */
const enabledToolNames = (
  apps: Partial<Record<ResourceApp, boolean | undefined>>,
) => RESOURCE_TOOLS.filter((tool) => apps[tool.id]).map((tool) => tool.name);

/** The folder name a repository Skill installs into, as the backend derives it. */
const installFolder = (directory: string) =>
  directory.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? "";

interface Confirmation {
  title: string;
  message: string;
  confirmText: string;
  destructive: boolean;
  action: () => Promise<unknown>;
}

interface Notice {
  message: string;
  actionLabel: string;
  onAction: () => void;
}

export const SkillsMcpView: React.FC<{
  initialApp?: AppId;
  refreshVersion?: number;
}> = ({ initialApp = "codex", refreshVersion = 0 }) => {
  const [targetApp, setTargetApp] = useState<ResourceApp>(
    () => RESOURCE_TOOLS.find((tool) => tool.id === initialApp)?.id || "codex",
  );
  const targetName = RESOURCE_TOOLS.find((tool) => tool.id === targetApp)!.name;
  const [tab, setTab] = useState<"skills" | "mcp">("skills");
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [skillNotes, setSkillNotes] = useState<Record<string, string>>({});
  const [mcpNotes, setMcpNotes] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installDrawerOpen, setInstallDrawerOpen] = useState(false);
  const installPanelRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  // null until the configured repositories have been read, so an empty read
  // can say so instead of leaving the panel silently blank.
  const [available, setAvailable] = useState<DiscoverableSkill[] | null>(null);
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const [removing, setRemoving] = useState<McpServer | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [loading, setLoading] = useState(true);
  // True only while the rows on screen come from a successful read; counts,
  // the summary card and empty states never speak for data we do not have.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repos, setRepos] = useState<SkillRepo[] | null>(null);
  const [unmanaged, setUnmanaged] = useState<UnmanagedSkill[] | null>(null);
  const [scanning, setScanning] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanGeneration = useRef(0);
  const [selectedImports, setSelectedImports] = useState<string[]>([]);
  const [backups, setBackups] = useState<SkillBackupEntry[] | null>(null);
  const [updates, setUpdates] = useState<SkillUpdateInfo[] | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
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
        setError("Skills 与 MCP 列表读取失败，请稍后重试。");
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
  const scanSkills = useCallback(async () => {
    const request = ++scanGeneration.current;
    setScanning(true);
    setScanError(null);
    try {
      const found = await skillsApi.scanUnmanaged();
      if (request !== scanGeneration.current) return;
      if (!Array.isArray(found))
        throw new Error("Invalid Skills scan response");
      setUnmanaged(found);
      setSelectedImports((previous) =>
        previous.filter(
          (directory) =>
            found.filter((skill) => skill.directory === directory).length === 1,
        ),
      );
    } catch {
      if (request === scanGeneration.current)
        setScanError("扫描失败，请检查目录访问权限后重试。");
    } finally {
      if (request === scanGeneration.current) setScanning(false);
    }
  }, []);
  useEffect(() => {
    void scanSkills();
    return () => {
      scanGeneration.current++;
    };
  }, [scanSkills, refreshVersion]);
  useEffect(() => {
    // In the narrow layout the panel opens below the fold; moving focus into
    // it also scrolls it into view, so the click visibly does something.
    if (installDrawerOpen) installPanelRef.current?.focus();
  }, [installDrawerOpen]);
  useEffect(() => {
    // Below 1100px the details stack under the list; bring them into view.
    if (selectedId) detailsRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  const lock = () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    return true;
  };
  const unlock = () => {
    busyRef.current = false;
    setBusy(false);
  };
  /** Writes: on failure the files may be half-written, so re-read the truth. */
  const run = async (action: () => Promise<unknown>) => {
    if (!lock()) return false;
    try {
      await action();
      await reload();
      return true;
    } catch {
      setNotice({
        message: "操作失败，可能部分完成。请重新读取列表并检查目标工具后重试。",
        actionLabel: "重新读取",
        onAction: () => {
          setNotice(null);
          void reload();
        },
      });
      toast.error("操作失败，请重试。未确认配置已更新。");
      return false;
    } finally {
      unlock();
    }
  };
  /** Reads change nothing on disk; a failure only needs another attempt. */
  const read = async (failure: string, action: () => Promise<unknown>) => {
    if (!lock()) return false;
    try {
      await action();
      return true;
    } catch {
      setNotice({
        message: failure,
        actionLabel: "重试",
        onAction: () => void read(failure, action),
      });
      toast.error(failure);
      return false;
    } finally {
      unlock();
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
    if (server)
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
  const noteKeys =
    (id: string, isSkill: boolean) =>
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") handleSaveNote(id, isSkill);
      if (event.key === "Escape") setEditingNoteId(null);
    };
  const enabledSkillsCount = skills.filter((s) => s.enabled).length;
  const enabledMcpCount = mcps.filter((s) => s.enabled).length;
  const hasCurrentRows =
    loaded && (tab === "skills" ? skills.length > 0 : mcps.length > 0);
  // The backend only checks Skills that were installed from a repository.
  const hasRepoSkills = installed.some(
    (skill) => skill.repoOwner && skill.repoName,
  );
  const installedByFolder = new Map(
    installed.map((skill) => [skill.directory.toLowerCase(), skill]),
  );
  const enabledRepoCount = repos?.filter((repo) => repo.enabled).length ?? 0;
  const installFromZip = () =>
    void run(async () => {
      const path = await skillsApi.openZipFileDialog();
      if (path) await skillsApi.installFromZip(path, targetApp);
    });
  const openRepos = () =>
    void read("无法读取仓库列表，请稍后重试。", async () => {
      setRepos((await skillsApi.getRepos()) ?? []);
      setRepoOpen(true);
    });
  const discoverFromRepos = () =>
    void read("无法读取仓库中的 Skill，请检查网络后重试。", async () => {
      const [found, configured] = await Promise.all([
        skillsApi.discoverAvailable(),
        skillsApi.getRepos(),
      ]);
      setRepos(configured ?? []);
      setAvailable(found);
    });
  const askUninstall = (skill: InstalledSkill) => {
    const tools = enabledToolNames(skill.apps);
    setConfirmation({
      title: "卸载 Skill",
      message: `将卸载「${skill.name}」${
        tools.length
          ? `，并从 ${tools.join("、")} 中移除`
          : "（目前没有在任何工具中启用）"
      }。卸载前会自动备份，可在「查看可恢复备份」中恢复。`,
      confirmText: "卸载",
      destructive: true,
      action: async () => {
        await skillsApi.uninstallUnified(skill.id);
        // Show the fresh backup right away: it is the way back.
        setBackups(await skillsApi.getBackups());
      },
    });
  };
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
  const removingTools = removing ? enabledToolNames(removing.apps) : [];
  return (
    <div className="skills-mcp-page connected-page text-[var(--text-1)] min-h-full box-border w-full flex flex-col gap-[12px] p-[12px_24px] justify-start items-start bg-[var(--bg-surface)] min-h-0">
      {/* 页头 */}
      <div data-pencil-name="页头" className="skills-mcp-header">
        <div className="box-border [flex:1_1_0] h-fit flex flex-col gap-[2px] justify-start items-start">
          <h1 className="m-0 text-left text-[var(--text-1)]">
            {targetName} · Skills 与 MCP
          </h1>
          <div className="skills-mcp-subtitle">
            Skills 与 MCP 在各工具间共享；下方开关只改变所选工具。
          </div>
        </div>
        <div className="box-border w-fit shrink-0 h-fit flex flex-row gap-[8px] justify-start items-center">
          <button
            type="button"
            disabled={loading || !loaded}
            onClick={exportSafeConfiguration}
            aria-describedby="mcp-export-scope"
            title={`导出全部工具的共享资源与启用状态。${MCP_EXPORT_NOTICE}`}
            className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[var(--bg-surface)] outline outline-1 outline-[var(--border-control)] -outline-offset-[0.5px] rounded-[4px] border-none cursor-pointer text-[var(--text-1)] hover:bg-[var(--bg-subtle)] transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
          >
            <Export size={16} aria-hidden="true" />
            <span className="text-[14px]/[20px] font-normal whitespace-nowrap">
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
              className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[var(--btn-primary-bg)] hover:bg-[var(--btn-primary-bg-hover)] active:bg-[var(--btn-primary-bg-pressed)] transition-colors rounded-[4px] border-none cursor-pointer text-[var(--btn-primary-fg)]"
            >
              <Plus size={16} strokeWidth={2.5} aria-hidden="true" />
              <span className="text-[14px]/[20px] font-normal whitespace-nowrap">
                {tab === "skills" ? "安装" : "添加 MCP"}
              </span>
            </button>
          )}
        </div>
      </div>

      <label className="skills-mcp-target">
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
          }}
          className="bg-[var(--input-bg)] text-[var(--text-1)] rounded-[4px]"
        >
          {RESOURCE_TOOLS.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.name}
            </option>
          ))}
        </select>
      </label>

      <div className="skills-mcp-tabs">
        <button
          type="button"
          disabled={busy || confirmation !== null || repoOpen}
          aria-pressed={tab === "skills"}
          onClick={() => {
            if (tab !== "skills") setEditingNoteId(null);
            setTab("skills");
          }}
          className={`box-border h-[35px] flex flex-row gap-[6px] px-[2px] justify-start items-center border-none bg-transparent cursor-pointer ${
            tab === "skills"
              ? "border-b-2 border-solid border-[var(--brand-text)] text-[var(--text-1)] font-bold"
              : "text-[var(--text-2)] font-normal hover:text-[var(--text-1)]"
          }`}
        >
          <span className="text-[14px]/[20px] whitespace-nowrap">Skills</span>
          {loaded && (
            <span className="text-[13px]/[18px] text-[var(--text-3)] whitespace-nowrap">
              {skills.length}
            </span>
          )}
        </button>

        <button
          type="button"
          disabled={busy}
          aria-pressed={tab === "mcp"}
          onClick={() => {
            if (tab !== "mcp") setEditingNoteId(null);
            setTab("mcp");
          }}
          className={`box-border h-[35px] flex flex-row gap-[6px] px-[2px] justify-start items-center border-none bg-transparent cursor-pointer ${
            tab === "mcp"
              ? "border-b-2 border-solid border-[var(--brand-text)] text-[var(--text-1)] font-bold"
              : "text-[var(--text-2)] font-normal hover:text-[var(--text-1)]"
          }`}
        >
          <span className="text-[14px]/[20px] whitespace-nowrap">MCP</span>
          {loaded && (
            <span className="text-[13px]/[18px] text-[var(--text-3)] whitespace-nowrap">
              {mcps.length}
            </span>
          )}
        </button>

        <div className="[flex:1_1_0]" />

        {/* 简短隐私提示，完整导出说明见按钮 title。 */}
        <div className="box-border min-w-0 max-w-[520px] py-[4px] flex flex-row gap-[6px] justify-start items-center">
          <ShieldCheck
            size={14}
            className="shrink-0 text-[var(--text-3)]"
            aria-hidden="true"
          />
          <span
            id="mcp-export-scope"
            className="text-[13px]/[18px] text-[var(--text-3)]"
          >
            导出前请检查敏感信息
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
      {notice && (
        <div role="alert" className="skills-mcp-notice">
          <span>{notice.message}</span>
          <button
            type="button"
            className="skills-mcp-notice-action"
            disabled={busy || loading}
            onClick={notice.onAction}
          >
            {notice.actionLabel}
          </button>
        </div>
      )}

      {hasCurrentRows && (
        <section
          className="skills-mcp-summary"
          aria-label={`${targetName} 资源概览`}
        >
          <div>
            <span>{tab === "skills" ? "已启用 Skills" : "已启用 MCP"}</span>
            <strong>
              {tab === "skills"
                ? `${enabledSkillsCount} / ${skills.length}`
                : `${enabledMcpCount} / ${mcps.length}`}
            </strong>
          </div>
          <p>
            <b>{targetName}</b>
            <span>新会话加载已启用的资源</span>
          </p>
          <span className="skills-mcp-summary-related">
            {tab === "skills"
              ? `另有 ${mcps.length} 个 MCP 服务`
              : `另有 ${skills.length} 个 Skill`}
          </span>
          <HelpTip
            title={tab === "skills" ? "Skills 如何生效" : "MCP 如何生效"}
            align="end"
            className="skills-mcp-help"
          >
            {tab === "skills"
              ? `Skills 存放在 Chimera++ 的共享目录；启用后同步到 ${targetName} 的 Skills 目录，新会话开始时加载。`
              : `MCP 服务写入 ${targetName} 自己的配置；关闭开关后它不再加载这一项，其他工具不受影响。`}
          </HelpTip>
        </section>
      )}

      {repoOpen && (
        <Suspense fallback={<p role="status">正在加载仓库管理…</p>}>
          <RepoManagerPanel
            repos={repos ?? []}
            skills={available}
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
                message: `不再从 ${owner}/${name} 发现 Skill？已安装的 Skills 不会卸载。`,
                confirmText: "移除仓库",
                destructive: true,
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
        confirmText={confirmation?.confirmText ?? "确认"}
        cancelText="取消"
        variant={confirmation?.destructive === false ? "info" : "destructive"}
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
              <p>为 {targetName} 添加技能，新会话即可使用。</p>
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
                  <button type="button" onClick={openRepos}>
                    管理仓库
                  </button>
                  <button
                    type="button"
                    disabled={scanning}
                    onClick={() => void scanSkills()}
                  >
                    {scanning
                      ? "正在扫描…"
                      : scanError
                        ? "重试扫描"
                        : "刷新扫描"}
                  </button>
                  {hasRepoSkills && (
                    <button
                      type="button"
                      onClick={() =>
                        void read(
                          "检查更新失败，请检查网络后重试。",
                          async () => {
                            setUpdates(null);
                            setUpdates(await skillsApi.checkUpdates());
                          },
                        )
                      }
                    >
                      检查 Skills 更新
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void read("无法读取备份列表，请稍后重试。", async () => {
                        setBackups(null);
                        setBackups(await skillsApi.getBackups());
                      })
                    }
                  >
                    查看可恢复备份
                  </button>
                </div>
                {updates !== null && (
                  <div className="skills-lifecycle-panel">
                    <div className="skills-panel-heading">
                      <h2>更新检查结果</h2>
                      <button
                        type="button"
                        className="skills-install-close"
                        aria-label="关闭更新检查结果"
                        onClick={() => setUpdates(null)}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
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
                                message: `更新 ${update.name} 将覆盖已安装版本并同步到已启用的工具。当前版本会先备份，请确认已保存本地改动。`,
                                confirmText: "更新",
                                destructive: false,
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
                    <div className="skills-panel-heading">
                      <h2>可恢复备份</h2>
                      <button
                        type="button"
                        className="skills-install-close"
                        aria-label="关闭可恢复备份"
                        onClick={() => setBackups(null)}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                    {backups.length === 0 && <p>暂无可恢复备份。</p>}
                    {backups.map((backup) => (
                      <div
                        className="skills-lifecycle-row"
                        key={backup.backupId}
                      >
                        <span>
                          {backup.skill.name} ·{" "}
                          {new Date(backup.createdAt * 1000).toLocaleString(
                            "zh-CN",
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmation({
                              title: "恢复 Skill",
                              message: `恢复「${backup.skill.name}」并启用到 ${targetName}。请检查目标目录，避免与手工安装内容冲突。`,
                              confirmText: "恢复",
                              destructive: false,
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
                              confirmText: "删除备份",
                              destructive: true,
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
                    <div
                      className="max-w-full text-[13px]/[18px] text-[var(--text-1)] font-['Overpass_Mono',system-ui,sans-serif] font-normal truncate"
                      title={skill.name}
                    >
                      {skill.name}
                    </div>
                    <div
                      className="max-w-full text-[13px]/[18px] text-[var(--text-3)] font-normal truncate"
                      title={skill.source}
                    >
                      {skill.source}
                    </div>
                  </div>

                  {/* 备注区（支持内联编辑） */}
                  <div className="box-border [flex:1_1_0] min-w-0 h-[28px] flex flex-row gap-[6px] px-[4px] justify-start items-center rounded-[4px] overflow-hidden">
                    {editingNoteId === skill.id ? (
                      <div className="flex items-center gap-2 w-full">
                        <input
                          aria-label="备注"
                          maxLength={1000}
                          type="text"
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          onKeyDown={noteKeys(skill.id, true)}
                          className="skills-note-input"
                          autoFocus
                        />
                        <button
                          type="button"
                          aria-label="保存备注"
                          onClick={() => handleSaveNote(skill.id, true)}
                          className="skills-note-save"
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
                        title={skill.note || undefined}
                        className="flex min-w-0 items-center gap-[6px] border-none bg-transparent cursor-pointer p-0 text-left hover:text-[var(--brand-text)]"
                      >
                        <NotePencil
                          size={14}
                          className="shrink-0 text-[var(--text-3)]"
                          aria-hidden="true"
                        />
                        <span className="text-[13px]/[18px] text-[var(--text-2)] truncate">
                          {skill.note || "添加备注"}
                        </span>
                      </button>
                    )}
                  </div>

                  {/* 更多：说明与卸载 */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Skill ${skill.name} 的更多操作`}
                        className="box-border w-[28px] shrink-0 h-[28px] flex justify-center items-center rounded-[4px] border-none bg-transparent hover:bg-[var(--bg-selected)] text-[var(--text-2)] cursor-pointer"
                      >
                        <DotsThree size={18} aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="skills-row-menu"
                    >
                      <DropdownMenuLabel className="skills-row-menu-info">
                        <span>{skill.name}</span>
                        {skill.description && (
                          <small>{skill.description}</small>
                        )}
                        <small>
                          文件夹 {skill.directory} · 安装于{" "}
                          {new Date(
                            skill.installedAt * 1000,
                          ).toLocaleDateString("zh-CN")}
                        </small>
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="skills-row-menu-danger"
                        onSelect={() => askUninstall(skill)}
                      >
                        <Trash size={15} aria-hidden="true" />
                        卸载…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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
                      title={mcp.name}
                      className="box-border w-[184px] shrink-0 h-fit flex flex-col gap-[2px] justify-start items-start overflow-hidden border-0 bg-transparent p-0 text-left"
                    >
                      <div className="max-w-full text-[13px]/[18px] text-[var(--text-1)] font-['Overpass_Mono',system-ui,sans-serif] font-normal truncate">
                        {mcp.name}
                      </div>
                      <div className="text-[13px]/[18px] text-[var(--text-3)] font-['Overpass_Mono',system-ui,sans-serif] font-normal truncate">
                        {mcp.sourceCommand}
                      </div>
                    </button>

                    {/* 备注区 */}
                    <div className="box-border [flex:1_1_0] min-w-0 h-[28px] flex flex-row gap-[6px] px-[4px] justify-start items-center rounded-[4px] overflow-hidden">
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
                            onKeyDown={noteKeys(mcp.id, false)}
                            className="skills-note-input"
                            autoFocus
                          />
                          <button
                            type="button"
                            aria-label="保存备注"
                            onClick={() => handleSaveNote(mcp.id, false)}
                            className="skills-note-save"
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
                          title={mcp.note || undefined}
                          className="flex min-w-0 items-center gap-[6px] border-none bg-transparent cursor-pointer p-0 text-left hover:text-[var(--brand-text)]"
                        >
                          <NotePencil
                            size={14}
                            className="shrink-0 text-[var(--text-3)]"
                            aria-hidden="true"
                          />
                          <span className="text-[13px]/[18px] text-[var(--text-2)] truncate">
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
                      <DotsThree size={18} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
          {loaded &&
            tab === "skills" &&
            (scanning || scanError || unmanaged !== null) && (
              <section
                className="skills-discovery"
                aria-label="本机发现的 Skills"
              >
                <fieldset
                  disabled={
                    busy ||
                    loading ||
                    !!error ||
                    confirmation !== null ||
                    repoOpen
                  }
                >
                  <div
                    className="skills-lifecycle-panel skills-scan-panel"
                    role="region"
                    aria-label="本地 Skills 扫描"
                    aria-busy={scanning}
                  >
                    <div className="skills-scan-heading">
                      <h2>本机发现的 Skills</h2>
                      {!scanning && !scanError && unmanaged !== null && (
                        <span>
                          {unmanaged.length} 个发现 · 已选{" "}
                          {selectedImports.length} 个
                        </span>
                      )}
                    </div>
                    <p>
                      扫描只读取文件，不会修改。确认后添加到共享资源库，并启用到{" "}
                      {targetName}。
                    </p>
                    {scanning && (
                      <p role="status">
                        {unmanaged === null
                          ? "正在发现本地 Skills…"
                          : "正在刷新，以下为上次扫描结果。"}
                      </p>
                    )}
                    {scanError && (
                      <p role="alert">
                        {scanError}
                        {unmanaged !== null &&
                          " 以下为上次扫描结果，暂不可添加。"}
                      </p>
                    )}
                    {!scanning && !scanError && unmanaged?.length === 0 && (
                      <p>未发现可添加的本地 Skills。</p>
                    )}
                    {unmanaged?.map((skill, index) => {
                      const ambiguous =
                        unmanaged.filter(
                          (item) => item.directory === skill.directory,
                        ).length !== 1;
                      return (
                        <label
                          className="skills-lifecycle-row skills-scan-row"
                          data-selected={selectedImports.includes(
                            skill.directory,
                          )}
                          key={`${skill.directory}-${index}`}
                        >
                          <input
                            type="checkbox"
                            aria-label={`添加 ${skill.name}`}
                            checked={selectedImports.includes(skill.directory)}
                            disabled={scanning || !!scanError || ambiguous}
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
                          <span className="skills-scan-details">
                            <strong>{skill.name}</strong>
                            <span
                              className="skills-scan-path"
                              title={skill.path}
                            >
                              {skill.path}
                            </span>
                            <span className="skills-scan-source">
                              来源：{skill.foundIn.map(sourceLabel).join("、")}
                            </span>
                            {ambiguous && (
                              <span className="skills-scan-warning">
                                目录名重复，请先整理来源。
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    <button
                      type="button"
                      disabled={
                        scanning || !!scanError || selectedImports.length === 0
                      }
                      onClick={() => {
                        const imports = selectedImports.map((directory) => ({
                          directory,
                          apps: {
                            claude: false,
                            codex: false,
                            gemini: false,
                            grokbuild: false,
                            opencode: false,
                            [targetApp]: true,
                          },
                        }));
                        setConfirmation({
                          title: "确认添加 Skills",
                          message: `将添加所选 ${imports.length} 个 Skill 到共享资源库，并启用到 ${targetName}。请先备份同名目录；失败可能部分完成。`,
                          confirmText: `添加 ${imports.length} 个`,
                          destructive: false,
                          action: async () => {
                            await skillsApi.importFromApps(imports);
                            setSelectedImports([]);
                            await scanSkills();
                          },
                        });
                      }}
                    >
                      添加所选 Skills
                    </button>
                  </div>
                </fieldset>
              </section>
            )}
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
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <p>安装后启用到 {targetName}，其他工具不受影响。</p>
                <div className="skills-install-section">
                  <h3>从仓库</h3>
                  <p>读取「管理仓库」中添加的 Git 仓库，列出可安装的 Skill。</p>
                  <button
                    type="button"
                    className="skills-install-action"
                    onClick={discoverFromRepos}
                  >
                    {available === null ? "读取已配置仓库" : "重新读取仓库"}
                  </button>
                  {available?.length === 0 &&
                    (enabledRepoCount === 0 ? (
                      <p role="status">
                        还没有启用的仓库。先在「管理仓库」中添加，再重新读取。
                      </p>
                    ) : (
                      <p role="status">
                        已启用的 {enabledRepoCount} 个仓库没有返回可安装的
                        Skill。仓库可能暂时无法访问，或其中没有
                        Skill；可以稍后重新读取。
                      </p>
                    ))}
                  {available?.map((skill) => {
                    const existing = installedByFolder.get(
                      installFolder(skill.directory),
                    );
                    const sameRepo =
                      existing?.repoOwner === skill.repoOwner &&
                      existing?.repoName === skill.repoName;
                    return (
                      <div key={skill.key} className="skills-install-result">
                        <span className="skills-install-name">
                          <strong title={skill.name}>{skill.name}</strong>
                          <small>
                            {skill.repoOwner}/{skill.repoName}
                            {skill.description ? ` · ${skill.description}` : ""}
                          </small>
                        </span>
                        {!existing ? (
                          <button
                            type="button"
                            className="skills-install-action"
                            aria-label={`安装 ${skill.name}`}
                            onClick={() =>
                              void run(() =>
                                skillsApi.installUnified(skill, targetApp),
                              )
                            }
                          >
                            安装
                          </button>
                        ) : !sameRepo ? (
                          <span className="skills-install-state">
                            已有同名 Skill（
                            {existing.repoOwner && existing.repoName
                              ? `${existing.repoOwner}/${existing.repoName}`
                              : "本地安装"}
                            ）
                          </span>
                        ) : existing.apps[targetApp] ? (
                          <span className="skills-install-state">
                            已安装并启用
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="skills-install-action"
                            aria-label={`启用 ${skill.name} 到 ${targetName}`}
                            onClick={() =>
                              void run(() =>
                                skillsApi.installUnified(skill, targetApp),
                              )
                            }
                          >
                            启用到 {targetName}
                          </button>
                        )}
                      </div>
                    );
                  })}
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
                ref={detailsRef}
                id="mcp-details"
                role="region"
                aria-label="MCP 详情"
                className="skills-mcp-panel box-border w-[380px] min-h-full shrink-0 flex flex-col gap-[16px] pl-[24px] justify-start items-start border-l border-solid border-[var(--border-subtle)]"
              >
                {/* 标题 */}
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] justify-start items-start">
                  <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[8px] justify-start items-center">
                    <div className="text-[15px]/[21px] [flex:1_1_0] min-w-0 text-[var(--text-1)] font-['Overpass_Mono',system-ui,sans-serif] font-bold text-left">
                      {selectedMcp.name}
                    </div>
                    <button
                      type="button"
                      aria-label="关闭 MCP 详情"
                      onClick={() => setSelectedMcp(null)}
                      className="box-border w-[28px] shrink-0 h-[28px] flex justify-center items-center rounded-[4px] border-none bg-transparent hover:bg-[var(--bg-selected)] text-[var(--text-2)] cursor-pointer"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="text-[13px]/[18px] text-[var(--text-3)]">
                    在 {targetName} 中
                    {selectedMcp.enabled ? "已启用" : "未启用"} ·{" "}
                    {selectedMcp.sourceCommand} · 新会话加载
                  </div>
                </div>

                {/* 启动命令 */}
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] justify-start items-start">
                  <div className="text-[13px]/[18px] text-[var(--text-2)] font-bold">
                    {selectedMcp.remote ? "远程连接" : "启动命令"}
                  </div>
                  <div className="box-border w-full h-fit flex flex-row gap-[8px] justify-start items-start text-[13px]/[18px]">
                    <div className="w-[64px] shrink-0 text-[var(--text-3)] font-['Overpass_Mono',system-ui,sans-serif]">
                      {selectedMcp.remote ? "url" : "command"}
                    </div>
                    <div className="[flex:1_1_0] text-[var(--text-1)]">
                      在编辑器中查看
                    </div>
                  </div>
                  <div className="box-border w-full h-fit flex flex-row gap-[8px] justify-start items-start text-[13px]/[18px]">
                    <div className="w-[64px] shrink-0 text-[var(--text-3)] font-['Overpass_Mono',system-ui,sans-serif]">
                      {selectedMcp.remote ? "headers" : "args"}
                    </div>
                    <div className="[flex:1_1_0] flex flex-col gap-[2px] text-[var(--text-1)]">
                      {selectedMcp.remote
                        ? "连接地址与请求头可能包含凭据；请通过编辑器查看。"
                        : "参数不在此显示，避免泄露命令行中的凭据；请通过编辑器查看。"}
                    </div>
                  </div>
                </div>

                {/* 环境变量（脱敏） */}
                {selectedMcp.envMasked && (
                  <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] justify-start items-start">
                    <div className="text-[13px]/[18px] text-[var(--text-2)] font-bold">
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
                    <div className="text-[13px]/[18px] text-[var(--text-3)]">
                      环境变量值不在此详情面板显示
                    </div>
                  </div>
                )}

                {/* 备注 */}
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] justify-start items-start">
                  <div className="text-[13px]/[18px] text-[var(--text-2)] font-bold">
                    备注
                  </div>
                  <div className="box-border w-full h-fit flex flex-row gap-[6px] justify-start items-center text-[13px]/[18px] text-[var(--text-2)]">
                    <NotePencil
                      size={14}
                      className="shrink-0 text-[var(--text-3)]"
                      aria-hidden="true"
                    />
                    <span>{selectedMcp.note || "未填写"}</span>
                  </div>
                </div>

                {/* 写入预告 */}
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] justify-start items-start">
                  <div className="text-[13px]/[18px] text-[var(--text-2)] font-bold">
                    写入位置
                  </div>
                  <div className="box-border w-full h-fit flex flex-row gap-[8px] justify-start items-start text-[13px]/[18px]">
                    <div className="w-[64px] shrink-0 text-[var(--text-3)]">
                      写入
                    </div>
                    <div className="[flex:1_1_0] flex flex-col gap-[2px] text-[var(--text-1)]">
                      <div>{targetName} 的 MCP 配置</div>
                      <div className="font-['Overpass_Mono',system-ui,sans-serif]">
                        {selectedMcp.id}
                      </div>
                    </div>
                  </div>
                  <div className="text-[13px]/[18px] text-[var(--text-3)]">
                    按目标工具的实际配置目录同步；保留非本应用管理的服务
                  </div>
                </div>

                <div className="[flex:1_1_0]" />

                {/* 底部操作 */}
                <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[8px] justify-end items-center pt-[12px]">
                  <button
                    type="button"
                    onClick={() =>
                      setRemoving(
                        servers.find((s) => s.id === selectedMcp.id) || null,
                      )
                    }
                    className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center rounded-[4px] border-none bg-transparent hover:bg-[var(--bg-subtle)] cursor-pointer text-[var(--danger-fg)] text-[14px]/[20px]"
                  >
                    <Trash size={16} aria-hidden="true" />
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
                    <PencilSimple size={16} aria-hidden="true" />
                    <span>编辑</span>
                  </button>
                </div>
              </div>
            )}
      </fieldset>
      <ConfirmDialog
        isOpen={removing !== null}
        title="移除 MCP"
        message={
          removing
            ? `将删除「${removing.name}」${
                removingTools.length
                  ? `，并从 ${removingTools.join("、")} 的配置中移除这一项`
                  : "（目前没有在任何工具中启用）"
              }。`
            : ""
        }
        confirmText="移除"
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
