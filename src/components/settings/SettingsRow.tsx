import type { ReactNode } from "react";

/**
 * One settings row: title and explanation on the left, the control on the
 * right, a hairline between rows (design L13). Every section uses this shape so
 * the page reads as one list, whatever the control is.
 */
export function SettingsRow({
  title,
  titleId,
  description,
  descriptionId,
  children,
  className,
}: {
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  descriptionId?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={
        className
          ? `settings-reference-row ${className}`
          : "settings-reference-row"
      }
    >
      <span>
        <b id={titleId}>{title}</b>
        {description !== undefined && (
          <small id={descriptionId}>{description}</small>
        )}
      </span>
      {children !== undefined && (
        <span className="settings-row-control">{children}</span>
      )}
    </div>
  );
}

/**
 * A whole-row switch: the row itself is the `role="switch"` button, so the
 * title and explanation are its accessible name and the target is generous.
 */
export function SwitchRow({
  title,
  description,
  checked,
  disabled,
  onToggle,
}: {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="settings-reference-row settings-switch-row"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
    >
      <span>
        <b>{title}</b>
        {description && <small>{description}</small>}
      </span>
      <i className={`settings-switch ${checked ? "is-on" : ""}`}>
        <u />
      </i>
    </button>
  );
}
