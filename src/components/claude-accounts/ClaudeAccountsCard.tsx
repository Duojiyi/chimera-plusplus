import "./ClaudeAccountsCard.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AppWindow,
  ArrowLeftRight,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  claudeAccountsApi,
  type ClaudeCodeAccount,
  type ClaudeCodeAccounts,
  type ClaudeDesktopProfile,
  type ClaudeQuota,
  type ClaudeQuotaWindow,
} from "@/lib/api/claudeAccounts";

export type ClaudeAccountsMode = "code" | "desktop";

export interface ClaudeAccountsCardProps {
  mode: ClaudeAccountsMode;
  /** Running inside the desktop shell (native commands available). */
  native?: boolean;
}

/** Backend errors arrive as text; drop the generic "无效输入: " prefix. */
export function errorText(cause: unknown): string {
  const text = (cause instanceof Error ? cause.message : String(cause)).trim();
  return text.replace(/^(无效输入|并发冲突):\s*/, "") || "操作失败，请重试";
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "18:40", or "11月2日 08:00" beyond today. */
export function clockText(ms: number, now: number): string {
  const date = new Date(ms);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** "2 小时 13 分后重置 · 18:40". */
export function resetText(resetsAt: string | null | undefined, now: number) {
  if (!resetsAt) return "重置时间未知";
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "重置时间未知";
  if (at <= now) return "已到重置时间";
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  const span =
    days > 0
      ? `${days} 天${hours ? ` ${hours} 小时` : ""}`
      : hours > 0
        ? `${hours} 小时${rest ? ` ${rest} 分` : ""}`
        : `${rest} 分钟`;
  return `${span}后重置 · ${clockText(at, now)}`;
}

const QUOTA_STATUS_TEXT: Partial<Record<ClaudeQuota["status"], string>> = {
  needs_relogin:
    "需要重新登录：在 Claude Code 中 /login 这个账号，再保存当前登录",
  live_expired: "当前登录已过期，请在 Claude Code 中继续使用以自动刷新",
  unavailable: "暂时无法刷新",
  not_signed_in: "未登录",
};

type QuotaState = { view?: ClaudeQuota; loading: boolean };

function QuotaMeter({
  window: w,
  now,
}: {
  window: ClaudeQuotaWindow;
  now: number;
}) {
  const used = Math.max(0, Math.min(100, w.utilization));
  const resetAt = w.resetAt ? Date.parse(w.resetAt) : Number.NaN;
  return (
    <div className="claude-quota-meter" data-kind={w.kind}>
      <div className="claude-quota-meter-head">
        <span>{w.label}</span>
        <strong>{Math.round(used)}%</strong>
      </div>
      <div
        className="claude-quota-bar"
        role="meter"
        aria-label={`${w.label}已用`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        data-level={used >= 90 ? "high" : used >= 70 ? "mid" : "low"}
      >
        <span style={{ width: `${used}%` }} />
      </div>
      <small>
        {w.reset ? (
          <span className="claude-quota-reset">
            已重置
            {Number.isFinite(resetAt) ? ` · ${clockText(resetAt, now)}` : ""}
          </span>
        ) : null}
        {w.resetsAt ? (
          resetText(w.resetsAt, now)
            .split(" · ")
            .map((part) => <span key={part}>{part}</span>)
        ) : w.reset ? null : (
          <span>重置时间未知</span>
        )}
      </small>
    </div>
  );
}

function QuotaStrip({
  state,
  now,
  onRefresh,
  label,
}: {
  state?: QuotaState;
  now: number;
  onRefresh: () => void;
  label: string;
}) {
  const view = state?.view;
  const main = view?.windows.filter((w) => w.kind !== "model") ?? [];
  const models = view?.windows.filter((w) => w.kind === "model") ?? [];
  const note = view ? QUOTA_STATUS_TEXT[view.status] : undefined;
  return (
    <div className="claude-quota" aria-label={`${label} 的额度`}>
      {main.length > 0 ? (
        <div className="claude-quota-meters">
          {main.map((w) => (
            <QuotaMeter key={w.name} window={w} now={now} />
          ))}
        </div>
      ) : null}
      {models.length > 0 ? (
        <ul className="claude-quota-models" aria-label="按模型的每周额度">
          {models.map((w) => (
            <li key={w.name} data-reset={w.reset || undefined}>
              <span>{w.label.replace(/^每周 · /, "")}</span>
              <strong>{Math.round(w.utilization)}%</strong>
              {w.reset ? (
                <span className="claude-quota-reset">已重置</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {view?.extraUsage ? (
        <p className="claude-quota-extra">
          超额用量 {view.extraUsage.used.toFixed(2)} /{" "}
          {view.extraUsage.limit.toFixed(2)} {view.extraUsage.currency}
        </p>
      ) : null}
      <div className="claude-quota-foot">
        {state?.loading ? (
          <span role="status" className="claude-quota-note">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            正在读取额度…
          </span>
        ) : note ? (
          <span className="claude-quota-note is-warning" role="status">
            {note}
          </span>
        ) : view && main.length === 0 && models.length === 0 ? (
          <span className="claude-quota-note">服务未返回额度数据</span>
        ) : view?.fetchedAt ? (
          <span className="claude-quota-note">
            更新于 {clockText(view.fetchedAt, now)}
          </span>
        ) : null}
        <button
          type="button"
          className="claude-quota-refresh"
          onClick={onRefresh}
          disabled={state?.loading}
          aria-label={`刷新 ${label} 的额度`}
          title="刷新额度"
        >
          <RotateCw size={12} aria-hidden="true" />
          刷新额度
        </button>
      </div>
    </div>
  );
}

type NameDialog =
  | { kind: "add-desktop" }
  /** `afterLoginFrom`: the saved login that was live before the guide. */
  | { kind: "save-code"; afterLoginFrom?: string | null }
  | { kind: "rename"; id: string; name: string };

type DeleteTarget = { id: string; name: string; email?: string | null };

export function ClaudeAccountsCard({
  mode,
  native = true,
}: ClaudeAccountsCardProps) {
  const headingId = useId();
  const nameInputId = useId();
  const [code, setCode] = useState<ClaudeCodeAccounts | null>(null);
  const [desktop, setDesktop] = useState<ClaudeDesktopProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [quota, setQuota] = useState<Record<string, QuotaState>>({});
  const [now, setNow] = useState(() => Date.now());
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [loginGuide, setLoginGuide] = useState(false);
  const [guideFrom, setGuideFrom] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DeleteTarget | null>(null);
  const [runningSwitch, setRunningSwitch] = useState<ClaudeCodeAccount | null>(
    null,
  );
  const mounted = useRef(true);
  const pending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);

  const readQuota = useCallback(async (id: string, force: boolean) => {
    setQuota((all) => ({ ...all, [id]: { ...all[id], loading: true } }));
    try {
      const view = await claudeAccountsApi.codeQuota(id, force);
      if (mounted.current)
        setQuota((all) => ({ ...all, [id]: { view, loading: false } }));
    } catch {
      if (mounted.current)
        setQuota((all) => ({
          ...all,
          [id]: {
            view: all[id]?.view
              ? { ...all[id].view!, status: "unavailable" }
              : {
                  status: "unavailable",
                  windows: [],
                  extraUsage: null,
                  fetchedAt: null,
                },
            loading: false,
          },
        }));
    }
  }, []);

  const load = useCallback(async () => {
    if (!native) return;
    setLoadError(null);
    try {
      if (mode === "code") {
        const result = await claudeAccountsApi.listCode();
        if (!mounted.current) return;
        setCode(result);
        if (result.supported)
          for (const account of result.accounts)
            if (!account.unreadable) void readQuota(account.id, false);
      } else {
        const result = await claudeAccountsApi.listDesktop();
        if (mounted.current) setDesktop(result);
      }
    } catch (cause) {
      if (mounted.current) setLoadError(errorText(cause));
    }
  }, [mode, native, readQuota]);

  useEffect(() => {
    void load();
  }, [load]);

  /** One mutation at a time; reloads afterwards. */
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

  const switchTo = (account: ClaudeCodeAccount, allowRunning = false) =>
    run(`switch:${account.id}`, async () => {
      const outcome = await claudeAccountsApi.switchCode(
        account.id,
        allowRunning,
      );
      if (outcome.status === "claude_running") {
        setRunningSwitch(account);
        return;
      }
      setRunningSwitch(null);
      if (outcome.status === "already_current") {
        toast.success(`「${account.name}」已经是当前账号`);
        return;
      }
      toast.success(`已切换到「${account.name}」`, {
        description: outcome.autoSavedId
          ? "原来的登录还没保存，已自动保存为新账号。新开的 Claude Code 会话将使用新账号，会话记录不受影响。"
          : "新开的 Claude Code 会话将使用新账号，会话记录不受影响。",
      });
    });

  const openNameDialog = (dialog: NameDialog) => {
    setNameValue(dialog.kind === "rename" ? dialog.name : "");
    setNameDialog(dialog);
  };

  const submitName = () => {
    const dialog = nameDialog;
    if (!dialog) return;
    const name = nameValue.trim();
    if (!name && dialog.kind !== "save-code") return;
    void run("name", async () => {
      if (dialog.kind === "rename") {
        if (mode === "code")
          await claudeAccountsApi.renameCode(dialog.id, name);
        else await claudeAccountsApi.renameDesktop(dialog.id, name);
        toast.success("已重命名");
      } else if (dialog.kind === "save-code") {
        const saved = await claudeAccountsApi.saveCurrentCode(name);
        if (dialog.afterLoginFrom && saved.id === dialog.afterLoginFrom) {
          toast.warning(`仍是「${saved.name}」，未检测到新的登录`, {
            description: "请确认已在 Claude Code 中用 /login 登录新账号。",
          });
        } else {
          toast.success(`已保存为「${saved.name}」`);
        }
      } else {
        const profile = await claudeAccountsApi.createDesktop(name);
        // The profile exists now: close the dialog before launching so a
        // failed launch cannot lead to a second profile on retry.
        setNameDialog(null);
        toast.success(`已添加「${profile.name}」，正在打开 Claude Desktop…`, {
          description: "新窗口打开后，用这个账号登录即可。",
        });
        await claudeAccountsApi.launchDesktop(profile.id);
        return;
      }
      setNameDialog(null);
    });
  };

  /** Before `claude /login` replaces the live login, keep it. Saved logins
   *  are saved again too: Claude Code rotates refresh tokens, so the vault
   *  copy may already be stale. */
  const startLoginGuide = () =>
    run("login-guide", async () => {
      let from: string | null = null;
      if (code?.live.signedIn) {
        const saved = await claudeAccountsApi.saveCurrentCode();
        if (!code.live.savedId)
          toast.success(`已先保存当前登录为「${saved.name}」`);
        from = saved.id;
      }
      setGuideFrom(from);
      setLoginGuide(true);
    });

  const confirmDelete = () => {
    const target = removing;
    if (!target) return;
    void run(`delete:${target.id}`, async () => {
      if (mode === "code") await claudeAccountsApi.deleteCode(target.id);
      else await claudeAccountsApi.deleteDesktop(target.id);
      setRemoving(null);
      toast.success(`已删除「${target.name}」`);
    });
  };

  const disabled = busy !== null;
  const title = mode === "code" ? "Claude Code 账号" : "Claude Desktop 账号";
  const description =
    mode === "code"
      ? "保存多个 Claude 登录并一键切换。所有账号共用同一个 Claude Code 配置目录，会话、历史、设置与 MCP 都保持不变；保存的登录加密存放在本机。"
      : "每个账号一个独立的 Claude Desktop 数据目录，登录互不影响，可以同时打开。";

  const headerAction =
    mode === "code" ? (
      code?.supported ? (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void startLoginGuide()}
        >
          <Plus size={14} aria-hidden="true" />
          登录新账号
        </Button>
      ) : null
    ) : (
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !native}
        onClick={() => openNameDialog({ kind: "add-desktop" })}
      >
        <Plus size={14} aria-hidden="true" />
        添加账号
      </Button>
    );

  const codeRows = code?.accounts ?? [];
  const desktopRows = desktop ?? [];

  return (
    <section className="claude-accounts-card" aria-labelledby={headingId}>
      <header className="claude-accounts-heading">
        <span className="claude-accounts-icon" aria-hidden="true">
          <UserRound size={18} />
        </span>
        <div className="claude-accounts-title">
          <h2 id={headingId}>{title}</h2>
          <p>{description}</p>
        </div>
        {headerAction}
      </header>

      {!native ? (
        <p className="claude-accounts-note">账号管理需要在桌面端使用。</p>
      ) : loadError ? (
        <div className="claude-accounts-error" role="alert">
          <span>读取账号失败：{loadError}</span>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            重试
          </Button>
        </div>
      ) : mode === "code" ? (
        code === null ? (
          <p className="claude-accounts-note" role="status">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            正在读取账号…
          </p>
        ) : (
          <>
            {!code.supported ? (
              <p className="claude-accounts-note is-warning" role="status">
                {code.unsupportedReason}
              </p>
            ) : null}
            <div
              className="claude-accounts-live"
              data-signed-in={code.live.signedIn}
            >
              <ShieldCheck size={16} aria-hidden="true" />
              <div>
                <span className="claude-accounts-eyebrow">
                  Claude Code 当前登录
                </span>
                <strong>
                  {code.live.signedIn
                    ? (code.live.email ?? "已登录（未读到邮箱）")
                    : code.liveError
                      ? "无法读取登录文件"
                      : "未登录"}
                </strong>
                {code.live.plan ? (
                  <span className="claude-accounts-plan">{code.live.plan}</span>
                ) : null}
              </div>
              {code.supported && code.live.signedIn && !code.live.savedId ? (
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => openNameDialog({ kind: "save-code" })}
                >
                  保存当前登录为账号
                </Button>
              ) : code.live.savedId ? (
                <span className="claude-accounts-saved">已保存</span>
              ) : null}
            </div>
            {code.liveError ? (
              <p className="claude-accounts-note is-warning" role="status">
                {code.liveError}
              </p>
            ) : null}
            {codeRows.length === 0 ? (
              <p className="claude-accounts-empty">
                还没有保存的账号。先在 Claude Code
                中登录，再点「保存当前登录为账号」；之后用「登录新账号」添加更多账号。
              </p>
            ) : (
              <ul
                className="claude-accounts-list"
                aria-label="已保存的 Claude Code 账号"
              >
                {codeRows.map((account) => (
                  <li
                    key={account.id}
                    className="claude-account-row"
                    data-current={account.isCurrent || undefined}
                  >
                    <span className="claude-account-avatar" aria-hidden="true">
                      {Array.from(
                        account.name || account.email || "?",
                      )[0]?.toUpperCase()}
                    </span>
                    <div className="claude-account-identity">
                      <div className="claude-account-name">
                        <strong>{account.name}</strong>
                        {account.isCurrent ? (
                          <span className="claude-account-tag">使用中</span>
                        ) : null}
                        {account.plan ? (
                          <span className="claude-accounts-plan">
                            {account.plan}
                          </span>
                        ) : null}
                        {account.needsRelogin && !account.unreadable ? (
                          <span
                            className="claude-account-tag"
                            data-tone="warning"
                          >
                            需要重新登录
                          </span>
                        ) : null}
                      </div>
                      <span className="claude-account-meta">
                        {account.unreadable
                          ? "无法读取（可能因系统密码重置或迁移），只能删除"
                          : (account.email ?? "未读到邮箱")}
                        {account.fingerprint ? (
                          <code title="令牌指纹（SHA-256 前 8 位）">
                            #{account.fingerprint}
                          </code>
                        ) : null}
                      </span>
                    </div>
                    {!account.unreadable ? (
                      <QuotaStrip
                        state={quota[account.id]}
                        now={now}
                        label={account.name}
                        onRefresh={() => void readQuota(account.id, true)}
                      />
                    ) : null}
                    <div className="claude-account-actions">
                      {!account.isCurrent &&
                      !account.unreadable &&
                      code.supported ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled || account.needsRelogin}
                          title={
                            account.needsRelogin
                              ? "这个账号需要重新登录后才能切换"
                              : undefined
                          }
                          onClick={() => void switchTo(account)}
                        >
                          {busy === `switch:${account.id}` ? (
                            <Loader2
                              size={14}
                              className="animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <ArrowLeftRight size={14} aria-hidden="true" />
                          )}
                          切换到此账号
                        </Button>
                      ) : null}
                      {!account.unreadable ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={disabled}
                          aria-label={`重命名 ${account.name}`}
                          title="重命名"
                          onClick={() =>
                            openNameDialog({
                              kind: "rename",
                              id: account.id,
                              name: account.name,
                            })
                          }
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </Button>
                      ) : null}
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={disabled}
                        aria-label={`删除 ${account.name}`}
                        title="删除"
                        onClick={() =>
                          setRemoving({
                            id: account.id,
                            name: account.name,
                            email: account.email,
                          })
                        }
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      ) : desktop === null ? (
        <p className="claude-accounts-note" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          正在读取账号…
        </p>
      ) : (
        <ul className="claude-accounts-list" aria-label="Claude Desktop 账号">
          <li className="claude-account-row is-default">
            <span className="claude-account-avatar" aria-hidden="true">
              默
            </span>
            <div className="claude-account-identity">
              <div className="claude-account-name">
                <strong>默认账号</strong>
                <span className="claude-account-tag is-muted">只读</span>
              </div>
              <span className="claude-account-meta">
                Claude Desktop
                自己的系统默认目录，未加隔离；从开始菜单打开的就是它。
              </span>
            </div>
          </li>
          {desktopRows.length === 0 ? (
            <li className="claude-accounts-empty">
              添加账号后，每个账号会有自己的独立目录，登录互不影响，可同时使用。首次登录前请先完全退出
              Claude Desktop。
            </li>
          ) : null}
          {desktopRows.map((profile) => (
            <li key={profile.id} className="claude-account-row">
              <span className="claude-account-avatar" aria-hidden="true">
                {Array.from(profile.name || "?")[0]?.toUpperCase()}
              </span>
              <div className="claude-account-identity">
                <div className="claude-account-name">
                  <strong>{profile.name}</strong>
                  <span
                    className="claude-account-tag"
                    data-tone={profile.signedIn ? "success" : "muted"}
                  >
                    {profile.signedIn
                      ? "已登录"
                      : profile.initialized
                        ? "未登录"
                        : "尚未打开"}
                  </span>
                </div>
                <span className="claude-account-meta">
                  {profile.signedIn
                    ? "可与其他账号同时打开"
                    : "首次登录前请先完全退出 Claude Desktop（包括托盘图标）"}
                </span>
              </div>
              <div className="claude-account-actions">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void run(`launch:${profile.id}`, () =>
                      claudeAccountsApi.launchDesktop(profile.id),
                    )
                  }
                >
                  {busy === `launch:${profile.id}` ? (
                    <Loader2
                      size={14}
                      className="animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <AppWindow size={14} aria-hidden="true" />
                  )}
                  打开 Claude Desktop
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`重命名 ${profile.name}`}
                  title="重命名"
                  onClick={() =>
                    openNameDialog({
                      kind: "rename",
                      id: profile.id,
                      name: profile.name,
                    })
                  }
                >
                  <Pencil size={14} aria-hidden="true" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`删除 ${profile.name}`}
                  title="删除"
                  onClick={() =>
                    setRemoving({ id: profile.id, name: profile.name })
                  }
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open && busy !== "name") setNameDialog(null);
        }}
      >
        <DialogContent className="claude-accounts-dialog">
          <DialogTitle>
            {nameDialog?.kind === "rename"
              ? "重命名账号"
              : nameDialog?.kind === "save-code"
                ? "保存当前登录"
                : "添加 Claude Desktop 账号"}
          </DialogTitle>
          <DialogDescription>
            {nameDialog?.kind === "save-code"
              ? "把 Claude Code 当前的登录加密保存到本机。名称可留空，默认使用登录邮箱。"
              : nameDialog?.kind === "add-desktop"
                ? "创建后会立即用这个账号的独立目录打开 Claude Desktop，在新窗口中登录即可。"
                : "只修改在 Chimera 中显示的名称。"}
          </DialogDescription>
          <form
            className="claude-accounts-form"
            onSubmit={(event) => {
              event.preventDefault();
              submitName();
            }}
          >
            <label htmlFor={nameInputId}>账号名称</label>
            <Input
              id={nameInputId}
              value={nameValue}
              maxLength={40}
              autoFocus
              placeholder={
                nameDialog?.kind === "save-code"
                  ? "例如：工作号"
                  : "例如：个人号"
              }
              onChange={(event) => setNameValue(event.target.value)}
            />
            <footer>
              <Button
                type="button"
                variant="outline"
                disabled={busy === "name"}
                onClick={() => setNameDialog(null)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  busy === "name" ||
                  (nameDialog?.kind !== "save-code" && !nameValue.trim())
                }
              >
                {nameDialog?.kind === "add-desktop"
                  ? "创建并打开"
                  : nameDialog?.kind === "save-code"
                    ? "保存"
                    : "确定"}
              </Button>
            </footer>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={loginGuide} onOpenChange={setLoginGuide}>
        <DialogContent className="claude-accounts-dialog">
          <DialogTitle>登录新的 Claude 账号</DialogTitle>
          <DialogDescription>
            当前登录已保存，登录新账号不会丢失它，会话记录也不受影响。
          </DialogDescription>
          <ol className="claude-accounts-steps">
            <li>
              在终端运行 <code>claude</code>，输入 <code>/login</code>
              ，用新账号完成登录。
            </li>
            <li>回到这里，点击下方按钮，把新登录保存为账号。</li>
          </ol>
          <footer className="claude-accounts-form-actions">
            <Button variant="outline" onClick={() => setLoginGuide(false)}>
              稍后
            </Button>
            <Button
              onClick={() => {
                setLoginGuide(false);
                void load().then(() =>
                  openNameDialog({
                    kind: "save-code",
                    afterLoginFrom: guideFrom,
                  }),
                );
              }}
            >
              我已登录，保存为账号
            </Button>
          </footer>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        isOpen={removing !== null}
        busy={busy?.startsWith("delete:") ?? false}
        title={`删除「${removing?.name ?? ""}」？`}
        message={
          mode === "code"
            ? `只删除 Chimera 保存的这份登录${removing?.email ? `（${removing.email}）` : ""}。不会退出 Claude Code，不影响会话记录和其他账号；以后要再用这个账号需重新登录并保存。`
            : `将删除「${removing?.name ?? ""}」在本机的 Claude Desktop 独立目录：登录状态、设置、MCP 配置与缓存。不影响系统默认的 Claude Desktop 和其他账号，也不会删除服务器上的对话。此操作不可撤销。`
        }
        confirmText="确认删除"
        cancelText="取消"
        variant="destructive"
        onCancel={() => {
          if (!busy) setRemoving(null);
        }}
        onConfirm={confirmDelete}
      />

      <ConfirmDialog
        isOpen={runningSwitch !== null}
        busy={busy?.startsWith("switch:") ?? false}
        title="Claude Code 可能正在运行"
        message={`检测到正在运行的 Claude Code（或无法确认它已退出）。它可能在稍后把原来的登录写回，导致切换失效。建议先关闭所有 Claude Code 会话再切换到「${runningSwitch?.name ?? ""}」。`}
        confirmText="仍然切换"
        cancelText="先去关闭"
        variant="info"
        onCancel={() => {
          if (!busy) setRunningSwitch(null);
        }}
        onConfirm={() => {
          if (runningSwitch) void switchTo(runningSwitch, true);
        }}
      />
    </section>
  );
}

export default ClaudeAccountsCard;
