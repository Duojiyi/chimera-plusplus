import "./ToolVisibilityPage.css";
import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Info } from "lucide-react";
import { settingsApi } from "@/lib/api/settings";
import { productToolViews } from "@/lib/productCapabilities";
import registry from "@/shared/tool-registry.json";
import type { VisibleApps } from "@/types";
import { toolBadgeMarks, toolDisplayNames } from "./toolBadges";

type ToolId = Exclude<keyof VisibleApps, "codex">;

const tools: ToolId[] = Object.values(productToolViews);
const switchesOneLine = new Set(
  registry.filter((tool) => tool.mode === "switch").map((tool) => tool.id),
);
const notes: Partial<Record<ToolId, string>> = {
  pi: "默认模型仍在 Pi 中选择",
};
// Known gaps, worded as on the tool pages and in Skills 与 MCP.
const limits: Partial<Record<ToolId, readonly string[]>> = {
  "claude-desktop": ["仅检测标准安装路径"],
  openclaw: ["暂不支持受管 MCP"],
  pi: ["无安装管理"],
  mcode: ["无安装管理"],
};

const describe = (appId: ToolId) =>
  [
    switchesOneLine.has(appId) ? "一次使用一条线路" : "可同时启用多条线路",
    notes[appId],
  ]
    .filter(Boolean)
    .join("，");

const reason = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function ToolVisibilityPage({ native }: { native: boolean }) {
  const baseId = useId();
  const client = useQueryClient();
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
    enabled: native,
  });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [pending, setPending] = useState<ReadonlySet<ToolId>>(new Set());
  const [failures, setFailures] = useState<Partial<Record<ToolId, string>>>({});
  const ready = native && Boolean(data) && !isError;

  const toggle = (appId: ToolId, visible: boolean) => {
    setPending((current) => new Set(current).add(appId));
    setFailures((current) => {
      const next = { ...current };
      delete next[appId];
      return next;
    });
    // One save at a time, each re-reading settings first, so queued changes
    // never overwrite each other or unrelated preferences.
    queue.current = queue.current.then(async () => {
      try {
        const current = await settingsApi.get();
        const visibleApps = Object.fromEntries(
          ["codex", ...tools].map((id) => [
            id,
            current.visibleApps?.[id as keyof VisibleApps] ?? id === "codex",
          ]),
        ) as unknown as VisibleApps;
        const next = {
          ...current,
          visibleApps: { ...visibleApps, [appId]: visible },
        };
        if (!(await settingsApi.save(next))) throw new Error("保存未完成");
        client.setQueryData(["settings"], next);
      } catch (cause) {
        setFailures((current) => ({ ...current, [appId]: reason(cause) }));
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(appId);
          return next;
        });
      }
    });
  };

  return (
    <section
      className="tool-visibility-page"
      aria-labelledby={`${baseId}-title`}
    >
      <header className="tool-visibility-header">
        <h1 id={`${baseId}-title`}>管理工具</h1>
        <p>选择在侧栏「其他工具」中显示哪些工具</p>
      </header>
      <div className="tool-visibility-callout" role="note">
        <Info size={16} aria-hidden="true" />
        <p>
          启用只是在侧栏显示该工具，并允许 Chimera++
          管理它的配置；不会安装工具，也不会导入或激活任何线路。关闭后，已写入的配置保持不变。
        </p>
      </div>
      {!native && (
        <p className="tool-visibility-notice" role="status">
          浏览器预览无法读取或保存本机工具偏好，请在桌面应用中修改。
        </p>
      )}
      {native && isError && (
        <div className="tool-visibility-load-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span>无法读取工具偏好，暂时不能修改。</span>
          <button
            type="button"
            className="secondary"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {isFetching ? "正在重试…" : "重试"}
          </button>
        </div>
      )}
      {native && isLoading && (
        <p className="sr-only" role="status">
          正在读取工具偏好…
        </p>
      )}
      <ul
        className="tool-visibility-list"
        aria-label="工具"
        aria-busy={native && isLoading}
      >
        <li className="tool-visibility-row">
          <span className="tool-visibility-badge" aria-hidden="true">
            {toolBadgeMarks.codex}
          </span>
          <div className="tool-visibility-text">
            <span className="tool-visibility-name">
              {toolDisplayNames.codex}
            </span>
            <p className="tool-visibility-description">核心入口</p>
          </div>
          <span className="tool-visibility-fixed">始终显示</span>
        </li>
        {tools.map((appId) => {
          const id = `${baseId}-${appId}`;
          const name = toolDisplayNames[appId];
          const saving = pending.has(appId);
          const failure = failures[appId];
          const toolLimits = limits[appId];
          return (
            <li
              key={appId}
              className="tool-visibility-row"
              aria-busy={saving || undefined}
            >
              <span className="tool-visibility-badge" aria-hidden="true">
                {toolBadgeMarks[appId]}
              </span>
              <div className="tool-visibility-text">
                {ready ? (
                  <label className="tool-visibility-name" htmlFor={id}>
                    {name}
                  </label>
                ) : (
                  <span className="tool-visibility-name">{name}</span>
                )}
                <p
                  id={`${id}-description`}
                  className="tool-visibility-description"
                >
                  {describe(appId)}
                </p>
                {toolLimits && (
                  <ul
                    className="tool-visibility-limits"
                    aria-label={`${name} 的已知限制`}
                  >
                    {toolLimits.map((limit) => (
                      <li key={limit}>{limit}</li>
                    ))}
                  </ul>
                )}
                {failure && (
                  <p className="tool-visibility-error" role="alert">
                    {name} 的显示设置未保存：{failure}。请重试。
                  </p>
                )}
              </div>
              <span id={`${id}-state`} className="tool-visibility-state">
                {saving ? "正在保存…" : ""}
              </span>
              {ready ? (
                <input
                  id={id}
                  type="checkbox"
                  role="switch"
                  className="tool-visibility-switch"
                  checked={data?.visibleApps?.[appId] === true}
                  // Not `disabled`: that would drop keyboard focus mid-save.
                  aria-disabled={saving || undefined}
                  aria-describedby={`${id}-description ${id}-state`}
                  onChange={(event) => {
                    if (!saving) toggle(appId, event.target.checked);
                  }}
                />
              ) : (
                <span
                  className={`tool-visibility-switch-placeholder${native && isLoading ? " is-loading" : ""}`}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
