import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { isMac } from "@/lib/platform";
import "./WindowControls.css";

export function WindowControls({
  closeDisabled = false,
}: {
  closeDisabled?: boolean;
}) {
  const mac = isMac();
  const native = isTauri();
  const [maximizable, setMaximizable] = useState(false);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    const sync = async () => {
      try {
        const [canMaximize, isMaximized] = await Promise.all([
          win.isMaximizable(),
          win.isMaximized(),
        ]);
        if (!disposed) {
          setMaximizable(canMaximize);
          setMaximized(isMaximized);
        }
      } catch {
        /* Old desktop builds may not expose window capabilities. */
      }
    };
    void sync();
    void win
      .onResized(() => void sync())
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [native]);
  const act = async (action: "minimize" | "toggleMaximize" | "close") => {
    try {
      await getCurrentWindow()[action]();
    } catch {
      toast.error("窗口操作未完成，请重试");
    }
  };
  const controls = {
    close: { label: "关闭窗口", action: "close", icon: <X size={14} /> },
    minimize: {
      label: "最小化窗口",
      action: "minimize",
      icon: <Minus size={14} />,
    },
    maximize: {
      label: maximized ? "还原窗口" : "最大化窗口",
      action: "toggleMaximize",
      icon: maximized ? <Copy size={12} /> : <Square size={12} />,
    },
  } as const;
  const order = mac
    ? (["close", "minimize", "maximize"] as const)
    : (["minimize", "maximize", "close"] as const);
  return (
    <div
      className={
        "window-controls " +
        (mac ? "window-controls-mac" : "window-controls-windows")
      }
      data-tauri-no-drag
    >
      {order.map((key) => (
        <button
          type="button"
          key={key}
          className={"window-control-" + key}
          aria-label={controls[key].label}
          title={
            key === "close" && closeDisabled
              ? "请先保存或返回线路页面"
              : !native
                ? "仅桌面应用可用"
                : key === "maximize" && !maximizable
                  ? "当前调试包固定窗口尺寸，更新原生程序后可用"
                  : controls[key].label
          }
          disabled={
            !native ||
            (key === "close" && closeDisabled) ||
            (key === "maximize" && !maximizable)
          }
          onClick={() => void act(controls[key].action)}
        >
          {controls[key].icon}
        </button>
      ))}
    </div>
  );
}
