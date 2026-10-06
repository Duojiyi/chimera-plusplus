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
import {
  promptsApi,
  type Prompt,
  type PromptCategory,
} from "@/lib/api/prompts";
import { bundledPromptTemplates } from "@/config/promptTemplates";
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
  { id: "openclaw", name: "OpenClaw", file: "AGENTS.md" },
  { id: "hermes", name: "Hermes", file: "SOUL.md" },
] as const;
const UNSUPPORTED_PROMPT_TOOLS =
  "Claude Desktop、Pi 和 MiniMax Code 暂不支持提示词";
type Template = (typeof bundledPromptTemplates)[number];
type Entry = { prompt: Prompt; saved: boolean; template?: Template };
type Editor = { entry?: Entry; readOnly: boolean };

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
  initialApp?: AppId;
  refreshVersion?: number;
}> = ({ initialApp = "codex", refreshVersion = 0 }) => {
  const [targetApp, setTargetApp] = useState(
    () => PROMPT_TOOLS.find((tool) => tool.id === initialApp)?.id ?? "codex",
  );
  const target = PROMPT_TOOLS.find((tool) => tool.id === targetApp)!;
  const isCodex = targetApp === "codex";
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [categories, setCategories] = useState<PromptCategory[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [showCategories, setShowCategories] = useState(false);
  const [live, setLive] = useState<string | null>(null);
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
    setLoading(true);
    setError(false);
    try {
      const [rows, content, groups] = await Promise.all([
        promptsApi.getPrompts(targetApp),
        promptsApi.getCurrentFileContent(targetApp),
        promptsApi.getCategories(targetApp),
      ]);
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
      }
    } catch {
      if (mounted.current && request === generation.current) {
        setError(true);
        setCategories([]);
        setPrompts([]);
        setLive(null);
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
    void load();
    return () => {
      generation.current++;
    };
  }, [load, refreshVersion]);
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
        const message = String(reason);
        const known = [
          "请先关闭 Codex 代理接管，再修改生效提示词。",
          "无法检查代理接管状态。",
          "AGENTS.md 必须使用 UTF-8 编码。",
          "启用的提示词不能为空。",
          "提示词内容超过大小上限。",
          "提示词文件必须为 UTF-8。",
          "提示词不存在，请刷新后重试。",
          "这条提示词已更新或被删除，请重新打开后编辑。当前草稿尚未保存。",
          "分类不存在，请刷新后重试。",
          "分类名称已存在。",
          "该分类名称为系统保留名称。",
          "分类名称需为 1–50 个字符，且不能包含控制字符。",
        ].find((text) => message.includes(text));
        toast.error(known ?? "提示词操作未完成，请检查当前状态后重试。");
        await load();
      }
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
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
  const foreign =
    isCodex && live?.includes("<!-- CODEX-X:INSTRUCTIONS:BEGIN -->");
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
  const openFile = () => {
    setShowFile(true);
    void load();
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
              {PROMPT_TOOLS.map((tool) => (
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
        className={`prompts-summary${active.length ? " has-active" : ""}`}
        aria-label="当前提示词状态"
      >
        <div className="prompts-summary-icon" aria-hidden="true">
          {active.length ? <Check size={19} /> : <FileText size={19} />}
        </div>
        <div className="prompts-summary-copy">
          {loading ? (
            <strong role="status">正在读取提示词…</strong>
          ) : error ? (
            <strong>当前状态暂不可用</strong>
          ) : (
            <strong>
              {active.length
                ? `已启用 ${active.length} 条`
                : "未启用 Chimera 提示词"}
            </strong>
          )}
          {!loading && !error && active.length > 0 && (
            <span
              className="prompts-active-names"
              title={active.map(({ prompt }) => prompt.name).join("、")}
            >
              {active.map(({ prompt }) => prompt.name).join("、")}
            </span>
          )}
          <p>
            {isCodex
              ? "多条内容合并写入，保留原有指令；修改前自动备份。"
              : "每次使用一条，应用时替换整个指令文件；原文保留在提示词库。"}
          </p>
        </div>
        <Button
          variant="ghost"
          className="prompts-file-link"
          onClick={openFile}
          disabled={loading || busy}
        >
          查看当前指令
          <ArrowUpRight size={15} />
        </Button>
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
      {foreign && (
        <div className="prompts-notice">
          <span>检测到 Codex-X 区块，原内容保持只读。</span>
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
                      disabled={disabled}
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
                      disabled={disabled}
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
                    {template
                      ? modified
                        ? "内置 · 已修改"
                        : "内置"
                      : "自定义"}
                    <span className="prompt-card-category">
                      {categories.find(
                        (category) => category.id === prompt.categoryId,
                      )?.name ?? "未分类"}
                    </span>
                    {prompt.enabled && isCodex && (
                      <span className="prompt-enabled-label">已启用</span>
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
            ) : live === null ? (
              <div className="prompts-empty">
                <FileText size={28} />
                <h2>还没有 {target.file}</h2>
                <p>启用提示词之前，不会创建这个文件。</p>
              </div>
            ) : (
              <pre
                tabIndex={0}
                aria-label={`${target.file} 当前内容`}
                className="prompt-file-content"
              >
                {live || "文件为空"}
              </pre>
            )}
          </div>
          <DialogFooter>
            {foreign && (
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => setAdopting(live)}
              >
                接管 Codex-X 区块
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
        title="接管 Codex-X 区块"
        message="将把当前预览文件中的 Codex-X 区块转为 Chimera 受管区块。正文与区块外内容保持不变，原库条目保留但禁用，接管内容成为启用的新条目。写入前自动备份；若文件已变化则拒绝接管。已有 Chimera 区块时请先禁用其提示词。"
        checkboxRequired
        checkboxLabel="我已检查当前文件，并已停止 Codex-X 对该文件的写入"
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
