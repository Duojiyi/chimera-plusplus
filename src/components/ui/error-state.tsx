import * as React from "react";

export interface ErrorStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** What failed, in the user's words. */
  title: string;
  /** The underlying message; shown as-is, never swallowed. */
  description?: React.ReactNode;
  icon?: React.ReactNode;
  /** Usually a retry button. */
  action?: React.ReactNode;
}

/**
 * Error state that stays on the page instead of dying in a toast.
 *
 * A failed read used to survive four seconds and leave an empty screen behind;
 * this keeps the message, the raw detail and the retry path visible for as long
 * as the failure lasts.
 */
export function ErrorState({
  title,
  description,
  icon,
  action,
  className,
  ...rest
}: ErrorStateProps) {
  return (
    <div
      className={className ? `error-state ${className}` : "error-state"}
      role="alert"
      {...rest}
    >
      {icon ? (
        <span className="error-state-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}
