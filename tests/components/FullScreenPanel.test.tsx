import { render, screen, fireEvent } from "@testing-library/react";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("FullScreenPanel", () => {
  it("names the back button and restores the previous scroll lock", () => {
    const onClose = vi.fn();
    document.body.style.overflow = "scroll";
    const { unmount } = render(
      <FullScreenPanel isOpen title="Edit MCP" onClose={onClose}>
        Content
      </FullScreenPanel>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "common.back" }));
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(document.body.style.overflow).toBe("scroll");
    document.body.style.overflow = "";
  });
  it("leaves the shell title bar exposed and keeps the footer outside the scroll area", () => {
    render(
      <FullScreenPanel
        isOpen
        title="线路"
        onClose={() => {}}
        footer={<button>保存线路</button>}
      >
        <p>表单内容</p>
      </FullScreenPanel>,
    );
    const panel = screen.getByText("表单内容").closest(".fixed");
    expect(panel).toHaveClass("top-10", "min-h-0");
    const scroll = screen.getByText("表单内容").closest(".overflow-y-auto");
    expect(scroll).not.toContainElement(
      screen.getByRole("button", { name: "保存线路" }),
    );
  });
  it("focuses the panel, isolates covered content and restores focus on close", () => {
    const shell = document.createElement("div");
    shell.className = "chimera-shell";
    shell.innerHTML =
      '<aside><button>打开</button></aside><main><header><button>窗口控制</button></header><section class="chimera-content">背景</section></main>';
    document.body.appendChild(shell);
    const trigger = shell.querySelector("button")!;
    trigger.focus();
    const { unmount } = render(
      <FullScreenPanel isOpen title="编辑线路" onClose={() => {}}>
        内容
      </FullScreenPanel>,
    );
    expect(screen.getByRole("dialog", { name: "编辑线路" })).toHaveFocus();
    expect(shell.querySelector("aside")!.inert).toBe(true);
    expect(shell.querySelector<HTMLElement>(".chimera-content")!.inert).toBe(
      true,
    );
    expect(shell.querySelector("header")!.inert).not.toBe(true);
    unmount();
    expect(shell.querySelector("aside")!.inert).not.toBe(true);
    expect(trigger).toHaveFocus();
    shell.remove();
  });
  it("does not unlock the body when a closed panel unmounts", () => {
    document.body.style.overflow = "hidden";
    const { unmount } = render(
      <FullScreenPanel isOpen={false} title="Closed" onClose={() => {}}>
        Content
      </FullScreenPanel>,
    );
    unmount();
    expect(document.body.style.overflow).toBe("hidden");
    document.body.style.overflow = "";
  });
});
