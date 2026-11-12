import type { ConfigHealthReport } from "@/lib/api/configHealth";

/**
 * Browser design-preview fixture for the 配置体检 page (L11).
 *
 * Only used when the renderer runs outside Tauri with `?preview=design`, so
 * the layout can be reviewed without a backend. Every issue below is one the
 * real checker can report (same titles, files and wording); nothing is
 * invented. Recheck and repair stay disabled while this is on screen.
 */
export const isConfigHealthDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

export const configHealthSampleReport = (
  now = Date.now(),
): ConfigHealthReport => ({
  checkedAt: new Date(now - 4 * 60_000).toISOString(),
  readOnly: true,
  repairToken: "design-preview",
  issues: [
    {
      id: "file-ref-missing-0",
      severity: "critical",
      title: "引用的文件不存在",
      location: "config.toml",
      line: 3,
      column: 1,
      field: "model_instructions_file",
      impact: "Codex 找不到指令文件时会拒绝启动。",
      solution:
        "确认路径是否正确；不再需要时删除这一行。Chimera++ 自有的失效引用可用「修复自有引用」清理。",
      repairable: true,
    },
    {
      id: "deepseek-ws-1",
      severity: "warning",
      title: "DeepSeek WebSocket 设置需检查",
      location: "config.toml",
      line: 18,
      column: 1,
      field: "supports_websockets",
      impact: "DeepSeek 官方接口应使用 HTTP 连接。",
      solution: "删除 supports_websockets 这一行，或把它设为 false。",
      repairable: false,
    },
    {
      id: "tui-prompt-2",
      severity: "warning",
      title: "旧版提示词设置不会生效",
      location: "config.toml",
      line: 31,
      column: 1,
      field: "model_instructions_file",
      impact:
        "Codex 只在顶层读取 model_instructions_file，写在 [tui] 下会被忽略。",
      solution: "把这一行移到 config.toml 顶部（任何 [表头] 之前），或删除它。",
      repairable: false,
    },
    {
      id: "auth-missing-3",
      severity: "warning",
      title: "未发现登录配置",
      location: "auth.json",
      impact: "使用环境变量认证时可以没有此文件；官方账户可通过登录流程创建。",
      solution: "登录官方账号后会自动生成；使用 API 密钥的线路不需要它。",
      repairable: false,
    },
  ],
});
