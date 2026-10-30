import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ProviderIcon";
import { sessionsApi, type SessionDeleteBackup } from "@/lib/api/sessions";
import { extractErrorMessage } from "@/utils/errorUtils";
import {
  formatTimestamp,
  getProviderIconName,
  getProviderLabel,
  shortSessionId,
} from "./utils";

export const DELETE_BACKUPS_QUERY_KEY = ["sessionDeleteBackups"] as const;

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const backupTitle = (backup: SessionDeleteBackup) =>
  backup.title?.trim() ||
  (backup.sessionIds[0]
    ? `会话 ${shortSessionId(backup.sessionIds[0])}`
    : "未命名会话");

const backupTime = (backup: SessionDeleteBackup) => {
  const parsed = backup.createdAt ? Date.parse(backup.createdAt) : NaN;
  return Number.isNaN(parsed) ? "" : formatTimestamp(parsed);
};

interface SessionDeleteBackupsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Sessions deleted from this page, restorable from the copies taken before
 * each delete. Restoring never overwrites a file that exists again.
 */
export function SessionDeleteBackupsDialog({
  open,
  onOpenChange,
}: SessionDeleteBackupsDialogProps) {
  const queryClient = useQueryClient();
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: DELETE_BACKUPS_QUERY_KEY,
    queryFn: () => sessionsApi.listDeleteBackups(),
    enabled: open,
  });
  const backups = data ?? [];
  const includesCodex = backups.some((backup) => backup.providerId === "codex");

  useEffect(() => {
    if (!open) setConfirmClear(false);
  }, [open]);

  const handleRestore = async (backup: SessionDeleteBackup) => {
    setRestoringId(backup.id);
    try {
      const result = await sessionsApi.restoreDeleteBackup(backup.id);
      const skipped =
        result.skippedExisting > 0
          ? `${result.skippedExisting} 个文件的原位置已有内容，没有覆盖。`
          : undefined;
      if (result.restoredFiles > 0) {
        toast.success(`已恢复「${backupTitle(backup)}」`, {
          description: skipped,
        });
      } else {
        toast.info("没有需要恢复的文件", { description: skipped });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        refetch(),
      ]);
    } catch (restoreError) {
      toast.error(extractErrorMessage(restoreError) || "恢复失败");
    } finally {
      setRestoringId(null);
    }
  };

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setIsClearing(true);
    try {
      const result = await sessionsApi.clearDeleteBackups();
      toast.success(`已清空 ${result.removedBackups} 份删除备份`, {
        description: `释放 ${formatBytes(result.freedBytes)}`,
      });
    } catch (clearError) {
      toast.error(extractErrorMessage(clearError) || "清空失败");
    } finally {
      setIsClearing(false);
      setConfirmClear(false);
      void refetch();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="session-backups-dialog">
        <DialogHeader className="session-delete-dialog-header">
          <DialogTitle className="session-backups-dialog-title">
            <History className="size-5 shrink-0" aria-hidden />
            已删除的会话
          </DialogTitle>
          <DialogDescription className="session-delete-dialog-lead">
            删除 Claude Code、Codex、Gemini 和 Grok Build
            会话前，会先把会话文件备份到 Chimera++
            数据目录。可以从这里放回原位，已存在的文件不会被覆盖。
          </DialogDescription>
        </DialogHeader>

        <div className="session-delete-dialog-body">
          {isLoading ? (
            <p className="session-backups-empty">正在读取备份…</p>
          ) : isError ? (
            <p className="session-backups-empty" role="alert">
              {extractErrorMessage(error) || "读取备份失败"}
            </p>
          ) : backups.length === 0 ? (
            <p className="session-backups-empty">还没有删除备份。</p>
          ) : (
            <ul className="session-delete-list" aria-label="删除备份">
              {backups.map((backup) => {
                const title = backupTitle(backup);
                const nothingToRestore = backup.restorableFiles === 0;
                return (
                  <li key={backup.id} className="session-backup-item">
                    <ProviderIcon
                      icon={getProviderIconName(backup.providerId)}
                      name={getProviderLabel(backup.providerId)}
                      size={16}
                    />
                    <span className="session-backup-item-text">
                      <span className="session-delete-item-title" title={title}>
                        {title}
                      </span>
                      <span className="session-delete-item-meta">
                        <span>{getProviderLabel(backup.providerId)}</span>
                        <span>{backupTime(backup)}</span>
                        <span>{formatBytes(backup.totalBytes)}</span>
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="session-backup-restore"
                      disabled={nothingToRestore || restoringId !== null}
                      aria-label={`恢复 ${title}`}
                      title={
                        nothingToRestore
                          ? "原位置已有这些文件，无需恢复"
                          : undefined
                      }
                      onClick={() => void handleRestore(backup)}
                    >
                      <RotateCcw
                        className={`size-3.5${restoringId === backup.id ? " motion-safe:animate-spin" : ""}`}
                        aria-hidden
                      />
                      {nothingToRestore ? "已在原位" : "恢复"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          <ul className="session-delete-notes">
            {includesCodex ? (
              <li>
                Codex 只恢复会话文件；下次打开会话列表时，Codex
                会根据会话文件重新建立索引。自定义的会话名称和输入历史不会恢复。
              </li>
            ) : null}
            <li>7 天内的备份都会保留，更早的每个工具只留最近 20 次。</li>
          </ul>
        </div>

        <DialogFooter className="session-delete-dialog-footer session-backups-footer">
          <Button
            variant={confirmClear ? "destructive" : "ghost"}
            disabled={backups.length === 0 || isClearing}
            onClick={() => void handleClear()}
          >
            {confirmClear ? `确认清空 ${backups.length} 份备份` : "清空备份"}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
