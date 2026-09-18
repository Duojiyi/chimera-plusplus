import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/types";

const mocks = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  return {
    get: vi.fn(),
    patch: vi.fn(),
    error: vi.fn(),
    getAutoLaunch: vi.fn(),
    setAutoLaunch: vi.fn(),
  };
});
vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    get: mocks.get,
    patchPreferences: mocks.patch,
    getAutoLaunchStatus: mocks.getAutoLaunch,
    setAutoLaunch: mocks.setAutoLaunch,
  },
}));
vi.mock("@/lib/updater", () => ({ getCurrentVersion: async () => "test" }));
vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => ({}) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: mocks.error } }));
import { NewSettingsView } from "@/views/NewSettingsView";

const initial = {
  checkCodexUpdatesOnStart: true,
  checkProviderStatusOnStart: true,
  showProviderBalance: false,
  minimizeToTrayOnClose: false,
  codexUpdateSource: "auto",
  codexInstallMode: "standard",
  currentProviderCodex: "active",
} as Settings;

describe("atomic preference saves", () => {
  beforeEach(() => {
    mocks.get.mockResolvedValue({ ...initial });
    mocks.patch.mockReset();
    mocks.error.mockClear();
    mocks.getAutoLaunch.mockReset().mockResolvedValue(true);
    mocks.setAutoLaunch.mockReset().mockResolvedValue(true);
  });

  it("reads the OS startup status and persists toggles through the dedicated command", async () => {
    render(<NewSettingsView />);
    const toggle = screen.getByRole("switch", { name: /开机自启动/ });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "false"),
    );
    expect(mocks.setAutoLaunch).toHaveBeenCalledWith(false);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("keeps an existing disabled startup preference", async () => {
    mocks.getAutoLaunch.mockResolvedValue(false);
    render(<NewSettingsView />);
    const toggle = screen.getByRole("switch", { name: /开机自启动/ });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(mocks.setAutoLaunch).not.toHaveBeenCalled();
  });

  it("reconciles OS state after a failed startup change", async () => {
    mocks.setAutoLaunch.mockRejectedValue(new Error("permission denied"));
    render(<NewSettingsView />);
    const toggle = screen.getByRole("switch", { name: /开机自启动/ });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.getAutoLaunch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(mocks.error).toHaveBeenCalledWith(
      "设置开机自启动失败",
      expect.anything(),
    );
  });

  it("disables startup control on read failure and offers retry", async () => {
    mocks.getAutoLaunch.mockRejectedValueOnce(new Error("read failed"));
    render(<NewSettingsView />);
    const retry = await screen.findByRole("button", {
      name: "重试读取自启动状态",
    });
    expect(screen.getByRole("switch", { name: /开机自启动/ })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /开机自启动/ })).toBeEnabled(),
    );
  });

  it("saves all three close behaviors atomically", async () => {
    mocks.patch.mockImplementation(async (patch) => ({ ...initial, ...patch }));
    render(<NewSettingsView />);
    const select = screen.getByRole("combobox", { name: "关闭主窗口时" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue("exit");
    for (const [value, tray, lightweight] of [
      ["lightweight", true, true],
      ["tray", true, false],
      ["exit", false, false],
    ] as const) {
      fireEvent.change(select, { target: { value } });
      await waitFor(() => expect(select).toHaveValue(value));
      expect(mocks.patch).toHaveBeenLastCalledWith({
        minimizeToTrayOnClose: tray,
        lightweightOnClose: lightweight,
      });
      await waitFor(() => expect(select).toBeEnabled());
    }
  });

  it("queues different toggles and never submits a full settings snapshot", async () => {
    let resolveFirst!: (value: Settings) => void;
    mocks.patch.mockImplementationOnce(
      () =>
        new Promise<Settings>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mocks.patch.mockResolvedValueOnce({
      ...initial,
      checkCodexUpdatesOnStart: false,
      showProviderBalance: true,
    });
    render(<NewSettingsView />);
    const checks = screen.getByRole("switch", {
      name: /启动时检查 Codex 更新/,
    });
    await waitFor(() => expect(checks).toBeEnabled());
    fireEvent.click(checks);
    fireEvent.click(screen.getByRole("switch", { name: /显示供应商余额/ }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(checks).toBeDisabled();
    expect(mocks.patch).toHaveBeenNthCalledWith(1, {
      checkCodexUpdatesOnStart: false,
    });
    await act(async () =>
      resolveFirst({ ...initial, checkCodexUpdatesOnStart: false }),
    );
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(mocks.patch).toHaveBeenNthCalledWith(2, {
      showProviderBalance: true,
    });
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: /显示供应商余额/ }),
      ).toHaveAttribute("aria-checked", "true"),
    );
    expect(checks).toHaveAttribute("aria-checked", "false");
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("unlocks after failure and permits a successful retry", async () => {
    mocks.patch.mockRejectedValueOnce(new Error("disk full"));
    mocks.patch.mockResolvedValueOnce({
      ...initial,
      showProviderBalance: true,
    });
    render(<NewSettingsView />);
    const balance = screen.getByRole("switch", { name: /显示供应商余额/ });
    await waitFor(() => expect(balance).toBeEnabled());
    fireEvent.click(balance);
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(balance).toBeEnabled();
    expect(balance).toHaveAttribute("aria-checked", "false");
    fireEvent.click(balance);
    await waitFor(() =>
      expect(balance).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("resets only the preferences owned by this page", async () => {
    mocks.patch.mockResolvedValueOnce(initial);
    render(<NewSettingsView />);
    const reset = screen.getByRole("button", { name: "恢复默认设置" });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.patch.mock.calls[0][0]).toEqual({
      codexUpdateSource: "auto",
      codexInstallMode: "standard",
      checkCodexUpdatesOnStart: true,
      checkProviderStatusOnStart: true,
      showProviderBalance: false,
      minimizeToTrayOnClose: true,
      lightweightOnClose: false,
    });
  });
});
