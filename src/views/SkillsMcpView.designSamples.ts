import type { InstalledSkill } from "@/lib/api/skills";
import type { McpServer } from "@/types";

/**
 * Browser design-preview fixtures for the Skills 与 MCP page (L07).
 *
 * Only used when the renderer runs outside Tauri with `?preview=design`, so
 * the layout can be compared with the four rows per column in the approved design.
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
  skill("code-review-checklist", "自动执行结构化代码审查与安全检查", true, [
    "studio",
    "skills",
  ]),
  skill("tauri-rust-auditor", "分析 Rust 命令权限、异步锁与路径边界", true),
  skill("docs-changelog-writer", "根据提交历史整理中英双语发布说明", false),
  skill("sql-migration-guard", "校验 SQLite 迁移脚本幂等性与只读备份", false),
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
    server("filesystem-local", "读写授权工作区内的代码与配置文件", true, {
      type: "stdio",
      command: "filesystem-local",
    }),
    server("postgres-readonly", "只读查询本地开发数据库结构与表数据", true, {
      type: "stdio",
      command: "postgres-readonly",
      env: { DATABASE_URL: "sample" },
    }),
    server("fetch-docs-mcp", "按需抓取官方文档页面并转成 Markdown", false, {
      type: "http",
      url: "https://docs.example.test/mcp",
    }),
    server(
      "git-history-inspector",
      "只读检索仓库提交图谱与文件演进记录",
      false,
      { type: "stdio", command: "git-history-inspector" },
    ),
  ].map((entry) => [entry.id, entry]),
);

export const SAMPLE_NOTES: Record<string, string> = {};
