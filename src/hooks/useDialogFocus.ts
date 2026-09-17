import { useEffect, useRef } from "react";

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
    const focusFirst = () => {
      const preferred = dialog.querySelector<HTMLElement>("[data-autofocus]");
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (preferred ?? first ?? dialog).focus();
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
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
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
