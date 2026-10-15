import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { DeepLinkImportRequest } from "@/lib/api/deeplink";
import { providersApi } from "@/lib/api/providers";
import ChimeraApp from "./ChimeraApp";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";

const DeepLinkImportDialog = lazy(() =>
  import("./components/DeepLinkImportDialog").then((module) => ({
    default: module.DeepLinkImportDialog,
  })),
);

type PendingDeepLink = { id: string; request: DeepLinkImportRequest };

/**
 * A link the backend refused before queueing it (lib.rs handle_deeplink_url).
 * The payload names the reason, never the link: it may carry a key.
 */
function showDeepLinkError(payload: unknown) {
  const reason =
    payload &&
    typeof payload === "object" &&
    typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : "";
  if (reason === "DEEP_LINK_PARSE_FAILED") {
    toast.error("无法识别这个导入链接", {
      description: "链接可能不完整，或用于 Chimera++ 不支持的工具或资源。",
    });
  } else if (reason === "DEEP_LINK_QUEUE_FULL") {
    toast.error("待确认的导入太多", {
      description: "请先处理已打开的导入确认，再重新打开这个链接。",
    });
  } else if (reason.includes("multi_tool")) {
    toast.error("无法导入这个链接", {
      description: "链接要导入到的工具在当前版本不可用。",
    });
  } else {
    toast.error("无法处理导入链接", {
      description: "请稍后重新打开这个链接。",
    });
  }
}

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
    const register = async (
      event: string,
      handler: (payload: unknown) => void,
    ) => {
      const dispose = await listen(event, (received) => {
        if (active) handler(received?.payload);
      });
      if (active) disposers.push(dispose);
      else dispose();
    };
    // Subscribe before reading. The queue owns the payload until confirmation
    // or cancellation, so duplicate notifications and StrictMode cannot lose it.
    void Promise.all([
      register("deeplink-import", () => void refresh()),
      register("deeplink-error", showDeepLinkError),
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
