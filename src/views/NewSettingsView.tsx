import "./NewSettingsView.css";
import "@/theme/v3/settings.css";
import { ImportPanel } from "@/components/settings/ImportPanel";
import { ToolRegistryPanel } from "@/components/settings/ToolRegistryPanel";
import { LogSettingsPanel } from "@/components/settings/LogSettingsPanel";
import { SettingsRow, SwitchRow } from "@/components/settings/SettingsRow";
import { settingsDesignSamples } from "./NewSettingsView.designSamples";
import { useTranslation } from "react-i18next";
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
  ArchiveRestore,
  ArrowDownToLine,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Download,
  FolderCog,
  Info,
  LoaderCircle,
  RefreshCw,
  ScrollText,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { Settings } from "@/types";
import { settingsApi, type PreferencesPatch } from "@/lib/api/settings";
import { getCurrentVersion } from "@/lib/updater";
import { licenseLinks } from "@/lib/licenses";
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

// Design L13 order. Only sections with a real backend are listed: project
// profiles and cloud sync are not exposed in this build.
const settingsSections = [
  ["settings-general", "通用", SettingsIcon],
  ["settings-import", "导入", ArrowDownToLine],
  ["settings-backups", "备份与恢复", ArchiveRestore],
  ["settings-connections", "代理与故障转移", Waypoints],
  ["settings-advanced", "高级修复与日志", ScrollText],
  ["settings-directories", "配置目录", FolderCog],
  ["settings-codex", "Codex 偏好", SlidersHorizontal],
  ["settings-updates", "更新", RefreshCw],
  ["settings-about", "关于", Info],
] as const satisfies readonly (readonly [string, string, LucideIcon])[];
type SectionId = (typeof settingsSections)[number][0];
const firstSection: SectionId = settingsSections[0][0];
// 导入 is a page of its own; the other sections share one scroll.
const isStandalone = (id: SectionId) => id === "settings-import";
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
// Browser preview with the design-review sample values (never in the app).
const designPreview =
  import.meta.env.DEV &&
  !runningInTauri &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("preview") === "design";

/** get_app_config_path points at config.json; the folder is what users want. */
const configFolder = (path: string) =>
  /\.json$/i.test(path) ? path.replace(/[\/][^\/]+$/, "") : path;
