import { Loader2, Radio } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { cn } from "@/lib/utils";

interface ClaudeDesktopRouteToggleProps {
  className?: string;
  disabled?: boolean;
}

export function ClaudeDesktopRouteToggle({
  className,
  disabled = false,
}: ClaudeDesktopRouteToggleProps) {
  const { t } = useTranslation();
  const {
    isRunning,
    isLoading,
    status,
    takeoverStatus,
    startProxyServer,
    stopProxyServer,
    isStarting,
    isStoppingServer,
  } = useProxyStatus();

  const isBusy = isStarting || isStoppingServer;
  const otherTakeoverActive = Boolean(
    takeoverStatus?.claude ||
    takeoverStatus?.codex ||
    takeoverStatus?.gemini ||
    takeoverStatus?.grokbuild,
  );
  const routeAddress = status?.address ?? "127.0.0.1";
  const routePort = status?.port ?? 15721;

  const handleToggle = async (checked: boolean) => {
    if (isBusy || isLoading || disabled) return;
    try {
      if (checked) {
        await startProxyServer();
        return;
      }

      if (otherTakeoverActive) {
        toast.warning(
          t("claudeDesktop.route.stopBlockedByTakeover", {
            defaultValue:
              "其它应用正在使用代理接管。请先在设置中关闭对应应用接管，再停止本地路由。",
          }),
          { duration: 5000 },
        );
        return;
      }

      await stopProxyServer();
    } catch (error) {
      console.error("[ClaudeDesktopRouteToggle] Toggle route failed:", error);
    }
  };

  const tooltipText = isRunning
    ? t("claudeDesktop.route.tooltip.active", {
        address: routeAddress,
        port: routePort,
        defaultValue: `Claude Desktop 本地路由已开启 - ${routeAddress}:${routePort}`,
      })
    : t("claudeDesktop.route.tooltip.inactive", {
        address: routeAddress,
        port: routePort,
        defaultValue: `开启 Claude Desktop 本地路由，用于需要模型映射或格式转换的供应商。当前配置地址：${routeAddress}:${routePort}`,
      });

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 text-xs text-[var(--text-2)]",
        className,
      )}
      title={tooltipText}
    >
      {isBusy || isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <Radio
          className={cn(
            "h-4 w-4 transition-colors",
            isRunning
              ? "text-emerald-500 animate-pulse"
              : "text-muted-foreground",
          )}
        />
      )}
      <span>
        {isBusy
          ? "处理中…"
          : isLoading
            ? "读取中…"
            : isRunning
              ? "已开启"
              : "未开启"}
      </span>
      <Switch
        aria-label="Claude Desktop 本地路由"
        checked={isRunning}
        onCheckedChange={handleToggle}
        disabled={disabled || isBusy || isLoading}
      />
    </div>
  );
}
