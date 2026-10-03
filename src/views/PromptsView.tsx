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
  MoreHorizontal as DotsThree,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import "./PromptsView.css";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppId } from "@/lib/api/types";
import { promptsApi, type Prompt } from "@/lib/api/prompts";
import { bundledPromptTemplates } from "@/config/promptTemplates";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
const PromptFormModal = React.lazy(
  () => import("@/components/prompts/PromptFormModal"),
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

export const PromptsView: React.FC<{
  initialApp?: AppId;
  refreshVersion?: number;
}> = ({ initialApp = "codex", refreshVersion = 0 }) => {
  const [targetApp, setTargetApp] = useState(
    () => PROMPT_TOOLS.find((tool) => tool.id === initialApp)?.id ?? "codex",
  );
  const target = PROMPT_TOOLS.find((tool) => tool.id === targetApp)!;
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [live, setLive] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [editor, setEditor] = useState<Prompt | "new" | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [templateDraft, setTemplateDraft] = useState<Prompt | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<
    (typeof bundledPromptTemplates)[number] | null
  >(null);
  const [writeConfirmation, setWriteConfirmation] = useState<{
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const confirmFileWrite = () =>
    targetApp === "codex"
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => setWriteConfirmation({ resolve }));
  const [removing, setRemoving] = useState<Prompt | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(false);
    setPrompts([]);
    setLive(null);
    try {
      const [rows, content] = await Promise.all([
        promptsApi.getPrompts(targetApp),
        promptsApi.getCurrentFileContent(targetApp),
      ]);
      if (mounted.current && request === generation.current) {
        setPrompts(Object.values(rows));
        setLive(content);
      }
    } catch {
      if (mounted.current && request === generation.current) setError(true);
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, [targetApp]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [load, refreshVersion]);
  const mutate = async (action: () => Promise<unknown>) => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    try {
      await action();
      if (mounted.current) await load();
      return true;
    } catch (reason) {
      if (mounted.current) {
        const message = String(reason);
        // Only display known safe instructions, never arbitrary native errors.
        const known = [
          "请先关闭 Codex 代理接管，再修改生效提示词。",
          "无法检查代理接管状态。",
          "AGENTS.md 必须使用 UTF-8 编码。",
          "启用的提示词不能为空。",
        ].find((text) => message.includes(text));
        toast.error(
          known ?? "提示词操作失败，未确认写入成功。请检查配置状态后重试。",
        );
        await load();
      }
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const handleTogglePrompt = async (id: string) => {
    const prompt = prompts.find((item) => item.id === id);
    if (!prompt) return;
    if (targetApp !== "codex" && !(await confirmFileWrite())) return;
    void mutate(() =>
      targetApp !== "codex" && !prompt.enabled
        ? promptsApi.enablePrompt(targetApp, id)
        : promptsApi.upsertPrompt(targetApp, id, {
            ...prompt,
            enabled: !prompt.enabled,
            updatedAt: Math.floor(Date.now() / 1000),
          }),
    );
  };
  const enabledCount = prompts.filter((p) => p.enabled).length;
  const disabled = loading || busy || error || writeConfirmation !== null;
  const handleImportMd = () => {
    void mutate(async () => {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof path === "string")
        await promptsApi.importFromFile(targetApp, path);
    });
  };
  const handleCreatePrompt = () => {
    setTemplateDraft(null);
    setEditor("new");
  };

  return (
    <div className="prompts-page">
      <header className="prompts-heading">
        <div>
          <h1>提示词</h1>
          <p>把常用指令留在身边，让 {target.name} 按你的习惯工作。</p>
        </div>
        <div className="prompts-actions">
          <label>
            目标工具{" "}
            <select
              aria-label="提示词目标工具"
              value={targetApp}
              disabled={
                busy ||
                writeConfirmation !== null ||
                editor !== null ||
                removing !== null ||
                adopting !== null
              }
              onChange={(event) => {
                setTargetApp(event.target.value as typeof targetApp);
                setPreviewTemplate(null);
              }}
            >
              {PROMPT_TOOLS.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="outline"
            onClick={handleImportMd}
            disabled={disabled}
          >
            <FileText size={15} />
            导入 .md
          </Button>
          <Button onClick={handleCreatePrompt} disabled={disabled}>
            <Plus size={15} />
            新建提示词
          </Button>
        </div>
      </header>
      <p className="prompts-library-note">
        暂不支持 Claude Desktop、Pi 和 MiniMax Code 提示词。
      </p>
      {loading && <p role="status">正在读取提示词…</p>}
      {error && (
        <div className="prompts-notice" role="alert">
          <span>本地提示词暂时无法读取，仍可浏览内置模板。</span>
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
      {targetApp === "codex" &&
        live?.includes("<!-- CODEX-X:INSTRUCTIONS:BEGIN -->") && (
          <div className="prompts-notice">
            <span>
              检测到 Codex-X 区块，默认只读。接管前请停止其他工具写入。
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => setAdopting(live)}
            >
              接管 Codex-X 区块
            </Button>
          </div>
        )}
      <div className="prompts-workspace">
        <div className="prompts-library">
          <section aria-label="我的提示词">
            <div className="prompts-section-heading">
              <h2>我的提示词</h2>
              <span>
                已启用 {enabledCount} / {prompts.length}
              </span>
            </div>
            {!loading && !error && prompts.length === 0 && (
              <div className="prompts-empty">
                <FileText size={22} />
                <strong>从一条好指令开始</strong>
                <p>选择下方模板，或新建自己的提示词。保存前请检查目标文件。</p>
              </div>
            )}
            {prompts.map((item) => (
              <div className="prompt-local-row" key={item.id}>
                <Switch
                  aria-label={`启用 ${item.name}`}
                  checked={item.enabled}
                  disabled={disabled}
                  onCheckedChange={() => handleTogglePrompt(item.id)}
                />
                <button
                  className="prompt-local-copy"
                  onClick={() => setEditor(item)}
                  disabled={disabled}
                >
                  <strong>{item.name}</strong>
                  <span>{item.description || item.content.split("\n")[0]}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`操作 ${item.name}`}
                      disabled={disabled}
                    >
                      <DotsThree size={17} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditor(item)}>
                      编辑
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={item.enabled}
                      onSelect={() => setRemoving(item)}
                    >
                      {item.enabled ? "请先禁用后删除" : "删除"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </section>
          <section aria-label="内置模板">
            <div className="prompts-section-heading">
              <h2>内置模板</h2>
              <span>{bundledPromptTemplates.length} 个 · 来自 Codex-X</span>
            </div>
            <p className="prompts-section-description">
              点击预览，使用前可以自由编辑。
            </p>
            <div className="prompt-template-grid">
              {bundledPromptTemplates.map((template, index) => (
                <button
                  type="button"
                  key={template.id}
                  className="prompt-template"
                  aria-pressed={previewTemplate?.id === template.id}
                  onClick={() => setPreviewTemplate(template)}
                >
                  <span className="prompt-template-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <strong>{template.name}</strong>
                  <span>{template.description}</span>
                </button>
              ))}
            </div>
            <p className="prompts-library-note">
              模板是可编辑的本地指令，不改变模型服务的使用规则。
            </p>
          </section>
        </div>
        <section className="prompt-preview" aria-label="提示词预览">
          <header>
            <FileText size={17} />
            <div>
              <strong>
                {previewTemplate ? previewTemplate.name : target.file}
              </strong>
              <span>
                {previewTemplate
                  ? "内置模板 · 只读预览"
                  : "当前文件内容（只读）"}
              </span>
            </div>
            {previewTemplate && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPreviewTemplate(null)}
              >
                当前文件
              </Button>
            )}
          </header>
          <pre
            tabIndex={0}
            aria-label={
              previewTemplate ? "模板内容" : `${target.file} 当前内容`
            }
          >
            {previewTemplate
              ? previewTemplate.content
              : loading
                ? "正在读取文件…"
                : error
                  ? "文件预览不可用"
                  : live === null
                    ? `尚未创建 ${target.file}`
                    : live || "文件为空"}
          </pre>
          <footer>
            {previewTemplate ? (
              <>
                <span>
                  {targetApp === "codex"
                    ? "保存后手动启用，不会自动覆盖当前指令。"
                    : "非 Codex 保存也可能清空当前文件；请先备份，保存前将再次确认。"}
                </span>
                <Button
                  disabled={disabled}
                  onClick={() => {
                    setTemplateDraft({
                      id: "",
                      templateId: previewTemplate.id,
                      name: previewTemplate.name,
                      description: previewTemplate.description,
                      content: previewTemplate.content,
                      enabled: false,
                    });
                    setEditor("new");
                  }}
                >
                  使用此模板
                </Button>
              </>
            ) : (
              <>
                <ShieldCheck size={15} />
                <span>
                  启用时更新 {target.file}
                  {targetApp === "codex"
                    ? " · 写入前自动备份"
                    : " · 请先检查并备份当前文件"}
                </span>
              </>
            )}
          </footer>
        </section>
      </div>
      <ConfirmDialog
        isOpen={removing !== null}
        busy={busy}
        title="删除提示词"
        message={`删除「${removing?.name || ""}」？此操作仅删除已禁用的本地条目，不修改 ${target.file}。`}
        confirmText="确认删除"
        cancelText="取消"
        onCancel={() => {
          if (!pending.current) setRemoving(null);
        }}
        onConfirm={() => {
          if (!removing || removing.enabled) return;
          void mutate(async () => {
            await promptsApi.deletePrompt(targetApp, removing.id);
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
          void mutate(async () => {
            await promptsApi.adoptForeignCodex(expected);
          }).then(() => {
            if (mounted.current) setAdopting(null);
          });
        }}
      />
      <ConfirmDialog
        isOpen={writeConfirmation !== null}
        busy={busy}
        title="确认修改提示词文件"
        message={`此操作可能覆盖或清空 ${target.name} 的 ${target.file} 整个文件。非 Codex 后端保存禁用条目时，若没有其他启用条目也会清空文件；不保证自动备份或失败回滚。请先手动备份并停止其他工具写入。`}
        checkboxRequired
        checkboxLabel="我已备份目标文件，理解覆盖或清空风险"
        confirmText="确认写入"
        cancelText="取消"
        onCancel={() => {
          writeConfirmation?.resolve(false);
          setWriteConfirmation(null);
        }}
        onConfirm={(confirmed) => {
          if (confirmed) {
            writeConfirmation?.resolve(true);
            setWriteConfirmation(null);
          }
        }}
      />
      {editor && (
        <Suspense fallback={<p role="status">正在加载编辑器…</p>}>
          <PromptFormModal
            appId={targetApp}
            editingId={editor === "new" ? undefined : editor.id}
            initialData={
              editor === "new" ? (templateDraft ?? undefined) : editor
            }
            onClose={() => {
              if (!pending.current) setEditor(null);
            }}
            onSave={async (id, prompt) => {
              if (!(await confirmFileWrite()))
                throw new Error("Write cancelled");
              const saved = await mutate(() =>
                promptsApi.upsertPrompt(targetApp, id, prompt),
              );
              if (!saved) throw new Error("Prompt save failed");
            }}
          />
        </Suspense>
      )}
    </div>
  );
};
