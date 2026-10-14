import { describe, expect, it } from "vitest";
import { splitInstructionFile } from "@/components/prompts/instructionSections";
import { codexStatusView, formatBytes } from "@/components/prompts/codexStatus";
import {
  describeFileIssue,
  describePromptError,
} from "@/components/prompts/promptErrors";

const BEGIN = "<!-- CHIMERA:INSTRUCTIONS:BEGIN -->";
const END = "<!-- CHIMERA:INSTRUCTIONS:END -->";
const FOREIGN_BEGIN = "<!-- CODEX-X:INSTRUCTIONS:BEGIN -->";
const FOREIGN_END = "<!-- CODEX-X:INSTRUCTIONS:END -->";

describe("splitInstructionFile", () => {
  it("keeps file order and the exact block text", () => {
    const block = `${BEGIN}\r\nRules\r\n${END}`;
    const foreign = `${FOREIGN_BEGIN}\nOther\n${FOREIGN_END}`;
    expect(
      splitInstructionFile(`\uFEFFMine\r\n\r\n${block}\r\n${foreign}\nTail\n`),
    ).toEqual([
      { kind: "user", text: "\uFEFFMine" },
      { kind: "managed", text: block },
      { kind: "foreign", text: foreign },
      { kind: "user", text: "Tail" },
    ]);
  });
  it("treats a file without markers as the user's own text", () => {
    expect(splitInstructionFile("Only mine")).toEqual([
      { kind: "user", text: "Only mine" },
    ]);
  });
  it("refuses incomplete, repeated, reversed or nested markers", () => {
    for (const text of [
      `${BEGIN}\nx`,
      `${END}\n${BEGIN}`,
      `${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}`,
      `${FOREIGN_BEGIN}\n${BEGIN}\nx\n${END}\n${FOREIGN_END}`,
    ])
      expect(splitInstructionFile(text)).toBeNull();
  });
});

describe("codexStatusView", () => {
  it("states the written size only when the block is in effect", () => {
    expect(
      codexStatusView({
        state: "in_sync",
        enabledCount: 3,
        managedBytes: 4300,
      }),
    ).toMatchObject({
      tone: "ok",
      headline: "已写入 AGENTS.md · 3 条 · 4.2 KB",
    });
    expect(codexStatusView({ state: "in_sync", enabledCount: 0 })).toBeNull();
  });
  it("gives every other state a warning with one fix", () => {
    const actions = {
      missing: "rewrite",
      edited: "resolve",
      overridden: "open-folder",
      linked: "open-folder",
      unreadable: "retry",
    } as const;
    for (const [state, kind] of Object.entries(actions)) {
      expect(
        codexStatusView({
          state: state as keyof typeof actions,
          enabledCount: 2,
        }),
      ).toMatchObject({ tone: "warning", action: { kind } });
    }
    // The drawer is the fix for broken markers, so the card adds no button.
    const malformed = codexStatusView({ state: "malformed", enabledCount: 1 });
    expect(malformed?.tone).toBe("warning");
    expect(malformed?.action).toBeUndefined();
    expect(
      codexStatusView({ state: "foreign", enabledCount: 0 }),
    ).toMatchObject({ tone: "warning", fileLink: "查看与接管" });
  });
  it("formats sizes for people", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4300)).toBe("4.2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("prompt error presentation", () => {
  it("never shows raw native text", () => {
    expect(
      describePromptError(
        new Error("IO 错误: C:\\Users\\private\\AGENTS.md: denied"),
        "AGENTS.md",
      ),
    ).toEqual({
      message: "提示词操作未完成，请检查当前状态后重试。",
      showFile: false,
    });
    expect(
      describePromptError(
        "[config.changeset_conflict] C:\\Users\\private\\AGENTS.md 在读取后已被其他程序修改",
        "AGENTS.md",
      ).message,
    ).not.toContain("private");
  });
  it("explains why a file could not be previewed", () => {
    expect(
      describeFileIssue("[prompt.file.linked] raw", "AGENTS.md"),
    ).toMatchObject({
      kind: "linked",
      title: "AGENTS.md 是链接文件，Chimera++ 只读不写",
    });
    expect(describeFileIssue("anything else", "GEMINI.md")).toMatchObject({
      kind: "unreadable",
      title: "无法读取 GEMINI.md",
    });
  });
});
