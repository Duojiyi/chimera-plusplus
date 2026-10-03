import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  mac: false,
  native: true,
  canMaximize: true,
  maximized: false,
  minimize: vi.fn(),
  close: vi.fn(),
  toggleMaximize: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("@/lib/platform", () => ({ isMac: () => state.mac }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => state.native }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: state.minimize,
    close: state.close,
    toggleMaximize: state.toggleMaximize,
    isMaximizable: async () => state.canMaximize,
    isMaximized: async () => state.maximized,
    onResized: async () => state.unlisten,
  }),
}));
import { WindowControls } from "@/components/WindowControls";
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    mac: false,
    native: true,
    canMaximize: true,
    maximized: false,
  });
});
describe("WindowControls", () => {
  it("uses macOS traffic-light order", async () => {
    state.mac = true;
    const { container } = render(<WindowControls />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "最大化窗口" })).toBeEnabled(),
    );
    expect(container.firstChild).toHaveClass("window-controls-mac");
    expect(
      screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
    ).toEqual(["关闭窗口", "最小化窗口", "最大化窗口"]);
  });
  it("uses Windows minimize, maximize, close order", async () => {
    render(<WindowControls />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "最大化窗口" })).toBeEnabled(),
    );
    expect(
      screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
    ).toEqual(["最小化窗口", "最大化窗口", "关闭窗口"]);
  });
  it("reflects a fixed-size native build instead of offering a dead action", async () => {
    state.canMaximize = false;
    render(<WindowControls />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "最大化窗口" })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "最大化窗口" }));
    expect(state.toggleMaximize).not.toHaveBeenCalled();
  });
  it("preserves draft protection and native actions", async () => {
    const { unmount } = render(<WindowControls closeDisabled />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "最大化窗口" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
    expect(state.close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "最小化窗口" }));
    expect(state.minimize).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "最大化窗口" }));
    expect(state.toggleMaximize).toHaveBeenCalledOnce();
    unmount();
    expect(state.unlisten).toHaveBeenCalledOnce();
  });
  it("offers restore after maximizing and closes through Tauri", async () => {
    state.maximized = true;
    render(<WindowControls />);
    await screen.findByRole("button", { name: "还原窗口" });
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
    expect(state.close).toHaveBeenCalledOnce();
  });
  it("does not pretend to control a native window in browser preview", () => {
    state.native = false;
    render(<WindowControls />);
    for (const button of screen.getAllByRole("button"))
      expect(button).toBeDisabled();
  });
});
