import React, { useEffect, useRef, useState } from "react";
import {
  Copy,
  ArrowUpRight,
  Loader2 as CircleNotch,
  X,
  Plus,
  ShieldCheck,
  UserRound,
  Trash2,
  AlertTriangle as Warning,
  RotateCw as ArrowsClockwise,
  Info,
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
import "./OfficialAccountsView.css";
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

const queryable = (account: OfficialAccountDto) =>
  !account.needsRelogin && !account.accessExpired;

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
  const value = percentText(quota.remaining);
  const reset = resetText(quota.resetsAt, now, compact);
  const exact = quota.resetsAt === null ? null : exactTime(quota.resetsAt);
  const low = quota.remaining <= 10;
  return (
    <div
      className={compact ? "quota-meter is-compact" : "quota-meter"}
      data-low={low || undefined}
    >
      <span className="quota-meter-label">
        {compact ? quota.label : `${quota.label} · 剩余`}
      </span>
      <strong className="quota-meter-value">{value}</strong>
      <div
        className="quota-meter-bar"
        role="progressbar"
        aria-label={`${quota.label}额度剩余`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(quota.remaining)}
        aria-valuetext={`剩余 ${value}`}
      >
        <span style={{ width: `${quota.remaining}%` }} />
      </div>
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
    </div>
  );
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
  useLightweightCloseBlocker(
    startingLogin ||
      loginModalOpen ||
      importingLogin ||
      switching ||
      removing ||
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
  const selected = rows.find((row) => row.account.isSelected) ?? null;
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
  }: { background?: boolean; scope?: QuotaScope } = {}): Promise<void> => {
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
        const targets = list.filter(
          (account) =>
            queryable(account) &&
            (scope === "all" || (scope === "current" && account.isCurrent)),
        );
        if (!targets.length) return;
        const targetKeys = targets.map((account) => account.key);
        setPendingQuotas(new Set(targetKeys));
        const results = await Promise.allSettled(
          targetKeys.map((key) => officialAccountsApi.getQuota(key)),
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
        void refreshRef.current({ background: true, scope: "current" });
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

  return (
    <div className="official-accounts-page">
      <header className="accounts-heading">
        <div>
          <h1>官方账号</h1>
          <p>保存多个 ChatGPT 账号，查看额度并一键切换。</p>
        </div>
        <div className="accounts-header-actions">
          <Button
            variant="outline"
            disabled={busyLogin}
            onClick={() => void handleStartLogin("device")}
          >
            设备码登录
          </Button>
          <Button
            variant="outline"
            disabled={busyLogin}
            onClick={() => void handleImportLogin()}
          >
            {importingLogin ? "正在导入…" : "导入本机登录"}
          </Button>
          {/* With no account yet, the empty card holds the only add action. */}
          {(rows.length > 0 || loadError) && (
            <Button
              ref={addAccountRef}
              onClick={() => void handleStartLogin()}
              disabled={startingLogin}
            >
              <Plus size={16} />
              {startingLogin ? "正在准备登录…" : "添加官方账号"}
            </Button>
          )}
        </div>
      </header>
      {listLoading && rows.length === 0 && !loadError && (
        <div className="accounts-notice" role="status">
          <CircleNotch size={16} className="animate-spin" />
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
              {selected
                ? `线路选的是「${selected.title}」，但 Codex 中的登录不是它。重新应用后，Codex 改用这个账号。`
                : "Codex 中的登录与所选线路不一致。"}
            </p>
          </div>
          {selected &&
            (selected.needsRelogin ? (
              <Button
                size="sm"
                disabled={startingLogin || switching}
                onClick={() => void handleStartLogin()}
              >
                重新登录
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={startingLogin || switching}
                onClick={(event) => openSwitch(selected, event.currentTarget)}
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
      {current && (
        <section className="account-current" aria-label="Codex 当前登录">
          <div className="account-current-identity">
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
          </div>
          <div className="account-current-quota">{currentQuota(current)}</div>
        </section>
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
        <section className="accounts-list" aria-label="已保存的官方账号">
          <div className="accounts-list-heading">
            <h2>
              已保存账号 <span>{rows.length}</span>
            </h2>
            <div className="accounts-list-tools">
              {oldestQueriedAt !== null && (
                <span className="accounts-checked">
                  查询于 {clockTime(oldestQueriedAt)}
                </span>
              )}
              <label htmlFor="official-accounts-refresh">自动刷新额度</label>
              <select
                id="official-accounts-refresh"
                title="只自动刷新 Codex 当前登录的账号；其他账号在打开页面或点“刷新”时查询"
                value={refreshMinutes}
                onChange={(event) => {
                  const minutes = Number(event.target.value);
                  setRefreshMinutes(minutes);
                  try {
                    localStorage.setItem(REFRESH_STORAGE_KEY, String(minutes));
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
              <Button
                variant="ghost"
                size="sm"
                disabled={refreshing}
                onClick={() => void loadAccounts()}
              >
                <ArrowsClockwise
                  size={14}
                  className={refreshing ? "animate-spin" : undefined}
                />
                刷新
              </Button>
            </div>
          </div>
          {(quotaFailed || listStale) && (
            <p className="accounts-refresh-error" role="status">
              {quotaFailed
                ? "部分额度未更新，已显示的额度可能不是最新值。可手动刷新重试。"
                : "账号状态未更新，显示的可能不是最新信息。可手动刷新重试。"}
            </p>
          )}
          {rows.map((row) => {
            const { account } = row;
            return (
              <article
                className="account-row"
                key={account.providerId || account.key}
                data-current={account.isCurrent}
                data-attention={row.needsRelogin || undefined}
              >
                <div
                  className="account-avatar"
                  data-unreadable={account.unreadable || undefined}
                  aria-hidden="true"
                >
                  {account.unreadable ? (
                    <Warning size={15} />
                  ) : (
                    avatarText(account)
                  )}
                </div>
                <div className="account-identity">
                  <div className="account-title">
                    <strong title={row.title}>{row.title}</strong>
                    {account.isCurrent && (
                      <span className="account-current-tag">使用中</span>
                    )}
                  </div>
                  {(row.subtitle || row.plan) && (
                    <div className="account-meta">
                      {row.subtitle && (
                        <small title={row.subtitle}>{row.subtitle}</small>
                      )}
                      <PlanTag plan={row.plan} />
                    </div>
                  )}
                  {row.needsRelogin && !account.unreadable && (
                    <span className="account-status">
                      <Warning size={12} />
                      需要重新登录
                    </span>
                  )}
                </div>
                <div className="account-row-quota">{rowQuota(row)}</div>
                <div className="account-row-actions">
                  <Button
                    variant="outline"
                    size="sm"
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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="account-remove"
                    aria-label={"删除" + row.title}
                    title="删除账号"
                    disabled={removing}
                    onClick={(event) => {
                      dialogTriggerRef.current = event.currentTarget;
                      setRemoveTarget(row);
                    }}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              </article>
            );
          })}
        </section>
      )}
      <footer className="accounts-privacy">
        <ShieldCheck size={16} />
        <p>登录凭据仅保存在本机，界面不会显示令牌。</p>
      </footer>

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
              <p className="account-dialog-note">
                <ShieldCheck size={15} />
                登录凭据仅保存在本机，不会显示在界面中。
              </p>
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
          <dl className="account-switch-preview">
            <dt>目标账号</dt>
            <dd>
              {confirmTarget?.title}
              {confirmTarget?.subtitle && (
                <small>{confirmTarget.subtitle}</small>
              )}
            </dd>
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
    </div>
  );
};
