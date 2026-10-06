// Curated MIT templates from Codex-X; revision, license and hashes in THIRD_PARTY_NOTICES.md.
import template0 from "./prompt-templates/software-development-code-review.md?raw";
import template1 from "./prompt-templates/software-development-debugging.md?raw";
import template2 from "./prompt-templates/software-development-maintainer.md?raw";
import template3 from "./prompt-templates/writing-clarity-editor.md?raw";
import template4 from "./prompt-templates/writing-structured-draft.md?raw";
import template5 from "./prompt-templates/writing-technical-docs.md?raw";

export const bundledPromptTemplates = [
  {
    id: "software-development-code-review",
    categoryId: "software-development",
    name: "代码审查",
    description: "检查具体缺陷、回归与安全风险",
    content: template0,
  },
  {
    id: "software-development-debugging",
    categoryId: "software-development",
    name: "问题调试",
    description: "定位根因并验证最小修复",
    content: template1,
  },
  {
    id: "software-development-maintainer",
    categoryId: "software-development",
    name: "项目维护",
    description: "理解现有约定并维护代码质量",
    content: template2,
  },
  {
    id: "writing-clarity-editor",
    categoryId: "writing",
    name: "清晰表达",
    description: "改善文字结构、准确性与可读性",
    content: template3,
  },
  {
    id: "writing-structured-draft",
    categoryId: "writing",
    name: "结构化写作",
    description: "围绕目标与读者组织初稿",
    content: template4,
  },
  {
    id: "writing-technical-docs",
    categoryId: "writing",
    name: "技术文档",
    description: "编写可验证、可执行的技术说明",
    content: template5,
  },
] as const;
