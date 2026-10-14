import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";
import "./help-tip.css";

/**
 * Explanation card behind a small "?" next to the term it explains.
 *
 * - Opens after 300 ms of hover and closes 200 ms after the pointer leaves
 *   (moving into the card keeps it open). Keyboard focus opens it at once;
 *   pointer focus does not, so clicking inside a dialog never pops it.
 * - Click pins it; Escape or a click elsewhere closes it. It never takes
 *   focus (non-modal) and contains no controls or links.
 * - Only rules and terminology go here. Consequences such as restarts,
 *   routing changes or data loss stay visible on the page, the button,
 *   the confirmation or the toast.
 */

const OPEN_DELAY = 300;
const CLOSE_DELAY = 200;

function isKeyboardFocus(element: HTMLElement) {
  try {
    return element.matches(":focus-visible");
  } catch {
    // Engines without :focus-visible support: treat focus as keyboard focus.
    return true;
  }
}

function useHoverCard() {
  const [open, setOpen] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);

  const clear = React.useCallback(() => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  React.useEffect(() => clear, [clear]);

  const schedule = (next: boolean, delay: number) => {
    clear();
    timer.current = window.setTimeout(() => setOpen(next), delay);
  };

  return {
    open: open || pinned,
    onPointerEnter: () => {
      if (!pinned) schedule(true, OPEN_DELAY);
    },
    onPointerLeave: () => {
      if (!pinned) schedule(false, CLOSE_DELAY);
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (!isKeyboardFocus(event.currentTarget)) return;
      clear();
      setOpen(true);
    },
    onBlur: () => {
      if (pinned) return;
      clear();
      setOpen(false);
    },
    onClick: () => {
      clear();
      setPinned((value) => !value);
      setOpen(true);
    },
    onOpenChange: (next: boolean) => {
      if (next) return;
      clear();
      setPinned(false);
      setOpen(false);
    },
  };
}

interface HelpCardProps {
  id: string;
  title?: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "end";
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

function HelpCard({
  id,
  title,
  children,
  side = "bottom",
  align = "start",
  onPointerEnter,
  onPointerLeave,
}: HelpCardProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        id={id}
        role="tooltip"
        side={side}
        align={align}
        sideOffset={6}
        alignOffset={-8}
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        className="help-card"
      >
        {title ? <span className="help-card-title">{title}</span> : null}
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

export interface HelpTipProps {
  /** Card title and the accessible name of the "?" button. */
  title: string;
  /** One sentence, at most about 80 characters. */
  children: React.ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "end";
  className?: string;
}

/** The "?" button placed right after the explained label. */
export function HelpTip({
  title,
  children,
  side,
  align,
  className,
}: HelpTipProps) {
  const id = React.useId();
  const descId = `${id}-desc`;
  const hover = useHoverCard();

  return (
    <PopoverPrimitive.Root open={hover.open} onOpenChange={hover.onOpenChange}>
      {/* The card mounts only while open; screen readers read this copy. */}
      <span id={descId} className="sr-only">
        {children}
      </span>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={title}
          aria-describedby={descId}
          onPointerEnter={hover.onPointerEnter}
          onPointerLeave={hover.onPointerLeave}
          onFocus={hover.onFocus}
          onBlur={hover.onBlur}
          onClick={(event) => {
            event.preventDefault();
            hover.onClick();
          }}
          className={cn("help-tip-trigger", className)}
        >
          <CircleHelp aria-hidden="true" strokeWidth={1.75} />
        </button>
      </PopoverPrimitive.Trigger>
      <HelpCard
        id={id}
        title={title}
        side={side}
        align={align}
        onPointerEnter={hover.onPointerEnter}
        onPointerLeave={hover.onPointerLeave}
      >
        {children}
      </HelpCard>
    </PopoverPrimitive.Root>
  );
}

export interface DisabledReasonProps {
  /** Why the control cannot be used. Without a reason the child renders unchanged. */
  reason?: React.ReactNode;
  /**
   * A single button. With a reason it becomes aria-disabled instead of
   * natively disabled, so it still receives hover and keyboard focus and can
   * explain itself; clicks are ignored.
   */
  children: React.ReactElement<{
    onClick?: React.MouseEventHandler;
    "aria-disabled"?: boolean | "true" | "false";
    "aria-describedby"?: string;
    disabled?: boolean;
    className?: string;
  }>;
  side?: "top" | "bottom";
  align?: "start" | "end";
}

/**
 * Shows why a button is unavailable when it is hovered or focused. Inside
 * menus, dialogs and drawers write the reason as a visible second line
 * instead of using this component.
 */
export function DisabledReason({
  reason,
  children,
  side,
  align,
}: DisabledReasonProps) {
  const id = React.useId();
  const descId = `${id}-desc`;
  const hover = useHoverCard();

  if (!reason) return children;

  const button = React.cloneElement(children, {
    disabled: false,
    "aria-disabled": "true",
    "aria-describedby": descId,
    onClick: (event: React.MouseEvent) => {
      event.preventDefault();
      hover.onClick();
    },
    className: cn(children.props.className, "is-reason-disabled"),
  });

  return (
    <PopoverPrimitive.Root open={hover.open} onOpenChange={hover.onOpenChange}>
      <PopoverPrimitive.Anchor asChild>
        <span
          className="disabled-reason-anchor"
          onPointerEnter={hover.onPointerEnter}
          onPointerLeave={hover.onPointerLeave}
          onFocus={hover.onFocus}
          onBlur={hover.onBlur}
        >
          {button}
          <span id={descId} className="sr-only">
            {reason}
          </span>
        </span>
      </PopoverPrimitive.Anchor>
      <HelpCard
        id={id}
        side={side}
        align={align}
        onPointerEnter={hover.onPointerEnter}
        onPointerLeave={hover.onPointerLeave}
      >
        {reason}
      </HelpCard>
    </PopoverPrimitive.Root>
  );
}
