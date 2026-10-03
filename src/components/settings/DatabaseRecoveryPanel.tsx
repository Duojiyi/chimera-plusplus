import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { backupsApi } from "@/lib/api/settings";
import {
  PartialBackupRestoreError,
  restoreDatabaseBackup,
} from "@/lib/api/config";
import { promptCodexImportReview } from "@/utils/codexImportReview";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";

export function DatabaseRecoveryPanel({
  onRestored,
  onBusyChange,
}: {
  onRestored?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["db-backups"],
    queryFn: backupsApi.listDbBackups,
    retry: false,
  });
  const [action, setAction] = useState<{
    kind: "restore" | "delete";
    filename: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState("");
  useLightweightCloseBlocker(busy);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const run = async (job: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    let restored = false;
    try {
      await job();
      restored = action?.kind === "restore";
      setAction(null);
      toast.success("数据库备份操作已完成");
    } catch (error) {
      restored = error instanceof PartialBackupRestoreError;
      if (restored) setAction(null);
      setNotice(
        restored
          ? "数据库已恢复，但 Live/运行态同步未完成。请重新应用当前供应商，不要重复恢复。"
          : "数据库备份操作失败，未确认完成，请刷新后重试。",
      );
    } finally {
      try {
        if (restored) {
          await client.invalidateQueries();
          onRestored?.();
          await promptCodexImportReview(t);
        }
        await query.refetch();
      } catch {
        setNotice(
          "备份操作已结束，但界面刷新失败。请重新打开设置确认状态，不要重复恢复。",
        );
      } finally {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section aria-label="应用数据库备份" className="space-y-3">
      <h3>应用数据库备份</h3>
      <p>
        恢复将替换应用 DB，后端会先创建安全备份，并可能重同步工具 Live
        配置。不是完整应用或登录凭据备份；Codex
        导入配置仍需审核确认。不会启用定时备份或云同步。
      </p>
      {notice && <p role="alert">{notice}</p>}
      <button
        className="secondary"
        disabled={busy || query.isFetching}
        onClick={() => void query.refetch()}
      >
        刷新数据库备份
      </button>{" "}
      <button
        className="secondary"
        disabled={busy || query.isPending || query.isError}
        onClick={() => void run(backupsApi.createDbBackup)}
      >
        创建数据库备份
      </button>
      {query.isPending ? (
        <p role="status">正在读取数据库备份…</p>
      ) : query.isError ? (
        <p role="alert">数据库备份读取失败，请刷新重试。</p>
      ) : query.data?.length ? (
        <ul>
          {query.data.map((backup) => (
            <li key={backup.filename}>
              <span>
                {backup.filename} ·{" "}
                {new Date(backup.createdAt).toLocaleString()} ·{" "}
                {(backup.sizeBytes / 1024).toFixed(1)} KiB
              </span>{" "}
              <button
                disabled={busy || query.isFetching}
                onClick={() =>
                  setAction({ kind: "restore", filename: backup.filename })
                }
              >
                恢复 {backup.filename}
              </button>{" "}
              <button
                disabled={busy || query.isFetching}
                onClick={() =>
                  setAction({ kind: "delete", filename: backup.filename })
                }
              >
                删除 {backup.filename}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>暂无数据库备份。</p>
      )}
      <ConfirmDialog
        isOpen={action !== null}
        busy={busy}
        title={action?.kind === "restore" ? "恢复应用数据库" : "删除数据库备份"}
        message={
          action?.kind === "restore"
            ? `确认恢复 ${action.filename}？将覆盖当前数据库，并可能同步工具配置。请停止其他配置写入。`
            : `确认永久删除 ${action?.filename ?? ""}？当前数据库不会改变。`
        }
        confirmText={
          action?.kind === "restore" ? "确认恢复数据库" : "确认删除数据库备份"
        }
        cancelText="取消"
        onCancel={() => {
          if (!lock.current) setAction(null);
        }}
        onConfirm={() => {
          if (action)
            void run(() =>
              action.kind === "restore"
                ? restoreDatabaseBackup(action.filename)
                : backupsApi.deleteDbBackup(action.filename),
            );
        }}
      />
    </section>
  );
}
