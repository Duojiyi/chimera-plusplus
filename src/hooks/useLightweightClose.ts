import { useEffect, useLayoutEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { openDialogCount } from "@/hooks/useDialogFocus";

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
  const handling = useRef(false);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    const registration = listen("request-lightweight-close", async () => {
      if (disposed || handling.current) return;
      handling.current = true;
      try {
        await invoke(
          blockers.size > 0 || openDialogCount() > 0
            ? "hide_main_window"
            : "enter_lightweight_mode",
        );
      } catch (reason) {
        toast.error("关闭窗口失败", { description: String(reason) });
      } finally {
        handling.current = false;
      }
    });
    void registration.catch((reason) => {
      if (!disposed)
        toast.error("无法启用轻量关闭", { description: String(reason) });
    });
    return () => {
      disposed = true;
      void registration.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
}
