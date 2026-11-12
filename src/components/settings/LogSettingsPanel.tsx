import { useEffect, useState } from "react";
import { settingsApi, type LogConfig } from "@/lib/api/settings";
import { SettingsRow, SwitchRow } from "./SettingsRow";

const levels = [
  ["error", "错误"],
  ["warn", "警告"],
  ["info", "信息"],
  ["debug", "调试"],
  ["trace", "跟踪"],
] as const;

const fallback: LogConfig = { enabled: true, level: "info" };

/**
 * Runtime log switch and level (`get_log_config` / `set_log_config`). The
 * backend applies a new level immediately; nothing here touches tool configs.
 */
export function LogSettingsPanel({ native }: { native: boolean }) {
  const [config, setConfig] = useState<LogConfig | null>(
    native ? null : fallback,
  );
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = async () => {
    setFailed(false);
    try {
      setConfig(await settingsApi.getLogConfig());
    } catch {
      setFailed(true);
    }
  };
  useEffect(() => {
    if (native) void load();
  }, [native]);

  const save = async (next: LogConfig) => {
    if (!native || busy || !config) return;
    const previous = config;
    setBusy(true);
    setNotice("");
    setConfig(next);
    try {
      await settingsApi.setLogConfig(next);
      setNotice("日志设置已应用");
    } catch {
      setConfig(previous);
      setNotice("日志设置没有保存，请重试");
    } finally {
      setBusy(false);
    }
  };

  const disabled = !native || busy || !config;
  const verbose = config?.level === "debug" || config?.level === "trace";
  return (
    <div className="settings-reference-list">
      {failed && (
        <SettingsRow
          title="无法读取日志设置"
          description="其他设置不受影响，可以稍后再试。"
        >
          <button
            type="button"
            className="secondary"
            onClick={() => void load()}
          >
            重试
          </button>
        </SettingsRow>
      )}
      <SwitchRow
        title="写入运行日志"
        description="关闭后不再记录新的日志，反馈问题时将没有记录可附"
        checked={config?.enabled ?? true}
        disabled={disabled}
        onToggle={() =>
          config && void save({ ...config, enabled: !config.enabled })
        }
      />
      <SettingsRow
        title="日志级别"
        titleId="settings-log-level-label"
        description={
          verbose
            ? "调试与跟踪会记录大量请求细节，排查完请调回「信息」"
            : "默认「信息」；排查问题时可临时调高"
        }
      >
        <div
          className="settings-segment"
          role="group"
          aria-labelledby="settings-log-level-label"
        >
          {levels.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={config?.level === value ? "is-active" : undefined}
              aria-pressed={config?.level === value}
              disabled={disabled || !config?.enabled}
              onClick={() => config && void save({ ...config, level: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </SettingsRow>
      {notice && (
        <p className="settings-card-foot" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
