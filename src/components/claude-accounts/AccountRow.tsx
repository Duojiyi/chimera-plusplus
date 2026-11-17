import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Ban,
  Copy,
  FolderTree,
  GripVertical,
  Loader2,
  Monitor,
  NotebookPen,
  Pencil,
  Play,
  Terminal,
  Trash2,
  Ellipsis,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  ClaudeCodeAccount,
  ClaudeDesktopSnapshot,
} from "@/lib/api/claudeAccounts";
import { DESKTOP_STATUS_TEXT, QuotaStrip, type QuotaState } from "./quota";
import type { SortableRowProps } from "./useSortable";

export const KIND_LABEL = {
  oauth: "订阅登录",
  setup_token: "setup-token",
  api_key: "API Key",
  desktop_only: "仅 Desktop",
} as const;

/** `someone@example.com` → `so***@example.com`, for screens others can see. */
export function maskEmail(text: string): string {
  const at = text.indexOf("@");
  if (at <= 0) return text.length > 4 ? `${text.slice(0, 2)}***` : text;
  return `${text.slice(0, Math.min(2, at))}***${text.slice(at)}`;
}

export interface AccountRowProps {
  account: ClaudeCodeAccount;
  quota?: QuotaState;
  now: number;
  /** Another change is running; nothing here can be started. */
  disabled: boolean;
  busy: string | null;
  /** Claude Code can switch to this login (Claude Desktop cannot). */
  canSwitch: boolean;
  /** A terminal can be opened on this login (Claude Code only). */
  canOpenSession: boolean;
  /** Present when the row can be dragged. */
  sortable?: SortableRowProps;
  /** Where the row stands among those that can be moved. */
  position?: { first: boolean; last: boolean };
  /** Claude Desktop page: this login's saved Desktop sign-in. */
  desktop?: {
    supported: boolean;
    apiMode?: boolean;
    snapshot?: ClaudeDesktopSnapshot;
    /** Desktop is signed in as this login right now. */
    signedInHere: boolean;
  };
  /** `card`: a tile in the grid; `row`: a line in the list. */
  variant?: "row" | "card";
  /** Hide most of the email (screen sharing). */
  hideEmail?: boolean;
  onSwitch: () => void;
  onRefresh: () => void;
  onRename: () => void;
  onNote?: () => void;
  onToggleDisabled: () => void;
  onOpenSession: () => void;
  onCopyCommands: (shell: "cmd" | "powershell") => void;
  onBind: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  onSaveDesktop: () => void;
  onSwitchDesktop: () => void;
  onPrepareDesktop: () => void;
  onOpenDesktop?: () => void;
}

/** What a token or key account says where an OAuth login shows its quota. */
function NoQuota({ account }: { account: ClaudeCodeAccount }) {
  const text = account.disabled
    ? "已停用：不读取额度"
    : account.kind === "api_key"
      ? "按量计费的 API Key，没有订阅额度"
      : account.kind === "desktop_only"
        ? "只保存了 Desktop 登录，读不到额度"
        : "长期令牌，读不到订阅额度";
  return <p className="claude-account-noquota">{text}</p>;
}

