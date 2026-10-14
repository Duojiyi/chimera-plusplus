import type { CodexPromptStatus } from "@/lib/api/prompts";

export type StatusAction = "rewrite" | "resolve" | "open-folder" | "retry";

export interface CodexStatusView {
  tone: "ok" | "warning";
  tag: string;
  headline: string;
  detail?: string;
  /** The one action that fixes this state. */
  action?: { kind: StatusAction; label: string };
  /** Label for the standing "查看当前指令" link when the drawer is the fix. */
  fileLink?: string;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Summary-card copy for the file Codex actually reads; null = nothing enabled, nothing wrong. */
export function codexStatusView(
  status: CodexPromptStatus,
): CodexStatusView | null {
  const count = status.enabledCount;
  switch (status.state) {
    case "in_sync":
      if (count === 0) return null;
      return {
        tone: "ok",
        tag: "已生效",
        headline: `已写入 AGENTS.md · ${count} 条${
          status.managedBytes === undefined
            ? ""
            : ` · ${formatBytes(status.managedBytes)}`
        }`,
      };
    case "missing":
      return {
        tone: "warning",
        tag: "区块缺失",
        headline: `已启用 ${count} 条，但 AGENTS.md 中没有 Chimera 区块`,
        detail:
          "Codex 读不到这些提示词。重新写入会把它们追加到文件末尾，写入前自动备份，你的内容不变。",
        action: { kind: "rewrite", label: "重新写入" },
      };
    case "edited":
      return {
        tone: "warning",
        tag: "已手动修改",
        headline: "AGENTS.md 中的 Chimera 区块被手动修改过",
        detail:
          "选择保留哪一份之前，启用和停用不会写入文件，以免覆盖你的修改。",
        action: { kind: "resolve", label: "处理修改" },
      };
    case "malformed":
      return {
        tone: "warning",
        tag: "标记损坏",
        headline: "AGENTS.md 中的区块标记不完整或重复",
        detail:
          "修好标记之前无法写入。打开当前指令找到出错的标记，修改后刷新。",
      };
    case "foreign":
      return {
        tone: "warning",
        tag: "其他工具的区块",
        headline: "AGENTS.md 中有其他工具写入的区块",
        detail: "Chimera++ 不会改动它。确认后可以接管为提示词库中的一条。",
        fileLink: "查看与接管",
      };
    case "overridden":
      return {
        tone: "warning",
        tag: "被覆盖",
        headline: "Codex 正在使用 AGENTS.override.md",
        detail: `该文件不为空时，Codex 不读取 AGENTS.md，${
          count > 0 ? `已启用的 ${count} 条` : "其中的指令"
        }暂不生效。清空或删除 AGENTS.override.md 后恢复。`,
        action: { kind: "open-folder", label: "打开所在文件夹" },
      };
    case "linked":
      return {
        tone: "warning",
        tag: "链接文件",
        headline: "AGENTS.md 是链接文件，Chimera++ 只读不写",
        detail:
          "启用和停用已暂停。请到链接指向的原文件中修改，或改用普通文件。",
        action: { kind: "open-folder", label: "打开所在文件夹" },
      };
    case "unreadable":
      return {
        tone: "warning",
        tag: "无法读取",
        headline: "无法读取 AGENTS.md",
        detail: "请检查文件权限，或确认它不是文件夹。",
        action: { kind: "retry", label: "重试" },
      };
  }
}
