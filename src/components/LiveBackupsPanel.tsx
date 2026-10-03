import "./LiveBackupsPanel.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import type { AppId } from "@/lib/api/types";
import { liveBackupsApi, type LiveBackup } from "@/lib/api/liveBackups";

const reasons: Record<LiveBackup["reason"], string> = {
  manual: "手动备份",
  firstWrite: "首次写入前",
  firstEnable: "首次启用前",
  preRestore: "恢复前",
  preImport: "导入前",
  prePrompt: "提示词写入前",
  preRepair: "配置修复前",
};
const fileName = (path: string) => path.split(/[\\/]/).pop() || "配置文件";

/** Mount only after the live_backups capability is enabled. Native guards remain authoritative. */
const backupTools = [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["claude-desktop", "Claude Desktop"],
  ["gemini", "Gemini"],
  ["grokbuild", "Grok Build"],
  ["opencode", "OpenCode"],
  ["openclaw", "OpenClaw"],
  ["hermes", "Hermes"],
] as const;

export function LiveBackupsPanel({
  onRestored,
}: { onRestored?: () => void } = {}) {
  const [app, setApp] = useState<AppId>("codex");
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <label>
        Live 备份工具{" "}
        <select
          aria-label="Live 备份工具"
          value={app}
          disabled={busy}
          onChange={(event) => setApp(event.target.value as AppId)}
        >
          {backupTools.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p>
        Pi、MiniMax Code 暂无后端 Live 备份清单。Claude Desktop 仅支持
        Windows/macOS。
      </p>
      <ToolLiveBackupsPanel
        key={app}
        app={app}
        onBusyChange={setBusy}
        onRestored={onRestored}
      />
    </div>
  );
}

function ToolLiveBackupsPanel({
  app,
  onBusyChange,
  onRestored,
}: {
  app: AppId;
  onBusyChange: (busy: boolean) => void;
  onRestored?: () => void;
}) {
  const [backups, setBackups] = useState<LiveBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{
    kind: "restore" | "delete";
    backup: LiveBackup;
  } | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  useLightweightCloseBlocker(busy);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(false);
    setBackups([]);
    try {
      const rows = await liveBackupsApi.list(app);
      if (mounted.current && request === generation.current) setBackups(rows);
    } catch {
      if (mounted.current && request === generation.current) setError(true);
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, [app]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [load]);
  const run = async (job: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await job();
      if (mounted.current) setAction(null);
    } catch {
      if (mounted.current)
        toast.error("备份操作失败，未确认完成。请检查配置后重试。");
    } finally {
      if (mounted.current) await load();
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const openDirectory = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await liveBackupsApi.openDirectory(app);
    } catch {
      if (mounted.current)
        toast.error("无法打开备份目录，请检查本机文件管理器。");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const disabled = loading || busy || error;
  return (
    <section
      className="live-backups-panel"
      aria-label={`${backupTools.find(([id]) => id === app)?.[1]} Live 备份`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="live-backups-heading">备份与恢复</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void openDirectory()}
          >
            打开备份目录
          </Button>
          <Button
            variant="outline"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            刷新备份
          </Button>
          <Button
            disabled={disabled}
            onClick={() =>
              void run(async () => {
                const backup = await liveBackupsApi.create(app);
                if (mounted.current) {
                  if (backup) toast.success("备份已创建");
                  else toast.info("没有可备份的 Live 文件，未创建备份。");
                }
              })
            }
          >
            创建备份
          </Button>
        </div>
      </div>
      <p className="live-backups-description">
        仅本机保存，最多保留 20 份。不会备份或恢复 auth.json
        登录凭据。其他工具配置可能包含 API 密钥，请妥善保管备份。
      </p>
      <div className="overflow-x-auto">
        <table className="live-backups-table">
          <thead>
            <tr className="border-b">
              <th scope="col">时间</th>
              <th scope="col">触发</th>
              <th scope="col">包含文件</th>
              <th scope="col">大小</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {(loading || error || backups.length === 0) && (
              <tr>
                <td colSpan={5} className="live-backups-empty">
                  {loading ? (
                    <p role="status">正在读取备份…</p>
                  ) : error ? (
                    <p role="alert">备份读取失败。请刷新重试，未显示旧列表。</p>
                  ) : (
                    <p>暂无 Live 备份。</p>
                  )}
                </td>
              </tr>
            )}
            {backups.map((backup) => (
              <tr key={backup.id} className="border-b">
                <td className="p-2">
                  <div>{new Date(backup.createdAt).toLocaleString()}</div>
                  <small className="live-backup-id" title={backup.id}>
                    {backup.id}
                  </small>
                </td>
                <td>{reasons[backup.reason] || "备份"}</td>
                <td className="p-2 break-all">
                  {backup.files.map(fileName).join("、")}
                </td>
                <td className="live-backup-size">
                  {typeof backup.sizeBytes === "number" &&
                  Number.isFinite(backup.sizeBytes) &&
                  backup.sizeBytes >= 0
                    ? `${(backup.sizeBytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`
                    : "—"}
                </td>
                <td className="p-2">
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={`恢复备份 ${backup.id}`}
                      onClick={() => setAction({ kind: "restore", backup })}
                    >
                      恢复
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={`删除备份 ${backup.id}`}
                      onClick={() => setAction({ kind: "delete", backup })}
                    >
                      删除
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        isOpen={action !== null}
        busy={busy}
        title={action?.kind === "restore" ? "恢复 Live 备份" : "删除 Live 备份"}
        message={
          action?.kind === "restore"
            ? app !== "codex"
              ? "将覆盖所选工具备份中的配置文件（可能含 API 密钥），恢复前会备份现有文件。不是完整登录身份恢复；请先停止该工具及其他程序对配置的修改。"
              : "将恢复备份中的配置文件，并在恢复前备份现有文件。恢复 AGENTS.md 时会同步提示词启用状态，原模板保留。登录凭据不会修改；可读取的当前 Codex 模型设置将保留。请先停止其他工具对这些文件的修改。"
            : "将永久删除这份本地备份，当前配置文件不会改变。"
        }
        confirmText={action?.kind === "restore" ? "确认恢复" : "确认删除"}
        cancelText="取消"
        onCancel={() => {
          if (!pending.current) setAction(null);
        }}
        onConfirm={() => {
          if (!action) return;
          void run(async () => {
            if (action.kind === "delete") {
              await liveBackupsApi.delete(app, action.backup.id);
              if (mounted.current) toast.success("备份已删除");
            } else {
              const result = await liveBackupsApi.restore(
                app,
                action.backup.id,
              );
              if (mounted.current) {
                onRestored?.();
                toast.success(`已恢复 ${result.restored.length} 个文件`);
                if (result.identityChanged)
                  toast.info("当前登录身份与备份记录不同，登录凭据未修改。");
              }
            }
          });
        }}
      />
    </section>
  );
}
