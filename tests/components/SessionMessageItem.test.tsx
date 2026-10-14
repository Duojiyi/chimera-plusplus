import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionMessageItem } from "@/components/sessions/SessionMessageItem";
import { splitFencedBlocks } from "@/components/sessions/SessionMessageContent";
import type { SessionTranscriptEntry } from "@/lib/api/sessions";

const renderEntry = (message: SessionTranscriptEntry, searchQuery?: string) => {
  const copy = vi.fn();
  const view = render(
    <TooltipProvider>
      <SessionMessageItem
        message={message}
        isActive={false}
        onCopy={copy}
        searchQuery={searchQuery}
      />
    </TooltipProvider>,
  );
  return { copy, ...view };
};

const renderMessage = (role: string, content: string, searchQuery?: string) =>
  renderEntry({ role, content }, searchQuery).copy;

describe("readable session records", () => {
  it.each(["developer", "system"])(
    "collapses %s instructions and retains full content",
    (role) => {
      const content = "INTERNAL INSTRUCTIONS ".repeat(200);
      const copy = renderMessage(role, content);
      expect(screen.getByText("系统与环境")).toBeInTheDocument();
      expect(
        screen.queryByText(/INTERNAL INSTRUCTIONS/),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { expanded: false }));
      expect(screen.getByText(/INTERNAL INSTRUCTIONS/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "复制内容" }));
      expect(copy).toHaveBeenCalledWith(content);
    },
  );
  it("collapses injected AGENTS context without hiding normal user messages", () => {
    renderMessage(
      "user",
      "# AGENTS.md instructions for D:/example\nProject rules",
    );
    expect(screen.queryByText(/Project rules/)).not.toBeInTheDocument();
  });
  it("reveals a search match within collapsed instructions", () => {
    renderMessage(
      "developer",
      "Searchable internal instructions",
      "Searchable",
    );
    expect(screen.getByText("Searchable")).toBeInTheDocument();
  });
  it("keeps a short user request immediately readable", () => {
    renderMessage("user", "请修复设置滚动");
    expect(screen.getByText("请修复设置滚动")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { expanded: false }),
    ).not.toBeInTheDocument();
  });
});

describe("code in session records", () => {
  it("sets inline code and fenced blocks in the code face", () => {
    const { container } = renderEntry({
      role: "assistant",
      content: [
        "改动在 `codex_config.rs` 里：",
        "",
        "```rust",
        "fn main() {}",
        "```",
        "",
        "然后运行测试。",
      ].join("\n"),
    });
    expect(container.querySelector(".session-inline-code")).toHaveTextContent(
      "codex_config.rs",
    );
    const block = container.querySelector("pre.session-code-block");
    expect(block).toHaveTextContent("fn main() {}");
    expect(block).toHaveAttribute("data-language", "rust");
    expect(screen.getByText("然后运行测试。")).toBeInTheDocument();
    // The fences themselves are markup, not content.
    expect(container.textContent).not.toContain("```");
  });

  it("shows tool output as machine text and says when it was cut", () => {
    const { container } = renderEntry({
      role: "tool",
      content: "Exit code: 0\nOutput:\nok\n…[已截断 12 KB]",
      truncated: true,
    });
    expect(screen.getByText("工具输出")).toBeInTheDocument();
    expect(screen.getByText("已截断")).toBeInTheDocument();
    expect(
      container.querySelector("pre.session-tool-output"),
    ).toHaveTextContent("Exit code: 0");
  });

  it("shows a tool call as a compact line", () => {
    renderEntry({ role: "assistant", content: "[Tool: shell]" });
    expect(screen.getByText("调用工具")).toBeInTheDocument();
    expect(screen.getByText("shell").tagName).toBe("CODE");
    expect(screen.queryByText("[Tool: shell]")).not.toBeInTheDocument();
  });

  it("states what the reader left out as a note, not as a message", () => {
    renderEntry({
      role: "notice",
      content: "会话内容过大，后续 8 条消息未显示。",
      truncated: true,
    });
    expect(screen.getByRole("note")).toHaveTextContent("后续 8 条消息未显示");
    expect(
      screen.queryByRole("button", { name: "复制内容" }),
    ).not.toBeInTheDocument();
  });

  it("keeps an unclosed fence as code to the end of a shortened preview", () => {
    expect(splitFencedBlocks("看这里\n```ts\nconst a = 1;")).toEqual([
      { kind: "text", text: "看这里" },
      { kind: "code", text: "const a = 1;", language: "ts" },
    ]);
    expect(splitFencedBlocks("no fences, just `inline`")).toEqual([
      { kind: "text", text: "no fences, just `inline`" },
    ]);
  });
});
