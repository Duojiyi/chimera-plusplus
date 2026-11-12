import type { Prompt, PromptCategory } from "@/lib/api/prompts";

/**
 * Browser design-preview fixtures for the prompts page (L05 / L22).
 *
 * Only used when the renderer runs outside Tauri with `?preview=design`, so
 * the layout can be reviewed without a backend. Counts follow the shared fake
 * data baseline (design system §6): 9 prompts, 6 enabled, 3 of them built in.
 * Every write is refused while these are on screen.
 */
export const isPromptsDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

export const SAMPLE_PROMPT_CATEGORIES: PromptCategory[] = [
  { id: "conventions", name: "工程约定" },
  { id: "quality", name: "质量" },
  { id: "docs", name: "文档" },
  { id: "maintenance", name: "维护" },
  { id: "security", name: "安全" },
  { id: "data", name: "数据" },
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
    "commit",
    "提交信息规范",
    "conventions",
    "按 Conventional Commits 输出，subject 不超过 72 字符，正文说明动机而非改动清单。",
    "# 提交信息规范\n\n按 Conventional Commits 输出。\n\n{{diff}} 会替换为当前工作区差异；{{branch}} 替换为分支名。",
    true,
    true,
    3,
  ),
  sample(
    "review",
    "代码审查清单",
    "conventions",
    "先看错误路径与并发，再看命名与可读性；每条意见给出具体行号与替代写法。",
    "# 代码审查清单\n\n审查 {{file}}，先看错误路径与并发。",
    true,
    true,
    5,
  ),
  sample(
    "tests",
    "测试补充策略",
    "quality",
    "新增分支必须补一个失败用例与一个通过用例；不写只断言 truthy 的空壳测试。",
    "# 测试补充策略\n\n为 {{module}} 补充失败用例与通过用例。",
    true,
    false,
    1,
  ),
  sample(
    "summary",
    "变更摘要",
    "docs",
    "面向使用者写：先一句结论，再列受影响的行为，最后写迁移方式。禁止写「优化了代码」。",
    "# 变更摘要\n\n先一句结论，再列受影响的行为。",
    true,
    true,
    8,
  ),
  sample(
    "deps",
    "依赖升级评估",
    "maintenance",
    "列出破坏性变更、替代方案与回滚成本；主版本升级必须先读 CHANGELOG 再动手。",
    "# 依赖升级评估\n\n评估 {{package}} 升级到 {{version}} 的影响。",
    true,
    false,
    2,
  ),
  sample(
    "terms",
    "术语与文案风格",
    "docs",
    "中文为主，术语首次出现给英文原文；不用「赋能」「闭环」这类词，不写感叹号。",
    "# 术语与文案风格\n\n中文为主，术语首次出现给英文原文。",
    true,
    false,
    12,
  ),
  sample(
    "security",
    "安全敏感改动",
    "security",
    "涉及凭据、路径、子进程时必须说明信任边界；默认拒绝外部输入直接进 shell。",
    "# 安全敏感改动\n\n涉及 {{path}} 时说明信任边界。",
    false,
    false,
    20,
  ),
  sample(
    "perf",
    "性能回归排查",
    "quality",
    "先量化再改：给出基线数字、测量方式与目标值；没有数据不做优化。",
    "# 性能回归排查\n\n先量化再改。",
    false,
    false,
    26,
  ),
  sample(
    "migration",
    "迁移脚本规范",
    "data",
    "迁移必须可重入、可回滚，禁止在迁移里写业务逻辑；大表变更分步执行。",
    "# 迁移脚本规范\n\n对 {{table}} 的变更必须可重入。",
    false,
    false,
    30,
  ),
];

/** What the injection preview shows in the design preview (L22). */
export const SAMPLE_AGENTS_FILE = `# 项目约束

- 不要在本机编译 Rust，除非用户明确要求。
- 优先源码审查、cargo fmt --check、前端类型检查。
- 未做 Rust 验证时必须明确报告。

<!-- CHIMERA:INSTRUCTIONS:BEGIN -->
## 提交信息规范

按 Conventional Commits 输出，subject 不超过 72 字符。

## 代码审查清单

先看错误路径与并发，再看命名与可读性。
<!-- CHIMERA:INSTRUCTIONS:END -->`;
