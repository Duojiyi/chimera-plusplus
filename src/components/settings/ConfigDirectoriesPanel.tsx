import { useEffect, useRef, useState } from "react";
import { settingsApi } from "@/lib/api/settings";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";

const directories = [
  ["claude", "Claude Code", "claudeConfigDir"],
  ["codex", "Codex", "codexConfigDir"],
  ["gemini", "Gemini", "geminiConfigDir"],
  ["grokbuild", "Grok Build", "grokConfigDir"],
  ["opencode", "OpenCode", "opencodeConfigDir"],
] as const;
type DirectoryField = (typeof directories)[number][2];

export function ConfigDirectoriesPanel({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
}) {
  const [values, setValues] = useState<
    Partial<Record<DirectoryField | "app", string>>
  >({});
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  useLightweightCloseBlocker(busy);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const load = async () => {
    setLoaded(false);
    try {
      const [settings, override, appPath, ...paths] = await Promise.all([
        settingsApi.get(),
        settingsApi.getAppConfigDirOverride(),
        settingsApi.getAppConfigPath(),
        ...directories.map(([app]) => settingsApi.getConfigDir(app)),
      ]);
      setValues({
        app: override ?? "",
        ...Object.fromEntries(
          directories.map(([, , field]) => [field, settings[field] ?? ""]),
        ),
      });
      setResolved({
        app: appPath,
        ...Object.fromEntries(
          directories.map(([, , field], index) => [field, paths[index]]),
        ),
      });
      setLoaded(true);
    } catch {
      setMessage("读取目录失败，请重试。未允许保存。");
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const save = async (field: DirectoryField | "app") => {
    if (lock.current || !loaded) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const path = values[field]?.trim() ?? "";
      if (path && !/^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(path))
        throw new Error(
          "请填写绝对路径（支持 WSL UNC 路径），或留空恢复默认。",
        );
      if (field === "app") {
        if (!(await settingsApi.setAppConfigDirOverride(path || null)))
          throw new Error("应用目录保存失败。");
      } else {
        const app = directories.find(([, , key]) => key === field)![0];
        if (!(await settingsApi.patchConfigDirectory(app, path || null)))
          throw new Error("工具目录保存失败。");
      }
      setMessage(
        field === "app"
          ? "应用目录覆盖已保存，重启应用后生效。不会自动迁移旧目录内容。"
          : "工具目录已保存；不会自动迁移文件或启动工具。",
      );
      const pathNow =
        field === "app"
          ? await settingsApi.getAppConfigPath()
          : await settingsApi.getConfigDir(
              directories.find(([, , key]) => key === field)![0],
            );
      setResolved((current) => ({ ...current, [field]: pathNow }));
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "保存目录失败，请重新读取后确认。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <section aria-label="配置目录" className="space-y-3">
      <p>
        留空并保存可恢复默认目录。Windows 下可填写
        \\wsl.localhost\发行版\home\用户\目录；不会安装
        WSL、迁移文件或自动重启。修改目录后请重新打开依赖旧路径的页面。
      </p>
      {message && <p role="status">{message}</p>}
      {!loaded && (
        <button disabled={busy} onClick={() => void load()}>
          重新读取目录
        </button>
      )}
      <fieldset disabled={!loaded || busy} className="space-y-3">
        {(
          [
            ["app", "应用数据目录"],
            ...directories.map(([, label, field]) => [field, label] as const),
          ] as const
        ).map(([field, label]) => (
          <div key={field}>
            <label>
              {label}
              <input
                aria-label={`${label}目录`}
                value={values[field] ?? ""}
                placeholder="留空使用默认目录"
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }))
                }
              />
            </label>
            <button
              onClick={() =>
                void (async () => {
                  try {
                    const selected = await settingsApi.pickDirectory(
                      values[field] || resolved[field],
                    );
                    if (selected)
                      setValues((current) => ({
                        ...current,
                        [field]: selected,
                      }));
                  } catch {
                    setMessage("选择目录失败。");
                  }
                })()
              }
            >
              浏览 {label}
            </button>{" "}
            <button onClick={() => void save(field)}>保存 {label}</button>
            <p>
              当前生效路径：<code>{resolved[field] || "未读取"}</code>
            </p>
          </div>
        ))}
      </fieldset>
    </section>
  );
}
