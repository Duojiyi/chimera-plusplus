import "./NewSettingsView.css";
import { ImportPanel } from "@/components/settings/ImportPanel";
import { ToolRegistryPanel } from "@/components/settings/ToolRegistryPanel";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/components/theme-provider";
import { LiveBackupsPanel } from "@/components/LiveBackupsPanel";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Download,
  FileSearch,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import type { Settings } from "@/types";
import { settingsApi, type PreferencesPatch } from "@/lib/api/settings";
import { getCurrentVersion } from "@/lib/updater";
import { useUpdate } from "@/contexts/UpdateContext";
import { extractErrorMessage } from "@/utils/errorUtils";

const DatabaseRecoveryPanel = lazy(() =>
  import("@/components/settings/DatabaseRecoveryPanel").then((m) => ({
    default: m.DatabaseRecoveryPanel,
  })),
);
const ConfigDirectoriesPanel = lazy(() =>
  import("@/components/settings/ConfigDirectoriesPanel").then((m) => ({
    default: m.ConfigDirectoriesPanel,
  })),
);
const OutboundProxyPanel = lazy(() =>
  import("@/components/settings/AdvancedConnectionPanels").then((m) => ({
    default: m.OutboundProxyPanel,
  })),
);
const FailoverSettingsPanel = lazy(() =>
  import("@/components/settings/AdvancedConnectionPanels").then((m) => ({
    default: m.FailoverSettingsPanel,
  })),
);

const settingsSections = [
  ["settings-tools", "工具"],
  ["settings-import", "导入"],
  ["settings-backups", "备份与恢复"],
  ["settings-connections", "代理与故障转移"],
  ["settings-directories", "配置目录"],
  ["settings-general", "通用设置"],
  ["settings-codex", "Codex 偏好"],
  ["settings-updates", "应用更新"],
] as const;
type SectionId = (typeof settingsSections)[number][0];
const firstSection: SectionId = settingsSections[0][0];
// 工具 and 导入 are pages of their own; the other sections share one scroll.
const isStandalone = (id: SectionId) =>
  id === "settings-tools" || id === "settings-import";
const scrolledSections = settingsSections
  .map(([id]) => id)
  .filter((id) => !isStandalone(id));
// A section stays current until less than this much of it is left below the
// top edge of the scroll area, so the highlight never points at a section
// that has scrolled out of view.
const SCROLL_SPY_OFFSET = 48;
const isSectionHash = (hash: string) =>
  settingsSections.some(([id]) => `#${id}` === hash);
const sectionFromLocation = (): SectionId =>
  settingsSections.find(([id]) => `#${id}` === window.location.hash)?.[0] ??
  firstSection;

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const defaultPreferences: PreferencesPatch = {
  codexUpdateSource: "auto",
  codexInstallMode: "standard",
  checkCodexUpdatesOnStart: true,
  checkProviderStatusOnStart: true,
  showProviderBalance: false,
  minimizeToTrayOnClose: true,
  lightweightOnClose: false,
};

const closeBehaviors = [
  ["tray", "最小化到托盘", "窗口收进托盘，Chimera++ 和本地路由继续运行"],
  ["exit", "退出软件", "完全退出 Chimera++，本地路由随之停止"],
  ["lightweight", "轻量模式", "关闭界面以释放内存，托盘和本地路由继续运行"],
] as const;

// Both values currently download from the same verified mirror: the runtime
// manager resolves "auto" to it on Windows. Say so instead of implying a
// difference that does not exist.
const updateSources = [
  [
    "auto",
    "自动选择",
    "推荐。由 Chimera++ 选择下载来源，目前从 GitHub 镜像下载并校验文件",
  ],
  [
    "mirror",
    "镜像安装",
    "固定从 GitHub 镜像下载并校验文件，目前与「自动选择」相同",
  ],
] as const;

const describeError = (reason: unknown) =>
  extractErrorMessage(reason) || String(reason);

