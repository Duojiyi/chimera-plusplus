import "./ClaudeAccountsCard.css";
import "./ClaudeBindingsCard.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  FolderTree,
  Loader2,
  Plus,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  claudeAccountsApi,
  type ClaudeBinding,
  type ClaudeCodeAccount,
} from "@/lib/api/claudeAccounts";
import { BINDINGS_CHANGED_EVENT } from "./ClaudeAccountsCard";
import { errorText } from "./quota";
import { useReturnFocus } from "./useReturnFocus";
import { useStoredFlag } from "./useStoredFlag";

/** The last part of a path, for the row's title. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

const STATE_TEXT: Record<ClaudeBinding["state"], string | null> = {
  ready: null,
  missing: "账号已删除",
  disabled: "账号已停用",
};

export interface ClaudeBindingsCardProps {
  /** Running inside the desktop shell (native commands available). */
  native?: boolean;
  /** Open when the user has not chosen yet. */
  defaultOpen?: boolean;
}

/**
 * Folders bound to a saved login. A bound folder, and anything under it,
 * opens Claude with that login when started from here.
 */
export function ClaudeBindingsCard({
  native = true,
  defaultOpen = true,
}: ClaudeBindingsCardProps) {
  const headingId = useId();
  const [open, setOpen] = useStoredFlag(
    "chimera.claude.bindings.open",
    defaultOpen,
  );
  const selectId = useId();
  const [bindings, setBindings] = useState<ClaudeBinding[] | null>(null);
  const [accounts, setAccounts] = useState<ClaudeCodeAccount[]>([]);
  const [sessionsSupported, setSessionsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ path: string } | null>(null);
  const [chosen, setChosen] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  useReturnFocus(adding !== null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!native) return;
    setError(null);
    try {
      const [list, saved] = await Promise.all([
        claudeAccountsApi.listBindings(),
        claudeAccountsApi.listCode(),
      ]);
      if (!mounted.current) return;
      setBindings(Array.isArray(list) ? list : []);
      setAccounts(
        saved.supported && Array.isArray(saved.accounts) ? saved.accounts : [],
      );
      setSessionsSupported(saved.sessionsSupported);
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    }
  }, [native]);

  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener(BINDINGS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(BINDINGS_CHANGED_EVENT, reload);
  }, [load]);

  /** One change at a time; reloads afterwards. */
  const run = async (key: string, job: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(key);
    try {
      await job();
    } catch (cause) {
      if (mounted.current) toast.error(errorText(cause));
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(null);
        await load();
      }
    }
  };

  const usable = accounts.filter((a) => !a.unreadable && !a.disabled);

  const startAdd = () =>
    run("pick", async () => {
      const path = await claudeAccountsApi.pickFolder();
      if (!path) return;
      setChosen(usable[0]?.id ?? "");
      setAdding({ path });
    });

  const confirmAdd = () => {
    const target = adding;
    if (!target || !chosen) return;
    void run("bind", async () => {
      await claudeAccountsApi.setBinding(target.path, chosen);
      setAdding(null);
      toast.success(`已绑定 ${folderName(target.path)}`);
    });
  };

  const openFolder = (path: string) =>
    run(`open:${path}`, async () => {
      const launch = await claudeAccountsApi.openSession({ dir: path });
      toast.success(
        launch.accountName
          ? `已用「${launch.accountName}」在 ${folderName(path)} 打开 Claude`
          : `已在 ${folderName(path)} 打开 Claude`,
        {
          description: launch.usesDefaultLogin
            ? "这个账号就是 Claude Code 当前的登录。"
            : launch.accountName
              ? undefined
              : "这个目录没有绑定账号，用的是默认登录。",
        },
      );
    });

  const quickOpen = () =>
    run("quick", async () => {
      const path = await claudeAccountsApi.pickFolder();
      if (!path) return;
      const launch = await claudeAccountsApi.openSession({ dir: path });
      toast.success(
        launch.viaBinding
          ? `已按目录绑定，用「${launch.accountName}」打开 Claude`
          : `已在 ${folderName(path)} 打开 Claude`,
        {
          description: launch.viaBinding
            ? undefined
            : "这个目录没有绑定账号，用的是默认登录。",
        },
      );
    });

  const disabled = busy !== null;

  return (
    <section
      className="claude-accounts-card claude-bindings-card"
      aria-labelledby={headingId}
    >
      <header className="claude-accounts-heading">
        <span className="claude-accounts-icon" aria-hidden="true">
          <FolderTree size={18} />
        </span>
        <div className="claude-accounts-title">
          <h2 id={headingId}>目录绑定</h2>
          <p>
            给项目目录指定账号。从这里打开 Claude
            时自动用对应账号，子目录继承；不改你的终端和环境变量。
          </p>
        </div>
        {native && open && bindings !== null && sessionsSupported ? (
          <div className="claude-bindings-actions">
            {sessionsSupported ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => void quickOpen()}
              >
                <FolderOpen size={14} aria-hidden="true" />
                选择目录并打开 Claude
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || usable.length === 0}
              title={usable.length === 0 ? "先保存一个账号" : undefined}
              onClick={() => void startAdd()}
            >
              <Plus size={14} aria-hidden="true" />
              绑定目录
            </Button>
          </div>
        ) : null}
        <button
          type="button"
          className="claude-card-toggle"
          aria-expanded={open}
          title={open ? "收起" : "展开"}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown size={16} aria-hidden="true" />
          <span className="sr-only">{open ? "收起" : "展开"}目录绑定</span>
        </button>
      </header>

      {!native ? (
        <p className="claude-accounts-note">目录绑定需要在桌面端使用。</p>
      ) : !open ? null : error ? (
        <div className="claude-accounts-error" role="alert">
          <span>读取目录绑定失败：{error}</span>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            重试
          </Button>
        </div>
      ) : bindings === null ? (
        <p className="claude-accounts-note" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          正在读取…
        </p>
      ) : !sessionsSupported ? (
        <p className="claude-accounts-note">
          目录绑定要靠并行会话来打开，目前只支持 Windows。
        </p>
      ) : bindings.length === 0 ? (
        <p className="claude-accounts-empty">
          还没有绑定的目录。把常用的项目目录绑定到某个账号，以后在这里一点就用对的账号打开
          Claude。
        </p>
      ) : (
        <ul className="claude-bindings-list" aria-label="已绑定的目录">
          {bindings.map((binding) => {
            const stateText = STATE_TEXT[binding.state];
            const canOpen =
              sessionsSupported &&
              binding.state === "ready" &&
              !binding.pathMissing;
            return (
              <li key={binding.path} className="claude-binding-row">
                <span className="claude-binding-icon" aria-hidden="true">
                  <FolderTree size={15} />
                </span>
                <div className="claude-binding-path">
                  <strong>{folderName(binding.path)}</strong>
                  <code title={binding.path}>{binding.path}</code>
                  {binding.pathMissing ? (
                    <span className="claude-account-tag" data-tone="warning">
                      目录不存在
                    </span>
                  ) : null}
                </div>
                <div className="claude-binding-account">
                  <select
                    aria-label={`${folderName(binding.path)} 使用的账号`}
                    value={binding.accountId}
                    disabled={disabled}
                    onChange={(event) =>
                      void run(`rebind:${binding.path}`, async () => {
                        await claudeAccountsApi.setBinding(
                          binding.path,
                          event.target.value,
                        );
                        toast.success("已更换绑定的账号");
                      })
                    }
                  >
                    {binding.state === "missing" ? (
                      <option value={binding.accountId}>（账号已删除）</option>
                    ) : null}
                    {accounts
                      .filter(
                        (a) =>
                          !a.unreadable &&
                          (!a.disabled || a.id === binding.accountId),
                      )
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                          {a.disabled ? "（已停用）" : ""}
                        </option>
                      ))}
                  </select>
                  {stateText ? (
                    <span className="claude-account-tag" data-tone="warning">
                      {stateText}
                    </span>
                  ) : null}
                </div>
                <div className="claude-account-actions">
                  {sessionsSupported ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled || !canOpen}
                      title={
                        canOpen ? undefined : "账号不可用或目录不存在，无法打开"
                      }
                      aria-label={`在 ${folderName(binding.path)} 打开 Claude`}
                      onClick={() => void openFolder(binding.path)}
                    >
                      {busy === `open:${binding.path}` ? (
                        <Loader2
                          size={14}
                          className="animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Terminal size={14} aria-hidden="true" />
                      )}
                      打开 Claude
                    </Button>
                  ) : null}
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={`解除 ${folderName(binding.path)} 的绑定`}
                    title="解除绑定"
                    onClick={() =>
                      void run(`unbind:${binding.path}`, async () => {
                        await claudeAccountsApi.removeBinding(binding.path);
                        toast.success(
                          `已解除 ${folderName(binding.path)} 的绑定`,
                        );
                      })
                    }
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={adding !== null}
        onOpenChange={(open) => {
          if (!open && busy !== "bind") setAdding(null);
        }}
      >
        <DialogContent className="claude-accounts-dialog">
          <DialogTitle>绑定目录</DialogTitle>
          <DialogDescription>
            从 Chimera 在这个目录（以及它的子目录）打开 Claude
            时，用下面选的账号。
          </DialogDescription>
          <form
            className="claude-accounts-form"
            onSubmit={(event) => {
              event.preventDefault();
              confirmAdd();
            }}
          >
            <p className="claude-binding-picked">
              <FolderTree size={14} aria-hidden="true" />
              <code>{adding?.path}</code>
            </p>
            <label htmlFor={selectId}>使用的账号</label>
            <select
              id={selectId}
              className="claude-binding-select"
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
            >
              {usable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.email ? `（${a.email}）` : ""}
                </option>
              ))}
            </select>
            <footer>
              <Button
                type="button"
                variant="outline"
                disabled={busy === "bind"}
                onClick={() => setAdding(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy === "bind" || !chosen}>
                绑定
              </Button>
            </footer>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default ClaudeBindingsCard;
