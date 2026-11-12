import { useEffect, useState } from "react";
import { MonitorCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  claudeAccountsApi,
  DEFAULT_DESKTOP_ID,
} from "@/lib/api/claudeAccounts";

/**
 * A sign-in on this computer that is not saved yet, said on the lines page
 * so it is seen without opening 官方账号. The import itself happens there.
 */
export function LocalLoginNotice({
  mode,
  native,
  refreshVersion = 0,
  onOpen,
}: {
  mode: "code" | "desktop";
  native: boolean;
  refreshVersion?: number;
  onOpen: () => void;
}) {
  const [found, setFound] = useState<{ email: string | null } | null>(null);

  useEffect(() => {
    if (!native) return;
    let alive = true;
    const detect = async () => {
      if (mode === "desktop") {
        const swap = await claudeAccountsApi.desktopSwapStatus();
        if (!swap.supported || !swap.signedIn || swap.currentAccountId)
          return null;
        const email = await claudeAccountsApi
          .desktopQuota(DEFAULT_DESKTOP_ID)
          .then((quota) => quota.email ?? null)
          .catch(() => null);
        return { email };
      }
      const code = await claudeAccountsApi.listCode();
      if (!code.supported || !code.live?.signedIn || code.live.savedId)
        return null;
      return { email: code.live.email ?? null };
    };
    detect()
      .then((result) => {
        if (alive) setFound(result);
      })
      .catch(() => {
        if (alive) setFound(null);
      });
    return () => {
      alive = false;
    };
  }, [mode, native, refreshVersion]);

  if (!found) return null;
  const tool = mode === "desktop" ? "Claude Desktop" : "Claude Code";
  return (
    <div className="claude-local-login" role="status">
      <MonitorCheck size={16} aria-hidden="true" />
      <span>
        检测到本机 {tool} 已登录
        {found.email ? <strong> {found.email}</strong> : null}
        ，还没有导入。导入后可以一键切换，不用选文件。
      </span>
      <Button size="sm" onClick={onOpen}>
        去导入
      </Button>
    </div>
  );
}
