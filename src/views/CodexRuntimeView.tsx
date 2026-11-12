import "@/components/CodexRuntimePage.css";
import "@/theme/v3/codex-runtime.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openNativeFileDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  FolderClock,
  FolderOpen,
  History,
  Info,
  LoaderCircle,
  Package,
  SquareTerminal,
  Stethoscope,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { settingsApi } from "@/lib/api/settings";
import type { Settings } from "@/types";
import {
  OperationReceipt,
  type ReceiptAction,
} from "@/components/OperationReceipt";
import { copyText } from "@/lib/clipboard";
import {
  buildReport,
  conclusionLine,
  errorText,
  formatReceiptTime,
  isPlainChinese,
  journalTimeMs,
  parseOperationError,
} from "@/lib/operationReceipt";
import {
  ensureStop,
  formatMegabytes,
  runtimeFailureReceipt,
  runtimeSuccessReceipt,
  runtimeText,
  withReceiptLine,
  type CodexInstallRecoveryEntry,
  type CodexOfflineInspection,
  type CodexRuntimeReleaseItem,
  type CodexRuntimeReleasePlan,
  type DownloadProgress,
  type ReleaseStatus,
  type RuntimeAction,
  type RuntimeOperation,
  type RuntimeOperationResult,
  type RuntimeReceipt,
  type RuntimeReceiptKind,
  type RuntimeStatus,
  type RuntimeUpdatePreferences,
} from "@/ChimeraApp";
import {
  isRuntimeDesignPreview,
  RUNTIME_DESIGN_SAMPLE,
} from "./CodexRuntimeView.designSamples";

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const runtimeChannelText = (source?: string | null) =>
  source === "mirror" ? "GitHub 镜像" : "自动（镜像）";

// UTC slicing (`publishedAt.slice(0, 10)`) shows the wrong calendar day in
// timezones ahead of UTC (e.g. UTC+8 late-evening releases). Format in the
// viewer's local timezone instead, and fall back gracefully for
// missing/unparseable timestamps rather than throwing or showing 1970-01-01
// (`new Date(null)` resolves to the epoch, not an invalid date).
const formatReleaseDate = (publishedAt?: string | null): string => {
  if (!publishedAt) return "发布时间未知";
  const parsed = new Date(publishedAt);
  if (Number.isNaN(parsed.getTime())) return "发布时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
};

// Journal sources read `mirror:latest`, `mirror:<package>` or `offline:<file>`.
const installSourceText = (source: string) =>
  source.startsWith("offline:")
    ? `离线安装包 ${source.slice("offline:".length)}`.trim()
    : source === "mirror:latest"
      ? "镜像最新版"
      : source.startsWith("mirror")
        ? "镜像"
        : source;

const runtimeReportFields = (runtime: RuntimeStatus | null) =>
  [
    [
      "本机 Codex",
      runtime?.installed
        ? `${runtime.version ?? "版本未知"} · ${runtimeText(runtime.installMode)}`
        : runtime
          ? "未检测到安装"
          : "未读取到安装状态",
    ],
    ["安装位置", runtime?.installPath],
  ] as const;

const reportTime = (at: number) =>
  new Date(at).toLocaleString("zh-CN", { hour12: false });

async function copyDiagnosticReport(report: string) {
  try {
    await copyText(report);
    toast.success("已复制诊断信息");
  } catch (error) {
    toast.error("复制诊断信息失败", { description: errorText(error) });
  }
}

// Writes survive navigation; remounted views must wait before reading preferences.
let runtimePreferenceSaveQueue = Promise.resolve();

// Re-read the installation at most this often when the window regains focus.
const RUNTIME_FOCUS_REFRESH_MS = 3000;

