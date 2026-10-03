import i18n from "i18next";
import { ThemeProvider } from "@/components/theme-provider";
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
vi.mock("@/lib/api/toolRegistry", () => ({
  toolRegistryApi: { list: async () => [] },
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
  beforeEach(async () => {
    window.history.replaceState(null, "", window.location.pathname);
    await i18n.changeLanguage("zh");
    window.localStorage.removeItem("language");
    window.localStorage.removeItem("cc-switch-theme");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    mocks.get.mockResolvedValue({ ...initial });
    mocks.patch.mockReset();
    mocks.error.mockClear();
    mocks.getAutoLaunch.mockReset().mockResolvedValue(true);
    mocks.setAutoLaunch.mockReset().mockResolvedValue(true);
  });

  it("keeps backup and four general rows in design order without fabricating backups", async () => {
    const { container } = render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "退出软件" })).toBeEnabled(),
    );
    const sections = [
      ...container.querySelectorAll(".settings-standard-sections > section"),
    ];
    expect(sections.map((section) => section.id)).toEqual([
      "settings-backups",
      "settings-connections",
      "settings-directories",
      "settings-general",
      "settings-codex",
      "settings-updates",
    ]);
    const rows = container.querySelectorAll(
      "#settings-general .settings-reference-row",
    );
    expect(rows).toHaveLength(4);
    expect(rows[0].querySelector("select")).toBeNull();
    expect(rows[0]).toHaveTextContent("当前版本仅提供简体中文界面。");
    expect(rows[1].querySelector('[role="group"]')).not.toBeNull();
    expect(rows[2]).toHaveAttribute("role", "switch");
    expect(rows[3].querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(screen.getByText("备份功能尚未开放")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开备份目录" })).toBeDisabled();
    expect(container.querySelector("#settings-backups tbody")).toBeNull();
    expect(
      container.querySelectorAll(".settings-backups-columns span"),
    ).toHaveLength(5);
    expect(screen.getByLabelText("设置摘要")).toHaveTextContent(
      "备份服务 尚未开放",
    );
  });

  it("restores the tools section from its URL and follows history changes", async () => {
    window.history.replaceState(null, "", "#settings-tools");
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
    await screen.findByText("工具注册表为空。");
    window.history.replaceState(null, "", "#settings-general");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(screen.getByRole("region", { name: "通用设置" })).toBeVisible();
    expect(screen.getByRole("link", { name: "通用设置" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("opens import separately without showing unrelated reset controls", async () => {
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "导入" }));
    expect(screen.getByLabelText("导入链接")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "恢复默认设置" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "通用设置" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "通用设置" }));
    expect(screen.getByRole("region", { name: "通用设置" })).toBeVisible();
    expect(screen.queryByLabelText("导入链接")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "恢复默认设置" }),
      ).toBeEnabled(),
    );
  });

  it("opens tools independently and returns to the standard sections", async () => {
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "工具" }));
    await screen.findByText("工具注册表为空。");
    expect(
      screen.queryByRole("region", { name: "通用设置" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "通用设置" }));
    expect(screen.getByRole("region", { name: "通用设置" })).toBeVisible();
    expect(screen.queryByText("工具注册表为空。")).not.toBeInTheDocument();
  });

  it("persists application theme and restores the selected segment on remount", async () => {
    const view = render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /开机自启动/ })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: "跟随系统" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    expect(document.documentElement).toHaveClass("dark");
    expect(window.localStorage.getItem("cc-switch-theme")).toBe("dark");
    expect(mocks.patch).not.toHaveBeenCalled();
    view.unmount();
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
    expect(screen.getByRole("button", { name: "深色" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "浅色" }));
    expect(document.documentElement).toHaveClass("light");
    fireEvent.click(screen.getByRole("button", { name: "跟随系统" }));
    expect(window.localStorage.getItem("cc-switch-theme")).toBe("system");
    expect(document.documentElement).toHaveClass("light");
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /开机自启动/ })).toBeEnabled(),
    );
  });

  it("ignores legacy language preferences without rewriting user settings", async () => {
    mocks.get.mockResolvedValueOnce({ ...initial, language: "en" });
    window.localStorage.setItem("language", "ja");
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "退出软件" })).toBeEnabled(),
    );
    expect(i18n.language).toBe("zh");
    expect(screen.queryByRole("combobox", { name: "界面语言" })).toBeNull();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("language")).toBe("ja");
  });

  it("links the settings directory to real sections and marks unavailable backups", async () => {
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /开机自启动/ })).toBeEnabled(),
    );
    const navigation = screen.getByRole("navigation", { name: "设置目录" });
    const links = navigation.querySelectorAll("a");
    expect(links).toHaveLength(8);
    expect(links[2]).toHaveAttribute("aria-current", "location");
    fireEvent.click(links[3]);
    expect(links[3]).toHaveAttribute("aria-current", "location");
    expect(links[2]).not.toHaveAttribute("aria-current");
    for (const link of links) {
      const target = document.querySelector(link.getAttribute("href")!);
      expect(target).not.toBeNull();
      expect(target).toHaveAttribute("tabindex", "-1");
    }
    expect(
      screen.getByRole("region", { name: "备份与恢复" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "通用设置" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "应用更新" }),
    ).toBeInTheDocument();
  });

  it("reads the OS startup status and persists toggles through the dedicated command", async () => {
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
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
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
    const toggle = screen.getByRole("switch", { name: /开机自启动/ });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(mocks.setAutoLaunch).not.toHaveBeenCalled();
  });

  it("reconciles OS state after a failed startup change", async () => {
    mocks.setAutoLaunch.mockRejectedValue(new Error("permission denied"));
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
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
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
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
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
    const exit = screen.getByRole("radio", { name: "退出软件" });
    await waitFor(() => expect(exit).toBeEnabled());
    expect(exit).toBeChecked();
    for (const [label, tray, lightweight] of [
      ["轻量模式", true, true],
      ["最小化到托盘", true, false],
      ["退出软件", false, false],
    ] as const) {
      const radio = screen.getByRole("radio", { name: label });
      fireEvent.click(radio);
      await waitFor(() => expect(radio).toBeChecked());
      expect(mocks.patch).toHaveBeenLastCalledWith({
        minimizeToTrayOnClose: tray,
        lightweightOnClose: lightweight,
      });
      await waitFor(() => expect(radio).toBeEnabled());
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
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
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
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
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
    render(
      <ThemeProvider>
        <NewSettingsView />
      </ThemeProvider>,
    );
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
