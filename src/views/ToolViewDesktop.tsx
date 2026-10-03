import { useCallback, useEffect, useState } from "react";
import { providersApi, type ClaudeDesktopStatus } from "@/lib/api/providers";
import { ClaudeDesktopRouteToggle } from "@/components/proxy/ClaudeDesktopRouteToggle";
import { Button } from "@/components/ui/button";

export default function ToolViewDesktop({
  native,
  refreshVersion,
  onChanged,
  onSupported,
}: {
  native: boolean;
  refreshVersion: number;
  onChanged: () => Promise<void>;
  onSupported: (supported: boolean) => void;
}) {
  const [status, setStatus] = useState<ClaudeDesktopStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setError("");
      const next = await providersApi.getClaudeDesktopStatus();
      setStatus(next);
      onSupported(next.supported);
    } catch (cause) {
      setError(String(cause));
      setStatus(null);
      onSupported(false);
    }
  }, [onSupported]);
  useEffect(() => {
    if (!native) return;
    let active = true;
    providersApi
      .getClaudeDesktopStatus()
      .then((next) => {
        if (active) {
          setStatus(next);
          setError("");
          onSupported(next.supported);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(String(cause));
          onSupported(false);
        }
      });
    return () => {
      active = false;
    };
  }, [native, refreshVersion, onSupported]);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await onChanged();
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="Claude Desktop 配置状态"
      className="rounded border p-3 space-y-2"
    >
      <p>
        {status?.installationPath
          ? `检测到 Desktop 程序：${status.installationPath}`
          : status
            ? "标准路径未检测到程序，可能为自定义/MSIX安装"
            : "安装探测状态未知，请先读取 Desktop 状态。"}
      </p>
      <p>
        暂无 Desktop 安装、升级或重启管理；以下仅为 3P
        配置状态。标准路径为最佳努力探测，MSIX 未验证。
      </p>
      {!native ? (
        <p>请在桌面应用中读取状态。</p>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          <p>
            {!status
              ? "配置状态未知"
              : !status.supported
                ? "当前平台不支持 Desktop 3P 配置（Linux 不支持）"
                : status.configured
                  ? "已存在 3P 配置，不代表已安装或已登录"
                  : "尚未配置 3P"}
          </p>
          {status?.supported && (
            <>
              <p>
                配置模式：{status.mode ?? "未设置"} · 路由服务：
                {status.proxyRunning ? "运行中" : "未运行"}
              </p>
              {status.profilePath && <p>Profile：{status.profilePath}</p>}
              {status.staleRawModels && (
                <p role="alert">模型配置已过期，请重新应用线路。</p>
              )}
              {status.missingRouteMappings && (
                <p role="alert">缺少模型路由映射，请检查线路配置。</p>
              )}
              <ClaudeDesktopRouteToggle />
            </>
          )}
          <Button disabled={busy} onClick={() => void load()}>
            重新读取 Desktop 状态
          </Button>
          <Button
            disabled={busy || !status?.supported}
            onClick={() =>
              void act(() => providersApi.importClaudeDesktopFromClaude())
            }
          >
            从 Claude Code 导入线路（不激活）
          </Button>
          <Button
            disabled={busy || !status?.supported}
            onClick={() =>
              void act(() => providersApi.ensureClaudeDesktopOfficialProvider())
            }
          >
            添加官方配置入口（不切换）
          </Button>
        </>
      )}
      <p>切换线路后需手动重启 Desktop；官方配置入口不代表官方账户已登录。</p>
    </section>
  );
}
