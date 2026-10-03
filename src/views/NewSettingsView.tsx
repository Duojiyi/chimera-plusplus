import "./NewSettingsView.css";
import { ImportPanel } from "@/components/settings/ImportPanel";
import { ToolRegistryPanel } from "@/components/settings/ToolRegistryPanel";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/components/theme-provider";
import { LiveBackupsPanel } from "@/components/LiveBackupsPanel";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
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
];
const sectionFromLocation = () => {
  const id = window.location.hash.slice(1);
  return settingsSections.some(([section]) => section === id)
    ? id
    : "settings-backups";
};

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
  const [sectionTarget, setSectionTarget] = useState(sectionFromLocation);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<Settings | null>(null);
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(
    runningInTauri ? null : true,
  );
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(false);
  const [autoLaunchError, setAutoLaunchError] = useState(false);
  const [activeSection, setActiveSection] = useState(sectionFromLocation);
  const [appVersion, setAppVersion] = useState("正在读取版本");

  useEffect(() => {
    const syncSection = () => {
      const section = sectionFromLocation();
      setActiveSection(section);
      setSectionTarget(section);
    };
    window.addEventListener("hashchange", syncSection);
    window.addEventListener("popstate", syncSection);
    return () => {
      window.removeEventListener("hashchange", syncSection);
      window.removeEventListener("popstate", syncSection);
    };
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    const section = document.getElementById(sectionTarget);
    if (container && section) {
      container.scrollTop +=
        section.getBoundingClientRect().top -
        container.getBoundingClientRect().top;
    }
  }, [sectionTarget]);

  useEffect(() => {
    if (!runningInTauri) {
      setSettings({
        codexUpdateSource: "auto",
        codexInstallMode: "standard",
      } as Settings);
      setAppVersion("开发预览");
      return;
    }
    void getCurrentVersion().then((version) =>
      setAppVersion(version || "未知版本"),
    );
    void settingsApi
      .get()
      .then(setSettings)
      .catch((reason) =>
        toast.error("无法读取设置", { description: String(reason) }),
      );
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
  const readAutoLaunch = async () => {
    setAutoLaunchBusy(true);
    try {
      setAutoLaunch(await settingsApi.getAutoLaunchStatus());
      setAutoLaunchError(false);
    } catch (reason) {
      setAutoLaunchError(true);
      toast.error("无法读取开机自启动状态", { description: String(reason) });
    } finally {
      setAutoLaunchBusy(false);
    }
  };
  useEffect(() => {
    if (runningInTauri) void readAutoLaunch();
  }, []);
  const toggleAutoLaunch = async () => {
    if (autoLaunch === null || autoLaunchBusy) return;
    if (!runningInTauri) {
      setAutoLaunch(!autoLaunch);
      return;
    }
    setAutoLaunchBusy(true);
    try {
      await settingsApi.setAutoLaunch(!autoLaunch);
      setAutoLaunch(!autoLaunch);
      toast.success("开机自启动设置已保存");
    } catch (reason) {
      toast.error("设置开机自启动失败", { description: String(reason) });
      // Reconcile the actual OS state even if persistence/rollback failed.
      await readAutoLaunch();
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
                if (window.location.hash !== `#${id}`) {
                  window.history.pushState(null, "", `#${id}`);
                }
                setActiveSection(id);
                setSectionTarget(id);
                if (id === sectionTarget && scrollRef.current) {
                  const section = document.getElementById(id);
                  if (section)
                    scrollRef.current.scrollTop +=
                      section.getBoundingClientRect().top -
                      scrollRef.current.getBoundingClientRect().top;
                }
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
          onScroll={() => {
            if (
              activeSection === "settings-tools" ||
              activeSection === "settings-import"
            )
              return;
            const container = scrollRef.current;
            if (!container) return;
            if (
              container.scrollHeight > container.clientHeight &&
              container.scrollTop + container.clientHeight >=
                container.scrollHeight - 2
            ) {
              setActiveSection("settings-updates");
              return;
            }
            const top = container.getBoundingClientRect().top;
            const current = settingsSections
              .slice(2)
              .filter(([id]) => {
                const section = document.getElementById(id);
                return (
                  section && section.getBoundingClientRect().top <= top + 48
                );
              })
              .at(-1);
            if (current) setActiveSection(current[0]);
          }}
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
            hidden={
              activeSection === "settings-tools" ||
              activeSection === "settings-import"
            }
            className="settings-standard-sections"
          >
            <section
              id="settings-backups"
              aria-label="备份与恢复"
              tabIndex={-1}
            >
              <button
                className="secondary"
                disabled={!runningInTauri || recoveryBusy}
                onClick={() => setDbOpen((open) => !open)}
                aria-expanded={dbOpen}
              >
                应用数据库备份与恢复
              </button>
              {dbOpen && runningInTauri && (
                <Suspense fallback={<p role="status">正在加载数据库备份…</p>}>
                  <DatabaseRecoveryPanel
                    onRestored={onImported}
                    onBusyChange={setRecoveryBusy}
                  />
                </Suspense>
              )}
              {liveBackupsEnabled ? (
                <LiveBackupsPanel onRestored={onImported} />
              ) : (
                <div className="settings-backups-unavailable">
                  <div className="settings-backups-header">
                    <h2>备份与恢复</h2>
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
            </section>
            <section
              id="settings-connections"
              aria-label="代理与故障转移"
              tabIndex={-1}
            >
              <h2>代理与故障转移</h2>
              <p>
                默认不启用代理或后台任务。打开面板只读取状态，保存、测试和启用均需手动操作。
              </p>
              <button
                className="secondary"
                disabled={!runningInTauri}
                aria-expanded={connectionPanel === "proxy"}
                onClick={() =>
                  setConnectionPanel((panel) =>
                    panel === "proxy" ? null : "proxy",
                  )
                }
              >
                全局 HTTP/SOCKS 出站代理
              </button>{" "}
              <button
                className="secondary"
                disabled={!runningInTauri}
                aria-expanded={connectionPanel === "failover"}
                onClick={() =>
                  setConnectionPanel((panel) =>
                    panel === "failover" ? null : "failover",
                  )
                }
              >
                自动故障转移管理
              </button>
              {runningInTauri && (
                <Suspense fallback={<p role="status">正在加载代理设置…</p>}>
                  {connectionPanel === "proxy" && <OutboundProxyPanel />}
                  {connectionPanel === "failover" && <FailoverSettingsPanel />}
                </Suspense>
              )}
            </section>
            <section
              id="settings-directories"
              aria-label="配置目录设置"
              tabIndex={-1}
            >
              <h2>配置目录</h2>
              <button
                className="secondary"
                disabled={!runningInTauri || directoryBusy}
                aria-expanded={directoriesOpen}
                onClick={() => setDirectoriesOpen((open) => !open)}
              >
                管理配置目录与 WSL 路径
              </button>
              {directoriesOpen && runningInTauri && (
                <Suspense fallback={<p role="status">正在加载目录设置…</p>}>
                  <ConfigDirectoriesPanel onBusyChange={setDirectoryBusy} />
                </Suspense>
              )}
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
                  aria-checked={autoLaunch === true}
                  disabled={
                    autoLaunch === null || autoLaunchBusy || autoLaunchError
                  }
                  onClick={() => void toggleAutoLaunch()}
                >
                  <span>
                    <b>开机自启动</b>
                    <small>
                      {autoLaunchError
                        ? "状态读取失败，请重试"
                        : autoLaunch === null
                          ? "正在读取系统启动项"
                          : "登录系统后自动启动 Chimera++，新配置默认开启"}
                    </small>
                  </span>
                  <i className={`settings-switch ${autoLaunch ? "is-on" : ""}`}>
                    <u />
                  </i>
                </button>
                {autoLaunchError && (
                  <button
                    disabled={autoLaunchBusy}
                    onClick={() => void readAutoLaunch()}
                  >
                    重试读取自启动状态
                  </button>
                )}
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
          </div>
        </div>
      </div>
      <footer
        className="settings-reference-footer"
        hidden={
          activeSection === "settings-tools" ||
          activeSection === "settings-import"
        }
      >
        <code>Chimera++ {appVersion}</code>
        <button
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
    </section>
  );
}
