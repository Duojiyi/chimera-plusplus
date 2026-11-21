import { useEffect, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { openDialogCount } from "@/hooks/useDialogFocus";

export interface LightweightCloseRequest {
  fromTray: boolean;
  mainActivation: number;
}

const blockers = new Set<symbol>();

// Each mounted page contributes its unsaved/busy state without threading props.
export function useLightweightCloseBlocker(blocked: boolean) {
  useLayoutEffect(() => {
    if (!blocked) return;
    const token = Symbol();
    blockers.add(token);
    return () => {
      blockers.delete(token);
    };
  }, [blocked]);
}

export function useLightweightClose(blocked: boolean) {
  useLightweightCloseBlocker(blocked);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    const handling = new Set<number>();
    let pendingDestruction = 0;
    let restoreInput: (() => void) | undefined;
    const resumeInput = () => {
      restoreInput?.();
      restoreInput = undefined;
    };
    const registration = listen<LightweightCloseRequest>(
      "request-lightweight-close",
      async ({ payload }) => {
        const { mainActivation } = payload;
        if (disposed || handling.has(mainActivation)) return;
        handling.add(mainActivation);
        const blocked = blockers.size > 0 || openDialogCount() > 0;
        try {
          const args = { mainActivation };
          if (blocked && payload.fromTray) {
            // An explicit toggle should explain why the window stays intact.
            await invoke("show_main_window", args);
            if (!disposed)
              toast.info("请先完成或取消主界面中的操作，再开启轻量模式");
            return;
          }
          if (blocked) {
            await invoke("hide_main_window", args);
            return;
          }
          // Prevent a new draft from opening after we approve destruction but
          // before the window worker can finish it. Native close events can
          // still request a close for a newer activation.
          if (++pendingDestruction === 1) {
            const body = document.body;
            if (!body.hasAttribute("inert")) {
              body.setAttribute("inert", "");
              restoreInput = () => body.removeAttribute("inert");
            }
          }
          try {
            await invoke("enter_lightweight_mode", args);
          } finally {
            if (--pendingDestruction === 0) resumeInput();
          }
        } catch (reason) {
          if (!disposed)
            toast.error("关闭窗口失败", { description: String(reason) });
        } finally {
          handling.delete(mainActivation);
        }
      },
    );
    void registration.catch((reason) => {
      if (!disposed)
        toast.error("无法启用轻量关闭", { description: String(reason) });
    });
    return () => {
      disposed = true;
      resumeInput();
      void registration.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
}
