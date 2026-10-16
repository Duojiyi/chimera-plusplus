// 轻量平台检测，避免在 SSR 或无 navigator 的环境报错
export const isMac = (): boolean => {
  try {
    const ua = navigator.userAgent || "";
    const plat = (navigator.platform || "").toLowerCase();
    return /mac/i.test(ua) || plat.includes("mac");
  } catch {
    return false;
  }
};

export const isWindows = (): boolean => {
  try {
    const ua = navigator.userAgent || "";
    return /windows|win32|win64/i.test(ua);
  } catch {
    return false;
  }
};

export const isLinux = (): boolean => {
  try {
    const ua = navigator.userAgent || "";
    // WebKitGTK/Chromium 在 Linux/Wayland/X11 下 UA 通常包含 Linux 或 X11
    return (
      /linux|x11/i.test(ua) && !/android/i.test(ua) && !isMac() && !isWindows()
    );
  } catch {
    return false;
  }
};

// Linux 上禁用所有 drag region，规避 Wayland 下 gtk_window_begin_move_drag
// 相关的窗口事件异常（Tauri #13440）。Windows 只用 Tauri 的事件拖拽
// （drag.js：按下时 start_dragging，双击切换最大化），不启用原生拖拽 CSS：
// wry 为 WebView2 打开了非客户区支持，`-webkit-app-region: drag` 会让
// WebView2 每次布局后重算拖拽区域，可能持续占用主线程或卡死。macOS 保留原有
// 拖动行为。Adapted from farion1231/cc-switch 09237ebd
//
// 这些常量设计为通过 JSX 属性 spread 消费（`{...DRAG_REGION_ATTR}`），禁用时
// 完全不渲染属性，避免被拖拽脚本或 CSS 选择器识别为拖拽区域。取值 "deep"：
// drag.js 对裸属性只在按下的元素本身带属性时才拖动，"deep" 让区域里的标题
// 文字等非交互子元素也能拖动；按钮、链接、输入框等可点击元素照常拦截。
export const DRAG_REGION_ENABLED = !isLinux();

export const DRAG_REGION_ATTR: Record<string, unknown> = DRAG_REGION_ENABLED
  ? { "data-tauri-drag-region": "deep" }
  : {};

// 与 index.css 的 `.is-mac [data-tauri-drag-region]` 一致：原生拖拽 CSS 只用于 macOS。
export const DRAG_REGION_STYLE: Record<string, unknown> = isMac()
  ? { WebkitAppRegion: "drag" }
  : {};
