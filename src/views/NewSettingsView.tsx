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
  FolderOpen,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import type { Settings } from "@/types";
import { settingsApi, type PreferencesPatch } from "@/lib/api/settings";
import { getCurrentVersion } from "@/lib/updater";
import { useUpdate } from "@/contexts/UpdateContext";

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
// A section becomes current once its heading is within this distance of the
// top edge of the scroll area.
const SCROLL_SPY_OFFSET = 48;
const isSectionHash = (hash: string) =>
  settingsSections.some(([id]) => `#${id}` === hash);
const sectionFromLocation = (): SectionId =>
  settingsSections.find(([id]) => `#${id}` === window.location.hash)?.[0] ??
  firstSection;

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
  const [settingsError, setSettingsError] = useState(false);
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
    let current = scrolledSections[0];
    for (const id of scrolledSections) {
      const section = document.getElementById(id);
      if (
        section &&
        section.getBoundingClientRect().top - top <= SCROLL_SPY_OFFSET
      )
        current = id;
    }
    setActiveSection(current);
  };

  const loadSettings = async () => {
    setSettingsError(false);
    try {
      setSettings(await settingsApi.get());
    } catch {
      setSettingsError(true);
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
  const save = (patch: PreferencesPatch) => {
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
        toast.success(runningInTauri ? "设置已保存" : "预览设置已更新");
      } catch (reason) {
        toast.error("设置保存失败", { description: String(reason) });
      } finally {
        setPendingKeys((current) => {
          const next = new Set(current);
          keys.forEach((key) => next.delete(key));
          return next;
        });
      }
    });
  };
  // Mirrors the backend default for a preference that was never saved.
  const launchOnStartup = settings?.launchOnStartup ?? true;
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
      toast.error("设置开机自启动失败", { description: String(reason) });
    } finally {
      setAutoLaunchBusy(false);
    }
  };
  const updateChecks = settings?.checkCodexUpdatesOnStart ?? true;
  const providerChecks = settings?.checkProviderStatusOnStart ?? true;
  const showProviderBalance = settings?.showProviderBalance ?? false;
  const closeBehavior = !(settings?.minimizeToTrayOnClose ?? true)
    ? "exit"
    : settings?.lightweightOnClose
      ? "lightweight"
      : "tray";
  useLightweightCloseBlocker(
    pendingKeys.size > 0 || autoLaunchBusy || installingAppUpdate || isStaging,
  );
  const openDataFolder = async () => {
    if (!runningInTauri) return;
    try {
      await settingsApi.openAppConfigFolder();
    } catch (reason) {
      toast.error("无法打开数据目录", { description: String(reason) });
    }
  };
  const checkAppUpdate = async () => {
    try {
      await checkUpdate();
    } catch (reason) {
      toast.error("检查应用更新失败", { description: String(reason) });
    }
  };
  const installAppUpdate = async () => {
    try {
      const installed = await installUpdate();
      if (!installed) {
        toast.info("该更新已不可用", { description: "已重新检查更新" });
      }
    } catch (reason) {
      toast.error("应用更新失败", { description: String(reason) });
    }
  };
  const lastCheckedLabel = lastCheckedAt
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(lastCheckedAt)
    : null;
  const appUpdatePercent =
    appUpdateProgress?.total && appUpdateProgress.total > 0
      ? Math.min(
          100,
          Math.round(
            (appUpdateProgress.downloaded / appUpdateProgress.total) * 100,
          ),
        )
      : null;
  const appUpdateTitle = installingAppUpdate
    ? "正在更新 Chimera++"
    : isChecking
      ? "正在检查更新"
      : hasUpdate && updateInfo
        ? updateErrorOperation === "install"
          ? "更新未完成，可以重试"
          : `发现 Chimera++ ${updateInfo.availableVersion}`
        : updateError
          ? "检查更新失败"
          : lastCheckedAt
            ? "已是最新版本"
            : `Chimera++ ${appVersion}`;
  const appUpdateDescription = installingAppUpdate
    ? appUpdatePercent === null
      ? "正在准备更新，完成后应用将自动重启"
      : appUpdatePercent >= 100
        ? "正在安装更新，完成后应用将自动重启"
        : `正在下载更新 ${appUpdatePercent}%`
    : isChecking
      ? "正在连接稳定版更新源"
      : hasUpdate
        ? updateErrorOperation === "install"
          ? `${updateError ?? "安装失败"}。旧版本未被替换，可再次尝试。`
          : updateErrorOperation === "stage"
            ? "后台预下载未完成，点击后会重新下载、验证并安装"
            : stagedVersion === updateInfo?.availableVersion
              ? "更新包已下载并通过验证，安装后应用将自动重启"
              : isStaging
                ? "正在后台下载更新包，点击后将下载完成并安装"
                : "发现新版本，下载并验证后安装"
        : updateError
          ? updateError
          : lastCheckedLabel
            ? `Chimera++ ${appVersion} · 上次检查 ${lastCheckedLabel}`
            : "自动检测已开启，也可以随时手动检查";
  return (
    <section className="new-settings-view">
      <header className="settings-page-header">
        <h1>{t("settings.title", { defaultValue: "设置" })}</h1>
        <p>Chimera++ {appVersion} · 配置只保存在本机</p>
      </header>
      <div className="settings-page-summary" aria-label="设置摘要">
        <span>
          运行环境 <b>{runningInTauri ? "桌面应用" : "浏览器预览"}</b>
        </span>
        <span>
          备份服务{" "}
          <b>
            {!runningInTauri
              ? "未连接本机"
              : liveBackupsEnabled
                ? "已开放"
                : "尚未开放"}
          </b>
        </span>
        <span>
          存储方式 <b>仅本机</b>
        </span>
      </div>
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
            {settingsError && (
              <div className="settings-load-error" role="alert">
                <CircleAlert size={16} aria-hidden="true" />
                <span>无法读取设置，以下偏好暂时不能修改。</span>
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
                默认不启用代理或后台任务。展开后只读取状态，保存、测试和启用都需要手动操作。
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
                  description="本地代理请求失败时按队列切换线路"
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
                  <span aria-labelledby="settings-language-label">
                    简体中文
                  </span>
                </div>
                <div className="settings-reference-row settings-theme-row">
                  <span>
                    <b id="settings-theme-label">
                      {t("settings.theme", { defaultValue: "应用主题" })}
                    </b>
                    <small>只改变 Chimera++ 自身；Codex 皮肤在「外观」里</small>
                  </span>
                  <div
                    className="settings-segment settings-theme-segment"
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
                <div className="settings-reference-row">
                  <span>
                    <b id="close-behavior-label">关闭主窗口时</b>
                  </span>
                  <div
                    className="settings-close-options"
                    role="radiogroup"
                    aria-labelledby="close-behavior-label"
                  >
                    {(
                      [
                        ["tray", "最小化到托盘"],
                        ["exit", "退出软件"],
                        ["lightweight", "轻量模式"],
                      ] as const
                    ).map(([value, label]) => (
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
                    <b>自动检查供应商状态</b>
                    <small>启动后轻量验证当前路由</small>
                  </span>
                  <i
                    className={`settings-switch ${providerChecks ? "is-on" : ""}`}
                  >
                    <u />
                  </i>
                </button>
                <button
                  className="settings-reference-row"
                  role="switch"
                  aria-checked={showProviderBalance}
                  disabled={!settings || pendingKeys.has("showProviderBalance")}
                  onClick={() =>
                    void save({ showProviderBalance: !showProviderBalance })
                  }
                >
                  <span>
                    <b>显示供应商余额</b>
                    <small>
                      在供应商卡片显示余额或额度（需供应商配置用量查询脚本）
                    </small>
                  </span>
                  <i
                    className={`settings-switch ${showProviderBalance ? "is-on" : ""}`}
                  >
                    <u />
                  </i>
                </button>
                <div className="settings-reference-row settings-segment-row">
                  <span>
                    <b>Codex 更新源</b>
                    <small>
                      安装方式请在“Codex 管理”页的“安装方式与更新源”中选择
                    </small>
                  </span>
                  <div className="settings-segment">
                    <button
                      className={
                        settings?.codexUpdateSource === "mirror"
                          ? ""
                          : "is-active"
                      }
                      aria-pressed={settings?.codexUpdateSource !== "mirror"}
                      disabled={
                        !settings || pendingKeys.has("codexUpdateSource")
                      }
                      onClick={() => void save({ codexUpdateSource: "auto" })}
                    >
                      自动选择
                    </button>
                    <button
                      className={
                        settings?.codexUpdateSource === "mirror"
                          ? "is-active"
                          : ""
                      }
                      aria-pressed={settings?.codexUpdateSource === "mirror"}
                      disabled={
                        !settings || pendingKeys.has("codexUpdateSource")
                      }
                      onClick={() => void save({ codexUpdateSource: "mirror" })}
                    >
                      镜像安装
                    </button>
                  </div>
                </div>
                <button
                  className="settings-reference-row settings-link-row"
                  onClick={() => void openDataFolder()}
                >
                  <span>
                    <b>数据与日志</b>
                    <small>配置保存在本机</small>
                  </span>
                  <FolderOpen size={16} aria-hidden="true" />
                </button>
              </div>
            </section>
            <section
              id="settings-updates"
              aria-labelledby="settings-updates-heading"
              tabIndex={-1}
            >
              <h2 id="settings-updates-heading">应用更新</h2>
              <div
                className={`settings-app-update${hasUpdate ? " is-available" : ""}${updateError ? " is-error" : ""}`}
                aria-live="polite"
              >
                <div className="settings-app-update-row">
                  <span className="settings-app-update-icon" aria-hidden="true">
                    {installingAppUpdate || isChecking ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : hasUpdate ? (
                      <Download size={15} />
                    ) : lastCheckedAt && !updateError ? (
                      <CircleCheck size={15} />
                    ) : updateError ? (
                      <CircleAlert size={15} />
                    ) : (
                      <RefreshCw size={15} />
                    )}
                  </span>
                  <span className="settings-app-update-copy">
                    <b>{appUpdateTitle}</b>
                    <small>{appUpdateDescription}</small>
                  </span>
                  <button
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
                    {installingAppUpdate
                      ? "正在更新…"
                      : isChecking
                        ? "正在检查…"
                        : hasUpdate
                          ? stagedVersion === updateInfo?.availableVersion
                            ? "安装并重启"
                            : "下载并安装"
                          : lastCheckedAt
                            ? "重新检查"
                            : "检查更新"}
                  </button>
                </div>
                {hasUpdate && updateInfo && (
                  <div className="settings-app-update-details">
                    <span>
                      <b>
                        {updateInfo.currentVersion} →{" "}
                        {updateInfo.availableVersion}
                      </b>
                      <small>
                        {updateInfo.notes?.trim() ||
                          "安装期间 Chimera++ 将重新启动，正在运行的 Codex 任务不会被关闭。"}
                      </small>
                    </span>
                  </div>
                )}
                {installingAppUpdate && (
                  <div className="settings-app-update-progress">
                    <span>
                      {appUpdatePercent === null
                        ? "正在准备下载"
                        : appUpdatePercent >= 100
                          ? "正在安装"
                          : `${appUpdatePercent}%`}
                    </span>
                    <i
                      role="progressbar"
                      aria-label="应用更新下载进度"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={appUpdatePercent ?? undefined}
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
              </div>
            </section>
            {/* Part of the scroll flow, so it can never cover the last rows. */}
            <footer className="settings-page-footer">
              <p>
                将 Codex 偏好、Codex
                安装方式和「关闭主窗口时」恢复为默认值；主题与开机自启动保持不变。
              </p>
              <button
                type="button"
                className="secondary"
                disabled={!settings || pendingKeys.size > 0}
                onClick={() =>
                  void save({
                    codexUpdateSource: "auto",
                    codexInstallMode: "standard",
                    checkCodexUpdatesOnStart: true,
                    checkProviderStatusOnStart: true,
                    showProviderBalance: false,
                    minimizeToTrayOnClose: true,
                    lightweightOnClose: false,
                  })
                }
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
