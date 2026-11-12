import React, { useEffect, useRef, useState } from "react";
import {
  Copy,
  ArrowUpRight,
  Loader2 as CircleNotch,
  X,
  Plus,
  ShieldCheck,
  UserRound,
  Pencil,
  Trash2,
  AlertTriangle as Warning,
  RotateCw as ArrowsClockwise,
  Info,
  Search,
  LayoutGrid,
  List as ListIcon,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { settingsApi } from "@/lib/api/settings";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { AccountDetailsDialog } from "@/components/official-accounts/AccountDetailsDialog";
import "./OfficialAccountsView.css";
import "@/theme/v3/accounts.css";
import {
  isAccountsDesignPreview,
  sampleAccounts,
  sampleQuotas,
} from "./OfficialAccountsView.designSamples";
import {
  officialAccountsApi,
  type OfficialAccountDto,
  type OfficialQuota,
  type StartedLoginDto,
} from "@/lib/api/officialAccounts";

const UNREADABLE_MESSAGE =
  "无法读取（可能因系统密码重置或配置迁移），请重新登录或删除";
const QUOTA_FAILED = "额度查询失败，请刷新重试";
const NO_WINDOWS = "服务未返回额度数据";

/** Backend messages read "中文 (English)"; the interface is Chinese only. */
function displayError(message: string): string {
  const text = message.trim();
  const open = text.lastIndexOf(" (");
  if (open > 0 && text.endsWith(")")) {
    const head = text.slice(0, open);
    const tail = text.slice(open + 2, -1);
    if (/[一-鿿]/.test(head) && !/[一-鿿]/.test(tail)) return head;
  }
  return text;
}

const errorText = (cause: unknown) =>
  displayError(cause instanceof Error ? cause.message : String(cause));

const pad = (value: number) => String(value).padStart(2, "0");
const clockTime = (ms: number) => {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const exactTime = (ms: number) => {
  const date = new Date(ms);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clockTime(ms)}`;
};

type QuotaWindow = {
  label: string;
  seconds: number;
  /** Share already used, 0-100. Bars and labels show this (spec §1.2). */
  used: number;
  remaining: number;
  resetsAt: number | null;
};

function tierSeconds(name: string): number | null {
  if (name === "five_hour") return 5 * 3_600;
  if (name === "seven_day") return 7 * 86_400;
  const match = /^(\d{1,4})_(hour|day)$/.exec(name);
  return match
    ? Number(match[1]) * (match[2] === "day" ? 86_400 : 3_600)
    : null;
}

function windowLabel(seconds: number | null): string {
  if (!seconds) return "其他";
  return seconds % 86_400 === 0
    ? `${seconds / 86_400} 天`
    : `${Math.round(seconds / 3_600)} 小时`;
}

/** Every window the service returned, shortest first. */
function quotaWindows(quota: OfficialQuota | undefined): QuotaWindow[] {
  if (!quota?.success) return [];
  return quota.tiers
    .filter((tier) => Number.isFinite(tier.utilization))
    .map((tier) => {
      const seconds = tierSeconds(tier.name);
      const resetsAt = tier.resetsAt ? Date.parse(tier.resetsAt) : Number.NaN;
      return {
        label: windowLabel(seconds),
        seconds: seconds ?? Number.POSITIVE_INFINITY,
        used: Math.max(0, Math.min(100, tier.utilization)),
        remaining: Math.max(0, Math.min(100, 100 - tier.utilization)),
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
      };
    })
    .sort((a, b) => a.seconds - b.seconds);
}

function percentText(remaining: number): string {
  const digits =
    remaining > 0 && remaining < 10 && !Number.isInteger(remaining) ? 1 : 0;
  return `${Number(remaining.toFixed(digits))}%`;
}

function resetText(
  resetsAt: number | null,
  now: number,
  compact: boolean,
): string {
  if (resetsAt === null) return "重置时间未知";
  if (resetsAt <= now) return "已到重置时间";
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (days)
    return compact || !hours
      ? `${days} 天后重置`
      : `${days} 天 ${hours} 小时后重置`;
  if (hours)
    return compact || !rest
      ? `${hours} 小时后重置`
      : `${hours} 小时 ${rest} 分钟后重置`;
  return `${minutes} 分钟后重置`;
}

const PLAN_LABELS: Record<string, string> = {
  free: "免费版",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

function planLabel(planType?: string | null): string | null {
  const raw = planType?.trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[-_\s]+/g, "");
  return Object.prototype.hasOwnProperty.call(PLAN_LABELS, key)
    ? PLAN_LABELS[key]
    : raw;
}

/** The line's own name unless it is just the default "ChatGPT · email". */
function accountTitle(account: OfficialAccountDto): string {
  const line = account.lineName?.trim();
  if (line && line !== account.displayName) return line;
  if (account.unreadable) return account.displayName;
  return account.email || account.displayName;
}

function accountSubtitle(account: OfficialAccountDto): string | null {
  const title = accountTitle(account);
  const subtitle = account.unreadable ? account.displayName : account.email;
  return subtitle && subtitle !== title ? subtitle : null;
}

function avatarText(account: OfficialAccountDto): string {
  const source = account.email || accountTitle(account);
  return Array.from(source.trim())[0]?.toUpperCase() ?? "?";
}

type AccountRow = {
  account: OfficialAccountDto;
  title: string;
  subtitle: string | null;
  plan: string | null;
  quota?: OfficialQuota;
  windows: QuotaWindow[];
  needsRelogin: boolean;
  accessExpired: boolean;
  pending: boolean;
  error?: string;
};

interface OfficialAccountsViewProps {
  onAccountSwitched?: () => void;
}

const REFRESH_STORAGE_KEY = "chimera.officialAccounts.refreshMinutes";
const REFRESH_MINUTES = [0, 1, 5, 15, 30] as const;

function readRefreshMinutes(): number {
  try {
    const saved = localStorage.getItem(REFRESH_STORAGE_KEY);
    const minutes = saved === null ? 5 : Number(saved);
    return saved !== "" && REFRESH_MINUTES.some((value) => value === minutes)
      ? minutes
      : 5;
  } catch {
    return 5;
  }
}

/** Which quotas a list load also queries: entry and manual refresh query
 * every account, the timer only Codex's current one, focus none. */
type QuotaScope = "all" | "current" | "none";

// A disabled account is held out of use: no quota reads (design: 停用).
const queryable = (account: OfficialAccountDto) =>
  !account.needsRelogin && !account.accessExpired && !account.disabled;

function PlanTag({ plan }: { plan: string | null }) {
  return plan ? <span className="account-plan">{plan}</span> : null;
}

function QuotaMeter({
  window: quota,
  now,
  compact = false,
}: {
  window: QuotaWindow;
  now: number;
  compact?: boolean;
}) {
  const value = percentText(quota.used);
  const reset = resetText(quota.resetsAt, now, compact);
  const exact = quota.resetsAt === null ? null : exactTime(quota.resetsAt);
  // Bar length is the used share: accent < 90, warn >= 90, bad when spent.
  const level =
    quota.used >= 100 ? "bad" : quota.used >= 90 ? "warn" : undefined;
  return (
    <div
      className={compact ? "quota-meter is-compact" : "quota-meter"}
      data-low={level ? "true" : undefined}
      data-level={level}
    >
      <span className="quota-meter-label">{quota.label}</span>
      <span className="quota-meter-used">
        已用 <strong className="quota-meter-value">{value}</strong>
      </span>
      <small
        className="quota-meter-reset"
        title={compact && exact ? `${exact} 重置` : undefined}
      >
        {compact || !exact ? (
          reset
        ) : (
          <>
            {reset} · {/* Date and time wrap as one unit ("10月13日 13:55"). */}
            <span className="quota-meter-exact">{exact}</span>
          </>
        )}
      </small>
      <div
        className="quota-meter-bar"
        role="progressbar"
        aria-label={`${quota.label}额度已用`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(quota.used)}
        aria-valuetext={`已用 ${value}`}
      >
        <span style={{ width: `${quota.used}%` }} />
      </div>
    </div>
  );
}

const designPreview = isAccountsDesignPreview();
const PREVIEW_REFUSAL = "设计预览不会修改本机账号";

type AccountFilter = "all" | "usable" | "relogin" | "disabled";
type AccountSort = "default" | "week" | "name" | "recent";
const VIEW_STORAGE_KEY = "chimera.officialAccounts.view";

function readView(): "grid" | "list" {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function relativeTime(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** The longest window's used share, for "按周额度" sorting. */
function weekUsed(row: { windows: QuotaWindow[] }): number {
  const last = row.windows[row.windows.length - 1];
  return last ? last.used : Number.POSITIVE_INFINITY;
}

/** Ascending; accounts with no reading (infinite) stay last, in their order. */
function compareWeekUsed(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

let loginStartupPending = false;

export const OfficialAccountsView: React.FC<OfficialAccountsViewProps> = ({
  onAccountSwitched,
}) => {
  const [accounts, setAccounts] = useState<OfficialAccountDto[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const accountsGeneration = useRef(0);
  const accountsRequest = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  const [refreshMinutes, setRefreshMinutes] = useState(readRefreshMinutes);
  const [listStale, setListStale] = useState(false);
  const addAccountRef = useRef<HTMLButtonElement>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const restoreDialogFocus = (event: Event) => {
    event.preventDefault();
    const trigger = dialogTriggerRef.current;
    if (trigger?.isConnected && !trigger.matches(":disabled")) trigger.focus();
    else addAccountRef.current?.focus();
  };
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quotas, setQuotas] = useState<Record<string, OfficialQuota>>({});
  const [quotaErrors, setQuotaErrors] = useState<Record<string, string>>({});
  const [pendingQuotas, setPendingQuotas] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Relative reset times stay current without another request.
  const [, setClock] = useState(0);
  const now = Date.now();

  // Device Code Login State (03B)
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginMethod, setLoginMethod] = useState<"browser" | "device">(
    "browser",
  );
  const [startingLogin, setStartingLogin] = useState(false);
  const [activeLogin, setActiveLogin] = useState<StartedLoginDto | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [pollWarning, setPollWarning] = useState<string | null>(null);
  const [importingLogin, setImportingLogin] = useState(false);
  const [expiresInSeconds, setExpiresInSeconds] = useState(15 * 60);

  // Refs for poll cleanup and concurrency safety
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const loginGeneration = useRef(0);
  const activeFlowRef = useRef<string | null>(null);
  const startingLoginRef = useRef(false);

  // Switch Confirmation Dialog State (03C)
  const [confirmTarget, setConfirmTarget] = useState<AccountRow | null>(null);
  const [switching, setSwitching] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<AccountRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [editTarget, setEditTarget] = useState<AccountRow | null>(null);
  const [sort, setSort] = useState<AccountSort>("default");
  const [view, setView] = useState<"grid" | "list">(readView);
  const changeView = (next: "grid" | "list") => {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable; the choice still holds this visit.
    }
  };
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [batchRemoving, setBatchRemoving] = useState(false);
  const [batchResult, setBatchResult] = useState<{
    removed: { key: string; title: string }[];
    failed: { key: string; title: string; error: string }[];
  } | null>(null);
  useLightweightCloseBlocker(
    startingLogin ||
      loginModalOpen ||
      importingLogin ||
      switching ||
      removing ||
      batchRemoving ||
      Boolean(confirmTarget) ||
      Boolean(removeTarget),
  );

  const rows: AccountRow[] = accounts.map((account) => {
    const quota = quotas[account.key];
    // Only a rejected login asks for a new one; an expired access token is
    // renewed by Codex when the account is used.
    const needsRelogin =
      account.needsRelogin || quota?.credentialStatus === "expired";
    return {
      account,
      title: accountTitle(account),
      subtitle: accountSubtitle(account),
      plan: planLabel(account.planType),
      quota,
      windows: quotaWindows(quota),
      needsRelogin,
      accessExpired:
        !needsRelogin && Boolean(account.accessExpired || quota?.accessExpired),
      pending: pendingQuotas.has(account.key),
      error: quotaErrors[account.key],
    };
  });

  const current = rows.find((row) => row.account.isCurrent) ?? null;
  const selectedLine = rows.find((row) => row.account.isSelected) ?? null;
  const liveState = accounts[0]?.liveState;
  const quotaFailed = rows.some((row) => row.error !== undefined);
  const queriedTimes = rows
    .map((row) => (row.quota?.success ? row.quota.queriedAt : null))
    .filter((time): time is number => typeof time === "number");
  // The oldest shown result: every value on the page is at least this fresh.
  const oldestQueriedAt = queriedTimes.length
    ? Math.min(...queriedTimes)
    : null;

  const clearPollTimer = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  };

  const applyQuotaResults = (
    keys: string[],
    results: PromiseSettledResult<OfficialQuota>[],
  ) => {
    const fresh: Record<string, OfficialQuota> = {};
    const failed: Record<string, string> = {};
    results.forEach((result, index) => {
      const key = keys[index];
      if (result.status === "rejected") {
        failed[key] = QUOTA_FAILED;
        return;
      }
      const quota = result.value;
      // Keep last known values on transient failure, but never mask an
      // explicit expired credential response from the service.
      if (
        quota.success ||
        quota.accessExpired ||
        quota.credentialStatus === "expired"
      )
        fresh[key] = quota;
      if (!quota.success && !quota.accessExpired)
        failed[key] =
          quota.credentialStatus === "expired"
            ? QUOTA_FAILED
            : displayError(quota.error ?? "") || QUOTA_FAILED;
    });
    setQuotas((previous) => ({ ...previous, ...fresh }));
    setQuotaErrors((previous) => {
      const next = { ...previous };
      for (const key of keys) {
        if (failed[key] === undefined) delete next[key];
        else next[key] = failed[key];
      }
      return next;
    });
  };

  const loadAccounts = async ({
    background = false,
    scope = "all",
    force = false,
  }: {
    background?: boolean;
    scope?: QuotaScope;
    /** The user pressed 刷新额度: ask for new readings, not stored ones. */
    force?: boolean;
  } = {}): Promise<void> => {
    // Background ticks are skipped; account mutations still get a fresh reload
    // after the current request, so an older list cannot hide a new account.
    const waitingGeneration = accountsGeneration.current;
    while (accountsRequest.current) {
      if (background) return;
      await accountsRequest.current;
      if (waitingGeneration !== accountsGeneration.current) return;
    }
    const generation = ++accountsGeneration.current;
    const isLatest = () => generation === accountsGeneration.current;
    const request = (async () => {
      try {
        if (!background) setListLoading(true);
        if (designPreview) {
          // Fixtures only: the browser preview has no account service.
          const stamp = Date.now();
          setAccounts(sampleAccounts(stamp));
          setQuotas(sampleQuotas(stamp));
          setLoadError(null);
          return;
        }
        if (scope === "all") setRefreshing(true);
        const list = await officialAccountsApi.list();
        if (!isLatest()) return;
        setAccounts(list);
        setLoadError(null);
        setListStale(false);
        setListLoading(false);
        const keys = new Set(list.map((account) => account.key));
        const keep = <T,>(previous: Record<string, T>) =>
          Object.fromEntries(
            Object.entries(previous).filter(([key]) => keys.has(key)),
          );
        setQuotas(keep);
        setQuotaErrors(keep);
        setSelected((previous) => {
          const next = new Set([...previous].filter((key) => keys.has(key)));
          return next.size === previous.size ? previous : next;
        });
        const targets = list.filter(
          (account) =>
            queryable(account) &&
            (scope === "all" || (scope === "current" && account.isCurrent)),
        );
        if (!targets.length) return;
        const targetKeys = targets.map((account) => account.key);
        setPendingQuotas(new Set(targetKeys));
        const results = await Promise.allSettled(
          targetKeys.map((key) =>
            force
              ? officialAccountsApi.getQuota(key, true)
              : officialAccountsApi.getQuota(key),
          ),
        );
        if (!isLatest()) return;
        applyQuotaResults(targetKeys, results);
      } catch (cause) {
        if (!isLatest()) return;
        if (background) {
          setListStale(true);
          return;
        }
        const message = errorText(cause);
        setLoadError(
          message.includes("undefined") && message.includes("invoke")
            ? "暂未连接本机账号服务，请在桌面应用中重试"
            : message || "请稍后重试",
        );
      } finally {
        if (isLatest()) {
          setListLoading(false);
          setRefreshing(false);
          setPendingQuotas(new Set());
        }
      }
    })();
    accountsRequest.current = request;
    await request;
    if (accountsRequest.current === request) accountsRequest.current = null;
  };

  /** On demand for one account, outside the list request queue. */
  const queryQuota = async (key: string) => {
    setPendingQuotas((previous) => new Set(previous).add(key));
    const results = await Promise.allSettled([
      officialAccountsApi.getQuota(key),
    ]);
    if (!alive.current) return;
    applyQuotaResults([key], results);
    setPendingQuotas((previous) => {
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  };

  const refreshRef = useRef(loadAccounts);
  useEffect(() => {
    refreshRef.current = loadAccounts;
  });

  useEffect(() => {
    if (!refreshMinutes) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden")
        // The chosen interval is the freshness the user asked for, so the
        // stored reading is not good enough (the backend still debounces).
        void refreshRef.current({
          background: true,
          scope: "current",
          force: true,
        });
    }, refreshMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [refreshMinutes]);

  useEffect(() => {
    // Returning to the window re-reads the local list only, no network.
    const refreshList = () => {
      if (document.visibilityState !== "hidden")
        void refreshRef.current({ background: true, scope: "none" });
    };
    const timer = window.setInterval(
      () => setClock((tick) => tick + 1),
      60_000,
    );
    window.addEventListener("focus", refreshList);
    document.addEventListener("visibilitychange", refreshList);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshList);
      document.removeEventListener("visibilitychange", refreshList);
    };
  }, []);

  useEffect(() => {
    alive.current = true;
    void loadAccounts();
    return () => {
      alive.current = false;
      accountsGeneration.current++;
      loginGeneration.current++;
      clearPollTimer();
      if (activeFlowRef.current) {
        void officialAccountsApi
          .cancelDeviceLogin(activeFlowRef.current)
          .catch(() => {});
        activeFlowRef.current = null;
      }
    };
  }, []);

  // Format seconds to mm:ss
  const formatCountdown = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins} 分 ${secs < 10 ? "0" : ""}${secs} 秒后过期`;
  };

  // Each attempt owns its timers and requests. A cancelled attempt cannot close
  // a newer dialog or overwrite its status when a slow IPC response arrives.
  const handleStartLogin = async (method: "browser" | "device" = "browser") => {
    if (startingLoginRef.current) return;
    if (loginStartupPending) {
      toast.error("上一登录仍在准备或取消中，请稍后重试");
      return;
    }
    loginStartupPending = true;
    setLoginMethod(method);
    if (!loginModalOpen)
      dialogTriggerRef.current = document.activeElement as HTMLElement | null;
    startingLoginRef.current = true;
    const generation = ++loginGeneration.current;
    const isCurrent = () => generation === loginGeneration.current;
    const previousFlow = activeFlowRef.current;
    activeFlowRef.current = null;
    clearPollTimer();
    setStartingLogin(true);
    setLoginModalOpen(true);
    setActiveLogin(null);
    setLoginError(null);
    setPollWarning(null);

    const failLogin = (message: string) => {
      if (!isCurrent()) return;
      loginGeneration.current++;
      clearPollTimer();
      setLoginError(displayError(message));
      setPollWarning(null);
      startingLoginRef.current = false;
      setStartingLogin(false);
      if (activeFlowRef.current) {
        void officialAccountsApi
          .cancelDeviceLogin(activeFlowRef.current)
          .catch(() => {});
        activeFlowRef.current = null;
      }
    };
    try {
      if (previousFlow)
        await officialAccountsApi
          .cancelDeviceLogin(previousFlow)
          .catch(() => {});
      if (!isCurrent()) return;
      const started = await (method === "browser"
        ? officialAccountsApi.startBrowserLogin()
        : officialAccountsApi.startDeviceLogin());
      if (!isCurrent()) {
        await officialAccountsApi
          .cancelDeviceLogin(started.flowId)
          .catch(() => {});
        return;
      }
      activeFlowRef.current = started.flowId;
      setActiveLogin(started);
      const parsedExpiry = Date.parse(started.expiresAt);
      const deadline =
        started.expiresInSeconds !== undefined
          ? Date.now() + started.expiresInSeconds * 1000
          : Number.isFinite(parsedExpiry)
            ? parsedExpiry
            : Date.now() + 900_000;
      const updateCountdown = () => {
        const remaining = Math.max(
          0,
          Math.ceil((deadline - Date.now()) / 1000),
        );
        setExpiresInSeconds(remaining);
        if (!remaining)
          failLogin(
            method === "device"
              ? "一次性代码已过期，请重新获取代码。"
              : "浏览器登录已过期，请重新登录。",
          );
      };
      updateCountdown();
      if (!isCurrent()) return;
      countdownTimerRef.current = setInterval(updateCountdown, 1000);
      let polling = false;
      let consecutiveErrors = 0;
      pollTimerRef.current = setInterval(async () => {
        if (polling || !isCurrent()) return;
        polling = true;
        try {
          const result = await officialAccountsApi.pollDeviceLogin(
            started.flowId,
          );
          if (!isCurrent()) return;
          consecutiveErrors = 0;
          setPollWarning(null);
          if (result.status === "completed") {
            loginGeneration.current++;
            clearPollTimer();
            activeFlowRef.current = null;
            setLoginModalOpen(false);
            setActiveLogin(null);
            toast.success("官方账号已添加，登录凭据仅保存在本机");
            await loadAccounts();
            onAccountSwitched?.();
          } else if (
            result.status === "expired" ||
            result.status === "failed"
          ) {
            failLogin(result.error || "授权未完成，请重新登录。");
          }
        } catch (cause) {
          if (!isCurrent()) return;
          const message = errorText(cause);
          consecutiveErrors++;
          if (consecutiveErrors >= 3)
            failLogin("连续 3 次无法获取授权状态：" + message);
          else
            setPollWarning(
              "暂时无法获取授权状态，正在重试（" + consecutiveErrors + "/3）",
            );
        } finally {
          polling = false;
        }
      }, 2500);
    } catch (cause) {
      failLogin(errorText(cause));
    } finally {
      startingLoginRef.current = false;
      loginStartupPending = false;
      setStartingLogin(false);
    }
  };

  const handleCancelLogin = async () => {
    loginGeneration.current++;
    clearPollTimer();
    const flow = activeFlowRef.current;
    activeFlowRef.current = null;
    setActiveLogin(null);
    setLoginError(null);
    setLoginModalOpen(false);
    if (flow) await officialAccountsApi.cancelDeviceLogin(flow).catch(() => {});
  };

  const handleImportLogin = async () => {
    if (importingLogin) return;
    setImportingLogin(true);
    try {
      await officialAccountsApi.saveCurrentLogin();
      toast.success("已导入本机 Codex 登录");
      await loadAccounts();
      onAccountSwitched?.();
    } catch (cause) {
      toast.error("未能导入本机登录", { description: errorText(cause) });
    } finally {
      setImportingLogin(false);
    }
  };

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制${label}`);
    } catch {
      toast.error("复制失败，请选中文本后手动复制");
    }
  };

  const handleOpenBrowser = async (url: string) => {
    try {
      await settingsApi.openExternal(url);
    } catch {
      toast.error("无法打开浏览器，请复制地址后访问");
    }
  };

  const openSwitch = (row: AccountRow, trigger: HTMLElement) => {
    dialogTriggerRef.current = trigger;
    setConfirmTarget(row);
  };

  const handlePerformSwitch = async () => {
    if (!confirmTarget) return;
    try {
      setSwitching(true);
      await officialAccountsApi.switchAccount(confirmTarget.account.key);
      toast.success(
        `已切换到 ${confirmTarget.title}，请重启已打开的 Codex 以使用新账号`,
      );
      setConfirmTarget(null);
      await loadAccounts();
      if (onAccountSwitched) onAccountSwitched();
    } catch (cause) {
      toast.error("切换账号失败", { description: errorText(cause) });
    } finally {
      setSwitching(false);
    }
  };

  const handleRemoveAccount = async () => {
    if (!removeTarget) return;
    try {
      setRemoving(true);
      await officialAccountsApi.removeAccount(removeTarget.account.key);
      toast.success(`已删除账号 ${removeTarget.title}`);
      setRemoveTarget(null);
      await loadAccounts();
      if (onAccountSwitched) onAccountSwitched();
    } catch (cause) {
      toast.error("删除账号失败", { description: errorText(cause) });
    } finally {
      setRemoving(false);
    }
  };

  const handleBatchRemove = async (keys: string[]) => {
    if (!keys.length || batchRemoving) return;
    const titles = new Map(rows.map((row) => [row.account.key, row.title]));
    const name = (key: string) => titles.get(key) ?? key;
    setBatchConfirm(false);
    setBatchRemoving(true);
    try {
      const result = await officialAccountsApi.removeAccounts(keys);
      setBatchResult({
        removed: result.removed.map((key) => ({ key, title: name(key) })),
        failed: result.failed.map((item) => ({
          key: item.key,
          title: name(item.key),
          error: item.error,
        })),
      });
      setSelected(new Set(result.failed.map((item) => item.key)));
      await loadAccounts();
      if (result.removed.length) onAccountSwitched?.();
    } catch (cause) {
      toast.error("批量删除没有完成，账号均未删除", {
        description: errorText(cause),
      });
    } finally {
      setBatchRemoving(false);
    }
  };

  const cliMissing = loginError?.includes("未找到 Codex CLI") ?? false;
  const busyLogin = importingLogin || startingLogin || loginModalOpen;

  const rowQuota = (row: AccountRow) => {
    const { account } = row;
    if (account.unreadable)
      return (
        <p className="account-quota-note is-warning">{UNREADABLE_MESSAGE}</p>
      );
    if (row.needsRelogin)
      return <p className="account-quota-note">重新登录后可查询额度</p>;
    if (row.accessExpired)
      return (
        <p className="account-quota-note">
          {account.isCurrent
            ? "令牌已过期 · Codex 下次使用时续期"
            : "令牌已过期 · 切换后由 Codex 续期"}
        </p>
      );
    if (row.quota?.success)
      return row.windows.length ? (
        <div className="account-quota-meters" title="剩余额度">
          {row.windows.map((meter, index) => (
            <QuotaMeter
              key={`${meter.label}-${index}`}
              window={meter}
              now={now}
              compact
            />
          ))}
        </div>
      ) : (
        <p className="account-quota-note">{NO_WINDOWS}</p>
      );
    if (row.pending)
      return (
        <p className="account-quota-note" role="status">
          额度查询中…
        </p>
      );
    if (row.error !== undefined)
      return <p className="account-quota-note is-warning">{row.error}</p>;
    return (
      <p className="account-quota-note">
        尚未查询额度
        <button
          type="button"
          className="account-quota-query"
          onClick={() => void queryQuota(account.key)}
        >
          查询
        </button>
      </p>
    );
  };

  const currentQuota = (row: AccountRow) => {
    // Codex is signed in to this very account, so its live login repairs it.
    if (row.account.unreadable)
      return (
        <div className="account-current-message">
          <p>
            已保存的登录无法读取。Codex 正在使用这个账号，导入本机登录即可修复。
          </p>
          <Button
            size="sm"
            variant="outline"
            className="account-current-action"
            disabled={busyLogin}
            onClick={() => void handleImportLogin()}
          >
            导入本机登录
          </Button>
        </div>
      );
    if (row.needsRelogin)
      return <p className="account-current-message">重新登录后可查询额度</p>;
    if (row.accessExpired)
      return (
        <p className="account-current-message">
          令牌已过期，Codex 下次使用时会自动续期，之后即可查询额度
        </p>
      );
    if (row.quota?.success)
      return row.windows.length ? (
        <>
          <div className="account-current-meters">
            {row.windows.map((meter, index) => (
              <QuotaMeter
                key={`${meter.label}-${index}`}
                window={meter}
                now={now}
              />
            ))}
          </div>
          {typeof row.quota.queriedAt === "number" && (
            <small className="account-current-checked">
              查询于 {clockTime(row.quota.queriedAt)}
            </small>
          )}
        </>
      ) : (
        <p className="account-current-message">{NO_WINDOWS}</p>
      );
    if (row.pending)
      return (
        <div className="account-current-meters is-loading" role="status">
          <span className="sr-only">正在查询额度…</span>
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </div>
      );
    return (
      <p className="account-current-message">
        {row.error ?? "尚未查询额度，可点击下方“刷新”"}
      </p>
    );
  };

  const usableRows = rows.filter(
    (row) =>
      !row.needsRelogin && !row.account.disabled && !row.account.unreadable,
  );
  const counts: Record<AccountFilter, number> = {
    all: rows.length,
    usable: usableRows.length,
    relogin: rows.filter((row) => row.needsRelogin).length,
    disabled: rows.filter((row) => row.account.disabled).length,
  };
  const query = search.trim().toLocaleLowerCase();
  const groups = [
    ...new Set(
      rows
        .map((row) => row.account.groupName?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const shownRows = rows
    .filter((row) =>
      filter === "all"
        ? true
        : filter === "usable"
          ? usableRows.includes(row)
          : filter === "relogin"
            ? row.needsRelogin
            : Boolean(row.account.disabled),
    )
    .filter(
      (row) => groupFilter === "all" || row.account.groupName === groupFilter,
    )
    .filter(
      (row) =>
        !query ||
        [
          row.title,
          row.subtitle ?? "",
          row.account.email ?? "",
          ...(row.account.tags ?? []),
          row.account.note ?? "",
        ]
          .join("\n")
          .toLocaleLowerCase()
          .includes(query),
    );
  if (sort !== "default")
    shownRows.sort((a, b) =>
      sort === "week"
        ? compareWeekUsed(weekUsed(a), weekUsed(b))
        : sort === "name"
          ? a.title.localeCompare(b.title, "zh-CN")
          : (b.account.lastUsedAt ?? 0) - (a.account.lastUsedAt ?? 0),
    );
  const selectedRows = rows.filter((row) => selected.has(row.account.key));
  const toggleSelected = (key: string, checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });

  const statusChip = (row: AccountRow) => {
    const { account } = row;
    if (account.unreadable)
      return <span className="account-chip is-bad">无法读取</span>;
    if (row.needsRelogin)
      return (
        <span className="account-status account-chip is-bad">
          <Warning size={11} aria-hidden="true" />
          需要重新登录
        </span>
      );
    if (account.disabled)
      return <span className="account-chip is-muted">已停用</span>;
    if (account.isCurrent)
      return <span className="account-current-tag account-chip">使用中</span>;
    return <span className="account-chip is-ok">备用</span>;
  };

  return (
    <div
      className={`official-accounts-page${designPreview ? " is-design-preview" : ""}`}
    >
      <header className="accounts-heading">
        <div>
          <h1>官方账号</h1>
          <p className="accounts-subtitle">
            {rows.length > 0 ? (
              <>
                <span>{rows.length} 个账号</span>
                <span>{counts.usable} 个可用</span>
                <span>
                  {refreshMinutes
                    ? `额度每 ${refreshMinutes} 分钟自动刷新`
                    : "额度自动刷新已关闭"}
                </span>
              </>
            ) : (
              "保存多个 ChatGPT 账号，查看额度并一键切换。"
            )}
          </p>
        </div>
        <div className="accounts-header-actions">
          <Button
            variant="ghost"
            className="accounts-text-action"
            disabled={designPreview || busyLogin}
            title={
              designPreview ? PREVIEW_REFUSAL : "用一次性代码在浏览器中授权"
            }
            onClick={() => void handleStartLogin("device")}
          >
            设备码登录
          </Button>
          {rows.length > 0 && (
            <Button
              variant="outline"
              aria-label="刷新"
              title="重新查询全部账号的额度"
              disabled={refreshing}
              onClick={() => void loadAccounts({ force: true })}
            >
              <ArrowsClockwise
                size={14}
                aria-hidden="true"
                className={refreshing ? "animate-spin" : undefined}
              />
              刷新额度
            </Button>
          )}
          <Button
            variant="outline"
            aria-label="导入本机登录"
            title={
              designPreview ? PREVIEW_REFUSAL : "保存 Codex 当前已登录的账号"
            }
            disabled={designPreview || busyLogin}
            onClick={() => void handleImportLogin()}
          >
            {importingLogin ? "正在导入…" : "导入"}
          </Button>
          {/* With no account yet, the empty card holds the only add action. */}
          {(rows.length > 0 || loadError) && (
            <Button
              ref={addAccountRef}
              aria-label="添加官方账号"
              title={designPreview ? PREVIEW_REFUSAL : undefined}
              onClick={() => void handleStartLogin()}
              disabled={designPreview || startingLogin}
            >
              <Plus size={14} aria-hidden="true" />
              {startingLogin ? "正在准备登录…" : "添加账号"}
            </Button>
          )}
        </div>
      </header>
      {listLoading && rows.length === 0 && !loadError && (
        <div className="accounts-notice" role="status">
          <CircleNotch size={14} className="animate-spin" />
          正在读取本机保存的账号…
        </div>
      )}
      {loadError && !listLoading && (
        <div className="accounts-notice is-error" role="alert">
          <Warning size={16} />
          <div>
            <strong>无法读取已保存的账号</strong>
            <p>{loadError}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadAccounts()}
          >
            重新加载
          </Button>
        </div>
      )}
      {liveState === "unsaved" && (
        <div className="accounts-banner" role="status">
          <Info size={16} />
          <div>
            <strong>Codex 当前登录的账号还没有保存</strong>
            <p>导入后，可以随时从这里切换回这个账号。</p>
          </div>
          <Button
            size="sm"
            disabled={busyLogin}
            onClick={() => void handleImportLogin()}
          >
            {importingLogin ? "正在导入…" : "导入本机登录"}
          </Button>
        </div>
      )}
      {liveState === "mismatch" && (
        <div className="accounts-banner is-warning" role="status">
          <Warning size={16} />
          <div>
            <strong>Codex 当前没有使用所选账号</strong>
            <p>
              {selectedLine
                ? `线路选的是「${selectedLine.title}」，但 Codex 中的登录不是它。重新应用后，Codex 改用这个账号。`
                : "Codex 中的登录与所选线路不一致。"}
            </p>
          </div>
          {selectedLine &&
            (selectedLine.needsRelogin ? (
              <Button
                size="sm"
                disabled={startingLogin || switching}
                onClick={() => void handleStartLogin()}
              >
                重新登录
              </Button>
            ) : selectedLine.account.disabled ? (
              <span className="account-chip is-muted">
                已停用，启用后可应用
              </span>
            ) : (
              <Button
                size="sm"
                disabled={startingLogin || switching}
                onClick={(event) =>
                  openSwitch(selectedLine, event.currentTarget)
                }
              >
                重新应用
              </Button>
            ))}
        </div>
      )}
      {liveState === "third_party" && !current && rows.length > 0 && (
        <p className="accounts-route-note">
          <Info size={14} />
          Codex 正在使用第三方线路。切换到下方任一账号后，Codex 改用官方登录。
        </p>
      )}
      {!listLoading && !loadError && rows.length === 0 && (
        <section className="accounts-empty">
          <div className="accounts-empty-icon">
            <UserRound size={28} strokeWidth={1.5} />
          </div>
          <h2>连接第一个官方账号</h2>
          <p>
            在浏览器中登录 ChatGPT，返回后即可添加账号。
            <br />
            已在 Codex 中登录？也可以用“导入本机登录”直接保存。
          </p>
          <Button
            ref={addAccountRef}
            onClick={() => void handleStartLogin()}
            disabled={startingLogin}
          >
            <Plus size={16} />
            {startingLogin ? "正在准备登录…" : "登录并添加账号"}
          </Button>
        </section>
      )}
      {rows.length > 0 && (
        <>
          <div className="accounts-toolbar">
            <label className="accounts-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索账号"
                placeholder="搜索账号、邮箱或标签"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div
              className="accounts-segment"
              role="group"
              aria-label="按状态筛选"
            >
              {(
                [
                  ["all", "全部"],
                  ["usable", "可用"],
                  ["relogin", "需重新登录"],
                  ["disabled", "已停用"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                >
                  {label}
                  <span>{counts[id]}</span>
                </button>
              ))}
            </div>
            <span className="accounts-toolbar-spacer" />
            {groups.length > 0 && (
              <select
                className="accounts-select"
                aria-label="按分组筛选"
                value={groupFilter}
                onChange={(event) => setGroupFilter(event.target.value)}
              >
                <option value="all">全部分组</option>
                {groups.map((group) => (
                  <option key={group} value={group}>
                    {group}
                  </option>
                ))}
              </select>
            )}
            <select
              className="accounts-select"
              aria-label="排序"
              value={sort}
              onChange={(event) => setSort(event.target.value as AccountSort)}
            >
              <option value="default">按线路顺序</option>
              <option value="week">按周额度</option>
              <option value="recent">按最近使用</option>
              <option value="name">按名称</option>
            </select>
            <div
              className="accounts-view-toggle"
              role="group"
              aria-label="视图"
            >
              <button
                type="button"
                aria-label="网格视图"
                aria-pressed={view === "grid"}
                onClick={() => changeView("grid")}
              >
                <LayoutGrid size={14} />
              </button>
              <button
                type="button"
                aria-label="列表视图"
                aria-pressed={view === "list"}
                onClick={() => changeView("list")}
              >
                <ListIcon size={14} />
              </button>
            </div>
          </div>
          {selectedRows.length > 0 && (
            <div
              className="accounts-batch-bar"
              role="region"
              aria-label="批量操作"
            >
              <strong>已选 {selectedRows.length} 项</strong>
              <Button
                variant="ghost"
                size="sm"
                className="is-danger"
                disabled={designPreview || batchRemoving}
                title={designPreview ? PREVIEW_REFUSAL : undefined}
                onClick={() => setBatchConfirm(true)}
              >
                <Trash2 size={13} aria-hidden="true" />
                批量删除
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="accounts-batch-cancel"
                onClick={() => setSelected(new Set())}
              >
                取消选择
              </Button>
            </div>
          )}
          {(quotaFailed || listStale) && (
            <p className="accounts-refresh-error" role="status">
              <Warning size={13} aria-hidden="true" />
              {quotaFailed
                ? "部分额度未更新，已显示的额度可能不是最新值。可手动刷新重试。"
                : "账号状态未更新，显示的可能不是最新信息。可手动刷新重试。"}
            </p>
          )}
          <section
            className={`accounts-list is-${view}`}
            aria-label="已保存的官方账号"
          >
            {shownRows.map((row) => {
              const { account } = row;
              const checked = selected.has(account.key);
              return (
                <article
                  className="account-row"
                  key={account.providerId || account.key}
                  data-current={account.isCurrent}
                  data-attention={row.needsRelogin || undefined}
                  data-disabled={account.disabled || undefined}
                  data-checked={checked || undefined}
                >
                  <div className="account-card-head">
                    <div
                      className="account-avatar"
                      data-unreadable={account.unreadable || undefined}
                      aria-hidden="true"
                    >
                      {account.unreadable ? (
                        <Warning size={14} />
                      ) : (
                        avatarText(account)
                      )}
                    </div>
                    <div className="account-identity">
                      <div className="account-title">
                        <strong title={row.title}>{row.title}</strong>
                      </div>
                      <div className="account-meta">
                        <small title={row.subtitle ?? undefined}>
                          {row.subtitle ?? "OpenAI 官方"}
                        </small>
                        <PlanTag plan={row.plan} />
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      className="account-select"
                      aria-label={`选择 ${row.title}`}
                      checked={checked}
                      onChange={(event) =>
                        toggleSelected(account.key, event.target.checked)
                      }
                    />
                  </div>
                  <div className="account-status-row">
                    {statusChip(row)}
                    <div
                      className="account-row-actions"
                      data-role="card-actions"
                    >
                      {account.disabled ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="account-primary-action"
                          disabled={designPreview}
                          onClick={() =>
                            void officialAccountsApi
                              .setDisabled(account.key, false)
                              .then(() => loadAccounts({ scope: "none" }))
                              .catch((cause) =>
                                toast.error("启用失败", {
                                  description: errorText(cause),
                                }),
                              )
                          }
                        >
                          启用
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="account-primary-action"
                          disabled={startingLogin || switching}
                          onClick={(event) => {
                            if (row.needsRelogin) void handleStartLogin();
                            else openSwitch(row, event.currentTarget);
                          }}
                        >
                          {row.needsRelogin
                            ? "重新登录"
                            : account.isCurrent
                              ? "重新应用"
                              : "切换"}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="account-edit"
                        aria-label={"编辑" + row.title}
                        title={
                          designPreview
                            ? PREVIEW_REFUSAL
                            : "备注、标签、分组与停用"
                        }
                        disabled={designPreview || account.unreadable}
                        onClick={() => setEditTarget(row)}
                      >
                        <Pencil size={13} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="account-remove"
                        aria-label={"删除" + row.title}
                        title={designPreview ? PREVIEW_REFUSAL : "删除账号"}
                        disabled={designPreview || removing}
                        onClick={(event) => {
                          dialogTriggerRef.current = event.currentTarget;
                          setRemoveTarget(row);
                        }}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                  <div className="account-row-quota">{rowQuota(row)}</div>
                  {account.note ? (
                    <p className="account-note" title={account.note}>
                      {account.note}
                    </p>
                  ) : null}
                  <div className="account-card-foot">
                    <span className="account-tags">
                      {(account.tags ?? []).slice(0, 3).map((tag) => (
                        <span key={tag} className="account-tag">
                          #{tag}
                        </span>
                      ))}
                    </span>
                    {account.lastUsedAt ? (
                      <time
                        className="account-last-used"
                        title={`最近使用 ${exactTime(account.lastUsedAt)}`}
                      >
                        {relativeTime(account.lastUsedAt, now)}
                      </time>
                    ) : null}
                  </div>
                </article>
              );
            })}
            {shownRows.length === 0 && (
              <div className="accounts-no-match">
                <p>没有符合筛选条件的账号。</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setFilter("all");
                    setGroupFilter("all");
                    setSearch("");
                  }}
                >
                  查看全部
                </Button>
              </div>
            )}
            {view === "grid" && (
              <button
                type="button"
                className="account-add-tile"
                disabled={designPreview || startingLogin}
                title={designPreview ? PREVIEW_REFUSAL : undefined}
                onClick={() => void handleStartLogin()}
              >
                <span className="account-add-icon" aria-hidden="true">
                  <Plus size={16} />
                </span>
                <strong>添加账号</strong>
                <small>在浏览器中登录 ChatGPT</small>
              </button>
            )}
          </section>
          {batchResult && (
            <section
              className="accounts-batch-result"
              aria-label="批量删除结果"
            >
              <header>
                <h2>批量删除结果</h2>
                <span
                  className={`account-chip ${batchResult.failed.length ? "is-warn" : "is-ok"}`}
                >
                  {batchResult.removed.length} 成功
                  {batchResult.failed.length
                    ? ` · ${batchResult.failed.length} 失败`
                    : ""}
                </span>
              </header>
              <ul>
                {batchResult.removed.map((item) => (
                  <li key={item.key} className="is-ok">
                    <strong>{item.title}</strong>
                    <small>已删除</small>
                  </li>
                ))}
                {batchResult.failed.map((item) => (
                  <li key={item.key} className="is-bad">
                    <strong>{item.title}</strong>
                    <small>删除失败 · {displayError(item.error)}</small>
                  </li>
                ))}
              </ul>
              <footer>
                <p>失败的账号保持原样，可以稍后重试。</p>
                {batchResult.failed.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={batchRemoving}
                    onClick={() =>
                      void handleBatchRemove(
                        batchResult.failed.map((item) => item.key),
                      )
                    }
                  >
                    重试失败项
                  </Button>
                )}
                <Button size="sm" onClick={() => setBatchResult(null)}>
                  完成
                </Button>
              </footer>
            </section>
          )}
          <div className="accounts-bottom">
            {current ? (
              <section className="account-current" aria-label="Codex 当前登录">
                <header className="account-current-identity">
                  <span className="account-eyebrow">Codex 当前登录</span>
                  <h2 title={current.title}>{current.title}</h2>
                  {(current.subtitle || current.plan) && (
                    <p>
                      {current.subtitle && (
                        <span title={current.subtitle}>{current.subtitle}</span>
                      )}
                      <PlanTag plan={current.plan} />
                    </p>
                  )}
                </header>
                <div className="account-current-quota">
                  {currentQuota(current)}
                </div>
              </section>
            ) : (
              <section className="account-current is-empty">
                <header className="account-current-identity">
                  <span className="account-eyebrow">Codex 当前登录</span>
                  <h2>未使用已保存的账号</h2>
                </header>
                <p className="account-current-message">
                  切换到上方任一账号后，这里显示它的额度明细与重置时间。
                </p>
              </section>
            )}
            <section className="accounts-refresh-card" aria-label="额度刷新">
              <header>
                <h2>额度刷新</h2>
                {oldestQueriedAt !== null && (
                  <span className="accounts-checked">
                    查询于 {clockTime(oldestQueriedAt)}
                  </span>
                )}
              </header>
              <dl>
                <div>
                  <dt>
                    <label htmlFor="official-accounts-refresh">
                      自动刷新额度
                    </label>
                  </dt>
                  <dd>
                    <select
                      id="official-accounts-refresh"
                      className="accounts-select"
                      title="只自动刷新 Codex 当前登录的账号；其他账号在打开页面或点“刷新”时查询"
                      value={refreshMinutes}
                      onChange={(event) => {
                        const minutes = Number(event.target.value);
                        setRefreshMinutes(minutes);
                        try {
                          localStorage.setItem(
                            REFRESH_STORAGE_KEY,
                            String(minutes),
                          );
                        } catch {
                          // Storage may be unavailable; the setting still works this visit.
                        }
                      }}
                    >
                      {REFRESH_MINUTES.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes ? `每 ${minutes} 分钟` : "关闭"}
                        </option>
                      ))}
                    </select>
                  </dd>
                </div>
                <div>
                  <dt>自动刷新范围</dt>
                  <dd>只查询 Codex 当前登录的账号</dd>
                </div>
                <div>
                  <dt>其他账号</dt>
                  <dd>打开页面或点「刷新额度」时查询</dd>
                </div>
              </dl>
              <p className="accounts-privacy-note">
                <ShieldCheck size={13} aria-hidden="true" />
                登录凭据仅保存在本机，界面不会显示令牌。
              </p>
            </section>
          </div>
        </>
      )}
      {rows.length === 0 && (
        <footer className="accounts-privacy">
          <ShieldCheck size={16} />
          <p>登录凭据仅保存在本机，界面不会显示令牌。</p>
        </footer>
      )}

      <Dialog
        open={loginModalOpen}
        onOpenChange={(open) => {
          if (!open) void handleCancelLogin();
        }}
      >
        <DialogContent
          onCloseAutoFocus={restoreDialogFocus}
          className="account-dialog"
          overlayClassName="backdrop-blur-none"
        >
          <header className="account-dialog-heading">
            <DialogTitle>添加官方账号</DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭登录"
              onClick={() => void handleCancelLogin()}
            >
              <X size={16} />
            </Button>
          </header>
          <DialogDescription className="account-dialog-description">
            {loginMethod === "browser"
              ? "在浏览器中登录 ChatGPT，授权后自动返回并添加账号，无需一次性代码。浏览器未自动打开时，可点击下方按钮。"
              : "在浏览器中登录 ChatGPT，输入下方一次性代码。授权完成后，账号会自动添加到本机。"}
          </DialogDescription>
          {startingLogin && (
            <div className="account-login-wait" role="status">
              <CircleNotch size={16} className="animate-spin" />
              {loginMethod === "browser"
                ? "正在启动浏览器登录…"
                : "正在获取一次性代码…"}
            </div>
          )}
          {loginError &&
            (cliMissing ? (
              <div className="account-login-error" role="alert">
                <strong>未找到 Codex CLI</strong>
                <p>
                  已在 PATH、常见安装位置和 Codex 桌面版自带的 CLI
                  中查找，都没有找到。可以先在 Codex 中登录
                  ChatGPT，再用“导入本机登录”保存这个账号；安装 Codex CLI
                  后也可以重新检测。
                </p>
              </div>
            ) : (
              <div className="account-login-error" role="alert">
                <strong>授权未完成</strong>
                <p>{loginError}</p>
              </div>
            ))}
          {activeLogin && !loginError && (
            <>
              <div className="account-login-address">
                <code>{activeLogin.verificationUrl}</code>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="复制验证地址"
                  onClick={() =>
                    void handleCopy(activeLogin.verificationUrl, "验证地址")
                  }
                >
                  <Copy size={15} />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void handleOpenBrowser(activeLogin.verificationUrl)
                  }
                >
                  <ArrowUpRight size={15} />
                  打开浏览器
                </Button>
              </div>
              {loginMethod === "device" && (
                <div className="account-login-code">
                  <span>一次性代码</span>
                  <strong>{activeLogin.userCode}</strong>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void handleCopy(activeLogin.userCode, "一次性代码")
                    }
                  >
                    <Copy size={15} />
                    复制代码
                  </Button>
                </div>
              )}
              <div className="account-login-wait" role="status">
                <CircleNotch size={16} className="animate-spin" />
                <span>
                  {expiresInSeconds > 0
                    ? pollWarning || "等待浏览器授权"
                    : "登录已过期，请取消后重新登录"}
                </span>
                {expiresInSeconds > 0 && (
                  <small>{formatCountdown(expiresInSeconds)}</small>
                )}
              </div>
            </>
          )}
          {!cliMissing && (
            <div className="account-login-help">
              <p>
                {loginMethod === "device"
                  ? "设备码登录需要在 ChatGPT 安全设置中开启；工作区可能需要管理员授权。未开启时可改用浏览器登录。"
                  : "浏览器登录需要本机回调端口可用；若回调受阻，可改用设备码登录或导入本机登录。"}
              </p>
              <details
                className="chimera-disclosure is-inline"
                open={Boolean(loginError)}
              >
                <summary>浏览器报错或无法继续？</summary>
                <div className="chimera-disclosure-body">
                  <p>
                    本应用无法读取浏览器中的报错。若显示{" "}
                    <code>unsupported_country_region_territory</code>
                    ，表示服务不支持当前国家或地区，继续等待不会完成授权。请取消登录并核对服务可用范围。
                  </p>
                  <p>
                    若本机 Codex
                    已成功登录，可关闭弹窗后选择“导入本机登录”。这只读取已有凭据，不会绕过服务限制；系统钥匙串中的凭据可能无法导入。
                  </p>
                </div>
              </details>
            </div>
          )}
          <footer className="account-dialog-actions">
            <Button variant="outline" onClick={() => void handleCancelLogin()}>
              {cliMissing ? "取消" : "取消登录"}
            </Button>
            {cliMissing ? (
              <>
                <Button
                  variant="outline"
                  disabled={startingLogin}
                  onClick={() => void handleStartLogin(loginMethod)}
                >
                  重新检测
                </Button>
                <Button
                  disabled={importingLogin}
                  onClick={() => {
                    void handleCancelLogin();
                    void handleImportLogin();
                  }}
                >
                  导入本机登录
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={startingLogin}
                  onClick={() =>
                    void handleStartLogin(
                      loginMethod === "browser" ? "device" : "browser",
                    )
                  }
                >
                  {loginMethod === "browser"
                    ? "改用设备码登录"
                    : "改用浏览器登录"}
                </Button>
                <Button
                  disabled={startingLogin}
                  onClick={() => void handleStartLogin(loginMethod)}
                >
                  {loginMethod === "browser" ? "重新登录" : "重新获取代码"}
                </Button>
              </>
            )}
          </footer>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(confirmTarget)}
        onOpenChange={(open) => {
          if (!open && !switching) setConfirmTarget(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={restoreDialogFocus}
          className="account-dialog"
          overlayClassName="backdrop-blur-none"
        >
          <DialogTitle>切换到 {confirmTarget?.title}？</DialogTitle>
          <DialogDescription className="account-dialog-description">
            将更新 Codex 的本机登录信息与当前线路。已经打开的 Codex
            需要你手动重启后使用新账号，本次操作不会自动关闭或重启 Codex。
          </DialogDescription>
          <ol className="account-switch-path" aria-label="切换前后">
            {current && confirmTarget && current !== confirmTarget && (
              <li className="account-switch-from">
                <span className="account-avatar" aria-hidden="true">
                  {avatarText(current.account)}
                </span>
                <span className="account-switch-name">
                  <strong>{current.title}</strong>
                  <small>
                    {[
                      current.plan,
                      current.windows.at(-1) &&
                        `${current.windows.at(-1)!.label}已用 ${percentText(current.windows.at(-1)!.used)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
                <span className="account-switch-tag">当前</span>
              </li>
            )}
            {confirmTarget && (
              <li className="account-switch-to">
                <span className="account-avatar" aria-hidden="true">
                  {avatarText(confirmTarget.account)}
                </span>
                <span className="account-switch-name">
                  <strong>{confirmTarget.title}</strong>
                  <small>
                    {[
                      confirmTarget.plan,
                      confirmTarget.windows.at(-1) &&
                        `${confirmTarget.windows.at(-1)!.label}已用 ${percentText(confirmTarget.windows.at(-1)!.used)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || confirmTarget.subtitle}
                  </small>
                </span>
                <ArrowRight size={14} aria-hidden="true" />
              </li>
            )}
          </ol>
          <dl className="account-switch-preview">
            <dt>更新内容</dt>
            <dd>Codex 登录凭据与官方线路配置</dd>
            <dt>会话记录</dt>
            <dd>保留已有会话，不修改会话内容</dd>
          </dl>
          <footer className="account-dialog-actions">
            <Button
              variant="outline"
              onClick={() => setConfirmTarget(null)}
              disabled={switching}
            >
              取消
            </Button>
            <Button
              onClick={() => void handlePerformSwitch()}
              disabled={switching}
            >
              <ArrowsClockwise
                size={15}
                className={switching ? "animate-spin" : undefined}
              />
              {switching ? "正在切换…" : "确认切换"}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
      <AccountDetailsDialog
        account={editTarget?.account ?? null}
        title={editTarget?.title ?? ""}
        inUse={Boolean(
          editTarget?.account.isCurrent || editTarget?.account.isSelected,
        )}
        onClose={() => setEditTarget(null)}
        onSaved={() => void loadAccounts({ scope: "none" })}
      />
      <Dialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open && !removing) setRemoveTarget(null);
        }}
      >
        <DialogContent
          role="alertdialog"
          onCloseAutoFocus={restoreDialogFocus}
          className="account-dialog"
          overlayClassName="backdrop-blur-none"
        >
          <DialogTitle>删除账号“{removeTarget?.title}”？</DialogTitle>
          <DialogDescription className="account-dialog-description">
            {removeTarget?.account.unreadable
              ? "这个账号保存的登录已无法读取，删除后可以重新登录添加。"
              : "将删除本机为这个账号保存的登录凭据，Codex 与 ChatGPT 中已有的登录不受影响。"}
            使用它的线路会保留，之后切换到这些线路时沿用 Codex 当前的登录。
          </DialogDescription>
          <footer className="account-dialog-actions">
            <Button
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              disabled={removing}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleRemoveAccount()}
              disabled={removing}
            >
              {removing ? "正在删除…" : "删除账号"}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
      <Dialog
        open={batchConfirm}
        onOpenChange={(open) => {
          if (!open && !batchRemoving) setBatchConfirm(false);
        }}
      >
        <DialogContent
          role="alertdialog"
          className="account-dialog"
          overlayClassName="backdrop-blur-none"
        >
          <DialogTitle>删除选中的 {selectedRows.length} 个账号？</DialogTitle>
          <DialogDescription className="account-dialog-description">
            逐个删除本机为这些账号保存的登录凭据，Codex 与 ChatGPT
            中已有的登录不受影响；使用它们的线路会保留。某个账号删除失败时，其余账号照常删除。
          </DialogDescription>
          {/* Every selected account by name: a filter may be hiding some. */}
          <ul className="account-batch-names" aria-label="将删除的账号">
            {selectedRows.map((row) => (
              <li key={row.account.key}>{row.title}</li>
            ))}
          </ul>
          <footer className="account-dialog-actions">
            <Button
              variant="outline"
              onClick={() => setBatchConfirm(false)}
              disabled={batchRemoving}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={batchRemoving}
              onClick={() =>
                void handleBatchRemove(
                  selectedRows.map((row) => row.account.key),
                )
              }
            >
              {batchRemoving ? "正在删除…" : "删除账号"}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
    </div>
  );
};
