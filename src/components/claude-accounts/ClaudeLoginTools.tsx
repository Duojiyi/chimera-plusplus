import { useEffect, useRef, useState } from "react";
import { FileDown, FileUp, Globe, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  claudeAccountsApi,
  type ClaudeLoginImportReport,
} from "@/lib/api/claudeAccounts";

const POLL_INTERVAL_MS = 2_000;

/** Backend errors arrive as text; drop the generic "无效输入: " prefix. */
function messageOf(cause: unknown): string {
  const text = (cause instanceof Error ? cause.message : String(cause)).trim();
  return text.replace(/^(无效输入|并发冲突):\s*/, "") || "操作失败，请重试";
}

/** Stops a flow without waiting; a flow that is already over is not an error. */
function endFlow(id: string) {
  void Promise.resolve()
    .then(() => claudeAccountsApi.cancelBrowserLogin(id))
    .catch(() => {});
}

type Browser =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting"; id: string }
  | { phase: "failed"; message: string };

export interface ClaudeLoginToolsProps {
  /** Another change to the accounts is running. */
  disabled: boolean;
  /** The app can start a browser authorization on this system. */
  browserSupported: boolean;
  /** Logins that can be written to a file. */
  exportable: number;
  /** Called after the saved logins changed, so the lists reload. */
  onChanged: () => void;
}

/**
 * Add a Claude login by browser authorization, or move logins in and out as a
 * JSON file. Shared by the Claude Code and Claude Desktop pages: both read the
 * same saved logins.
 */
