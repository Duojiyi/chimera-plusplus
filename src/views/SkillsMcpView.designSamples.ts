import type { InstalledSkill } from "@/lib/api/skills";
import type { McpServer } from "@/types";

/**
 * Browser design-preview fixtures for the Skills 与 MCP page (L07).
 *
 * Only used when the renderer runs outside Tauri with `?preview=design`, so
 * the layout can be reviewed without a backend. Counts follow the shared fake
 * data baseline (design system §6): 6 Skills with 4 enabled, 6 MCP services
 * with 3 enabled. Writes are disabled while these are on screen.
 */
export const isSkillsDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

const apps = (codex: boolean) => ({
  claude: false,
  codex,
  gemini: false,
  grokbuild: false,
  opencode: false,
});

const DAY = 86_400;
const BASE = 1_793_000_000;

const skill = (
  id: string,
  description: string,
  enabled: boolean,
  repo?: [string, string],
  age = 10,
): InstalledSkill => ({
  id,
  name: id,
  description,
  directory: id,
  repoOwner: repo?.[0],
  repoName: repo?.[1],
  apps: apps(enabled),
  installedAt: BASE - age * DAY,
  updatedAt: BASE - age * DAY,
});

export const SAMPLE_SKILLS: InstalledSkill[] = [
  skill("commit-style", "按团队约定撰写提交说明", true, ["team", "skills"], 42),
  skill("repo-map", "生成仓库结构概览", true, ["team", "skills"], 30),
  skill("pdf-tools", "读取与拆分 PDF", true, undefined, 21),
  skill("db-inspect", "只读查看本地数据库表结构", true, undefined, 12),
  skill("legacy-notes", "旧版笔记整理规则", false, undefined, 88),
  skill("image-lab", "图片裁剪与压缩", false, ["team", "skills"], 5),
];

const server = (
  id: string,
  description: string,
  enabled: boolean,
  spec: McpServer["server"],
): McpServer => ({
  id,
  name: id,
  description,
  apps: apps(enabled),
  server: spec,
});

export const SAMPLE_MCP_SERVERS: Record<string, McpServer> = Object.fromEntries(
  [
    server("filesystem", "本地文件读写", true, {
      type: "stdio",
      command: "npx",
      env: { ALLOWED_ROOT: "sample" },
    }),
    server("github", "仓库、议题与合并请求", true, {
      type: "http",
      url: "https://api.githubcopilot.com/mcp",
      headers: { Authorization: "sample" },
    }),
    server("sqlite", "查询本地 SQLite 数据库", true, {
      type: "stdio",
      command: "uvx",
    }),
    server("browser", "驱动浏览器完成网页操作", false, {
      type: "stdio",
      command: "npx",
    }),
    server("sentry", "查看线上错误报告", false, {
      type: "http",
      url: "https://mcp.sentry.dev/sse",
    }),
    server("memory", "跨会话记住项目约定", false, {
      type: "stdio",
      command: "npx",
    }),
  ].map((entry) => [entry.id, entry]),
);

export const SAMPLE_NOTES: Record<string, string> = {
  "commit-style": "提交前自动套用",
};
