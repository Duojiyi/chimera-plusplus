import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  show: vi.fn(),
  setFocus: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: mocks.show, setFocus: mocks.setFocus }),
}));

import { revealMainWindow } from "@/lib/startupWindow";

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(false);
  mocks.show.mockReset().mockResolvedValue(undefined);
  mocks.setFocus.mockReset().mockResolvedValue(undefined);
});

describe("revealMainWindow", () => {
  it("shows and focuses the window on a normal launch", async () => {
    await revealMainWindow();
    expect(mocks.invoke).toHaveBeenCalledWith("take_started_hidden");
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.setFocus).toHaveBeenCalledTimes(1);
  });

  it("leaves a silent start hidden", async () => {
    mocks.invoke.mockResolvedValue(true);
    await revealMainWindow();
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.setFocus).not.toHaveBeenCalled();
  });

  it("shows the window when the setting cannot be read", async () => {
    // Losing the safety net is worse than ignoring silent startup once.
    mocks.invoke.mockRejectedValue(new Error("no command"));
    await revealMainWindow();
    expect(mocks.show).toHaveBeenCalledTimes(1);
  });
});
