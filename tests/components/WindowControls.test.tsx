/**
 * macOS window-control conventions.
 *
 * macOS and Windows order their window buttons oppositely, so `WindowControls`
 * branches on platform. These tests pin the DOM contract that the CSS relies on:
 * the `is-traffic-lights` class (which drives the left-edge positioning) and the
 * close-first button order. Getting the order wrong would put the close button
 * where users expect minimize — a destructive misclick.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const minimizeMock = vi.fn();
const closeMock = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: minimizeMock,
    close: closeMock,
  }),
}));

const isMacMock = vi.fn();
vi.mock("@/lib/platform", () => ({
  isMac: () => isMacMock(),
  isWindows: () => !isMacMock(),
  isLinux: () => false,
  DRAG_REGION_ENABLED: true,
  DRAG_REGION_ATTR: {},
  DRAG_REGION_STYLE: {},
}));

// Imported after the mocks so the component picks them up.
const { WindowControls } = await import("@/components/WindowControls");

const buttonOrder = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).map((button) =>
    button.className.replace(/\s+/g, " ").trim(),
  );

afterEach(() => {
  vi.clearAllMocks();
});

describe("WindowControls", () => {
  it("renders macOS traffic lights with close first", () => {
    isMacMock.mockReturnValue(true);
    const { container } = render(<WindowControls />);

    const group = container.querySelector(".window-dots");
    expect(group).toHaveClass("is-traffic-lights");

    // Close must come first: on macOS the leftmost light is close, and the CSS
    // lays these out left-to-right in DOM order.
    expect(buttonOrder(container)).toEqual([
      "is-close",
      "is-minimize",
      "is-zoom",
    ]);
  });

  it("marks the macOS zoom light disabled because the window is fixed-size", () => {
    isMacMock.mockReturnValue(true);
    const { container } = render(<WindowControls />);

    const zoom = container.querySelector("button.is-zoom");
    expect(zoom).toBeDisabled();
    // A two-light macOS window reads as broken, so the light stays present.
    expect(zoom).toBeInTheDocument();
  });

  it("keeps the Windows order unchanged: minimize then close", () => {
    isMacMock.mockReturnValue(false);
    const { container } = render(<WindowControls />);

    expect(container.querySelector(".window-dots")).not.toHaveClass(
      "is-traffic-lights",
    );
    expect(buttonOrder(container)).toEqual(["is-minimize", "is-close"]);
    // No zoom affordance on Windows — the titlebar never offered one.
    expect(container.querySelector("button.is-zoom")).toBeNull();
  });

  it("protects editor drafts from titlebar close while allowing minimize", () => {
    for (const mac of [true, false]) {
      isMacMock.mockReturnValue(mac);
      const { unmount } = render(<WindowControls closeDisabled />);
      const close = screen.getByRole("button", { name: /关闭/ });
      expect(close).toBeDisabled();
      close.click();
      expect(closeMock).not.toHaveBeenCalled();
      screen.getByRole("button", { name: /最小化/ }).click();
      expect(minimizeMock).toHaveBeenCalledTimes(1);
      unmount();
      vi.clearAllMocks();
    }
  });

  it("wires both platforms' buttons to the real window actions", () => {
    for (const mac of [true, false]) {
      isMacMock.mockReturnValue(mac);
      const { unmount } = render(<WindowControls />);

      screen.getByRole("button", { name: /最小化/ }).click();
      expect(minimizeMock).toHaveBeenCalledTimes(1);

      screen.getByRole("button", { name: /关闭/ }).click();
      expect(closeMock).toHaveBeenCalledTimes(1);

      unmount();
      vi.clearAllMocks();
    }
  });
});
