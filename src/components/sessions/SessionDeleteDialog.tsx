import { useEffect, useId, useState } from "react";
import { AlertTriangle, FolderOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { SessionMeta } from "@/types";
import {
  formatSessionTitle,
  getBaseName,
  getSessionKey,
  hasSubSessions,
  isArchivedSession,
  shortSessionId,
} from "./utils";

/** More rows than this and the list stops being read; the rest is counted. */
export const DELETE_PREVIEW_LIMIT = 8;

export interface SessionDeleteTarget {
  session: SessionMeta;
  /** The content is already gone; only index cleanup is left to finish. */
  contentDeleted?: boolean;
}

interface SessionDeleteDialogProps {
  targets: SessionDeleteTarget[] | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation for a destructive delete: names what goes, says what else
 * goes with it and what cannot come back. For Codex the user confirms the
 * sessions are closed everywhere; the app can only see its own Codex window,
 * not a CLI or an editor extension, so it asks instead of claiming to know.
 */
export function SessionDeleteDialog({
  targets,
  onConfirm,
  onCancel,
}: SessionDeleteDialogProps) {
  const checkboxId = useId();
  const [closedElsewhere, setClosedElsewhere] = useState(false);

  // Every request starts unconfirmed.
  useEffect(() => {
    setClosedElsewhere(false);
  }, [targets]);

  if (!targets || targets.length === 0) return null;

  const sessions = targets.map((target) => target.session);
  const count = sessions.length;
  const cleanupOnly = targets.every((target) => target.contentDeleted);
  const includesCodex = sessions.some(
    (session) => session.providerId === "codex",
  );
  const includesSubSessions = sessions.some(hasSubSessions);
  const shown = targets.slice(0, DELETE_PREVIEW_LIMIT);
  const hidden = count - shown.length;

  const title = cleanupOnly
    ? "完成删除"
    : count > 1
      ? `删除 ${count} 个会话`
      : "删除会话";
  const confirmText = cleanupOnly
    ? "完成清理"
    : count > 1
      ? `删除 ${count} 个会话`
      : "删除会话";

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="session-delete-dialog" zIndex="alert">
        <DialogHeader className="session-delete-dialog-header">
          <DialogTitle className="session-delete-dialog-title">
            <AlertTriangle className="size-5 shrink-0" aria-hidden />
            {title}
          </DialogTitle>
          <DialogDescription className="session-delete-dialog-lead">
            {cleanupOnly
              ? "这些会话的内容已经删除，还有索引记录没有清理干净。"
              : "以下本地会话记录将被永久删除，删除后无法恢复。"}
          </DialogDescription>
        </DialogHeader>

        <div className="session-delete-dialog-body">
          <ul className="session-delete-list" aria-label="将删除的会话">
            {shown.map(({ session }) => {
              const sessionTitle = formatSessionTitle(session);
              const folder = getBaseName(session.projectDir);
              return (
                <li
                  key={getSessionKey(session)}
                  className="session-delete-item"
                >
                  <span
                    className="session-delete-item-title"
                    title={sessionTitle}
                  >
                    {sessionTitle}
                  </span>
                  <span className="session-delete-item-meta">
                    <code title={session.sessionId}>
                      {shortSessionId(session.sessionId)}
                    </code>
                    {folder ? (
                      <span
                        className="session-delete-item-folder"
                        title={session.projectDir ?? undefined}
                      >
                        <FolderOpen className="size-3 shrink-0" aria-hidden />
                        <span>{folder}</span>
                      </span>
                    ) : null}
                    {isArchivedSession(session) ? (
                      <span className="session-tag">已归档</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {hidden > 0 ? (
            <p className="session-delete-more">另有 {hidden} 条</p>
          ) : null}

          <ul className="session-delete-notes">
            {includesSubSessions && !cleanupOnly ? (
              <li>由这些会话派生的子会话会一并删除。</li>
            ) : null}
            {includesCodex ? (
              <li>
                这些会话在 Codex 输入历史（按 ↑ 键回看的记录）里的内容也会清除。
              </li>
            ) : null}
            {includesCodex ? (
              <li>
                删除前会把会话文件和 Codex 索引数据库备份到 Chimera++ 数据目录的
                backups\codex-session-delete，只保留最近 20 次。
              </li>
            ) : null}
          </ul>

          {includesCodex ? (
            <label htmlFor={checkboxId} className="session-delete-ack">
              <Checkbox
                id={checkboxId}
                checked={closedElsewhere}
                onCheckedChange={(value) => setClosedElsewhere(value === true)}
              />
              <span>
                我已关闭正在使用这些会话的 Codex 窗口、CLI 或 VS Code 扩展
              </span>
            </label>
          ) : null}
        </div>

        <DialogFooter className="session-delete-dialog-footer">
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={includesCodex && !closedElsewhere}
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
