import {
  CLAUDE_DESKTOP_SAMPLE_ACCOUNTS,
  CLAUDE_DESKTOP_SAMPLE_QUOTA,
  CLAUDE_DESKTOP_SAMPLE_SWAP,
  CLAUDE_SAMPLE_ACCOUNTS,
  CLAUDE_SAMPLE_QUOTA,
  isToolDesignPreview,
} from "@/views/ToolView.designSamples";
import "./ClaudeAccountsCard.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AppWindow,
  Loader2,
  Pencil,
  Plus,
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
  DEFAULT_DESKTOP_ID,
  type ClaudeCodeAccount,
  type ClaudeCodeAccounts,
  type ClaudeDesktopProfile,
  type ClaudeDesktopSwapOutcome,
  type ClaudeDesktopSwapStatus,
} from "@/lib/api/claudeAccounts";
import { AccountRow, maskEmail } from "./AccountRow";
import {
  AccountsToolbar,
  visibleAccounts,
  type AccountFilter,
  type AccountSort,
} from "./AccountsToolbar";
import { AddAccountMenu, type DetectedLogin } from "./AddAccountMenu";
import {
  DESKTOP_STATUS_TEXT,
  QuotaStrip,
  errorText,
  type QuotaState,
} from "./quota";
import { useReturnFocus } from "./useReturnFocus";
import { moveBy, useSortable } from "./useSortable";
import { useStoredFlag } from "./useStoredFlag";

export { clockText, errorText, resetText } from "./quota";

/** Other cards on the page (folder bindings) reload when this fires. */
export const BINDINGS_CHANGED_EVENT = "chimera-claude-bindings-changed";

export type ClaudeAccountsMode = "code" | "desktop";

export interface ClaudeAccountsCardProps {
  mode: ClaudeAccountsMode;
  /** Running inside the desktop shell (native commands available). */
  native?: boolean;
  refreshVersion?: number;
}

type NameDialog =
  | { kind: "add-desktop" }
  /** `afterLoginFrom`: the saved login that was live before the guide. */
  | { kind: "save-code"; afterLoginFrom?: string | null }
  | { kind: "rename"; id: string; name: string; vault?: boolean }
  | { kind: "note"; id: string; note: string };

type DeleteTarget = {
  id: string;
  name: string;
  email?: string | null;
  /** A saved Claude login (also listed on the Claude Desktop page). */
  vault?: boolean;
};

type DesktopSwapTarget = {
  kind: "capture" | "switch" | "prepare";
  account: ClaudeCodeAccount;
};

function swapMessage(
  target: DesktopSwapTarget,
  outcome: ClaudeDesktopSwapOutcome,
  nameOf: (id: string) => string,
) {
  const notes: string[] = [];
  if (outcome.restarted) notes.push("Claude Desktop 已重新打开。");
  else if (outcome.wasRunning)
    notes.push("Claude Desktop 已被关闭，没能自动重新打开，请手动打开。");
  if (outcome.savedOutgoingFor)
    notes.push(`原来的登录已保存到「${nameOf(outcome.savedOutgoingFor)}」。`);
  if (outcome.stashedOutgoing)
    notes.push(
      "原来的登录不属于已保存的账号，已暂存在保险库的 desktop-auth/.stash 里（保留最近 5 份，目前只能手动取回）。",
    );
  if (target.kind === "prepare")
    notes.unshift(
      `在里面登录「${target.account.name}」，再回到这里点这一行的「保存 Desktop 登录」。`,
    );
  toast.success(
    target.kind === "switch"
      ? `默认 Claude Desktop 已切换到「${target.account.name}」`
      : target.kind === "prepare"
        ? "默认 Claude Desktop 已回到登录页"
        : `已保存默认 Claude Desktop 的登录，属于「${target.account.name}」`,
    {
      description: notes.join("") || undefined,
      // Read it through: some of these say where a login went.
      duration: notes.length > 0 ? 15_000 : undefined,
    },
  );
}