const joinPath = (dir: string, name: string) =>
  `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`;

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
  ["auto", "自动选择", "目前使用 GitHub 镜像"],
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
  // Folder that holds config.json, chimera.db, backups and logs.
  const [configDir, setConfigDir] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

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
      if (designPreview) {
        setSettings({ ...settingsDesignSamples.settings });
        setAppVersion(settingsDesignSamples.appVersion);
        setConfigDir(settingsDesignSamples.configDir);
        return;
      }
      setSettings({
        codexUpdateSource: "auto",
        codexInstallMode: "standard",
      } as Settings);
      setAppVersion("开发预览");
      return;
    }
    void settingsApi
      .getAppConfigPath()
      .then((path) => setConfigDir(configFolder(path)))
      .catch(() => setConfigDir(null));
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

  const sectionLabel = (id: SectionId) =>
    settingsSections.find(([sectionId]) => sectionId === id)?.[1] ?? "";
  const heading = (id: SectionId) => (
    <h2 id={`${id}-heading`}>{sectionLabel(id)}</h2>
  );
  const openDirectoriesPanel = () => {
    setDirectoriesOpen(true);
    openSection("settings-directories");
  };
  const openLogsPanel = () => {
    setLogsOpen(true);
    openSection("settings-advanced");
  };
  const native = runningInTauri;
  const dbPath = configDir ? joinPath(configDir, "chimera.db") : null;
  const backupDir = configDir ? joinPath(configDir, "backups") : null;
  const logDir = configDir ? joinPath(configDir, "logs") : null;
  const pathText = (path: string | null) =>
    path ?? (native ? "正在读取路径…" : "浏览器预览不读取本机路径");

  return (
    <section className="new-settings-view v3-settings-page">
      <header className="settings-page-header">
        <div className="settings-page-titles">
          <h1>{t("settings.title", { defaultValue: "设置" })}</h1>
          <p>
            Chimera++ {appVersion} ·{" "}
            {runningInTauri || designPreview
              ? "这些设置只影响本应用，不改 Codex 配置"
              : "浏览器预览，不读取本机数据"}
          </p>
        </div>
        {!isStandalone(activeSection) && (
          <button
            type="button"
            className="secondary"
            aria-label="恢复默认设置"
            title="恢复 Codex 偏好、安装方式和关闭行为的默认值"
            disabled={!settings || pendingKeys.size > 0}
            onClick={resetPreferences}
          >
            恢复默认
          </button>
        )}
      </header>
      <div className="settings-page-layout">
        <aside className="settings-page-aside">
          <nav className="settings-page-nav" aria-label="设置目录">
            {settingsSections.map(([id, label, Icon]) => (
              <a
                key={id}
                href={`#${id}`}
                aria-current={activeSection === id ? "location" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  openSection(id);
                }}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{label}</span>
              </a>
            ))}
          </nav>
          <div className="settings-page-version">
            <span>Chimera++ {appVersion}</span>
            <button
              type="button"
              className="settings-text-button"
              disabled={isChecking || installingAppUpdate}
              onClick={() => {
                openSection("settings-updates");
                if (!hasUpdate) void checkAppUpdate();
              }}
            >
              {hasUpdate ? "查看更新" : "检查应用更新"}
            </button>
          </div>
        </aside>
        <div
          className="settings-page-content"
          ref={scrollRef}
          tabIndex={0}
          aria-label="设置内容"
          onScroll={followScroll}
        >
          <div
            id="settings-import"
            tabIndex={-1}
            hidden={activeSection !== "settings-import"}
            className="settings-card settings-standalone"
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
            {/* 通用 is two cards (preferences, then data and folders); the
                wrapper is the scroll target so the directory highlight
                covers both. */}
            <div id="settings-general" className="settings-group" tabIndex={-1}>
              <section
                className="settings-card"
                aria-labelledby="settings-general-heading"
              >
                {heading("settings-general")}
                <div className="settings-reference-list">
                  <SwitchRow
                    title="开机自启动"
                    description="登录系统后自动启动 Chimera++"
                    checked={launchOnStartup}
                    disabled={!settings || autoLaunchBusy}
                    onToggle={() => void toggleLaunchOnStartup()}
                  />
                  {/* The backend only starts hidden when the tray flag is on too
                    (`AppSettings::starts_hidden`), because the tray icon is
                    what brings the window back. Turning the switch on sets
                    both, so the switch always shows what the next launch
                    will do. */}
                  <SwitchRow
                    title="静默启动"
                    description="启动时不打开主窗口，只留托盘图标"
                    checked={silentStartup}
                    disabled={
                      !settings ||
                      pendingKeys.has("silentStartup") ||
                      pendingKeys.has("showInTray")
                    }
                    onToggle={() =>
                      void save(
                        silentStartup
                          ? { silentStartup: false }
                          : { silentStartup: true, showInTray: true },
                      )
                    }
                  />
                  <SettingsRow
                    title="关闭主窗口时"
                    titleId="close-behavior-label"
                    descriptionId="close-behavior-note"
                    description={
                      closeBehaviors.find(
                        ([value]) => value === closeBehavior,
                      )?.[2]
                    }
                  >
                    <div
                      className="settings-segment settings-close-options"
                      role="radiogroup"
                      aria-labelledby="close-behavior-label"
                      aria-describedby="close-behavior-note"
                    >
                      {closeBehaviors.map(([value, label]) => (
                        <label
                          key={value}
                          className={
                            closeBehavior === value ? "is-active" : undefined
                          }
                        >
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
                  </SettingsRow>
                  <SwitchRow
                    title="显示线路余额"
                    description="仅部分服务商支持；开启后在当前线路卡上显示余额"
                    checked={showProviderBalance}
                    disabled={
                      !settings || pendingKeys.has("showProviderBalance")
                    }
                    onToggle={() =>
                      void save({ showProviderBalance: !showProviderBalance })
                    }
                  />
                </div>
              </section>
              <section
                className="settings-card"
                aria-labelledby="settings-data-heading"
              >
                <h2 id="settings-data-heading">数据与目录</h2>
                <p className="settings-card-lead">
                  线路、备份和运行日志都保存在本机这个目录里
                </p>
                <div className="settings-reference-list">
                  <SettingsRow
                    title="数据目录"
                    description={<code>{pathText(configDir)}</code>}
                  >
                    <button
                      type="button"
                      className="secondary"
                      aria-label="打开数据目录"
                      disabled={!native}
                      onClick={() => void openDataFolder()}
                    >
                      打开
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label="更改数据目录"
                      disabled={!native || directoryBusy}
                      onClick={openDirectoriesPanel}
                    >
                      更改
                    </button>
                  </SettingsRow>
                  <SettingsRow
                    title="日志目录"
                    description={<code>{pathText(logDir)}</code>}
                  >
                    <button
                      type="button"
                      className="secondary"
                      aria-label="定位日志文件"
                      disabled={!native}
                      onClick={() => void revealLogFile()}
                    >
                      定位
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label="日志设置"
                      onClick={openLogsPanel}
                    >
                      设置
                    </button>
                  </SettingsRow>
                  <SettingsRow
                    title="备份目录"
                    description={<code>{pathText(backupDir)}</code>}
                  >
                    <button
                      type="button"
                      className="secondary"
                      aria-label="管理备份"
                      onClick={() => openSection("settings-backups")}
                    >
                      管理
                    </button>
                  </SettingsRow>
                  <SettingsRow
                    title="数据库"
                    description={<code>{pathText(dbPath)}</code>}
                  >
                    <button
                      type="button"
                      className="secondary"
                      aria-label="备份应用数据库"
                      disabled={!native || recoveryBusy}
                      onClick={() => {
                        setDbOpen(true);
                        openSection("settings-backups");
                      }}
                    >
                      备份
                    </button>
                  </SettingsRow>
                </div>
              </section>
            </div>
            <section
              id="settings-backups"
              className="settings-card"
              aria-labelledby="settings-backups-heading"
              tabIndex={-1}
            >
              {heading("settings-backups")}
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
              className="settings-card"
              aria-labelledby="settings-connections-heading"
              tabIndex={-1}
            >
              {heading("settings-connections")}
              <p className="settings-card-lead">
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
              id="settings-advanced"
              className="settings-card"
              aria-labelledby="settings-advanced-heading"
              tabIndex={-1}
            >
              {heading("settings-advanced")}
              <p className="settings-card-lead">
                排查问题时使用；日志只保存在本机，不会自动上传
              </p>
              <div className="settings-reference-list">
                <DisclosureRow
                  id="settings-logs"
                  title="运行日志"
                  description="日志开关与级别，修改后立即生效"
                  expanded={logsOpen}
                  onToggle={() => setLogsOpen((open) => !open)}
                />
                {logsOpen && (
                  <div id="settings-logs-panel" className="settings-subpanel">
                    <LogSettingsPanel native={runningInTauri} />
                  </div>
                )}
                <SettingsRow
                  title="定位日志文件"
                  description="在文件管理器中选中运行日志，反馈问题时可以附上"
                >
                  <button
                    type="button"
                    className="secondary"
                    disabled={!native}
                    onClick={() => void revealLogFile()}
                  >
                    定位
                  </button>
                </SettingsRow>
              </div>
            </section>
            <section
              id="settings-directories"
              className="settings-card"
              aria-labelledby="settings-directories-heading"
              tabIndex={-1}
            >
              {heading("settings-directories")}
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
              </div>
            </section>
            <section
              id="settings-codex"
              className="settings-card"
              aria-labelledby="settings-codex-heading"
              tabIndex={-1}
            >
              {heading("settings-codex")}
              <div className="settings-reference-list">
                <SwitchRow
                  title="启动时检查 Codex 更新"
                  description="只提醒，不自动安装"
                  checked={updateChecks}
                  disabled={
                    !settings || pendingKeys.has("checkCodexUpdatesOnStart")
                  }
                  onToggle={() =>
                    void save({ checkCodexUpdatesOnStart: !updateChecks })
                  }
                />
                <SwitchRow
                  title="自动检查线路状态"
                  description="启动时测试当前线路地址"
                  checked={providerChecks}
                  disabled={
                    !settings || pendingKeys.has("checkProviderStatusOnStart")
                  }
                  onToggle={() =>
                    void save({ checkProviderStatusOnStart: !providerChecks })
                  }
                />
                <SettingsRow
                  title="Codex 更新源"
                  titleId="settings-update-source-label"
                  descriptionId="settings-update-source-note"
                  description={
                    updateSources.find(([value]) => value === updateSource)?.[2]
                  }
                >
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
                </SettingsRow>
              </div>
            </section>
            <section
              id="settings-updates"
              className="settings-card"
              aria-labelledby="settings-updates-heading"
              tabIndex={-1}
            >
              {heading("settings-updates")}
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
            <section
              id="settings-about"
              className="settings-card"
              aria-labelledby="settings-about-heading"
              tabIndex={-1}
            >
              {heading("settings-about")}
              <div className="settings-reference-list">
                <DisclosureRow
                  id="settings-tools"
                  title="支持的工具"
                  description="各工具的切换方式、配置文件位置与安装检测"
                  expanded={toolsOpen}
                  onToggle={() => setToolsOpen((open) => !open)}
                />
                {toolsOpen && (
                  <div id="settings-tools-panel" className="settings-subpanel">
                    <ToolRegistryPanel
                      settings={settings}
                      native={runningInTauri}
                    />
                  </div>
                )}
                <SettingsRow
                  title="许可证与源代码"
                  description="Chimera++ 按 MIT 与 AGPL-3.0 许可发行"
                  className="settings-licenses-row"
                >
                  <span
                    className="settings-licenses"
                    role="group"
                    aria-label="许可证与源代码"
                  >
                    {licenseLinks(appVersion).map((link) => (
                      <button
                        key={link.label}
                        type="button"
                        className="settings-licenses-link"
                        onClick={() => void settingsApi.openExternal(link.url)}
                      >
                        {link.label}
                      </button>
                    ))}
                  </span>
                </SettingsRow>
              </div>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}
