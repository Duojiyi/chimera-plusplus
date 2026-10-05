import { lazy, Suspense, useEffect, useState } from "react";
import { toolRegistryApi, type ToolInfo } from "@/lib/api/toolRegistry";
import registry from "@/shared/tool-registry.json";
import type { Settings } from "@/types";
import { toolBadgeMarks, toolDisplayNames } from "./toolBadges";

const AboutSection = lazy(() =>
  import("./AboutSection").then((module) => ({ default: module.AboutSection })),
);

export function ToolRegistryPanel({
  settings,
  native,
}: {
  settings: Settings | null;
  native: boolean;
}) {
  const [tools, setTools] = useState<ToolInfo[]>(
    native ? [] : (registry as ToolInfo[]),
  );
  const [loading, setLoading] = useState(native);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!native) {
      setTools(registry as ToolInfo[]);
      setLoading(false);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void toolRegistryApi
      .list()
      .then((rows) => {
        // Never render a malformed reply as an empty or partial registry.
        if (!Array.isArray(rows)) throw new Error("invalid tool registry");
        if (!cancelled) setTools(rows);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [native, attempt]);

  return (
    <section aria-labelledby="settings-tools-heading" tabIndex={-1}>
      <h2 id="settings-tools-heading">工具</h2>
      {native && (
        <Suspense
          fallback={
            <p className="settings-tools-description" role="status">
              正在检测本机工具…
            </p>
          }
        >
          <AboutSection isPortable={false} toolsOnly />
        </Suspense>
      )}
      <p className="settings-tools-description">
        切换型工具使用一条当前线路；增量型工具在自身配置中保留多个条目。线路页的切换与启停会直接写入后端管理的
        live 配置。 下方是配置适配清单，不是已安装客户端清单；Pi、MiniMax Code
        和 Claude Desktop 暂无安装管理入口。
      </p>
      {!native && (
        <p className="settings-tools-preview-note" role="status">
          浏览器预览：以下为应用内置的支持工具清单，尚未读取本机安装状态和显示偏好。
        </p>
      )}
      {loading ? (
        <p role="status">正在读取工具注册表…</p>
      ) : failed ? (
        <div role="alert">
          无法读取工具注册表。
          <button
            type="button"
            className="secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试
          </button>
        </div>
      ) : tools.length === 0 ? (
        <p role="status">工具注册表为空。</p>
      ) : (
        <div className="settings-tools-list">
          {tools.map((tool) => (
            <details key={tool.id} className="settings-tool-row">
              <summary>
                <span className="settings-tool-mark" aria-hidden="true">
                  {toolBadgeMarks[tool.id] ?? "?"}
                </span>
                <b>{toolDisplayNames[tool.id] ?? tool.id}</b>
                <span className="settings-tool-mode">
                  {tool.mode === "switch" ? "切换型" : "增量型"}
                </span>
                <span className="settings-tool-visibility">
                  {!native || !settings
                    ? "偏好未读取"
                    : (settings.visibleApps?.[tool.id] ?? tool.id === "codex")
                      ? "已设为显示"
                      : "未设为显示"}
                </span>
              </summary>
              <div className="settings-tool-details">
                <p>默认配置位置（自定义目录以本机设置为准）</p>
                <ul>
                  {tool.liveFiles.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
                <p>
                  深链：
                  {tool.deeplink === "reject"
                    ? "不支持"
                    : tool.deeplink === "importOnly"
                      ? "仅导入，不激活"
                      : "导入前确认"}{" "}
                  · 托盘：{tool.tray ? "支持" : "不支持"} · 代理：
                  {tool.proxy ? "支持" : "不支持"}
                </p>
                <p>
                  注册表只描述配置适配范围；显示偏好与线路配置不代表已安装，请以上方安装检测为准。
                </p>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
