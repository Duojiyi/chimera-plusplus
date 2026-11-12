import "@/theme/v3/tool-visibility.css";
import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Info } from "lucide-react";
import { settingsApi } from "@/lib/api/settings";
import { productToolViews } from "@/lib/productCapabilities";
import registry from "@/shared/tool-registry.json";
import type { VisibleApps } from "@/types";
import { toolDisplayNames } from "./toolBadges";

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
};

const describe = (appId: ToolId) =>
  appId === "omp"
    ? "独立管理运行环境、插件与市场源，与 Pi 分开配置"
    : [
        switchesOneLine.has(appId) ? "一次使用一条线路" : "可同时启用多条线路",
        notes[appId],
      ]
        .filter(Boolean)
        .join("，");

const modeLabel = (appId: keyof VisibleApps) =>
  appId === "codex" || switchesOneLine.has(appId) ? "切换型" : "累加型";

// Browser design preview only (L34): a plausible visibility map, never saved.
const isDesignPreview = () =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("preview") === "design";
const DESIGN_SAMPLE_VISIBLE: Partial<Record<ToolId, boolean>> = {
  claude: true,
  "claude-desktop": true,
  gemini: true,
  grokbuild: true,
  opencode: true,
  pi: true,
  omp: false,
};

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
  const [designPreview] = useState(() => !native && isDesignPreview());
  const isVisible = (appId: ToolId) =>
    designPreview
      ? DESIGN_SAMPLE_VISIBLE[appId] === true
      : data?.visibleApps?.[appId] === true;
  const known = ready || designPreview;
  const visibleTools = known ? tools.filter(isVisible) : [];

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

  const toolCount = tools.length + 1;
  return (
    <section
      className="tool-visibility-page"
      aria-labelledby={`${baseId}-title`}
    >
      <header className="tool-visibility-header">
        <h1 id={`${baseId}-title`}>管理工具</h1>
        <p>侧栏显示哪些工具 · 隐藏不会卸载，也不会删除配置</p>
      </header>
      {!native && !designPreview && (
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
      <div className="tool-visibility-layout">
        <div className="tool-visibility-card">
          <div className="tool-visibility-card-head">
            <h2>工具</h2>
            <p>
              {known
                ? `${toolCount} 个工具 · ${visibleTools.length + 1} 个显示`
                : `${toolCount} 个工具`}
            </p>
          </div>
          <ul
            className="tool-visibility-list"
            aria-label="工具"
            aria-busy={native && isLoading}
          >
            <li className="tool-visibility-row">
              <span
                className="v3-tool-bar"
                data-tool="codex"
                aria-hidden="true"
              />
              <div className="tool-visibility-text">
                <span className="tool-visibility-name">
                  {toolDisplayNames.codex}
                </span>
                <p className="tool-visibility-description">
                  在侧栏顶部固定显示，不能隐藏
                </p>
              </div>
              <span className="tool-visibility-mode">{modeLabel("codex")}</span>
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
                  <span
                    className="v3-tool-bar"
                    data-tool={appId}
                    aria-hidden="true"
                  />
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
                  <span className="tool-visibility-mode">
                    {modeLabel(appId)}
                  </span>
                  <span id={`${id}-state`} className="tool-visibility-state">
                    {saving ? "正在保存…" : ""}
                  </span>
                  {ready ? (
                    <input
                      id={id}
                      type="checkbox"
                      role="switch"
                      className="tool-visibility-switch"
                      checked={isVisible(appId)}
                      // Not `disabled`: that would drop keyboard focus mid-save.
                      aria-disabled={saving || undefined}
                      aria-describedby={`${id}-description ${id}-state`}
                      onChange={(event) => {
                        if (!saving) toggle(appId, event.target.checked);
                      }}
                    />
                  ) : (
                    <span
                      className={`tool-visibility-switch-placeholder${native && isLoading ? " is-loading" : ""}${designPreview && isVisible(appId) ? " is-on" : ""}`}
                      aria-hidden="true"
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <p className="tool-visibility-foot">
            隐藏只影响侧栏是否显示，不会卸载或改动任何工具的数据。
          </p>
        </div>
        <aside className="tool-visibility-card tool-visibility-preview">
          <div className="tool-visibility-card-head">
            <h2>侧栏预览</h2>
            <p>
              {known
                ? `切换器里能看到这 ${visibleTools.length + 1} 个工具`
                : "读取工具偏好后显示"}
            </p>
          </div>
          {known && (
            <ul className="tool-visibility-preview-list" aria-label="侧栏预览">
              {(["codex", ...visibleTools] as (keyof VisibleApps)[]).map(
                (appId) => (
                  <li key={appId}>
                    <span
                      className="v3-tool-bar"
                      data-tool={appId}
                      aria-hidden="true"
                    />
                    <span>{toolDisplayNames[appId]}</span>
                    <small>{modeLabel(appId)}</small>
                  </li>
                ),
              )}
            </ul>
          )}
          <p className="tool-visibility-preview-note">
            <Info size={13} aria-hidden="true" />
            切换型一次只用一条线路；累加型可以同时启用多条线路。
          </p>
        </aside>
      </div>
    </section>
  );
}
