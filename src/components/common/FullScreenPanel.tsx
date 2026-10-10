import React from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE } from "@/lib/platform";
import { isTextEditableTarget } from "@/utils/domUtils";
import { cn } from "@/lib/utils";

interface FullScreenPanelProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  editorHeader?: React.ReactNode;
  /**
   * 覆盖内容区滚动容器的内边距/间距类。默认 `px-6 py-6 space-y-6`。
   * 通过 `cn`(twMerge) 合并，传入如 `pt-3` 只覆盖顶部内边距，其余保持默认。
   */
  contentClassName?: string;
}

const HEADER_HEIGHT = 64; // px - match App.tsx

/**
 * Reusable full-screen panel component
 * Handles portal rendering, header with back button, and footer
 * Uses solid theme colors without transparency
 */
export const FullScreenPanel: React.FC<FullScreenPanelProps> = ({
  isOpen,
  title,
  onClose,
  children,
  footer,
  contentClassName,
  editorHeader,
}) => {
  const { t } = useTranslation();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement;
    // Native inert excludes covered controls from both tab order and accessibility
    // APIs, while the shell's real window controls remain usable above the panel.
    const covered = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".chimera-shell > aside, .chimera-content, [data-fullscreen-panel]",
      ),
    ).filter(
      (node) => node !== panelRef.current && !node.contains(panelRef.current),
    );
    const states = covered.map((node) => [node, node.inert] as const);
    covered.forEach((node) => {
      node.inert = true;
    });
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      states.forEach(([node, inert]) => {
        node.inert = inert;
      });
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [isOpen]);
  React.useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  // ESC 键关闭面板
  const onCloseRef = React.useRef(onClose);

  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 子组件（例如 Radix 的 Select/Dialog/Dropdown）如果已经消费了 ESC，就不要再关闭整个面板
        if (event.defaultPrevented) {
          return;
        }

        if (isTextEditableTarget(event.target)) {
          return; // 让输入框自己处理 ESC（比如清空、失焦等）
        }

        event.stopPropagation(); // 阻止事件继续冒泡到 window，避免触发 App.tsx 的全局监听
        onCloseRef.current();
      }
    };

    // 使用冒泡阶段监听，让子组件（如 Radix UI）优先处理 ESC
    window.addEventListener("keydown", handleKeyDown, false);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, false);
    };
  }, [isOpen]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={panelRef}
          data-fullscreen-panel
          role="dialog"
          aria-labelledby={editorHeader ? undefined : titleId}
          aria-label={editorHeader ? title : undefined}
          tabIndex={-1}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className={cn(
            "fixed inset-x-0 bottom-0 top-10 z-[60] flex min-h-0 flex-col",
            editorHeader && "provider-editor-page",
          )}
          style={{ backgroundColor: "hsl(var(--background))" }}
        >
          {editorHeader ? (
            <section className="provider-editor">
              <header className="editor-page-header">{editorHeader}</header>
              <div className="editor-scroll">{children}</div>
              {footer && (
                <div className="editor-bottom">
                  <footer>{footer}</footer>
                </div>
              )}
            </section>
          ) : (
            <>
              {/* Keep the shell title bar and native window controls reachable. */}
              {/* Header - match App.tsx */}
              <div
                className="flex-shrink-0 flex items-center"
                {...DRAG_REGION_ATTR}
                style={
                  {
                    ...DRAG_REGION_STYLE,
                    backgroundColor: "hsl(var(--background))",
                    height: HEADER_HEIGHT,
                  } as React.CSSProperties
                }
              >
                <div
                  className="px-6 w-full flex items-center gap-4"
                  {...DRAG_REGION_ATTR}
                  style={{ ...DRAG_REGION_STYLE } as React.CSSProperties}
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t("common.back", { defaultValue: "返回" })}
                    onClick={onClose}
                    className="rounded-lg select-none"
                    style={
                      { WebkitAppRegion: "no-drag" } as React.CSSProperties
                    }
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <h2
                    id={titleId}
                    className="text-lg font-semibold text-foreground select-none"
                  >
                    {title}
                  </h2>
                </div>
              </div>

              {/* Content */}
              <div className="min-h-0 flex-1 overflow-y-auto scroll-overlay">
                <div
                  className={cn("px-6 py-6 space-y-6 w-full", contentClassName)}
                >
                  {children}
                </div>
              </div>

              {/* Footer */}
              {footer && (
                <div
                  className="flex-shrink-0 py-4 border-t border-border-default"
                  style={{ backgroundColor: "hsl(var(--background))" }}
                >
                  <div className="px-6 flex items-center justify-end gap-3">
                    {footer}
                  </div>
                </div>
              )}
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    (editorHeader && document.querySelector(".chimera-shell")) || document.body,
  );
};
