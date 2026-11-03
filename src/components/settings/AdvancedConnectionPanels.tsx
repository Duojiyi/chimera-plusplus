import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GlobalProxySettings } from "@/components/settings/GlobalProxySettings";
import { useGlobalProxyUrl } from "@/hooks/useGlobalProxy";
import { AutoFailoverConfigPanel } from "@/components/proxy/AutoFailoverConfigPanel";
import { FailoverQueueManager } from "@/components/proxy/FailoverQueueManager";
import { invoke } from "@tauri-apps/api/core";
import type { ProxyStatus, ProxyTakeoverStatus } from "@/types/proxy";

export function OutboundProxyPanel() {
  const query = useGlobalProxyUrl();
  if (query.isLoading) return <p role="status">正在读取全局代理…</p>;
  if (query.isError)
    return (
      <div role="alert">
        读取全局代理失败。
        <button onClick={() => void query.refetch()}>重试</button>
      </div>
    );
  return (
    <>
      <GlobalProxySettings />
    </>
  );
}

export function FailoverSettingsPanel() {
  const [app, setApp] = useState<"claude" | "codex" | "gemini">("codex");
  const status = useQuery({
    queryKey: ["proxyStatus"],
    queryFn: () => invoke<ProxyStatus>("get_proxy_status"),
    retry: false,
  });
  const takeover = useQuery({
    queryKey: ["proxyTakeoverStatus"],
    queryFn: () => invoke<ProxyTakeoverStatus>("get_proxy_takeover_status"),
    retry: false,
  });
  const disabled =
    status.isError ||
    takeover.isError ||
    !status.data?.running ||
    !takeover.data?.[app];
  return (
    <section aria-label="自动故障转移管理" className="space-y-3">
      <p>请求失败时按队列换用下一条线路，可能产生额外费用。</p>
      <label>
        故障转移工具{" "}
        <select
          aria-label="故障转移工具"
          value={app}
          onChange={(event) => setApp(event.target.value as typeof app)}
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
          <option value="gemini">Gemini</option>
        </select>
      </label>
      <button
        onClick={() => {
          void status.refetch();
          void takeover.refetch();
        }}
      >
        刷新代理状态
      </button>
      {disabled && (
        <p role="status">
          代理未运行、当前工具未接管或状态读取失败。队列修改已禁用；请在已有代理入口显式启用后刷新。
        </p>
      )}
      <FailoverQueueManager
        key={`queue-${app}`}
        appType={app}
        disabled={disabled}
      />
      <AutoFailoverConfigPanel
        key={`config-${app}`}
        appType={app}
        disabled={disabled}
      />
    </section>
  );
}
