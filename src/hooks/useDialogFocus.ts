import { useEffect, useLayoutEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Open dialogs, bottom to top. Every enabled `useDialogFocus` instance
 * registers itself here; only the entry on top reacts to Escape and traps Tab,
 * so a model picker stacked over the provider editor closes alone instead of
 * taking the editor (and its unsaved input) with it.
 */
const dialogStack: symbol[] = [];

export function isTopmostDialog(token: symbol): boolean {
  return (
    dialogStack.length > 0 && dialogStack[dialogStack.length - 1] === token
  );
}

export function openDialogCount(): number {
  return dialogStack.length;
}

/**
 * Registers a modal surface (such as Radix `<Dialog>` content or a
 * `<FullScreenPanel>`) in the shared open-dialog stack while mounted/open so
 * global shortcuts (`Ctrl+K`) and lightweight-close guards do not fire underneath.
 */
export function useRegisterOpenDialog(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    const token = Symbol("registered-dialog");
    dialogStack.push(token);
    return () => {
      const index = dialogStack.lastIndexOf(token);
      if (index !== -1) dialogStack.splice(index, 1);
    };
  }, [active]);
}

export function useDialogFocus<T extends HTMLElement>(
  onClose: () => void,
  enabled = true,
  returnFocusRef?: { current: HTMLElement | null },
) {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!enabled) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const token = Symbol("dialog");
    dialogStack.push(token);
    const isVisibleFocusable = (element: HTMLElement, hasLayout: boolean) => {
      if (
        element.hidden ||
        element.closest("[hidden], [aria-hidden='true']") !== null ||
        element.style.display === "none" ||
        element.style.visibility === "hidden"
      ) {
        return false;
      }
      return !hasLayout || element.offsetParent !== null;
    };
    const getVisibleFocusable = () => {
      const hasLayout = dialog.offsetParent !== null;
      return Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => isVisibleFocusable(element, hasLayout));
    };
    const focusFirst = () => {
      const hasLayout = dialog.offsetParent !== null;
      const preferred = dialog.querySelector<HTMLElement>("[data-autofocus]");
      const visiblePreferred =
        preferred && isVisibleFocusable(preferred, hasLayout)
          ? preferred
          : null;
      const first = getVisibleFocusable()[0] ?? null;
      (visiblePreferred ?? first ?? dialog).focus();
    };
    const focusFrame = requestAnimationFrame(focusFirst);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostDialog(token)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getVisibleFocusable();
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!active || !dialog.contains(active) || active === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      const index = dialogStack.lastIndexOf(token);
      if (index !== -1) dialogStack.splice(index, 1);
      if (enabled) {
        const returnTarget = returnFocusRef?.current ?? previousFocus;
        if (returnTarget?.isConnected) returnTarget.focus();
      }
    };
  }, [enabled, returnFocusRef]);
  return dialogRef;
}