export function ClaudeLoginTools({
  disabled,
  browserSupported,
  exportable,
  onChanged,
}: ClaudeLoginToolsProps) {
  const [browser, setBrowser] = useState<Browser>({ phase: "idle" });
  const [report, setReport] = useState<ClaudeLoginImportReport | null>(null);
  const [confirmExport, setConfirmExport] = useState(false);
  const [working, setWorking] = useState<"import" | "export" | null>(null);
  const mounted = useRef(true);
  const flowId = useRef<string | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const waitingId = browser.phase === "waiting" ? browser.id : null;
  flowId.current = waitingId;

  // Leaving the page ends a flow that is still waiting: nothing polls it
  // anymore, and its console window would stay open.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (flowId.current) endFlow(flowId.current);
    };
  }, []);

  useEffect(() => {
    if (!waitingId) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const result = await claudeAccountsApi.pollBrowserLogin(waitingId);
        if (stopped) return;
        if (result.state === "waiting") {
          timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
          return;
        }
        if (result.state === "done") {
          setBrowser({ phase: "idle" });
          toast.success(
            result.created
              ? `已添加「${result.account.name}」`
              : `「${result.account.name}」已更新为刚授权的登录`,
            {
              description:
                "Claude Code 当前的登录没有改动；要使用它，请在账号列表里切换。",
            },
          );
          onChangedRef.current();
          return;
        }
        setBrowser({
          phase: "failed",
          message:
            result.state === "failed"
              ? result.message
              : "这次授权已经结束，或应用被重启过。请重新开始。",
        });
      } catch (cause) {
        if (!stopped)
          setBrowser({ phase: "failed", message: messageOf(cause) });
      }
    };
    timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS / 2);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [waitingId]);

  const startBrowser = async () => {
    if (browser.phase === "starting") return;
    setBrowser({ phase: "starting" });
    try {
      const id = await claudeAccountsApi.beginBrowserLogin();
      if (mounted.current) setBrowser({ phase: "waiting", id });
    } catch (cause) {
      if (mounted.current)
        setBrowser({ phase: "failed", message: messageOf(cause) });
    }
  };

  const cancelBrowser = () => {
    if (browser.phase === "waiting") endFlow(browser.id);
    setBrowser({ phase: "idle" });
  };

  const importFile = async () => {
    if (working) return;
    setWorking("import");
    try {
      const result = await claudeAccountsApi.importLogins();
      if (!mounted.current || result === null) return;
      setReport(result);
      if (result.imported.length > 0 || result.updated.length > 0)
        onChangedRef.current();
    } catch (cause) {
      if (mounted.current) toast.error(messageOf(cause));
    } finally {
      if (mounted.current) setWorking(null);
    }
  };

  const exportFile = async () => {
    if (working) return;
    setWorking("export");
    try {
      const result = await claudeAccountsApi.exportLogins();
      if (!mounted.current) return;
      setConfirmExport(false);
      if (result === null) return;
      toast.success(`已导出 ${result.count} 个登录`, {
        description: `${result.path}${
          result.skipped > 0
            ? `（另有 ${result.skipped} 个缺少账号信息，没有导出）`
            : ""
        }。文件里是明文令牌，用完请删除。`,
      });
    } catch (cause) {
      if (mounted.current) {
        setConfirmExport(false);
        toast.error(messageOf(cause));
      }
    } finally {
      if (mounted.current) setWorking(null);
    }
  };

  const browserOpen = browser.phase !== "idle";
  const busy = disabled || working !== null || browser.phase === "starting";

  return (
    <div className="claude-login-tools">
      <div
        className="claude-login-tools-actions"
        role="group"
        aria-label="登录凭证"
      >
        {browserSupported ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || browserOpen}
            onClick={() => void startBrowser()}
          >
            <Globe size={14} aria-hidden="true" />
            从浏览器授权添加
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void importFile()}
        >
          {working === "import" ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <FileUp size={14} aria-hidden="true" />
          )}
          导入凭证文件
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || exportable === 0}
          title={exportable === 0 ? "还没有可导出的登录" : undefined}
          onClick={() => setConfirmExport(true)}
        >
          <FileDown size={14} aria-hidden="true" />
          导出凭证文件
        </Button>
      </div>

      <Dialog
        open={browserOpen}
        onOpenChange={(open) => {
          if (!open && browser.phase !== "starting") cancelBrowser();
        }}
      >
        <DialogContent className="claude-accounts-dialog">
          <DialogTitle>
            {browser.phase === "failed"
              ? "浏览器授权没有完成"
              : "在浏览器里授权 Claude 账号"}
          </DialogTitle>
          {browser.phase === "failed" ? (
            <>
              <DialogDescription>{browser.message}</DialogDescription>
              <footer className="claude-accounts-form-actions">
                <Button variant="outline" onClick={cancelBrowser}>
                  关闭
                </Button>
                <Button onClick={() => void startBrowser()}>重新开始</Button>
              </footer>
            </>
          ) : (
            <>
              <DialogDescription>
                用 Claude Code 官方的授权流程添加账号，不会改动 Claude Code
                当前的登录。
              </DialogDescription>
              <ol className="claude-accounts-steps">
                <li>
                  浏览器会打开 claude.ai
                  的授权页，选择要添加的账号并点击「授权」。
                </li>
                <li>
                  如果页面最后给出一串授权码，把它粘贴到弹出的黑色窗口里并回车；多数情况下会自动完成，不需要这一步。
                </li>
                <li>完成后这里会自动保存，无需其他操作。</li>
              </ol>
              <p className="claude-accounts-note" role="status">
                <Loader2
                  size={14}
                  className="animate-spin"
                  aria-hidden="true"
                />
                {browser.phase === "starting"
                  ? "正在启动…"
                  : "等待授权完成…（最多 15 分钟）"}
              </p>
              <footer className="claude-accounts-form-actions">
                <Button
                  variant="outline"
                  disabled={browser.phase === "starting"}
                  onClick={cancelBrowser}
                >
                  取消授权
                </Button>
              </footer>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={report !== null}
        onOpenChange={(open) => {
          if (!open) setReport(null);
        }}
      >
        <DialogContent className="claude-accounts-dialog">
          <DialogTitle>导入完成</DialogTitle>
          <DialogDescription>
            {report
              ? `新增 ${report.imported.length} 个，更新 ${report.updated.length} 个，跳过 ${report.skipped.length} 个。`
              : ""}
          </DialogDescription>
          <ul className="claude-login-report">
            {report?.imported.map((account) => (
              <li key={`i:${account.id}`}>
                <strong>新增</strong>
                <span>{account.name}</span>
                {account.email && account.email !== account.name ? (
                  <small>{account.email}</small>
                ) : null}
              </li>
            ))}
            {report?.updated.map((account) => (
              <li key={`u:${account.id}`}>
                <strong>更新</strong>
                <span>{account.name}</span>
                <small>已用文件里的新登录替换了失效的那份</small>
              </li>
            ))}
            {report?.skipped.map((skipped, index) => (
              <li key={`s:${index}`} data-skipped="true">
                <strong>跳过</strong>
                <span>{skipped.email ?? "未识别的账号"}</span>
                <small>{skipped.reason}</small>
              </li>
            ))}
          </ul>
          <footer className="claude-accounts-form-actions">
            <Button onClick={() => setReport(null)}>知道了</Button>
          </footer>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        isOpen={confirmExport}
        busy={working === "export"}
        title="导出的文件里是明文令牌"
        message={`文件包含 ${exportable} 个账号的 access token 和 refresh token，拿到它的人可以直接登录这些 Claude 账号。只保存在可信的位置，用完立即删除，不要上传或发给别人。格式与 claude-swap 兼容，可以导入那边使用。`}
        confirmText="我了解，选择保存位置"
        cancelText="取消"
        variant="destructive"
        onCancel={() => {
          if (working !== "export") setConfirmExport(false);
        }}
        onConfirm={() => void exportFile()}
      />
    </div>
  );
}