function dateText(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())}`;
}

export function AccountRow({
  account,
  quota,
  now,
  disabled,
  busy,
  canSwitch,
  canOpenSession,
  sortable,
  position,
  desktop,
  variant = "row",
  hideEmail = false,
  onSwitch,
  onRefresh,
  onRename,
  onNote,
  onToggleDisabled,
  onOpenSession,
  onCopyCommands,
  onBind,
  onDelete,
  onMove,
  onSaveDesktop,
  onSwitchDesktop,
  onPrepareDesktop,
  onOpenDesktop,
}: AccountRowProps) {
  const card = variant === "card";
  const current = desktop
    ? desktop.signedInHere && !desktop.apiMode
    : canSwitch && account.isCurrent;
  const usable = !account.unreadable && !account.disabled;
  const showQuota =
    !account.unreadable &&
    (account.kind === "oauth" ||
      (desktop && account.kind === "desktop_only")) &&
    !account.disabled;
  const snapshot = desktop?.snapshot;
  const shownName =
    hideEmail && account.name.includes("@")
      ? maskEmail(account.name)
      : account.name;
  const shownEmail = account.email
    ? hideEmail
      ? maskEmail(account.email)
      : account.email
    : null;

  const gripKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      onMove(event.key === "ArrowUp" ? -1 : 1);
    }
  };

  const lead = (
    <span className="claude-account-lead">
      {sortable ? (
        <button
          type="button"
          className="claude-account-grip"
          aria-label={`移动 ${account.name}：拖动，或按上下方向键`}
          title="拖动排序，或按上下方向键"
          disabled={disabled}
          onKeyDown={gripKey}
          {...sortable.gripProps}
        >
          <GripVertical size={14} aria-hidden="true" />
        </button>
      ) : null}
      <span className="claude-account-avatar" aria-hidden="true">
        {Array.from(account.name || account.email || "?")[0]?.toUpperCase()}
      </span>
    </span>
  );

  const tags = (
    <>
      {current ? (
        <span className="claude-account-tag" data-tone="success">
          {desktop ? "Desktop 当前使用" : "使用中"}
        </span>
      ) : null}
      {account.plan ? (
        <span className="claude-accounts-plan">{account.plan}</span>
      ) : null}
      {!desktop && account.kind !== "oauth" ? (
        <span className="claude-account-tag" data-tone="kind">
          {KIND_LABEL[account.kind]}
        </span>
      ) : null}
      {account.disabled ? (
        <span className="claude-account-tag" data-tone="muted">
          已停用
        </span>
      ) : null}
      {!desktop && account.sessionRunning ? (
        <span className="claude-account-tag" data-tone="live">
          会话中
        </span>
      ) : null}
      {!desktop &&
      account.needsRelogin &&
      !account.unreadable &&
      account.kind === "oauth" ? (
        <span className="claude-account-tag" data-tone="warning">
          需要重新登录
        </span>
      ) : null}
      {desktop && !account.unreadable ? (
        <span
          className="claude-account-tag"
          data-tone={snapshot ? "kind" : "warning"}
        >
          {snapshot
            ? "可一键切换"
            : desktop.signedInHere
              ? "登录待保存"
              : "需要 Desktop 登录"}
        </span>
      ) : null}
    </>
  );

  const meta = (
    <span className="claude-account-meta">
      {account.unreadable
        ? "无法读取（可能因系统密码重置或迁移），只能删除"
        : (shownEmail ??
          (account.kind === "oauth" ? "未读到邮箱" : "没有邮箱"))}
      {!desktop && account.fingerprint ? (
        <code title="令牌指纹（SHA-256 前 8 位）">#{account.fingerprint}</code>
      ) : null}
    </span>
  );

  const quotaBlock = showQuota ? (
    <QuotaStrip
      state={quota}
      now={now}
      label={account.name}
      remaining={Boolean(desktop)}
      statusText={desktop ? DESKTOP_STATUS_TEXT : undefined}
      onRefresh={onRefresh}
    />
  ) : account.unreadable ? (
    <span aria-hidden="true" />
  ) : (
    <NoQuota account={account} />
  );

  const switchButton =
    canSwitch && !account.isCurrent && usable ? (
      <Button
        size="sm"
        variant="outline"
        disabled={
          disabled || (account.kind === "oauth" && account.needsRelogin)
        }
        title={
          account.needsRelogin ? "这个账号需要重新登录后才能切换" : undefined
        }
        aria-label={`切换到此账号 ${account.name}`}
        onClick={onSwitch}
      >
        {busy === `switch:${account.id}` ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : (
          <ArrowLeftRight size={14} aria-hidden="true" />
        )}
        {card ? "切换" : "切换到此账号"}
      </Button>
    ) : null;

  const sessionButton =
    canOpenSession && !account.isCurrent && usable && !account.needsRelogin ? (
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        title="并行打开：在新终端里用这个账号运行 claude，不影响当前登录"
        aria-label={`并行打开 ${account.name}`}
        onClick={onOpenSession}
      >
        {busy === `session:${account.id}` ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : (
          <Terminal size={14} aria-hidden="true" />
        )}
      </Button>
    ) : null;

  const desktopIcon =
    busy === `desktop:${account.id}` ? (
      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
    ) : (
      <Monitor size={14} aria-hidden="true" />
    );
  const desktopButton =
    desktop?.supported &&
    (account.kind === "oauth" || account.kind === "desktop_only") &&
    usable ? (
      snapshot ? (
        !desktop.signedInHere || desktop.apiMode ? (
          <Button
            size="sm"
            variant="default"
            disabled={disabled}
            aria-label={`切换到此账号 ${account.name}`}
            aria-busy={busy === `desktop:${account.id}`}
            onClick={onSwitchDesktop}
          >
            {busy === `desktop:${account.id}` ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <ArrowLeftRight size={14} aria-hidden="true" />
            )}
            {busy === `desktop:${account.id}` ? "正在切换…" : "切换到此账号"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={onOpenDesktop}
            aria-label={"打开 Desktop " + account.name}
          >
            {desktopIcon}打开 Desktop
          </Button>
        )
      ) : desktop.signedInHere ? (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          title="把默认 Claude Desktop 现在的登录保存下来，以后可以切换回来"
          aria-label={`保存 Desktop 登录 ${account.name}`}
          onClick={onSaveDesktop}
        >
          {desktopIcon}
          保存 Desktop 登录
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          title="让默认 Claude Desktop 回到登录页，原来的登录先保存起来，不会被退出"
          aria-label={`用此账号登录 Desktop ${account.name}`}
          onClick={onPrepareDesktop}
        >
          {desktopIcon}
          登录并启用
        </Button>
      )
    ) : null;

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          disabled={disabled}
          aria-label={`${account.name} 的更多操作`}
          title="更多操作"
        >
          <Ellipsis size={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="claude-account-menu">
        {desktop?.signedInHere && usable ? (
          <DropdownMenuItem onSelect={onSaveDesktop}>
            <Monitor size={14} aria-hidden="true" />
            更新保存的登录
          </DropdownMenuItem>
        ) : null}
        {!account.unreadable ? (
          <DropdownMenuItem onSelect={onRename}>
            <Pencil size={14} aria-hidden="true" />
            重命名
          </DropdownMenuItem>
        ) : null}
        {!account.unreadable && onNote ? (
          <DropdownMenuItem onSelect={onNote}>
            <NotebookPen size={14} aria-hidden="true" />
            {account.note ? "编辑备注" : "加备注"}
          </DropdownMenuItem>
        ) : null}
        {sortable && position ? (
          <>
            <DropdownMenuItem
              disabled={position.first}
              onSelect={() => onMove(-1)}
            >
              <ArrowUp size={14} aria-hidden="true" />
              上移
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={position.last}
              onSelect={() => onMove(1)}
            >
              <ArrowDown size={14} aria-hidden="true" />
              下移
            </DropdownMenuItem>
          </>
        ) : null}
        {!account.unreadable ? (
          <DropdownMenuItem
            disabled={account.isCurrent && !account.disabled}
            onSelect={onToggleDisabled}
          >
            {account.disabled ? (
              <Play size={14} aria-hidden="true" />
            ) : (
              <Ban size={14} aria-hidden="true" />
            )}
            {account.disabled
              ? "启用"
              : account.isCurrent
                ? canSwitch
                  ? "停用（正在使用，先切换到别的账号）"
                  : "停用（它是 Claude Code 当前的登录，先在 Claude Code 页切换）"
                : "停用"}
          </DropdownMenuItem>
        ) : null}
        {canOpenSession && usable && !account.isCurrent ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onCopyCommands("cmd")}>
              <Copy size={14} aria-hidden="true" />
              复制启动命令（cmd）
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCopyCommands("powershell")}>
              <Copy size={14} aria-hidden="true" />
              复制启动命令（PowerShell）
            </DropdownMenuItem>
          </>
        ) : null}
        {canOpenSession && usable ? (
          <DropdownMenuItem onSelect={onBind}>
            <FolderTree size={14} aria-hidden="true" />
            绑定目录…
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="claude-account-menu-danger"
          onSelect={onDelete}
        >
          <Trash2 size={14} aria-hidden="true" />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const rowAttributes = {
    "data-id": account.id,
    "data-current": current || undefined,
    "data-disabled": account.disabled || undefined,
    "data-dragging": sortable?.dragging || undefined,
    "data-drop": sortable?.dropEdge ?? undefined,
    ...sortable?.rowProps,
  };

  if (card) {
    return (
      <li className="claude-account-card" {...rowAttributes}>
        <header className="claude-account-card-head">
          {lead}
          <div className="claude-account-identity">
            <div className="claude-account-name">
              <strong title={account.name}>{shownName}</strong>
            </div>
            {!desktop || shownName !== shownEmail || account.unreadable
              ? meta
              : null}
          </div>
        </header>
        <div className="claude-account-card-tags">{tags}</div>
        {onNote && !account.unreadable && (!desktop || account.note) ? (
          <button
            type="button"
            className="claude-account-note"
            data-empty={account.note ? undefined : "true"}
            disabled={disabled}
            title={account.note ? "编辑备注" : "加备注"}
            onClick={onNote}
          >
            <NotebookPen size={12} aria-hidden="true" />
            <span>{account.note ?? "加备注"}</span>
          </button>
        ) : null}
        <div className="claude-account-card-quota">{quotaBlock}</div>
        <footer className="claude-account-card-foot">
          <span className="claude-account-card-date">
            {desktop
              ? snapshot
                ? "登录已保存"
                : "账号已添加"
              : dateText(account.createdAt)}
          </span>
          <div className="claude-account-actions">
            {switchButton}
            {desktopButton}
            {sessionButton}
            {menu}
          </div>
        </footer>
      </li>
    );
  }

  return (
    <li className="claude-account-row" {...rowAttributes}>
      {lead}
      <div className="claude-account-identity">
        <div className="claude-account-name">
          <strong>{shownName}</strong>
          {tags}
        </div>
        {!desktop || shownName !== shownEmail || account.unreadable
          ? meta
          : null}
        {account.note && !account.unreadable ? (
          <span className="claude-account-note-line">{account.note}</span>
        ) : null}
      </div>
      {quotaBlock}
      <div className="claude-account-actions">
        {switchButton}
        {sessionButton}
        {desktopButton}
        {menu}
      </div>
    </li>
  );
}
