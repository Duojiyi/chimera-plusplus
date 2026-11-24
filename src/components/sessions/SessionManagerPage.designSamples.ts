/**
 * Browser design-preview fixtures for the 会话 page (L12).
 *
 * Only used when the renderer runs outside Tauri with `?preview=design`, so the
 * layout can be reviewed without a backend. Real sessions always come from
 * `sessionsApi`; nothing here is written anywhere.
 */
import type { SessionMessage, SessionMeta } from "@/types";

export const isSessionsDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

const now = Date.now();
const minutes = (value: number) => now - value * 60_000;

const codex = (
  id: string,
  title: string,
  projectDir: string,
  ageMinutes: number,
): SessionMeta => ({
  providerId: "codex",
  sessionId: id,
  title,
  projectDir,
  createdAt: minutes(ageMinutes + 72),
  lastActiveAt: minutes(ageMinutes),
  sourcePath: `~/.codex/sessions/2026/11/10/rollout-${id}.jsonl`,
  resumeCommand: `codex resume ${id}`,
});

export const SESSIONS_DESIGN_SAMPLE: SessionMeta[] = [
  codex(
    "thr_7f3a91",
    "优化 Tauri 托盘液态玻璃与多平面架构",
    "D:/Desktop/chimera-plusplus",
    3,
  ),
  codex(
    "thr_52c0de",
    "双盲审计 Rust 后端配置读写锁边界",
    "D:/Desktop/chimera-plusplus",
    900,
  ),
  codex(
    "thr_19aa40",
    "修复 MCP 服务配置同步与备份恢复",
    "D:/Desktop/chimera-plusplus",
    4000,
  ),
  {
    providerId: "claude",
    sessionId: "c8a1f0e2",
    title: "排查深色皮肤高对比度 Token 映射",
    projectDir: "D:/Desktop/agent-toolkit",
    createdAt: minutes(5800),
    lastActiveAt: minutes(5720),
    sourcePath: "~/.claude/projects/agent-toolkit/c8a1f0e2.jsonl",
    resumeCommand: "claude --resume c8a1f0e2",
  },
];

export const SESSION_MESSAGES_DESIGN_SAMPLE: SessionMessage[] = [
  {
    role: "user",
    content:
      "请针对 Windows 平台重构托盘窗口的多平面液态玻璃反射（Liquid Specular）。我们需要在浅色 Daylight 背景下保持层级清晰，避免文字折行堆叠，并确保阴影与边框光圈在 125% 和 150% DPI 缩放下不产生锯齿。",
    ts: minutes(5),
  },
  {
    role: "assistant",
    content: [
      "已完成液态玻璃多平面架构重构。针对 Windows Desktop 浅色背板环境，调整了三阶高斯模糊与内描边高光（Specular Inset）。",
      "```css",
      "/* 液态高光与分层双内阴影 */",
      "--glass-plane-base: rgba(245, 248, 252, 0.94);",
      "--glass-specular-edge: 0 0 0 1px rgba(255, 255, 255, 0.85) inset;",
      "--glass-subtle-outline: 0 0 0 1px rgba(160, 175, 195, 0.35);",
      "```",
      "主次信息栏采用自适应排版。当前激活会话与关键操作沿用深石油绿。",
    ].join("\n"),
    ts: minutes(4),
  },
];
