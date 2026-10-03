import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { settingsApi } from "@/lib/api/settings";
import {
  nativeToolNames,
  additionalToolNames,
} from "@/utils/toolProviderConfig";
import { productToolViews } from "@/lib/productCapabilities";
import type { VisibleApps } from "@/types";

const names = { ...nativeToolNames, ...additionalToolNames };
export function ToolVisibilityView({ native }: { native: boolean }) {
  const client = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
    enabled: native,
  });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const toggle = async (
    appId: Exclude<keyof VisibleApps, "codex">,
    checked: boolean,
  ) => {
    setBusy(true);
    setSaveError("");
    try {
      // Read current settings before saving, preserving unrelated preferences.
      const current = await settingsApi.get();
      const visibleApps = Object.fromEntries(
        ["codex", ...Object.values(productToolViews)].map((id) => [
          id,
          current.visibleApps?.[id as keyof VisibleApps] ?? id === "codex",
        ]),
      ) as unknown as VisibleApps;
      const next = {
        ...current,
        visibleApps: { ...visibleApps, [appId]: checked },
      };
      if (!(await settingsApi.save(next))) throw new Error("工具偏好保存失败");
      client.setQueryData(["settings"], next);
    } catch (cause) {
      setSaveError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="p-6 space-y-3" aria-label="工具显示偏好">
      <h1>管理工具</h1>
      <p>
        显式启用工具后显示导航，并参与后端工具策略。启用不安装工具、不导入或激活线路；隐藏不代表卸载或撤销已写入配置。
      </p>
      {!native && <p>浏览器预览无法读取或保存本机工具偏好。</p>}
      {native && isLoading && <p role="status">正在读取工具偏好…</p>}
      {(error || saveError) && <p role="alert">{saveError || String(error)}</p>}
      {native && error && (
        <button onClick={() => void refetch()}>重试读取偏好</button>
      )}
      {Object.values(productToolViews).map((appId) => (
        <label key={appId} className="flex gap-3 items-center">
          <input
            type="checkbox"
            checked={data?.visibleApps?.[appId] === true}
            disabled={!native || !data || busy || Boolean(error)}
            onChange={(event) => void toggle(appId, event.target.checked)}
          />
          {names[appId]}
        </label>
      ))}
      <p>
        Codex 为核心入口。Desktop
        仅探测标准安装路径，不支持托管升级；Pi、MiniMax Code
        暂无安装检测与托管升级能力。
      </p>
    </section>
  );
}
