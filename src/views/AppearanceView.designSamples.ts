/**
 * Browser design-preview fixtures for the 外观 page (L10).
 *
 * Only used when the renderer runs outside Tauri with `?preview=design`, so the
 * layout can be reviewed without a backend. Every write on the page stays
 * disabled while these are on screen; real skins come from `list_skin_catalog`.
 */
export const isAppearanceDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

export const APPEARANCE_DESIGN_SAMPLE = [
  {
    id: "aperture",
    name: "Aperture",
    description: "冷灰侧栏与石墨绿强调色，代码区保持高对比。",
    version: "1.4.0",
    author: "Wangnov",
    appearance: "dual",
    preview: "",
    installed: true,
    applied: true,
  },
  {
    id: "graphite",
    name: "Graphite",
    description: "低饱和深色，适合长时间阅读日志。",
    version: "2.0.1",
    author: "内置",
    appearance: "dark",
    preview: "",
    installed: true,
    applied: false,
  },
  {
    id: "paper",
    name: "Paper",
    description: "纸张底色与细线分隔，浅色环境更柔和。",
    version: "1.1.0",
    author: "内置",
    appearance: "light",
    preview: "",
    installed: true,
    applied: false,
  },
  {
    id: "terminal",
    name: "Terminal",
    description: "终端绿与等宽字体，信息密度更高。",
    version: "0.9.2",
    author: "社区",
    appearance: "dark",
    preview: "",
    installed: false,
    applied: false,
  },
  {
    id: "ember",
    name: "Ember",
    description: "暖棕色调，降低夜间蓝光。",
    version: "1.0.3",
    author: "社区",
    appearance: "dark",
    preview: "",
    installed: false,
    applied: false,
  },
] as const;
