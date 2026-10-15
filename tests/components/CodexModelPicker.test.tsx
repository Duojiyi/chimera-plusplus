import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodexModelPicker } from "@/components/providers/CodexModelPicker";

const models = [
  { id: "big-1", ownedBy: "relay" },
  { id: "mid-1", ownedBy: "relay" },
];

describe("fetched model list", () => {
  it("fills the one field it was opened for when there are no mapping rows", () => {
    const onPick = vi.fn();
    render(
      <CodexModelPicker
        models={models}
        defaultModel="mid-1"
        target="Opus 模型"
        refetching={false}
        onPick={onPick}
        onRefetch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("点击模型填入「Opus 模型」");
    expect(dialog).not.toHaveTextContent("已加入映射");
    expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
    expect(
      within(dialog).queryByRole("button", { name: "应用" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /big-1/ }));
    expect(onPick).toHaveBeenCalledWith("big-1", []);
  });

  it("keeps the Codex mapping checkboxes and 应用 when rows are given", () => {
    render(
      <CodexModelPicker
        models={models}
        defaultModel="mid-1"
        rows={[]}
        refetching={false}
        onPick={vi.fn()}
        onApply={vi.fn()}
        onRefetch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent("勾选加入模型映射");
  });
});
