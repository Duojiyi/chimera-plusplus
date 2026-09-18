import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, X } from "lucide-react";
import { isMac } from "@/lib/platform";

/**
 * 标题栏窗口按钮。
 *
 * macOS 与 Windows 的窗口按钮惯例完全相反，所以这里按平台分两套：
 * - macOS：左上角红黄绿「交通灯」，顺序为关闭、最小化、缩放，图标只在悬停时
 *   显现。窗口不可缩放（`resizable: false`），因此第三颗灯按系统对不可缩放窗口
 *   的表现渲染为禁用态，而不是直接抹掉——只有两颗灯的 macOS 窗口更像是坏了。
 * - Windows：保持现状（右上角，最小化在前、关闭在后）。
 *
 * 平台判定用 `is-mac` body class 驱动 CSS 定位（见 main.tsx），DOM 顺序在这里
 * 决定，两者必须一致：CSS 按 DOM 顺序从左到右排列，顺序错了会把关闭按钮放到
 * 用户以为是最小化的位置，键盘 Tab 顺序也会与视觉顺序不符。
 */
export function WindowControls({
  closeDisabled = false,
}: {
  closeDisabled?: boolean;
}) {
  const mac = isMac();

  const minimizeButton = (
    <button
      key="minimize"
      className="is-minimize"
      aria-label="最小化 Chimera++"
      title="最小化"
      onClick={() => void getCurrentWindow().minimize()}
    >
      <Minus size={mac ? 10 : 17} strokeWidth={mac ? 2.5 : 2} />
    </button>
  );

  const closeButton = (
    <button
      key="close"
      className="is-close"
      aria-label="关闭 Chimera++"
      title={closeDisabled ? "请先保存或返回线路页面" : "关闭"}
      disabled={closeDisabled}
      onClick={() => void getCurrentWindow().close()}
    >
      <X size={mac ? 10 : 16} strokeWidth={mac ? 2.5 : 2} />
    </button>
  );

  if (!mac) {
    return (
      <div className="window-dots">
        {minimizeButton}
        {closeButton}
      </div>
    );
  }

  return (
    <div className="window-dots is-traffic-lights">
      {closeButton}
      {minimizeButton}
      {/* 窗口固定尺寸，对应系统里不可缩放窗口的置灰绿灯。 */}
      <button
        className="is-zoom"
        aria-label="缩放不可用（窗口尺寸固定）"
        title="此窗口尺寸固定"
        disabled
        aria-disabled="true"
      />
    </div>
  );
}
