import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useDialogFocus } from "@/hooks/useDialogFocus";

export interface AlertConfirmDialogProps {
  titleId: string;
  title: ReactNode;
  icon?: ReactNode;
  facts?: ReactNode;
  description: ReactNode;
  cancelLabel?: ReactNode;
  confirmLabel: ReactNode;
  confirmTone?: "primary" | "danger";
  acknowledgement?: string;
  autoFocusCancel?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function AlertConfirmDialog({
  titleId,
  title,
  icon,
  facts,
  description,
  cancelLabel = "取消",
  confirmLabel,
  confirmTone = "primary",
  acknowledgement,
  autoFocusCancel = false,
  busy = false,
  onCancel,
  onConfirm,
}: AlertConfirmDialogProps) {
  const dialogRef = useDialogFocus<HTMLElement>(() => {
    if (!busy) onCancel();
  }, true);
  const [acknowledged, setAcknowledged] = useState(false);
  const descriptionId = `${titleId}-desc`;
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className={`confirm-dialog${acknowledgement ? " confirm-guarded" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        {icon}
        <h2 id={titleId}>{title}</h2>
        {acknowledgement && (
          <button
            className="confirm-close icon-button"
            aria-label="关闭确认窗口"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            <X size={18} />
          </button>
        )}
        {facts ? <p className="confirm-facts">{facts}</p> : null}
        <p id={descriptionId}>{description}</p>
        {acknowledgement && (
          <label className="confirm-acknowledgement">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.currentTarget.checked)}
            />
            {acknowledgement}
          </label>
        )}
        <footer>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy ? true : undefined}
            data-autofocus={autoFocusCancel ? true : undefined}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={confirmTone}
            disabled={busy || Boolean(acknowledgement && !acknowledged)}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
