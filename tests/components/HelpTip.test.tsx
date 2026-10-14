import { act, fireEvent, render, screen } from "@testing-library/react";
import { DisabledReason, HelpTip } from "@/components/ui/help-tip";

describe("HelpTip", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens after the hover delay and closes after the pointer leaves", () => {
    vi.useFakeTimers();
    render(<HelpTip title="协议说明">按模型族自动选择请求格式。</HelpTip>);
    const trigger = screen.getByRole("button", { name: "协议说明" });

    fireEvent.pointerEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "按模型族自动选择请求格式。",
    );

    fireEvent.pointerLeave(trigger);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("opens immediately on keyboard focus and closes with Escape", () => {
    render(<HelpTip title="上下文说明">单次请求可用的最大长度。</HelpTip>);
    const trigger = screen.getByRole("button", { name: "上下文说明" });

    act(() => {
      trigger.focus();
    });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("stays open after a click until it is dismissed", () => {
    vi.useFakeTimers();
    render(<HelpTip title="映射说明">把请求模型改写为实际模型。</HelpTip>);
    const trigger = screen.getByRole("button", { name: "映射说明" });

    fireEvent.click(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerLeave(trigger);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("describes the trigger for screen readers while the card is closed", () => {
    render(<HelpTip title="地址说明">本地路由会补全 /v1。</HelpTip>);
    expect(
      screen.getByRole("button", { name: "地址说明" }),
    ).toHaveAccessibleDescription("本地路由会补全 /v1。");
  });
});

describe("DisabledReason", () => {
  it("keeps the button focusable, blocks its action and explains why", () => {
    const onClick = vi.fn();
    render(
      <DisabledReason reason="Codex 正在更新，完成后再试。">
        <button type="button" onClick={onClick}>
          重启 Codex
        </button>
      </DisabledReason>,
    );
    const button = screen.getByRole("button", { name: "重启 Codex" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAccessibleDescription("Codex 正在更新，完成后再试。");

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Codex 正在更新，完成后再试。",
    );
  });

  it("renders the button unchanged without a reason", () => {
    const onClick = vi.fn();
    render(
      <DisabledReason>
        <button type="button" onClick={onClick}>
          重启 Codex
        </button>
      </DisabledReason>,
    );
    const button = screen.getByRole("button", { name: "重启 Codex" });
    expect(button).not.toHaveAttribute("aria-disabled");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