function formatCheckedAt(time: number) {
  const date = new Date(time);
  const clock = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return date.toDateString() === new Date().toDateString()
    ? clock
    : `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

function DisclosureRow({
  id,
  title,
  description,
  expanded,
  disabled,
  onToggle,
}: {
  id: string;
  title: string;
  description: string;
  expanded: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="settings-reference-row settings-disclosure-row"
      aria-expanded={expanded}
      aria-controls={expanded ? `${id}-panel` : undefined}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      disabled={disabled}
      onClick={onToggle}
    >
      <span>
        <b id={`${id}-title`}>{title}</b>
        <small id={`${id}-description`}>{description}</small>
      </span>
      <ChevronDown
        className="settings-disclosure-icon"
        size={16}
        aria-hidden="true"
      />
    </button>
  );
}

export function NewSettingsView({
  liveBackupsEnabled = false,
  onImported,
}: {
  liveBackupsEnabled?: boolean;
  onImported?: () => void;
}) {
  const {
    hasUpdate,
    updateInfo,
    isChecking,
    isInstalling: installingAppUpdate,
    error: updateError,
    errorOperation: updateErrorOperation,
    lastCheckedAt,
    downloadProgress: appUpdateProgress,
    stagedVersion,
    isStaging,
    checkUpdate,
    installUpdate,
  } = useUpdate();
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  const [connectionPanel, setConnectionPanel] = useState<
    "proxy" | "failover" | null
  >(null);
  const [directoriesOpen, setDirectoriesOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Settings always opens at its first section, whatever an earlier visit left.
  const [activeSection, setActiveSection] = useState<SectionId>(firstSection);
  const [scrollRequest, setScrollRequest] = useState<{
    id: SectionId;
    focus: boolean;
  } | null>(null);
  // Where the last directory jump landed; its own scroll event must not move
  // the highlight away from the section the user picked.
  const jumpTop = useRef<number | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(false);
  const [appVersion, setAppVersion] = useState("正在读取版本");

  useEffect(() => {
    if (isSectionHash(window.location.hash)) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }
    const syncSection = () => {
      const section = sectionFromLocation();
      setActiveSection(section);
      setScrollRequest({ id: section, focus: false });
    };
    window.addEventListener("hashchange", syncSection);
    window.addEventListener("popstate", syncSection);
    return () => {
      window.removeEventListener("hashchange", syncSection);
      window.removeEventListener("popstate", syncSection);
    };
  }, []);

  // Layout effect: the target may have just been unhidden, and the jump must
  // land before paint.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const section = scrollRequest && document.getElementById(scrollRequest.id);
    if (!container || !section) return;
    container.scrollTop +=
      section.getBoundingClientRect().top -
      container.getBoundingClientRect().top;
    jumpTop.current = container.scrollTop;
    if (scrollRequest.focus) section.focus({ preventScroll: true });
  }, [scrollRequest]);

  const openSection = (id: SectionId) => {
    if (window.location.hash !== `#${id}`) {
      window.history.pushState(null, "", `#${id}`);
    }
    setActiveSection(id);
    setScrollRequest({ id, focus: true });
  };

  const followScroll = () => {
    const container = scrollRef.current;
    if (!container || isStandalone(activeSection)) return;
    if (
      jumpTop.current !== null &&
      Math.abs(container.scrollTop - jumpTop.current) < 1
    )
      return;
    jumpTop.current = null;
    const top = container.getBoundingClientRect().top;
    // The first section that still shows more than a sliver is the one being
    // read; near the end of the page that is the section at the top of the
    // view, never one that has already scrolled away.
    const current =
      scrolledSections.find((id) => {
        const section = document.getElementById(id);
        return (
          section !== null &&
          section.getBoundingClientRect().bottom - top > SCROLL_SPY_OFFSET
        );
      }) ?? scrolledSections[scrolledSections.length - 1];
    setActiveSection(current);
  };

  const loadSettings = async () => {
    setSettingsError(null);
    try {
      setSettings(await settingsApi.get());
    } catch (reason) {
      setSettingsError(describeError(reason));
    }
  };
  useEffect(() => {
    if (!runningInTauri) {
      setSettings({
        codexUpdateSource: "auto",
        codexInstallMode: "standard",
      } as Settings);
      setAppVersion("开发预览");
      return;
    }
    void getCurrentVersion()
      .then((version) => setAppVersion(version || "未知版本"))
      .catch(() => setAppVersion("未知版本"));
    void loadSettings();
  }, []);
  const save = (
    patch: PreferencesPatch,
    done?: { message: string; undo: PreferencesPatch },
  ) => {
    if (!settings) return;
    const keys = Object.keys(patch);
    setPendingKeys((current) => new Set([...current, ...keys]));
    // Serialize UI responses; backend applies only these fields under its lock.
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        if (runningInTauri) {
          setSettings(await settingsApi.patchPreferences(patch));
        } else {
          setSettings((current) =>
            current ? { ...current, ...patch } : current,
          );
        }
        if (done) {
          toast.success(done.message, {
            action: { label: "撤销", onClick: () => save(done.undo) },
          });
        } else {
          toast.success(runningInTauri ? "设置已保存" : "预览设置已更新");
        }
      } catch (reason) {
        toast.error("设置保存失败", { description: describeError(reason) });
      } finally {
        setPendingKeys((current) => {
          const next = new Set(current);
          keys.forEach((key) => next.delete(key));
          return next;
        });
      }
    });
  };
  const resetPreferences = () => {
    if (!settings) return;
    const undo = Object.fromEntries(
      Object.keys(defaultPreferences).map((key) => [
        key,
        settings[key as keyof PreferencesPatch],
      ]),
    ) as PreferencesPatch;
    save(defaultPreferences, { message: "已恢复默认设置", undo });
  };
  // Mirrors the backend default for a preference that was never saved.
  const launchOnStartup = settings?.launchOnStartup ?? true;
  // What the next launch will do: silent startup only applies with the tray
  // flag on (`AppSettings::starts_hidden`).
  const silentStartup =
    (settings?.silentStartup ?? false) && (settings?.showInTray ?? true);
  const toggleLaunchOnStartup = async () => {
    if (!settings || autoLaunchBusy) return;
    const enabled = !launchOnStartup;
    if (!runningInTauri) {
      setSettings((current) =>
        current ? { ...current, launchOnStartup: enabled } : current,
      );
      return;
    }
    setAutoLaunchBusy(true);
    try {
      // The backend registers the system entry and saves the preference as one
      // step and rolls back on failure, so the saved value only changes here.
      await settingsApi.setAutoLaunch(enabled);
      setSettings((current) =>
        current ? { ...current, launchOnStartup: enabled } : current,
      );
      toast.success("开机自启动设置已保存");
    } catch (reason) {
      toast.error("设置开机自启动失败", { description: describeError(reason) });
    } finally {
      setAutoLaunchBusy(false);
    }
  };
  const updateChecks = settings?.checkCodexUpdatesOnStart ?? true;
  const providerChecks = settings?.checkProviderStatusOnStart ?? true;
  const showProviderBalance = settings?.showProviderBalance ?? false;
  const updateSource =
    settings?.codexUpdateSource === "mirror" ? "mirror" : "auto";
  const closeBehavior = !(settings?.minimizeToTrayOnClose ?? true)
    ? "exit"
    : settings?.lightweightOnClose
      ? "lightweight"
      : "tray";
  useLightweightCloseBlocker(
    pendingKeys.size > 0 || autoLaunchBusy || installingAppUpdate || isStaging,
  );
  const openDataFolder = async () => {
    try {
      await settingsApi.openAppConfigFolder();
    } catch (reason) {
      toast.error("无法打开数据目录", { description: describeError(reason) });
    }
  };
  const revealLogFile = async () => {
    try {
      await settingsApi.revealAppLogFile();
    } catch (reason) {
      toast.error("无法打开日志位置", { description: describeError(reason) });
    }
  };
  const checkAppUpdate = async () => {
    if (!runningInTauri) {
      toast.info("浏览器预览无法检查更新");
      return;
    }
    try {
      await checkUpdate();
    } catch (reason) {
      toast.error("检查应用更新失败", { description: describeError(reason) });
    }
  };
  const installAppUpdate = async () => {
    try {
      const installed = await installUpdate();
      if (!installed) {
        toast.info("该更新已不可用", { description: "已重新检查更新" });
      }
    } catch (reason) {
      toast.error("应用更新未完成", { description: describeError(reason) });
    }
  };

  const availableVersion = updateInfo?.availableVersion;
  const installFailed = hasUpdate && updateErrorOperation === "install";
  const checkFailed = !hasUpdate && Boolean(updateError);
  const packageStaged =
    hasUpdate && !installFailed && stagedVersion === availableVersion;
  const appUpdatePercent =
    appUpdateProgress?.total && appUpdateProgress.total > 0
      ? Math.min(
          100,
          Math.round(
            (appUpdateProgress.downloaded / appUpdateProgress.total) * 100,
          ),
        )
      : null;
  // The install waits for a background download that reports no progress of
  // its own; say what it is waiting for instead of an open-ended "preparing".
  const finishingBackgroundDownload =
    installingAppUpdate && isStaging && appUpdatePercent === null;
  const updateTone = installingAppUpdate
    ? "available"
    : isChecking
      ? "idle"
      : installFailed || checkFailed
        ? "error"
        : hasUpdate
          ? "available"
          : lastCheckedAt
            ? "ok"
            : "idle";
  const appUpdateTitle = installingAppUpdate
    ? "正在更新 Chimera++"
    : isChecking
      ? "正在检查更新"
      : installFailed
        ? "更新未完成，可以重试"
        : hasUpdate && availableVersion
          ? `发现 Chimera++ ${availableVersion}`
          : checkFailed
            ? "检查更新失败"
            : lastCheckedAt
              ? "已是最新版本"
              : `Chimera++ ${appVersion}`;
  const appUpdateDescription = installingAppUpdate
    ? finishingBackgroundDownload
      ? "正在完成后台下载，完成后自动安装并重启"
      : appUpdatePercent === null
        ? "正在准备更新，完成后应用将自动重启"
        : appUpdatePercent >= 100
          ? "正在安装更新，完成后应用将自动重启"
          : "正在下载更新包，完成后自动安装并重启"
    : isChecking
      ? "正在连接稳定版更新源"
      : installFailed
        ? `${(updateError ?? "安装没有完成").replace(/[。.]+$/, "")}。旧版本未被替换。`
        : hasUpdate
          ? updateErrorOperation === "stage"
            ? "后台下载没有完成；点击后会重新下载、验证并安装"
            : packageStaged
              ? "更新包已下载并通过验证，安装后应用将自动重启"
              : isStaging
                ? "正在后台下载更新包；现在点击会等下载完成后安装"
                : "下载并验证后安装，完成后应用将自动重启"
          : checkFailed
            ? (updateError ?? "")
            : lastCheckedAt
              ? `Chimera++ ${appVersion} · 上次检查 ${formatCheckedAt(lastCheckedAt)}`
              : "Chimera++ 会自动检查新版本，也可以随时手动检查";
  const appUpdateButton = installingAppUpdate
    ? "正在更新…"
    : isChecking
      ? "正在检查…"
      : installFailed
        ? "重试更新"
        : hasUpdate
          ? packageStaged
            ? "安装并重启"
            : "下载并安装"
          : lastCheckedAt || checkFailed
            ? "重新检查"
            : "检查更新";
  const appUpdateProgressLabel =
    appUpdatePercent === null
      ? finishingBackgroundDownload
        ? "后台下载中"
        : "准备中"
      : appUpdatePercent >= 100
        ? "正在安装"
        : `${appUpdatePercent}%`;
  const releaseNotes = updateInfo?.notes?.trim();

  return (
    <section className="new-settings-view">
      <header className="settings-page-header">
        <h1>{t("settings.title", { defaultValue: "设置" })}</h1>
        <p>
          Chimera++ {appVersion} ·{" "}
          {runningInTauri ? "配置只保存在本机" : "浏览器预览，不读取本机数据"}
        </p>
      </header>
      <div className="settings-page-layout">
        <nav className="settings-page-nav" aria-label="设置目录">
          {settingsSections.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={activeSection === id ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault();
                openSection(id);
              }}
            >
              {label}
            </a>
          ))}
        </nav>
        <div
          className="settings-page-content"
          ref={scrollRef}
          tabIndex={0}
          aria-label="设置内容"
          onScroll={followScroll}
        >
          <div
            id="settings-tools"
            tabIndex={-1}
            hidden={activeSection !== "settings-tools"}
          >
            {activeSection === "settings-tools" && (
              <ToolRegistryPanel settings={settings} native={runningInTauri} />
            )}
          </div>
          <div
            id="settings-import"
            tabIndex={-1}
            hidden={activeSection !== "settings-import"}
          >
            {activeSection === "settings-import" && (
              <ImportPanel native={runningInTauri} onImported={onImported} />
            )}
          </div>
          <div
            hidden={isStandalone(activeSection)}
            className="settings-standard-sections"
          >
            {settingsError !== null && (
              <div className="settings-load-error" role="alert">
                <CircleAlert size={16} aria-hidden="true" />
                <span>
                  无法读取设置，以下偏好暂时不能修改。
                  {settingsError && <small>{settingsError}</small>}
                </span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void loadSettings()}
                >
                  重试
                </button>
              </div>
            )}
            <section
              id="settings-backups"
              aria-labelledby="settings-backups-heading"
              tabIndex={-1}
            >
              <h2 id="settings-backups-heading">备份与恢复</h2>
              {liveBackupsEnabled ? (
                <LiveBackupsPanel onRestored={onImported} />
              ) : (
                <div className="settings-backups-unavailable">
                  <div className="settings-backups-toolbar">
                    <button type="button" className="secondary" disabled>
                      打开备份目录
                    </button>
                  </div>
                  <div className="settings-backups-columns" aria-hidden="true">
                    <span>时间</span>
                    <span>触发</span>
                    <span>包含文件</span>
                    <span>大小</span>
                    <span>操作</span>
                  </div>
                  <div className="settings-backups-notice" role="status">
                    <b>
                      {runningInTauri
                        ? "备份功能尚未开放"
                        : "浏览器预览不读取本机备份"}
                    </b>
                    <p>
                      此处未连接本机备份服务，不展示示例记录，也不执行备份或恢复。
                    </p>
                  </div>
                </div>
              )}
              <div className="settings-reference-list settings-backups-database">
                <DisclosureRow
                  id="settings-database"
                  title="应用数据库"
                  description="手动备份或恢复 Chimera++ 保存的线路等数据"
                  expanded={dbOpen}
                  disabled={!runningInTauri || recoveryBusy}
                  onToggle={() => setDbOpen((open) => !open)}
                />
                {dbOpen && runningInTauri && (
                  <div
                    id="settings-database-panel"
                    className="settings-subpanel"
                  >
                    <Suspense
                      fallback={<p role="status">正在加载数据库备份…</p>}
                    >
                      <DatabaseRecoveryPanel
                        onRestored={onImported}
                        onBusyChange={setRecoveryBusy}
                      />
                    </Suspense>
                  </div>
                )}
              </div>
            </section>
            <section
              id="settings-connections"
              aria-labelledby="settings-connections-heading"
              tabIndex={-1}
            >
              <h2 id="settings-connections-heading">代理与故障转移</h2>
              <p className="settings-section-lead">
                默认都不启用。展开只读取当前状态，保存、测试和启用都需要你手动操作。
              </p>
              <div className="settings-reference-list">
                <DisclosureRow
                  id="settings-proxy"
                  title="全局出站代理"
                  description="Chimera++ 联网时使用的 HTTP 或 SOCKS 代理，不修改系统代理"
                  expanded={connectionPanel === "proxy"}
                  disabled={!runningInTauri}
                  onToggle={() =>
                    setConnectionPanel((panel) =>
                      panel === "proxy" ? null : "proxy",
                    )
                  }
                />
                {connectionPanel === "proxy" && runningInTauri && (
                  <div id="settings-proxy-panel" className="settings-subpanel">
                    <Suspense fallback={<p role="status">正在加载代理设置…</p>}>
                      <OutboundProxyPanel />
                    </Suspense>
                  </div>
                )}
                <DisclosureRow
                  id="settings-failover"
                  title="自动故障转移"
                  description="本地路由请求失败时，按队列换用下一条线路"
                  expanded={connectionPanel === "failover"}
                  disabled={!runningInTauri}
                  onToggle={() =>
                    setConnectionPanel((panel) =>
                      panel === "failover" ? null : "failover",
                    )
                  }
                />
                {connectionPanel === "failover" && runningInTauri && (
                  <div
                    id="settings-failover-panel"
                    className="settings-subpanel"
                  >
                    <Suspense
                      fallback={<p role="status">正在加载故障转移设置…</p>}
                    >
                      <FailoverSettingsPanel />
                    </Suspense>
                  </div>
                )}
              </div>
            </section>
            <section
              id="settings-directories"
              aria-labelledby="settings-directories-heading"
              tabIndex={-1}
            >
              <h2 id="settings-directories-heading">配置目录</h2>
              <div className="settings-reference-list">
                <DisclosureRow
                  id="settings-config-dirs"
                  title="配置目录与 WSL 路径"
                  description="自定义各工具和 Chimera++ 读取配置的位置，留空使用默认目录"
                  expanded={directoriesOpen}
                  disabled={!runningInTauri || directoryBusy}
                  onToggle={() => setDirectoriesOpen((open) => !open)}
                />
                {directoriesOpen && runningInTauri && (
                  <div
                    id="settings-config-dirs-panel"
                    className="settings-subpanel"
                  >
                    <Suspense fallback={<p role="status">正在加载目录设置…</p>}>
                      <ConfigDirectoriesPanel onBusyChange={setDirectoryBusy} />
                    </Suspense>
                  </div>
                )}
                <button
                  type="button"
                  className="settings-reference-row settings-link-row"
                  disabled={!runningInTauri}
                  onClick={() => void openDataFolder()}
                >
                  <span>
                    <b>打开数据目录</b>
                    <small>线路、备份和运行日志都保存在这里</small>
                  </span>
                  <FolderOpen size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="settings-reference-row settings-link-row"
                  disabled={!runningInTauri}
                  onClick={() => void revealLogFile()}
                >
                  <span>
                    <b>定位日志文件</b>
                    <small>
                      在文件管理器中选中运行日志，反馈问题时可以附上
                    </small>
                  </span>
                  <FileSearch size={16} aria-hidden="true" />
                </button>
              </div>
            </section>
            <section
              id="settings-general"
              aria-labelledby="settings-general-heading"
              tabIndex={-1}
            >
              <h2 id="settings-general-heading">通用设置</h2>
              <div className="settings-reference-list">
                <div className="settings-reference-row">
                  <span>
                    <b id="settings-language-label">
                      {t("settings.language", { defaultValue: "界面语言" })}
                    </b>
                    <small>当前版本仅提供简体中文界面。</small>
                  </span>
                  <span
                    className="settings-static-value"
                    aria-labelledby="settings-language-label"
                  >
                    简体中文
                  </span>
                </div>
                <div className="settings-reference-row">
                  <span>
                    <b id="settings-theme-label">
                      {t("settings.theme", { defaultValue: "应用主题" })}
                    </b>
                    <small>只改变 Chimera++ 自身；Codex 皮肤在「外观」里</small>
                  </span>
                  <div
                    className="settings-segment"
                    role="group"
                    aria-labelledby="settings-theme-label"
                  >
                    {(
                      [
                        [
                          "system",
                          t("settings.themeSystem", {
                            defaultValue: "跟随系统",
                          }),
                        ],
                        [
                          "light",
                          t("settings.themeLight", { defaultValue: "浅色" }),
                        ],
                        [
                          "dark",
                          t("settings.themeDark", { defaultValue: "深色" }),
                        ],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={theme === value ? "is-active" : undefined}
                        aria-pressed={theme === value}
                        onClick={() => setTheme(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-reference-row"
                  role="switch"
                  aria-checked={launchOnStartup}
                  disabled={!settings || autoLaunchBusy}
                  onClick={() => void toggleLaunchOnStartup()}
                >
                  <span>
                    <b>开机自启动</b>
                    <small>登录系统后自动启动 Chimera++</small>
                  </span>
                  <i
                    className={`settings-switch ${launchOnStartup ? "is-on" : ""}`}
                  >
                    <u />
                  </i>
                </button>
                {/* The backend only starts hidden when the tray flag is on too
                    (`AppSettings::starts_hidden`), because the tray icon is
                    what brings the window back. Turning the switch on sets
                    both, so the switch always shows what the next launch
                    will do. */}
                <button
                  type="button"
                  className="settings-reference-row"
                  role="switch"
                  aria-checked={silentStartup}
                  disabled={
                    !settings ||
                    pendingKeys.has("silentStartup") ||
                    pendingKeys.has("showInTray")
                  }
                  onClick={() =>
                    void save(
                      silentStartup
                        ? { silentStartup: false }
                        : { silentStartup: true, showInTray: true },
                    )
                  }
                >
                  <span>
                    <b>静默启动</b>
                    <small>
                      启动后只在托盘运行，不打开主窗口；从托盘图标打开界面
                    </small>
                  </span>
                  <i
                    className={`settings-switch ${silentStartup ? "is-on" : ""}`}
                  >
                    <u />
                  </i>
                </button>
                <div className="settings-reference-row">
                  <span>
                    <b id="close-behavior-label">关闭主窗口时</b>
                    <small id="close-behavior-note">
                      {
                        closeBehaviors.find(
                          ([value]) => value === closeBehavior,
                        )?.[2]
                      }
                    </small>
                  </span>
                  <div
                    className="settings-close-options"
                    role="radiogroup"
                    aria-labelledby="close-behavior-label"
                    aria-describedby="close-behavior-note"
                  >
                    {closeBehaviors.map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="close-behavior"
                          value={value}
                          checked={closeBehavior === value}
                          disabled={
                            !settings ||
                            pendingKeys.has("minimizeToTrayOnClose") ||
                            pendingKeys.has("lightweightOnClose")
                          }
                          onChange={() =>
                            void save({
                              minimizeToTrayOnClose: value !== "exit",
                              lightweightOnClose: value === "lightweight",
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </section>
            <section
              id="settings-codex"
              aria-labelledby="settings-codex-heading"
              tabIndex={-1}
            >
              <h2 id="settings-codex-heading">Codex 偏好</h2>
              <div className="settings-reference-list">
                <button
                  type="button"
                  className="settings-reference-row"
                  role="switch"
                  aria-checked={updateChecks}
                  disabled={
                    !settings || pendingKeys.has("checkCodexUpdatesOnStart")
                  }
                  onClick={() =>
                    void save({ checkCodexUpdatesOnStart: !updateChecks })
                  }
                >
                  <span>
                    <b>启动时检查 Codex 更新</b>
                    <small>仅提醒，不会静默替换当前版本</small>
                  </span>
                  <i
                    className={`settings-switch ${updateChecks ? "is-on" : ""}`}
                  >
                    <u />
                  </i>
                </button>
                <button
                  type="button"
                  className="settings-reference-row"
                  role="switch"
                  aria-checked={providerChecks}
                  disabled={
                    !settings || pendingKeys.has("checkProviderStatusOnStart")
                  }
                  onClick={() =>
                    void save({ checkProviderStatusOnStart: !providerChecks })
                  }
                >
                  <span>
                    <b>自动检查线路状态</b>
                    <small>启动后测试当前线路的地址能否连通，不使用密钥</small>
                  </span>
                  <i
                    className={`settings-switch ${providerChecks ? "is-on" : ""}`}
                  >
                    <u />
                  </i>
                </button>
                <button
                  type="button"
                  className="settings-reference-row"
                  role="switch"
                  aria-checked={showProviderBalance}
                  disabled={!settings || pendingKeys.has("showProviderBalance")}
                  onClick={() =>
                    void save({ showProviderBalance: !showProviderBalance })
                  }
                >
                  <span>
                    <b>显示线路余额</b>
                    <small>
                      在线路页显示当前线路的余额或额度（支持的服务商会自动查询）
                    </small>
                  </span>
                  <i
                    className={`settings-switch ${showProviderBalance ? "is-on" : ""}`}
                  >
                    <u />
                  </i>
                </button>
                <div className="settings-reference-row">
                  <span>
                    <b id="settings-update-source-label">Codex 更新源</b>
                    <small id="settings-update-source-note">
                      {
                        updateSources.find(
                          ([value]) => value === updateSource,
                        )?.[2]
                      }
                    </small>
                  </span>
                  <div
                    className="settings-segment"
                    role="group"
                    aria-labelledby="settings-update-source-label"
                    aria-describedby="settings-update-source-note"
                  >
                    {updateSources.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={
                          updateSource === value ? "is-active" : undefined
                        }
                        aria-pressed={updateSource === value}
                        disabled={
                          !settings || pendingKeys.has("codexUpdateSource")
                        }
                        onClick={() => void save({ codexUpdateSource: value })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>
            <section
              id="settings-updates"
              aria-labelledby="settings-updates-heading"
              tabIndex={-1}
            >
              <h2 id="settings-updates-heading">应用更新</h2>
              <div className={`settings-app-update is-${updateTone}`}>
                <div className="settings-app-update-row">
                  <span className="settings-app-update-icon" aria-hidden="true">
                    {installingAppUpdate || isChecking ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : installFailed || checkFailed ? (
                      <CircleAlert size={16} />
                    ) : hasUpdate ? (
                      <Download size={16} />
                    ) : lastCheckedAt ? (
                      <CircleCheck size={16} />
                    ) : (
                      <RefreshCw size={16} />
                    )}
                  </span>
                  <span className="settings-app-update-copy" aria-live="polite">
                    <b>{appUpdateTitle}</b>
                    <small>{appUpdateDescription}</small>
                  </span>
                  <button
                    type="button"
                    className={hasUpdate ? "primary" : "secondary"}
                    disabled={isChecking || installingAppUpdate}
                    onClick={() => {
                      if (hasUpdate) {
                        void installAppUpdate();
                      } else {
                        void checkAppUpdate();
                      }
                    }}
                  >
                    {installingAppUpdate || isChecking ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : hasUpdate ? (
                      <Download size={14} />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    {appUpdateButton}
                  </button>
                </div>
                {installingAppUpdate && (
                  <div className="settings-app-update-progress">
                    <span>{appUpdateProgressLabel}</span>
                    <i
                      role="progressbar"
                      aria-label="应用更新下载进度"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={appUpdatePercent ?? undefined}
                      aria-valuetext={
                        appUpdatePercent === null
                          ? appUpdateProgressLabel
                          : undefined
                      }
                    >
                      <u
                        className={
                          appUpdatePercent === null
                            ? "is-indeterminate"
                            : undefined
                        }
                        style={
                          appUpdatePercent === null
                            ? undefined
                            : { width: `${appUpdatePercent}%` }
                        }
                      />
                    </i>
                  </div>
                )}
                {hasUpdate && updateInfo && (
                  <div className="settings-app-update-details">
                    <b>
                      {updateInfo.currentVersion || appVersion} →{" "}
                      {updateInfo.availableVersion}
                    </b>
                    {releaseNotes && (
                      <p className="settings-app-update-notes">
                        {releaseNotes}
                      </p>
                    )}
                    <small>
                      安装时 Chimera++ 会退出并自动重启，Codex
                      保持运行；重启完成前，经本地路由的请求会暂停。
                    </small>
                  </div>
                )}
              </div>
            </section>
            {/* Part of the scroll flow, so it can never cover the last rows. */}
            <footer className="settings-page-footer">
              <p>
                将 Codex 偏好、Codex
                安装方式和「关闭主窗口时」恢复为默认值；主题、开机自启动与静默启动保持不变。
              </p>
              <button
                type="button"
                className="secondary"
                disabled={!settings || pendingKeys.size > 0}
                onClick={resetPreferences}
              >
                恢复默认设置
              </button>
            </footer>
          </div>
        </div>
      </div>
    </section>
  );
}
