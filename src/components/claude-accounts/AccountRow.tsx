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
import { QuotaStrip, type QuotaState } from "./quota";
import type { SortableRowProps } from "./useSortable";

export const KIND_LABEL = {
  oauth: "订阅登录",
  setup_token: "setup-token",
  api_key: "API Key",
} as const;

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
    snapshot?: ClaudeDesktopSnapshot;
    /** Desktop is signed in as this login right now. */
    signedInHere: boolean;
  };
  onSwitch: () => void;
  onRefresh: () => void;
  onRename: () => void;
  onToggleDisabled: () => void;
  onOpenSession: () => void;
  onCopyCommands: (shell: "cmd" | "powershell") => void;
  onBind: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  onSaveDesktop: () => void;
  onSwitchDesktop: () => void;
  onPrepareDesktop: () => void;
}

/** What a token or key account says where an OAuth login shows its quota. */
function NoQuota({ account }: { account: ClaudeCodeAccount }) {
  const text = account.disabled
    ? "已停用：不读取额度"
    : account.kind === "api_key"
      ? "按量计费的 API Key，没有订阅额度"
      : "长期令牌，读不到订阅额度";
  return <p className="claude-account-noquota">{text}</p>;
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
  onSwitch,
  onRefresh,
  onRename,
  onToggleDisabled,
  onOpenSession,
  onCopyCommands,
  onBind,
  onDelete,
  onMove,
  onSaveDesktop,
  onSwitchDesktop,
  onPrepareDesktop,
}: AccountRowProps) {
  const current = canSwitch && account.isCurrent;
  const usable = !account.unreadable && !account.disabled;
  const showQuota =
    !account.unreadable && account.kind === "oauth" && !account.disabled;
  const snapshot = desktop?.snapshot;

  const gripKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      onMove(event.key === "ArrowUp" ? -1 : 1);
    }
  };

  return (
    <li
      className="claude-account-row"
      data-id={account.id}
      data-current={current || undefined}
      data-disabled={account.disabled || undefined}
      data-dragging={sortable?.dragging || undefined}
      data-drop={sortable?.dropEdge ?? undefined}
      {...sortable?.rowProps}
    >
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

      <div className="claude-account-identity">
        <div className="claude-account-name">
          <strong>{account.name}</strong>
          {current ? <span className="claude-account-tag">使用中</span> : null}
          {account.plan ? (
            <span className="claude-accounts-plan">{account.plan}</span>
          ) : null}
          {account.kind !== "oauth" ? (
            <span className="claude-account-tag" data-tone="kind">
              {KIND_LABEL[account.kind]}
            </span>
          ) : null}
          {account.disabled ? (
            <span className="claude-account-tag" data-tone="muted">
              已停用
            </span>
          ) : null}
          {account.sessionRunning ? (
            <span className="claude-account-tag" data-tone="live">
              会话中
            </span>
          ) : null}
          {account.needsRelogin &&
          !account.unreadable &&
          account.kind === "oauth" ? (
            <span className="claude-account-tag" data-tone="warning">
              需要重新登录
            </span>
          ) : null}
          {desktop && snapshot ? (
            <span
              className="claude-account-tag"
              data-tone={snapshot.isCurrent ? "success" : "kind"}
            >
              {snapshot.isCurrent ? "默认 Desktop 在用" : "Desktop 登录已保存"}
            </span>
          ) : null}
        </div>
        <span className="claude-account-meta">
          {account.unreadable
            ? "无法读取（可能因系统密码重置或迁移），只能删除"
            : (account.email ??
              (account.kind === "oauth" ? "未读到邮箱" : "没有邮箱"))}
          {account.fingerprint ? (
            <code title="令牌指纹（SHA-256 前 8 位）">
              #{account.fingerprint}
            </code>
          ) : null}
        </span>
      </div>

      {showQuota ? (
        <QuotaStrip
          state={quota}
          now={now}
          label={account.name}
          onRefresh={onRefresh}
        />
      ) : account.unreadable ? (
        <span aria-hidden="true" />
      ) : (
        <NoQuota account={account} />
      )}

      <div className="claude-account-actions">
        {canSwitch && !account.isCurrent && usable ? (
          <Button
            size="sm"
            variant="outline"
            disabled={
              disabled || (account.kind === "oauth" && account.needsRelogin)
            }
            title={
              account.needsRelogin
                ? "这个账号需要重新登录后才能切换"
                : undefined
            }
            aria-label={`切换到此账号 ${account.name}`}
            onClick={onSwitch}
          >
            {busy === `switch:${account.id}` ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <ArrowLeftRight size={14} aria-hidden="true" />
            )}
            切换到此账号
          </Button>
        ) : null}
        {canOpenSession &&
        !account.isCurrent &&
        usable &&
        !account.needsRelogin ? (
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
        ) : null}
        {desktop?.supported && account.kind === "oauth" && usable ? (
          snapshot ? (
            !snapshot.isCurrent ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                aria-label={`切换默认 Desktop 到 ${account.name}`}
                onClick={onSwitchDesktop}
              >
                {busy === `desktop:${account.id}` ? (
                  <Loader2
                    size={14}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Monitor size={14} aria-hidden="true" />
                )}
                切换默认 Desktop
              </Button>
            ) : null
          ) : desktop.signedInHere ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              title="把默认 Claude Desktop 现在的登录保存下来，以后可以切换回来"
              aria-label={`保存 Desktop 登录 ${account.name}`}
              onClick={onSaveDesktop}
            >
              <Monitor size={14} aria-hidden="true" />
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
              {busy === `desktop:${account.id}` ? (
                <Loader2
                  size={14}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Monitor size={14} aria-hidden="true" />
              )}
              用此账号登录 Desktop
            </Button>
          )
        ) : null}

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
            {!account.unreadable ? (
              <DropdownMenuItem onSelect={onRename}>
                <Pencil size={14} aria-hidden="true" />
                重命名
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
      </div>
    </li>
  );
}
