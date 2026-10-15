import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { DeepLinkImportRequest } from "@/lib/api/deeplink";
import { describeDeepLinkRefusal } from "@/lib/api/deeplink";
import { providersApi } from "@/lib/api/providers";
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
    // Links the backend refused wait in a buffer too (lib.rs
    // handle_deeplink_url), so one refused before this window could listen
    // (cold start, lightweight mode) is still explained. Reading clears the
    // buffer, so what was read is shown even if this effect has ended.
    const readRefusals = async () => {
      try {
        const reasons = await invoke<string[]>("take_deeplink_refusals");
        for (const reason of reasons ?? []) {
          const { title, description } = describeDeepLinkRefusal(reason);
          // The answer to a link the user just opened stays until closed:
          // a later toast (a failed startup check) must not bury it unread.
          toast.error(title, { description, duration: Infinity });
        }
      } catch {
        // Nothing to explain this round; the next refusal wakes us again.
      }
    };
    const readAll = () => {
      void refresh();
      void readRefusals();
    };
    refreshPendingRef.current = refresh;
    window.addEventListener("focus", readAll);
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
      register("deeplink-error", () => void readRefusals()),
    ])
      .then(() => {
        if (active) readAll();
      })
      .catch(() => {
        if (active) {
          toast.error("无法订阅导入请求，请重新加载应用");
          readAll();
        }
      });
    return () => {
      active = false;
      window.removeEventListener("focus", readAll);
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
            onImported={() => {
              setProviderRefreshVersion((value) => value + 1);
              // The tray lists every line, so a new import must show up there
              // too. Best effort: the import itself already succeeded.
              void providersApi.updateTrayMenu().catch(() => undefined);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
