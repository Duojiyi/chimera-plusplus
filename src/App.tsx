import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { DeepLinkImportRequest } from "@/lib/api/deeplink";
import ChimeraApp from "./ChimeraApp";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";

const DeepLinkImportDialog = lazy(() =>
  import("./components/DeepLinkImportDialog").then((module) => ({
    default: module.DeepLinkImportDialog,
  })),
);

type PendingDeepLink = { id: string; request: DeepLinkImportRequest };

export default function App() {
  const [pending, setPending] = useState<PendingDeepLink | null>(null);
  const [providerRefreshVersion, setProviderRefreshVersion] = useState(0);
  const refreshPendingRef = useRef<() => Promise<void>>(async () => {});
  useLightweightCloseBlocker(Boolean(pending));

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true;
    let sequence = 0;
    const disposers: Array<() => void> = [];
    const refresh = async () => {
      const seq = ++sequence;
      try {
        const next = await invoke<PendingDeepLink | null>(
          "get_pending_deeplink",
        );
        if (active && seq === sequence) {
          setPending((current) => (current?.id === next?.id ? current : next));
        }
      } catch {
        if (active && seq === sequence) toast.error("无法读取待确认的导入请求");
      }
    };
    refreshPendingRef.current = refresh;
    window.addEventListener("focus", refresh);
    const register = async (event: string, handler: () => void) => {
      const dispose = await listen(event, () => {
        if (active) handler();
      });
      if (active) disposers.push(dispose);
      else dispose();
    };
    // Subscribe before reading. The queue owns the payload until confirmation
    // or cancellation, so duplicate notifications and StrictMode cannot lose it.
    void Promise.all([
      register("deeplink-import", () => void refresh()),
      register("deeplink-error", () =>
        toast.error("无法处理导入链接，请检查链接或待处理请求数量"),
      ),
    ])
      .then(() => {
        if (active) void refresh();
      })
      .catch(() => {
        if (active) {
          toast.error("无法订阅导入请求，请重新加载应用");
          void refresh();
        }
      });
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      refreshPendingRef.current = async () => {};
      disposers.forEach((dispose) => dispose());
    };
  }, []);

  return (
    <>
      <ChimeraApp providerRefreshVersion={providerRefreshVersion} />
      {pending && (
        <Suspense fallback={null}>
          <DeepLinkImportDialog
            key={pending.id}
            request={pending.request}
            onHandled={async () => {
              await invoke("dismiss_pending_deeplink", { id: pending.id });
              setPending((current) =>
                current?.id === pending.id ? null : current,
              );
              await refreshPendingRef.current();
            }}
            onProviderImported={(app) => {
              if (app === "codex")
                setProviderRefreshVersion((value) => value + 1);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
