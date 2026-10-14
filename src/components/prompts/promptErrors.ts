import { promptErrorCode } from "@/lib/api/prompts";

export interface PromptErrorView {
  message: string;
  /** The conflict is in the instruction file: offer "查看当前指令". */
  showFile: boolean;
}

const GENERIC = "提示词操作未完成，请检查当前状态后重试。";

// Coded backend errors. Their raw text may carry a file path, so only these
// sentences are ever shown.
const CODED: Record<string, (file: string) => PromptErrorView> = {
  "prompt.managed.unbalanced": (file) => ({
    message: `${file} 中的 Chimera 区块标记不完整（只剩开始或结束标记，或顺序颠倒）。打开当前指令修好标记后再试。`,
    showFile: true,
  }),
  "prompt.managed.duplicate": (file) => ({
    message: `${file} 中有重复的 Chimera 区块或多余的标记。只保留一份后再试。`,
    showFile: true,
  }),
  "prompt.managed.marker_inline": (file) => ({
    message: `${file} 中的区块标记必须各占一行。把标记单独放一行后再试。`,
    showFile: true,
  }),
  "prompt.managed.nested": (file) => ({
    message: `${file} 中 Chimera 区块与其他工具的区块互相嵌套。先把两个区块分开再试。`,
    showFile: true,
  }),
  "prompt.managed.malformed": (file) => ({
    message: `${file} 中的 Chimera 区块无法完整读取。打开当前指令检查该区块。`,
    showFile: true,
  }),
  "prompt.managed.edited": (file) => ({
    message: `${file} 中的 Chimera 区块被手动修改过。为避免覆盖，请先在页面上方选择保留修改或恢复提示词库内容。`,
    showFile: true,
  }),
  "prompt.managed.empty_block": (file) => ({
    message: `${file} 中的 Chimera 区块是空的，无法保留为提示词。请改为恢复提示词库内容。`,
    showFile: true,
  }),
  "prompt.managed.legacy_mismatch": (file) => ({
    message: `${file} 已在 Chimera++ 之外修改过，旧版提示词不能自动迁移。请先查看当前指令，再用「重新写入」恢复。`,
    showFile: true,
  }),
  "prompt.managed.foreign_legacy": (file) => ({
    message: `${file} 中有其他工具的区块，旧版提示词不能自动迁移。请先查看当前指令。`,
    showFile: true,
  }),
  "prompt.managed.takeover_conflict": () => ({
    message:
      "已有 Chimera 区块，不能同时接管其他工具的区块。请先停用全部提示词后再接管。",
    showFile: false,
  }),
  "prompt.managed.foreign_missing": () => ({
    message: "没有找到可接管的区块，文件可能已经变化。请刷新后再试。",
    showFile: true,
  }),
  "prompt.body.reserved_marker": () => ({
    message:
      "正文里不能出现以 <!-- CHIMERA: 或 <!-- CODEX-X: 开头的标记，请删除后再试。",
    showFile: false,
  }),
  "prompt.file.linked": (file) => ({
    message: `${file} 是链接文件，Chimera++ 只读不写。请到链接指向的原文件中修改，或改用普通文件。`,
    showFile: false,
  }),
  "prompt.file.too_large": (file) => ({
    message: `${file} 超过 8 MiB 上限，请精简后再试。`,
    showFile: false,
  }),
  "prompt.file.encoding": (file) => ({
    message: `${file} 不是 UTF-8 编码。用编辑器另存为 UTF-8 后再试。`,
    showFile: false,
  }),
  "prompt.file.unreadable": (file) => ({
    message: `无法读取 ${file}，请检查文件权限后再试。`,
    showFile: false,
  }),
  "config.changeset_conflict": (file) => ({
    message: `${file} 在读取后被其他程序修改，本次没有写入。请查看当前内容后再试。`,
    showFile: true,
  }),
};

// Uncoded backend sentences that are safe and actionable as they are.
const KNOWN = [
  "请先关闭 Codex 代理接管，再修改生效提示词。",
  "无法检查代理接管状态。",
  "启用的提示词不能为空。",
  "提示词内容超过大小上限。",
  "生效提示词合计超过大小上限。",
  "提示词文件必须为 UTF-8。",
  "提示词不存在，请刷新后重试。",
  "提示词不存在。",
  "这条提示词已更新或被删除，请重新打开后编辑。当前草稿尚未保存。",
  "提示词在操作期间已变化，请刷新后重试。",
  "提示词已启用或不存在，请刷新后重试。",
  "无法删除已启用的提示词",
  "存在多个旧版整文件提示词，请先解决所有权冲突。",
  "提示词保存失败且文件已被外部修改，无法自动回滚；请检查 Live 备份。",
  "AGENTS.md 已变化，请刷新并重新确认接管。",
  "确认内容超过大小上限。",
  "请选择 Markdown (.md) 文件。",
  "无法读取 Markdown 文件：需为不超过 8 MiB 的普通 UTF-8 文件。",
  "不能导入空提示词。",
  "分类不存在，请刷新后重试。",
  "分类名称已存在。",
  "该分类名称为系统保留名称。",
  "分类名称需为 1–50 个字符，且不能包含控制字符。",
];

/** Turn a failed prompt command into a safe sentence with a next step. */
export function describePromptError(
  reason: unknown,
  file: string,
): PromptErrorView {
  const code = promptErrorCode(reason);
  const coded = code ? CODED[code] : undefined;
  if (coded) return coded(file);
  const text = reason instanceof Error ? reason.message : String(reason);
  const known = KNOWN.find((sentence) => text.includes(sentence));
  return { message: known ?? GENERIC, showFile: false };
}

export type FileIssueKind = "linked" | "too_large" | "encoding" | "unreadable";

/** Why the current instruction file could not be previewed. */
export function describeFileIssue(
  reason: unknown,
  file: string,
): { kind: FileIssueKind; title: string; detail: string } {
  switch (promptErrorCode(reason)) {
    case "prompt.file.linked":
      return {
        kind: "linked",
        title: `${file} 是链接文件，Chimera++ 只读不写`,
        detail:
          "启用和停用已暂停。请到链接指向的原文件中修改，或改用普通文件后刷新。",
      };
    case "prompt.file.too_large":
      return {
        kind: "too_large",
        title: `${file} 超过 8 MiB，无法预览`,
        detail: "精简文件后刷新。",
      };
    case "prompt.file.encoding":
      return {
        kind: "encoding",
        title: `${file} 不是 UTF-8 编码，无法预览`,
        detail: "用编辑器另存为 UTF-8 后刷新。",
      };
    default:
      return {
        kind: "unreadable",
        title: `无法读取 ${file}`,
        detail: "请检查文件权限，或确认它不是文件夹，然后刷新。",
      };
  }
}
