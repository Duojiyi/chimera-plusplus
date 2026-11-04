import { Loader2, RotateCw } from "lucide-react";
import type { ClaudeQuota, ClaudeQuotaWindow } from "@/lib/api/claudeAccounts";

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

export const QUOTA_STATUS_TEXT: Partial<Record<ClaudeQuota["status"], string>> =
  {
    needs_relogin:
      "需要重新登录：在 Claude Code 中 /login 这个账号，再保存当前登录",
    live_expired: "当前登录已过期，请在 Claude Code 中继续使用以自动刷新",
    unavailable: "暂时无法刷新",
    not_signed_in: "未登录",
  };

/** Claude Desktop reads with the app's own sign-in and never renews it. */
export const DESKTOP_STATUS_TEXT: Partial<
  Record<ClaudeQuota["status"], string>
> = {
  live_expired: "登录已过期：打开一次这个账号的 Claude Desktop 会自动续期",
  unavailable: "暂时无法读取额度",
  not_signed_in: "未登录",
};

export type QuotaState = {
  view?: ClaudeQuota;
  loading: boolean;
  /** Claude Desktop only: from the account's profile. */
  email?: string | null;
  plan?: string | null;
};

export function QuotaMeter({
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

export function QuotaStrip({
  state,
  now,
  onRefresh,
  label,
  statusText = QUOTA_STATUS_TEXT,
}: {
  state?: QuotaState;
  now: number;
  onRefresh: () => void;
  label: string;
  statusText?: Partial<Record<ClaudeQuota["status"], string>>;
}) {
  const view = state?.view;
  const main = view?.windows.filter((w) => w.kind !== "model") ?? [];
  const models = view?.windows.filter((w) => w.kind === "model") ?? [];
  const note = view ? statusText[view.status] : undefined;
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
