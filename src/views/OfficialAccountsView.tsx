import React, { useEffect, useRef, useState } from "react";
import {
  CheckCircle2 as CheckCircle,
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
import type { SubscriptionQuota } from "@/types/subscription";
import {
  officialAccountsApi,
  type OfficialAccountDto,
  type StartedLoginDto,
} from "@/lib/api/officialAccounts";

type AccountRow = OfficialAccountDto & {
  id: string;
  shortBadge: string;
  status: "valid" | "expired" | "unknown";
};

type QuotaMetric = { remaining: number; resetTime: string };

function quotaMetric(
  quota: SubscriptionQuota | undefined,
  tierName: string,
): QuotaMetric | null {
  if (!quota?.success) return null;
  const tier = quota.tiers.find((item) => item.name === tierName);
  if (!tier || !Number.isFinite(tier.utilization)) return null;
  return {
    remaining: Math.max(0, Math.min(100, 100 - tier.utilization)),
    resetTime: tier.resetsAt
      ? `重置于 ${new Date(tier.resetsAt).toLocaleString()}`
      : "重置时间未知",
  };
}

interface OfficialAccountsViewProps {
  onAccountSwitched?: () => void;
}

let loginStartupPending = false;

export const OfficialAccountsView: React.FC<OfficialAccountsViewProps> = ({
  onAccountSwitched,
}) => {
  const [accounts, setAccounts] = useState<OfficialAccountDto[]>([]);
  const [loading, setLoading] = useState(true);
  const accountsGeneration = useRef(0);
  const addAccountRef = useRef<HTMLButtonElement>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const restoreDialogFocus = (event: Event) => {
    event.preventDefault();
    const trigger = dialogTriggerRef.current;
    if (trigger?.isConnected && !trigger.matches(":disabled")) trigger.focus();
    else addAccountRef.current?.focus();
  };
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quotas, setQuotas] = useState<Record<string, SubscriptionQuota>>({});
  const [loadingQuotas, setLoadingQuotas] = useState(false);
  const [quotaErrors, setQuotaErrors] = useState<Set<string>>(new Set());

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
  useLightweightCloseBlocker(
    startingLogin ||
      loginModalOpen ||
      importingLogin ||
      switching ||
      Boolean(confirmTarget),
  );

  const mergedAccounts: AccountRow[] = React.useMemo(
    () =>
      accounts.map((dto) => {
        const needsRelogin =
          dto.needsRelogin || quotas[dto.key]?.credentialStatus === "expired";
        return {
          ...dto,
          needsRelogin,
          id: dto.providerId || dto.key,
          shortBadge: dto.displayName.trim().slice(0, 1) || "官",
          status: needsRelogin ? "expired" : "valid",
        };
      }),
    [accounts, quotas],
  );

  const activeLiveAccount = mergedAccounts.find((a) => a.isCurrent) ?? null;
  const activeQuota = activeLiveAccount
    ? quotas[activeLiveAccount.key]
    : undefined;
  const activeFiveHour = quotaMetric(activeQuota, "five_hour");
  const activeWeekly = quotaMetric(activeQuota, "seven_day");
  const activeQuotaMessage = activeLiveAccount?.needsRelogin
    ? "重新登录后可查询额度"
    : loadingQuotas
      ? "正在查询…"
      : (activeLiveAccount && quotaErrors.has(activeLiveAccount.key)) ||
          (activeQuota && !activeQuota.success)
        ? "额度查询失败，请刷新重试"
        : "尚未获取额度";

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

  const loadAccounts = async () => {
    const generation = ++accountsGeneration.current;
    try {
      setLoading(true);
      setLoadError(null);
      const list = await officialAccountsApi.list();
      if (generation !== accountsGeneration.current) return;
      setAccounts(list);
      setQuotas({});
      setQuotaErrors(new Set());
      const queryAccounts = list.filter((account) => !account.needsRelogin);
      setLoadingQuotas(queryAccounts.length > 0);
      const quotaResults = await Promise.allSettled(
        queryAccounts.map((account) =>
          officialAccountsApi.getQuota(account.key),
        ),
      );
      if (generation !== accountsGeneration.current) return;
      const nextQuotas: Record<string, SubscriptionQuota> = {};
      const nextErrors = new Set<string>();
      quotaResults.forEach((result, index) => {
        const key = queryAccounts[index].key;
        if (result.status === "fulfilled") nextQuotas[key] = result.value;
        else nextErrors.add(key);
      });
      setQuotas(nextQuotas);
      setQuotaErrors(nextErrors);
    } catch (err: any) {
      if (generation !== accountsGeneration.current) return;
      setAccounts([]);
      const message = err?.message || String(err);
      setLoadError(
        message.includes("undefined") && message.includes("invoke")
          ? "暂未连接本机账号服务，请在桌面应用中重试"
          : message || "无法读取官方账号，请重试",
      );
    } finally {
      if (generation === accountsGeneration.current) {
        setLoadingQuotas(false);
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadAccounts();
    return () => {
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
      setLoginError(message);
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
          const message =
            cause instanceof Error ? cause.message : String(cause);
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
      failLogin(cause instanceof Error ? cause.message : String(cause));
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
      toast.error("未能导入本机登录", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
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

  const handlePerformSwitch = async () => {
    if (!confirmTarget) return;
    try {
      setSwitching(true);
      const targetKey = confirmTarget.key;
      await officialAccountsApi.switchAccount(targetKey);
      toast.success(
        `已切换到 ${confirmTarget.displayName || "官方账号"}，请重启已打开的 Codex 以使用新账号`,
      );
      setConfirmTarget(null);
      await loadAccounts();
      if (onAccountSwitched) onAccountSwitched();
    } catch (err: any) {
      toast.error(err?.message || "切换官方账号失败");
    } finally {
      setSwitching(false);
    }
  };

  const handleRemoveAccount = async (account: AccountRow) => {
    if (
      !window.confirm(
        `确认移除官方账号“${account.displayName}”？本机保险库中的凭证也会被移除。`,
      )
    ) {
      return;
    }
    try {
      await officialAccountsApi.removeAccount(account.key);
      toast.success("官方账号已移除");
      await loadAccounts();
      if (onAccountSwitched) onAccountSwitched();
    } catch (err: any) {
      toast.error(err?.message || "移除官方账号失败");
    }
  };

  return (
    <div className="official-accounts-page">
      <header className="accounts-heading">
        <div>
          <h1>官方账号</h1>
          <p>连接你的 ChatGPT 账号，在不同账号之间轻松切换。</p>
        </div>
        <div className="accounts-header-actions">
          <Button
            variant="outline"
            disabled={importingLogin || startingLogin || loginModalOpen}
            onClick={() => void handleStartLogin("device")}
          >
            设备码登录
          </Button>
          <Button
            variant="outline"
            disabled={importingLogin || startingLogin || loginModalOpen}
            onClick={() => void handleImportLogin()}
          >
            {importingLogin ? "正在导入…" : "导入本机登录"}
          </Button>
          {/* With no account yet, the empty card holds the only add action. */}
          {(mergedAccounts.length > 0 || loadError) && (
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
      {loading && (
        <div className="accounts-notice" role="status">
          正在读取本机官方账号…
        </div>
      )}
      {loadError && !loading && (
        <div className="accounts-notice" role="alert">
          <span>{loadError}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadAccounts()}
          >
            重新加载
          </Button>
        </div>
      )}
      {activeLiveAccount && (
        <section className="account-current" aria-label="当前官方账号">
          <div>
            <span className="account-eyebrow">当前线路 · 官方账号</span>
            <h2>{activeLiveAccount.displayName}</h2>
            <p>{activeLiveAccount.email}</p>
          </div>
          <div className="account-current-quota">
            <span>5 小时 · 剩余</span>
            <strong>
              {activeFiveHour ? activeFiveHour.remaining + "%" : "—"}
            </strong>
            <small>{activeFiveHour?.resetTime ?? activeQuotaMessage}</small>
          </div>
          <div className="account-current-quota">
            <span>本周 · 剩余</span>
            <strong>{activeWeekly ? activeWeekly.remaining + "%" : "—"}</strong>
            <small>{activeWeekly?.resetTime ?? activeQuotaMessage}</small>
          </div>
        </section>
      )}
      {!loading && !loadError && mergedAccounts.length === 0 && (
        <section className="accounts-empty">
          <div className="accounts-empty-icon">
            <UserRound size={28} strokeWidth={1.5} />
          </div>
          <span className="account-eyebrow">你的账号，你的工作空间</span>
          <h2>连接第一个官方账号</h2>
          <p>
            通过官方网页完成授权，无需在这里输入密码。
            <br />
            添加后即可查看额度，并将账号切换为当前 Codex 线路。
          </p>
          <Button
            ref={addAccountRef}
            onClick={() => void handleStartLogin()}
            disabled={startingLogin}
          >
            <Plus size={16} />
            {startingLogin ? "正在准备登录…" : "登录并添加账号"}
          </Button>
          <div className="accounts-login-steps">
            <span>
              <b>01</b> 浏览器登录（推荐）
            </span>
            <span>
              <b>02</b> 前往官方网页授权
            </span>
            <span>
              <b>03</b> 返回这里开始使用
            </span>
          </div>
        </section>
      )}
      {mergedAccounts.length > 0 && (
        <section className="accounts-list" aria-label="已保存的官方账号">
          <div className="accounts-list-heading">
            <h2>
              已保存账号 <span>{mergedAccounts.length}</span>
            </h2>
            <Button
              variant="ghost"
              size="sm"
              disabled={loading || loadingQuotas}
              onClick={() => void loadAccounts()}
            >
              <ArrowsClockwise size={14} />
              刷新
            </Button>
          </div>
          {mergedAccounts.map((account) => {
            const accountQuota = quotas[account.key];
            const fiveHour = quotaMetric(accountQuota, "five_hour");
            const weekly = quotaMetric(accountQuota, "seven_day");
            return (
              <article
                className="account-row"
                key={account.id}
                data-current={account.isCurrent}
              >
                <div className="account-avatar">{account.shortBadge}</div>
                <div className="account-identity">
                  <strong>
                    {account.displayName}
                    {account.isCurrent && <span>使用中</span>}
                  </strong>
                  <small>{account.email}</small>
                  <span
                    className={
                      account.needsRelogin
                        ? "account-status expired"
                        : "account-status"
                    }
                  >
                    {account.needsRelogin ? (
                      <Warning size={12} />
                    ) : (
                      <CheckCircle size={12} />
                    )}
                    {account.needsRelogin ? "需要重新登录" : "登录有效"}
                  </span>
                </div>
                <div className="account-row-quota">
                  {account.needsRelogin ? (
                    <span>重新登录后可查询额度</span>
                  ) : fiveHour || weekly ? (
                    <>
                      <span>
                        5 小时剩余{" "}
                        <b>{fiveHour ? fiveHour.remaining + "%" : "—"}</b>
                      </span>
                      <span>
                        本周剩余 <b>{weekly ? weekly.remaining + "%" : "—"}</b>
                      </span>
                    </>
                  ) : (
                    <span>
                      {loadingQuotas
                        ? "额度查询中…"
                        : quotaErrors.has(account.key) ||
                            (accountQuota && !accountQuota.success)
                          ? "额度查询失败，请刷新重试"
                          : "尚未获取额度"}
                    </span>
                  )}
                </div>
                <div className="account-row-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={startingLogin || switching}
                    onClick={(event) => {
                      if (account.needsRelogin) void handleStartLogin();
                      else {
                        dialogTriggerRef.current = event.currentTarget;
                        setConfirmTarget(account);
                      }
                    }}
                  >
                    {account.needsRelogin
                      ? "重新登录"
                      : account.isCurrent
                        ? "重新应用"
                        : "切换"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={"移除" + account.displayName}
                    onClick={() => void handleRemoveAccount(account)}
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
        <p>
          登录令牌仅保存在本机。切换官方账号时更新 Codex
          登录信息，第三方线路不会改写官方账号凭证。
        </p>
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
          {loginError && (
            <div className="account-login-error" role="alert">
              <strong>授权未完成</strong>
              <p>{loginError}</p>
            </div>
          )}
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
          <div className="account-login-help">
            <p>
              {loginMethod === "device"
                ? "设备码登录需要在 ChatGPT 安全设置中开启；工作区可能需要管理员授权。未开启时可改用浏览器登录。"
                : "浏览器登录需要本机回调端口可用；若回调受阻，可改用设备码登录或导入本机登录。"}
            </p>
            <strong>浏览器报错或无法继续？</strong>
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
          <footer className="account-dialog-actions">
            <Button variant="outline" onClick={() => void handleCancelLogin()}>
              取消登录
            </Button>
            <Button
              disabled={startingLogin}
              onClick={() =>
                void handleStartLogin(
                  loginMethod === "browser" ? "device" : "browser",
                )
              }
            >
              {loginMethod === "browser" ? "改用设备码登录" : "改用浏览器登录"}
            </Button>
            <Button
              disabled={startingLogin}
              onClick={() => void handleStartLogin(loginMethod)}
            >
              {loginMethod === "browser" ? "重新登录" : "重新获取代码"}
            </Button>
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
          <DialogTitle>
            切换到 {confirmTarget?.displayName || "官方账号"}？
          </DialogTitle>
          <DialogDescription className="account-dialog-description">
            将更新 Codex 的本机登录信息与当前线路。已经打开的 Codex
            需要你手动重启后使用新账号，本次操作不会自动关闭或重启 Codex。
          </DialogDescription>
          <dl className="account-switch-preview">
            <dt>目标账号</dt>
            <dd>{confirmTarget?.displayName || "官方账号"}</dd>
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
                className={switching ? "animate-spin" : ""}
              />
              {switching ? "正在切换…" : "确认切换"}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
    </div>
  );
};
