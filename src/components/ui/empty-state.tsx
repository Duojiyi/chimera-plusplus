import * as React from "react";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Short, concrete headline. Say what is missing, not "暂无数据". */
  title: string;
  /** One or two sentences that tell the user what to do next. */
  description?: React.ReactNode;
  /** Lucide-style icon element, rendered inside a soft round plate. */
  icon?: React.ReactNode;
  /** The single next action for this state. */
  action?: React.ReactNode;
}

/**
 * Empty state for a page or a section that has no content yet.
 *
 * Kept deliberately plain: a round icon plate, a headline, a sentence and at
 * most one action. It renders in the page flow (not centred in a giant box),
 * so a short list never leaves a hole in the layout.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div
      className={className ? `empty-state ${className}` : "empty-state"}
      {...rest}
    >
      {icon ? (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}
