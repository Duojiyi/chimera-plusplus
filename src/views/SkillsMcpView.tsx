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
  Folder,
  FolderOpen,
  Globe,
  Terminal,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import "./SkillsMcpView.css";
import "@/theme/v3/skills-mcp.css";
import { settingsApi } from "@/lib/api/settings";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  SAMPLE_MCP_SERVERS,
  SAMPLE_NOTES,
  SAMPLE_SKILLS,
  isSkillsDesignPreview,
} from "./SkillsMcpView.designSamples";
import {
  skillsApi,
  type InstalledSkill,
  type DiscoverableSkill,
  type SkillRepo,
  type UnmanagedSkill,
  type SkippedSkillDir,
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
const importKey = (skill: UnmanagedSkill) =>
  JSON.stringify([skill.directory, skill.path, skill.contentHash ?? ""]);

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

/** Where an MCP points, without arguments, query strings or credentials. */
const safeTarget = (spec: McpServer["server"]) => {
  if (spec.url) {
    try {
      return new URL(spec.url).host || "远程服务";
    } catch {
      return "远程服务";
    }
  }
  const args = spec.args?.length ?? 0;
  const env = Object.keys(spec.env || {}).length;
  return [
    "本地进程",
    args ? `${args} 个启动参数` : null,
    env ? `${env} 个环境变量` : null,
  ]
    .filter(Boolean)
    .join(" · ");
};

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
  // Browser design preview: sample rows, every write refused.
  const [preview] = useState(isSkillsDesignPreview);
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
  // A Skill and an MCP may share an ID; the kind keeps their notes apart.
  const [editingNote, setEditingNote] = useState<{
    kind: "skill" | "mcp";
    id: string;
  } | null>(null);
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
  const [skippedSkills, setSkippedSkills] = useState<SkippedSkillDir[]>([]);
  const [scanning, setScanning] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanGeneration = useRef(0);
  const [selectedImports, setSelectedImports] = useState<string[]>([]);
  const [scanAllSources, setScanAllSources] = useState(false);
  const [backups, setBackups] = useState<SkillBackupEntry[] | null>(null);
  const [updates, setUpdates] = useState<SkillUpdateInfo[] | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const [nextSkills, nextServers, sn, mn] = preview
        ? [SAMPLE_SKILLS, SAMPLE_MCP_SERVERS, SAMPLE_NOTES, {}]
        : await Promise.all([
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
  }, [preview]);
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
      const scan = preview
        ? { skills: [], skipped: [] }
        : await skillsApi.scanUnmanagedWithSkipped(
            scanAllSources ? undefined : targetApp,
          );
      if (request !== scanGeneration.current) return;
      const found = scan?.skills;
      if (!Array.isArray(found))
        throw new Error("Invalid Skills scan response");
      setUnmanaged(found);
      setSkippedSkills(Array.isArray(scan.skipped) ? scan.skipped : []);
      setSelectedImports((previous) =>
        previous.filter((key) =>
          found.some((skill) => importKey(skill) === key),
        ),
      );
    } catch {
      if (request === scanGeneration.current)
        setScanError("扫描失败，请检查目录访问权限后重试。");
    } finally {
      if (request === scanGeneration.current) setScanning(false);
    }
  }, [preview, scanAllSources, targetApp]);
  useEffect(() => {
    setUnmanaged(null);
    setSkippedSkills([]);
    setSelectedImports([]);
  }, [scanSkills]);
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
    if (selectedId) detailsRef.current?.focus();
  }, [selectedId]);

  /** The design preview has no backend; say so instead of failing. */
  const previewBlocked = () => {
    if (!preview) return false;
    toast.info("设计预览中不能修改，请在桌面应用中操作。");
    return true;
  };
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
    if (previewBlocked() || !lock()) return false;
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
    if (previewBlocked() || !lock()) return false;
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
    target: safeTarget(s.server),
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
  const setSelectedMcp = (server: { id: string } | null) => {
    setSelectedId(server?.id || null);
    // One drawer at a time; a half-typed Skill note does not follow along.
    if (server) {
      setInstallDrawerOpen(false);
      setEditingNote(null);
    }
  };
  const openInstall = () => {
    setSelectedId(null);
    setInstallDrawerOpen(true);
  };
  const openEditor = (target: McpServer | "new" | null) => {
    if (target && previewBlocked()) return;
    setEditing(target);
  };
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
  const handleStartEditNote = (id: string, note: string, isSkill: boolean) => {
    setEditingNote({ kind: isSkill ? "skill" : "mcp", id });
    setNoteText(note);
  };
  const isEditingNote = (id: string, isSkill: boolean) =>
    editingNote?.id === id && editingNote.kind === (isSkill ? "skill" : "mcp");
  const handleSaveNote = (id: string, isSkill: boolean) =>
    void run(async () => {
      await officialAccountsApi.setNotes(
        isSkill ? "skills" : "mcp_servers",
        id,
        noteText,
      );
      setEditingNote(null);
    });
  const noteKeys =
    (id: string, isSkill: boolean) =>
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") handleSaveNote(id, isSkill);
      if (event.key === "Escape") setEditingNote(null);
    };
  const enabledSkillsCount = skills.filter((s) => s.enabled).length;
  const enabledMcpCount = mcps.filter((s) => s.enabled).length;
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
  const repoSkillCount = installed.filter(
    (item) => item.repoOwner && item.repoName,
  ).length;
  const remoteMcpCount = mcps.filter((item) => item.remote).length;
  const scanButtonLabel = scanning
    ? "正在扫描…"
    : scanError
      ? "重试扫描"
      : "刷新扫描";
  const closeDrawers = () => {
    setInstallDrawerOpen(false);
    setSelectedId(null);
  };
  const drawerKeys = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !busyRef.current) {
      event.stopPropagation();
      closeDrawers();
    }
  };
  const overlayOpen =
    busy ||
    confirmation !== null ||
    repoOpen ||
    editing !== null ||
    removing !== null;
  const renderNote = (id: string, note: string, isSkill: boolean) =>
    isEditingNote(id, isSkill) ? (
      <span className="v3-res-note-edit">
        <input
          aria-label="备注"
          maxLength={1000}
          type="text"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          onKeyDown={noteKeys(id, isSkill)}
          className="skills-note-input"
          autoFocus
        />
        <button
          type="button"
          aria-label="保存备注"
          onClick={() => handleSaveNote(id, isSkill)}
          className="skills-note-save"
        >
          保存
        </button>
      </span>
    ) : (
      <button
        type="button"
        onClick={() => handleStartEditNote(id, note, isSkill)}
        title={note || undefined}
        className="v3-res-note"
        data-empty={!note}
      >
        <NotePencil size={11} aria-hidden="true" />
        <span>{note || "添加备注"}</span>
      </button>
    );
  return (
    <div className="skills-mcp-page v3-skills-page connected-page">
      {/* 页头 */}
      <header data-pencil-name="页头" className="v3-skills-head">
        <div className="v3-skills-titles">
          <h1>Skills 与 MCP</h1>
          <div className="v3-skills-sub">
            <label className="v3-skills-target">
              <span>目标工具</span>
              <select
                aria-label="目标工具"
                value={targetApp}
                disabled={overlayOpen}
                onChange={(event) => {
                  const next = RESOURCE_TOOLS.find(
                    (tool) => tool.id === event.target.value,
                  );
                  if (!next || busyRef.current) return;
                  setTargetApp(next.id);
                  setSelectedId(null);
                  setEditingNote(null);
                  setInstallDrawerOpen(false);
                }}
              >
                {RESOURCE_TOOLS.map((tool) => (
                  <option key={tool.id} value={tool.id}>
                    {tool.name}
                  </option>
                ))}
              </select>
            </label>
            {loaded && (
              <section
                className="v3-skills-summary"
                aria-label={`${targetName} 资源概览`}
              >
                <span>
                  {skills.length} 个技能 · {mcps.length} 个服务 ·{" "}
                  {enabledSkillsCount + enabledMcpCount} 项已启用
                </span>
                <HelpTip
                  title="Skills 与 MCP 如何生效"
                  align="start"
                  className="skills-mcp-help"
                >
                  {`Skills 与 MCP 在各工具间共享，开关只改变 ${targetName}，新会话开始时加载。`}
                </HelpTip>
              </section>
            )}
          </div>
        </div>
        <div className="v3-skills-actions">
          <button
            type="button"
            className="v3-btn v3-btn-ghost"
            disabled={loading || !loaded}
            onClick={() => {
              if (!previewBlocked()) exportSafeConfiguration();
            }}
            aria-describedby="mcp-export-scope"
            title={`导出全部工具的共享资源与启用状态。${MCP_EXPORT_NOTICE}`}
          >
            <Export size={13} aria-hidden="true" />
            导出
          </button>
          {/* The Skills empty state carries its own install paths. */}
          {loaded && skills.length > 0 && (
            <button
              type="button"
              className="v3-btn"
              disabled={busy || loading}
              aria-expanded={installDrawerOpen}
              aria-controls={
                installDrawerOpen ? "skills-install-panel" : undefined
              }
              onClick={openInstall}
            >
              安装
            </button>
          )}
          {/* With no services the MCP card's empty state carries this action. */}
          {loaded && mcps.length > 0 && (
            <button
              type="button"
              className="v3-btn v3-btn-primary"
              disabled={busy || loading}
              onClick={() => openEditor("new")}
            >
              添加 MCP
            </button>
          )}
        </div>
      </header>

      {loading && !loaded && (
        <p role="status" className="v3-skills-status">
          正在读取 Skills 与 MCP…
        </p>
      )}
      {notice && (
        <div role="alert" className="v3-skills-notice">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{notice.message}</span>
          <button
            type="button"
            disabled={busy || loading}
            onClick={notice.onAction}
          >
            {notice.actionLabel}
          </button>
        </div>
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

      {error ? (
        <ErrorState
          className="v3-skills-error"
          icon={<AlertCircle size={18} />}
          title={error}
          description="本机配置暂时读不到，已安装的内容不受影响。"
          action={
            <button
              type="button"
              className="v3-btn"
              onClick={() => void reload()}
            >
              重试
            </button>
          }
        />
      ) : (
        <fieldset
          data-pencil-name="两栏"
          disabled={busy || loading}
          aria-busy={busy}
          className="v3-skills-grid"
        >
          {/* ---------- 左：Skills ---------- */}
          <section className="v3-res-card" aria-labelledby="skills-card-title">
            <div className="v3-res-card-head">
              <h2 id="skills-card-title">Skills</h2>
              <p>
                {loaded ? (
                  <>
                    {targetName} 已启用{" "}
                    <strong>{`${enabledSkillsCount} / ${skills.length}`}</strong>
                    {repoSkillCount > 0 && ` · ${repoSkillCount} 个来自仓库`}
                  </>
                ) : (
                  "正在读取…"
                )}
              </p>
            </div>
            <div className="v3-res-card-body">
              {!loaded && (
                <div className="v3-res-skeleton" aria-hidden="true">
                  {[0, 1, 2, 3].map((row) => (
                    <Skeleton key={row} height={60} radius={10} />
                  ))}
                </div>
              )}
              {loaded && skills.length === 0 && (
                <section
                  className="resource-empty v3-res-empty"
                  aria-labelledby="skills-empty-title"
                >
                  <span className="resource-empty-icon" aria-hidden="true">
                    <Puzzle size={22} strokeWidth={1.6} />
                  </span>
                  <h2 id="skills-empty-title">尚未由 Chimera++ 管理 Skills</h2>
                  <p>
                    磁盘上已有的技能仍可被工具读取，可在下方发现并纳入管理。
                  </p>
                  <div className="resource-empty-paths">
                    <button
                      type="button"
                      className="resource-path"
                      aria-expanded={installDrawerOpen}
                      aria-controls={
                        installDrawerOpen ? "skills-install-panel" : undefined
                      }
                      onClick={openInstall}
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
              {skills.map((skill) => (
                <div key={skill.id} className="v3-res-row">
                  <Folder
                    size={15}
                    strokeWidth={1.7}
                    className="v3-res-icon"
                    aria-hidden="true"
                  />
                  <div className="v3-res-main">
                    <div className="v3-res-name" title={skill.name}>
                      {skill.name}
                    </div>
                    <div className="v3-res-path" title={skill.source}>
                      {skill.source}
                    </div>
                    {renderNote(skill.id, skill.note, true)}
                  </div>
                  <div className="v3-res-side">
                    <div className="v3-res-controls">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Skill ${skill.name} 的更多操作`}
                            className="v3-icon-btn"
                          >
                            <DotsThree size={15} aria-hidden="true" />
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
                            onSelect={() => {
                              if (!previewBlocked()) askUninstall(skill);
                            }}
                          >
                            <Trash size={15} aria-hidden="true" />
                            卸载…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <button
                        type="button"
                        role="switch"
                        aria-label={`启用 Skill ${skill.name}`}
                        aria-checked={skill.enabled}
                        disabled={busy || loading || !loaded}
                        onClick={() => handleToggleSkill(skill.id)}
                        className="skills-resource-switch"
                      >
                        <span
                          className="skills-resource-switch-thumb"
                          aria-hidden="true"
                        />
                      </button>
                    </div>
                    <span
                      className="v3-res-state"
                      data-state={skill.enabled ? "on" : "off"}
                    >
                      {skill.enabled ? "已启用" : "未启用"}
                    </span>
                  </div>
                </div>
              ))}
              {loaded && (updates !== null || backups !== null) && (
                <fieldset
                  className="v3-res-lifecycle"
                  disabled={
                    busy || loading || confirmation !== null || repoOpen
                  }
                >
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
              )}
              {loaded && (scanning || scanError || unmanaged !== null) && (
                <section
                  className="skills-discovery v3-res-discovery"
                  aria-label="本机发现的 Skills"
                >
                  <fieldset
                    disabled={
                      busy || loading || confirmation !== null || repoOpen
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
                      <label className="skills-scan-scope">
                        <input
                          type="checkbox"
                          checked={scanAllSources}
                          onChange={(event) =>
                            setScanAllSources(event.target.checked)
                          }
                        />
                        同时发现其他工具的 Skills
                      </label>
                      <p className="skills-scan-scope-hint">
                        {scanAllSources
                          ? "正在查看所有工具与共享目录；相同内容的副本会合并。"
                          : `仅查看 ${targetName}${targetApp === "codex" ? " 与通用 .agents 目录" : " 的技能目录"}。`}
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
                      {!scanError && skippedSkills.length > 0 && (
                        <p
                          className="skills-scan-scope-hint"
                          data-testid="skills-scan-skipped"
                        >
                          {skippedSkills.length} 个本地 Skill
                          目录无法读取或校验，已跳过：
                          {skippedSkills
                            .map(
                              (dir) =>
                                `${dir.directory}（${dir.reason}，来源：${dir.foundIn.map(sourceLabel).join("、")}）`,
                            )
                            .join("；")}
                          。
                        </p>
                      )}
                      {unmanaged?.map((skill) => {
                        const key = importKey(skill);
                        const ambiguous =
                          unmanaged.filter(
                            (item) => item.directory === skill.directory,
                          ).length !== 1;
                        return (
                          <label
                            className="skills-lifecycle-row skills-scan-row"
                            data-selected={selectedImports.includes(key)}
                            key={key}
                          >
                            <input
                              type="checkbox"
                              aria-label={`添加 ${skill.name}`}
                              checked={selectedImports.includes(key)}
                              disabled={scanning || !!scanError}
                              onChange={(event) =>
                                setSelectedImports((previous) =>
                                  event.target.checked
                                    ? [
                                        ...previous.filter(
                                          (item) =>
                                            !unmanaged.some(
                                              (candidate) =>
                                                candidate.directory ===
                                                  skill.directory &&
                                                importKey(candidate) === item,
                                            ),
                                        ),
                                        key,
                                      ]
                                    : previous.filter((item) => item !== key),
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
                                来源：
                                {skill.foundIn.map(sourceLabel).join("、")}
                              </span>
                              {ambiguous && (
                                <span className="skills-scan-warning">
                                  同名但内容不同，请选择一个来源；不会覆盖目标中的不同内容。
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                      <button
                        type="button"
                        disabled={
                          scanning ||
                          !!scanError ||
                          selectedImports.length === 0
                        }
                        onClick={() => {
                          const imports = (unmanaged ?? [])
                            .filter((skill) =>
                              selectedImports.includes(importKey(skill)),
                            )
                            .map((skill) => ({
                              directory: skill.directory,
                              sourcePath: skill.path,
                              contentHash: skill.contentHash,
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
                            message: `将添加所选 ${imports.length} 个 Skill 到共享资源库，并启用到 ${targetName}。已有目标必须与所选来源内容一致；如有冲突，本批次将回滚新建文件，不会覆盖已有目录。`,
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
            <div className="v3-res-card-foot">
              <p>
                <span className="v3-res-foot-label">共享目录</span>
                启用后同步到 {targetName} 的 Skills 目录 · 新会话加载
              </p>
              <fieldset
                className="v3-res-foot-actions"
                disabled={
                  !loaded ||
                  busy ||
                  loading ||
                  confirmation !== null ||
                  repoOpen
                }
              >
                <button type="button" className="v3-btn" onClick={openRepos}>
                  管理仓库
                </button>
                <button
                  type="button"
                  className="v3-btn"
                  disabled={scanning}
                  onClick={() => {
                    if (!previewBlocked()) void scanSkills();
                  }}
                >
                  {scanButtonLabel}
                </button>
                {hasRepoSkills && (
                  <button
                    type="button"
                    className="v3-btn"
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
                  className="v3-btn"
                  onClick={() =>
                    void read("无法读取备份列表，请稍后重试。", async () => {
                      setBackups(null);
                      setBackups(await skillsApi.getBackups());
                    })
                  }
                >
                  查看可恢复备份
                </button>
              </fieldset>
            </div>
          </section>

          {/* ---------- 右：MCP 服务 ---------- */}
          <section className="v3-res-card" aria-labelledby="mcp-card-title">
            <div className="v3-res-card-head">
              <h2 id="mcp-card-title">MCP 服务</h2>
              <p>
                {loaded ? (
                  <>
                    {targetName} 已启用{" "}
                    <strong>{`${enabledMcpCount} / ${mcps.length}`}</strong>
                    {remoteMcpCount > 0 && ` · ${remoteMcpCount} 个远程`}
                  </>
                ) : (
                  "正在读取…"
                )}
              </p>
            </div>
            <div className="v3-res-card-body">
              {!loaded && (
                <div className="v3-res-skeleton" aria-hidden="true">
                  {[0, 1, 2, 3].map((row) => (
                    <Skeleton key={row} height={60} radius={10} />
                  ))}
                </div>
              )}
              {loaded && mcps.length === 0 && (
                <section
                  className="resource-empty v3-res-empty"
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
                    className="v3-btn v3-btn-primary"
                    onClick={() => openEditor("new")}
                  >
                    <Plus size={13} strokeWidth={2.4} aria-hidden="true" />
                    添加 MCP
                  </button>
                </section>
              )}
              {mcps.map((mcp) => {
                const isSelected = selectedMcp?.id === mcp.id;
                const Icon = mcp.remote ? Globe : Terminal;
                return (
                  <div
                    key={mcp.id}
                    className={`v3-res-row${isSelected ? " is-current" : ""}`}
                  >
                    <Icon
                      size={15}
                      strokeWidth={1.7}
                      className="v3-res-icon"
                      aria-hidden="true"
                    />
                    <div className="v3-res-main">
                      <div className="v3-res-title-line">
                        <button
                          type="button"
                          aria-label={`查看 MCP ${mcp.name}`}
                          aria-expanded={isSelected}
                          aria-controls={isSelected ? "mcp-details" : undefined}
                          onClick={() => setSelectedMcp(mcp)}
                          title={mcp.name}
                          className="v3-res-name v3-res-name-button"
                        >
                          {mcp.name}
                        </button>
                        <span className="v3-res-chip">{mcp.sourceCommand}</span>
                      </div>
                      <div className="v3-res-path">{mcp.target}</div>
                      {renderNote(mcp.id, mcp.note, false)}
                    </div>
                    <div className="v3-res-side">
                      <div className="v3-res-controls">
                        <button
                          type="button"
                          aria-label={`MCP ${mcp.name} 的详情和操作`}
                          onClick={() => setSelectedMcp(mcp)}
                          className="v3-icon-btn"
                        >
                          <DotsThree size={15} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          role="switch"
                          aria-label={`启用 MCP ${mcp.name}`}
                          aria-checked={mcp.enabled}
                          disabled={busy || loading || !loaded}
                          onClick={() => handleToggleMcp(mcp.id)}
                          className="skills-resource-switch"
                        >
                          <span
                            className="skills-resource-switch-thumb"
                            aria-hidden="true"
                          />
                        </button>
                      </div>
                      <span
                        className="v3-res-state v3-res-dot"
                        data-state={mcp.enabled ? "on" : "off"}
                      >
                        {mcp.enabled ? "已启用" : "未启用"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="v3-res-card-foot">
              <p>
                <span className="v3-res-foot-label">配置文件</span>
                写入 {targetName} 的 MCP 配置 · 保留其他来源的服务
              </p>
              <p className="v3-res-privacy">
                <ShieldCheck size={12} aria-hidden="true" />
                <span id="mcp-export-scope">导出前请检查敏感信息</span>
              </p>
              <fieldset
                className="v3-res-foot-actions"
                disabled={!loaded || busy || loading}
              >
                <button
                  type="button"
                  className="v3-btn"
                  onClick={() => {
                    if (previewBlocked()) return;
                    settingsApi.openConfigFolder(targetApp).catch(() => {
                      toast.error("无法打开配置目录，请检查目录是否存在。");
                    });
                  }}
                >
                  <FolderOpen size={13} aria-hidden="true" />
                  打开配置目录
                </button>
              </fieldset>
            </div>
          </section>

          {/* ---------- 抽屉：安装 Skill / MCP 详情（L23） ---------- */}
          {(installDrawerOpen || selectedMcp) && (
            <div
              className="v3-drawer-scrim"
              aria-hidden="true"
              onClick={() => {
                if (!busyRef.current) closeDrawers();
              }}
            />
          )}
          {installDrawerOpen && (
            <div
              ref={installPanelRef}
              id="skills-install-panel"
              tabIndex={-1}
              role="region"
              aria-label="安装 Skill"
              className="v3-drawer"
              onKeyDown={drawerKeys}
            >
              <div className="v3-drawer-head">
                <div>
                  <strong className="v3-drawer-title">安装 Skill</strong>
                  <p>安装后启用到 {targetName}，其他工具不受影响。</p>
                </div>
                <button
                  type="button"
                  aria-label="关闭安装"
                  className="v3-icon-btn"
                  onClick={() => setInstallDrawerOpen(false)}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
              <div className="v3-drawer-body">
                <div className="v3-drawer-section">
                  <h3>从仓库</h3>
                  <p>读取「管理仓库」中添加的 Git 仓库，列出可安装的 Skill。</p>
                  <button
                    type="button"
                    className="v3-btn"
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
                            className="v3-btn v3-btn-small"
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
                            className="v3-btn v3-btn-small"
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
                <div className="v3-drawer-section">
                  <h3>从 ZIP 文件</h3>
                  <p>选择本机的 Skill 压缩包。</p>
                  <button
                    type="button"
                    className="v3-btn"
                    onClick={installFromZip}
                  >
                    从 ZIP 安装…
                  </button>
                </div>
              </div>
            </div>
          )}
          {selectedMcp && (
            <div
              ref={detailsRef}
              id="mcp-details"
              tabIndex={-1}
              role="region"
              aria-label="MCP 详情"
              className="v3-drawer"
              onKeyDown={drawerKeys}
            >
              <div className="v3-drawer-head">
                <div>
                  <strong className="v3-drawer-title v3-drawer-title-mono">
                    {selectedMcp.remote ? (
                      <Globe size={16} strokeWidth={1.7} aria-hidden="true" />
                    ) : (
                      <Terminal
                        size={16}
                        strokeWidth={1.7}
                        aria-hidden="true"
                      />
                    )}
                    {selectedMcp.name}
                  </strong>
                  <p>
                    {selectedMcp.description
                      ? `${selectedMcp.description} · `
                      : ""}
                    在 {targetName} 中
                    {selectedMcp.enabled ? "已启用" : "未启用"} · 新会话加载
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="关闭 MCP 详情"
                  onClick={() => setSelectedMcp(null)}
                  className="v3-icon-btn"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
              <div className="v3-drawer-body">
                <div className="v3-drawer-section">
                  <h3>{selectedMcp.remote ? "远程连接" : "启动命令"}</h3>
                  <dl className="v3-drawer-code">
                    <dt>transport</dt>
                    <dd>{selectedMcp.sourceCommand}</dd>
                    <dt>{selectedMcp.remote ? "url" : "command"}</dt>
                    <dd>{selectedMcp.target}</dd>
                    <dt>{selectedMcp.remote ? "headers" : "args"}</dt>
                    <dd>
                      {selectedMcp.remote
                        ? "连接地址与请求头可能包含凭据；请通过编辑器查看。"
                        : "参数不在此显示，避免泄露命令行中的凭据；请通过编辑器查看。"}
                    </dd>
                  </dl>
                </div>

                {selectedMcp.envMasked && (
                  <div className="v3-drawer-section">
                    <h3>
                      环境变量 ·{" "}
                      {Object.keys(selectedMcp.server.env || {}).length} 个
                    </h3>
                    <div className="v3-drawer-mono">
                      {selectedMcp.envMasked.key}
                    </div>
                    <div className="v3-drawer-env">
                      <span className="v3-drawer-inset">
                        {selectedMcp.envMasked.maskedValue}
                      </span>
                      <button
                        type="button"
                        className="v3-btn v3-btn-small"
                        onClick={() =>
                          openEditor(
                            servers.find((s) => s.id === selectedMcp.id) ||
                              null,
                          )
                        }
                      >
                        替换…
                      </button>
                    </div>
                    <p>环境变量值不在此详情面板显示</p>
                  </div>
                )}

                <div className="v3-drawer-section">
                  <h3>备注</h3>
                  <p className="v3-drawer-note">
                    <NotePencil size={12} aria-hidden="true" />
                    <span>{selectedMcp.note || "未填写"}</span>
                  </p>
                </div>

                <div className="v3-drawer-section">
                  <h3>写入位置</h3>
                  <div className="v3-drawer-kv">
                    <span>写入</span>
                    <span>
                      {targetName} 的 MCP 配置
                      <code>{selectedMcp.id}</code>
                    </span>
                  </div>
                  <p>按目标工具的实际配置目录同步；保留非本应用管理的服务</p>
                </div>
              </div>
              <div className="v3-drawer-foot">
                <button
                  type="button"
                  className="v3-btn v3-btn-danger-text"
                  onClick={() => {
                    if (previewBlocked()) return;
                    setRemoving(
                      servers.find((s) => s.id === selectedMcp.id) || null,
                    );
                  }}
                >
                  <Trash size={13} aria-hidden="true" />
                  移除…
                </button>
                <span className="v3-drawer-foot-gap" />
                <button
                  type="button"
                  className="v3-btn"
                  onClick={() =>
                    openEditor(
                      servers.find((s) => s.id === selectedMcp.id) || null,
                    )
                  }
                >
                  <PencilSimple size={13} aria-hidden="true" />
                  编辑
                </button>
                <button
                  type="button"
                  className="v3-btn v3-btn-primary"
                  onClick={() => setSelectedMcp(null)}
                >
                  完成
                </button>
              </div>
            </div>
          )}
        </fieldset>
      )}
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