export function ClaudeAccountsCard({
  mode,
  native = true,
  refreshVersion = 0,
}: ClaudeAccountsCardProps) {
  const headingId = useId();
  const nameInputId = useId();
  // Browser design preview (L14/L30): sample accounts, every write disabled.
  const [designPreview] = useState(() => !native && isToolDesignPreview());
  const live = native || designPreview;
  const [code, setCode] = useState<ClaudeCodeAccounts | null>(null);
  const [desktop, setDesktop] = useState<ClaudeDesktopProfile[] | null>(null);
  const [swap, setSwap] = useState<ClaudeDesktopSwapStatus | null>(null);
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
  const [desktopConfirm, setDesktopConfirm] =
    useState<DesktopSwapTarget | null>(null);
  const [localImport, setLocalImport] = useState<{
    uuid: string;
    email: string | null;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");
  const [sortBy, setSortBy] = useState<AccountSort>("custom");
  const [grid, setGrid] = useStoredFlag("chimera.claude.accounts.grid", true);
  const [hideEmail, setHideEmail] = useStoredFlag(
    "chimera.claude.accounts.hideEmail",
    false,
  );
  const [refreshingAll, setRefreshingAll] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  /** The newest list read wins; a move invalidates the ones still on the way. */
  const loadGeneration = useRef(0);
  const orderQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);

  /** `vault`: a saved Claude login shown on the Claude Desktop page. */
  const readQuota = useCallback(
    async (id: string, force: boolean, vault = false) => {
      const key = vault && mode === "desktop" ? `vault:${id}` : id;
      setQuota((all) => ({ ...all, [key]: { ...all[key], loading: true } }));
      try {
        const next: QuotaState =
          mode === "code"
            ? {
                view: await claudeAccountsApi.codeQuota(id, force),
                loading: false,
              }
            : await claudeAccountsApi[
                vault ? "desktopAccountQuota" : "desktopQuota"
              ](id, force).then(
                ({ quota: view, email, plan, accountUuid }) => ({
                  accountUuid,
                  view,
                  email,
                  plan,
                  loading: false,
                }),
              );
        if (mounted.current) setQuota((all) => ({ ...all, [key]: next }));
      } catch {
        if (mounted.current)
          setQuota((all) => ({
            ...all,
            [key]: {
              view: all[key]?.view
                ? { ...all[key].view!, status: "unavailable" }
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
    },
    [mode],
  );

  const load = useCallback(async () => {
    if (designPreview) {
      const sample =
        mode === "code"
          ? CLAUDE_SAMPLE_ACCOUNTS
          : CLAUDE_DESKTOP_SAMPLE_ACCOUNTS;
      const quotas =
        mode === "code" ? CLAUDE_SAMPLE_QUOTA : CLAUDE_DESKTOP_SAMPLE_QUOTA;
      setCode(sample);
      if (mode === "desktop") {
        setDesktop([]);
        setSwap(CLAUDE_DESKTOP_SAMPLE_SWAP);
      }
      setQuota(
        Object.fromEntries(
          Object.entries(quotas).map(([id, view]) => [
            mode === "desktop" ? `vault:${id}` : id,
            { view, loading: false },
          ]),
        ),
      );
      return;
    }
    if (!native) return;
    const mine = ++loadGeneration.current;
    const stale = () => !mounted.current || mine !== loadGeneration.current;
    setLoadError(null);
    const readQuotas = (accounts: ClaudeCodeAccount[], vault: boolean) => {
      for (const account of accounts)
        if (
          (account.kind === "oauth" ||
            (vault && account.kind === "desktop_only")) &&
          !account.disabled &&
          !account.unreadable
        )
          void readQuota(account.id, false, vault);
    };
    try {
      if (mode === "code") {
        const result = await claudeAccountsApi.listCode();
        if (stale()) return;
        setCode(result);
        if (result.supported) readQuotas(result.accounts, false);
      } else {
        const result = await claudeAccountsApi.listDesktop();
        if (stale()) return;
        setDesktop(result);
        void readQuota(DEFAULT_DESKTOP_ID, false);
        for (const profile of result)
          if (profile.signedIn) void readQuota(profile.id, false);
        // Saved subscription identities are shared with Claude Code.
        const vault = await claudeAccountsApi.listCode();
        if (stale()) return;
        setCode(vault);
        if (vault?.supported) readQuotas(vault.accounts, true);
        const status = await claudeAccountsApi
          .desktopSwapStatus()
          .catch(() => null);
        if (!stale()) setSwap(status);
      }
    } catch (cause) {
      if (!stale()) setLoadError(errorText(cause));
    }
  }, [designPreview, mode, native, readQuota]);

  useEffect(() => {
    void load();
  }, [load, refreshVersion]);

  // Signing in from a terminal happens elsewhere; read again when the window
  // is brought back.
  useEffect(() => {
    const refresh = () => {
      if (!pending.current) void load();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
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
        // The folder bindings show these accounts too.
        window.dispatchEvent(new CustomEvent(BINDINGS_CHANGED_EVENT));
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
    setNameValue(
      dialog.kind === "rename"
        ? dialog.name
        : dialog.kind === "note"
          ? dialog.note
          : "",
    );
    setNameDialog(dialog);
  };

  const submitName = () => {
    const dialog = nameDialog;
    if (!dialog) return;
    const name = nameValue.trim();
    if (!name && dialog.kind !== "save-code" && dialog.kind !== "note") return;
    void run("name", async () => {
      if (dialog.kind === "note") {
        await claudeAccountsApi.setNote(dialog.id, name);
        toast.success(name ? "已保存备注" : "已清除备注");
      } else if (dialog.kind === "rename") {
        if (mode === "code" || dialog.vault)
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

  const renameSaved = (account: ClaudeCodeAccount, vault: boolean) =>
    openNameDialog({
      kind: "rename",
      id: account.id,
      name: account.name,
      vault,
    });

  const removeSaved = (account: ClaudeCodeAccount, vault: boolean) =>
    setRemoving({
      id: account.id,
      name: account.name,
      email: account.email,
      vault,
    });

  const confirmDelete = () => {
    const target = removing;
    if (!target) return;
    void run(`delete:${target.id}`, async () => {
      if (mode === "code" || target.vault)
        await claudeAccountsApi.deleteCode(target.id);
      else await claudeAccountsApi.deleteDesktop(target.id);
      setRemoving(null);
      toast.success(`已删除「${target.name}」`);
    });
  };

  const toggleDisabled = (account: ClaudeCodeAccount) =>
    run(`disable:${account.id}`, async () => {
      await claudeAccountsApi.setDisabled(account.id, !account.disabled);
      toast.success(
        account.disabled
          ? `已启用「${account.name}」`
          : `已停用「${account.name}」`,
        {
          description: account.disabled
            ? undefined
            : "它不会被切换、并行打开或绑定到目录，也不再读取额度。登录仍保留。",
        },
      );
    });

  const openSession = (account: ClaudeCodeAccount) =>
    run(`session:${account.id}`, async () => {
      const launch = await claudeAccountsApi.openSession({ id: account.id });
      const warnings = launch.warnings ?? [];
      const base = launch.usesDefaultLogin
        ? "它就是 Claude Code 当前的登录，打开的是普通终端。"
        : "这个终端只用这个账号，Claude Code 当前的登录不受影响。它有自己的对话记录，看不到别的登录下的对话；设置、技能等每次启动都以默认登录的为准，在这个终端里改的不保留。";
      toast.success(`已在新终端打开「${launch.accountName ?? account.name}」`, {
        description:
          warnings.length > 0 ? `${base}${warnings.join("；")}。` : base,
        duration: warnings.length > 0 ? 15_000 : undefined,
      });
    });

  const copyCommands = (
    account: ClaudeCodeAccount,
    shell: "cmd" | "powershell",
  ) =>
    run(`commands:${account.id}`, async () => {
      const commands = await claudeAccountsApi.sessionCommands(account.id);
      const text = shell === "cmd" ? commands.cmd : commands.powershell;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        throw new Error("无法写入剪贴板，请手动复制：" + text);
      }
      toast.success("已复制启动命令", {
        description: `在${shell === "cmd" ? " cmd " : " PowerShell "}里粘贴运行，就会用「${account.name}」启动 claude。`,
      });
    });

  const bindFolder = (account: ClaudeCodeAccount) =>
    run(`bind:${account.id}`, async () => {
      const folder = await claudeAccountsApi.pickFolder();
      if (!folder) return;
      await claudeAccountsApi.setBinding(folder, account.id);
      toast.success(`已把 ${folder} 绑定到「${account.name}」`, {
        description: "从 Chimera 在这个目录打开 Claude 时，会用这个账号。",
      });
    });

  const nameOf = (id: string) =>
    code?.accounts.find((account) => account.id === id)?.name ?? "已保存的账号";

  const runDesktopSwap = (target: DesktopSwapTarget, close: boolean) =>
    run(`desktop:${target.account.id}`, async () => {
      const call =
        target.kind === "capture"
          ? claudeAccountsApi.captureDesktopLogin
          : target.kind === "prepare"
            ? claudeAccountsApi.prepareDesktopLogin
            : claudeAccountsApi.switchDesktop;
      let outcome: ClaudeDesktopSwapOutcome;
      try {
        outcome = await call(target.account.id, close);
      } catch (cause) {
        // The question was answered; a failure is shown on its own.
        if (close) setDesktopConfirm(null);
        throw cause;
      }
      if (outcome.status === "desktop_running") {
        setDesktopConfirm(target);
        return;
      }
      setDesktopConfirm(null);
      if (target.kind !== "capture")
        window.dispatchEvent(
          new CustomEvent("chimera-provider-mutated", {
            detail: { appId: "claude-desktop" },
          }),
        );
      swapMessage(target, outcome, nameOf);
    });

  /** The backend saves the account and its Desktop sign-in as one operation. */
  const importDesktopLogin = (
    close = false,
    selected?: { uuid: string; email: string | null },
  ) =>
    run("desktop:import", async () => {
      const detected =
        selected ??
        (swap?.accountUuid
          ? {
              uuid: swap.accountUuid,
              email: desktopEmail,
            }
          : null);
      if (!detected) throw new Error("没有读到本机登录，请重新检测后再试。");
      try {
        const outcome = await claudeAccountsApi.importDesktopLogin(
          detected.uuid,
          detected.email,
          close,
        );
        if (outcome.status === "desktop_running") {
          setLocalImport(detected);
          return;
        }
        setLocalImport(null);
        if (outcome.account) {
          swapMessage(
            { kind: "capture", account: outcome.account },
            outcome,
            nameOf,
          );
        }
      } catch (cause) {
        if (close) setLocalImport(null);
        throw cause;
      }
    });

  // ----- the saved logins: order -----
  // Only the logins this page lists: a hidden Desktop-only login must not
  // take a place in the order being edited.
  const readableIds = (code?.accounts ?? [])
    .filter(
      (account) =>
        !account.unreadable &&
        (mode === "desktop" || account.kind !== "desktop_only"),
    )
    .map((account) => account.id);

  const commitOrder = (next: string[]) => {
    // A list read before this move would put the old order back.
    loadGeneration.current += 1;
    setCode((current) => {
      if (!current) return current;
      const byId = new Map(current.accounts.map((a) => [a.id, a]));
      const listed = next.flatMap((id) => byId.get(id) ?? []);
      const rest = current.accounts.filter((a) => !next.includes(a.id));
      return { ...current, accounts: [...listed, ...rest] };
    });
    // One after the other, so the last move is the one that stays saved.
    orderQueue.current = orderQueue.current
      .then(() => claudeAccountsApi.reorder(next))
      .then(
        () => undefined,
        (cause) => {
          toast.error(errorText(cause));
          if (mounted.current) void load();
        },
      );
  };
  const sortable = useSortable(readableIds, commitOrder);
  const moveAccount = (id: string, delta: -1 | 1) => {
    const next = moveBy(readableIds, id, delta);
    if (next === readableIds) return;
    commitOrder(next);
    setAnnouncement(
      `已把「${nameOf(id)}」移到第 ${next.indexOf(id) + 1} 位，共 ${next.length} 个`,
    );
    // The row re-renders in its new place; keep the keyboard on its grip.
    window.requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>(
          `[data-id="${id}"] .claude-account-grip`,
        )
        ?.focus(),
    );
  };

  const disabled = busy !== null;
  const title = mode === "code" ? "Claude Code 账号" : "Claude Desktop 账号";
  const description =
    mode === "code"
      ? code?.sessionsSupported
        ? "切换账号不影响会话、设置与 MCP；也可以让多个账号在各自的终端里同时用。"
        : "切换账号不影响会话、设置与 MCP。"
      : "导入本机登录，查看剩余额度；点击其他账号卡片上的「切换到此账号」即可切换。";
  useReturnFocus(
    nameDialog !== null ||
      loginGuide ||
      removing !== null ||
      runningSwitch !== null ||
      desktopConfirm !== null ||
      localImport !== null,
  );

  // Desktop-only logins have no Claude Code tokens: not shown for Code.
  const codeRows = (code?.accounts ?? [])
    .filter((account) =>
      mode === "desktop"
        ? account.kind === "oauth" ||
          account.kind === "desktop_only" ||
          account.unreadable
        : account.kind !== "desktop_only",
    )
    .map((account) =>
      mode === "desktop"
        ? {
            ...account,
            isCurrent:
              swap?.signedIn === true &&
              !swap.apiMode &&
              swap.currentAccountId === account.id,
            plan: quota[`vault:${account.id}`]?.plan ?? account.plan,
          }
        : account,
    );
  // Dragging and moving only make sense on the whole list in its own order.
  const ordering = !query.trim() && filter === "all" && sortBy === "custom";
  const shownRows = visibleAccounts(codeRows, {
    query,
    filter,
    sort: sortBy,
    quotaOf: (account) =>
      quota[mode === "desktop" ? `vault:${account.id}` : account.id],
  });
  const refreshAll = async () => {
    if (refreshingAll) return;
    setRefreshingAll(true);
    try {
      await Promise.allSettled(
        codeRows
          .filter(
            (a) =>
              (a.kind === "oauth" ||
                (mode === "desktop" && a.kind === "desktop_only")) &&
              !a.disabled &&
              !a.unreadable,
          )
          .map((a) => readQuota(a.id, true, mode === "desktop")),
      );
    } finally {
      if (mounted.current) setRefreshingAll(false);
    }
  };
  const toolbar =
    codeRows.length > 0 ? (
      <AccountsToolbar
        accounts={codeRows}
        mode={mode}
        detectedCurrent={
          mode === "desktop" &&
          swap?.supported === true &&
          swap.signedIn &&
          !swap.apiMode &&
          !codeRows.some((account) => account.isCurrent)
        }
        query={query}
        onQuery={setQuery}
        filter={filter}
        onFilter={setFilter}
        sort={sortBy}
        onSort={setSortBy}
        grid={grid}
        onGrid={setGrid}
        hideEmail={hideEmail}
        onHideEmail={setHideEmail}
        refreshing={refreshingAll}
        onRefreshAll={() => void refreshAll()}
      />
    ) : null;
  const listClass = grid ? "claude-accounts-grid" : "claude-accounts-list";
  const exportable = codeRows.filter(
    (a) =>
      !a.unreadable &&
      a.kind !== "desktop_only" &&
      (a.kind !== "oauth" || a.email),
  ).length;
  const desktopRows = desktop ?? [];
  const defaultQuota = quota[DEFAULT_DESKTOP_ID];
  const currentSaved =
    swap?.signedIn && swap.currentAccountId
      ? codeRows.find((a) => a.id === swap.currentAccountId)
      : undefined;
  const defaultIdentityMatches = Boolean(
    swap?.signedIn &&
    defaultQuota?.accountUuid &&
    swap.accountUuid?.toLowerCase() === defaultQuota.accountUuid.toLowerCase(),
  );
  const desktopEmail = defaultIdentityMatches
    ? (defaultQuota?.email ?? null)
    : (currentSaved?.email ?? null);
  const showDetectedDesktop = Boolean(
    mode === "desktop" &&
    swap?.supported &&
    swap.signedIn &&
    !currentSaved &&
    (filter === "all" || (filter === "current" && !swap.apiMode)) &&
    (!query.trim() ||
      [desktopEmail, "本机已登录的账号", "Claude Desktop"].some((text) =>
        text?.toLowerCase().includes(query.trim().toLowerCase()),
      )),
  );
  const noMatch =
    shownRows.length === 0 &&
    !showDetectedDesktop &&
    (codeRows.length > 0 || (mode === "desktop" && swap?.signedIn)) ? (
      <p className="claude-accounts-empty">没有符合条件的账号。</p>
    ) : null;

  const saveLiveCode = () =>
    run("save-code", async () => {
      const saved = await claudeAccountsApi.saveCurrentCode();
      toast.success(`已导入本机 Claude Code 登录「${saved.name}」`);
    });
  const detectedLogins: DetectedLogin[] = [
    ...(mode === "desktop" &&
    swap?.supported &&
    swap.signedIn &&
    swap.accountUuid
      ? [
          {
            id: "desktop",
            source: "Claude Desktop · 本机登录",
            email: desktopEmail,
            plan: defaultIdentityMatches
              ? defaultQuota?.plan
              : currentSaved?.plan,
            managed: Boolean(currentSaved),
            onImport: () => void importDesktopLogin(),
          },
        ]
      : []),
    ...(code?.supported &&
    code.live?.signedIn &&
    (mode === "desktop" || !code.live.savedId)
      ? [
          {
            id: "code",
            source: "Claude Code · 本机登录",
            email: code.live.email ?? null,
            plan: code.live.plan,
            managed: Boolean(code.live.savedId),
            description: "导入订阅账号；首次在 Desktop 使用时仍需登录一次。",
            onImport: () => void saveLiveCode(),
          },
        ]
      : []),
  ];
  const openDefaultDesktop = () =>
    void run("launch:default", () =>
      claudeAccountsApi.launchDesktop(DEFAULT_DESKTOP_ID),
    );

  const headerAction =
    mode === "code" ? (
      code?.supported ? (
        <AddAccountMenu
          disabled={disabled}
          browserSupported={code.browserLoginSupported}
          exportable={exportable}
          detected={detectedLogins}
          onChanged={() => {
            void load();
            window.dispatchEvent(new CustomEvent(BINDINGS_CHANGED_EVENT));
          }}
          onTerminalGuide={() => void startLoginGuide()}
        />
      ) : null
    ) : (
      <AddAccountMenu
        disabled={disabled || !native}
        browserSupported={code?.browserLoginSupported === true}
        exportable={exportable}
        onChanged={() => {
          void load();
          window.dispatchEvent(new CustomEvent(BINDINGS_CHANGED_EVENT));
        }}
        mode="desktop"
        detected={detectedLogins}
        onDetect={load}
        onOpenDesktop={openDefaultDesktop}
        onCreateProfile={() => openNameDialog({ kind: "add-desktop" })}
      />
    );

  const rowFor = (account: ClaudeCodeAccount, forDesktop: boolean) => (
    <AccountRow
      key={account.id}
      account={account}
      quota={quota[forDesktop ? `vault:${account.id}` : account.id]}
      now={now}
      disabled={disabled}
      busy={busy}
      canSwitch={!forDesktop && code?.supported === true}
      canOpenSession={!forDesktop && code?.sessionsSupported === true}
      variant={grid ? "card" : "row"}
      hideEmail={hideEmail}
      onNote={() =>
        openNameDialog({
          kind: "note",
          id: account.id,
          note: account.note ?? "",
        })
      }
      sortable={
        ordering && readableIds.length > 1 && !account.unreadable
          ? sortable(account.id)
          : undefined
      }
      position={{
        first: readableIds[0] === account.id,
        last: readableIds[readableIds.length - 1] === account.id,
      }}
      desktop={
        forDesktop
          ? {
              supported: swap?.supported === true,
              apiMode: swap?.apiMode,
              snapshot: swap?.snapshots.find((s) => s.accountId === account.id),
              signedInHere:
                swap?.signedIn === true && swap.currentAccountId === account.id,
            }
          : undefined
      }
      onSwitch={() => void switchTo(account)}
      onRefresh={() => void readQuota(account.id, true, forDesktop)}
      onRename={() => renameSaved(account, forDesktop)}
      onToggleDisabled={() => void toggleDisabled(account)}
      onOpenSession={() => void openSession(account)}
      onCopyCommands={(shell) => void copyCommands(account, shell)}
      onBind={() => void bindFolder(account)}
      onDelete={() => removeSaved(account, forDesktop)}
      onMove={(delta) => moveAccount(account.id, delta)}
      onSaveDesktop={() =>
        void runDesktopSwap({ kind: "capture", account }, false)
      }
      onSwitchDesktop={() =>
        void runDesktopSwap({ kind: "switch", account }, false)
      }
      onOpenDesktop={openDefaultDesktop}
      onPrepareDesktop={() =>
        void runDesktopSwap({ kind: "prepare", account }, false)
      }
    />
  );

  return (
    <section
      className="claude-accounts-card"
      data-mode={mode}
      aria-labelledby={headingId}
    >
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
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {!live ? (
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
                    ? ((code.live.email && hideEmail
                        ? maskEmail(code.live.email)
                        : code.live.email) ??
                      (code.live.plan === "API Key"
                        ? "API Key 登录"
                        : "已登录（未读到邮箱）"))
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
                中登录，再点「保存当前登录为账号」；也可以点右上角「添加账号」，从浏览器授权、粘贴令牌或导入凭证文件。
              </p>
            ) : (
              <>
                {toolbar}
                {noMatch}
                <ul
                  className={listClass}
                  aria-label="已保存的 Claude Code 账号"
                >
                  {shownRows.map((account) => rowFor(account, false))}
                </ul>
              </>
            )}
          </>
        )
      ) : desktop === null ? (
        <p className="claude-accounts-note" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          正在读取账号…
        </p>
      ) : (
        <>
          <div className="claude-desktop-summary" aria-label="账号概况">
            <span>
              <strong>{codeRows.length}</strong> 个已保存账号
            </span>
            <span>
              <span
                className="claude-desktop-status-dot"
                data-active={swap?.apiMode || swap?.signedIn || undefined}
              />
              {swap === null
                ? "暂未读到 Desktop 状态"
                : swap.apiMode
                  ? "当前使用 API 线路"
                  : swap.signedIn
                    ? "Desktop 已登录"
                    : "Desktop 未登录"}
            </span>
            {swap?.signedIn && !currentSaved ? (
              <span>检测到可导入的本机登录</span>
            ) : null}
          </div>
          {toolbar}
          {noMatch}
          <ul className={listClass} aria-label="Claude Desktop 账号">
            {showDetectedDesktop ? (
              <li className="claude-account-card claude-detected-card">
                <header className="claude-account-card-head">
                  <span className="claude-account-avatar" aria-hidden="true">
                    <UserRound size={20} />
                  </span>
                  <div className="claude-account-identity">
                    <strong>
                      {desktopEmail
                        ? hideEmail
                          ? maskEmail(desktopEmail)
                          : desktopEmail
                        : "本机已登录的账号"}
                    </strong>
                    <span className="claude-account-meta">
                      从 Claude Desktop 检测到
                    </span>
                  </div>
                </header>
                <div className="claude-account-card-tags">
                  <span className="claude-account-tag" data-tone="success">
                    {swap?.apiMode ? "本机登录已保留" : "Desktop 当前使用"}
                  </span>
                  <span className="claude-account-tag" data-tone="warning">
                    待导入
                  </span>
                </div>
                <p className="claude-detected-description">
                  保存这个登录，之后可以从账号卡片一键切换回来。
                </p>
                <footer className="claude-account-card-foot">
                  <span className="claude-account-card-date">仅保存在本机</span>
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() => void importDesktopLogin()}
                  >
                    {busy === "desktop:import" ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                    一键导入
                  </Button>
                </footer>
              </li>
            ) : null}
            {shownRows.map((account) => rowFor(account, true))}
          </ul>
          {codeRows.length === 0 && !swap?.signedIn ? (
            <div className="claude-desktop-empty">
              <UserRound size={32} aria-hidden="true" />
              <h3>添加你的第一个账号</h3>
              <p>已在这台电脑登录 Claude？点击「添加账号」即可识别导入。</p>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={openDefaultDesktop}
              >
                打开 Claude Desktop
              </Button>
            </div>
          ) : null}
          {desktopRows.length > 0 ? (
            <details className="claude-desktop-profiles">
              <summary>
                独立窗口 <span>{desktopRows.length}</span>
              </summary>
              <p className="claude-accounts-note">
                独立窗口有各自的登录和设置，可同时使用。
              </p>
              <ul
                className="claude-accounts-list"
                aria-label="独立 Desktop 窗口"
              >
                {desktopRows.map((profile) => (
                  <li key={profile.id} className="claude-account-row">
                    <span className="claude-account-lead">
                      <span
                        className="claude-account-avatar"
                        aria-hidden="true"
                      >
                        {Array.from(profile.name || "?")[0]?.toUpperCase()}
                      </span>
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
                        {quota[profile.id]?.plan ? (
                          <span className="claude-accounts-plan">
                            {quota[profile.id]?.plan}
                          </span>
                        ) : null}
                      </div>
                      <span className="claude-account-meta">
                        {profile.signedIn
                          ? (quota[profile.id]?.email ?? "可与其他账号同时打开")
                          : "首次登录前请先完全退出 Claude Desktop（包括托盘图标）"}
                      </span>
                    </div>
                    {profile.signedIn ? (
                      <QuotaStrip
                        state={quota[profile.id]}
                        now={now}
                        label={profile.name}
                        statusText={DESKTOP_STATUS_TEXT}
                        onRefresh={() => void readQuota(profile.id, true)}
                      />
                    ) : (
                      <span aria-hidden="true" />
                    )}
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
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => openNameDialog({ kind: "add-desktop" })}
              >
                <Plus size={14} />
                创建独立窗口
              </Button>
            </details>
          ) : null}
        </>
      )}

      <Dialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open && busy !== "name") setNameDialog(null);
        }}
      >
        <DialogContent className="claude-accounts-dialog">
          <DialogTitle>
            {nameDialog?.kind === "note"
              ? "账号备注"
              : nameDialog?.kind === "rename"
                ? "重命名账号"
                : nameDialog?.kind === "save-code"
                  ? "保存当前登录"
                  : "添加 Claude Desktop 账号"}
          </DialogTitle>
          <DialogDescription>
            {nameDialog?.kind === "note"
              ? "只保存在本机，用来区分账号（例如用途、谁在用）。留空即清除。"
              : nameDialog?.kind === "save-code"
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
            <label htmlFor={nameInputId}>
              {nameDialog?.kind === "note" ? "备注" : "账号名称"}
            </label>
            <Input
              id={nameInputId}
              value={nameValue}
              maxLength={nameDialog?.kind === "note" ? 200 : 40}
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
                  (nameDialog?.kind !== "save-code" &&
                    nameDialog?.kind !== "note" &&
                    !nameValue.trim())
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
            {guideFrom
              ? "当前登录已保存，登录新账号不会丢失它，会话记录也不受影响。"
              : "现在没有可保存的登录。登录新账号后，回来把它保存为账号。"}
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
          mode === "code" || removing?.vault
            ? `只删除 Chimera 保存的这份登录${removing?.email ? `（${removing.email}）` : ""}。不会退出 Claude Code，不影响其他账号；它的并行会话目录和已保存的 Desktop 登录（包括暂存区里属于它的）也会一起删除，并行会话里的对话记录会移到保险库的 sessions-removed 文件夹里保留，绑定到它的目录会显示为失效。以后要再用这个账号需重新登录并保存。`
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

      <ConfirmDialog
        isOpen={desktopConfirm !== null || localImport !== null}
        busy={busy?.startsWith("desktop:") ?? false}
        title="需要先关闭 Claude Desktop"
        message={
          desktopConfirm?.kind === "switch"
            ? `切换默认 Claude Desktop 到「${desktopConfirm.account.name}」要先把它关掉（包括托盘里的），换好登录后会自动重新打开。关闭会一并结束 Desktop 里正在运行的 Claude Code 会话、定时任务和 MCP 服务，未保存的输入也会丢失，请先处理好。现在的登录和本地会话会先保存起来，切换后可继续查看。换好后如果 Desktop 回到登录页，重新登录一次即可。`
            : desktopConfirm?.kind === "prepare"
              ? `要让默认 Claude Desktop 回到登录页，先要把它关掉（包括托盘里的）。现在的登录会先保存起来，不会被退出，之后还能切换回来；然后打开 Desktop，你在里面登录「${desktopConfirm.account.name}」，再回来点「保存 Desktop 登录」。关闭会一并结束 Desktop 里正在运行的 Claude Code 会话、定时任务和 MCP 服务，未保存的输入也会丢失，请先处理好。`
              : "保存默认 Claude Desktop 的登录要先把它关掉（包括托盘里的），保存好后会自动重新打开。关闭会一并结束 Desktop 里正在运行的 Claude Code 会话、定时任务和 MCP 服务，未保存的输入也会丢失，请先处理好。"
        }
        confirmText="关闭并继续"
        cancelText="取消"
        variant="info"
        onCancel={() => {
          if (!busy) {
            setDesktopConfirm(null);
            setLocalImport(null);
          }
        }}
        onConfirm={() => {
          if (localImport) void importDesktopLogin(true, localImport);
          else if (desktopConfirm) void runDesktopSwap(desktopConfirm, true);
        }}
      />
    </section>
  );
}

export default ClaudeAccountsCard;
