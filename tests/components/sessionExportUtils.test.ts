import { markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import {
  buildSessionExport,
  buildSessionMarkdown,
} from "@/components/sessions/utils";
import type { SessionMessage, SessionMeta } from "@/types";

const session: SessionMeta = {
  providerId: "codex",
  sessionId: "original-id",
  title: "A conversation",
  sourcePath: "C:\\private\\session.jsonl",
  projectDir: "C:\\project",
};
const defaults = { includeToolOutput: false };

const nodesOf = (markdown: string, name: string) => {
  const ranges: { from: number; to: number }[] = [];
  markdownLanguage.parser.parse(markdown).iterate({
    enter(node) {
      if (node.name === name) ranges.push({ from: node.from, to: node.to });
    },
  });
  return ranges;
};

describe("session export privacy", () => {
  it.each([false, true])(
    "omits sourcePath even when includeToolOutput is %s, without mutating input",
    (includeToolOutput) => {
      const messages: SessionMessage[] = [
        { role: "user", content: "hello", ts: 0 },
        { role: "tool", content: "TOKEN=secret" },
      ];
      Object.freeze(session);
      Object.freeze(messages);
      for (const message of messages) Object.freeze(message);
      const json = buildSessionExport(session, messages, { includeToolOutput });
      const markdown = buildSessionMarkdown(session, messages, {
        includeToolOutput,
      });
      expect(json.session).not.toHaveProperty("sourcePath");
      expect(json.session).not.toHaveProperty("projectDir");
      expect(JSON.stringify(json)).not.toContain("session.jsonl");
      expect(markdown).not.toContain("session.jsonl");
      expect(session.sourcePath).toBe("C:\\private\\session.jsonl");
      expect(messages).toHaveLength(2);
      expect(json.messages).toHaveLength(includeToolOutput ? 2 : 1);
      expect(markdown.includes("TOKEN=secret")).toBe(includeToolOutput);
    },
  );

  it.each([false, true])(
    "exports only allowlisted fields (tool output: %s)",
    (includeToolOutput) => {
      const extendedSession = Object.freeze({
        ...session,
        summary: "Summary",
        createdAt: 0,
        lastActiveAt: 123,
        resumeCommand: "codex resume --cd C:\\private original-id",
        futureMetadata: { privatePath: "C:\\private" },
      });
      const message = Object.freeze({
        role: "user",
        content: "Keep my text",
        ts: 0,
        sourcePath: "private-message.jsonl",
        futureMetadata: { token: "private-token" },
      });
      const json = buildSessionExport(extendedSession, [message], {
        includeToolOutput,
      });
      expect(json.session).toEqual({
        providerId: "codex",
        sessionId: "original-id",
        title: "A conversation",
        summary: "Summary",
        createdAt: 0,
        lastActiveAt: 123,
      });
      expect(json.messages).toEqual([
        { role: "user", content: "Keep my text", ts: 0 },
      ]);
      expect(json.messages[0]).not.toBe(message);
      expect(extendedSession).toHaveProperty("resumeCommand");
      expect(message).toHaveProperty("futureMetadata");
    },
  );

  it("filters case-insensitive and padded tool roles by default but preserves other messages in order", () => {
    const messages = [
      { role: "user", content: "one" },
      { role: "tool", content: "secret one" },
      { role: " TOOL ", content: "secret two" },
      { role: "Tool", content: "secret three" },
      { role: "assistant", content: "two" },
      { role: "notice", content: "reader stopped early" },
    ];
    const json = buildSessionExport(session, messages, defaults);
    expect(json.messages.map((message) => message.content)).toEqual([
      "one",
      "two",
      "reader stopped early",
    ]);
    const markdown = buildSessionMarkdown(session, messages, defaults);
    expect(markdown).not.toContain("secret");
    expect(nodesOf(markdown, "FencedCode")).toHaveLength(3);
    expect(markdown.indexOf("one")).toBeLessThan(markdown.indexOf("two"));
    expect(markdown).toContain("## 读取提示");
  });

  it("does not silently remove a path or secrets deliberately written inside a user's message", () => {
    const content = `The user mentioned ${session.sourcePath} and TOKEN=typed`;
    const messages = [{ role: "user", content }];
    expect(
      buildSessionExport(session, messages, defaults).messages[0].content,
    ).toBe(content);
    expect(buildSessionMarkdown(session, messages, defaults)).toContain(
      content,
    );
  });
});

describe("buildSessionMarkdown", () => {
  it("uses product names, keeps timestamps including zero, and represents empty bodies", () => {
    const markdown = buildSessionMarkdown(
      session,
      [
        { role: "user", content: "", ts: 0 },
        { role: "assistant", content: "answer", ts: 123.5 },
      ],
      defaults,
    );
    expect(markdown).toContain("# A conversation");
    expect(markdown).toContain("- 工具：Codex");
    expect(markdown).toContain("- 时间戳：0");
    expect(markdown).toContain("- 时间戳：123.5");
    expect(markdown).toContain("```text\n\n```\n");
    expect(nodesOf(markdown, "FencedCode")).toHaveLength(2);
  });

  it("keeps HTML, nested fences, whitespace, and Unicode content verbatim inside one text block", () => {
    const content = [
      "  leading whitespace",
      '<script>alert("unsafe")</script>',
      '<img src="file:///C:/private/secret" onerror="attack()">',
      "```html",
      "<b>nested code</b>",
      "```",
      "````",
      "## fake heading",
      "`````",
      "中文 🌊 trailing  ",
      "",
    ].join("\n");
    const markdown = buildSessionMarkdown(
      session,
      [{ role: "assistant", content }],
      defaults,
    );
    expect(markdown).toContain(`\n${content}\n`);
    const blocks = nodesOf(markdown, "FencedCode");
    expect(blocks).toHaveLength(1);
    expect(markdown.slice(blocks[0].from, blocks[0].to)).toBe(
      `${"`".repeat(6)}text\n${content}\n${"`".repeat(6)}`,
    );
    expect(nodesOf(markdown, "HTMLBlock")).toHaveLength(0);
    expect(nodesOf(markdown, "ATXHeading2")).toHaveLength(1);
  });

  it("escapes metadata and unfamiliar roles so they cannot create HTML, links or headings", () => {
    const metadata =
      "# [title](javascript:alert(1)) &lt;img&gt;\r\n## bad\n<script>x</script>\u2028![](file:///secret)";
    const markdown = buildSessionMarkdown(
      {
        ...session,
        title: metadata,
        sessionId: metadata,
        providerId: metadata,
      },
      [{ role: metadata, content: "body" }],
      defaults,
    );
    expect(nodesOf(markdown, "ATXHeading1")).toHaveLength(1);
    expect(nodesOf(markdown, "ATXHeading2")).toHaveLength(1);
    for (const type of [
      "HTMLBlock",
      "HTMLTag",
      "Link",
      "Image",
      "Entity",
      "Emphasis",
    ]) {
      expect(nodesOf(markdown, type), type).toHaveLength(0);
    }
    expect(markdown).toContain("\\<script\\>");
    expect(markdown).toContain("\\&lt\\;img\\&gt\\;");
    expect(nodesOf(markdown, "FencedCode")).toHaveLength(1);
  });

  it.each(["__proto__", "constructor", "toString", "", "  "])(
    "handles unknown or blank role/provider %j without object-prototype lookups",
    (role) => {
      const markdown = buildSessionMarkdown(
        { ...session, providerId: role },
        [{ role, content: "unknown role content" }],
        defaults,
      );
      expect(markdown).toContain("unknown role content");
      expect(nodesOf(markdown, "ATXHeading2")).toHaveLength(1);
      expect(markdown).not.toContain("[object Object]");
      expect(markdown).not.toContain("function Object");
      if (!role.trim()) expect(markdown).toContain("## 未知角色");
    },
  );

  it("supports many backtick runs without argument-count overflow", () => {
    const content = "`x".repeat(150000);
    const markdown = buildSessionMarkdown(
      session,
      [{ role: "user", content }],
      defaults,
    );
    expect(markdown).toContain(`\n${content}\n`);
    expect(markdown).toContain("```text");
  });

  it("supports long fences and keeps each subsequent message separate", () => {
    const content = "`".repeat(256);
    const markdown = buildSessionMarkdown(
      session,
      [
        { role: "user", content },
        { role: "assistant", content: "next message" },
      ],
      defaults,
    );
    expect(markdown).toContain(
      `${"`".repeat(257)}text\n${content}\n${"`".repeat(257)}`,
    );
    expect(nodesOf(markdown, "FencedCode")).toHaveLength(2);
  });

  it("documents whether tool output was included and handles a transcript with no messages", () => {
    const empty = buildSessionMarkdown({ ...session, title: "" }, [], defaults);
    expect(empty).toContain("# 会话记录");
    expect(empty).toContain("未包含工具输出");
    expect(nodesOf(empty, "FencedCode")).toHaveLength(0);
    const full = buildSessionMarkdown(
      session,
      [{ role: "tool", content: "included" }],
      { includeToolOutput: true },
    );
    expect(full).toContain("已包含工具输出；分享前请检查");
    expect(full).not.toContain("未包含工具输出");
  });
});
