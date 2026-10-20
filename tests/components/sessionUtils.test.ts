import { describe, expect, it } from "vitest";
import {
  buildSessionExport,
  describeSessionReadError,
  extractCodexPromptPreview,
  formatSessionMessagePreview,
  getProviderLabel,
  getSessionDirectoryGroupKey,
  groupSessionsByProviderAndDirectory,
  isArchivedSession,
  isTruncatedMessage,
  shouldHideCodexMessageFromToc,
} from "@/components/sessions/utils";
import type {
  SessionListEntry,
  SessionTranscriptEntry,
} from "@/lib/api/sessions";
import type { SessionMeta } from "@/types";

describe("session utils", () => {
  it("groups Windows project directories regardless of case and separators", () => {
    const key = getSessionDirectoryGroupKey("codex", "D:\\demo");
    expect(getSessionDirectoryGroupKey("codex", "d:/demo/")).toBe(key);
    expect(getSessionDirectoryGroupKey("codex", " D:\\Demo\\ ")).toBe(key);
    expect(getSessionDirectoryGroupKey("codex", "\\\\host\\Share")).toBe(
      getSessionDirectoryGroupKey("codex", "//HOST/share/"),
    );
    // POSIX stays case-sensitive; only the trailing slash is ignored.
    expect(getSessionDirectoryGroupKey("codex", "/home/a/Proj/")).toBe(
      getSessionDirectoryGroupKey("codex", "/home/a/Proj"),
    );
    expect(getSessionDirectoryGroupKey("codex", "/home/a/proj")).not.toBe(
      getSessionDirectoryGroupKey("codex", "/home/a/Proj"),
    );
  });

  it("extracts Codex VS Code prompts after the request marker", () => {
    const content = [
      "# Context from my IDE setup:",
      "",
      "## Active file: src/main.ts",
      "",
      "## My request for Codex:",
      "Fix the session title preview",
    ].join("\n");

    expect(extractCodexPromptPreview(content)).toBe(
      "Fix the session title preview",
    );
  });

  it("extracts inline Codex VS Code prompts", () => {
    const content = [
      "# Context from my IDE setup:",
      "",
      "## My request for Codex: Fix the TOC preview",
    ].join("\n");

    expect(extractCodexPromptPreview(content)).toBe("Fix the TOC preview");
  });

  it("ignores marker mentions before the Codex request heading", () => {
    const content = [
      "# Context from my IDE setup:",
      "",
      "## Active selection:",
      "My request for Codex: not the prompt",
      "",
      "## My request for Codex:",
      "Use the real request heading",
    ].join("\n");

    expect(extractCodexPromptPreview(content)).toBe(
      "Use the real request heading",
    );
  });

  it("uses the last request heading when the selection contains one", () => {
    const content = [
      "# Context from my IDE setup:",
      "",
      "## Active selection: docs/codex-format.md:10-14",
      "## My request for Codex:",
      "selected document content, not the real request",
      "",
      "## My request for Codex:",
      "the real injected request",
    ].join("\n");

    expect(extractCodexPromptPreview(content)).toBe(
      "the real injected request",
    );
  });

  // Known limitation: the IDE marker is matched purely by text, so a
  // "## My request for Codex:" line inside the real request body is treated as
  // a new boundary and only the trailing part is kept. Pinning this documents
  // the best-effort behavior; fully fixing it needs structured IDE section data
  // that the Codex VS Code context does not provide.
  it("keeps only the trailing part when the request body repeats the heading", () => {
    const content = [
      "# Context from my IDE setup:",
      "",
      "## Active file: foo.ts",
      "",
      "## My request for Codex:",
      "Document the format, for example:",
      "## My request for Codex:",
      "and the rest follows.",
    ].join("\n");

    expect(extractCodexPromptPreview(content)).toBe("and the rest follows.");
  });

  it("does not extract from ordinary messages that mention the marker", () => {
    const content = "Please explain the phrase My request for Codex.";

    expect(extractCodexPromptPreview(content)).toBe(content);
  });

  it("hides Codex context messages without user prompts from the TOC", () => {
    expect(
      shouldHideCodexMessageFromToc("# AGENTS.md instructions for F:/project"),
    ).toBe(true);
    expect(
      shouldHideCodexMessageFromToc(
        "<environment_context>\n<cwd>F:/project</cwd>",
      ),
    ).toBe(true);
    expect(shouldHideCodexMessageFromToc("# Context from my IDE setup:")).toBe(
      true,
    );
    expect(
      shouldHideCodexMessageFromToc(
        "# Context from my IDE setup:\n\n## My request for Codex:\nFix it",
      ),
    ).toBe(false);
  });

  it("formats message previews with truncation", () => {
    expect(formatSessionMessagePreview("short message")).toBe("short message");
    expect(formatSessionMessagePreview("a".repeat(51))).toBe(
      `${"a".repeat(50)}...`,
    );
  });

  it("groups sessions by provider and project directory", () => {
    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "codex-1",
        projectDir: "/workspace/app",
      },
      {
        providerId: "codex",
        sessionId: "codex-2",
        projectDir: "/workspace/app",
      },
      {
        providerId: "claude",
        sessionId: "claude-1",
        projectDir: "/workspace/docs",
      },
    ];

    const groups = groupSessionsByProviderAndDirectory(sessions, "未知目录");

    expect(groups).toHaveLength(2);
    expect(groups[0].providerId).toBe("codex");
    expect(groups[0].sessions.map((session) => session.sessionId)).toEqual([
      "codex-1",
      "codex-2",
    ]);
    expect(groups[0].directories).toHaveLength(1);
    expect(groups[0].directories[0]).toMatchObject({
      projectDir: "/workspace/app",
      label: "app",
    });
    expect(
      groups[0].directories[0].sessions.map((session) => session.sessionId),
    ).toEqual(["codex-1", "codex-2"]);
    expect(groups[1].providerId).toBe("claude");
    expect(groups[1].directories[0].label).toBe("docs");
  });

  it("uses an unknown directory group for sessions without project directories", () => {
    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "codex-1",
        projectDir: null,
      },
      {
        providerId: "codex",
        sessionId: "codex-2",
        projectDir: "   ",
      },
    ];

    const groups = groupSessionsByProviderAndDirectory(sessions, "未知目录");

    expect(groups).toHaveLength(1);
    expect(groups[0].directories).toHaveLength(1);
    expect(groups[0].directories[0]).toMatchObject({
      projectDir: null,
      label: "未知目录",
    });
    expect(
      groups[0].directories[0].sessions.map((session) => session.sessionId),
    ).toEqual(["codex-1", "codex-2"]);
  });

  it("preserves filtered session order inside provider and directory groups", () => {
    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "newest",
        projectDir: "/workspace/app",
        lastActiveAt: 30,
      },
      {
        providerId: "codex",
        sessionId: "middle",
        projectDir: "/workspace/docs",
        lastActiveAt: 20,
      },
      {
        providerId: "codex",
        sessionId: "oldest",
        projectDir: "/workspace/app",
        lastActiveAt: 10,
      },
    ];

    const groups = groupSessionsByProviderAndDirectory(sessions, "未知目录");

    expect(groups[0].sessions.map((session) => session.sessionId)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
    expect(groups[0].directories.map((group) => group.label)).toEqual([
      "app",
      "docs",
    ]);
    expect(
      groups[0].directories[0].sessions.map((session) => session.sessionId),
    ).toEqual(["newest", "oldest"]);
  });

  it("names tools by their product names, as the application filter does", () => {
    expect(getProviderLabel("codex")).toBe("Codex");
    expect(getProviderLabel("claude")).toBe("Claude Code");
    expect(getProviderLabel("gemini")).toBe("Gemini CLI");
    expect(getProviderLabel("opencode")).toBe("OpenCode");
    expect(getProviderLabel("grokbuild")).toBe("Grok Build");
    expect(getProviderLabel("future-tool")).toBe("future-tool");
  });

  it("reads the optional archived and truncated flags", () => {
    const archived: SessionListEntry = {
      providerId: "codex",
      sessionId: "a",
      archived: true,
    };
    expect(isArchivedSession(archived)).toBe(true);
    expect(isArchivedSession({ providerId: "codex", sessionId: "b" })).toBe(
      false,
    );
    const cut: SessionTranscriptEntry = {
      role: "tool",
      content: "x",
      truncated: true,
    };
    expect(isTruncatedMessage(cut)).toBe(true);
    expect(isTruncatedMessage({ role: "tool", content: "x" })).toBe(false);
  });

  it("leaves tool output and the record location out of an export unless asked", () => {
    const session: SessionMeta = {
      providerId: "codex",
      sessionId: "s1",
      title: "T",
      projectDir: "C:\\work\\app",
      sourcePath: "C:\\Users\\lin\\.codex\\sessions\\rollout.jsonl",
    };
    const messages = [
      { role: "user", content: "run it" },
      { role: "assistant", content: "[Tool: shell]" },
      { role: "tool", content: "TOKEN=secret" },
      { role: "Tool", content: "TOKEN=secret-2" },
    ];
    const plain = buildSessionExport(session, messages, {
      includeToolOutput: false,
    });
    expect(plain.version).toBe(1);
    expect(plain.session).not.toHaveProperty("sourcePath");
    expect(plain.session).not.toHaveProperty("projectDir");
    expect(plain.messages.map((message) => message.content)).toEqual([
      "run it",
      "[Tool: shell]",
    ]);
    expect(JSON.stringify(plain)).not.toContain("secret");
    // The page's own copy of the session keeps its location.
    expect(session.sourcePath).toContain("rollout.jsonl");

    const full = buildSessionExport(session, messages, {
      includeToolOutput: true,
    });
    expect(full.messages).toHaveLength(4);
    expect(full.session).not.toHaveProperty("sourcePath");
  });

  it("turns read errors into a plain cause", () => {
    expect(
      describeSessionReadError(
        "Failed to read session file C:\\a.jsonl: 另一个程序正在使用此文件，进程无法访问。 (os error 32)",
      ),
    ).toEqual({ tooLarge: false, hint: "文件正被其他程序占用，请稍后重试。" });
    expect(
      describeSessionReadError(
        "Failed to read session file /a: Permission denied (os error 13)",
      ).hint,
    ).toBe("没有读取这个文件的权限。");
    expect(
      describeSessionReadError(
        "Failed to read session file /a: No such file or directory (os error 2)",
      ).hint,
    ).toContain("已不存在");
    expect(
      describeSessionReadError(
        "Failed to read session file /a.jsonl.zst: session decoded output exceeds byte limit",
      ),
    ).toMatchObject({ tooLarge: true });
    expect(describeSessionReadError("Unknown frame descriptor")).toEqual({
      tooLarge: false,
      hint: "",
    });
  });
});