export function NewRuntimeView({
  runtime: runtimeProp,
  runtimeError = null,
  release: releaseProp,
  progress,
  operation,
  receipt = null,
  onCheck,
  onDiagnose,
  diagnosing,
  onAction,
  onRuntimeChanged,
  onOperationFinished,
  onRetryRuntime,
  onRefreshStatus,
  onReceipt,
  onOpenProxySettings,
}: {
  runtime: RuntimeStatus | null;
  runtimeError?: string | null;
  release: ReleaseStatus | null;
  progress: DownloadProgress | null;
  operation: RuntimeOperation | null;
  receipt?: RuntimeReceipt | null;
  onCheck: (preferences?: RuntimeUpdatePreferences) => unknown;
  onDiagnose: () => void;
  diagnosing: boolean;
  onAction: (
    value: RuntimeAction,
    preferences?: RuntimeUpdatePreferences,
  ) => void;
  onOperationFinished?: () => void;
  /** Resolves false when the update status could not be refreshed. */
  onRuntimeChanged?: (preferences?: RuntimeUpdatePreferences) => unknown;
  onRetryRuntime?: () => void;
  /** Re-reads the installation; called when the window regains focus. */
  onRefreshStatus?: () => unknown;
  onReceipt?: (receipt: RuntimeReceipt | null) => void;
  onOpenProxySettings?: () => void;
}) {
  // Browser design preview: show the §6 baseline install, keep every write off.
  const [designSample] = useState(isRuntimeDesignPreview);
  const runtime: RuntimeStatus | null = designSample
    ? RUNTIME_DESIGN_SAMPLE.runtime
    : runtimeProp;
  const release: ReleaseStatus | null = designSample
    ? RUNTIME_DESIGN_SAMPLE.release
    : releaseProp;
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [preferences, setPreferences] = useState<Pick<
    Settings,
    "codexInstallMode" | "codexUpdateSource" | "checkCodexUpdatesOnStart"
  > | null>(() =>
    designSample
      ? RUNTIME_DESIGN_SAMPLE.preferences
      : runningInTauri
        ? null
        : {},
  );
  const [preferencesError, setPreferencesError] = useState(false);
  const [preferencesRetry, setPreferencesRetry] = useState(0);
  const [pendingPreferenceKeys, setPendingPreferenceKeys] = useState<
    Set<string>
  >(new Set());
  const preferencesMounted = useRef(false);
  useEffect(() => {
    preferencesMounted.current = true;
    return () => {
      preferencesMounted.current = false;
    };
  }, []);
  const installMode = preferences?.codexInstallMode ?? "standard";
  const updateSource = preferences?.codexUpdateSource ?? "auto";
  const preferencesBusy = !preferences || pendingPreferenceKeys.size > 0;

  useEffect(() => {
    if (!runningInTauri) return;
    let cancelled = false;
    setPreferencesError(false);
    void runtimePreferenceSaveQueue
      .then(() => settingsApi.get())
      .then(
        (saved) => {
          if (!cancelled) setPreferences(saved);
        },
        (reason) => {
          if (cancelled) return;
          setPreferencesError(true);
          toast.error("读取更新偏好失败", { description: String(reason) });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [preferencesRetry]);
  // v2.5.0 M3：历史版本 / 离线导入 / 安装事务恢复
  const [recovery, setRecovery] = useState<CodexInstallRecoveryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyReleases, setHistoryReleases] = useState<
    CodexRuntimeReleaseItem[]
  >([]);
  const [pendingPlan, setPendingPlan] =
    useState<CodexRuntimeReleasePlan | null>(null);
  const [planningTag, setPlanningTag] = useState<string | null>(null);
  const [installingHistory, setInstallingHistory] = useState(false);
  const [offlineInspection, setOfflineInspection] = useState<
    (CodexOfflineInspection & { filePath: string }) | null
  >(null);
  const [inspectingOffline, setInspectingOffline] = useState(false);
  const [installingOffline, setInstallingOffline] = useState(false);
  const [historyError, setHistoryError] = useState<{
    title: string;
    raw: string;
    retry: () => void;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  useLightweightCloseBlocker(
    preferencesBusy ||
      installingHistory ||
      installingOffline ||
      inspectingOffline ||
      Boolean(planningTag),
  );

  const maintenanceDialogRef = useDialogFocus<HTMLElement>(
    () => setMaintenanceOpen(false),
    maintenanceOpen,
  );
  const historyDialogRef = useDialogFocus<HTMLElement>(
    () => setHistoryOpen(false),
    historyOpen,
  );
  const offlineDialogRef = useDialogFocus<HTMLElement>(
    () => setOfflineInspection(null),
    Boolean(offlineInspection),
  );

  const loadRecovery = useCallback(async () => {
    if (!runningInTauri) return;
    try {
      const entries = await invoke<CodexInstallRecoveryEntry[]>(
        "get_codex_install_recovery",
      );
      if (preferencesMounted.current) setRecovery(entries);
    } catch {
      // 恢复记录是提示性信息，读取失败不打扰用户
    }
  }, []);

  useEffect(() => {
    void loadRecovery();
  }, [loadRecovery]);

  // Codex can be updated or removed outside Chimera++ while this page sits in
  // the background, so re-read the installation when the window comes back.
  // Throttled, skipped while anything here is running, and the page entry
  // read counts as the first refresh.
  const refreshBusy =
    Boolean(operation) ||
    diagnosing ||
    checking ||
    installingHistory ||
    installingOffline ||
    inspectingOffline ||
    Boolean(planningTag);
  const lastStatusRefreshRef = useRef(Date.now());
  const refreshStatusRef = useRef(onRefreshStatus);
  useLayoutEffect(() => {
    refreshStatusRef.current = onRefreshStatus;
  });
  useEffect(() => {
    if (!runningInTauri || refreshBusy) return;
    const refresh = () => {
      if (document.visibilityState !== "visible" || !refreshStatusRef.current)
        return;
      const now = Date.now();
      if (now - lastStatusRefreshRef.current < RUNTIME_FOCUS_REFRESH_MS) return;
      lastStatusRefreshRef.current = now;
      void refreshStatusRef.current();
      void loadRecovery();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshBusy, loadRecovery]);

  const acknowledgeRecovery = async (id: string) => {
    try {
      await invoke("acknowledge_codex_install_recovery", { id });
      await loadRecovery();
    } catch (reason) {
      toast.error("更新恢复记录失败", { description: String(reason) });
    }
  };

  const loadHistoryReleases = useCallback(
    async (page: number) => {
      if (designSample) {
        setHistoryReleases(page === 1 ? RUNTIME_DESIGN_SAMPLE.releases : []);
        setHistoryPage(page);
        return;
      }
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const items = await invoke<CodexRuntimeReleaseItem[]>(
          "list_codex_runtime_releases",
          { page },
        );
        setHistoryReleases(items);
        setHistoryPage(page);
      } catch (reason) {
        // An empty list would read as "no versions"; say the read failed.
        setHistoryError({
          title: "无法读取版本目录",
          raw: errorText(reason),
          retry: () => void loadHistoryReleases(page),
        });
      } finally {
        setHistoryLoading(false);
      }
    },
    [designSample],
  );

  const openHistory = () => {
    setMaintenanceOpen(false);
    setHistoryOpen(true);
    setPendingPlan(null);
    if (!historyReleases.length) void loadHistoryReleases(1);
  };

  const planHistoryRelease = async (tag: string) => {
    if (designSample) return;
    setPlanningTag(tag);
    setHistoryError(null);
    try {
      const plan = await invoke<CodexRuntimeReleasePlan>(
        "plan_codex_runtime_release",
        { tag },
      );
      setPendingPlan(plan);
    } catch (reason) {
      setHistoryError({
        title: "无法读取这个版本的安装包信息",
        raw: errorText(reason),
        retry: () => void planHistoryRelease(tag),
      });
    } finally {
      setPlanningTag(null);
    }
  };

  const refreshFailedLine =
    "更新状态没有刷新成功，可以稍后重新检查；已安装的版本不受影响。";

  const installHistoryRelease = async () => {
    if (!pendingPlan || preferencesBusy) return;
    const plan = pendingPlan;
    const choice: RuntimeUpdatePreferences = {
      source: updateSource,
      installMode,
    };
    setInstallingHistory(true);
    onReceipt?.(null);
    try {
      // 确认对象原样传回：版本、资产、SHA-256 与下载地址全部锁定，
      // 目录刷新不会改变本次安装的目标。
      const result = await invoke<RuntimeOperationResult | null>(
        "install_codex_runtime_release",
        {
          plan,
          installMode,
          confirm: true,
        },
      );
      let next = runtimeSuccessReceipt("history", result, plan.version, choice);
      setPendingPlan(null);
      setHistoryOpen(false);
      if ((await onRuntimeChanged?.(choice)) === false)
        next = withReceiptLine(next, refreshFailedLine);
      onReceipt?.(next);
      await loadRecovery();
    } catch (reason) {
      // The dialog stays open on the locked plan and shows this receipt.
      onReceipt?.(runtimeFailureReceipt("history", reason, choice));
    } finally {
      setInstallingHistory(false);
      onOperationFinished?.();
    }
  };

  const pickOfflinePackage = async () => {
    if (designSample) return;
    setMaintenanceOpen(false);
    let filePath: string | null = null;
    try {
      const selected = await openNativeFileDialog({
        multiple: false,
        title: "选择 Codex 安装包",
        filters: [{ name: "Codex 安装包", extensions: ["msix", "Msix"] }],
      });
      filePath = typeof selected === "string" ? selected : null;
    } catch (reason) {
      toast.error("无法打开文件选择窗口", { description: errorText(reason) });
      return;
    }
    if (!filePath) return;
    setInspectingOffline(true);
    onReceipt?.(null);
    try {
      const inspection = await invoke<CodexOfflineInspection>(
        "inspect_codex_runtime_package",
        { filePath },
      );
      setOfflineInspection({ ...inspection, filePath });
    } catch (reason) {
      onReceipt?.(runtimeFailureReceipt("offline", reason));
    } finally {
      setInspectingOffline(false);
    }
  };

  const installOfflinePackage = async () => {
    if (!offlineInspection) return;
    const inspection = offlineInspection;
    setInstallingOffline(true);
    onReceipt?.(null);
    try {
      const result = await invoke<RuntimeOperationResult | null>(
        "install_codex_runtime_offline",
        {
          filePath: inspection.filePath,
          expectedSha256: inspection.sha256,
          confirm: true,
        },
      );
      let next = runtimeSuccessReceipt(
        "offline",
        result,
        inspection.packageVersion,
      );
      setOfflineInspection(null);
      if (
        (await onRuntimeChanged?.({ source: updateSource, installMode })) ===
        false
      )
        next = withReceiptLine(next, refreshFailedLine);
      onReceipt?.(next);
      await loadRecovery();
    } catch (reason) {
      onReceipt?.(runtimeFailureReceipt("offline", reason));
    } finally {
      setInstallingOffline(false);
      onOperationFinished?.();
    }
  };
  const version = runtime?.version ?? "等待识别";
  const runtimeSupported = runtime?.supported !== false;
  const runtimeUnreadable = runningInTauri && !runtime && Boolean(runtimeError);
  // Live data on screen: the desktop app, or the design-preview sample.
  const live = runningInTauri || designSample;
  const installed = live && runtime?.installed === true;
  const previousVersion =
    runtime?.history?.find((item) => item.state === "previous")?.version ??
    null;
  const updateAvailable = release?.updateAvailable === true;
  const selectedInstallLabel = runtimeText(installMode);
  const updateActionLabel = updateAvailable
    ? `下载并安装 ${selectedInstallLabel}`
    : "检查更新";
  const percent = progress?.total
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : 0;
  const retries = progress?.retries ?? 0;
  const actionsLocked =
    !runningInTauri ||
    !runtimeSupported ||
    preferencesBusy ||
    Boolean(operation);
  const startAction = (
    action: RuntimeAction,
    preferences?: RuntimeUpdatePreferences,
  ) => {
    if (actionsLocked) return;
    setMaintenanceOpen(false);
    onAction(action, preferences);
  };
  const selectedPreferences: RuntimeUpdatePreferences = {
    source: updateSource,
    installMode,
  };
  const checkSelectedRuntime = async () => {
    if (actionsLocked || checking) return;
    setChecking(true);
    try {
      await onCheck(selectedPreferences);
    } finally {
      if (preferencesMounted.current) setChecking(false);
    }
  };
  const runDiagnostics = () => {
    setMaintenanceOpen(false);
    onDiagnose();
  };
  const operationLabel = progress
    ? progress.stage === "installing"
      ? "正在校验并安装，请勿关闭窗口"
      : progress.total > 0
        ? `${retries ? "连接中断，正在重新下载" : "正在下载"} ${percent}%`
        : retries
          ? "连接中断，正在重新下载"
          : "正在下载，等待获取文件大小"
    : operation?.action === "uninstall"
      ? "正在卸载 Codex，请稍候"
      : operation?.action === "rollback"
        ? "正在恢复上一版本，请稍候"
        : operation
          ? "正在准备操作，请稍候"
          : null;
  // Next steps a receipt offers; the first one available is the primary.
  const retryReceipt = (current: RuntimeReceipt): (() => void) | null => {
    switch (current.kind) {
      case "update":
      case "install":
        return () =>
          startAction("update", current.preferences ?? selectedPreferences);
      case "repair":
      case "rollback":
      case "uninstall":
        return () => startAction(current.kind as RuntimeAction);
      case "check":
        return () => void checkSelectedRuntime();
      case "diagnose":
        return onDiagnose;
      case "history":
        return openHistory;
      case "offline":
        return () => void pickOfflinePackage();
    }
  };
  const receiptActions = (current: RuntimeReceipt): ReceiptAction[] => {
    const actions: ReceiptAction[] = [];
    for (const step of current.steps) {
      if (step === "retry") {
        const retry = retryReceipt(current);
        if (retry)
          actions.push({
            label: "重试",
            onClick: retry,
            disabled: actionsLocked || checking,
          });
      } else if (step === "proxy" && onOpenProxySettings) {
        actions.push({ label: "打开代理设置", onClick: onOpenProxySettings });
      } else if (step === "offline" && current.kind !== "offline") {
        actions.push({
          label: "离线导入安装包",
          onClick: () => void pickOfflinePackage(),
          disabled: actionsLocked || inspectingOffline,
        });
      } else if (step === "repair" && runtime?.canRepair) {
        actions.push({
          label: "修复安装",
          onClick: () => startAction("repair"),
          disabled: actionsLocked,
        });
      } else if (step === "diagnose" && current.kind !== "diagnose") {
        actions.push({
          label: "运行诊断",
          onClick: onDiagnose,
          disabled: diagnosing || Boolean(operation),
          busy: diagnosing,
        });
      }
    }
    return actions.map((action, index) =>
      index === 0 ? { ...action, primary: true } : action,
    );
  };
  const copyReceipt = (current: RuntimeReceipt) =>
    void copyDiagnosticReport(
      buildReport(
        `Chimera++ · Codex 管理 · ${current.title}`,
        [
          ["时间", reportTime(current.at)],
          ...runtimeReportFields(runtime),
          ["结论", current.lines.join(" ")],
          ["提示", current.notes.join(" ")],
        ],
        current.detail,
      ),
    );
  const renderReceipt = (current: RuntimeReceipt, inline = false) => (
    <OperationReceipt
      key={current.id}
      className={inline ? "runtime-dialog-receipt" : "runtime-receipt"}
      tone={current.tone}
      eyebrow={inline ? undefined : "最近一次操作"}
      time={formatReceiptTime(current.at)}
      title={current.title}
      lines={current.lines}
      notes={current.notes}
      detail={current.detail}
      actions={inline ? [] : receiptActions(current)}
      onCopy={() => copyReceipt(current)}
      onDismiss={!inline && onReceipt ? () => onReceipt(null) : undefined}
    />
  );
  const dialogReceipt = (kind: RuntimeReceiptKind) =>
    receipt?.kind === kind && receipt.tone === "error"
      ? renderReceipt(receipt, true)
      : null;
  // Why an installation-bound action is unavailable right now.
  const unavailableReason = !runningInTauri
    ? "浏览器预览不执行本机操作。"
    : !runtime
      ? runtimeUnreadable
        ? "读取到安装状态后可用。"
        : "正在读取安装状态。"
      : "尚未安装 Codex，安装后可用。";
  const noRollbackReason = !installed
    ? unavailableReason
    : runtime?.installMode === "standard"
      ? "标准安装由 Windows 管理，没有本地回滚副本。"
      : "只有通过 Chimera++ 更新过的免安装版才会保留上一版本。";
  const recoveryEntry = recovery[0];
  // Portable layout and a second, unmanaged standard install: one callout
  // under the status board. An interrupted migration keeps the Codex files in
  // the .layout- staging folder, so its title carries the "do not delete".
  const layoutInterrupted = runtime?.portableLayout === "interrupted";
  const unmanagedStandard = runtime?.unmanagedStandardVersion;
  const runtimeNotice =
    runningInTauri && (runtime?.layoutNotice || unmanagedStandard)
      ? {
          tone: layoutInterrupted ? ("warning" as const) : ("info" as const),
          title: layoutInterrupted
            ? "免安装版目录升级被中断 · 请勿删除 .layout- 暂存目录"
            : runtime?.layoutNotice
              ? "免安装版目录结构待升级"
              : `另检测到标准安装 ${unmanagedStandard}`,
          lines: [
            runtime?.layoutNotice,
            unmanagedStandard
              ? runtime?.layoutNotice
                ? `另检测到标准安装 ${unmanagedStandard}，它不由 Chimera++ 管理。`
                : "它不由 Chimera++ 管理；本页的更新、修复与卸载只作用于免安装版。"
              : null,
          ].filter((line): line is string => Boolean(line)),
        }
      : null;
  const saveRuntimePreference = (
    patch: Partial<Pick<Settings, "codexInstallMode" | "codexUpdateSource">>,
  ) => {
    if (!preferences || designSample) return;
    if (!runningInTauri) {
      setPreferences((current) => current && { ...current, ...patch });
      return;
    }
    const keys = Object.keys(patch);
    setPendingPreferenceKeys((current) => new Set([...current, ...keys]));
    // Patch only the selected fields; serialize replies so an older save cannot
    // overwrite a newer selection. Failed saves leave the confirmed values intact.
    runtimePreferenceSaveQueue = runtimePreferenceSaveQueue.then(async () => {
      try {
        const saved = await settingsApi.patchPreferences(patch);
        if (preferencesMounted.current) {
          setPreferences(saved);
          toast.success("更新偏好已保存");
        }
      } catch (reason) {
        toast.error("保存更新偏好失败", { description: String(reason) });
      } finally {
        if (preferencesMounted.current) {
          setPendingPreferenceKeys((current) => {
            const next = new Set(current);
            keys.forEach((key) => next.delete(key));
            return next;
          });
        }
      }
    });
  };
  const openInstallDirectory = async () => {
    if (!runningInTauri) return;
    try {
      await invoke("open_codex_runtime_directory");
    } catch (reason) {
      toast.error("无法打开安装目录", { description: String(reason) });
    }
  };
  const stateTone = !live
    ? "mute"
    : !runtimeSupported || runtimeUnreadable
      ? "bad"
      : runtime?.installed
        ? "ok"
        : "mute";
  const portableLayoutRow = !installed
    ? { tone: "mute", value: "安装后显示" }
    : runtime?.installMode !== "portable"
      ? { tone: "ok", value: "由 Windows 管理" }
      : layoutInterrupted
        ? { tone: "bad", value: "升级被中断" }
        : runtime?.layoutNotice
          ? { tone: "warn", value: "待升级" }
          : { tone: "ok", value: "正常" };
  const environmentRows: Array<{ label: string; tone: string; value: string }> =
    [
      {
        label: "系统支持",
        ...(!live
          ? { tone: "mute", value: "未检测本机" }
          : runtimeSupported
            ? { tone: "ok", value: "Windows · 可以管理" }
            : { tone: "bad", value: "仅支持 Windows" }),
      },
      {
        label: "安装识别",
        ...(!live
          ? { tone: "mute", value: "未检测本机" }
          : runtimeUnreadable
            ? { tone: "bad", value: "读取失败" }
            : !runtime
              ? { tone: "mute", value: "正在读取" }
              : runtime.installed
                ? { tone: "ok", value: "已识别安装" }
                : { tone: "warn", value: "未检测到 Codex" }),
      },
      { label: "目录结构", ...portableLayoutRow },
      {
        label: "其他安装",
        ...(!installed
          ? { tone: "mute", value: "安装后检查" }
          : unmanagedStandard
            ? {
                tone: "warn",
                value: `标准安装 ${unmanagedStandard} · 不受管理`,
              }
            : { tone: "ok", value: "未发现" }),
      },
      {
        label: "更新偏好",
        ...(preferencesError
          ? { tone: "bad", value: "读取失败" }
          : !preferences
            ? { tone: "mute", value: "正在读取" }
            : pendingPreferenceKeys.size > 0
              ? { tone: "mute", value: "正在保存" }
              : { tone: "ok", value: "已读取" }),
      },
    ];
  const historyRows = installed
    ? [
        {
          version:
            runtime?.history?.find((item) => item.state !== "previous")
              ?.version ?? version,
          state: "当前",
          current: true,
        },
        ...(previousVersion
          ? [{ version: previousVersion, state: "可回滚", current: false }]
          : []),
      ]
    : [];
  type RowAction = {
    key: string;
    icon: typeof Wrench;
    title: string;
    detail: string;
    onClick: () => void;
    disabled: boolean;
    danger?: boolean;
  };
  const maintenanceRows: Array<RowAction & { action: string; busy?: boolean }> =
    [
      {
        key: "diagnose",
        icon: Stethoscope,
        title: "运行诊断",
        detail: installed
          ? "检查安装、系统注册、运行依赖与启动情况，不修改本机文件。"
          : "尚未安装 Codex 时，诊断只会确认安装状态。",
        action: diagnosing ? "正在诊断" : "运行",
        onClick: onDiagnose,
        disabled:
          !runningInTauri ||
          !runtimeSupported ||
          diagnosing ||
          Boolean(operation),
        busy: diagnosing,
      },
      {
        key: "repair",
        icon: Wrench,
        title: "修复安装",
        detail: runtime?.canRepair
          ? "重新下载最新版本并按当前安装方式覆盖安装，配置与凭据保留；操作前会再次确认。"
          : unavailableReason,
        action: "修复",
        onClick: () => startAction("repair"),
        disabled: actionsLocked || !runtime?.canRepair,
      },
      {
        key: "rollback",
        icon: History,
        title: "回滚到上一版本",
        detail:
          live && runtime?.canRollback
            ? previousVersion
              ? `当前 ${version}，可回滚到 ${previousVersion}；当前版本会被替换。`
              : "恢复到上一版本；当前版本会被替换。"
            : noRollbackReason,
        action:
          runtime?.canRollback && previousVersion
            ? `回滚到 ${previousVersion}`
            : "回滚",
        onClick: () => startAction("rollback"),
        disabled: actionsLocked || !runtime?.canRollback,
      },
      {
        key: "history",
        icon: FolderClock,
        title: "安装历史版本",
        detail:
          "从镜像发布目录选择指定版本；选定后版本、安装包与 SHA-256 即被锁定。",
        action: "选择版本",
        onClick: openHistory,
        disabled: Boolean(operation) || preferencesBusy,
      },
      {
        key: "uninstall",
        icon: Trash2,
        title: "卸载 Codex",
        detail: runtime?.canUninstall
          ? "从本机移除 Codex；线路配置和 ~/.codex 中的会话与设置会保留。"
          : unavailableReason,
        action: "卸载",
        onClick: () => startAction("uninstall"),
        disabled: actionsLocked || !runtime?.canUninstall,
        danger: true,
      },
    ];
  const workspaceActions: RowAction[] = [
    {
      key: "diagnose",
      icon: Stethoscope,
      title: diagnosing ? "正在诊断" : "诊断",
      detail: "只检查，不修改本机文件",
      onClick: runDiagnostics,
      disabled: diagnosing || designSample,
    },
    {
      key: "repair",
      icon: Wrench,
      title: "修复",
      detail: "修复损坏的 Codex 安装文件",
      onClick: () => startAction("repair"),
      disabled: !runtime?.canRepair || preferencesBusy || actionsLocked,
    },
    {
      key: "rollback",
      icon: History,
      title: "回滚",
      detail: "恢复上一个可用版本",
      onClick: () => startAction("rollback"),
      disabled: !runtime?.canRollback || preferencesBusy || actionsLocked,
    },
    {
      key: "history",
      icon: FolderClock,
      title: "安装历史版本",
      detail: "从镜像发布目录选择并锁定指定版本",
      onClick: openHistory,
      disabled: Boolean(operation) || preferencesBusy,
    },
    {
      key: "offline",
      icon: Package,
      title: inspectingOffline ? "正在检查安装包…" : "离线导入安装包",
      detail: "校验本地 .Msix 的哈希与 OpenAI 签名后安装（免安装版）",
      onClick: () => void pickOfflinePackage(),
      disabled:
        designSample ||
        Boolean(operation) ||
        preferencesBusy ||
        inspectingOffline,
    },
    {
      key: "uninstall",
      icon: Trash2,
      title: "卸载 Codex",
      detail: "保留 Chimera++ 与线路配置",
      onClick: () => startAction("uninstall"),
      disabled: !runtime?.canUninstall || preferencesBusy || actionsLocked,
      danger: true,
    },
  ];
  const sizeText = (bytes?: number | null) =>
    bytes && bytes > 0 ? formatMegabytes(bytes) : "—";
  const bareVersion = (value?: string | null) =>
    (value ?? "").replace(/^v/i, "");
  return (
    <>
      <section className="runtime-reference-view" aria-label="Codex 管理">
        <header className="runtime-page-heading">
          <div>
            <h1>Codex 管理</h1>
            <p>本机 Codex 的安装、更新与维护 · 只改动本机</p>
          </div>
          <div className="runtime-heading-actions">
            <button
              type="button"
              className="secondary"
              title={installed ? undefined : "尚未安装 Codex，没有可打开的目录"}
              onClick={() => void openInstallDirectory()}
              disabled={
                !runningInTauri ||
                !installed ||
                !runtimeSupported ||
                Boolean(operation)
              }
            >
              <FolderOpen size={14} aria-hidden="true" />
              打开安装目录
            </button>
            <button
              type="button"
              className="primary"
              onClick={onDiagnose}
              disabled={
                !runningInTauri ||
                !runtimeSupported ||
                diagnosing ||
                Boolean(operation)
              }
              aria-busy={diagnosing || undefined}
            >
              {diagnosing && (
                <LoaderCircle className="spin" size={14} aria-hidden="true" />
              )}
              {diagnosing ? "正在诊断" : "运行诊断"}
            </button>
          </div>
        </header>
        {operationLabel && (
          <section
            className="runtime-task-card"
            aria-label="当前安装任务"
            aria-busy="true"
          >
            <div className="runtime-task-heading">
              <div>
                <h2 role="status">{operationLabel}</h2>
                <p>请保持 Chimera++ 运行。完成后会自动刷新本机安装状态。</p>
              </div>
              {progress?.stage !== "installing" &&
                progress &&
                progress.total > 0 && (
                  <strong>
                    {percent}
                    <small>%</small>
                  </strong>
                )}
            </div>
            <div className="runtime-reference-progress">
              <i
                role="progressbar"
                aria-label="安装进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  progress &&
                  progress.total > 0 &&
                  progress.stage !== "installing"
                    ? percent
                    : undefined
                }
                aria-valuetext={operationLabel}
              >
                <u
                  className={
                    !progress ||
                    !progress.total ||
                    progress.stage === "installing"
                      ? "is-indeterminate"
                      : ""
                  }
                  style={{
                    width:
                      progress && progress.total > 0 ? `${percent}%` : "38%",
                  }}
                />
              </i>
            </div>
            <div className="runtime-task-detail">
              <span>
                {progress && progress.stage !== "installing"
                  ? `${formatMegabytes(progress.downloaded)}${progress.total > 0 ? ` / ${formatMegabytes(progress.total)}` : " 已接收"}`
                  : "本机操作进行中，请勿关闭窗口"}
              </span>
              <span>
                {progress?.stage === "installing"
                  ? "下载完成 · 校验并安装"
                  : retries
                    ? `已自动重试 ${retries} 次`
                    : "完成后自动刷新安装状态"}
              </span>
            </div>
          </section>
        )}
        <section className="runtime-hero" aria-label="本机 Codex">
          <span className="runtime-hero-mark" aria-hidden="true">
            <SquareTerminal size={22} strokeWidth={1.6} />
          </span>
          <div className="runtime-hero-identity">
            <p className="runtime-hero-title">
              <span>Codex CLI</span>
              {installed && runtime?.version ? (
                <code>{runtime.version}</code>
              ) : null}
            </p>
            {!live ? (
              <p className="runtime-hero-line">
                浏览器预览不读取本机安装，也不执行下载、修复或卸载。
              </p>
            ) : updateAvailable && release ? (
              <p className="runtime-hero-line" role="status">
                {`Codex ${release.latestVersion} 可用 · `}
                {[
                  release.currentVersion &&
                  installed &&
                  release.currentVersion === runtime?.version
                    ? null
                    : release.currentVersion
                      ? `当前 ${release.currentVersion} → ${release.latestVersion}`
                      : `将安装 ${release.latestVersion}`,
                  release.sizeBytes > 0
                    ? formatMegabytes(release.sizeBytes)
                    : null,
                  release.releasedAt
                    ? `${formatReleaseDate(release.releasedAt)} 发布`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : (
              <p className="runtime-hero-line">
                {release
                  ? `已是最新 · 镜像上的最新版本是 ${release.latestVersion}`
                  : "尚未检查更新 · 点“检查更新”查询镜像上的最新版本"}
              </p>
            )}
            <h2 className={`runtime-hero-state is-${stateTone}`}>
              {!live
                ? "浏览器预览 · 未检测本机"
                : runtimeSupported
                  ? !runtime
                    ? runtimeUnreadable
                      ? "无法读取本机 Codex"
                      : "正在识别本机 Codex"
                    : runtime.installed
                      ? "已安装"
                      : "尚未安装 Codex"
                  : "Codex 更新管理仅支持 Windows"}
            </h2>
          </div>
          <dl className="runtime-hero-facts">
            <div>
              <dt>安装位置</dt>
              <dd title={live ? runtime?.installPath || undefined : undefined}>
                {!live
                  ? "未访问本机文件"
                  : !runtimeSupported
                    ? "不适用"
                    : runtime?.installed
                      ? runtime.installPath || "路径未识别"
                      : runtime
                        ? "未检测到"
                        : runtimeUnreadable
                          ? "读取失败"
                          : "正在识别"}
              </dd>
            </div>
            <div>
              <dt>安装方式</dt>
              <dd>
                {!live
                  ? "未检测"
                  : runtime?.installed
                    ? runtimeText(runtime.installMode)
                    : "—"}
              </dd>
            </div>
            <div>
              <dt>更新源</dt>
              <dd title="GitHub · Duojiyi/codex-app-mirror">
                {!live
                  ? "未读取"
                  : preferences
                    ? runtimeChannelText(updateSource)
                    : preferencesError
                      ? "读取失败"
                      : "读取中"}
              </dd>
            </div>
          </dl>
          <div className="runtime-hero-actions">
            {updateAvailable && live && (
              <button
                type="button"
                className="secondary runtime-update-action"
                onClick={() => startAction("update", selectedPreferences)}
                disabled={
                  !runtimeSupported ||
                  Boolean(operation) ||
                  preferencesBusy ||
                  designSample
                }
              >
                <Download size={14} aria-hidden="true" />
                {updateActionLabel}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => void checkSelectedRuntime()}
              disabled={actionsLocked || checking}
              aria-busy={checking || undefined}
              title={checking ? "正在查询镜像上的最新版本" : undefined}
            >
              {checking && (
                <LoaderCircle className="spin" size={14} aria-hidden="true" />
              )}
              {updateAvailable ? "重新检查" : "检查更新"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setMaintenanceOpen(true)}
              disabled={
                !runtimeSupported || Boolean(operation) || preferencesBusy
              }
            >
              安装方式与更新源
            </button>
            <small>
              启动时检查更新 ·{" "}
              <b>
                {!live
                  ? "未读取"
                  : preferences
                    ? preferences.checkCodexUpdatesOnStart === false
                      ? "已关闭"
                      : "已开启"
                    : preferencesError
                      ? "读取失败"
                      : "读取中"}
              </b>
            </small>
          </div>
        </section>
        {!operationLabel && receipt && renderReceipt(receipt)}
        {runtimeNotice && (
          <div
            className={`runtime-notice is-${runtimeNotice.tone}`}
            role="status"
            aria-labelledby="runtime-notice-title"
          >
            <span className="runtime-notice-icon" aria-hidden="true">
              {runtimeNotice.tone === "warning" ? (
                <TriangleAlert size={18} />
              ) : (
                <Info size={18} />
              )}
            </span>
            <div>
              <h3 id="runtime-notice-title">{runtimeNotice.title}</h3>
              {runtimeNotice.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
        )}
        {runtimeUnreadable && runtimeError && (
          <OperationReceipt
            className="runtime-receipt"
            tone="error"
            title="无法读取本机 Codex 安装状态"
            lines={[
              conclusionLine(parseOperationError(runtimeError)) ??
                "没有收到可以直接显示的原因，可展开技术详情查看。",
              "读到安装状态之前，修复、回滚和卸载暂不可用。",
            ]}
            detail={runtimeError}
            actions={
              onRetryRuntime
                ? [
                    {
                      label: "重新读取",
                      primary: true,
                      onClick: onRetryRuntime,
                    },
                  ]
                : []
            }
            onCopy={() =>
              void copyDiagnosticReport(
                buildReport(
                  "Chimera++ · Codex 管理 · 无法读取本机 Codex 安装状态",
                  [["时间", reportTime(Date.now())]],
                  runtimeError,
                ),
              )
            }
          />
        )}
        {preferencesError && (
          <div className="runtime-inline-alert" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <span>读取更新偏好失败，重试前无法检查或安装更新。</span>
            <button
              type="button"
              className="secondary compact"
              onClick={() => setPreferencesRetry((current) => current + 1)}
            >
              重试读取更新偏好
            </button>
          </div>
        )}
        {pendingPreferenceKeys.size > 0 && (
          <p className="runtime-inline-status" role="status">
            正在保存更新偏好…
          </p>
        )}
        {recoveryEntry &&
          !operationLabel &&
          !installingHistory &&
          !installingOffline && (
            <OperationReceipt
              className="runtime-receipt"
              tone="warning"
              eyebrow={
                recovery.length > 1
                  ? `共 ${recovery.length} 次安装没有完成，这是最近的一次`
                  : undefined
              }
              time={formatReceiptTime(journalTimeMs(recoveryEntry.startedAt))}
              title="上次安装没有完成"
              lines={[
                `Codex ${recoveryEntry.version} · ${runtimeText(recoveryEntry.installMode)} · ${installSourceText(recoveryEntry.source)}`,
                recoveryEntry.detail && isPlainChinese(recoveryEntry.detail)
                  ? ensureStop(recoveryEntry.detail)
                  : null,
                recoveryEntry.backupPath && runtime?.canRollback
                  ? "上一版本的备份还在，可以回滚恢复；如果 Codex 能正常打开，也可以忽略这条记录。"
                  : "如果 Codex 能正常打开，可以忽略这条记录；否则可以修复安装。",
              ]}
              actions={[
                ...(recoveryEntry.backupPath && runtime?.canRollback
                  ? [
                      {
                        label: previousVersion
                          ? `回滚到 ${previousVersion}`
                          : "回滚到上一版本",
                        primary: true,
                        onClick: () => startAction("rollback"),
                        disabled: actionsLocked,
                      },
                    ]
                  : []),
                {
                  label: "我已处理",
                  onClick: () => void acknowledgeRecovery(recoveryEntry.id),
                },
              ]}
            />
          )}
        <div className="runtime-grid">
          <section
            className="runtime-card runtime-maintenance-card"
            aria-label="维护"
          >
            <header className="runtime-card-head">
              <h2>维护</h2>
              <p>除诊断外，这些操作会先关闭正在运行的 Codex，请先保存工作</p>
            </header>
            <ul className="runtime-maintenance-items">
              {maintenanceRows.map((row) => {
                const Icon = row.icon;
                return (
                  <li
                    key={row.key}
                    className={row.danger ? "is-danger" : undefined}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>
                      <strong>{row.title}</strong>
                      <small>{row.detail}</small>
                    </span>
                    <button
                      type="button"
                      className={row.danger ? "secondary danger" : "secondary"}
                      onClick={row.onClick}
                      disabled={row.disabled}
                      aria-busy={row.busy || undefined}
                    >
                      {row.busy && (
                        <LoaderCircle
                          className="spin"
                          size={14}
                          aria-hidden="true"
                        />
                      )}
                      {row.action}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="runtime-card-foot">
              卸载后 Chimera++ 仍可管理第三方线路，但需要重新安装 Codex
              才能切换。
            </p>
          </section>
          <div className="runtime-side">
            <section className="runtime-card" aria-label="本机版本">
              <header className="runtime-card-head">
                <h2>版本历史</h2>
                <p>本机保留的版本</p>
              </header>
              {historyRows.length > 0 && (
                <ul className="runtime-version-rows">
                  {historyRows.map((row) => (
                    <li
                      key={`${row.state}-${row.version}`}
                      className={row.current ? "is-current" : undefined}
                    >
                      <code>{row.version}</code>
                      <span>{row.state}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="runtime-card-note">
                {!live
                  ? "连接本机后显示实际版本。"
                  : runtimeUnreadable
                    ? "读取安装状态后显示版本。"
                    : !runtime
                      ? "正在读取本机版本。"
                      : !runtime.installed
                        ? "尚未安装 Codex，安装后显示当前版本与可回滚的上一版本。"
                        : previousVersion
                          ? "上一版本可在左侧“维护”中回滚。"
                          : `没有可回滚的上一版本。${noRollbackReason}`}
              </p>
            </section>
            <section className="runtime-card" aria-label="本机环境">
              <header className="runtime-card-head">
                <h2>本机环境</h2>
                <p>完整检查请运行诊断</p>
              </header>
              <ul className="runtime-env-rows">
                {environmentRows.map((row) => (
                  <li key={row.label} className={`is-${row.tone}`}>
                    <i aria-hidden="true" />
                    <span>{row.label}</span>
                    <em>{row.value}</em>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </section>
      {maintenanceOpen && (
        <div
          className="runtime-maintenance-page"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMaintenanceOpen(false);
          }}
        >
          <section
            ref={maintenanceDialogRef}
            className="runtime-maintenance-workspace"
            role="dialog"
            aria-modal="true"
            aria-label="安装与维护"
            tabIndex={-1}
          >
            <header>
              <div>
                <h2>安装与维护</h2>
                <p>分别选择安装方式与下载更新源；配置与凭据不受影响</p>
              </div>
              <button
                type="button"
                aria-label="关闭安装与维护"
                onClick={() => setMaintenanceOpen(false)}
              >
                <ChevronLeft size={15} aria-hidden="true" /> 返回 Codex 管理
              </button>
            </header>
            <div className="runtime-maintenance-content">
              <div className="runtime-workspace-main">
                <section className="runtime-card">
                  <header className="runtime-card-head">
                    <h3>安装方式</h3>
                  </header>
                  <div className="runtime-choice-list">
                    <button
                      type="button"
                      className={`runtime-mode-card ${installMode === "standard" ? "is-active" : ""}`}
                      disabled={
                        designSample ||
                        !preferences ||
                        pendingPreferenceKeys.has("codexInstallMode")
                      }
                      aria-pressed={installMode === "standard"}
                      onClick={() =>
                        saveRuntimePreference({ codexInstallMode: "standard" })
                      }
                    >
                      <span className="runtime-radio" aria-hidden="true" />
                      <span>
                        <strong>标准安装</strong>
                        <small>自动集成到 Windows，适合大多数用户</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`runtime-mode-card ${installMode === "portable" ? "is-active" : ""}`}
                      disabled={
                        designSample ||
                        !preferences ||
                        pendingPreferenceKeys.has("codexInstallMode")
                      }
                      aria-pressed={installMode === "portable"}
                      onClick={() =>
                        saveRuntimePreference({ codexInstallMode: "portable" })
                      }
                    >
                      <span className="runtime-radio" aria-hidden="true" />
                      <span>
                        <strong>免安装版</strong>
                        <small>便携运行，可放在任意目录</small>
                      </span>
                    </button>
                  </div>
                </section>
                <section className="runtime-card">
                  <header className="runtime-card-head">
                    <h3>更新源</h3>
                  </header>
                  <div className="runtime-choice-list runtime-source-segment">
                    {(
                      [
                        ["auto", "自动选择", "由 Chimera++ 选择可用的下载地址"],
                        ["mirror", "镜像安装", "固定从 GitHub 镜像下载"],
                      ] as const
                    ).map(([value, label, hint]) => (
                      <div className="runtime-source-option" key={value}>
                        <button
                          type="button"
                          className={updateSource === value ? "is-active" : ""}
                          disabled={
                            designSample ||
                            !preferences ||
                            pendingPreferenceKeys.has("codexUpdateSource")
                          }
                          aria-pressed={updateSource === value}
                          onClick={() =>
                            saveRuntimePreference({ codexUpdateSource: value })
                          }
                        >
                          <span className="runtime-radio" aria-hidden="true" />
                          {label}
                        </button>
                        <small>{hint}</small>
                      </div>
                    ))}
                  </div>
                  <p className="runtime-source-note">
                    当前安装包来自 GitHub 镜像：
                    <code>Duojiyi/codex-app-mirror</code>，非 OpenAI
                    官方下载站。
                  </p>
                </section>
              </div>
              <div className="runtime-workspace-side">
                <section className="runtime-card">
                  <header className="runtime-card-head">
                    <h3>当前状态</h3>
                  </header>
                  <dl className="runtime-state-list">
                    <div>
                      <dt>已安装版本</dt>
                      <dd>{installed ? version : "—"}</dd>
                    </div>
                    <div>
                      <dt>最新版本</dt>
                      <dd>{release ? release.latestVersion : "未检查"}</dd>
                    </div>
                    <div>
                      <dt>下次安装方式</dt>
                      <dd>{selectedInstallLabel}</dd>
                    </div>
                    <div>
                      <dt>包大小</dt>
                      <dd>{sizeText(release?.sizeBytes)}</dd>
                    </div>
                  </dl>
                  <p
                    className={`runtime-state-summary${updateAvailable ? " is-ok" : ""}`}
                  >
                    {updateAvailable && release
                      ? `可更新到 ${release.latestVersion}`
                      : release
                        ? "已是最新版本"
                        : "尚未检查更新"}
                  </p>
                </section>
                <section className="runtime-card">
                  <header className="runtime-card-head">
                    <h3>维护操作</h3>
                  </header>
                  <div className="runtime-maintenance-list">
                    {workspaceActions.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          type="button"
                          key={item.key}
                          className={item.danger ? "danger" : undefined}
                          onClick={item.onClick}
                          disabled={item.disabled}
                        >
                          <Icon size={15} aria-hidden="true" />
                          <span>
                            <strong>{item.title}</strong>
                            <small>{item.detail}</small>
                          </span>
                          <ChevronRight size={14} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>
            </div>
            <footer className="runtime-maintenance-footer">
              <button
                type="button"
                className="primary runtime-maintenance-primary"
                onClick={() => startAction("update", selectedPreferences)}
                disabled={Boolean(operation) || preferencesBusy || designSample}
              >
                <Download size={15} aria-hidden="true" />
                下载并安装 {selectedInstallLabel}
              </button>
            </footer>
          </section>
        </div>
      )}
      {historyOpen && (
        <div
          className="runtime-maintenance-page runtime-history-page"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !installingHistory)
              setHistoryOpen(false);
          }}
        >
          <section
            ref={historyDialogRef}
            className="runtime-maintenance-workspace runtime-history-workspace"
            role="dialog"
            aria-modal="true"
            aria-labelledby="runtime-history-title"
            tabIndex={-1}
          >
            <header>
              <div>
                <h2 id="runtime-history-title">安装历史版本</h2>
                <p>
                  版本来自 Chimera 镜像发布目录；选定后版本、安装包与 SHA-256
                  即被锁定，安装后会覆盖当前版本
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭历史版本"
                onClick={() => setHistoryOpen(false)}
                disabled={installingHistory}
              >
                <ChevronLeft size={15} aria-hidden="true" /> 返回 Codex 管理
              </button>
            </header>
            <div className="runtime-maintenance-content">
              <section className="runtime-card runtime-history-list">
                <header className="runtime-card-head">
                  <h3>可安装的版本</h3>
                  <p>第 {historyPage} 页</p>
                </header>
                <div className="runtime-history-columns" aria-hidden="true">
                  <span>版本</span>
                  <span>发布</span>
                  <span>状态</span>
                </div>
                <div className="runtime-history-rows">
                  {historyLoading && (
                    <p className="runtime-card-note" role="status">
                      正在加载版本目录…
                    </p>
                  )}
                  {/* A failed read must not look like an empty catalog. */}
                  {!historyLoading && historyError && (
                    <div className="history-dialog-error" role="alert">
                      <strong>{historyError.title}</strong>
                      <small>{historyError.raw}</small>
                      <button
                        type="button"
                        className="secondary"
                        onClick={historyError.retry}
                      >
                        重试
                      </button>
                    </div>
                  )}
                  {!historyLoading &&
                    !historyError &&
                    !historyReleases.length && (
                      <p className="runtime-card-note">
                        该页没有可安装的版本。
                      </p>
                    )}
                  {historyReleases.map((item) => {
                    const itemVersion = bareVersion(item.name || item.tag);
                    const isInstalled =
                      installed && itemVersion === bareVersion(version);
                    const chosen =
                      Boolean(pendingPlan) &&
                      itemVersion === bareVersion(pendingPlan?.version);
                    return (
                      <button
                        type="button"
                        key={item.tag}
                        className={chosen ? "is-selected" : undefined}
                        aria-pressed={chosen}
                        onClick={() => void planHistoryRelease(item.tag)}
                        disabled={
                          designSample ||
                          !item.installable ||
                          planningTag !== null ||
                          installingHistory
                        }
                      >
                        <strong>
                          {item.name || item.tag}
                          {item.prerelease ? "（预发布）" : ""}
                        </strong>
                        <small>{formatReleaseDate(item.publishedAt)}</small>
                        <em
                          className={
                            !item.installable
                              ? "is-mute"
                              : isInstalled
                                ? "is-ok"
                                : undefined
                          }
                        >
                          {planningTag === item.tag
                            ? "正在解析…"
                            : !item.installable
                              ? "缺少 Windows 安装包"
                              : isInstalled
                                ? "已安装"
                                : "可安装"}
                        </em>
                        <span className="runtime-radio" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
                <footer className="runtime-history-pager">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void loadHistoryReleases(historyPage - 1)}
                    disabled={historyLoading || historyPage <= 1}
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void loadHistoryReleases(historyPage + 1)}
                    disabled={historyLoading || historyReleases.length < 10}
                  >
                    下一页
                  </button>
                </footer>
              </section>
              <section className="runtime-card runtime-history-plan">
                <header className="runtime-card-head">
                  <h3>安装计划</h3>
                </header>
                {/* A failed install keeps the locked plan; show why here. */}
                {dialogReceipt("history")}
                {pendingPlan ? (
                  <>
                    <dl className="runtime-state-list">
                      <div>
                        <dt>目标版本</dt>
                        <dd>{pendingPlan.version}</dd>
                      </div>
                      {pendingPlan.packageVersion && (
                        <div>
                          <dt>包版本</dt>
                          <dd>{pendingPlan.packageVersion}</dd>
                        </div>
                      )}
                      <div>
                        <dt>大小</dt>
                        <dd>{sizeText(pendingPlan.sizeBytes)}</dd>
                      </div>
                      <div>
                        <dt>安装方式</dt>
                        <dd>{runtimeText(installMode)}</dd>
                      </div>
                      <div>
                        <dt>SHA-256</dt>
                        <dd>
                          <code title={pendingPlan.sha256}>
                            {pendingPlan.sha256}
                          </code>
                        </dd>
                      </div>
                      {pendingPlan.releasedAt && (
                        <div>
                          <dt>发布时间</dt>
                          <dd>{formatReleaseDate(pendingPlan.releasedAt)}</dd>
                        </div>
                      )}
                    </dl>
                    <p className="runtime-card-note">
                      安装会关闭正在运行的
                      Codex。历史版本降级不会被后台更新静默覆盖，安装前后都会复核哈希与
                      OpenAI 签名。
                    </p>
                    <div className="runtime-history-plan-actions">
                      <button
                        type="button"
                        className="primary"
                        onClick={() => void installHistoryRelease()}
                        disabled={installingHistory}
                      >
                        {installingHistory ? "正在安装…" : "确认安装此版本"}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setPendingPlan(null)}
                        disabled={installingHistory}
                      >
                        返回列表
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="runtime-card-note">
                    {designSample
                      ? "设计示例不读取安装包信息。在桌面应用中选择左侧的版本后，这里会显示锁定的版本、大小与 SHA-256。"
                      : "选择左侧的版本，这里会显示锁定的版本、大小与 SHA-256。"}
                  </p>
                )}
              </section>
            </div>
          </section>
        </div>
      )}
      {offlineInspection && (
        <div className="modal-backdrop">
          <section
            ref={offlineDialogRef}
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="runtime-offline-title"
            tabIndex={-1}
          >
            {offlineInspection.signatureValid &&
            offlineInspection.identityValid &&
            offlineInspection.architectureMatches ? (
              <CircleCheck size={26} />
            ) : (
              <CircleAlert size={26} />
            )}
            <h2 id="runtime-offline-title">确认离线安装？</h2>
            {dialogReceipt("offline")}
            <p>
              {offlineInspection.fileName} · Codex{" "}
              {offlineInspection.packageVersion} ·{" "}
              {offlineInspection.architecture} ·{" "}
              {(offlineInspection.sizeBytes / 1024 / 1024).toFixed(1)} MB
            </p>
            <p>
              <small>
                SHA-256：<code>{offlineInspection.sha256}</code>
              </small>
            </p>
            <p>
              <small>
                OpenAI 发行者签名：
                {offlineInspection.signatureValid ? "已通过" : "未通过"} ·
                包身份：
                {offlineInspection.identityValid
                  ? "Codex"
                  : offlineInspection.packageName}{" "}
                · 架构
                {offlineInspection.architectureMatches ? "匹配" : "不匹配"}
                。安装走免安装版，安装前会再次复核哈希。
              </small>
            </p>
            <footer>
              <button
                onClick={() => setOfflineInspection(null)}
                disabled={installingOffline}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => void installOfflinePackage()}
                disabled={
                  installingOffline ||
                  !offlineInspection.signatureValid ||
                  !offlineInspection.identityValid ||
                  !offlineInspection.architectureMatches
                }
              >
                {installingOffline ? "正在安装…" : "确认安装"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
