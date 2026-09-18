import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { useEffect, useRef, useState } from "react";
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

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function NewSettingsView() {
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
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<Settings | null>(null);
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(
    runningInTauri ? null : true,
  );
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(false);
  const [autoLaunchError, setAutoLaunchError] = useState(false);
  const [appVersion, setAppVersion] = useState("正在读取版本");

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
    if (!runningInTauri) {
      setSettings((current) => (current ? { ...current, ...patch } : current));
      return;
    }
    const keys = Object.keys(patch);
    setPendingKeys((current) => new Set([...current, ...keys]));
    // Serialize UI responses; backend applies only these fields under its lock.
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        setSettings(await settingsApi.patchPreferences(patch));
        toast.success("设置已保存");
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
      <h1>设置</h1>
      <div className="settings-reference-list">
        <button
          className="settings-reference-row"
          role="switch"
          aria-checked={updateChecks}
          disabled={!settings || pendingKeys.has("checkCodexUpdatesOnStart")}
          onClick={() => void save({ checkCodexUpdatesOnStart: !updateChecks })}
        >
          <span>
            <b>启动时检查 Codex 更新</b>
            <small>仅提醒，不会静默替换当前版本</small>
          </span>
          <i className={`settings-switch ${updateChecks ? "is-on" : ""}`}>
            <u />
          </i>
        </button>
        <button
          className="settings-reference-row"
          role="switch"
          aria-checked={providerChecks}
          disabled={!settings || pendingKeys.has("checkProviderStatusOnStart")}
          onClick={() =>
            void save({ checkProviderStatusOnStart: !providerChecks })
          }
        >
          <span>
            <b>自动检查供应商状态</b>
            <small>启动后轻量验证当前路由</small>
          </span>
          <i className={`settings-switch ${providerChecks ? "is-on" : ""}`}>
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
        <button
          className="settings-reference-row"
          role="switch"
          aria-checked={autoLaunch === true}
          disabled={autoLaunch === null || autoLaunchBusy || autoLaunchError}
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
            <small>
              轻量模式释放界面内存；编辑或任务进行中仅隐藏窗口。双击托盘可恢复。
            </small>
          </span>
          <select
            aria-labelledby="close-behavior-label"
            value={closeBehavior}
            disabled={
              !settings ||
              pendingKeys.has("minimizeToTrayOnClose") ||
              pendingKeys.has("lightweightOnClose")
            }
            onChange={(event) =>
              save({
                minimizeToTrayOnClose: event.target.value !== "exit",
                lightweightOnClose: event.target.value === "lightweight",
              })
            }
          >
            <option value="tray">最小化到托盘</option>
            <option value="lightweight">进入轻量模式</option>
            <option value="exit">退出软件</option>
          </select>
        </div>
        <div className="settings-reference-row settings-segment-row">
          <span>
            <b>Codex 更新源</b>
            <small>安装方式请在“更新”页的“安装方式与更新源”中选择</small>
          </span>
          <div className="settings-segment">
            <button
              className={
                settings?.codexUpdateSource === "mirror" ? "" : "is-active"
              }
              aria-pressed={settings?.codexUpdateSource !== "mirror"}
              disabled={!settings || pendingKeys.has("codexUpdateSource")}
              onClick={() => void save({ codexUpdateSource: "auto" })}
            >
              自动选择
            </button>
            <button
              className={
                settings?.codexUpdateSource === "mirror" ? "is-active" : ""
              }
              aria-pressed={settings?.codexUpdateSource === "mirror"}
              disabled={!settings || pendingKeys.has("codexUpdateSource")}
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
                  {updateInfo.currentVersion} → {updateInfo.availableVersion}
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
                    appUpdatePercent === null ? "is-indeterminate" : undefined
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
      </div>
      <footer className="settings-reference-footer">
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
