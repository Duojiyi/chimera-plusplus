import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/CommandPalette";
import type { Provider } from "@/types";

const saved: Provider = {
  id: "persisted-id",
  name: "My saved route",
  settingsConfig: {},
};
function mount(providers: Provider[] = [saved]) {
  const callbacks = {
    onClose: vi.fn(),
    onSwitchProvider: vi.fn(),
    onNavigate: vi.fn(),
    onAddProvider: vi.fn(),
    onEditProvider: vi.fn(),
    onSpeedTestAll: vi.fn(),
    onCheckHealth: vi.fn(),
    canNavigate: (view: string) => ["sessions", "usage"].includes(view),
  };
  const view = render(
    <CommandPalette
      isOpen
      providers={providers}
      currentProviderId={saved.id}
      {...callbacks}
    />,
  );
  return { ...callbacks, ...view };
}
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("command palette uses persisted data", () => {
  it("hides release-gated pages and health actions", () => {
    mount();
    expect(screen.queryByText("配置体检")).not.toBeInTheDocument();
    expect(screen.queryByText("打开配置体检")).not.toBeInTheDocument();
    expect(screen.queryByText("官方账号管理")).not.toBeInTheDocument();
  });

  it("switches and edits using the actual saved provider ID", () => {
    const callbacks = mount();
    expect(screen.getByText("当前线路")).toBeVisible();
    fireEvent.click(screen.getByText("切换到 My saved route"));
    expect(callbacks.onSwitchProvider).toHaveBeenCalledWith("persisted-id");
    fireEvent.click(screen.getByText("编辑 My saved route"));
    expect(callbacks.onEditProvider).toHaveBeenCalledWith("persisted-id");
  });
  it("does not fabricate providers for an empty store", () => {
    mount([]);
    expect(screen.queryByText(/^切换到 /)).not.toBeInTheDocument();
    expect(screen.queryByText(/^编辑 /)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/3 项需修复|近 7 天|Frame 13/),
    ).not.toBeInTheDocument();
  });
  it("offers one accurately labelled bulk speed test", () => {
    const callbacks = mount();
    fireEvent.click(screen.getByText("测速全部线路"));
    expect(callbacks.onSpeedTestAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("测速 My saved route")).not.toBeInTheDocument();
  });
  it("navigates to actual sessions and usage without sample metadata", () => {
    const callbacks = mount();
    fireEvent.click(screen.getByText("查看会话"));
    expect(callbacks.onNavigate).toHaveBeenCalledWith("sessions");
    fireEvent.click(screen.getByText("查看用量"));
    expect(callbacks.onNavigate).toHaveBeenCalledWith("usage");
  });
});
