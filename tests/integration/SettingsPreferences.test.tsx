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
  launchOnStartup: true,
} as Settings;

const renderSettings = () =>
  render(
    <ThemeProvider>
      <NewSettingsView />
    </ThemeProvider>,
  );
// Settings opens at 工具; the preference rows live in the scrolled sections.
const openSection = (name: string) =>
  fireEvent.click(screen.getByRole("link", { name }));

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

    mocks.get.mockReset().mockResolvedValue({ ...initial });
    mocks.patch.mockReset();
    mocks.error.mockClear();
    mocks.getAutoLaunch.mockReset().mockResolvedValue(false);
    mocks.setAutoLaunch.mockReset().mockResolvedValue(true);
  });

  it("keeps backup and four general rows in design order without fabricating backups", async () => {
    const { container } = renderSettings();
    openSection("备份与恢复");
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
    // Every section starts with its own heading, controls follow.
    for (const section of sections)
      expect(section.firstElementChild?.tagName).toBe("H2");
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

  it("always opens at the tools section and follows history changes", async () => {
    window.history.replaceState(null, "", "#settings-general");
    renderSettings();
    expect(screen.getByRole("link", { name: "工具" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    await screen.findByText("工具注册表为空。");
    expect(window.location.hash).toBe("");
    window.history.replaceState(null, "", "#settings-general");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(screen.getByRole("region", { name: "通用设置" })).toBeVisible();
    expect(screen.getByRole("link", { name: "通用设置" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("opens import separately without showing unrelated reset controls", async () => {
    renderSettings();
    openSection("导入");
    expect(screen.getByLabelText("导入链接")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "恢复默认设置" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "通用设置" }),
    ).not.toBeInTheDocument();
    openSection("通用设置");
    expect(screen.getByRole("region", { name: "通用设置" })).toBeVisible();
    expect(screen.queryByLabelText("导入链接")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "恢复默认设置" }),
      ).toBeEnabled(),
    );
  });

  it("opens tools independently and returns to the standard sections", async () => {
    renderSettings();
    openSection("工具");
    await screen.findByText("工具注册表为空。");
    expect(
      screen.queryByRole("region", { name: "通用设置" }),
    ).not.toBeInTheDocument();
    openSection("通用设置");
    expect(screen.getByRole("region", { name: "通用设置" })).toBeVisible();
    expect(screen.queryByText("工具注册表为空。")).not.toBeInTheDocument();
  });

  it("persists application theme and restores the selected segment on remount", async () => {
    const view = renderSettings();
    openSection("通用设置");
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
    renderSettings();
    openSection("通用设置");
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
    renderSettings();
    openSection("通用设置");
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "退出软件" })).toBeEnabled(),
    );
    expect(i18n.language).toBe("zh");
    expect(screen.queryByRole("combobox", { name: "界面语言" })).toBeNull();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("language")).toBe("ja");
  });

  it("links the settings directory to real sections and marks the clicked one", async () => {
    renderSettings();
    const navigation = screen.getByRole("navigation", { name: "设置目录" });
    const links = navigation.querySelectorAll("a");
    expect(links).toHaveLength(8);
    expect(links[0]).toHaveAttribute("aria-current", "location");
    fireEvent.click(links[3]);
    expect(links[3]).toHaveAttribute("aria-current", "location");
    expect(links[0]).not.toHaveAttribute("aria-current");
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
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /开机自启动/ })).toBeEnabled(),
    );
  });

  it("shows the saved startup preference and saves toggles through the dedicated command", async () => {
    renderSettings();
    openSection("通用设置");
    const toggle = screen.getByRole("switch", { name: /开机自启动/ });
    await waitFor(() => expect(toggle).toBeEnabled());
    // The saved preference wins over whatever the OS entry currently says.
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveTextContent("登录系统后自动启动 Chimera++");
    expect(toggle).not.toHaveTextContent("默认");
    expect(mocks.getAutoLaunch).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "false"),
    );
    expect(mocks.setAutoLaunch).toHaveBeenCalledWith(false);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("keeps an existing disabled startup preference", async () => {
    mocks.get.mockResolvedValue({ ...initial, launchOnStartup: false });
    renderSettings();
    openSection("通用设置");
    const toggle = screen.getByRole("switch", { name: /开机自启动/ });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(mocks.setAutoLaunch).not.toHaveBeenCalled();
  });

  it("keeps the saved preference when a startup change fails", async () => {
    mocks.setAutoLaunch.mockRejectedValue(new Error("permission denied"));
    renderSettings();
    openSection("通用设置");
    const toggle = screen.getByRole("switch", { name: /开机自启动/ });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "设置开机自启动失败",
        expect.anything(),
      ),
    );
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("disables preferences when settings cannot be read and offers a retry", async () => {
    mocks.get.mockRejectedValueOnce(new Error("read failed"));
    renderSettings();
    openSection("通用设置");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法读取设置");
    expect(screen.getByRole("switch", { name: /开机自启动/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /开机自启动/ })).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("saves all three close behaviors atomically", async () => {
    mocks.patch.mockImplementation(async (patch) => ({ ...initial, ...patch }));
    renderSettings();
    openSection("通用设置");
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
    renderSettings();
    openSection("Codex 偏好");
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
    renderSettings();
    openSection("Codex 偏好");
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
    renderSettings();
    openSection("应用更新");
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
