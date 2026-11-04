import { Eye, EyeOff, LayoutGrid, List, RotateCw, Search } from "lucide-react";
import type { ClaudeCodeAccount } from "@/lib/api/claudeAccounts";
import type { QuotaState } from "./quota";

export type AccountFilter =
  "all" | "current" | "oauth" | "token" | "disabled" | "relogin";
export type AccountSort = "custom" | "quota" | "name" | "added";

const FILTERS: { id: AccountFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "current", label: "使用中" },
  { id: "oauth", label: "订阅登录" },
  { id: "token", label: "令牌 / API Key" },
  { id: "disabled", label: "已停用" },
  { id: "relogin", label: "需要重新登录" },
];

const SORTS: { id: AccountSort; label: string }[] = [
  { id: "custom", label: "自定义顺序" },
  { id: "quota", label: "剩余额度最多" },
  { id: "name", label: "名称" },
  { id: "added", label: "最近添加" },
];

function matches(account: ClaudeCodeAccount, filter: AccountFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "current":
      return account.isCurrent;
    case "oauth":
      return account.kind === "oauth";
    case "token":
      return account.kind !== "oauth";
    case "disabled":
      return account.disabled;
    case "relogin":
      return account.kind === "oauth" && account.needsRelogin;
  }
}

/** What is left of the tightest window (5 hours or weekly), 0–100; -1 unknown. */
export function remainingQuota(state?: QuotaState): number {
  const windows = state?.view?.windows.filter((w) => w.kind !== "model") ?? [];
  if (windows.length === 0) return -1;
  return 100 - Math.max(...windows.map((w) => w.utilization));
}

/** The accounts the toolbar's search, filter and order leave, in that order. */
export function visibleAccounts(
  accounts: ClaudeCodeAccount[],
  {
    query,
    filter,
    sort,
    quotaOf,
  }: {
    query: string;
    filter: AccountFilter;
    sort: AccountSort;
    quotaOf: (account: ClaudeCodeAccount) => QuotaState | undefined;
  },
): ClaudeCodeAccount[] {
  const needle = query.trim().toLowerCase();
  const shown = accounts.filter(
    (account) =>
      matches(account, filter) &&
      (!needle ||
        [account.name, account.email, account.note, account.plan]
          .filter(Boolean)
          .some((text) => text!.toLowerCase().includes(needle))),
  );
  if (sort === "custom") return shown;
  const sorted = [...shown];
  if (sort === "name")
    sorted.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  else if (sort === "added")
    sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  else
    sorted.sort(
      (a, b) => remainingQuota(quotaOf(b)) - remainingQuota(quotaOf(a)),
    );
  return sorted;
}

export function filterCount(
  accounts: ClaudeCodeAccount[],
  filter: AccountFilter,
): number {
  return accounts.filter((account) => matches(account, filter)).length;
}

export interface AccountsToolbarProps {
  accounts: ClaudeCodeAccount[];
  query: string;
  onQuery: (query: string) => void;
  filter: AccountFilter;
  onFilter: (filter: AccountFilter) => void;
  sort: AccountSort;
  onSort: (sort: AccountSort) => void;
  grid: boolean;
  onGrid: (grid: boolean) => void;
  hideEmail: boolean;
  onHideEmail: (hide: boolean) => void;
  refreshing: boolean;
  onRefreshAll: () => void;
}

/** Search, filter, order and view of a list of saved logins. */
export function AccountsToolbar({
  accounts,
  query,
  onQuery,
  filter,
  onFilter,
  sort,
  onSort,
  grid,
  onGrid,
  hideEmail,
  onHideEmail,
  refreshing,
  onRefreshAll,
}: AccountsToolbarProps) {
  return (
    <div
      className="claude-accounts-toolbar"
      role="toolbar"
      aria-label="账号列表工具"
    >
      <label className="claude-accounts-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder="搜索账号、邮箱或备注"
          aria-label="搜索账号"
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      <select
        className="claude-accounts-select"
        aria-label="筛选"
        value={filter}
        onChange={(event) => onFilter(event.target.value as AccountFilter)}
      >
        {FILTERS.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}（{filterCount(accounts, item.id)}）
          </option>
        ))}
      </select>
      <select
        className="claude-accounts-select"
        aria-label="排序"
        value={sort}
        onChange={(event) => onSort(event.target.value as AccountSort)}
      >
        {SORTS.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>
      <div className="claude-accounts-toolbar-icons">
        <div className="claude-accounts-view" role="group" aria-label="视图">
          <button
            type="button"
            aria-pressed={grid}
            aria-label="卡片视图"
            title="卡片视图"
            onClick={() => onGrid(true)}
          >
            <LayoutGrid size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-pressed={!grid}
            aria-label="列表视图"
            title="列表视图"
            onClick={() => onGrid(false)}
          >
            <List size={14} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className="claude-accounts-icon-button"
          aria-pressed={hideEmail}
          aria-label={hideEmail ? "显示邮箱" : "隐藏邮箱"}
          title={hideEmail ? "显示邮箱" : "隐藏邮箱（共享屏幕时）"}
          onClick={() => onHideEmail(!hideEmail)}
        >
          {hideEmail ? (
            <EyeOff size={14} aria-hidden="true" />
          ) : (
            <Eye size={14} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="claude-accounts-icon-button"
          aria-label="刷新全部额度"
          title="刷新全部额度"
          disabled={refreshing}
          onClick={onRefreshAll}
        >
          <RotateCw
            size={14}
            className={refreshing ? "animate-spin" : undefined}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
}
