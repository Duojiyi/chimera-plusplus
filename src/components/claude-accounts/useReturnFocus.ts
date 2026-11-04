import { useEffect, useRef } from "react";

/**
 * Gives keyboard focus back to the control a dialog was opened from.
 *
 * The dialogs here are controlled, with no `DialogTrigger`, so Radix has
 * nothing to return focus to and it falls to the page. This remembers the
 * last control focused outside any dialog (for a menu item, the button that
 * opened the menu) and focuses it again once `open` turns false.
 */
export function useReturnFocus(open: boolean) {
  const last = useRef<HTMLElement | null>(null);
  const target = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const element = event.target;
      if (!(element instanceof HTMLElement)) return;
      if (element.closest('[role="dialog"], [role="alertdialog"]')) return;
      const menu = element.closest('[role="menu"]');
      const opener = menu?.getAttribute("aria-labelledby");
      last.current =
        (opener ? document.getElementById(opener) : null) ?? element;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);

  useEffect(() => {
    if (open && !wasOpen.current) target.current = last.current;
    if (!open && wasOpen.current) {
      const element = target.current;
      target.current = null;
      if (element?.isConnected)
        window.requestAnimationFrame(() => element.focus());
    }
    wasOpen.current = open;
  }, [open]);
}
