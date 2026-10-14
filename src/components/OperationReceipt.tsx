import "./OperationReceipt.css";
import { useId } from "react";
import {
  CircleAlert,
  CircleCheck,
  ClipboardCopy,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";

export type ReceiptTone = "success" | "warning" | "error";

export type ReceiptAction = {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
};

/**
 * A persistent account of one operation: what happened, what to do next, and
 * the raw text behind it. Replaces toasts that vanish before they are read.
 */
export function OperationReceipt({
  tone,
  eyebrow,
  title,
  time,
  lines = [],
  notes = [],
  actions = [],
  detail,
  detailLabel = "技术详情",
  onCopy,
  onDismiss,
  className = "",
}: {
  tone: ReceiptTone;
  eyebrow?: string;
  title: string;
  time?: string;
  lines?: ReadonlyArray<string | null | undefined>;
  notes?: readonly string[];
  actions?: readonly ReceiptAction[];
  detail?: string | null;
  detailLabel?: string;
  onCopy?: () => void;
  onDismiss?: () => void;
  className?: string;
}) {
  const headingId = useId();
  const Icon =
    tone === "success"
      ? CircleCheck
      : tone === "warning"
        ? TriangleAlert
        : CircleAlert;
  const visibleLines = lines.filter((line): line is string => Boolean(line));
  return (
    <section
      className={`operation-receipt is-${tone} ${className}`.trim()}
      aria-labelledby={headingId}
    >
      <span className="operation-receipt-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <div
        className="operation-receipt-body"
        role={tone === "error" ? "alert" : "status"}
      >
        {(eyebrow || time) && (
          <p className="operation-receipt-meta">
            {[eyebrow, time].filter(Boolean).join(" · ")}
          </p>
        )}
        <h3 id={headingId}>{title}</h3>
        {visibleLines.map((line, index) => (
          <p key={`${index}-${line}`}>{line}</p>
        ))}
        {notes.length > 0 && (
          <ul>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        {(actions.length > 0 || onCopy) && (
          <div className="operation-receipt-actions">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={`${action.primary ? "primary" : "secondary"} compact`}
                onClick={action.onClick}
                disabled={action.disabled || action.busy}
                aria-busy={action.busy || undefined}
              >
                {action.busy && (
                  <LoaderCircle className="spin" size={13} aria-hidden="true" />
                )}
                {action.label}
              </button>
            ))}
            {onCopy && (
              <button
                type="button"
                className="operation-receipt-copy"
                onClick={onCopy}
              >
                <ClipboardCopy size={14} aria-hidden="true" />
                复制诊断信息
              </button>
            )}
          </div>
        )}
        {detail && (
          <details className="operation-receipt-detail">
            <summary>{detailLabel}</summary>
            <pre>{detail}</pre>
          </details>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          className="operation-receipt-dismiss"
          aria-label="关闭这条记录"
          title="关闭这条记录"
          onClick={onDismiss}
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
