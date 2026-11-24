import type { Prompt, PromptCategory } from "@/lib/api/prompts";

/** Read-only examples from the v5.2 prompt library. */
export const isPromptsDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

export const SAMPLE_PROMPT_CATEGORIES: PromptCategory[] = [
  { id: "general", name: "通用" },
  { id: "writing", name: "语言规范" },
  { id: "architecture", name: "架构" },
  { id: "accessibility", name: "可访问性" },
];

const DAY = 86_400;
const NOW = 1_793_000_000;

type Sample = Prompt & { builtin: boolean };

const sample = (
  id: string,
  name: string,
  categoryId: string,
  description: string,
  content: string,
  enabled: boolean,
  builtin: boolean,
  age: number,
): Sample => ({
  id: `sample-${id}`,
  name,
  categoryId,
  description,
  content,
  enabled,
  builtin,
  createdAt: NOW - 40 * DAY,
  updatedAt: NOW - age * DAY,
});

export const SAMPLE_PROMPTS: Sample[] = [
  sample(
    "review",
    "严格代码审查与重构规范",
    "general",
    "工程质量与评审准则",
    `## 工程质量与评审准则

1. 原子提交与变更隔离：每次提交围绕一个可验证的变更，分开业务逻辑与格式整理。
2. 零隐藏状态副作用：异步流与跨组件订阅应明确生命周期与资源释放。
3. 类型契约与边界自检：公开接口应校验输入，并在边界处完成类型收拢。

\`\`\`yaml
mode: strict_engineering
target_env: codex-cli
enforce_rules: [atomic_commits, zero_side_effects, type_soundness]
\`\`\``,
    true,
    false,
    1,
  ),
  sample(
    "writing",
    "中文技术文档与清晰回复风格",
    "writing",
    "让技术说明简短而具体",
    "## 写作约定\n\n先给结论，首次使用缩写时写出全称。示例应能独立阅读。",
    true,
    false,
    4,
  ),
  sample(
    "rust",
    "Rust 与 Tauri 安全边界检查",
    "architecture",
    "桌面应用的输入、文件与错误边界",
    "## 接口审查\n\n在命令入口检查输入。使用项目已有的错误类型，并妥善处理文件读取失败。",
    false,
    true,
    8,
  ),
  sample(
    "type",
    "前端低视力无障碍排版准则",
    "accessibility",
    "正文与控件保持清晰可读",
    "## 排版准则\n\n保证字号、焦点和辅助文字的对比度，放大后仍能通过键盘完成操作。",
    false,
    false,
    12,
  ),
];

export const SAMPLE_AGENTS_FILE = [
  "# 项目约定",
  "",
  "<!-- CHIMERA:INSTRUCTIONS:BEGIN -->",
  ...SAMPLE_PROMPTS.filter((prompt) => prompt.enabled).map(
    (prompt) => prompt.content,
  ),
  "<!-- CHIMERA:INSTRUCTIONS:END -->",
].join("\n\n");
