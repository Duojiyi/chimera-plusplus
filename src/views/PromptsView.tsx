import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  Suspense,
} from "react";
import {
  FileText,
  Plus,
  MoreHorizontal,
  Search,
  ArrowUpRight,
  Check,
  X,
  Pencil,
  Upload,
  RefreshCw,
  FolderCog,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { AppId } from "@/lib/api/types";
import type { VisibleApps } from "@/types";
import {
  promptsApi,
  type CodexPromptResolution,
  type CodexPromptStatus,
  type Prompt,
  type PromptCategory,
} from "@/lib/api/prompts";
import { settingsApi } from "@/lib/api/settings";
import { bundledPromptTemplates } from "@/config/promptTemplates";
import {
  codexStatusView,
  type CodexStatusView,
} from "@/components/prompts/codexStatus";
import {
  describeFileIssue,
  describePromptError,
} from "@/components/prompts/promptErrors";
import { splitInstructionFile } from "@/components/prompts/instructionSections";
import "./PromptsView.css";

const PromptFormModal = React.lazy(
  () => import("@/components/prompts/PromptFormModal"),
);
const PromptCategoryManager = React.lazy(
  () => import("@/components/prompts/PromptCategoryManager"),
);
const PROMPT_TOOLS = [
  { id: "codex", name: "Codex", file: "AGENTS.md" },
  { id: "claude", name: "Claude Code", file: "CLAUDE.md" },
  { id: "gemini", name: "Gemini CLI", file: "GEMINI.md" },
  { id: "grokbuild", name: "Grok Build", file: "AGENTS.md" },
  { id: "opencode", name: "OpenCode", file: "AGENTS.md" },
  { id: "pi", name: "Pi", file: "AGENTS.md" },
  { id: "omp", name: "oh-my-pi", file: "AGENTS.md" },
] as const;
type PromptToolId = (typeof PROMPT_TOOLS)[number]["id"];
const UNSUPPORTED_PROMPT_TOOLS = "Claude Desktop 暂不支持提示词";

/** Only tools shown in the sidebar (Codex always); all when not given. */
function visiblePromptTools(visibleApps?: Partial<VisibleApps>) {
  return PROMPT_TOOLS.filter(
    (tool) =>
      tool.id === "codex" ||
      !visibleApps ||
      visibleApps[tool.id as keyof VisibleApps] === true,
  );
}
const FOREIGN_BEGIN = "<!-- CODEX-X:INSTRUCTIONS:BEGIN -->";
type Template = (typeof bundledPromptTemplates)[number];
type Entry = { prompt: Prompt; saved: boolean; template?: Template };
type Editor = { entry?: Entry; readOnly: boolean };
type FileIssue = ReturnType<typeof describeFileIssue>;

// Match provenance, never names: keep every saved copy and a stable template slot.
function libraryEntries(
  prompts: Prompt[],
  categories: PromptCategory[],
): Entry[] {
  const ordered = [...prompts].sort(
    (a, b) =>
      (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id),
  );
  const entries: Entry[] = bundledPromptTemplates.flatMap<Entry>((template) => {
    const copies = ordered.filter(
      (prompt) => prompt.templateId === template.id,
    );
    return copies.length
      ? copies.map((prompt) => ({ prompt, saved: true, template }))
      : [
          {
            prompt: {
              id: `template:${template.id}`,
              templateId: template.id,
              categoryId: categories.find(
                (category) => category.id === template.categoryId,
              )?.id,
              name: template.name,
              description: template.description,
              content: template.content,
              enabled: false,
            },
            saved: false,
            template,
          },
        ];
  });
  return entries.concat(
    ordered
      .filter(
        (prompt) =>
          !bundledPromptTemplates.some(
            (template) => template.id === prompt.templateId,
          ),
      )
      .map((prompt) => ({ prompt, saved: true })),
  );
}

export const PromptsView: React.FC<{
  initialApp?: AppId | "omp";
  refreshVersion?: number;
  visibleApps?: Partial<VisibleApps>;
}> = ({ initialApp = "codex", refreshVersion = 0, visibleApps }) => {
  const tools = visiblePromptTools(visibleApps);
  const [targetApp, setTargetApp] = useState<PromptToolId>(
    () => tools.find((tool) => tool.id === initialApp)?.id ?? "codex",
  );
  const toolKey = tools.map((tool) => tool.id).join(",");
  // A tool hidden after the page opened falls back to Codex.
  useEffect(() => {
    if (!toolKey.split(",").includes(targetApp)) setTargetApp("codex");
  }, [toolKey, targetApp]);
  const target = PROMPT_TOOLS.find((tool) => tool.id === targetApp)!;
  const isCodex = targetApp === "codex";
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [categories, setCategories] = useState<PromptCategory[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [showCategories, setShowCategories] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  const [liveIssue, setLiveIssue] = useState<FileIssue | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexPromptStatus | null>(
    null,
  );
  const [resolving, setResolving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [showFile, setShowFile] = useState(false);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Entry | null>(null);
  const [writeConfirmation, setWriteConfirmation] = useState<{
    message: string;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const confirmation = useRef<((confirmed: boolean) => void) | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    const fileName = PROMPT_TOOLS.find((tool) => tool.id === targetApp)!.file;
    setLoading(true);
    setError(false);
    // The instruction file is read on its own: a link or an unreadable file
    // must not take the library down with it.
    const file = promptsApi.getCurrentFileContent(targetApp).then(
      (content) => ({ content, issue: null }),
      (reason: unknown) => ({
        content: null,
        issue: describeFileIssue(reason, fileName),
      }),
    );
    // Without a status the card falls back to the library's own counts.
    const status =
      targetApp === "codex"
        ? promptsApi.getCodexStatus().then(
            (value) => value ?? null,
            () => null,
          )
        : Promise.resolve(null);
    try {
      const [rows, groups] = await Promise.all([
        promptsApi.getPrompts(targetApp),
        promptsApi.getCategories(targetApp),
      ]);
      const [{ content, issue }, codex] = await Promise.all([file, status]);
      if (mounted.current && request === generation.current) {
        setPrompts(Object.values(rows));
        setCategories(groups);
        setCategoryFilter((current) =>
          current === "all" ||
          current === "uncategorized" ||
          groups.some((group) => group.id === current)
            ? current
            : "all",
        );
        setLive(content);
        setLiveIssue(issue);
        setCodexStatus(codex);
      }
    } catch {
      if (mounted.current && request === generation.current) {
        setError(true);
        setCategories([]);
        setPrompts([]);
        setLive(null);
        setLiveIssue(null);
        setCodexStatus(null);
      }
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, [targetApp]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      confirmation.current?.(false);
      confirmation.current = null;
    };
  }, []);
  useEffect(() => {
    setPrompts([]);
    setCategories([]);
    setLive(null);
    setLiveIssue(null);
    setCodexStatus(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [load, refreshVersion]);
  const openFile = () => {
    setShowFile(true);
    void load();
  };
  const mutate = async (action: () => Promise<unknown>) => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setNotice("");
    setHighlightedId(null);
    try {
      await action();
      if (mounted.current) await load();
      return true;
    } catch (reason) {
      if (mounted.current) {
        const { message, showFile: offerFile } = describePromptError(
          reason,
          target.file,
        );
        if (offerFile)
          toast.error(message, {
            action: { label: "查看当前指令", onClick: openFile },
          });
        else toast.error(message);
        await load();
      }
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const resolveFile = (action: CodexPromptResolution) => {
    void mutate(() => promptsApi.resolveCodexFile(action)).then((done) => {
      if (!done || !mounted.current) return;
      setResolving(false);
      setNotice(
        action === "rewrite"
          ? "已重新写入 AGENTS.md，写入前已自动备份。"
          : "已保留文件中的修改，并存为一条启用的提示词。",
      );
    });
  };
  const openFolder = () => {
    settingsApi
      .openConfigFolder(targetApp)
      .catch(() => toast.error(`无法打开 ${target.name} 的配置文件夹。`));
  };
  const confirmWholeFileWrite = (message: string) => {
    if (isCodex) return Promise.resolve(true);
    if (confirmation.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      confirmation.current = resolve;
      setWriteConfirmation({ message, resolve });
    });
  };
  const finishConfirmation = (confirmed: boolean) => {
    writeConfirmation?.resolve(confirmed);
    confirmation.current = null;
    setWriteConfirmation(null);
  };
  const entries = libraryEntries(prompts, categories);
  const categoryOf = (prompt: Prompt) =>
    categories.some((category) => category.id === prompt.categoryId)
      ? prompt.categoryId!
      : "uncategorized";
  const categoryCounts: Record<string, number> = {};
  for (const { prompt } of entries) {
    const id = categoryOf(prompt);
    categoryCounts[id] = (categoryCounts[id] ?? 0) + 1;
  }
  const editorMissing =
    !!editor?.entry?.saved &&
    !loading &&
    !error &&
    !prompts.some((prompt) => prompt.id === editor.entry!.prompt.id);
  useEffect(() => {
    // A confirmation is not permission to resurrect a record deleted meanwhile.
    if (editorMissing && confirmation.current) {
      confirmation.current(false);
      confirmation.current = null;
      setWriteConfirmation(null);
    }
  }, [editorMissing]);
  const currentEditorPrompt = prompts.find(
    (prompt) => prompt.id === editor?.entry?.prompt.id,
  );
  const active = entries.filter(({ prompt }) => prompt.enabled);
  const editorEnabled = editor?.entry?.saved
    ? (prompts.find((prompt) => prompt.id === editor.entry!.prompt.id)
        ?.enabled ?? editor.entry.prompt.enabled)
    : false;
  const query = search.trim().toLocaleLowerCase();
  const visible = entries.filter(
    ({ prompt }) =>
      (!enabledOnly || prompt.enabled) &&
      (categoryFilter === "all" || categoryOf(prompt) === categoryFilter) &&
      `${prompt.name}\n${prompt.description ?? ""}`
        .toLocaleLowerCase()
        .includes(query),
  );
  const disabled = loading || busy || error || writeConfirmation !== null;
  const foreign = isCodex && live?.includes(FOREIGN_BEGIN);
  // What the file in effect says; null keeps the library's own summary.
  const statusView: CodexStatusView | null =
    loading || error
      ? null
      : isCodex && codexStatus
        ? codexStatusView(codexStatus)
        : liveIssue
          ? {
              tone: "warning",
              tag: liveIssue.kind === "linked" ? "链接文件" : "无法读取",
              headline: liveIssue.title,
              detail: liveIssue.detail,
              action:
                liveIssue.kind === "linked"
                  ? { kind: "open-folder", label: "打开所在文件夹" }
                  : { kind: "retry", label: "重试" },
            }
          : null;
  // Writes never follow links, so enabling is refused up front with the reason.
  const linkedFile =
    (isCodex && codexStatus?.state === "linked") ||
    liveIssue?.kind === "linked";
  const blockedReason = linkedFile
    ? `${target.file} 是链接文件，Chimera++ 只读不写，因此不能启用或停用。`
    : undefined;
  const notInEffect =
    isCodex &&
    (codexStatus?.state === "missing" || codexStatus?.state === "overridden");
  const managedCount = codexStatus?.enabledCount ?? active.length;
  const sections = isCodex && live ? splitInstructionFile(live) : null;
  const runStatusAction = (
    kind: NonNullable<CodexStatusView["action"]>["kind"],
  ) => {
    if (kind === "rewrite") resolveFile("rewrite");
    else if (kind === "resolve") setResolving(true);
    else if (kind === "open-folder") openFolder();
    else void load();
  };
  const activate = async (entry: Entry) => {
    if (pending.current || disabled) return false;
    const { prompt, saved } = entry;
    if (
      !isCodex &&
      !(await confirmWholeFileWrite(
        prompt.enabled
          ? `将清空 ${target.name} 的 ${target.file} 整个文件，不会自动恢复之前的指令。原内容会保留在提示词库中。`
          : `将用「${prompt.name}」替换 ${target.name} 的 ${target.file} 整个文件${active.length ? `，当前的「${active[0].prompt.name}」将停用` : ""}。原内容会保留在提示词库中，请停止其他工具写入。`,
      ))
    )
      return false;
    const id = saved ? prompt.id : `prompt-${crypto.randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const next = {
      ...prompt,
      id,
      createdAt: prompt.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    return mutate(async () => {
      if (saved) {
        if (isCodex || prompt.enabled) {
          await promptsApi.setPromptEnabled(targetApp, id, !prompt.enabled);
        } else {
          await promptsApi.enablePrompt(targetApp, id);
        }
      } else if (isCodex) {
        await promptsApi.upsertPrompt(targetApp, id, {
          ...next,
          enabled: true,
        });
      } else {
        // Reuse exclusive activation to preserve the existing whole-file contents.
        // A failed activation leaves a recoverable inactive entry, never a false toggle.
        if (!saved) {
          const stored = { ...next, enabled: false };
          await promptsApi.upsertPrompt(targetApp, id, stored);
          if (mounted.current)
            setEditor((current) =>
              current?.entry?.prompt.id === prompt.id
                ? {
                    ...current,
                    entry: { ...entry, saved: true, prompt: stored },
                  }
                : current,
            );
        }
        await promptsApi.enablePrompt(targetApp, id);
      }
    });
  };
  const importMarkdown = () => {
    let imported: string | undefined;
    void mutate(async () => {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof path === "string")
        imported = await promptsApi.importFromFile(targetApp, path);
    }).then((success) => {
      if (success && imported && mounted.current) {
        setSearch("");
        setEnabledOnly(false);
        setCategoryFilter("all");
        setHighlightedId(imported);
        setNotice("已导入提示词，尚未启用。");
      }
    });
  };
  useEffect(() => {
    if (highlightedId && !loading)
      document
        .getElementById(`prompt-card-${highlightedId}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedId, loading]);

  return (
    <div className="prompts-page">
      <header className="prompts-heading">
        <div>
          <div className="prompts-title-row">
            <h1>提示词</h1>
            <select
              aria-label="提示词目标工具"
              title={UNSUPPORTED_PROMPT_TOOLS}
              value={targetApp}
              disabled={
                busy ||
                writeConfirmation !== null ||
                editor !== null ||
                removing !== null ||
                adopting !== null ||
                resolving ||
                showCategories
              }
              onChange={(event) => {
                setTargetApp(event.target.value as typeof targetApp);
                setSearch("");
                setEnabledOnly(false);
                setCategoryFilter("all");
                setNotice("");
                setHighlightedId(null);
                setShowFile(false);
              }}
            >
              {tools.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.name}
                </option>
              ))}
            </select>
          </div>
          <p>配置 {target.name} 的全局工作指令，让常用习惯持续生效。</p>
        </div>
        <div className="prompts-actions">
          <Button
            variant="outline"
            onClick={importMarkdown}
            disabled={disabled}
          >
            <Upload size={15} />
            导入 .md
          </Button>
          <Button
            onClick={() => setEditor({ readOnly: false })}
            disabled={disabled}
          >
            <Plus size={15} />
            新建提示词
          </Button>
        </div>
      </header>

      <section
        className={`prompts-summary${
          statusView?.tone === "warning"
            ? " is-warning"
            : active.length
              ? " has-active"
              : ""
        }`}
        aria-label="当前提示词状态"
      >
        <div className="prompts-summary-icon" aria-hidden="true">
          {statusView?.tone === "warning" ? (
            <AlertTriangle size={19} />
          ) : active.length ? (
            <Check size={19} />
          ) : (
            <FileText size={19} />
          )}
        </div>
        <div className="prompts-summary-copy">
          {loading ? (
            <strong role="status">正在读取提示词…</strong>
          ) : error ? (
            <strong>当前状态暂不可用</strong>
          ) : (
            <div className="prompts-summary-headline">
              <strong>
                {statusView?.headline ??
                  (active.length
                    ? `已启用 ${active.length} 条`
                    : "未启用 Chimera 提示词")}
              </strong>
              {statusView && (
                <span className={`prompts-state-tag is-${statusView.tone}`}>
                  {statusView.tag}
                </span>
              )}
            </div>
          )}
          {!loading &&
            !error &&
            active.length > 0 &&
            statusView?.tone !== "warning" && (
              <span
                className="prompts-active-names"
                title={active.map(({ prompt }) => prompt.name).join("、")}
              >
                {active.map(({ prompt }) => prompt.name).join("、")}
              </span>
            )}
          <p id="prompts-summary-detail">
            {statusView?.detail ??
              (isCodex
                ? "多条内容合并写入，区块外的原有指令保持不变；修改前自动备份。"
                : "每次使用一条，应用时替换整个指令文件；原文保留在提示词库。")}
          </p>
        </div>
        <div className="prompts-summary-actions">
          {statusView?.action && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || writeConfirmation !== null}
              onClick={() => runStatusAction(statusView.action!.kind)}
            >
              {statusView.action.label}
            </Button>
          )}
          <Button
            variant="ghost"
            className="prompts-file-link"
            onClick={openFile}
            disabled={loading || busy}
          >
            {statusView?.fileLink ?? "查看当前指令"}
            <ArrowUpRight size={15} />
          </Button>
        </div>
      </section>
      {error && (
        <div className="prompts-notice" role="alert">
          <span>本地提示词暂时无法读取，仍可浏览内置内容。</span>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            重试
          </Button>
        </div>
      )}
      {notice && (
        <div className="prompts-notice" role="status">
          <span>{notice}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭提示"
            onClick={() => setNotice("")}
          >
            <X size={15} />
          </Button>
        </div>
      )}
      {foreign && !codexStatus && (
        <div className="prompts-notice">
          <span>检测到其他工具写入的区块，原内容保持只读。</span>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={openFile}
          >
            查看与接管
          </Button>
        </div>
      )}

      <div className="prompts-toolbar">
        <div className="prompts-search">
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="搜索提示词"
            placeholder="搜索名称或描述…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setSearch("")}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="prompts-filters" role="group" aria-label="提示词筛选">
          <button
            type="button"
            aria-pressed={!enabledOnly}
            onClick={() => setEnabledOnly(false)}
          >
            全部
          </button>
          <button
            type="button"
            aria-pressed={enabledOnly}
            onClick={() => setEnabledOnly(true)}
          >
            已启用{!loading && !error && <span>{active.length}</span>}
          </button>
        </div>
        <span className="prompts-result-count">{visible.length} 条提示词</span>
      </div>
      <div className="prompts-category-bar">
        <div
          className="prompts-category-filters"
          role="group"
          aria-label="分类筛选"
        >
          {[
            { id: "all", name: "全部分类" },
            ...categories,
            { id: "uncategorized", name: "未分类" },
          ].map((category) => (
            <button
              key={category.id}
              type="button"
              aria-pressed={categoryFilter === category.id}
              onClick={() => setCategoryFilter(category.id)}
            >
              {category.name}
              <span>
                {category.id === "all"
                  ? entries.length
                  : (categoryCounts[category.id] ?? 0)}
              </span>
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => setShowCategories(true)}
        >
          <FolderCog size={15} />
          管理分类
        </Button>
      </div>
      <section
        className="prompts-catalog"
        aria-label="提示词库"
        aria-busy={loading}
      >
        <div className="prompts-card-grid">
          {visible.map((entry) => {
            const { prompt, template, saved } = entry;
            const modified =
              template &&
              (prompt.content.trim() !== template.content.trim() ||
                prompt.name !== template.name ||
                (prompt.description ?? "") !== template.description);
            return (
              <article
                id={`prompt-card-${prompt.id}`}
                key={prompt.id}
                aria-label={prompt.name}
                className={`prompt-card${prompt.enabled ? " is-enabled" : ""}${highlightedId === prompt.id ? " is-highlighted" : ""}`}
              >
                <div className="prompt-card-heading">
                  <span className="prompt-card-icon" aria-hidden="true">
                    <FileText size={19} />
                  </span>
                  <button
                    type="button"
                    className="prompt-card-title"
                    onClick={() => setEditor({ entry, readOnly: true })}
                  >
                    {prompt.name}
                  </button>
                  {isCodex ? (
                    <Switch
                      aria-label={`启用 ${prompt.name}`}
                      checked={prompt.enabled}
                      disabled={disabled || linkedFile}
                      title={blockedReason}
                      aria-describedby={
                        blockedReason ? "prompts-summary-detail" : undefined
                      }
                      onCheckedChange={() => void activate(entry)}
                    />
                  ) : prompt.enabled ? (
                    <span className="prompt-current">
                      <Check size={13} />
                      当前使用
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`设为当前 ${prompt.name}`}
                      disabled={disabled || linkedFile}
                      title={blockedReason}
                      aria-describedby={
                        blockedReason ? "prompts-summary-detail" : undefined
                      }
                      onClick={() => void activate(entry)}
                    >
                      设为当前
                    </Button>
                  )}
                </div>
                <p className="prompt-card-description">
                  {prompt.description ||
                    prompt.content.split("\n").find((line) => line.trim()) ||
                    "暂无描述，点击标题查看正文。"}
                </p>
                <div className="prompt-card-footer">
                  <span className="prompt-card-origin">
                    {template ? "内置" : "自定义"}
                    {modified && (
                      <span
                        className="prompt-card-badge"
                        title="内容与内置模板不同，可在编辑时恢复内置内容"
                      >
                        本地已修改
                      </span>
                    )}
                    <span className="prompt-card-category">
                      {categories.find(
                        (category) => category.id === prompt.categoryId,
                      )?.name ?? "未分类"}
                    </span>
                    {prompt.enabled && isCodex && (
                      <span
                        className={`prompt-enabled-label${notInEffect ? " is-pending" : ""}`}
                      >
                        {notInEffect ? "已启用 · 未生效" : "已启用"}
                      </span>
                    )}
                  </span>
                  <div className="prompt-card-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`编辑 ${prompt.name}`}
                      disabled={disabled}
                      onClick={() => setEditor({ entry, readOnly: false })}
                    >
                      <Pencil size={14} />
                      编辑
                    </Button>
                    {saved && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`操作 ${prompt.name}`}
                            disabled={disabled}
                          >
                            <MoreHorizontal size={17} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() =>
                              setEditor({
                                entry: {
                                  ...entry,
                                  saved: false,
                                  prompt: {
                                    ...prompt,
                                    id: "",
                                    name: `${prompt.name}（副本）`,
                                    enabled: false,
                                    createdAt: undefined,
                                    updatedAt: undefined,
                                  },
                                },
                                readOnly: false,
                              })
                            }
                          >
                            复制
                          </DropdownMenuItem>
                          {!isCodex && prompt.enabled && (
                            <DropdownMenuItem
                              onSelect={() => void activate(entry)}
                            >
                              停用并清空指令文件
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            disabled={prompt.enabled}
                            onSelect={() => setRemoving(entry)}
                          >
                            {prompt.enabled ? "请先禁用后删除" : "删除"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
        {visible.length === 0 && (
          <div className="prompts-empty">
            <Search size={24} />
            <h2>
              {query
                ? "没有匹配的提示词"
                : enabledOnly
                  ? "还没有启用的提示词"
                  : "这个分类还没有提示词"}
            </h2>
            <p>
              {query
                ? "试试其他名称或描述，或清除筛选查看全部。"
                : enabledOnly
                  ? "从全部提示词中选择需要的指令，启用后会显示在这里。"
                  : "新建提示词，或在编辑时将已有提示词移入此分类。"}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setSearch("");
                setEnabledOnly(false);
                setCategoryFilter("all");
              }}
            >
              查看全部
            </Button>
          </div>
        )}
      </section>

      <Dialog
        open={showFile}
        onOpenChange={(value) => {
          if (!busy && adopting === null) setShowFile(value);
        }}
      >
        <DialogContent className="prompt-drawer">
          <DialogHeader className="text-left">
            <div className="prompt-drawer-title">
              <DialogTitle>当前指令</DialogTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label="关闭当前指令"
                disabled={busy}
                onClick={() => setShowFile(false)}
              >
                <X size={18} />
              </Button>
            </div>
            <DialogDescription>
              {target.name} 配置目录 / {target.file} · 只读
            </DialogDescription>
          </DialogHeader>
          <div className="prompt-drawer-body">
            <p className="prompt-detail-note">
              这里显示实际文件内容。写入成功不代表已有会话已重新加载，读取时机取决于{" "}
              {target.name}。
            </p>
            {loading ? (
              <p>正在读取文件…</p>
            ) : error ? (
              <p role="alert">文件预览不可用，请重试。</p>
            ) : liveIssue ? (
              <div className="prompts-empty prompt-file-issue" role="status">
                <AlertTriangle size={28} aria-hidden="true" />
                <h2>{liveIssue.title}</h2>
                <p>{liveIssue.detail}</p>
              </div>
            ) : live === null ? (
              <div className="prompts-empty">
                <FileText size={28} />
                <h2>还没有 {target.file}</h2>
                <p>启用提示词之前，不会创建这个文件。</p>
              </div>
            ) : sections ? (
              <div
                className="prompt-file-sections"
                role="group"
                aria-label={`${target.file} 当前内容`}
              >
                {sections.map((section, index) => (
                  <section
                    key={index}
                    className={`prompt-file-section is-${section.kind}`}
                  >
                    <h3>
                      {section.kind === "user"
                        ? "你的内容（Chimera 不改动）"
                        : section.kind === "managed"
                          ? `Chimera 受管区块（${managedCount} 条）`
                          : "其他工具的区块（只读）"}
                      {section.kind === "managed" &&
                        codexStatus?.state === "edited" && (
                          <span className="prompts-state-tag is-warning">
                            已手动修改
                          </span>
                        )}
                    </h3>
                    <pre tabIndex={0} className="prompt-file-content">
                      {section.text}
                    </pre>
                  </section>
                ))}
              </div>
            ) : (
              <>
                {isCodex && live && (
                  <p className="prompt-detail-note prompt-file-raw-note">
                    区块标记不完整，按原文显示。
                  </p>
                )}
                <pre
                  tabIndex={0}
                  aria-label={`${target.file} 当前内容`}
                  className="prompt-file-content"
                >
                  {live || "文件为空"}
                </pre>
              </>
            )}
          </div>
          <DialogFooter>
            {foreign && (
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => setAdopting(live)}
              >
                接管这个区块
              </Button>
            )}
            <Button
              variant="outline"
              disabled={loading || busy}
              onClick={() => void load()}
            >
              <RefreshCw size={14} />
              刷新
            </Button>
            <Button onClick={() => setShowFile(false)} disabled={busy}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        isOpen={removing !== null}
        busy={busy}
        title="删除提示词"
        message={`删除「${removing?.prompt.name || ""}」？仅删除已禁用的本地条目，不修改 ${target.file}。${removing?.template ? "内置原版仍可使用。" : ""}`}
        confirmText="确认删除"
        cancelText="取消"
        onCancel={() => {
          if (!pending.current) setRemoving(null);
        }}
        onConfirm={() => {
          if (!removing || removing.prompt.enabled) return;
          void mutate(async () => {
            await promptsApi.deletePrompt(targetApp, removing.prompt.id);
            if (mounted.current) setRemoving(null);
          });
        }}
      />
      <ConfirmDialog
        isOpen={adopting !== null}
        busy={busy}
        title="接管其他工具的区块"
        message="将把当前预览文件中其他工具写入的区块转为 Chimera 受管区块。正文与区块外内容保持不变，原库条目保留但禁用，接管内容成为启用的新条目。写入前自动备份；若文件已变化则拒绝接管。已有 Chimera 区块时请先停用其提示词。"
        checkboxRequired
        checkboxLabel="我已检查当前文件，并已停止那个工具对该文件的写入"
        confirmText="确认接管"
        cancelText="取消"
        onCancel={() => {
          if (!pending.current) setAdopting(null);
        }}
        onConfirm={(confirmed) => {
          if (!confirmed || adopting === null) return;
          const expected = adopting;
          void mutate(() => promptsApi.adoptForeignCodex(expected)).then(() => {
            if (mounted.current) setAdopting(null);
          });
        }}
      />
      <Dialog
        open={resolving}
        onOpenChange={(value) => {
          if (!busy) setResolving(value);
        }}
      >
        <DialogContent className="prompt-resolve-dialog">
          <DialogHeader className="text-left">
            <DialogTitle>处理手动修改</DialogTitle>
            <DialogDescription>
              AGENTS.md 中的 Chimera 区块与提示词库不一致。选择要保留的一份：
            </DialogDescription>
          </DialogHeader>
          <div className="prompt-resolve-options">
            <div className="prompt-resolve-option">
              <div>
                <strong>保留文件中的修改</strong>
                <p>
                  把区块中的内容存为一条新的启用提示词
                  {managedCount > 0 &&
                    `，原来启用的 ${managedCount} 条改为停用`}
                  。AGENTS.md 保持不变。
                </p>
              </div>
              <Button disabled={busy} onClick={() => resolveFile("keep_edits")}>
                保留修改
              </Button>
            </div>
            <div className="prompt-resolve-option">
              <div>
                <strong>恢复为提示词库内容</strong>
                <p>
                  {managedCount > 0
                    ? `用提示词库中已启用的 ${managedCount} 条重写这个区块，手动修改会被替换。`
                    : "提示词库中没有启用的条目，恢复会移除这个区块。"}
                  区块外的内容不变，写入前自动备份当前文件。
                </p>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => resolveFile("rewrite")}
              >
                恢复提示词库内容
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setResolving(false)}
            >
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        isOpen={writeConfirmation !== null}
        title="确认修改提示词文件"
        message={writeConfirmation?.message ?? ""}
        checkboxRequired
        checkboxLabel="我已检查目标文件，并理解整文件修改的影响"
        confirmText="确认写入"
        cancelText="取消"
        onCancel={() => finishConfirmation(false)}
        onConfirm={(confirmed) => {
          if (confirmed) finishConfirmation(true);
        }}
      />
      {showCategories && (
        <Suspense fallback={<p role="status">正在加载分类管理…</p>}>
          <PromptCategoryManager
            categories={categories}
            counts={categoryCounts}
            blocked={disabled}
            onCreate={(name) =>
              mutate(() => promptsApi.createCategory(targetApp, name))
            }
            onRename={(id, name) =>
              mutate(() => promptsApi.renameCategory(targetApp, id, name))
            }
            onDelete={(id) =>
              mutate(() => promptsApi.deleteCategory(targetApp, id))
            }
            onClose={() => {
              if (!pending.current) setShowCategories(false);
            }}
          />
        </Suspense>
      )}
      {editor && (
        <Suspense fallback={<p role="status">正在加载编辑器…</p>}>
          <PromptFormModal
            appName={target.name}
            filename={target.file}
            categories={categories}
            defaultCategoryId={
              categories.some((category) => category.id === categoryFilter)
                ? categoryFilter
                : undefined
            }
            unavailable={editorMissing}
            editingId={editor.entry?.saved ? editor.entry.prompt.id : undefined}
            initialData={
              editor.entry
                ? { ...editor.entry.prompt, enabled: editorEnabled }
                : undefined
            }
            template={editor.entry?.template}
            readOnly={editor.readOnly}
            blocked={disabled || editorMissing}
            onClose={() => {
              if (!pending.current) setEditor(null);
            }}
            onActivate={async () => {
              if (
                editor.entry &&
                (await activate({
                  ...editor.entry,
                  prompt: { ...editor.entry.prompt, enabled: editorEnabled },
                })) &&
                mounted.current
              )
                setEditor(null);
            }}
            onSave={async (id, prompt) => {
              // Keep the editable-field baseline from opening the drawer. Only
              // observed status/timestamp changes and a deleted category rebase.
              const baseline = editor.entry?.saved
                ? editor.entry.prompt
                : undefined;
              const expected = baseline
                ? {
                    ...baseline,
                    enabled: editorEnabled,
                    updatedAt: currentEditorPrompt?.updatedAt,
                    categoryId:
                      currentEditorPrompt?.categoryId === undefined &&
                      !categories.some(
                        (category) => category.id === baseline.categoryId,
                      )
                        ? undefined
                        : baseline.categoryId,
                  }
                : undefined;
              if (
                !isCodex &&
                prompt.enabled &&
                prompt.content !== editor.entry?.prompt.content &&
                !(await confirmWholeFileWrite(
                  `保存后将用修改后的「${prompt.name}」更新 ${target.name} 的 ${target.file} 整个文件。原内容会保留在提示词库中。`,
                ))
              )
                throw new Error("Write cancelled");
              const success = await mutate(() =>
                expected
                  ? promptsApi.upsertPrompt(targetApp, id, prompt, expected)
                  : promptsApi.upsertPrompt(targetApp, id, prompt),
              );
              if (!success) throw new Error("Prompt save failed");
              if (mounted.current) {
                setSearch("");
                setEnabledOnly(false);
                setCategoryFilter("all");
                setHighlightedId(id);
              }
            }}
          />
        </Suspense>
      )}
    </div>
  );
};
