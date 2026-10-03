import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionMessageItem } from "@/components/sessions/SessionMessageItem";
const renderMessage = (role: string, content: string, searchQuery?: string) => {
  const copy = vi.fn();
  render(
    <TooltipProvider>
      <SessionMessageItem
        message={{ role, content }}
        isActive={false}
        onCopy={copy}
        searchQuery={searchQuery}
      />
    </TooltipProvider>,
  );
  return copy;
};
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
